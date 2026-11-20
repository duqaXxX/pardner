/**
 * The app's joined-script entry (step 6.3 design, 6.4; app data design, 3.3 to 5): what Swift calls
 * through `ProtocolHost`. It holds one `AppLink`, the shared `Link` with what must not cross into
 * Swift taken out of its effects: no epoch key, file key or log ever leaves it.
 */
import { isBytes } from "./bytes.ts";
import { buildAdd, buildRemove, type SignedEntry } from "./device-builders.ts";
import { type DeviceKeys, foldLog, idKey, namedDevices } from "./device-log.ts";
import { buildEpoch, type EpochClock, tickEpoch } from "./epochs.ts";
import { encodeFrame } from "./frames.ts";
import { deviceId, relayKeyId } from "./ids.ts";
import { makeSeal, sealKey, seals, soleHolders, starts } from "./keeper.ts";
import { EXPORTER_LABEL } from "./labels.ts";
import { type Effect, Link, type LinkOptions, type Persist } from "./link.ts";
import {
  KIND_PROFILE,
  type Message,
  type MessageBody,
  openMessage,
  type Reference,
} from "./messages.ts";
import { checkPairingProof, shortForm } from "./pairing-string.ts";
import type { Bytes, Platform } from "./platform.ts";
import { encodeProfile, type Profile, Profiles } from "./profile.ts";
import type { Kept, Out } from "./reading.ts";
import type { PlatformError, Result } from "./result.ts";

// The first device's entry 0 (design 3.5): the app calls it through `ProtocolHost.callExported`, before any `AppLink` exists.
export { buildGenesis, readDeviceEntry } from "./device-builders.ts";
// What a pasted or a made pairing string says and the proof a joining device signs (design 3.4, 3.7): plain functions of the platform.
export {
  checkPairingName,
  inspectPairingString,
  makePairingProof,
  pairingString,
} from "./pairing-string.ts";
// The recovery key's two halves (design 3.5 steps 3 and 5): made before entry 0 and shown after it, the app calls both the same way.
export { createRecoveryKey, showRecoveryKey } from "./recovery.ts";
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

/** `Link`'s effects with `deliver` reduced to a `View` and `persist` to what the store writes, and the shown profile of a bot when it changes (design 5). */
export type AppEffect =
  | Exclude<Effect, { do: "deliver" | "persist" }>
  | { do: "deliver"; out: View }
  | { do: "persist"; what: AppPersist }
  | { do: "profile"; bot: Bytes; profile: Profile | null }
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
  // before it (design 3.3).
  #view(effects: Effect[], now: number): AppEffect[] {
    const out = effects.flatMap((fx) => this.#reduce(fx));
    const tail = out.at(-1)?.do === "persist" ? out.splice(-1) : [];
    if (!tail.length) out.push(...this.#keep(now)); // a held `persist` forbids any other call of the link
    return [...out, ...this.#retry(), ...this.#told(), ...this.#listing(), ...tail];
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
    if (fx.do !== "deliver") return [fx];
    const out = fx.out;
    if (out.do === "incarnation" && out.changed) {
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
      for (const [k, bot] of this.#recheck) this.#touched.set(k, bot);
      this.#recheck.clear();
    }
    if (out.do !== "message") return [{ do: "deliver", out }];
    const h = out.message.header;
    const key = this.#link.reading.key(h.channel, h.epoch);
    if (key) return this.#open(out.message, out.position, key, false);
    const at = `${idKey(h.channel)} ${idKey(h.epoch)}`;
    this.#waiting.set(at, [
      ...(this.#waiting.get(at) ?? []),
      { message: out.message, position: out.position },
    ]);
    return [{ do: "deliver", out: this.#message(out.message, out.position, undefined, false) }];
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
    for (const { channel } of starts(r, (c) => this.#clocks.get(idKey(c)), now)) {
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
    const { active } = foldLog(this.#platform, log);
    const sole = soleHolders(this.#platform, r);
    const devices = log.flatMap(({ entry: e }): DeviceView[] => {
      // An entry of the recovery key names its new device too, with no device as the adder.
      const named =
        "newDevice" in e
          ? e.newDevice?.device
          : e.kind === "add" || e.kind === "genesis"
            ? e.device
            : undefined;
      if (!named) return [];
      const id = deviceId(this.#platform, named.signing, named.receiving);
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
          short: shortForm(this.#platform, named),
        },
      ];
    });
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

/** A link for the app, from the platform the host holds. */
export function appLink(platform: Platform, options: AppLinkOptions): AppLink {
  return new AppLink(platform, options);
}
