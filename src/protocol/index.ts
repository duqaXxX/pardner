/**
 * The app's joined-script entry (step 6.3 design, 6.4; app data design, 3.3 to 5): what Swift calls
 * through `ProtocolHost`. It holds one `AppLink`, the shared `Link` with what must not cross into
 * Swift taken out of its effects: no epoch key, file key or log ever leaves it.
 */
import { type AppOutbox, Boxes, type OutboxView } from "./app-outbox.ts";
import { bytesEqual, isBytes } from "./bytes.ts";
import { buildAdd, buildRemove, type SignedEntry } from "./device-builders.ts";
import { type DeviceKeys, foldLog, idKey, type LoggedEntry, namedDevices } from "./device-log.ts";
import { buildEpoch, type EpochClock, tickEpoch } from "./epochs.ts";
import { encodeFrame } from "./frames.ts";
import { deviceId, recoveryKeyId, relayKeyId, signedId } from "./ids.ts";
import { makeSeal, sealKey, seals, soleHolders, startOf, starts } from "./keeper.ts";
import { EXPORTER_LABEL } from "./labels.ts";
import { type Effect, Link, type LinkOptions, type Persist } from "./link.ts";
import type { RecoveryOutcome } from "./link-types.ts";
import { encodeMemberEntry } from "./member-log.ts";
import {
  botOnly,
  decodeMessage,
  KIND_PROFILE,
  type Message,
  type MessageBody,
  type MessageHeader,
  messageChecker,
  openMessage,
  type Reference,
} from "./messages.ts";
import { build, type Draft, type OutboxItem, queue, Run, readBack, rebuild } from "./outbox.ts";
import { checkPairingProof, shortForm } from "./pairing-string.ts";
import type { Bytes, Platform } from "./platform.ts";
import { encodeProfile, type Profile, Profiles } from "./profile.ts";
import type { Identity, Kept, Out } from "./reading.ts";
import type { RecoverOptions } from "./recover.ts";
import type { PlatformError, Result } from "./result.ts";

// The first device's entry 0 (design 3.5): the app calls it through `ProtocolHost.callExported`, before any `AppLink` exists.
export { buildGenesis, buildReset, readDeviceEntry } from "./device-builders.ts";
// What a pasted or a made pairing string says and the proof a joining device signs (design 3.4, 3.7): plain functions of the platform.
export {
  checkPairingName,
  inspectPairingString,
  makePairingProof,
  pairingString,
} from "./pairing-string.ts";
// The recovery key's two halves (design 3.5 steps 3 and 5): made before entry 0 and shown after it, the app calls both the same way; `enterRecoveryKey` takes a typed one back (recovery design 2.2).
export { createRecoveryKey, enterRecoveryKey, showRecoveryKey } from "./recovery.ts";
export type { AppOutbox, OutboxView };
export { EXPORTER_LABEL };

/** The platform's names for the device's two keys: the app's key store holds them under these. */
export const SIGN = "device.sign";
export const RECEIVE = "device.receive";
/** History seals in flight at once: each is a request with the 30 s patience, so a long backlog must not all wait on one clock. */
const SEAL_WINDOW = 16;

/** A head the relay signed, as the app's store keeps it: the relay's key id is the pinned key's, added back on load. */
export interface StoredHead {
  n: number;
  chain: Bytes;
  sig: Bytes;
}

/** What the app's store gives back at launch (design 3.1): every field as the last confirmed write left it. */
export interface Stored {
  ids: Bytes[];
  head?: StoredHead | undefined;
  putBack: boolean;
  incarnation?: Bytes | undefined;
  fault: boolean;
}

/**
 * A store write (design 3.3): `kept` on every write, since `Link` counts it stored after any, with only
 * the ids after the `from` the store last confirmed; `incarnation` or `fault` when that is what is asked.
 */
export interface AppPersist {
  kept: { from: number; ids: Bytes[]; head: StoredHead | undefined; putBack: boolean };
  incarnation?: Bytes;
  fault?: true;
}

/** A file of an opened body, without the key that opens its blob (crypto.md 8). */
export interface FileView {
  blob: Bytes;
  size: number;
  type: string;
  name: string;
}

/**
 * What the screens read of a message (design 4.1): its place, its header, and, once its body opened
 * with its own epoch's key, the files and the text. `again` marks a message delivered unopened
 * before, now opened.
 */
export interface MessageView {
  do: "message";
  position: number;
  channel: Bytes;
  sender: Bytes;
  name: Bytes;
  epoch: Bytes;
  time: number;
  kind: number;
  to?: Bytes | undefined;
  re?: Reference | undefined;
  blobs: Bytes[];
  files?: FileView[] | undefined;
  text?: string | undefined;
  again: boolean;
}

export type View = MessageView | Exclude<Out, { do: "message" }>;

/**
 * A device the log names (device pairing design 3.9): `addedBy` is the signer of the entry that named it, `null` for entry 0's
 * device and also for a device a reset named, which no device added.
 */
export interface DeviceView {
  id: Bytes;
  kind: "app" | "bot";
  active: boolean;
  addedBy: Bytes | null;
  position: number;
  /** The epochs this device is the only active one holding a counting seal for: what a removal of the others would lose (design 3.9). */
  onlyHolder: { channel: Bytes; epoch: Bytes }[];
  /** The id's first 8 bytes in four groups of four hex digits (design 3.2): the one form the person compares. */
  short: string;
}

/** Why `addDevice` or `removeDevice` built nothing: the log is not at rest, the proof is not for this person, the log names the device already, or the builder's own refusal. */
export type DeviceActError = "busy" | "proof" | "named" | PlatformError;
export type DeviceAct = { ok: true; value: SignedEntry } | { ok: false; error: DeviceActError };

