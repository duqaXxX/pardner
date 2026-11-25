/**
 * The bot's copies of the files it sends (design G 3.5): `<state dir>/blobs/<id hex>`, the sealed
 * bytes of each file whose message is still in an outbox. They stay out of `store.json`, which is
 * written whole at every change. A copy is durable when `write` returns: the file is synced and
 * renamed into place, then `blobs/` is synced, as the relay does (`src/relay/blobs.ts:323-329`),
 * so a store write that names the copy never outlives it.
 */
import {
  closeSync,
  type Dirent,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Bytes } from "../../protocol/platform.ts";
import { toHex } from "./hex.ts";

/** The three steps of `write` that reach the disk, for a test to watch their order. */
export interface BlobOps {
  /** A new file, written whole and synced. */
  write(path: string, bytes: Bytes): void;
  rename(from: string, to: string): void;
  /** Syncs a directory, so that the names in it are on disk. */
  syncDirectory(path: string): void;
}

const real: BlobOps = {
  write(path, bytes) {
    const fd = openSync(path, "wx", 0o600);
    try {
      // `writeSync` may write less than asked: write the rest, or fail.
      for (let done = 0; done < bytes.length; ) {
        const written = writeSync(fd, bytes, done);
        if (written === 0) throw new Error("the write made no progress");
        done += written;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  rename: renameSync,
  syncDirectory(path) {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
};

export class BlobFiles {
  #dir: string;
  #ops: BlobOps;

  constructor(directory: string, ops: BlobOps = real) {
    this.#dir = directory;
    this.#ops = ops;
  }

  #path(id: Bytes): string {
    return join(this.#dir, toHex(id));
  }

  /** Keeps `bytes` as the copy of blob `id`; throws when it cannot be made durable, leaving no half copy. */
  write(id: Bytes, bytes: Bytes): void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const path = this.#path(id);
    const temporary = `${path}.tmp`;
    rmSync(temporary, { force: true });
    try {
      this.#ops.write(temporary, bytes);
      this.#ops.rename(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    this.#ops.syncDirectory(this.#dir);
  }

  has(id: Bytes): boolean {
    return existsSync(this.#path(id));
  }

  /** The copy of blob `id`, or `undefined` when there is none. */
  read(id: Bytes): Bytes | undefined {
    try {
      return Uint8Array.from(readFileSync(this.#path(id)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** Removes the copy of blob `id`, if any. */
  remove(id: Bytes): void {
    rmSync(this.#path(id), { force: true });
  }

  /**
   * Removes every file of the directory that is no copy of a blob in `keep` (hex ids): left by a
   * crash, or by a message that left the outbox. An entry that cannot be removed does not stop the
   * others; the first failure is thrown at the end.
   */
  sweep(keep: ReadonlySet<string>): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.#dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let failed: unknown;
    for (const entry of entries) {
      if (!entry.isFile() || keep.has(entry.name)) continue;
      try {
        rmSync(join(this.#dir, entry.name), { force: true });
      } catch (error) {
        failed ??= error;
      }
    }
    if (failed) throw failed;
  }
}
