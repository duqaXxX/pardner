import { bytesEqual, decode, isBytes, type Reader, refuse, Writer } from "./bytes.ts";
import {
  activeDevices,
  idKey,
  type LoggedEntry,
  namedDevices,
  recipientsOf,
} from "./device-log.ts";
import { signedId } from "./ids.ts";
import { type LoggedMember, membersOf } from "./member-log.ts";
import type { Bytes, Platform } from "./platform.ts";
import { fail, ok, type Result } from "./result.ts";

/** How much of a log an entry saw: its length, and the id of the last entry it counted. */
export interface Head {
  length: number;
  last: Bytes;
}

/** The epoch key sealed to one recipient (a device or a recovery key): HPKE's `enc` and the 48 bytes sealed. */
export interface EpochSeal {
  recipient: Bytes;
  enc: Bytes;
  sealed: Bytes;
}

/** An epoch-log entry (design 6.3); `prev` is absent exactly at `seq` 0. */
export interface EpochEntry {
  channel: Bytes;
  seq: number;
  prev?: Bytes | undefined;
  memberHead: Head;
  /** The head of each member's device log, one per member. */
  deviceHeads: (Head & { person: Bytes })[];
  seals: EpochSeal[];
  commitment: Bytes;
  signerPerson: Bytes;
  signerDevice: Bytes;
}

/** An entry the log holds: its id is SHA-256 of its signed bytes. */
export interface LoggedEpoch {
  entry: EpochEntry;
  id: Bytes;
}

/** A seal of an earlier epoch's key to a device, signed by the device that made it (design 6.3). */
export interface HistorySeal extends EpochSeal {
  channel: Bytes;
  epoch: Bytes;
  maker: Bytes;
}

/** Why an entry may not follow the epochs: `decode` is the structure, the rest are security design 4's rules. */
export type EpochRule =
  | "decode"
  | "heads"
  | "device"
  | "signature"
  | "position"
  | "prev"
  | "channel"
  | "recipients";

export type EpochVerdict = { ok: true; value: LoggedEpoch } | { ok: false; rule: EpochRule };
export type HistoryVerdict =
  | { ok: true; value: HistorySeal }
  | { ok: false; rule: "decode" | "device" | "signature" };

const SEALED = 48; // a 32-byte key and the 16-byte tag
const EMPTY = new Uint8Array(0);

const writeHead = (w: Writer, h: Head): Writer => {
  if (h.length < 1) throw new RangeError("a head counts one entry at least");
  return w.u64(h.length).b32(h.last);
};
const readHead = (r: Reader): Head => {
  const length = r.u64();
  if (length < 1) refuse();
  return { length, last: r.b32() };
};
function writeSeal(w: Writer, s: EpochSeal): Writer {
  if (!isBytes(s.sealed) || s.sealed.length !== SEALED) throw new RangeError("a seal is 48 bytes");
  return w.b32(s.recipient).pk(s.enc).raw(s.sealed);
}
const readSeal = (r: Reader): EpochSeal => ({
  recipient: r.b32(),
  enc: r.pk(),
  sealed: r.raw(SEALED),
});

/** The signed bytes of an entry, label first, signature excluded; a value outside its field throws. */
export function encodeEpochEntry(e: EpochEntry): Bytes {
  if ((e.seq === 0) !== (e.prev === undefined))
    throw new RangeError("seq 0 has no prev; any other epoch has one");
  if (e.deviceHeads.length === 0 || e.seals.length === 0)
    throw new RangeError("an epoch has members and recipients");
  const w = new Writer().label("epoch-entry").b32(e.channel).u64(e.seq);
  writeHead(
    w.opt(e.prev, (x, v) => x.b32(v)),
    e.memberHead,
  );
  w.set(
    e.deviceHeads,
    (h) => h.person,
    (x, h) => writeHead(x.b32(h.person), h),
  );
  w.set(e.seals, (s) => s.recipient, writeSeal);
  return w.b32(e.commitment).b32(e.signerPerson).b32(e.signerDevice).bytes();
}

/** Reads an entry; a head of no entries, no member and no recipient are refused. */
export function decodeEpochEntry(bytes: Bytes): Result<EpochEntry> {
  return decode(bytes, (r) => {
    r.label("epoch-entry");
    const channel = r.b32();
    const seq = r.u64();
    const prev = r.opt((x) => x.b32());
    if ((seq === 0) !== (prev === undefined)) refuse();
    const memberHead = readHead(r);
    const deviceHeads = r.set(
      (x) => ({ person: x.b32(), ...readHead(x) }),
      (h) => h.person,
    );
    const seals = r.set(readSeal, (s) => s.recipient);
    if (deviceHeads.length === 0 || seals.length === 0) refuse();
    const [commitment, signerPerson, signerDevice] = [r.b32(), r.b32(), r.b32()];
    return {
      channel,
      seq,
      prev,
      memberHead,
      deviceHeads,
      seals,
      commitment,
      signerPerson,
      signerDevice,
    };
  });
}

