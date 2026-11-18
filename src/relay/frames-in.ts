/**
 * Reads a device's frames off a connection (design 4.3): the length first, bounded before the body is
 * read; a frame whole within 30 s of its first byte; the bytes held for frames not yet whole bounded
 * across the relay. The frames themselves are the package's (`frames.ts`).
 */
import { decodeFrame, type Frame, frameLength } from "../protocol/frames.ts";

/** A frame is whole within this long of its first byte, else the connection is closed (review S1). */
export const FRAME_WHOLE_MS = 30_000;
/** The bytes held across the relay for frames not yet whole. */
export const PARTIAL_BYTES_MAX = 64 * 1024 * 1024;

/** The relay-wide count of bytes a connection has been allowed for the frame it is reading. */
export class PartialBytes {
  held = 0;
  readonly max: number;

  constructor(max = PARTIAL_BYTES_MAX) {
    this.max = max;
  }

  take(bytes: number): boolean {
    if (this.held + bytes > this.max) return false;
    this.held += bytes;
    return true;
  }

  give(bytes: number): void {
    this.held -= bytes;
  }
}

/** What `push` returns: the frames now whole, or why the connection must be closed (no answer, design 4.3). */
export type Taken = { frames: Frame[]; rest?: Buffer } | { closed: "length" | "frame" | "bytes" };

export class FrameReader {
  /** Set once a proof is served: the length limit becomes 1 MiB (design 4.3). */
  proven = false;
  /** A longest frame, narrower than the limit of the state: a connection after `prove upload` holds one small frame (design 4.6). */
  cap: number | null = null;
  #budget: PartialBytes;
  #now: () => number;
  #wholeMs: number;
  /** The length prefix being collected, then the frame, allocated once at its announced length. */
  #prefix = Buffer.alloc(4);
  #have = 0;
  #frame: Buffer | null = null;
  #filled = 0;
  #reserved = 0;
  #since: number | null = null;

  constructor(budget: PartialBytes, now: () => number = Date.now, wholeMs = FRAME_WHOLE_MS) {
    this.#budget = budget;
    this.#now = now;
    this.#wholeMs = wholeMs;
  }

  /** When the frame being read must be whole, or null while no frame is partly read. */
  get deadline(): number | null {
    return this.#since === null ? null : this.#since + this.#wholeMs;
  }

  /** The relay held the connection, not the peer's slowness: a frame partly read has its time again from now (4.3, 4.5). */
  restart(): void {
    if (this.#since !== null) this.#since = this.#now();
  }

  /**
   * Adds `chunk` and takes every frame it completes. `each` sees a frame as soon as it is whole, so
   * that a proof in the chunk changes how the frames after it are read (`proven`, `cap`); it returns
   * false to stop there, and the bytes after that frame come back as `rest` (the caller drops them
   * when the connection is over, and keeps them while it is held, design 4.5).
   */
  push(chunk: Buffer, each?: (frame: Frame) => boolean): Taken {
    if (this.#since === null && chunk.length > 0) this.#since = this.#now();
    const frames: Frame[] = [];
    let at = 0;
    while (at < chunk.length) {
      if (this.#frame === null) {
        const n = Math.min(4 - this.#have, chunk.length - at);
        chunk.copy(this.#prefix, this.#have, at, at + n);
        this.#have += n;
        at += n;
        if (this.#have < 4) break;
        const length = frameLength(this.#prefix, this.proven);
        if (!length.ok || (this.cap !== null && length.value > this.cap))
          return this.#close("length");
        const total = 4 + length.value;
        if (!this.#budget.take(total)) return this.#close("bytes");
        this.#reserved = total;
        // Allocated after the budget agreed, once, so that no chunk is copied again (a frame is under 1 MiB).
        this.#frame = Buffer.alloc(total);
        this.#prefix.copy(this.#frame);
        this.#filled = 4;
        continue;
      }
      const n = Math.min(this.#frame.length - this.#filled, chunk.length - at);
      chunk.copy(this.#frame, this.#filled, at, at + n);
      this.#filled += n;
      at += n;
      if (this.#filled < this.#frame.length) break;
      const frame = decodeFrame(this.#frame, this.proven, "relay");
      if (!frame.ok) return this.#close("frame");
      frames.push(frame.value);
      this.release();
      this.#have = 0;
      this.#frame = null;
      this.#since = at < chunk.length ? this.#now() : null;
      if (each?.(frame.value) === false) {
        // The caller stopped reading: the bytes it holds are its own wait, not the peer's slowness (4.3, 4.5).
        this.#since = null;
        break;
      }
    }
    return at < chunk.length ? { frames, rest: chunk.subarray(at) } : { frames };
  }

  /** Gives back what the frame being read held; once the connection is over, or a frame is whole. */
  release(): void {
    this.#budget.give(this.#reserved);
    this.#reserved = 0;
  }

  #close(why: "length" | "frame" | "bytes"): Taken {
    this.release();
    this.#frame = null;
    this.#have = 0;
    this.#since = null;
    return { closed: why };
  }
}
