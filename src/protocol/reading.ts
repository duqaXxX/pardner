/**
 * The device's reading of the relay's sequence (relay continuity design 4, security design 5.10),
 * written once for the bot and the app. Pure: the caller hands in each frame of a read or a follow
 * and gets back what to do, and keeps `kept` in its store. It never sends, and builds nothing.
 */

import type { Place } from "./bot-reader.ts";
import { bytesEqual } from "./bytes.ts";
import { checkDeviceEntry, idKey, type LoggedEntry } from "./device-log.ts";
import { Seen } from "./device-reader.ts";
import {
  checkEpochEntry,
  decodeEpochEntry,
  encodeHistorySeal,
  type HistorySeal,
  type LoggedEpoch,
  openEpochSeal,
  openHistorySeal,
} from "./epochs.ts";
import type { Frame } from "./frames.ts";
import { relayKeyId, signedId } from "./ids.ts";
import { checkMemberEntry, decodeMemberEntry, type LoggedMember } from "./member-log.ts";
import { decodeMessage, type Message, messageChecker } from "./messages.ts";
import type { Bytes, Platform } from "./platform.ts";
import { chainLink, checkHead, type RelayHead } from "./proofs.ts";

/** What a device keeps of the relay between runs: the id read at each position, the last head the relay signed, and whether it must be recreated. */
export interface Kept {
  ids: Bytes[];
  head: { head: RelayHead; sig: Bytes } | undefined;
  putBack: boolean;
}

/** Who reads: the person it was paired for, its own id, the name of its receiving key, and the relay's pinned key. */
export interface Who {
  platform: Platform;
  relay: Bytes;
  person: Bytes;
  self: Bytes;
  receiving: string;
}

export type State = "reading" | "rest" | "giving-back" | "refused" | "put-back" | "fault";

/** What the caller does next. `read` and `give-back` are for it to send; the rest it acts on. */
export type Out =
  | { do: "read"; from: number }
  | { do: "incarnation"; incarnation: Bytes; first: boolean; changed: boolean }
  | { do: "message"; message: Message; place: Place }
  | { do: "rest"; first: boolean }
  | { do: "give-back"; head: RelayHead; sig: Bytes }
  | { do: "refused"; reason: 1 | 2 | 3 | 5 }
  | { do: "put-back" }
  | { do: "fault"; why: string };

/** A channel as the reading folded it: its logs, the keys it holds, and whether its current epoch is open. */
export interface ChannelView {
  members: readonly LoggedMember[];
  epochs: readonly LoggedEpoch[];
  /** The key of the current epoch, when this device holds it. */
  key: Bytes | undefined;
  /** `openAt` the current epoch. */
  open: boolean;
}

interface Channel {
  members: LoggedMember[];
  epochs: LoggedEpoch[];
  keys: Map<string, Bytes>;
  check?: ReturnType<typeof messageChecker> | undefined;
}

const ZERO = new Uint8Array(32);

/**
 * Design 3.4, the model's `open()`: the epoch's device heads are the logs' length now, and no entry
 * that changes the member set came after its member head.
 */
export function openAt(
  epoch: LoggedEpoch | undefined,
  members: readonly LoggedMember[],
  logLength: number,
): boolean {
  return epoch
    ? epoch.entry.deviceHeads.every((h) => h.length === logLength) &&
        members.slice(epoch.entry.memberHead.length).every((m) => !m.changesMembers)
    : false;
}

export class Reading {
  readonly kept: Kept;
  #r: Who;
  #state: State = "reading";
  #served = false;
  #incarnation: Bytes | undefined;
  #first = true; // the next complete pass is the first under this incarnation
  #origin: "read" | "refused" = "read";
  #refusal: 1 | 2 = 1; // the reason a give-back on a refusal answers for
  #gave = false; // gave back on this refusal already
  #asked = false; // a read is asked for, and its `position` not yet here
  #inRead = false; // between a read's `position` and its head: the answer, not a push
  #cursor = 0;
  #chains: Bytes[] = [];
  #log: LoggedEntry[] = [];
  #channels = new Map<string, Channel>();
  #seals: { seal: HistorySeal; sig: Bytes; id: Bytes }[] = []; // `id`: the seal's own, never its signature (crypto.md 4)
  #seen = new Seen();

  /**
   * `stored` is what the caller's store holds: the incarnation last read under (a full pass is still owed
   * after a restart, so `rest.first` stays true) and a fault, which ends the reading at once.
   */
  constructor(
    reader: Who,
    kept: Kept = { ids: [], head: undefined, putBack: false },
    stored: { incarnation?: Bytes; fault?: boolean } = {},
  ) {
    this.#r = reader;
    this.#incarnation = stored.incarnation;
    this.kept = kept;
    if (kept.putBack) this.#state = "put-back";
    else if (stored.fault) this.#state = "fault";
  }

  get state(): State {
    return this.#state;
  }

  get cursor(): number {
    return this.#cursor;
  }

