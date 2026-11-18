import { bytesEqual, decode, isBytes, type Reader, refuse, Writer } from "./bytes.ts";
import { deviceId, recoveryKeyId, signedId } from "./ids.ts";
import type { Bytes, Platform } from "./platform.ts";
import type { Result } from "./result.ts";

/** A pair of public keys: a device's, or a recovery key's (design 6.1). */
export interface PublicKeys {
  signing: Bytes;
  receiving: Bytes;
}
export interface DeviceKeys extends PublicKeys {
  kind: "app" | "bot";
}

/** A device-log entry (design 6.1); `person` and `prev` are absent exactly at `seq` 0. */
export type DeviceEntry = {
  person?: Bytes | undefined;
  seq: number;
  prev?: Bytes | undefined;
  signer: Bytes;
} & DeviceBody;

/** What an entry does, by its kind. */
type DeviceBody =
  | { kind: "genesis"; device: DeviceKeys; recovery: PublicKeys }
  | { kind: "add"; device: DeviceKeys; proof: Bytes }
  | { kind: "remove"; device: Bytes }
  | {
      kind: "reset";
      set: Bytes[];
      newDevice?: { device: DeviceKeys; proof: Bytes } | undefined; // the new device and its proof of possession
      recovery?: PublicKeys | undefined;
    };

/** An entry the log holds: its id is SHA-256 of its signed bytes (the entry's signature is not part of it, a new device's proof is). */
export interface LoggedEntry {
  entry: DeviceEntry;
  id: Bytes;
}

/** Why an entry may not follow a log: `decode` is the structure, the rest are security design 4's rules. */
export type DeviceRule =
  | "decode"
  | "signature"
  | "proof"
  | "authority"
  | "position"
  | "prev"
  | "person"
  | "genesis"
  | "set"
  | "key named";

export type DeviceVerdict = { ok: true; value: LoggedEntry } | { ok: false; rule: DeviceRule };

const KINDS = ["genesis", "add", "remove", "reset"] as const;
const writeKeys = (w: Writer, k: PublicKeys) => w.pk(k.signing).pk(k.receiving);
/** `D`: a device's kind byte, then its two public keys. */
export function writeDevice(w: Writer, d: DeviceKeys): Writer {
  if (d.kind !== "app" && d.kind !== "bot") throw new RangeError("a device is an app or a bot");
  return writeKeys(w.u8(d.kind === "app" ? 1 : 2), d);
}
const readKeys = (r: Reader): PublicKeys => ({ signing: r.pk(), receiving: r.pk() });
export function readDevice(r: Reader): DeviceKeys {
  const kind = r.u8();
  if (kind !== 1 && kind !== 2) refuse();
  return { kind: kind === 1 ? "app" : "bot", ...readKeys(r) };
}

/**
 * What a new device signs with its own signing key to prove it holds it (design 6.1): the person id
 * of the log it joins and the device as an entry writes it. Make the proof once and reuse it on
 * every retry of the entry: ECDSA is randomized, so a new proof gives the entry another id.
 */
export function encodeDevicePossession(person: Bytes, device: DeviceKeys): Bytes {
  return writeDevice(new Writer().label("device-possession").b32(person), device).bytes();
}

/** The signed bytes of an entry, label first, signature excluded; a value outside its field throws. */
export function encodeDeviceEntry(e: DeviceEntry): Bytes {
  const first = e.seq === 0;
  if (
    (e.kind === "genesis") !== first ||
    (e.person === undefined) !== first ||
    (e.prev === undefined) !== first
  )
    throw new RangeError(
      "seq 0 is genesis and has no person and no prev; any other entry has both",
    );
  const w = new Writer().label("device-entry");
  w.opt(e.person, (x, v) => x.b32(v)).u64(e.seq);
  w.opt(e.prev, (x, v) => x.b32(v)).u8(KINDS.indexOf(e.kind));
  if (e.kind === "genesis") writeKeys(writeDevice(w, e.device), e.recovery);
  if (e.kind === "add") writeDevice(w, e.device).sig(e.proof);
  if (e.kind === "remove") w.b32(e.device);
  if (e.kind === "reset") {
    w.set(
      e.set,
      (id) => id,
      (x, id) => x.b32(id),
    );
    w.opt(e.newDevice, (x, n) => writeDevice(x, n.device).sig(n.proof)).opt(e.recovery, writeKeys);
  }
  return w.b32(e.signer).bytes();
}

