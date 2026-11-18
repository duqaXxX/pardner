/**
 * Design 3.4: the history seals as a file.
 *
 *   seals  = header ‖ entry...
 *   header = L("blind-relay/1 seals") ‖ relay: B32
 *   entry  = length: u32 ‖ var(signed seal) ‖ SIG ‖ check: B32
 *
 * `length` counts the bytes after it; `check` is SHA-256 of every byte of the entry before it. A
 * start reads the file once and drops from the first entry that is not whole, as the journal's does.
 */
import { fstatSync, ftruncateSync } from "node:fs";
import { bytesEqual, decode, Writer } from "../protocol/bytes.ts";
import type { Bytes, Platform } from "../protocol/platform.ts";
import { fileHeader, NotWhole, readAt } from "./journal.ts";
import type { Rounds } from "./round.ts";

export interface SealRecord {
  signed: Bytes;
  sig: Bytes;
}

/** The record of a whole entry, or null. */
function parse(platform: Platform, entry: Buffer): SealRecord | null {
  const read = decode(entry, (r) => {
    r.u32();
    return { signed: r.var(), sig: r.sig(), check: r.b32() };
  });
  const whole = read.ok && bytesEqual(read.value.check, platform.sha256(entry.subarray(0, -32)));
  return whole ? { signed: read.value.signed, sig: read.value.sig } : null;
}

export class SealsFile {
  #rounds: Rounds;
  #fd: number;
  #platform: Platform;

  private constructor(platform: Platform, rounds: Rounds, fd: number) {
    this.#platform = platform;
    this.#rounds = rounds;
    this.#fd = fd;
  }

  /**
   * Reads the seals file `fd` (opened for appending) and drops from the first entry that is not
   * whole, or that `keep` refuses, truncating and syncing before it returns. `entries` are the ones
   * kept; `lost` counts the whole entries cut with the refused one. Throws `NotWhole` for another
   * relay's header.
   */
  static async open(
    platform: Platform,
    rounds: Rounds,
    fd: number,
    relay: Bytes,
    keep: (record: SealRecord) => boolean = () => true,
  ): Promise<{ file: SealsFile; entries: SealRecord[]; dropped: number; lost: number }> {
    const header = fileHeader("seals", relay);
    const bytes = readAt(fd, 0, fstatSync(fd).size);
    if (!bytes.subarray(0, header.length).equals(header)) throw new NotWhole("seals header");
    const entries: SealRecord[] = [];
    let at = header.length;
    let cut = -1;
    let lost = 0;
    while (at + 4 <= bytes.length) {
      const end = at + 4 + bytes.readUInt32BE(at);
      const record = end <= bytes.length ? parse(platform, bytes.subarray(at, end)) : null;
      if (!record) break;
      if (cut < 0 && !keep(record)) cut = at;
      if (cut < 0) entries.push(record);
      else lost += 1;
      at = end;
    }
    const kept = cut < 0 ? at : cut;
    if (kept < bytes.length) rounds.guard("seals", () => ftruncateSync(fd, kept));
    await rounds.barrier([["seals", fd]]);
    return {
      file: new SealsFile(platform, rounds, fd),
      entries,
      dropped: bytes.length - kept,
      lost,
    };
  }

  /** Appends the entry and returns its ticket; a short or failed write stops the relay. */
  append(record: SealRecord): number {
    const body = new Writer().var(record.signed).sig(record.sig).bytes();
    const head = new Writer()
      .u32(body.length + 32)
      .raw(body)
      .bytes();
    return this.#rounds.write(
      "seals",
      this.#fd,
      Buffer.concat([head, this.#platform.sha256(head)]),
    );
  }
}
