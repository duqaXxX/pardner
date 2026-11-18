/**
 * Design 3.2: the one sequence of duty 1 as a file.
 *
 *   journal = header ‖ record...
 *   header  = L("blind-relay/1 journal") ‖ relay: B32
 *   record  = length: u32 ‖ position: u64 ‖ item-kind: u8 ‖ var(signed) ‖ SIG ‖ chain: B32 ‖ check: B32
 *
 * `length` counts the bytes after it; `check` is SHA-256 of every byte of the record before it. A
 * start places each record through `place`, the function an append uses, so a start and a run
 * build the same index.
 */
import { fstatSync, ftruncateSync, readSync } from "node:fs";
import { bytesEqual, decode, Writer } from "../protocol/bytes.ts";
import { signedId } from "../protocol/ids.ts";
import type { Bytes, Platform } from "../protocol/platform.ts";
import { chainLink } from "../protocol/proofs.ts";
import type { Rounds } from "./round.ts";

export interface Item {
  kind: number;
  signed: Bytes;
  sig: Bytes;
}

/** One entry of the sequence index (design 3.9): where a record is, and what it hashes to. */
export interface Placed {
  position: number;
  offset: number;
  /** The whole record, its length field included. */
  length: number;
  kind: number;
  id: Bytes;
  chain: Bytes;
}

/** The file is not a journal of this relay (design 3.1: not whole). */
export class NotWhole extends Error {}
/** What the file holds is not what the relay placed (design 3.2, rule 11). */
export class DirectoryChanged extends Error {}

const TAIL = 64;
const ZERO = new Uint8Array(32);

/** The header of the journal or of the seals file: `L(text)`, a length byte and ASCII, then the relay's key id. */
export function fileHeader(file: "journal" | "seals", relay: Bytes): Bytes {
  const text = new TextEncoder().encode(`blind-relay/1 ${file}`);
  return new Writer().u8(text.length).raw(text).b32(relay).bytes();
}

/** `length` bytes of `fd` from `offset`, fewer at the end of the file. */
export function readAt(fd: number, offset: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  let have = 0;
  while (have < length) {
    const count = readSync(fd, out, have, length - have, offset + have);
    if (count === 0) break;
    have += count;
  }
  return out.subarray(0, have);
}

function fields(record: Bytes) {
  return decode(record, (r) => {
    const length = r.u32();
    const position = r.u64();
    const kind = r.u8();
    const signed = r.var();
    const sig = r.sig();
    const chain = r.b32();
    r.b32();
    return { length, position, kind, signed, sig, chain };
  });
}

/** The bytes of the record for `item` as `position`, whose chain link follows `previous`. */
function encode(platform: Platform, position: number, item: Item, previous: Bytes): Uint8Array {
  const chain = chainLink(platform, previous, signedId(platform, item.signed));
  const body = new Writer().u64(position).u8(item.kind).var(item.signed).sig(item.sig).b32(chain);
  const bytes = body.bytes();
  const head = new Writer()
    .u32(bytes.length + 32)
    .raw(bytes)
    .bytes();
  return Buffer.concat([head, platform.sha256(head)]);
}

/**
 * The record at `offset` as the sequence's next position, with the item it holds, or null when it
 * is not whole (design 3.2, "At start"). The start, an append and a read all go through it.
 */
function place(
  platform: Platform,
  record: Bytes,
  offset: number,
  position: number,
  previous: Bytes,
): { placed: Placed; item: Item } | null {
  const parsed = fields(record);
  if (!parsed.ok) return null;
  const f = parsed.value;
  const id = signedId(platform, f.signed);
  const whole =
    f.length === record.length - 4 &&
    f.position === position &&
    bytesEqual(record.subarray(-32), platform.sha256(record.subarray(0, -32))) &&
    bytesEqual(f.chain, chainLink(platform, previous, id));
  if (!whole) return null;
  const placed: Placed = {
    position,
    offset,
    length: record.length,
    kind: f.kind,
    id,
    chain: f.chain,
  };
  return { placed, item: { kind: f.kind, signed: f.signed, sig: f.sig } };
}

export class Journal {
  readonly placed: Placed[];
  readonly fd: number;
  #platform: Platform;
  #rounds: Rounds;
  #length: number;
  #tail: Uint8Array;
  #durable: number;
  #pending: { ticket: number; count: number }[] = [];

