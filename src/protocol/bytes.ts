import { type LabelName, labelBytes } from "./labels.ts";
import type { Bytes } from "./platform.ts";
import { fail, ok, type Result } from "./result.ts";

const MAX_U64 = Number.MAX_SAFE_INTEGER;

/** Whether `value` is a `Uint8Array`, without `instanceof` (design 2.3: realms differ). */
export const isBytes = (value: unknown): value is Bytes =>
  ArrayBuffer.isView(value) &&
  (value as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1 &&
  Object.prototype.toString.call(value) === "[object Uint8Array]";

function need(value: unknown, length: number): Bytes {
  if (!isBytes(value) || value.length !== length) throw new RangeError(`expected ${length} bytes`);
  return value;
}

/** A public key's form: 65 bytes starting with 0x04 (the platform refuses a point off the curve). */
function publicKey(value: unknown): Bytes {
  const bytes = need(value, 65);
  if (bytes[0] !== 4) throw new RangeError("a public key starts with 0x04");
  return bytes;
}

/** An unsigned integer of `size` bytes, big-endian, below 2^53. */
function uint(value: number, size: number): Bytes {
  const limit = size >= 7 ? MAX_U64 : 2 ** (8 * size) - 1;
  if (!Number.isInteger(value) || value < 0 || value > limit) throw new RangeError("out of range");
  const out = new Uint8Array(size);
  for (let rest = value, i = size - 1; i >= 0; i--, rest = Math.floor(rest / 256))
    out[i] = rest % 256;
  return out;
}

/** Builds signed bytes field by field (design 4); a value outside its field throws. */
export class Writer {
  #chunks: Bytes[] = [];

  /** Appends bytes as they are. */
  raw(bytes: Bytes): this {
    if (!isBytes(bytes)) throw new TypeError("not bytes");
    this.#chunks.push(Uint8Array.from(bytes));
    return this;
  }
  /** `L(...)` of a label of the table (labels.ts), as its bytes. */
  label(name: LabelName): this {
    return this.raw(labelBytes(name));
  }
  u8 = (value: number): this => this.#uint(value, 1);
  u16 = (value: number): this => this.#uint(value, 2);
  u32 = (value: number): this => this.#uint(value, 4);
  /** A `u64`, at most 2^53 - 1. */
  u64 = (value: number): this => this.#uint(value, 8);
  b16 = (bytes: Bytes): this => this.raw(need(bytes, 16));
  b32 = (bytes: Bytes): this => this.raw(need(bytes, 32));
  /** `PK`: 65 bytes starting with 0x04. */
  pk(bytes: Bytes): this {
    return this.raw(publicKey(bytes));
  }
  /** `SIG`: 64 bytes. */
  sig = (bytes: Bytes): this => this.raw(need(bytes, 64));
  /** `opt(x)`: 0x00 for `undefined`, else 0x01 and what `write` appends. */
  opt<T>(value: T | undefined, write: (w: Writer, x: T) => void): this {
    if (value === undefined) return this.u8(0);
    this.u8(1);
    write(this, value);
    return this;
  }
  /** `var(x)`: `u32` length, then the bytes. */
  var(bytes: Bytes): this {
    if (!isBytes(bytes)) throw new TypeError("not bytes");
    return this.u32(bytes.length).raw(bytes);
  }
  /** `list(x...)`: `u32` count, then the items. */
  list<T>(items: readonly T[], write: (w: Writer, x: T) => void): this {
    this.u32(items.length);
    for (const item of items) write(this, item);
    return this;
  }
  /** `set(x...)`: a list sorted strictly by `idOf`, as unsigned bytes; an id twice throws. */
  set<T>(items: readonly T[], idOf: (x: T) => Bytes, write: (w: Writer, x: T) => void): this {
    const sorted = items
      .map((item) => ({ item, id: idOf(item) }))
      .sort((a, b) => compare(a.id, b.id));
    for (let i = 1; i < sorted.length; i++)
      if (compare((sorted[i - 1] as { id: Bytes }).id, (sorted[i] as { id: Bytes }).id) === 0)
        throw new RangeError("an id twice in a set");
    return this.list(sorted, (w, x) => write(w, x.item));
  }
  /** The bytes written so far. */
  bytes(): Bytes {
    const out = new Uint8Array(this.#chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  #uint(value: number, size: number): this {
    return this.raw(uint(value, size));
  }
}

/** Unsigned byte order; a shorter prefix sorts first. */
function compare(a: Bytes, b: Bytes): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

/** Whether two byte strings hold the same bytes. */
export const bytesEqual = (a: Bytes, b: Bytes): boolean => compare(a, b) === 0;

// A sentinel, not an Error: the catch below tells it from a fault by identity, with no instanceof.
const REFUSED = Object.freeze({});
/** Refuses the whole `decode` it runs inside: for a value a field's type holds but its structure does not allow. */
export function refuse(): never {
  throw REFUSED;
}

/** Reads what `Writer` wrote; each method refuses by failing the whole `decode`. */
export class Reader {
  #bytes: Bytes;
  #at = 0;
  constructor(bytes: Bytes) {
    this.#bytes = bytes;
  }

  /** Takes `length` bytes; a length past the end refuses. */
  raw(length: number): Bytes {
    if (this.#at + length > this.#bytes.length) refuse();
    const out = this.#bytes.slice(this.#at, this.#at + length);
    this.#at += length;
    return out;
  }
  /** Takes `L(expected)`; any other bytes refuse. */
  label(expected: LabelName): void {
    const want = labelBytes(expected);
    if (compare(this.raw(want.length), want) !== 0) refuse();
  }
  u8 = (): number => this.#uint(1);
  u16 = (): number => this.#uint(2);
  u32 = (): number => this.#uint(4);
  /** A `u64`; one past 2^53 - 1 refuses. */
  u64 = (): number => this.#uint(8);
  b16 = (): Bytes => this.raw(16);
  b32 = (): Bytes => this.raw(32);
  /** `PK`: 65 bytes; a first byte other than 4 refuses. */
  pk(): Bytes {
    const key = this.raw(65);
    if (key[0] !== 4) refuse();
    return key;
  }
  sig = (): Bytes => this.raw(64);
  /** `opt`: a byte other than 0 or 1 refuses. */
  opt<T>(read: (r: Reader) => T): T | undefined {
    const flag = this.u8();
    if (flag > 1) refuse();
    return flag === 0 ? undefined : read(this);
  }
  var(): Bytes {
    return this.raw(this.u32());
  }
  /** `list`: a count above the bytes left refuses, since every item takes a byte at least. */
  list<T>(read: (r: Reader) => T): T[] {
    const count = this.u32();
    if (count > this.#bytes.length - this.#at) refuse();
    return Array.from({ length: count }, () => read(this));
  }
  /** `set`: ids not strictly ascending refuse, an id twice included. */
  set<T>(read: (r: Reader) => T, idOf: (x: T) => Bytes): T[] {
    const items = this.list(read);
    const ids = items.map(idOf);
    for (let i = 1; i < ids.length; i++)
      if (compare(ids[i - 1] as Bytes, ids[i] as Bytes) >= 0) refuse();
    return items;
  }

  /** Whether every byte was read. */
  done(): boolean {
    return this.#at === this.#bytes.length;
  }

  #uint(size: number): number {
    let value = 0;
    for (const b of this.raw(size)) value = value * 256 + b;
    if (value > MAX_U64) refuse();
    return value;
  }
}

/** Reads all of `bytes` with `read`; a refusal or a byte left over is a failure, never a throw. */
export function decode<T>(bytes: Bytes, read: (r: Reader) => T): Result<T> {
  if (!isBytes(bytes)) return fail("bad-input");
  try {
    const reader = new Reader(Uint8Array.from(bytes)); // a copy: a Node Buffer is a view that its owner reuses
    const value = read(reader);
    return reader.done() ? ok(value) : fail("bad-input");
  } catch (error) {
    if (error === REFUSED) return fail("bad-input");
    throw error;
  }
}
