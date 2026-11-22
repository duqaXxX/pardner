/**
 * Design 3.9, 3.10, 6.2 and 6.6: the duties of SD 5.0 as the relay applies them to a frame's
 * content. One synchronous function per frame evaluates it against the indexes, appends the item to
 * the journal and indexes it; nothing awaits, so the order of calls is the order of duty 1. An
 * answer waits for the ticket it returns (design 3.6). The connection's proof, rule 11's check and
 * the frames are the caller's. This part holds the device logs; the channels come after it.
 */
import { bytesEqual } from "../protocol/bytes.ts";
import {
  checkDeviceEntry,
  currentRecovery,
  type DeviceKeys,
  decodeDeviceEntry,
  foldLog,
  idKey,
  type LoggedEntry,
  type PublicKeys,
} from "../protocol/device-log.ts";
import {
  checkEpochEntry,
  decodeEpochEntry,
  type HistorySeal,
  type LoggedEpoch,
} from "../protocol/epochs.ts";
import { deviceId, recoveryKeyId, signedId } from "../protocol/ids.ts";
import {
  checkMemberEntry,
  decodeMemberEntry,
  type LoggedMember,
  membersOf,
} from "../protocol/member-log.ts";
import {
  decodeMessage,
  KIND_BUILD,
  type MessageHeader,
  type MessageVerdict,
  messageChecker,
} from "../protocol/messages.ts";
import type { Bytes, Platform } from "../protocol/platform.ts";
import { encodeHead, type RelayHead } from "../protocol/proofs.ts";
import { type Item, Journal, type Placed } from "./journal.ts";
import type { Rounds } from "./round.ts";

/** The codes of design 6.7 that a duty answers. */
export const Code = {
  accepted: 0,
  refused: 1,
  position: 2,
  closed: 3,
  ended: 4,
  removed: 5,
  missing: 7,
  tooLarge: 8,
  gone: 9,
  /** A head given back that the sequence does not hold: the relay failed closed (6.5). */
  putBack: 11,
} as const;
/** The item kinds of a `submit` frame. */
const KIND = { device: 1, member: 2, epoch: 3, message: 4 } as const;
const ZERO = new Uint8Array(32);

/** What a proof established: the person, the device, and for a recovery the recovery key's id. */
export interface Conn {
  person: Bytes;
  device: Bytes;
  recovery?: Bytes;
}
/**
 * An evaluated frame. The answer is sent once `ticket` is on disk. `removed` are the devices this
 * entry removed: their connections close before the round's items go out (design 6.3, I5).
 */
export interface Outcome {
  code: number;
  ticket: number;
  removed: Bytes[];
}
/**
 * The relay's answer to a `read`: the head at `durable`, and the items up to it, read back from the
 * journal. `ticket` is the state the device was judged on (design 3.6): the answer is sent once it
 * is on disk.
 */
export interface Read {
  removed: false;
  ticket: number;
  head: RelayHead;
  sig: Bytes;
  items(): Generator<{ position: number; kind: number; signed: Bytes; sig: Bytes }>;
}
/** A read, or the refusal of a device the log does not hold as active. */
export type Fetched = Read | { removed: true; ticket: number };
/** The journal holds an item of a kind this part of the relay does not place. */
export class UnknownItem extends Error {}
/** One channel's logs, whether its current epoch is closed, and the slots the current epoch used. */
export interface Channel {
  members: LoggedMember[];
  epochs: LoggedEpoch[];
  /** The ids of `epochs`, for a seal's look-up. */
  epochIds: Set<string>;
  closed: boolean;
  slots: Set<string>;
  /** The persons who are members now, by id. */
  persons: Set<string>;
}
interface Reference {
  build: boolean;
  sender: string;
  name: string;
  position: number;
}
/** What a checked item is, for the indexes: the package's verdict value, or a message's header. */
type Parsed =
  | { device: LoggedEntry }
  | { member: LoggedMember }
  | { epoch: LoggedEpoch }
  | { header: MessageHeader };