  private constructor(
    platform: Platform,
    rounds: Rounds,
    fd: number,
    placed: Placed[],
    length: number,
    tail: Uint8Array,
  ) {
    this.#platform = platform;
    this.#rounds = rounds;
    this.fd = fd;
    this.placed = placed;
    this.#length = length;
    this.#tail = tail;
    this.#durable = placed.length;
  }

  /**
   * Reads the journal `fd` (opened for appending) from its header to its end and drops from the
   * first record that is not whole, truncating the file and syncing it before it returns. Throws
   * `NotWhole` for a header that is not this relay's. `each` gets every whole record as it is read,
   * so that the caller builds its indexes in the same pass (design 3.2: a start and a run place a
   * record through one function).
   */
  static async open(
    platform: Platform,
    rounds: Rounds,
    fd: number,
    relay: Bytes,
    each?: (placed: Placed, item: Item) => void,
  ): Promise<{ journal: Journal; dropped: number }> {
    const header = fileHeader("journal", relay);
    const size = fstatSync(fd).size;
    if (size < header.length || !bytesEqual(readAt(fd, 0, header.length), header)) {
      throw new NotWhole("journal header");
    }
    const placed: Placed[] = [];
    let offset = header.length;
    let chain: Bytes = ZERO;
    for (;;) {
      const prefix = readAt(fd, offset, 4);
      const length = prefix.length === 4 ? prefix.readUInt32BE(0) : Infinity;
      if (offset + 4 + length > size) break;
      const record = readAt(fd, offset, 4 + length);
      const next = place(platform, record, offset, placed.length, chain);
      if (next === null) break;
      placed.push(next.placed);
      each?.(next.placed, next.item);
      offset += record.length;
      chain = next.placed.chain;
    }
    const dropped = size - offset;
    if (dropped > 0) rounds.guard("journal", () => ftruncateSync(fd, offset));
    await rounds.barrier([["journal", fd]]);
    const tail = readAt(fd, offset - Math.min(TAIL, offset), Math.min(TAIL, offset));
    return { journal: new Journal(platform, rounds, fd, placed, offset, tail), dropped };
  }

  /** The bytes of the file as the relay last wrote it. */
  get length(): number {
    return this.#length;
  }
  /** The last 64 bytes of those: what rule 11 reads back (design 3.7). */
  get tail(): Uint8Array {
    return this.#tail;
  }
  /** The running hash up to the last record. */
  get chain(): Bytes {
    return this.placed.at(-1)?.chain ?? ZERO;
  }
  /** The count of positions that a completed round covers (design 3.6). */
  get durable(): number {
    while (this.#pending[0] && this.#pending[0].ticket <= this.#rounds.synced) {
      this.#durable = (this.#pending.shift() as { count: number }).count;
    }
    return this.#durable;
  }

  /**
   * Appends `item` as the next position and returns its ticket. A short or failed write stops the
   * relay and throws before anything is indexed.
   */
  append(item: Item): { placed: Placed; ticket: number } {
    const position = this.placed.length;
    const bytes = encode(this.#platform, position, item, this.chain);
    const next = place(this.#platform, bytes, this.#length, position, this.chain);
    if (next === null) throw new Error("a record just encoded is not whole");
    const ticket = this.#rounds.write("journal", this.fd, bytes);
    this.placed.push(next.placed);
    this.#length += bytes.length;
    const keep = TAIL - Math.min(bytes.length, TAIL);
    this.#tail = Buffer.concat([
      this.#tail.subarray(Math.max(0, this.#tail.length - keep)),
      bytes.subarray(-TAIL),
    ]);
    this.#pending.push({ ticket, count: position + 1 });
    return { placed: next.placed, ticket };
  }

  /** The item at `position`, read from the file and checked, record whole, against what the relay placed. */
  read(position: number): Item {
    const held = this.placed[position];
    if (held === undefined) throw new RangeError("no such position");
    const previous = this.placed[position - 1]?.chain ?? ZERO;
    const found = place(
      this.#platform,
      readAt(this.fd, held.offset, held.length),
      held.offset,
      position,
      previous,
    );
    if (
      found === null ||
      found.placed.kind !== held.kind ||
      !bytesEqual(found.placed.id, held.id)
    ) {
      throw new DirectoryChanged("journal");
    }
    return found.item;
  }
}