/** Why `createChannel` made nothing: the device does not read its own log active, a creation is pending, the bot is not an active bot of the person, or the platform's own refusal. */
export type CreateError = "not-ready" | "busy" | PlatformError;
/** Why `send` queued nothing: the draft is refused (6.4's table, files, a length), the channel is not one the reading holds or is being created, it is faulted, or the store failed. */
export type SendError = "bad-input" | "not-member" | "fault" | "not-ready";

/**
 * `Link`'s effects with `deliver` reduced to a `View` and `persist` to what the store writes, and the shown profile of a bot when it changes (design 5).
 * Of the app's own outbox (new channel design 3): `write` ends its list as `persist` does, never in one with it, and the driver answers it with
 * `written`; `store-failed` after a failed write; `outbox` the items of a channel that changed; `channel-refused` a new channel the relay refused; `channel-fault` a channel stopped on a relay answer no check explains; `creating` the channel being created with its bot and folder (at `start` for a stored one, and at `createChannel`), or `channel: null` once none is pending (read back or refused).
 */
export type AppEffect =
  | Exclude<Effect, { do: "deliver" | "persist" | "recovery" }>
  | { do: "deliver"; out: View }
  | { do: "persist"; what: AppPersist }
  | { do: "write"; outbox: AppOutbox }
  | { do: "store-failed" }
  | { do: "outbox"; channel: Bytes; items: OutboxView[] }
  | { do: "channel-refused"; channel: Bytes; code: number }
  | { do: "channel-fault"; channel: Bytes }
  | { do: "creating"; channel: Bytes; bot: Bytes; folder: string }
  | { do: "creating"; channel: null }
  | { do: "profile"; bot: Bytes; profile: Profile | null }
  | { do: "recovery"; outcome: Exclude<RecoveryOutcome, { log: readonly LoggedEntry[] }> }
  | {
      do: "recovery-log";
      person: Bytes;
      length: number;
      last: Bytes;
      devices: DeviceView[];
      recovery: Bytes;
      /** Every recovery key this person's log named, the oldest first and the current last: the keys an epoch's seal may be to, apart from other members' (2.6). */
      recoveries: Bytes[];
    }
  | {
      do: "devices";
      person: Bytes;
      length: number;
      last: Bytes;
      devices: DeviceView[];
      self: Bytes;
    };

/** The device and the relay it is paired with: the public keys of the device's own keys, the relay's pinned key, and what the store holds. */
export interface AppLinkOptions {
  relay: Bytes;
  person: Bytes;
  signing: Bytes;
  receiving: Bytes;
  stored?: Stored;
  constants?: LinkOptions["constants"];
  /** The first device's entry 0 and the relay's enrolment secret (device pairing design 3.5): see `LinkOptions.enrol`; a value that cannot be framed throws a `RangeError`. */
  enrol?: LinkOptions["enrol"];
  /** The app outbox as the last confirmed write left it (new channel design 4). */
  outbox?: AppOutbox;
  /** The run the messages are built under, made here when absent (crypto.md 1): a test passes one at its counter limit. */
  run?: Run;
}

// A pairing's shape, without `instanceof` (design 2.3: realms differ): the host's value is its own to get wrong.
const shaped = (p: { device?: Partial<DeviceKeys>; proof?: unknown } | undefined): boolean => {
  const key = (k: unknown) => isBytes(k) && k.length === 65;
  const d = p?.device;
  const proof = p?.proof;
  return (
    !!d &&
    (d.kind === "app" || d.kind === "bot") &&
    key(d.signing) &&
    key(d.receiving) &&
    isBytes(proof) &&
    proof.length === 64
  );
};

/**
 * The device's connection to the relay for the app: `Link`'s calls, with effects a driver in Swift
 * can take. A `persist` ends its list, and the driver answers it with `persisted`.
 */
export class AppLink {
  #link: Link;
  #platform: Platform;
  #person: Bytes;
  #self: Bytes;
  #rested = false; // a rest was delivered in this call
  #listed = ""; // the device log last told to Swift, by length and last id
  #saved: number; // the ids the store confirmed
  #held: AppPersist | undefined;
  // Delivered unopened, by channel and epoch, in position order: no key of their epoch yet (4.2).
  #waiting = new Map<string, { message: Message; position: number }[]>();
  #profiles = new Profiles();
  #shown = new Map<string, { bot: Bytes; profile: Profile }>(); // the profile last told to Swift
  #touched = new Map<string, Bytes>(); // the bots whose profile a message of this call may have changed
  #recheck = new Map<string, Bytes>(); // bots shown before a rewind: checked again at the next rest
  // The keeper (design 3.11): run once at each rest, and what it sent, so nothing is sent twice while its answer is pending.
  #owed = false; // a rest was delivered and the keeper has not run since
  #asked = new Map<number, (code: number | "unanswered") => void>(); // request -> what its answer undoes
  #starting = new Map<string, number>(); // channel -> the epochs it had when its start was sent, until answered
  #given = new Set<string>(); // `sealKey` of each seal sent and not yet answered
  #tried = new Set<string>(); // `sealKey` of each seal sent since the last rest: the relay's list shows it only at the next
  #clocks = new Map<string, EpochClock>(); // the first read of each channel's current epoch, in memory alone
  // The app's own outbox (new channel design 3): its state, its one write, and what the sends of this run depend on.
  #boxes: Boxes;
  #run: Run;
  #incarnation: Bytes | undefined; // the one the reading is served under, which an item not built takes
  #writing: AppOutbox | undefined; // the write the store has not answered: no other is emitted, and no send that depends on it
  #dirty = false; // the outbox changed and no write holds it yet
  #failed = false; // a write failed: nothing is created or sent
  #notes: AppEffect[] = []; // effects an answer made, told at the end of the call
  #changed = new Map<string, Bytes>(); // the channels whose items changed in this call
  #refused = new Map<string, OutboxItem[]>(); // the items dropped as not delivered in this call, told once
  #flying = new Map<string, number>(); // channel -> the request of its item submitted and not answered
  #stuck = new Set<string>(); // the channels whose last answer no rule handles: nothing more until the next rest
  #accepted = new Map<string, Set<string>>(); // channel -> names given result 0 since the last rest
  #late = new Map<string, string>(); // channel -> the epoch that answered 3 or 4, where nothing is built again
  #rolled = new Map<string, string>(); // channel -> the epoch in which a build met the counter limit
  #entryRequest = 0; // the request of the entry 0 in flight
  #entry: "flying" | "tried" | undefined; // the pending entry 0: submitted and not answered, or answered and owed again at the next rest