/** Reads an entry; `seq` 0 is genesis and has no person and no prev, any other entry has both. */
export function decodeDeviceEntry(bytes: Bytes): Result<DeviceEntry> {
  return decode(bytes, (r) => {
    r.label("device-entry");
    const person = r.opt((x) => x.b32());
    const seq = r.u64();
    const prev = r.opt((x) => x.b32());
    const kind = KINDS[r.u8()];
    if (kind === undefined || (kind === "genesis") !== (seq === 0)) refuse();
    if ((person === undefined) !== (seq === 0) || (prev === undefined) !== (seq === 0)) refuse();
    const head = { person, seq, prev };
    let entry: DeviceBody & { person?: Bytes | undefined; seq: number; prev?: Bytes | undefined };
    if (kind === "genesis") entry = { ...head, kind, device: readDevice(r), recovery: readKeys(r) };
    else if (kind === "add") entry = { ...head, kind, device: readDevice(r), proof: r.sig() };
    else if (kind === "remove") entry = { ...head, kind, device: r.b32() };
    else {
      const set = r.set(
        (x) => x.b32(),
        (id) => id,
      );
      const newDevice = r.opt((x) => ({ device: readDevice(x), proof: x.sig() }));
      entry = { ...head, kind, set, newDevice, recovery: r.opt(readKeys) };
    }
    return { ...entry, signer: r.b32() } as DeviceEntry;
  });
}

/** A byte string as a map key. */
export const idKey = (id: Bytes) => Array.from(id, (b) => String.fromCharCode(b)).join("");

/** Whether any key of `keys` equals another of `keys`, or one in `before` (security design 4: a key is named once). */
const reused = (keys: readonly Bytes[], before: readonly Bytes[]) =>
  keys.some(
    (k, i) =>
      before.some((b) => bytesEqual(k, b)) || keys.slice(i + 1).some((o) => bytesEqual(k, o)),
  );
const keysOf = (...named: (PublicKeys | undefined)[]) =>
  named.flatMap((k) => (k ? [k.signing, k.receiving] : []));

/** Who is active, who was removed and which recovery key is current, after a log (design 6.1). */
interface State {
  devices: Map<string, DeviceKeys>; // every device the log ever named, by id
  active: Set<string>;
  removed: Set<string>;
  recoveries: Map<string, PublicKeys>; // every recovery key it ever named, by id
  recovery: string;
}

function stateOf(platform: Platform, log: readonly LoggedEntry[]): State {
  const s: State = {
    devices: new Map(),
    active: new Set(),
    removed: new Set(),
    recoveries: new Map(),
    recovery: "",
  };
  const device = (d: DeviceKeys) => {
    const id = idKey(deviceId(platform, d.signing, d.receiving));
    s.devices.set(id, d);
    s.active.add(id);
    return id;
  };
  const recovery = (k: PublicKeys) => {
    s.recovery = idKey(recoveryKeyId(platform, k.signing, k.receiving));
    s.recoveries.set(s.recovery, k);
  };
  for (const { entry: e } of log) {
    if (e.kind === "genesis") {
      device(e.device);
      recovery(e.recovery);
    }
    if (e.kind === "add") device(e.device);
    if (e.kind === "remove") {
      s.active.delete(idKey(e.device));
      s.removed.add(idKey(e.device));
    }
    if (e.kind === "reset") {
      if (e.newDevice) device(e.newDevice.device);
      const keep = new Set(e.set.map(idKey));
      for (const id of [...s.active])
        if (!keep.has(id)) {
          s.active.delete(id);
          s.removed.add(id);
        }
      for (const id of keep) s.active.add(id);
      if (e.recovery) recovery(e.recovery);
    }
  }
  return s;
}

/** The devices active after a log of checked entries, by `idKey` of their ids, with their keys. */
export function activeDevices(
  platform: Platform,
  log: readonly LoggedEntry[],
): Map<string, DeviceKeys> {
  const s = stateOf(platform, log);
  return new Map([...s.active].map((id) => [id, s.devices.get(id) as DeviceKeys]));
}

/** The recovery key after a log: the last one a genesis or a reset named (design 6.1). */
export function currentRecovery(
  platform: Platform,
  log: readonly LoggedEntry[],
): PublicKeys | undefined {
  const s = stateOf(platform, log);
  return s.recoveries.get(s.recovery);
}

/** Every device a log ever named, removed ones included, by `idKey` of their ids, with their keys. */
export function namedDevices(
  platform: Platform,
  log: readonly LoggedEntry[],
): Map<string, DeviceKeys> {
  return stateOf(platform, log).devices;
}

