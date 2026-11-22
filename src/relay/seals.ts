/**
 * Design 3.4 and 6.2, duty 6: one history seal kept for each epoch, recipient and maker, in the
 * order taken. The seals are kept and served from memory; the file is read at start alone, and a
 * seal is given to a device only once its round completed.
 */
import { bytesEqual } from "../protocol/bytes.ts";
import { idKey } from "../protocol/device-log.ts";
import { checkHistorySeal, decodeHistorySeal, type HistorySeal } from "../protocol/epochs.ts";
import type { Bytes, Platform } from "../protocol/platform.ts";
import type { Log } from "./log.ts";
import type { Rounds } from "./round.ts";
import { type SealRecord, SealsFile } from "./seals-file.ts";
import { Code, type Conn, type Sequence } from "./sequence.ts";

/**
 * Whether the relay takes the seal: its maker is a device some held log names, its recipient a device
 * or recovery key some held log names, and its own channel placed its epoch. Each only ever becomes
 * true (a log only grows and keeps removed devices and replaced recovery keys, epochs are
 * append-only), so a start's cut on them never drops a seal that was answered.
 */
function bounded(seq: Sequence, seal: HistorySeal): boolean {
  return (
    seq.namesDevice(seal.maker) &&
    (seq.namesDevice(seal.recipient) || seq.namesRecovery(seal.recipient)) &&
    seq.placed(seal.channel, seal.epoch)
  );
}

/** The seal's (epoch, recipient, maker) key. */
const sealKey = (seal: HistorySeal): string =>
  `${idKey(seal.epoch)}|${idKey(seal.recipient)}|${idKey(seal.maker)}`;

export class Seals {
  #platform: Platform;
  #rounds: Rounds;
  #seq: Sequence;
  #file: SealsFile;
  #kept: SealRecord[] = [];
  // The ticket of each kept seal, in step with `#kept`; `#covered` of them are on disk (design 3.6).
  #tickets: number[] = [];
  #covered = 0;
  /** What a start dropped: the bytes of a torn tail, and the seals whose maker, recipient or epoch no log names or places. */
  dropped = { bytes: 0, seals: 0 };
  #keys = new Set<string>();

  private constructor(platform: Platform, rounds: Rounds, seq: Sequence, file: SealsFile) {
    this.#platform = platform;
    this.#rounds = rounds;
    this.#seq = seq;
    this.#file = file;
  }

  /**
   * Reads the seals file `fd` and logs what it dropped. A seal whose maker or recipient no device
   * log names, or whose epoch no channel placed, is dropped with all after it: the seals are synced
   * before the journal, so a power cut can leave one whose add or epoch never reached it, and the
   * file is cut there. A history seal goes by purpose to a device that was no recipient of its
   * epoch, as the model's `addHistorySeal` allows. Throws what `SealsFile.open` throws.
   */
  static async open(
    platform: Platform,
    rounds: Rounds,
    seq: Sequence,
    fd: number,
    relay: Bytes,
    log?: Log,
  ): Promise<Seals> {
    // Each record is decoded once: the decoded seal is kept for `#keep` below.
    const decoded = new Map<SealRecord, HistorySeal>();
    // Safe to cut from the first such seal: nothing at or after it was answered (the add, or the
    // epoch, was in the same round and is not durable, a later round's journal sync would have made
    // it durable, and a log keeps removed devices).
    const { file, entries, dropped, lost } = await SealsFile.open(
      platform,
      rounds,
      fd,
      relay,
      (r) => {
        const seal = decodeHistorySeal(r.signed);
        if (!seal.ok || !bounded(seq, seal.value)) return false;
        decoded.set(r, seal.value);
        return true;
      },
    );
    const seals = new Seals(platform, rounds, seq, file);
    seals.dropped = { bytes: dropped, seals: lost };
    for (const record of entries) seals.#keep(record, decoded.get(record) as HistorySeal, 0);
    log?.info(`seals: dropped ${dropped} bytes, ${seals.dropped.seals} entries`);
    return seals;
  }

  #keep(record: SealRecord, seal: HistorySeal, ticket: number): void {
    const key = sealKey(seal);
    if (this.#keys.has(key)) return;
    this.#keys.add(key);
    this.#kept.push({ signed: Uint8Array.from(record.signed), sig: Uint8Array.from(record.sig) });
    this.#tickets.push(ticket);
  }

  /** Duty 6 (the model's `addHistorySeal`): an active device's own seal for a maker, a recipient and an epoch the relay's logs and channel name; a held one is accepted again. */
  give(conn: Conn, signed: Bytes, sig: Bytes): { code: number; ticket: number } {
    const refuse = { code: Code.refused, ticket: this.#rounds.written };
    if (!this.#seq.active(conn)) return refuse;
    const log = this.#seq.devices.get(idKey(conn.person)) ?? [];
    const verdict = checkHistorySeal(this.#platform, log, signed, sig);
    if (!verdict.ok || !bytesEqual(verdict.value.maker, conn.device)) return refuse;
    if (!bounded(this.#seq, verdict.value)) return refuse;
    if (this.#keys.has(sealKey(verdict.value))) {
      return { code: Code.accepted, ticket: this.#rounds.written };
    }
    if (!this.#seq.keepsSeal(verdict.value)) return refuse; // S6, at submit only: a held seal, which an older relay may have kept, is accepted above
    const ticket = this.#file.append({ signed, sig });
    this.#keep({ signed, sig }, verdict.value, ticket); // a copy: the frame's buffer is reused
    return { code: Code.accepted, ticket };
  }

  /** The seals on disk, in the order taken; none for a device the log does not hold as active. */
  list(conn: Conn): SealRecord[] {
    return this.since(conn, 0);
  }

  /** The seals on disk from the `from`th, which a follower that holds the ones before it is given. */
  since(conn: Conn, from: number): SealRecord[] {
    if (!this.#seq.active(conn)) return [];
    while ((this.#tickets[this.#covered] ?? Number.POSITIVE_INFINITY) <= this.#rounds.synced)
      this.#covered += 1;
    return this.#kept.slice(from, this.#covered);
  }
}
