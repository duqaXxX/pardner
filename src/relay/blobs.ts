/**
 * Design 3.11 and 6.2: the blobs. A put writes a `tmp-` file; its data is synced by a round, then
 * the file is renamed to its id and kept, and once the next round has synced `blobs/` it is held and
 * answered (N2, 3.6): no message can name it before both of its names are on disk. A write
 * error on a `tmp-` file refuses that put and the relay serves on (N3). What the relay holds is
 * kept in memory from the start, and removed once the sequence no longer wants it.
 */
import { createHash, type Hash } from "node:crypto";
import {
  closeSync,
  constants,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { bytesEqual } from "../protocol/bytes.ts";
import { idKey } from "../protocol/device-log.ts";
import type { Bytes, Platform } from "../protocol/platform.ts";
import type { Rounds, Seam } from "./round.ts";
import { Code, type Conn, type Sequence } from "./sequence.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** The figures of design 11.2, constants of the code; a test replaces them. */
export interface Limits {
  maxBlob: number;
  unnamedAll: number;
  unnamedDevice: number;
  /** The free bytes the volume keeps for the journal and the seals. */
  floor: number;
  /** Milliseconds an unnamed blob is kept. */
  expiry: number;
}
const DEFAULTS: Limits = {
  maxBlob: 100 * MIB,
  unnamedAll: GIB,
  unnamedDevice: 256 * MIB,
  floor: 2 * GIB,
  expiry: 24 * 3600 * 1000,
};
const CHUNK = 512 * 1024;

interface Writing {
  key: string;
  id: Bytes;
  size: number;
  conn: Conn;
  next: number;
  hash: Hash;
  fd: number;
  tmp: string;
}
/** What one connection holds: its put in flight, or the blob whose chunks are ignored. */
export class PutSession {
  writing: Writing | undefined;
  ignore: string | undefined;
}
interface Held {
  id: Bytes;
  size: number;
  at: number;
  /** The devices that put it while no message named it: a removed device's blob goes with it. */
  by: Set<string>;
  /** Set from its rename until the round that syncs `blobs/` after it: not held meanwhile (3.6). */
  naming?: Promise<void>;
}
/** `null` when a chunk takes no answer; an answer now; or one that waits for the put's round. */
export type Put = null | { code: number; ticket: number } | { done: Promise<number> };
export type Got = { code: number } | { code: 0; size: number; offset: number; chunk: Bytes };

export class Blobs {
  #platform: Platform;
  #rounds: Rounds;
  #seam: Seam;
  #dir: string;
  #limits: Limits;
  #held = new Map<string, Held>();
  #inflight = 0;
  #inflightBy = new Map<string, number>();
  #dirFd = -1;
  #seq!: Sequence;

  constructor(
    platform: Platform,
    rounds: Rounds,
    seam: Seam,
    dir: string,
    limits: Partial<Limits> = {},
  ) {
    this.#platform = platform;
    this.#rounds = rounds;
    this.#seam = seam;
    this.#dir = dir;
    this.#limits = { ...DEFAULTS, ...limits };
  }

  /** The `held` hook of the sequence: whether the blob's bytes are on disk under its id. */
  held = (blob: Bytes): boolean => {
    const kept = this.#held.get(hex(blob));
    return kept !== undefined && kept.naming === undefined;
  };

  /**
   * The start (design 3.11): a `tmp-` file whose hash a message names is renamed to its id, since its
   * bytes were synced before the message could be placed; any other goes. A blob its sequence no
   * longer wants goes. What stays counts as put by no device.
   */
  start(seq: Sequence): void {
    this.#seq = seq;
    this.#dirFd = openSync(this.#dir, constants.O_RDONLY);
    let renamed = false;
    for (const name of readdirSync(this.#dir)) {
      const path = join(this.#dir, name);
      if (name.startsWith("tmp-")) {
        const id = hashFile(path);
        const key = hex(id);
        if (seq.wanted(id) === true && !this.#held.has(key)) {
          this.#rounds.guard("blobs", () => renameSync(path, join(this.#dir, key)));
          this.#remember(id, statSync(join(this.#dir, key)).size, []);
          renamed = true;
        } else unlink(path);
      } else if (/^[0-9a-f]{64}$/.test(name)) {
        const id = Buffer.from(name, "hex");
        if (seq.wanted(id) === false) unlink(path);
        else this.#remember(id, statSync(path).size, []);
      }
    }
    if (renamed) this.#rounds.touch("blobs", this.#dirFd);
  }

  /** Closes the directory descriptor `start` opened, for a start that fails after it. */
  close(): void {
    if (this.#dirFd >= 0) closeSync(this.#dirFd);
    this.#dirFd = -1;
  }

  session(): PutSession {
    return new PutSession();
  }

  /** A chunk of a put: the model's `putBlob`, with the answers of design 6.2. */
  put(conn: Conn, s: PutSession, blob: Bytes, size: number, offset: number, chunk: Bytes): Put {
    const answer = (code: number) => ({ code, ticket: this.#rounds.written });
    const key = hex(blob);
    if (!this.#seq.active(conn)) return answer(Code.removed);
    if (![size, offset].every((n) => Number.isSafeInteger(n) && n >= 0))
      return answer(Code.refused);
    if (s.ignore === key && offset > 0) return null;
    const w = s.writing;
    if (w && w.key !== key) return answer(Code.refused);
    if (w) {
      if (offset !== w.next || size !== w.size) return this.#drop(s, answer, Code.refused);
    } else {
      s.ignore = undefined;
      if (offset !== 0) return answer(Code.refused);
      // Gone before held, as the model: a replaced build's blob is not taken again (SD 5.12, point 8).
      if (this.#seq.wanted(blob) === false) return answer(Code.gone);
      const held = this.#held.get(key);
      if (held) {
        held.by.add(idKey(conn.device));
        held.at = this.#seam.now();
        s.ignore = key;
        return answer(Code.accepted);
      }
      if (this.#refusedBySize(conn, size)) return answer(Code.tooLarge);
      const tmp = join(this.#dir, `tmp-${hex(this.#platform.random(16))}`);
      let fd: number;
      try {
        fd = openSync(tmp, "wx");
      } catch (error) {
        return answer(codeOf(error));
      }
      const hash = createHash("sha256");
      s.writing = { key, id: blob, size, conn, next: 0, hash, fd, tmp };
      this.#track(conn, size);
    }
    const put = s.writing as Writing;
    if (put.next + chunk.length > put.size) return this.#drop(s, answer, Code.refused);
    try {
      if (this.#seam.write(put.fd, chunk) !== chunk.length) {
        return this.#drop(s, answer, Code.refused);
      }
    } catch (error) {
      return this.#drop(s, answer, codeOf(error));
    }
    put.hash.update(chunk);
    put.next += chunk.length;
    if (put.next < put.size) return null;
    if (!bytesEqual(put.hash.digest(), blob)) return this.#drop(s, answer, Code.refused);
    s.writing = undefined;
    const ticket = this.#rounds.touch("blob-data", put.fd);
    this.#rounds.close(put.fd);
    return { done: this.#rounds.wait(ticket).then(() => this.#finish(put)) };
  }

  /** The connection closed: a put before its last chunk loses its file; one in its round is kept (M5). */
  closeSession(s: PutSession): void {
    if (s.writing) this.#drop(s, () => null, 0);
  }

  /** Design 6.2, `getBlob`: a chunk from `offset`, only for a blob held that a message names and wants. */
  get(conn: Conn, blob: Bytes, offset: number): Got {
    if (!this.#seq.active(conn)) return { code: Code.removed };
    const held = this.#held.get(hex(blob));
    if (!held || this.#seq.wanted(blob) !== true) return { code: Code.gone };
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > held.size)
      return { code: Code.refused };
    const chunk = Buffer.alloc(Math.min(CHUNK, held.size - offset));
    let fd: number | undefined;
    try {
      fd = openSync(join(this.#dir, hex(blob)), constants.O_RDONLY);
      // A file the folder lost or cut short is a blob the relay no longer has.
      if (readSync(fd, chunk, 0, chunk.length, offset) !== chunk.length) return { code: Code.gone };
    } catch {
      return { code: Code.gone };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return { code: 0, size: held.size, offset, chunk };
  }

  /**
   * What a completed round does: removes the blobs a build placed made unwanted, once that build is
   * on disk (M4), and those a message placed names that are unwanted as it is (a later copy of an older
   * build). A key leaves the list once its blob is removed or wanted.
   */
  sweep(): void {
    for (const key of this.#seq.toCheck) {
      const held = this.#held.get(key);
      if (!held || this.#seq.wanted(held.id) === true) this.#seq.toCheck.delete(key);
      // Unwanted as of the disk, and by a message placed since: a message on disk next round needs it.
      else if (
        this.#seq.wanted(held.id, "durable") === false &&
        this.#seq.wanted(held.id) === false
      ) {
        this.#remove(key);
        this.#seq.toCheck.delete(key);
      }
    }
  }

  /** A removed device's unnamed blobs go, unless another device put them too (I3). */
  dropRemoved(devices: Bytes[]): void {
    for (const [key, held] of this.#held) {
      if (held.by.size === 0 || this.#seq.wanted(held.id) !== undefined) continue;
      for (const device of devices) held.by.delete(idKey(device));
      if (held.by.size === 0) this.#remove(key);
    }
  }

  /** An unnamed blob goes after the time of design 11.2; its sender's outbox puts it again. */
  expire(): void {
    const now = this.#seam.now();
    for (const [key, held] of this.#held) {
      if (now - held.at > this.#limits.expiry && this.#seq.wanted(held.id) === undefined) {
        this.#remove(key);
      }
    }
  }

  #remember(id: Bytes, size: number, by: string[]): Held {
    const kept = { id, size, at: this.#seam.now(), by: new Set(by) };
    this.#held.set(hex(id), kept);
    return kept;
  }

  #remove(key: string): void {
    this.#held.delete(key);
    unlink(join(this.#dir, key));
  }

  /** Whether the declared size is over a bound: the largest blob, the unnamed bytes, the free space (I3, N3). */
  #refusedBySize(conn: Conn, size: number): boolean {
    const device = idKey(conn.device);
    let all = this.#inflight;
    let own = this.#inflightBy.get(device) ?? 0;
    for (const held of this.#held.values()) {
      if (this.#seq.wanted(held.id) !== undefined) continue;
      all += held.size;
      if (held.by.has(device)) own += held.size;
    }
    const free = this.#seam.free(this.#dir) - this.#inflight - size;
    const l = this.#limits;
    return (
      size > l.maxBlob ||
      all + size > l.unnamedAll ||
      own + size > l.unnamedDevice ||
      free < l.floor
    );
  }

  /** Ends a put that failed: its file goes, its answer is `code` (a refusal; the relay serves on). */
  #drop<T>(s: PutSession, answer: (code: number) => T, code: number): T {
    const w = s.writing as Writing;
    s.writing = undefined;
    this.#track(w.conn, -w.size);
    this.#rounds.close(w.fd);
    unlink(w.tmp);
    return answer(code);
  }

  /** After the round that synced the data: rename and keep, then hold and answer once a round has synced `blobs/` (N2, 3.6). */
  #finish(w: Writing): number | Promise<number> {
    this.#track(w.conn, -w.size);
    const held = this.#held.get(w.key);
    const device = idKey(w.conn.device);
    const active = this.#seq.active(w.conn);
    if (held || this.#seq.wanted(w.id) === false || !active) {
      unlink(w.tmp);
      if (!active) return Code.removed;
      if (held) {
        held.by.add(device);
        held.at = this.#seam.now();
        return held.naming ? this.#named(w, held.naming) : Code.accepted;
      }
      return Code.gone;
    }
    this.#rounds.guard("blobs", () => renameSync(w.tmp, join(this.#dir, w.key)));
    // Kept at once, so that a second put of it, a removal and a sweep see its file; held, so that a
    // message can name it, only once its names are on disk: never allowed 13 rests on that sync (3.6).
    const kept = this.#remember(w.id, w.size, [device]);
    kept.naming = this.#rounds.wait(this.#rounds.touch("blobs", this.#dirFd)).then(() => {
      kept.naming = undefined;
    });
    return this.#named(w, kept.naming);
  }

  /** A put's answer once the names are on disk: a removal or a sweep may have taken the blob meanwhile. */
  #named(w: Writing, naming: Promise<void>): Promise<number> {
    return naming.then(() => {
      if (!this.#seq.active(w.conn)) return Code.removed;
      return this.#held.has(w.key) ? Code.accepted : Code.gone;
    });
  }

  #track(conn: Conn, delta: number): void {
    const device = idKey(conn.device);
    this.#inflight += delta;
    this.#inflightBy.set(device, (this.#inflightBy.get(device) ?? 0) + delta);
  }
}

/** A file that will not go stays as a `tmp-` file, which the next start removes. */
function unlink(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {}
}

/** A write or open error of a blob's file: a full disk is too large, anything else a refusal (N3). */
const codeOf = (error: unknown) =>
  (error as { code?: string }).code === "ENOSPC" ? Code.tooLarge : Code.refused;

/** SHA-256 of a file, read in pieces: a `tmp-` file may be 100 MiB. */
function hashFile(path: string): Bytes {
  const hash = createHash("sha256");
  const fd = openSync(path, constants.O_RDONLY);
  try {
    const piece = Buffer.alloc(64 * 1024);
    for (
      let n = readSync(fd, piece, 0, piece.length, null);
      n > 0;
      n = readSync(fd, piece, 0, piece.length, null)
    ) {
      hash.update(piece.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest();
}

const hex = (b: Bytes) => Buffer.from(b).toString("hex");