/** One fold of a log: its active devices, every device and recovery key it ever named (by `idKey` of their ids), and its current recovery key. */
export function foldLog(platform: Platform, log: readonly LoggedEntry[]) {
  const s = stateOf(platform, log);
  return {
    active: new Map([...s.active].map((id) => [id, s.devices.get(id) as DeviceKeys])),
    named: s.devices,
    recoveries: s.recoveries,
    recovery: s.recoveries.get(s.recovery),
  };
}

/** Who an epoch is sealed to after a log: its active devices and its current recovery key, with their receiving keys. */
export function recipientsOf(
  platform: Platform,
  log: readonly LoggedEntry[],
): { id: Bytes; receiving: Bytes }[] {
  const s = stateOf(platform, log);
  const recovery = s.recoveries.get(s.recovery);
  const devices = [...s.active].map((k) => s.devices.get(k) as DeviceKeys);
  return [
    ...devices.map((d) => ({
      id: deviceId(platform, d.signing, d.receiving),
      receiving: d.receiving,
    })),
    ...(recovery
      ? [
          {
            id: recoveryKeyId(platform, recovery.signing, recovery.receiving),
            receiving: recovery.receiving,
          },
        ]
      : []),
  ];
}

/**
 * Whether `signed` with `signature` may follow `log` (security design 4): the structure, then the
 * signature, then the proof of possession of a new device, then the rules, in that order; no field
 * is acted on before the signature verifies.
 * Each failure names its rule; nothing throws on another party's bytes.
 */
export function checkDeviceEntry(
  platform: Platform,
  log: readonly LoggedEntry[],
  signed: Bytes,
  signature: Bytes,
): DeviceVerdict {
  const decoded = decodeDeviceEntry(signed);
  if (!decoded.ok) return { ok: false, rule: "decode" };
  const e = decoded.value;
  const s = stateOf(platform, log);
  const signerKey =
    e.kind === "genesis"
      ? e.device.signing
      : (s.devices.get(idKey(e.signer)) ?? s.recoveries.get(idKey(e.signer)))?.signing;
  if (!signerKey) return { ok: false, rule: "authority" };
  if (
    !isBytes(signature) ||
    signature.length !== 64 ||
    !platform.verify(signerKey, signed, signature)
  )
    return { ok: false, rule: "signature" };
  const fail = (rule: DeviceRule): DeviceVerdict => ({ ok: false, rule });
  const proven = e.kind === "add" ? e : e.kind === "reset" ? e.newDevice : undefined;
  if (
    proven &&
    !platform.verify(
      proven.device.signing,
      encodeDevicePossession(e.person as Bytes, proven.device),
      proven.proof,
    )
  )
    return fail("proof");
  if (e.seq !== log.length) return fail("position");
  const first = log[0];
  if (e.kind === "genesis") {
    return bytesEqual(e.signer, deviceId(platform, e.device.signing, e.device.receiving)) &&
      !reused(keysOf(e.device, e.recovery), [])
      ? { ok: true, value: { entry: e, id: signedId(platform, signed) } }
      : fail("genesis");
  }
  const last = log.at(-1) as LoggedEntry;
  if (!e.prev || !bytesEqual(e.prev, last.id)) return fail("prev");
  if (!e.person || !first || !bytesEqual(e.person, first.id)) return fail("person");
  const signer = idKey(e.signer);
  const before = keysOf(...s.devices.values(), ...s.recoveries.values());
  const rule = ((): DeviceRule | null => {
    if (e.kind === "add") {
      const id = idKey(deviceId(platform, e.device.signing, e.device.receiving));
      if (!s.active.has(signer) || s.active.has(id) || s.removed.has(id)) return "authority";
      return reused(keysOf(e.device), before) ? "key named" : null;
    }
    if (e.kind === "remove")
      return s.active.has(signer) && s.active.has(idKey(e.device)) ? null : "authority";
    if (signer !== s.recovery) return "authority";
    const named = e.newDevice
      ? idKey(deviceId(platform, e.newDevice.device.signing, e.newDevice.device.receiving))
      : "";
    const set = e.set.map(idKey);
    if (set.length === 0 || (e.newDevice && !set.includes(named))) return "set";
    for (const d of set) if (s.removed.has(d) || (!s.active.has(d) && d !== named)) return "set";
    return reused(keysOf(e.newDevice?.device, e.recovery), before) ? "key named" : null;
  })();
  return rule ? fail(rule) : { ok: true, value: { entry: e, id: signedId(platform, signed) } };
}