export interface Deps {
  /** The relay key's id. */
  relay: Bytes;
  /** The relay key's signature over a head. */
  sign(message: Bytes): Bytes;
  /** Whether a blob is held on disk (PR 4); none is until then. */
  held?: (blob: Bytes) => boolean;
}

/** A person's devices as the log leaves them: kept until the log grows, so a frame reads them once. */
interface View {
  active: Map<string, DeviceKeys>;
  named: Map<string, DeviceKeys>;
  recovery: Bytes | undefined;
  recoveryKeys: PublicKeys | undefined;
  recoveries: Map<string, PublicKeys>;
}

export class Sequence {
  /** Per person id: the checked device-log entries. */
  readonly devices = new Map<string, LoggedEntry[]>();
  /** Per channel id. */
  readonly channels = new Map<string, Channel>();
  #platform: Platform;
  #rounds: Rounds;
  #deps: Deps;
  #journal!: Journal;
  #views = new Map<string, View>();
  /** Every device and recovery key any held log ever named, by `idKey`: what a history seal is bounded by. */
  #deviceNames = new Set<string>();
  #recoveryNames = new Set<string>();
  #messages = new Set<string>();
  #checkers = new Map<string, (signed: Bytes, sig: Bytes) => MessageVerdict>();
  // Builds (SD 5.12, point 8): the first copy of each sender's name, and each sender's builds in order.
  #firstAt = new Map<string, number>();
  #builds = new Map<string, number[]>();
  #byPerson = new Map<string, Set<Channel>>();
  /** Per person id: the first placed channel of the space class, which is the person's space (personal space design 2.3). */
  #spaces = new Map<string, string>();
  /** Per person id: the position of each device-log entry, in the log's order (the recovery log reads them back). */
  #at = new Map<string, number[]>();
  #named = new Map<string, Reference[]>();
  /** The blobs (hex) of each sender's builds since the first copy of its newest one. */
  #buildBlobs = new Map<string, Set<string>>();
  /**
   * The blobs (hex) a round must look at: those a build placed has made unwanted, and those a message
   * placed names, which may be unwanted as it is (a later copy of an older build). A blob leaves once
   * it is removed or wanted (design 3.11, M4).
   */
  readonly toCheck = new Set<string>();
  #signed: { n: number; sig: Bytes } | undefined;

  private constructor(platform: Platform, rounds: Rounds, deps: Deps) {
    this.#platform = platform;
    this.#rounds = rounds;
    this.#deps = deps;
  }

  /**
   * Reads the journal `fd` and builds the indexes in the same pass, through the function a submit
   * uses (design 3.2), so a start and a run agree. Throws what `Journal.open` throws, and
   * `UnknownItem` for an item this part does not place.
   */
  static async open(
    platform: Platform,
    rounds: Rounds,
    fd: number,
    deps: Deps,
  ): Promise<{ seq: Sequence; journal: Journal; dropped: number }> {
    const seq = new Sequence(platform, rounds, deps);
    const { journal, dropped } = await Journal.open(platform, rounds, fd, deps.relay, (p, item) =>
      seq.#restore(p, item),
    );
    seq.#journal = journal;
    return { seq, journal, dropped };
  }

  /**
   * The blob's wanted state: `undefined` when no message names it, else whether one still wants it.
   * A removal goes by what is on disk, `"durable"`: a replaced build's blob stays until the build
   * that replaces it is (design 3.11, RC F2).
   */
  wanted(blob: Bytes, asOf: "written" | "durable" = "written"): boolean | undefined {
    const upTo = asOf === "durable" ? this.#journal.durable : Number.POSITIVE_INFINITY;
    const refs = this.#named.get(idKey(blob))?.filter((r) => r.position < upTo);
    if (!refs?.length) return undefined;
    const newest = (sender: string) => this.#builds.get(sender)?.findLast((at) => at < upTo);
    return refs.some(
      (r) => !r.build || this.#firstAt.get(`${r.sender}|${r.name}`) === newest(r.sender),
    );
  }