/** The HPKE `info` of a seal: its label, the channel, the epoch before and the recipient's id. */
export const epochSealInfo = (channel: Bytes, prev: Bytes | undefined, recipient: Bytes): Bytes =>
  new Writer()
    .label("epoch-seal")
    .b32(channel)
    .opt(prev, (x, v) => x.b32(v))
    .b32(recipient)
    .bytes();

/** HKDF of the 32-byte epoch key under the commitment label, the channel and the epoch before. */
export function epochCommitment(
  platform: Platform,
  channel: Bytes,
  prev: Bytes | undefined,
  key: Bytes,
): Bytes {
  if (!isBytes(key) || key.length !== 32) throw new RangeError("an epoch key is 32 bytes");
  const info = new Writer()
    .label("commit")
    .b32(channel)
    .opt(prev, (x, v) => x.b32(v));
  return platform.hkdf(key, info.bytes(), 32);
}

/** Seals the epoch key to one recipient's receiving key; `recipient` is its id, bound into the `info`. */
export function sealEpochKey(
  platform: Platform,
  channel: Bytes,
  prev: Bytes | undefined,
  recipient: Bytes,
  receiving: Bytes,
  key: Bytes,
): Result<EpochSeal> {
  if (!isBytes(key) || key.length !== 32) throw new RangeError("an epoch key is 32 bytes");
  const sealed = platform.hpkeSeal(receiving, epochSealInfo(channel, prev, recipient), EMPTY, key);
  return sealed.ok ? ok({ recipient, ...sealed.value }) : sealed;
}

/**
 * Opens a seal under the private key `name` and returns the key only if it matches `commitment`
 * (security design 5.7); a mismatch is `open-failed` and says no more.
 */
function openSeal(
  platform: Platform,
  name: string,
  e: { channel: Bytes; prev?: Bytes | undefined; commitment: Bytes },
  seal: EpochSeal,
): Result<Bytes> {
  const info = epochSealInfo(e.channel, e.prev, seal.recipient);
  const opened = platform.hpkeOpen(name, seal.enc, info, EMPTY, seal.sealed);
  if (!opened.ok) return fail("open-failed"); // whatever the platform said: no more is told of which check failed
  const match = bytesEqual(
    epochCommitment(platform, e.channel, e.prev, opened.value),
    e.commitment,
  );
  return match ? opened : fail("open-failed");
}

/**
 * Opens the seal of `recipient` in an entry a check gave back, with the key held under `name`;
 * the key comes back only when it matches the entry's commitment.
 */
export function openEpochSeal(
  platform: Platform,
  name: string,
  epoch: LoggedEpoch,
  recipient: Bytes,
): Result<Bytes> {
  const seal = epoch.entry.seals.find((s) => bytesEqual(s.recipient, recipient));
  return seal ? openSeal(platform, name, epoch.entry, seal) : fail("open-failed");
}

/** `log` cut to the first `head.length` entries, if the entry `head` names is the one it holds there. */
export function cut<T extends { id: Bytes }>(log: readonly T[], head: Head): T[] | undefined {
  const there = Array.isArray(log) ? log[head.length - 1] : undefined;
  return there && bytesEqual(there.id, head.last) ? log.slice(0, head.length) : undefined;
}

/**
 * Whether `signed` with `signature` may follow `epochs` (security design 4): the structure, the
 * heads, the signer's device, the signature, then the rules. `members` and `devices` (each
 * person's device log) are checked entries, which may be longer than the entry's heads: the heads
 * cut them. An entry's recipients are exactly the active devices and the current recovery key of
 * the members at those heads. Each failure names its rule; nothing throws on another party's bytes.
 */