  constructor(platform: Platform, o: AppLinkOptions) {
    this.#platform = platform;
    this.#person = o.person;
    this.#self = deviceId(platform, o.signing, o.receiving);
    const s = o.stored;
    const head = s?.head && {
      head: { relay: relayKeyId(platform, o.relay), n: s.head.n, chain: s.head.chain },
      sig: s.head.sig,
    };
    const kept: Kept = { ids: s?.ids.slice() ?? [], head, putBack: s?.putBack ?? false };
    this.#saved = kept.ids.length;
    this.#boxes = new Boxes(o.outbox);
    this.#run = o.run ?? new Run(platform);
    this.#incarnation = s?.incarnation;
    this.#link = new Link({
      who: {
        platform,
        relay: o.relay,
        person: o.person,
        self: this.#self,
        receiving: RECEIVE,
      },
      keys: { kind: "app", signing: o.signing, receiving: o.receiving },
      sign: SIGN,
      kept,
      stored: { ...(s?.incarnation && { incarnation: s.incarnation }), fault: s?.fault ?? false },
      ...(o.constants && { constants: o.constants }),
      ...(o.enrol && { enrol: o.enrol }),
    });
  }

  start(now: number): AppEffect[] {
    // What the store held is told once, as a change would be: no call has changed it yet.
    for (const channel of this.#boxes.channels()) this.#changed.set(idKey(channel), channel);
    const pending = this.#boxes.pending;
    if (pending) this.#notes.push(this.#creating(signedId(this.#platform, pending.signed)));
    for (const channel of this.#boxes.snapshot().faults)
      this.#notes.push({ do: "channel-fault", channel });
    return this.#view(this.#link.start(now), now);
  }
  opened(conn: number, binding: Bytes, now: number): AppEffect[] {
    return this.#view(this.#link.opened(conn, binding, now), now);
  }
  received(conn: number, bytes: Bytes, now: number): AppEffect[] {
    return this.#view(this.#link.received(conn, bytes, now), now);
  }
  closed(conn: number, now: number): AppEffect[] {
    return this.#view(this.#link.closed(conn, now), now);
  }
  tick(now: number): AppEffect[] {
    return this.#view(this.#link.tick(now), now);
  }
  networkUp(now: number): AppEffect[] {
    return this.#view(this.#link.networkUp(now), now);
  }
  stop(now: number): AppEffect[] {
    return this.#view(this.#link.stop(now), now);
  }
  /** The store's answer to the last `persist`: `false` when the write failed. */
  persisted(ok: boolean, now: number): AppEffect[] {
    const held = this.#held;
    this.#held = undefined;
    if (ok && held) this.#saved = held.kept.from + held.kept.ids.length;
    return this.#view(this.#link.persisted(ok, now), now);
  }
  /**
   * The store's answer to the last `write`: `false` when it failed, after which nothing is created or sent
   * and the effect says `store-failed` (new channel design 3.1).
   */
  written(ok: boolean, now: number): AppEffect[] {
    this.#writing = undefined;
    if (ok) return this.#view([], now);
    this.#failed = true;
    return [{ do: "store-failed" }];
  }

  /**
   * A new channel (new channel design 3.2): entry 0 made and signed here, kept in the app outbox with the
   * `/bind` prompt to `bind.bot`, and submitted once that is written. The channel's id is known at once;
   * its first epoch is the keeper's.
   */
  createChannel(
    bind: { bot: Bytes; folder: string },
    now: number,
  ): { channel: Bytes; effects: AppEffect[] } | CreateError {
    const { active } = foldLog(this.#platform, this.#link.reading.devices);
    if (this.#failed || !active.has(idKey(this.#self))) return "not-ready";
    if (this.#boxes.pending) return "busy";
    if (!isBytes(bind.bot) || active.get(idKey(bind.bot))?.kind !== "bot") return "bad-input";
    if (typeof bind.folder !== "string") return "bad-input";
    const text = JSON.stringify({ text: `/bind ${bind.folder}` });
    const bound = queue(this.#platform, [], { kind: 2, to: bind.bot, content: text });
    if (!bound.ok) return "bad-input";
    const signed = encodeMemberEntry({
      seq: 0,
      kind: "create",
      nonce: this.#platform.random(16),
      signerPerson: this.#person,
      signerDevice: this.#self,
    });
    const sig = this.#platform.sign(SIGN, signed);
    if (!sig.ok) return sig.error;
    const channel = signedId(this.#platform, signed);
    this.#boxes.pending = { signed, sig: sig.value };
    this.#put(channel, bound.value);
    this.#notes.push(this.#creating(channel));
    return { channel, effects: this.#view([], now) };
  }

  /**
   * A message in the outbox of `channel` (new channel design 3.3): written, then built in the channel's
   * open epoch and written again, then submitted, and kept until this device reads it back.
   */
  send(
    channel: Bytes,
    draft: Draft,
    now: number,
  ): { name: Bytes; effects: AppEffect[] } | SendError {
    const pending = this.#boxes.pending;
    const known =
      this.#link.reading.channel(channel) ||
      (pending && bytesEqual(signedId(this.#platform, pending.signed), channel));
    if (this.#failed) return "not-ready";
    if (!known) return "not-member";
    if (this.#boxes.faulted(channel)) return "fault";
    if (
      draft.name &&
      this.#boxes.items(channel).some((i) => bytesEqual(i.name, draft.name as Bytes))
    )
      return "bad-input"; // two items of one name would be built and read back as one
    if (botOnly(draft.kind)) return "bad-input"; // the table says who sends a kind
    const queued = draft.files?.length
      ? undefined
      : queue(this.#platform, this.#boxes.items(channel), draft);
    if (!queued?.ok) return "bad-input";
    this.#put(channel, queued.value);
    return { name: (queued.value.at(-1) as OutboxItem).name, effects: this.#view([], now) };
  }

  /** An item past the frame limit or outside its field is `invalid`: the caller's item is wrong, the link is not. */
  submit(
    kind: 1 | 2 | 3 | 4,
    signed: Bytes,
    sig: Bytes,
    now: number,
  ): { request: number; effects: AppEffect[] } | "busy" | "invalid" {
    // The frame `Link` will cut, made first: only its failure is the item's. Any other throw is a fault.
    try {
      encodeFrame({ type: "submit", request: 1, kind, signed, sig }, true);
    } catch (error) {
      if ((error as Error)?.name === "RangeError") return "invalid";
      throw error;
    }
    const sent = this.#link.submit(kind, signed, sig, now);
    return sent === "busy"
      ? sent
      : { request: sent.request, effects: this.#view(sent.effects, now) };
  }

  /**
   * The enrolment secret again, after an `enrol-refused` effect: the next connection sends it with entry 0 (design 3.5).
   * A value that cannot be framed is `bad-input` and changes nothing.
   */
  enrol(secret: Bytes, signed: Bytes, sig: Bytes): Result<undefined> {
    return this.#link.enrol({ secret, signed, sig });
  }

  /**
   * A recovery for a link not yet started (recovery design 2.3, 3): its `reset` absent, the link reads the device log, tells it as a
   * `recovery-log` effect (the active devices for the question of 2.4) and stops; present, it tries `prove-active` first and sends the
   * reset on a recovery connection of its own after a refusal, until `recovered`. `bad-input` once the link started or for a value of the wrong shape.
   * The app stores the reset's inputs (`key.id`, `trusted`, `replacement`) and gives them again after a restart: the link rebuilds the reset in each recovery
   * connection, never hands it over, and a rebuild has, at an unchanged log, the same signed bytes and id; at a moved log, a new position.
   */
  recover(value: RecoverOptions): Result<undefined> {
    return this.#link.recover(value);
  }

  /** A recovery key held after the read, for opening only (2.6): the epochs it opens are delivered at once. */
  holdRecovery(
    identity: Identity,
    now: number,
  ): { ok: true; effects: AppEffect[] } | { ok: false; error: "bad-input" } {
    if (
      !isBytes(identity?.id) ||
      identity.id.length !== 32 ||
      typeof identity.receiving !== "string"
    )
      return { ok: false, error: "bad-input" };
    this.#link.reading.hold(identity);
    return { ok: true, effects: this.#view([], now) };
  }

  /** Every recovery key the device log read names, the oldest first and the current last: what tells this person's keys from the other recipients in `epochs`. */
  recoveries(): Bytes[] {
    return recoveryIds(this.#platform, this.#link.reading.devices);
  }

  /** What "done" needs (2.6): every epoch read, whether its key is held, and who it is sealed to. */
  epochs(): ReturnType<Link["reading"]["epochStates"]> {
    return this.#link.reading.epochStates();
  }

  /** The id of the recovery key the device log names now (2.6, done reads it again): `undefined` before any log. */
  currentRecovery(): Bytes | undefined {
    const key = foldLog(this.#platform, this.#link.reading.devices).recovery;
    return key && recoveryKeyId(this.#platform, key.signing, key.receiving);
  }

  /**
   * The add of the device a pairing string names, built and signed against the log this link holds,
   * and not sent: the app keeps it pending, then `submit`s kind 1 (design 3.6). `busy` while the log is not at rest, as `submit`
   * answers, since a partial log would sign an entry the relay refuses. `now` is for symmetry with the other calls.
   */
  addDevice(pairing: { device: DeviceKeys; proof: Bytes }, now: number): DeviceAct {
    const refused = this.checkPairing(pairing, now);
    if (!refused.ok) return refused;
    return buildAdd(
      this.#platform,
      SIGN,
      this.#link.reading.devices,
      this.#self,
      pairing.device,
      pairing.proof,
    );
  }
  /** What `addDevice` would refuse before it signs: the app shows the person the reason before the confirmation (design 3.4). */
  checkPairing(
    pairing: { device: DeviceKeys; proof: Bytes },
    _now: number,
  ): { ok: true } | { ok: false; error: DeviceActError } {
    if (!this.#link.reading.sendable) return { ok: false, error: "busy" };
    if (!shaped(pairing)) return { ok: false, error: "bad-input" };
    const { device, proof } = pairing;
    if (!checkPairingProof(this.#platform, this.#person, device, proof))
      return { ok: false, error: "proof" };
    const id = deviceId(this.#platform, device.signing, device.receiving);
    if (namedDevices(this.#platform, this.#link.reading.devices).has(idKey(id)))
      return { ok: false, error: "named" };
    return { ok: true };
  }
  /** The remove of `target`, built and signed and not sent, as `addDevice`'s; this device is refused (design 3.9). */
  removeDevice(target: Bytes, _now: number): DeviceAct {
    if (!this.#link.reading.sendable) return { ok: false, error: "busy" };
    return buildRemove(this.#platform, SIGN, this.#link.reading.devices, this.#self, target);
  }

  /** The label the connection's exporter is taken under. */
  exporterLabel(): string {
    return EXPORTER_LABEL;
  }

  // A `persist` ends its list: the messages a key opened in this call, then the profiles that changed, go
  // before it (design 3.3). The outbox's `write` ends a list that holds no `persist` (new channel design 3.1).
  #view(effects: Effect[], now: number): AppEffect[] {
    const out = effects.flatMap((fx) => this.#reduce(fx));
    const tail = out.at(-1)?.do === "persist" ? out.splice(-1) : [];
    if (!tail.length) out.push(...this.#flush(now), ...this.#keep(now)); // a held `persist` forbids any other call of the link
    return [
      ...out,
      ...this.#notes.splice(0),
      ...this.#retry(),
      ...this.#told(),
      ...this.#listing(),
      ...this.#outboxTold(),
      ...(tail.length ? tail : this.#own()),
    ];
  }

  #reduce(fx: Effect): AppEffect[] {
    if (fx.do === "answer") {
      const undo = this.#asked.get(fx.request);
      if (undo) {
        // The keeper's own request: its answer is the keeper's, not the driver's.
        undo(fx.code);
        this.#asked.delete(fx.request);
        return [];
      }
    }
    if (fx.do === "persist") return [{ do: "persist", what: this.#write(fx.what) }];
    if (fx.do === "recovery") return [this.#recovered(fx.outcome)];
    if (fx.do !== "deliver") return [fx];
    const out = fx.out;
    if (out.do === "incarnation") this.#incarnation = out.incarnation;
    if (out.do === "incarnation" && out.changed) {
      this.#flying.clear(); // what was sent under the old incarnation is not pending under the new: its answer frees nothing
      if (this.#entry === "flying") this.#entry = undefined;
      // The Reading rewinds and every position comes again (design 4.2, 5). A bot shown before is checked
      // again once the pass reaches rest, and told `null` only if the new sequence names it nowhere.
      this.#waiting.clear();
      this.#starting.clear(); // a start sent under the old incarnation is not pending under the new
      this.#profiles = new Profiles();
      for (const [k, { bot }] of this.#shown) this.#recheck.set(k, bot);
    }
    if (out.do === "rest") {
      this.#rested = this.#owed = true;
      this.#tried = new Set(this.#given); // one in flight is answered before it is tried again
      for (const c of this.#boxes.channels())
        if (this.#accepted.has(idKey(c))) this.#changed.set(idKey(c), c); // back to waiting: the screen is told
      this.#accepted.clear(); // what the pass did not read back is sent again, as the same bytes
      this.#late.clear();
      this.#stuck.clear();
      if (this.#entry === "tried") this.#entry = undefined;
      for (const [k, bot] of this.#recheck) this.#touched.set(k, bot);
      this.#recheck.clear();
    }
    if (out.do !== "message") return [{ do: "deliver", out }];
    const h = out.message.header;
    this.#readBack(h);
    const key = this.#link.reading.key(h.channel, h.epoch);
    if (key) return this.#open(out.message, out.position, key, false);
    const at = `${idKey(h.channel)} ${idKey(h.epoch)}`;
    this.#waiting.set(at, [
      ...(this.#waiting.get(at) ?? []),
      { message: out.message, position: out.position },
    ]);
    return [{ do: "deliver", out: this.#message(out.message, out.position, undefined, false) }];
  }

  // A log read by a recovery connection, as the devices it names; the rest of an outcome crosses as it is.
  #recovered(outcome: RecoveryOutcome): AppEffect {
    if (!("log" in outcome)) return { do: "recovery", outcome };
    const { log } = outcome;
    const { recovery } = foldLog(this.#platform, log);
    return {
      do: "recovery-log",
      person: this.#person,
      length: log.length,
      last: (log.at(-1) as LoggedEntry).id,
      devices: deviceViews(this.#platform, log, new Map()),
      recovery: recoveryKeyId(
        this.#platform,
        (recovery as DeviceKeys).signing,
        (recovery as DeviceKeys).receiving,
      ),
      recoveries: recoveryIds(this.#platform, log),
    };
  }

  #write(w: Persist): AppPersist {
    const k = this.#link.reading.kept;
    const what: AppPersist = {
      kept: {
        from: this.#saved,
        ids: k.ids.slice(this.#saved),
        head: k.head && { n: k.head.head.n, chain: k.head.head.chain, sig: k.head.sig },
        putBack: k.putBack,
      },
      ...("incarnation" in w && { incarnation: w.incarnation }),
      ...("fault" in w && { fault: true as const }),
    };
    this.#held = what;
    return what;
  }

  // The waiting messages whose epoch key is now held, by epoch and in position order; one that does not open under it is dropped.
  #retry(): AppEffect[] {
    const fx: AppEffect[] = [];
    for (const [at, list] of this.#waiting) {
      const h = (list[0] as { message: Message }).message.header;
      const key = this.#link.reading.key(h.channel, h.epoch);
      if (!key) continue;
      this.#waiting.delete(at);
      for (const { message, position } of list)
        fx.push(...this.#open(message, position, key, true));
    }
    return fx;
  }

  // A message opened now for the first time; delivered again only when it reads (`again`).
  #open(message: Message, position: number, key: Bytes, again: boolean): AppEffect[] {
    const body = openMessage(this.#platform, key, message);
    if (again && !body.ok) return [];
    const view = this.#message(message, position, body.ok ? body.value : undefined, again);
    const h = message.header;
    if (body.ok && h.kind === KIND_PROFILE) {
      this.#profiles.take(position, h, body.value.content);
      this.#touched.set(idKey(h.sender), h.sender);
    }
    return [{ do: "deliver", out: view }];
  }

  /**
   * The keeper's work at a rest (design 3.11), sent through `Link` like any request: the epoch of each
   * channel that needs one (kind 3, as the bot sends it) and the history seals this device owes. A
   * start or a seal sent is not sent again while its answer is pending; any answer, or none
   * (`unanswered`), ends that, and what the relay's list read at the next read still lacks is owed
   * again (security design 5.10). A frame past the limit is a refusal: nothing is sent for it.
   */
  #keep(now: number): AppEffect[] {
    const r = this.#link.reading;
    if (!this.#owed || !r.sendable) return [];
    this.#owed = false;
    const sent: Effect[] = [];
    for (const channel of r.channels()) {
      const k = idKey(channel);
      const clock = tickEpoch(this.#clocks.get(k), r.channel(channel)?.epochs ?? [], now, true);
      if (clock) this.#clocks.set(k, clock);
    }
    const clock = (c: Bytes) => this.#clocks.get(idKey(c));
    for (const { channel } of starts(r, clock, now, (c) => this.#rolling(c))) {
      if (this.#boxes.faulted(channel)) continue; // stopped until paired again (design 3.5)
      const [k, view] = [idKey(channel), r.channel(channel)];
      if (!view || this.#starting.get(k) === view.epochs.length) continue;
      const built = buildEpoch(this.#platform, view.members, view.epochs, [r.devices], {
        person: this.#person,
        device: this.#self,
        sign: SIGN,
      });
      const send =
        built.ok &&
        this.#sendKept(() => this.#link.submit(3, built.value.signed, built.value.sig, now));
      if (!send || send === "busy") continue;
      this.#starting.set(k, view.epochs.length);
      this.#asked.set(send.request, () => this.#starting.delete(k));
      sent.push(...send.effects);
    }
    for (const owed of seals(this.#platform, r, this.#self)) {
      if (this.#given.size >= SEAL_WINDOW) break; // the next ones follow the answers
      const k = sealKey(owed);
      const made =
        this.#given.has(k) || this.#tried.has(k)
          ? undefined
          : makeSeal(this.#platform, r, owed, SIGN, this.#self);
      const send =
        made?.ok && this.#sendKept(() => this.#link.giveSeal(made.value.seal, made.value.sig, now));
      if (!send || send === "busy") continue;
      this.#given.add(k);
      this.#tried.add(k);
      this.#asked.set(send.request, () => {
        this.#given.delete(k);
        this.#owed = true; // room for the next seal, owed as the log reads by then
      });
      sent.push(...send.effects);
    }
    return sent.flatMap((fx) => this.#reduce(fx));
  }

  // The creation of `channel` as a screen draws it: its bot and folder are the bind prompt's, the first item of its outbox.
  #creating(channel: Bytes): AppEffect {
    const bind = this.#boxes.items(channel)[0];
    let text: unknown; // a stored content is the file's: not always JSON
    try {
      text = bind ? (JSON.parse(bind.content) as { text?: unknown })?.text : undefined;
    } catch {}
    if (!bind?.to || typeof text !== "string" || !text.startsWith("/bind "))
      return { do: "creating", channel: null };
    return { do: "creating", channel, bot: bind.to, folder: text.slice("/bind ".length) };
  }

  // The outbox's changes come before the next flush, which runs on every call: the one place its state is read from the reading.
  #put(channel: Bytes, items: readonly OutboxItem[]): void {
    this.#boxes.set(channel, items);
    this.#dirty = true;
    this.#changed.set(idKey(channel), channel);
  }

  // Whether a build met the counter limit under the channel's current epoch: the mark ends with that epoch (a start owed at every epoch would never end).
  #rolling(channel: Bytes): boolean {
    const current = this.#link.reading.channel(channel)?.epochs.at(-1);
    return !!current && this.#rolled.get(idKey(channel)) === idKey(current.id);
  }

  // A message of this device read back leaves its outbox (SD 5.6), by name.
  #readBack(h: MessageHeader): void {
    const held = this.#boxes.items(h.channel);
    const rest = readBack([...held], this.#self, h);
    if (rest.length !== held.length) this.#put(h.channel, rest);
  }

  // The write of the app outbox when it changed, at the end of a list that holds no `persist`; none while one is held or after one failed.
  #own(): AppEffect[] {
    if (!this.#dirty || this.#writing || this.#failed) return [];
    this.#dirty = false;
    this.#writing = this.#boxes.snapshot();
    return [{ do: "write", outbox: this.#writing }];
  }

  // The items of each channel that changed in this call, and the ones dropped as not delivered, once.
  #outboxTold(): AppEffect[] {
    const fx = [...this.#changed].map(([k, channel]): AppEffect => {
      const done = this.#accepted.get(k);
      const state = (i: OutboxItem): OutboxView["state"] =>
        done?.has(idKey(i.name)) ? "sent" : "waiting";
      const items = this.#boxes.items(channel).map((i) => ({ ...view(i), state: state(i) }));
      const refused = (this.#refused.get(k) ?? []).map((i) => ({
        ...view(i),
        state: "refused" as const,
      }));
      return { do: "outbox", channel, items: [...items, ...refused] };
    });
    this.#changed.clear();
    this.#refused.clear();
    return fx;
  }

  /**
   * The outbox's work at a rest and after each answer (new channel design 3): entry 0 of the channel being
   * created, submitted as the same bytes until it is read back, and for each channel its items in order, one in
   * flight, each built once in the open epoch whose key this device holds and submitted only after a write
   * holds the built bytes (SD 5.9). Nothing while a change is not written, the store has a write unanswered or one failed.
   */
  #flush(now: number): AppEffect[] {
    const r = this.#link.reading;
    if (!r.sendable || this.#dirty || this.#writing || this.#failed) return [];
    const sent: Effect[] = [];
    this.#creation(sent, now);
    for (const channel of this.#boxes.channels()) this.#step(channel, sent, now);
    return sent.flatMap((fx) => this.#reduce(fx));
  }

  #creation(sent: Effect[], now: number): void {
    const pending = this.#boxes.pending;
    if (!pending) return;
    const channel = signedId(this.#platform, pending.signed);
    if (this.#link.reading.channel(channel)) {
      // Entry 0 is not a delivery: its being read is what says it was placed. The keeper owes the first epoch.
      this.#boxes.pending = null;
      this.#notes.push({ do: "creating", channel: null });
      this.#dirty = this.#owed = true;
      this.#entry = undefined;
      return;
    }
    if (this.#entry) return;
    const send = this.#sendKept(() => this.#link.submit(2, pending.signed, pending.sig, now));
    if (!send || send === "busy") return;
    this.#entry = "flying";
    this.#entryRequest = send.request;
    this.#asked.set(send.request, (code) => {
      if (this.#entryRequest !== send.request) return; // sent under an earlier incarnation: its answer is not this entry's
      if (code !== 1 && code !== 2 && code !== 5) {
        if (this.#entry === "flying") this.#entry = "tried"; // 0, or none: owed again at the next rest
        return;
      }
      // Refused (2 cannot happen for a new id): the channel never was, and its outbox goes with it.
      this.#boxes.pending = null;
      this.#notes.push({ do: "creating", channel: null });
      this.#entry = undefined;
      for (const item of this.#boxes.items(channel)) this.#drop(channel, item); // told as refused
      this.#notes.push({ do: "channel-refused", channel, code });
    });
    sent.push(...send.effects);
  }

  // One item of `channel`: built, or submitted when a write holds its bytes; the next follows its answer.
  #step(channel: Bytes, sent: Effect[], now: number): void {
    const [r, k] = [this.#link.reading, idKey(channel)];
    const view = r.channel(channel);
    const last = view?.epochs.at(-1);
    const incarnation = this.#incarnation;
    if (
      !view ||
      !last ||
      !incarnation ||
      this.#flying.has(k) ||
      this.#stuck.has(k) ||
      this.#boxes.faulted(channel)
    )
      return;
    // An epoch owed, or the one that answered 3 or 4 still the current one: the keeper's, the next rest's.
    if (
      startOf(r, channel, this.#clocks.get(k), now, this.#rolling(channel)) ||
      this.#late.get(k) === idKey(last.id)
    )
      return;
    const done = this.#accepted.get(k);
    const item = this.#boxes.items(channel).find((i) => !done?.has(idKey(i.name)));
    if (!item) return;
    if (!item.built) {
      const at = {
        channel,
        epoch: last.id,
        epochKey: view.key as Bytes,
        sender: this.#self,
        incarnation,
      };
      const made = build(this.#platform, this.#run, item, at, SIGN);
      if (!made.ok) return; // no key to sign with: nothing is sent
      if (made.value === "rollover") {
        this.#rolled.set(k, idKey(last.id));
        this.#owed = true;
        return;
      }
      const next = made.value;
      this.#put(
        channel,
        this.#boxes.items(channel).map((i) => (bytesEqual(i.name, item.name) ? next : i)),
      );
      return; // written before it is submitted
    }
    const { signed, signature } = item.built;
    const send = this.#sendKept(() => this.#link.submit(4, signed, signature, now));
    if (send === "busy") return;
    if (!send) {
      this.#drop(channel, item); // a frame past the limit: not deliverable, whatever the relay would say
      return;
    }
    this.#flying.set(k, send.request);
    this.#asked.set(send.request, (code) => this.#answered(channel, item, send.request, code));
    sent.push(...send.effects);
  }

  // The relay's result for an item: kept until read back, built again in the next epoch, dropped, or a fault.
  #answered(channel: Bytes, item: OutboxItem, request: number, code: number | "unanswered"): void {
    const k = idKey(channel);
    if (this.#flying.get(k) !== request) return; // sent under an earlier incarnation: nothing waits for it
    this.#flying.delete(k);
    const held = this.#boxes.items(channel).find((i) => bytesEqual(i.name, item.name));
    if (!held) return; // read back meanwhile
    if (code === "unanswered") {
      this.#stuck.add(k); // sent again at the next rest
      return;
    }
    const r = this.#link.reading;
    const epoch = r.channel(channel)?.epochs.at(-1);
    if (code === 0) {
      this.#accepted.set(k, (this.#accepted.get(k) ?? new Set<string>()).add(idKey(item.name)));
      this.#changed.set(k, channel);
    } else if (code === 3 || code === 4) {
      const built = decodeMessage((held.built as NonNullable<OutboxItem["built"]>).signed);
      if (built.ok) this.#late.set(k, idKey(built.value.header.epoch)); // the epoch it was built in, not the current one
      this.#put(
        channel,
        this.#boxes.items(channel).map((i) => (i === held ? rebuild(held) : i)),
      );
    } else if (code === 5 || code === 8) this.#drop(channel, held);
    else if (code !== 1)
      this.#stuck.add(k); // a result no rule here handles: the next rest asks again
    else {
      const { signed, signature } = held.built as NonNullable<OutboxItem["built"]>;
      const verdict = messageChecker(
        this.#platform,
        epoch ? (r.channel(channel)?.epochs ?? []) : [],
        [r.devices],
      )(signed, signature);
      // Kind, `to` and `re` depend on the draft alone: a refusal by them is the app's own, not the relay's (SD 4, I3).
      if (!verdict.ok && ["kind", "to", "re"].includes(verdict.rule)) this.#drop(channel, held);
      else {
        this.#boxes.fault(channel);
        this.#dirty = true;
        this.#notes.push({ do: "channel-fault", channel });
      }
    }
  }

  // An item that will not be delivered leaves the outbox, and the screen is told once.
  #drop(channel: Bytes, item: OutboxItem): void {
    const k = idKey(channel);
    this.#refused.set(k, [...(this.#refused.get(k) ?? []), item]);
    this.#put(
      channel,
      this.#boxes.items(channel).filter((i) => i !== item),
    );
  }

  // A frame past the limit throws before anything is sent: only that is the item's, as in `submit`.
  #sendKept<T>(send: () => T): T | undefined {
    try {
      return send();
    } catch (error) {
      if ((error as Error)?.name === "RangeError") return undefined;
      throw error;
    }
  }

  // Once per call, each bot whose shown profile changed in it.
  #told(): AppEffect[] {
    const fx: AppEffect[] = [];
    for (const [k, bot] of this.#touched) {
      const profile = this.#profiles.of(bot);
      const had = this.#shown.get(k);
      // By content: after a rewind the same profile is read again into a new object.
      if (had ? profile && encodeProfile(had.profile) === encodeProfile(profile) : !profile)
        continue;
      if (profile) this.#shown.set(k, { bot, profile });
      else this.#shown.delete(k);
      fx.push({ do: "profile", bot, profile: profile ?? null });
    }
    this.#touched.clear();
    return fx;
  }

  // At a rest, the devices the log names when it is not the one last told (design 4.2).
  #listing(): AppEffect[] {
    const rested = this.#rested;
    this.#rested = false;
    const log = this.#link.reading.devices;
    const last = log.at(-1);
    if (!rested || !last) return [];
    // The seals and epochs read move who holds what, with no entry of the device log.
    const r = this.#link.reading;
    const held = r.channels().reduce((n, c) => n + (r.channel(c)?.epochs.length ?? 0), 0);
    const at = `${log.length} ${idKey(last.id)} ${r.seals.length} ${held}`;
    if (at === this.#listed) return [];
    this.#listed = at;
    const devices = deviceViews(this.#platform, log, soleHolders(this.#platform, r));
    return [
      {
        do: "devices",
        person: this.#person,
        length: log.length,
        last: last.id,
        devices,
        self: this.#self,
      },
    ];
  }

  #message(
    message: Message,
    position: number,
    body: MessageBody | undefined,
    again: boolean,
  ): MessageView {
    const h = message.header;
    return {
      do: "message",
      position,
      channel: h.channel,
      sender: h.sender,
      name: h.name,
      epoch: h.epoch,
      time: h.time,
      kind: h.kind,
      to: h.to,
      re: h.re,
      blobs: h.blobs,
      files: body?.files.map(({ blob, size, type, name }) => ({ blob, size, type, name })),
      text: body?.content,
      again,
    };
  }
}

/** The ids of the recovery keys a log named, in the order it named them; the last is the current one. */
const recoveryIds = (platform: Platform, log: readonly LoggedEntry[]): Bytes[] =>
  [...foldLog(platform, log).recoveries.values()].map((k) =>
    recoveryKeyId(platform, k.signing, k.receiving),
  );

/** The devices a log names, each with whether it is active, who added it and what removing the others would lose it (`sole`). */
function deviceViews(
  platform: Platform,
  log: readonly LoggedEntry[],
  sole: Map<string, { channel: Bytes; epoch: Bytes }[]>,
): DeviceView[] {
  const { active } = foldLog(platform, log);
  return log.flatMap(({ entry: e }): DeviceView[] => {
    // An entry of the recovery key names its new device too, with no device as the adder.
    const named =
      "newDevice" in e
        ? e.newDevice?.device
        : e.kind === "add" || e.kind === "genesis"
          ? e.device
          : undefined;
    if (!named) return [];
    const id = deviceId(platform, named.signing, named.receiving);
    const addedBy = e.kind === "add" ? e.signer : null;
    const on = active.has(idKey(id));
    const onlyHolder = on ? (sole.get(idKey(id)) ?? []) : [];
    return [
      {
        id,
        kind: named.kind,
        active: on,
        addedBy,
        position: e.seq,
        onlyHolder,
        short: shortForm(platform, named),
      },
    ];
  });
}

const view = ({ name, kind, to, re, content }: OutboxItem) => ({ name, kind, to, re, content });

/** A link for the app, from the platform the host holds. */
export function appLink(platform: Platform, options: AppLinkOptions): AppLink {
  return new AppLink(platform, options);
}
