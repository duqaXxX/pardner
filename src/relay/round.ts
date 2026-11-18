/**
 * Design 3.6 and 9.3: what is written is answered only once it is on disk. Every write takes a
 * ticket, one `fsync` round at a time covers every write made before it began, and an answer waits
 * for its ticket. A short write, a write error or a failed `fsync` is one failure: nothing more is
 * answered and the process stops with 75. The four functions of the seam are the only file system
 * effects a test replaces. The round owns the descriptors it syncs: they are closed through
 * `close`, which waits for the round that covers them.
 */
import { closeSync, fsync, statfsSync, writeSync } from "node:fs";
import { errorFields, type Log } from "./log.ts";

/** What the relay asks of the machine, replaced by a test to inject a fault or to hold a sync. */
export interface Seam {
  sync(fd: number): Promise<void>;
  /** Returns the count of bytes written, which the caller compares with the length. */
  write(fd: number, bytes: Uint8Array): number;
  /** The free bytes on the volume of `path` that an unprivileged process may use (PR 4: blobs). */
  free(path: string): number;
  stop(code: number): void;
  /** Milliseconds since the epoch (PR 2: the mark's time; PR 5: the limits' clock). */
  now(): number;
}

/** The seam on the real machine. */
export const nodeSeam: Seam = {
  // `fs.fsync` is F_FULLFSYNC on macOS (design 3.6).
  sync: (fd) =>
    new Promise((resolve, reject) => fsync(fd, (error) => (error ? reject(error) : resolve()))),
  write: (fd, bytes) => writeSync(fd, bytes),
  free: (path) => {
    const { bavail, bsize } = statfsSync(path);
    return bavail * bsize;
  },
  stop: (code) => process.exit(code),
  now: Date.now,
};

/** In the order a round syncs them: a blob's data, its folder, the seals, the journal, the mark, the directory. */
const ORDER = ["blob-data", "blobs", "seals", "journal", "mark", "directory"] as const;
/** What a file is for, which fixes when a round syncs it. */
export type Role = (typeof ORDER)[number];

/** The relay has stopped for good; whoever was handling a frame abandons it. */
export class StorageFailed extends Error {}

const EXIT_START_AGAIN = 75;

/** The tickets and the `fsync` round of design 3.6, with the failure rule of 3.2. */
export class Rounds {
  #seam: Seam;
  #log: Log;
  #written = 0;
  #synced = 0;
  #failed = false;
  #running = false;
  #dirty = new Map<number, Role>();
  #syncing: number | undefined;
  #closing = new Set<number>();
  #waiting: { ticket: number; resolve: () => void }[] = [];
  /** Called once each round completes, after the answers it released (design 6.3: the relay pushes what it put on disk). */
  onRound: (() => void) | undefined;

  constructor(seam: Seam, log: Log) {
    this.#seam = seam;
    this.#log = log;
  }

  /** The highest ticket whose round completed. */
  get synced(): number {
    return this.#synced;
  }
  /** The latest ticket given: what an answer waits for when it depends on everything written so far. */
  get written(): number {
    return this.#written;
  }
  get failed(): boolean {
    return this.#failed;
  }

  /**
   * Writes `bytes` whole, or fails: a short count is an error like a thrown one (design 3.2).
   * Returns the ticket. A blob's data is no part of the sequence: it goes through `seam.write` and
   * `touch`, and its error refuses a put (N3).
   */
  write(role: Exclude<Role, "blob-data">, fd: number, bytes: Uint8Array): number {
    this.#assertOpen(fd);
    if ((role as Role) === "blob-data")
      throw new RangeError("a blob's data is not written through a round");
    let count: number;
    try {
      count = this.#seam.write(fd, bytes);
    } catch (error) {
      this.#fail(`write of ${role}`, error);
    }
    if (count !== bytes.length) {
      this.#fail(`short write of ${role}: ${count} of ${bytes.length} bytes`);
    }
    return this.touch(role, fd);
  }

  /** Marks `fd` to be synced by the next round (a rename, a new name, a blob's data); returns the ticket. */
  touch(role: Role, fd: number): number {
    this.#assertOpen(fd);
    this.#dirty.set(fd, role);
    queueMicrotask(() => this.#start());
    return ++this.#written;
  }

  /** Runs one file system call whose error stops the relay (a rename, a truncation). */
  guard<T>(role: Role, run: () => T): T {
    this.#assertOpen();
    try {
      return run();
    } catch (error) {
      return this.#fail(`${role}`, error);
    }
  }

  /** Resolves once `ticket` is on disk; never, once the relay has failed. */
  wait(ticket: number): Promise<void> {
    if (!this.#failed && ticket <= this.#synced) return Promise.resolve();
    return new Promise((resolve) => this.#waiting.push({ ticket, resolve }));
  }

  /**
   * Closes `fd` once no round holds it: at once when it is idle, else after the round that syncs
   * it. No other code closes a descriptor that was written through a round, so a round never
   * syncs a closed descriptor or one whose number was handed to another file.
   */
  close(fd: number): void {
    if (this.#dirty.has(fd) || this.#syncing === fd) this.#closing.add(fd);
    else closeSync(fd);
  }

  /** Syncs each file in turn, outside any round: the start's `fsync` (design 3.6). */
  async barrier(targets: [Role, number][]): Promise<void> {
    this.#assertOpen();
    for (const [role, fd] of targets) {
      try {
        await this.#seam.sync(fd);
      } catch (error) {
        this.#fail(`fsync of ${role}`, error);
      }
    }
  }

  async #start(): Promise<void> {
    if (this.#running || this.#failed || this.#written === this.#synced) return;
    this.#running = true;
    const upTo = this.#written;
    const files = [...this.#dirty].sort((a, b) => ORDER.indexOf(a[1]) - ORDER.indexOf(b[1]));
    try {
      for (const [fd, role] of files) {
        // The order of answers comes from the tickets, not from the order of these syncs.
        this.#dirty.delete(fd);
        this.#syncing = fd;
        try {
          await this.#seam.sync(fd);
        } catch (error) {
          this.#fail(`fsync of ${role}`, error);
        }
        this.#syncing = undefined;
        this.#closeIdle();
      }
    } catch {
      return;
    }
    this.#closeIdle();
    if (this.#failed) return;
    this.#synced = upTo;
    for (const w of this.#waiting) if (w.ticket <= upTo) w.resolve();
    this.#waiting = this.#waiting.filter((w) => w.ticket > upTo);
    queueMicrotask(() => this.onRound?.());
    this.#running = false;
    void this.#start();
  }

  #closeIdle(): void {
    for (const fd of this.#closing) {
      if (this.#dirty.has(fd) || this.#syncing === fd) continue;
      this.#closing.delete(fd);
      closeSync(fd);
    }
  }

  #assertOpen(fd?: number): void {
    if (this.#failed) throw new StorageFailed("the relay has stopped");
    if (fd !== undefined && this.#closing.has(fd))
      throw new RangeError("the descriptor is closing");
  }

  #fail(what: string, error?: unknown): never {
    if (!this.#failed) {
      this.#failed = true;
      try {
        this.#log.error(
          `${what}${error === undefined ? "" : ` (${errorFields(error)})`}: answering nothing, stopping`,
        );
      } finally {
        this.#seam.stop(EXIT_START_AGAIN);
      }
    }
    throw new StorageFailed(what);
  }
}