export function checkEpochEntry(
  platform: Platform,
  epochs: readonly LoggedEpoch[],
  members: readonly LoggedMember[],
  devices: readonly (readonly LoggedEntry[])[],
  signed: Bytes,
  signature: Bytes,
): EpochVerdict {
  const decoded = decodeEpochEntry(signed);
  const refused = (rule: EpochRule): EpochVerdict => ({ ok: false, rule });
  if (!decoded.ok) return refused("decode");
  const e = decoded.value;
  const atMembers = cut(members, e.memberHead);
  const persons = atMembers ? membersOf(atMembers) : new Set<string>();
  const logs = new Map<string, LoggedEntry[]>();
  for (const h of e.deviceHeads) {
    const own = Array.isArray(devices)
      ? devices.find((l) => l[0] && bytesEqual(l[0].id, h.person))
      : undefined;
    const seen = own && cut(own, h);
    if (seen) logs.set(idKey(h.person), seen);
  }
  if (
    persons.size !== logs.size ||
    e.deviceHeads.length !== logs.size ||
    ![...logs.keys()].every((k) => persons.has(k))
  )
    return refused("heads");
  const signerLog = logs.get(idKey(e.signerPerson));
  const signer = signerLog && activeDevices(platform, signerLog).get(idKey(e.signerDevice));
  if (!signer) return refused("device");
  if (
    !isBytes(signature) ||
    signature.length !== 64 ||
    !platform.verify(signer.signing, signed, signature)
  )
    return refused("signature");
  if (e.seq !== epochs.length) return refused("position");
  const last = epochs.at(-1);
  if (last && !(e.prev && bytesEqual(e.prev, last.id))) return refused("prev");
  if (!bytesEqual(e.channel, (members[0] as LoggedMember).id)) return refused("channel");
  const wanted = new Set(
    [...logs.values()].flatMap((l) => recipientsOf(platform, l).map((r) => idKey(r.id))),
  );
  if (e.seals.length !== wanted.size || !e.seals.every((s) => wanted.has(idKey(s.recipient))))
    return refused("recipients");
  return { ok: true, value: { entry: e, id: signedId(platform, signed) } };
}

/** A history seal as the bytes carry it, label first; a value outside its field throws. */
export const writeHistorySeal = (w: Writer, s: HistorySeal): Writer =>
  writeSeal(w.label("history-seal").b32(s.channel).b32(s.epoch), s).b32(s.maker);

/** Reads a history seal from `r`. */
export function readHistorySeal(r: Reader): HistorySeal {
  r.label("history-seal");
  const [channel, epoch] = [r.b32(), r.b32()];
  return { channel, epoch, ...readSeal(r), maker: r.b32() };
}

/** The signed bytes of a history seal, label first, signature excluded; a value outside its field throws. */
export const encodeHistorySeal = (s: HistorySeal): Bytes =>
  writeHistorySeal(new Writer(), s).bytes();

/** Reads a history seal. */
export const decodeHistorySeal = (bytes: Bytes): Result<HistorySeal> =>
  decode(bytes, readHistorySeal);

/**
 * Whether a history seal may be taken (security design 5.3, step 6): its maker is a device the
 * person's checked log `devices` ever named, removed since or not (a recovery key never is one),
 * and signed it.
 */
export function checkHistorySeal(
  platform: Platform,
  devices: readonly LoggedEntry[],
  signed: Bytes,
  signature: Bytes,
): HistoryVerdict {
  const decoded = decodeHistorySeal(signed);
  if (!decoded.ok) return { ok: false, rule: "decode" };
  const maker = Array.isArray(devices)
    ? namedDevices(platform, devices).get(idKey(decoded.value.maker))
    : undefined;
  if (!maker) return { ok: false, rule: "device" };
  if (
    !isBytes(signature) ||
    signature.length !== 64 ||
    !platform.verify(maker.signing, signed, signature)
  )
    return { ok: false, rule: "signature" };
  return decoded;
}

/**
 * Opens a history seal of `epoch`, an entry a check gave back, with the key held under `name`:
 * only after its signature verifies and only for that epoch, and the key comes back only when it
 * matches the epoch's commitment. Any refusal is `open-failed` and says no more.
 */
export function openHistorySeal(
  platform: Platform,
  name: string,
  devices: readonly LoggedEntry[],
  signed: Bytes,
  signature: Bytes,
  epoch: LoggedEpoch,
): Result<Bytes> {
  const checked = checkHistorySeal(platform, devices, signed, signature);
  const own =
    checked.ok &&
    bytesEqual(checked.value.channel, epoch.entry.channel) &&
    bytesEqual(checked.value.epoch, epoch.id);
  return own ? openSeal(platform, name, epoch.entry, checked.value) : fail("open-failed");
}

/**
 * The next epoch of a channel at the logs a device holds (security design 5.7): its heads, a fresh
 * key from the platform sealed to every active device and the current recovery key of each log in
 * `logs`, and the commitment. The key is returned to `buildEpoch` alone, which drops it: no caller
 * of the package holds an epoch key it did not read back.
 */