  /**
   * Design 6.6: places a genesis for the enrolment. Returns the ticket the proof waits for, or null
   * when nothing is held. The enrolment secret is the caller's: `secret` is step 3, asked only once
   * the identical genesis (step 1) and the empty journal (step 2) have been looked at, and before
   * the genesis itself is checked.
   */
  enrol(signed: Bytes, sig: Bytes, secret: () => boolean): number | null {
    const id = signedId(this.#platform, signed);
    if (this.devices.has(idKey(id))) return this.#rounds.written;
    if (this.devices.size > 0 || !secret()) return null;
    const verdict = checkDeviceEntry(this.#platform, [], signed, sig);
    if (!verdict.ok || verdict.value.entry.kind !== "genesis") return null;
    return this.#append(KIND.device, signed, sig, { device: verdict.value }).ticket;
  }

  /** The item of a `submit`, in the model's order. */
  submit(conn: Conn, kind: number, signed: Bytes, sig: Bytes): Outcome {
    const log = this.devices.get(idKey(conn.person));
    if (!log) return this.#out(Code.refused);
    if (kind === KIND.device) return this.#device(conn, log, signed, sig);
    // Every other duty is an active device's: a removed or unknown one is told so.
    if (!this.#view(conn.person, log).active.has(idKey(conn.device)))
      return this.#out(Code.removed);
    if (kind === KIND.member) return this.#member(conn, signed, sig);
    if (kind === KIND.epoch) return this.#epoch(conn, signed, sig);
    return kind === KIND.message ? this.#message(conn, signed, sig) : this.#out(Code.refused);
  }

  /** Whether the person's log holds the connection's device as active. */
  active(conn: Conn): boolean {
    const log = this.devices.get(idKey(conn.person));
    return log !== undefined && this.#view(conn.person, log).active.has(idKey(conn.device));
  }

  /** What a proof is checked against (6.1): the device the log names, removed ones too, and whether it is active, and the current recovery key with its id. Null when the log is not held. */
  standing(
    person: Bytes,
    device?: Bytes,
  ): { device?: DeviceKeys; active: boolean; recovery?: PublicKeys; recoveryId?: Bytes } | null {
    const log = this.devices.get(idKey(person));
    if (!log) return null;
    const view = this.#view(person, log);
    const key = device && idKey(device);
    return {
      device: key === undefined ? undefined : view.named.get(key),
      active: key !== undefined && view.active.has(key),
      recovery: view.recoveryKeys,
      recoveryId: view.recovery,
    };
  }

  /** Whether a held log ever named the device; true for good, as a log only grows and keeps removed devices. */
  namesDevice(id: Bytes): boolean {
    return this.#deviceNames.has(idKey(id));
  }

  /** Whether a held log ever named the recovery key; true for good, as a reset replaces a key and keeps it named. */
  namesRecovery(id: Bytes): boolean {
    return this.#recoveryNames.has(idKey(id));
  }

  /**
   * S6 (personal space design 2.4): whether the relay may keep a history seal of its channel's epoch. A
   * seal of a space epoch is kept only when its maker and its recipient are a device or recovery key
   * that the space's own person's log names; any other channel's is not bounded by this.
   */
  keepsSeal(seal: HistorySeal): boolean {
    const first = this.channels.get(idKey(seal.channel))?.members[0];
    if (!first?.space) return true;
    const owner = first.entry.signerPerson;
    const log = this.devices.get(idKey(owner));
    if (!log) return false;
    const { named, recoveries } = this.#view(owner, log);
    return (
      named.has(idKey(seal.maker)) &&
      (named.has(idKey(seal.recipient)) || recoveries.has(idKey(seal.recipient)))
    );
  }

  /** Whether the channel placed the epoch; true for good, as epochs are append-only. */
  placed(channel: Bytes, epoch: Bytes): boolean {
    return this.channels.get(idKey(channel))?.epochIds.has(idKey(epoch)) === true;
  }

  /** Duty 6: the head over what is on disk, and the items from `from` up to it; a removed device gets none. */
  fetch(conn: Conn, from: number): Fetched {
    if (!Number.isSafeInteger(from) || from < 0)
      throw new RangeError("a read starts at a position");
    const ticket = this.#rounds.written;
    if (!this.active(conn)) return { removed: true, ticket };
    const n = this.#journal.durable;
    const head = { relay: this.#deps.relay, n, chain: this.#journal.placed[n - 1]?.chain ?? ZERO };
    const journal = this.#journal;
    return {
      removed: false,
      ticket,
      head,
      sig: this.#signature(head),
      *items() {
        for (let position = from; position < n; position++) {
          yield { position, ...journal.read(position) };
        }
      },
    };
  }

  /** The relay's signature of the head, made once per length: every follower of a round is given the same one. */
  #signature(head: RelayHead): Bytes {
    if (this.#signed?.n !== head.n)
      this.#signed = { n: head.n, sig: this.#deps.sign(encodeHead(head)) };
    return this.#signed.sig;
  }

  /**
   * The person's device-log entries up to what is on disk, as they were signed, read one at a time as
   * the caller takes them; null when the log is not held.
   */
  recoveryLog(person: Bytes): Iterable<{ signed: Bytes; sig: Bytes }> | null {
    const at = this.#at.get(idKey(person));
    if (at === undefined) return null;
    const durable = this.#journal.durable;
    const journal = this.#journal;
    const on = at.filter((p) => p < durable);
    return (function* () {
      for (const p of on) yield journal.read(p);
    })();
  }

  /** The id of the person's recovery key as the entries on disk hold it; undefined when none, null when the log is not held. */
  recoveryOnDisk(person: Bytes): Bytes | undefined | null {
    const log = this.devices.get(idKey(person));
    const at = this.#at.get(idKey(person));
    if (!log || !at) return null;
    const durable = this.#journal.durable;
    const recovery = currentRecovery(
      this.#platform,
      log.slice(0, at.filter((p) => p < durable).length),
    );
    return recovery && recoveryKeyId(this.#platform, recovery.signing, recovery.receiving);
  }

  /** An answer that places nothing: it waits for every write made so far (design 3.6). */
  #out(code: number): Outcome {
    return { code, ticket: this.#rounds.written, removed: [] };
  }

  #view(person: Bytes, log: readonly LoggedEntry[]): View {
    const key = idKey(person);
    let view = this.#views.get(key);
    if (!view) {
      const folded = foldLog(this.#platform, log);
      const recovery = folded.recovery;
      view = {
        active: folded.active,
        named: folded.named,
        recovery: recovery && recoveryKeyId(this.#platform, recovery.signing, recovery.receiving),
        recoveryKeys: recovery,
        recoveries: folded.recoveries,
      };
      this.#views.set(key, view);
    }
    return view;
  }

  #device(conn: Conn, log: LoggedEntry[], signed: Bytes, sig: Bytes): Outcome {
    const view = this.#view(conn.person, log);
    const device = idKey(conn.device);
    if (!view.active.has(device) && view.named.has(device)) return this.#out(Code.removed);
    const decoded = decodeDeviceEntry(signed);
    if (!decoded.ok) return this.#out(Code.refused);
    const e = decoded.value;
    // A device in no log is proven only by the recovery key, and only for the reset that names it.
    const brings =
      e.kind === "reset" &&
      conn.recovery !== undefined &&
      view.recovery !== undefined &&
      bytesEqual(conn.recovery, view.recovery) &&
      e.newDevice !== undefined &&
      bytesEqual(
        deviceId(this.#platform, e.newDevice.device.signing, e.newDevice.device.receiving),
        conn.device,
      );
    if (!view.active.has(device) && !brings) return this.#out(Code.refused);
    const held = log[e.seq];
    if (held && bytesEqual(held.id, signedId(this.#platform, signed)))
      return this.#out(Code.accepted);
    if (e.kind !== "reset" && !bytesEqual(e.signer, conn.device)) return this.#out(Code.refused);
    const verdict = checkDeviceEntry(this.#platform, log, signed, sig);
    if (!verdict.ok) return this.#out(verdict.rule === "position" ? Code.position : Code.refused);
    const { ticket } = this.#append(KIND.device, signed, sig, { device: verdict.value });
    const after = this.#view(conn.person, log).active;
    const removed = [...view.active]
      .filter(([k]) => !after.has(k))
      .map(([, d]) => deviceId(this.#platform, d.signing, d.receiving));
    return { code: Code.accepted, ticket, removed };
  }

  #member(conn: Conn, signed: Bytes, sig: Bytes): Outcome {
    const decoded = decodeMemberEntry(signed);
    if (!decoded.ok) return this.#out(Code.refused);
    const e = decoded.value;
    const id = signedId(this.#platform, signed);
    const held = this.channels.get(idKey(e.channel ?? id));
    if (!held && e.kind !== "create") return this.#out(Code.refused);
    if (holds(held?.members ?? [], e.seq, id)) return this.#out(Code.accepted);
    if (!bytesEqual(e.signerDevice, conn.device) || !bytesEqual(e.signerPerson, conn.person))
      return this.#out(Code.refused);
    // S2 (personal space design 2.4): a space's member log is entry 0 alone. Here and not in the check, which a start runs again.
    if (held?.members[0]?.space) return this.#out(Code.refused);
    const verdict = checkMemberEntry(
      this.#platform,
      held?.members ?? [],
      signed,
      sig,
      this.devices.get(idKey(e.signerPerson)) ?? [],
    );
    if (!verdict.ok) return this.#out(verdict.rule === "position" ? Code.position : Code.refused);
    // S1: a person's space is the first of its class that is placed; the next is answered like a position taken.
    if (verdict.value.space && this.#spaces.has(idKey(e.signerPerson)))
      return this.#out(Code.position);
    return this.#placed(KIND.member, signed, sig, { member: verdict.value });
  }

  #epoch(conn: Conn, signed: Bytes, sig: Bytes): Outcome {
    const decoded = decodeEpochEntry(signed);
    const held = decoded.ok ? this.channels.get(idKey(decoded.value.channel)) : undefined;
    if (!decoded.ok || !held) return this.#out(Code.refused);
    const e = decoded.value;
    if (holds(held.epochs, e.seq, signedId(this.#platform, signed)))
      return this.#out(Code.accepted);
    if (!bytesEqual(e.signerDevice, conn.device) || !bytesEqual(e.signerPerson, conn.person))
      return this.#out(Code.refused);
    const verdict = checkEpochEntry(
      this.#platform,
      held.epochs,
      held.members,
      [...this.devices.values()],
      signed,
      sig,
    );
    if (!verdict.ok)
      return this.#out(
        verdict.rule === "position" || verdict.rule === "prev" ? Code.position : Code.refused,
      );
    // SD 5.7: another device was first, or a head moved meanwhile: the device fetches again.
    const current =
      e.memberHead.length === held.members.length &&
      e.deviceHeads.every((h) => this.devices.get(idKey(h.person))?.length === h.length);
    if (!current) return this.#out(Code.position);
    return this.#placed(KIND.epoch, signed, sig, { epoch: verdict.value });
  }

  #message(conn: Conn, signed: Bytes, sig: Bytes): Outcome {
    if (this.#messages.has(idKey(signedId(this.#platform, signed))))
      return this.#out(Code.accepted);
    const decoded = decodeMessage(signed);
    if (!decoded.ok) return this.#out(Code.refused);
    const h = decoded.value.header;
    if (!bytesEqual(h.sender, conn.device)) return this.#out(Code.refused);
    const held = this.channels.get(idKey(h.channel));
    if (!held) return this.#out(Code.refused);
    const current = held.epochs.at(-1);
    if (!current || !bytesEqual(current.id, h.epoch)) return this.#out(Code.ended);
    if (held.closed) return this.#out(Code.closed);
    if (!this.#checker(held, h.channel)(signed, sig).ok || held.slots.has(slotOf(h)))
      return this.#out(Code.refused);
    // SD 5.12, points 3 and 4: a blob that is not on disk and no longer wanted is gone for good, so
    // the outbox that holds the message drops it; one that is only not on disk yet is missing.
    const unheld = h.blobs.filter((b) => !this.#deps.held?.(b));
    if (unheld.some((b) => this.wanted(b) === false)) return this.#out(Code.gone);
    if (unheld.length > 0) return this.#out(Code.missing);
    return this.#placed(KIND.message, signed, sig, { header: h });
  }

  /**
   * The package's check of a message, over the channel's current epoch, rebuilt when an epoch is
   * placed (design 3.9), in the class of its channel (S5). A device log that grows changes no verdict:
   * the epoch's heads cut each log where it was (`messageChecker`'s contract).
   */
  #checker(held: Channel, channel: Bytes) {
    const key = idKey(channel);
    let check = this.#checkers.get(key);
    if (!check) {
      check = messageChecker(
        this.#platform,
        held.epochs.slice(-1),
        [...this.devices.values()],
        held.members[0]?.space === true,
      );
      this.#checkers.set(key, check);
    }
    return check;
  }

  /** The answer of an item placed: it waits for the item's own write. */
  #placed(kind: number, signed: Bytes, sig: Bytes, parsed: Parsed): Outcome {
    return {
      code: Code.accepted,
      ticket: this.#append(kind, signed, sig, parsed).ticket,
      removed: [],
    };
  }

  /** Appends the item and indexes it: the one place an item enters the sequence while serving. */
  #append(kind: number, signed: Bytes, sig: Bytes, parsed: Parsed): { ticket: number } {
    const { placed, ticket } = this.#journal.append({ kind, signed, sig });
    this.#index(placed, parsed);
    return { ticket };
  }

  /** The start's side of `#append`: the record is already in the file, and its verdict is taken again. */
  #restore(placed: Placed, item: Item): void {
    const bad = () =>
      new UnknownItem(`item ${placed.position} is of kind ${item.kind} or does not decode`);
    const { signed, sig } = item;
    if (item.kind === KIND.device) {
      const d = decodeDeviceEntry(signed);
      if (!d.ok) throw bad();
      this.#index(placed, { device: { entry: d.value, id: placed.id } });
      return;
    }
    if (item.kind === KIND.member) {
      const d = decodeMemberEntry(signed);
      if (!d.ok) throw bad();
      const members = this.channels.get(idKey(d.value.channel ?? placed.id))?.members ?? [];
      const devices = this.devices.get(idKey(d.value.signerPerson)) ?? [];
      const verdict = checkMemberEntry(this.#platform, members, signed, sig, devices);
      if (!verdict.ok) throw bad();
      this.#index(placed, { member: verdict.value });
      return;
    }
    if (item.kind === KIND.epoch) {
      const d = decodeEpochEntry(signed);
      if (!d.ok) throw bad();
      this.#index(placed, { epoch: { entry: d.value, id: placed.id } });
      return;
    }
    const d = decodeMessage(signed);
    if (item.kind !== KIND.message || !d.ok) throw bad();
    this.#index(placed, { header: d.value.header });
  }

  /** What a placed item does to the indexes; the same for an item just placed and one read at start. */
  #index(placed: Placed, parsed: Parsed): void {
    if ("device" in parsed) {
      const key = idKey(parsed.device.entry.person ?? placed.id);
      const log = this.devices.get(key) ?? [];
      log.push(parsed.device);
      this.devices.set(key, log);
      const at = this.#at.get(key);
      if (at) at.push(placed.position);
      else this.#at.set(key, [placed.position]);
      this.#views.delete(key);
      const view = this.#view(parsed.device.entry.person ?? placed.id, log);
      for (const id of view.named.keys()) this.#deviceNames.add(id);
      for (const id of view.recoveries.keys()) this.#recoveryNames.add(id);
      // Duty 3: a change of a person's devices closes the epoch of each channel that person is in.
      for (const channel of this.#byPerson.get(key) ?? []) channel.closed = true;
    } else if ("member" in parsed) {
      const e = parsed.member.entry;
      const key = idKey(e.channel ?? placed.id);
      const channel = this.channels.get(key) ?? {
        members: [],
        epochs: [],
        epochIds: new Set<string>(),
        closed: true,
        slots: new Set<string>(),
        persons: new Set<string>(),
      };
      channel.members.push(parsed.member);
      if (parsed.member.changesMembers) channel.closed = true;
      this.channels.set(key, channel);
      if (parsed.member.space && !this.#spaces.has(idKey(e.signerPerson)))
        this.#spaces.set(idKey(e.signerPerson), key);
      this.#placeMembers(channel);
    } else if ("epoch" in parsed) {
      const key = idKey(parsed.epoch.entry.channel);
      const channel = this.channels.get(key) as Channel;
      channel.epochs.push(parsed.epoch);
      channel.epochIds.add(idKey(parsed.epoch.id));
      channel.closed = false;
      channel.slots.clear();
      this.#checkers.delete(key);
    } else {
      const h = parsed.header;
      this.#messages.add(idKey(placed.id));
      this.channels.get(idKey(h.channel))?.slots.add(slotOf(h));
      this.#build(h, placed.position);
    }
  }

  /** Keeps the index of which channels a person is a member of, after a member entry (design 3.9). */
  #placeMembers(channel: Channel): void {
    const now = membersOf(channel.members);
    for (const person of channel.persons)
      if (!now.has(person)) this.#byPerson.get(person)?.delete(channel);
    for (const person of now) {
      const channels = this.#byPerson.get(person) ?? new Set<Channel>();
      channels.add(channel);
      this.#byPerson.set(person, channels);
    }
    channel.persons = now;
  }

  #build(h: MessageHeader, position: number): void {
    const build = h.kind === KIND_BUILD;
    const sender = idKey(h.sender);
    const name = idKey(h.name);
    if (build && !this.#firstAt.has(`${sender}|${name}`)) {
      this.#firstAt.set(`${sender}|${name}`, position);
      const first = this.#builds.get(sender) ?? [];
      first.push(position);
      this.#builds.set(sender, first);
      // The first copy of a new name replaces the sender's builds: what they named may be unwanted now.
      for (const key of this.#buildBlobs.get(sender) ?? []) this.toCheck.add(key);
      this.#buildBlobs.delete(sender);
    }
    for (const blob of h.blobs) {
      const key = Buffer.from(blob).toString("hex");
      // A start removes what its sequence no longer wants: only a message placed since is looked at.
      if (this.#journal) this.toCheck.add(key);
      if (build) {
        const named = this.#buildBlobs.get(sender) ?? new Set<string>();
        this.#buildBlobs.set(sender, named.add(key));
      }
      const refs = this.#named.get(idKey(blob)) ?? [];
      refs.push({ build, sender, name, position });
      this.#named.set(idKey(blob), refs);
    }
  }
}

/** Whether `list` holds the entry with `id` at `seq`: bytes the relay holds are accepted again (duty 5). */
const holds = (list: readonly { id: Bytes }[], seq: number, id: Bytes) => {
  const at = list[seq];
  return at !== undefined && bytesEqual(at.id, id);
};
const slotOf = (h: MessageHeader) => `${idKey(h.sender)}|${idKey(h.run)}|${h.counter}`;