  /** Whether the caller may build and send: a pass under the served incarnation reached its head (PD 6.7). */
  get sendable(): boolean {
    return this.#state === "rest";
  }

  channels(): Bytes[] {
    return [...this.#channels.values()].flatMap((c) => (c.members[0] ? [c.members[0].id] : []));
  }

  /** The folded channel, or `undefined` while no entry of it is read. */
  channel(id: Bytes): ChannelView | undefined {
    const c = this.#channels.get(idKey(id));
    const last = c?.epochs.at(-1);
    if (!c) return undefined;
    return {
      members: c.members,
      epochs: c.epochs,
      key: last && c.keys.get(idKey(last.id)),
      open: openAt(last, c.members, this.#log.length),
    };
  }

  /** The device's own log of its person, every entry checked. */
  get devices(): readonly LoggedEntry[] {
    return this.#log;
  }

  /** The connection ended: what was being read is read again from the cursor at the next one. */
  dropped(): void {
    this.#served = false;
    if (this.#state === "rest") this.#state = "reading";
    if (this.#state === "giving-back") {
      if (this.#origin === "refused") this.#gave = false; // no answer: owed again at the next refusal
      this.#state = this.#origin === "refused" ? "refused" : "reading";
    }
  }

  /** The answer to a give-back: a result code, or the reason of the `refused` that answered it, or neither when none came. */
  gaveBack(code: number | undefined, refused?: number): Out[] {
    if (this.#state !== "giving-back") return [];
    if (code === 11 || refused === 6) return this.#putBack();
    if (this.#origin === "refused") {
      this.#state = "refused";
      if (code === undefined) this.#gave = false; // no answer: owed again at the next refusal
      return [{ do: "refused", reason: this.#refusal }];
    }
    // Result 0 or 1: the relay holds the head, or takes no head of this key; the difference lies past
    // what this device can prove (RC L9), and the model puts the relay back for it on any answer but 'accepted'.
    if (code !== undefined) return this.#putBack();
    this.#state = "reading"; // no answer: the next read finds the difference again
    return [];
  }

  take(f: Frame): Out[] {
    if (["put-back", "fault", "giving-back"].includes(this.#state)) return [];
    switch (f.type) {
      case "served":
        return this.#serve(f.incarnation);
      case "refused":
        return this.#refused(f.reason);
      case "position":
        this.#seals = []; // a read's seals are the relay's list as it stands
        this.#asked = false;
        this.#inRead = true;
        return [];
      case "seals":
        for (const s of f.items) {
          const id = signedId(this.#r.platform, encodeHistorySeal(s.seal));
          if (!this.#seals.some((h) => bytesEqual(h.id, id))) this.#seals.push({ ...s, id });
        }
        this.#unlock();
        return [];
      case "item":
        return this.#item(f.position, f.kind, f.signed, f.sig);
      case "head":
        return this.#head(f.n, f.chain, f.sig);
      default:
        return [];
    }
  }

  #serve(incarnation: Bytes): Out[] {
    this.#inRead = false;
    const first = this.#incarnation === undefined;
    const changed = !first && !bytesEqual(this.#incarnation as Bytes, incarnation);
    if (changed) this.#rewind(); // another incarnation: read again from the start (5.10)
    this.#incarnation = incarnation;
    this.#served = true;
    this.#state = "reading";
    this.#gave = false;
    if (first || changed) this.#first = true; // the first pass under an incarnation
    this.#asked = true;
    return [
      { do: "incarnation", incarnation, first, changed },
      { do: "read", from: this.#cursor },
    ];
  }

  #rewind(): void {
    this.#cursor = 0;
    this.#chains = [];
    this.#log = [];
    this.#channels = new Map();
    this.#seen = new Seen();
  }

  #refused(reason: 1 | 2 | 3 | 5 | 6): Out[] {
    if (reason === 6) return this.#putBack();
    this.#served = false;
    this.#state = "refused";
    if ((reason === 1 || reason === 2) && this.kept.head && !this.#gave) {
      // A relay put back by hand may lack the add, and fails closed on a head it does not hold.
      this.#gave = true;
      return this.#giveBack("refused", reason);
    }
    return [{ do: "refused", reason }];
  }

  #giveBack(origin: "read" | "refused", reason?: 1 | 2): Out[] {
    const held = this.kept.head;
    if (!held) return this.#putBack(); // no head: the difference lies past it, for this device alone
    this.#origin = origin;
    this.#state = "giving-back";
    if (reason) this.#refusal = reason;
    return [{ do: "give-back", head: held.head, sig: held.sig }];
  }

  #putBack(): Out[] {
    this.#state = "put-back";
    this.kept.putBack = true;
    return [{ do: "put-back" }];
  }

  #fault(why: string): Out[] {
    this.#state = "fault";
    return [{ do: "fault", why }];
  }

  #item(position: number, kind: number, signed: Bytes, sig: Bytes): Out[] {
    if (!this.#served) return [];
    if (position > this.#cursor) return this.#ask(); // a gap: items are never skipped
    const id = signedId(this.#r.platform, signed);
    const had = this.kept.ids[position];
    if (had && !bytesEqual(had, id)) return this.#giveBack("read"); // 5.11: not what it read here
    if (position < this.#cursor) return [];
    this.#state = "reading";
    const out = this.#fold(kind, signed, sig);
    if (this.#state !== "reading") return out;
    this.kept.ids[position] = id;
    const previous = this.#chains[position - 1] ?? ZERO;
    this.#chains[position] = chainLink(this.#r.platform, previous, id);
    this.#cursor += 1;
    return out;
  }

  #ask(): Out[] {
    if (this.#asked) return [];
    this.#asked = true;
    return [{ do: "read", from: this.#cursor }];
  }

  #head(n: number, chain: Bytes, sig: Bytes): Out[] {
    const { platform, relay } = this.#r;
    const head = { relay: relayKeyId(platform, relay), n, chain };
    if (!checkHead(platform, relay, head, sig)) return this.#fault("a head the relay did not sign");
    const answer = this.#inRead;
    this.#inRead = false;
    if (!this.#served) return [];
    // A push older than what is held never lowers it; a read that ends before the cursor is a relay behind.
    if (n < this.#cursor) return answer ? this.#giveBack("read") : [];
    if (n > this.#cursor) return this.#ask();
    if (this.kept.ids.length > n) return this.#giveBack("read"); // the relay ends before what was read
    if (n > 0 && !bytesEqual(this.#chains[n - 1] as Bytes, chain))
      return this.#fault("a head that is not the running hash of the items given");
    if (!this.kept.head || n >= this.kept.head.head.n) this.kept.head = { head, sig };
    this.#state = "rest";
    const first = this.#first;
    this.#first = false;
    return [{ do: "rest", first }];
  }

  #fold(kind: number, signed: Bytes, sig: Bytes): Out[] {
    const { platform, person } = this.#r;
    const bad = (what: string) => this.#fault(`${what} refused`);
    if (kind === 1) {
      const v = checkDeviceEntry(platform, this.#log, signed, sig);
      if (!v.ok) return bad("a device entry");
      if (this.#log.length === 0 && !bytesEqual(v.value.id, person))
        return this.#fault("not the person I was given");
      this.#log.push(v.value);
      this.#unlock();
    } else if (kind === 2) {
      const d = decodeMemberEntry(signed);
      if (!d.ok) return bad("a member entry");
      const id = d.value.channel ?? signedId(platform, signed);
      const c: Channel = this.#channels.get(idKey(id)) ?? {
        members: [],
        epochs: [],
        keys: new Map(),
      };
      const v = checkMemberEntry(platform, c.members, signed, sig, this.#log);
      if (!v.ok || !bytesEqual(d.value.signerPerson, person)) return bad("a member entry");
      c.members.push(v.value);
      this.#channels.set(idKey(id), c);
    } else if (kind === 3) {
      const d = decodeEpochEntry(signed);
      const c = d.ok && this.#channels.get(idKey(d.value.channel));
      if (!c) return bad("an epoch entry");
      const v = checkEpochEntry(platform, c.epochs, c.members, [this.#log], signed, sig);
      if (!v.ok) return bad("an epoch entry");
      c.epochs.push(v.value);
      c.check = undefined;
      this.#unlock();
    } else return this.#message(signed, sig);
    return [];
  }

  #message(signed: Bytes, sig: Bytes): Out[] {
    const d = decodeMessage(signed);
    const c = d.ok && this.#channels.get(idKey(d.value.header.channel));
    if (!c) return [];
    c.check ??= messageChecker(this.#r.platform, c.epochs, [this.#log]);
    const v = c.check(signed, sig);
    const last = c.epochs.at(-1);
    if (!v.ok || !last || this.#seen.check(v.value.message.header) === "again") return [];
    this.#seen.add(v.value.message.header);
    const place: Place = {
      epoch: last.id,
      member: last.entry.seals.some((s) => bytesEqual(s.recipient, this.#r.self)),
      key: c.keys.get(idKey(last.id)),
      log: this.#log,
      length: this.#log.length,
    };
    return [{ do: "message", message: v.value.message, place }];
  }

  /** The key of each epoch this device holds: its own seal in the entry, or a history seal another device made (5.3). */
  #unlock(): void {
    const { platform, self, receiving } = this.#r;
    for (const c of this.#channels.values())
      for (const e of c.epochs) {
        if (c.keys.has(idKey(e.id))) continue;
        let key = openEpochSeal(platform, receiving, e, self);
        for (const h of this.#seals) {
          if (key.ok) break;
          if (!bytesEqual(h.seal.recipient, self) || !bytesEqual(h.seal.epoch, e.id)) continue;
          key = openHistorySeal(
            platform,
            receiving,
            this.#log,
            encodeHistorySeal(h.seal),
            h.sig,
            e,
          );
        }
        if (key.ok) c.keys.set(idKey(e.id), key.value);
      }
  }
}