function draftEpoch(
  platform: Platform,
  members: readonly LoggedMember[],
  epochs: readonly LoggedEpoch[],
  logs: readonly (readonly LoggedEntry[])[],
  signer: { person: Bytes; device: Bytes },
): Result<{ entry: EpochEntry; key: Bytes }> {
  const channel = (members[0] as LoggedMember).id;
  const prev = epochs.at(-1)?.id;
  const key = platform.random(32);
  const seals: EpochSeal[] = [];
  for (const r of logs.flatMap((l) => recipientsOf(platform, l))) {
    const sealed = sealEpochKey(platform, channel, prev, r.id, r.receiving, key);
    if (!sealed.ok) return sealed;
    seals.push(sealed.value);
  }
  const entry: EpochEntry = {
    channel,
    seq: epochs.length,
    prev,
    memberHead: { length: members.length, last: (members.at(-1) as LoggedMember).id },
    deviceHeads: logs.map((l) => ({
      person: (l[0] as LoggedEntry).id,
      length: l.length,
      last: (l.at(-1) as LoggedEntry).id,
    })),
    seals,
    commitment: epochCommitment(platform, channel, prev, key),
    signerPerson: signer.person,
    signerDevice: signer.device,
  };
  return ok({ entry, key });
}

/**
 * Builds and signs the next epoch entry of the channel `members` log, with `devices` the logs of
 * its members (checked entries). It fails, as a value, when a member's log is missing or a seal
 * cannot be made; the relay refuses an entry built at heads that moved (result 2), and the caller
 * reads again and builds anew.
 */
export function buildEpoch(
  platform: Platform,
  members: readonly LoggedMember[],
  epochs: readonly LoggedEpoch[],
  devices: readonly (readonly LoggedEntry[])[],
  signer: { person: Bytes; device: Bytes; sign: string },
): Result<{ signed: Bytes; sig: Bytes; entry: EpochEntry }> {
  const persons = membersOf(members);
  const logs = devices.filter((l) => l[0] && persons.has(idKey(l[0].id)));
  const owners = new Set(logs.map((l) => idKey((l[0] as LoggedEntry).id)));
  if (persons.size === 0 || logs.length !== persons.size || owners.size !== persons.size)
    return fail("bad-input"); // every member's log once
  const drafted = draftEpoch(platform, members, epochs, logs, signer);
  if (!drafted.ok) return drafted;
  const signed = encodeEpochEntry(drafted.value.entry);
  const sig = platform.sign(signer.sign, signed);
  return sig.ok ? ok({ signed, sig: sig.value, entry: drafted.value.entry }) : sig;
}

/** Security design 5.7: an epoch is 30 days old at most. */
export const EPOCH_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What a device keeps for each channel of its current epoch's age: the epoch, and the time of its
 * first read of that entry, which carries no time. It is stored, since the device reads the
 * sequence again from the start at every run.
 */
export interface EpochClock {
  epoch: Bytes;
  since: number;
}

/** The clock after a read that reached the relay's end (`atRest`): the same while the current epoch is the one it counts, started at `now` for another. */
export function tickEpoch(
  clock: EpochClock | undefined,
  epochs: readonly LoggedEpoch[],
  now: number,
  atRest: boolean,
): EpochClock | undefined {
  const current = epochs.at(-1)?.id;
  if (!atRest) return clock; // mid-read the last epoch is not yet the current one
  if (!current) return undefined;
  return clock && bytesEqual(clock.epoch, current) ? clock : { epoch: current, since: now };
}

export type StartReason = "no-epoch" | "closed" | "no-key" | "rollover" | "aged";

/**
 * Why a device that has read a channel to its end starts the next epoch (security design 5.4 and
 * 5.7), or `undefined` when it has nothing to do: the channel has none, it is closed, the device
 * holds no key of the current one (its own seal failed the commitment, and no history seal
 * opened), a sender's counter is at its limit (`rollover`), or the epoch is 30 days old by `clock`.
 */
export function whyStart(
  view: { open: boolean; epochs: readonly LoggedEpoch[]; key: Bytes | undefined },
  clock: EpochClock | undefined,
  now: number,
  rollover: boolean,
): StartReason | undefined {
  const current = view.epochs.at(-1);
  if (!current) return "no-epoch";
  if (!view.open) return "closed";
  if (!view.key) return "no-key";
  if (rollover) return "rollover";
  const counted = clock && bytesEqual(clock.epoch, current.id);
  return counted && now - clock.since >= EPOCH_LIFE_MS ? "aged" : undefined;
}
