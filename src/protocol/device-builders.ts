/**
 * Device-log entries a device signs (device pairing design 3.6, 4.2): each is signed once with
 * the platform and checked against the log before it is returned, so a builder never returns an
 * entry the log would refuse. The caller keeps the bytes and the signature, and sends them as they are.
 */
import { bytesEqual } from "./bytes.ts";
import {
  checkDeviceEntry,
  type DeviceEntry,
  type DeviceKeys,
  decodeDeviceEntry,
  encodeDeviceEntry,
  type LoggedEntry,
  type PublicKeys,
} from "./device-log.ts";
import { deviceId, signedId } from "./ids.ts";
import type { Bytes, Platform } from "./platform.ts";
import { fail, ok, type Result } from "./result.ts";

/** An entry as a device sends it: the bytes it signed, its signature and its id. */
export interface SignedEntry {
  signed: Bytes;
  sig: Bytes;
  id: Bytes;
}

function seal(
  platform: Platform,
  signName: string,
  log: readonly LoggedEntry[],
  entry: () => DeviceEntry,
): Result<SignedEntry> {
  let signed: Bytes;
  try {
    signed = encodeDeviceEntry(entry());
  } catch {
    // Only the encoding of the caller's values runs here, and it throws only on a value outside its
    // field (a key, an id or a proof of the wrong length, an unknown kind): a refusal the caller
    // handles, never an exception thrown across JavaScriptCore. The package has no `instanceof`.
    return fail("bad-input");
  }
  const sig = platform.sign(signName, signed);
  if (!sig.ok) return sig;
  if (!checkDeviceEntry(platform, log, signed, sig.value).ok) return fail("bad-input");
  return ok({ signed, sig: sig.value, id: signedId(platform, signed) });
}

/** The first entry of a log: `device` names itself and the recovery keys. */
export function buildGenesis(
  platform: Platform,
  signName: string,
  device: DeviceKeys,
  recovery: PublicKeys,
): Result<SignedEntry> {
  return seal(platform, signName, [], () => ({
    seq: 0,
    kind: "genesis",
    device,
    recovery,
    signer: deviceId(platform, device.signing, device.receiving),
  }));
}

/** The position every later entry takes: the person, the next sequence number and the last id. */
function next(log: readonly LoggedEntry[]) {
  const first = log[0];
  const last = log.at(-1);
  return first && last ? { person: first.id, seq: log.length, prev: last.id } : undefined;
}

/** `signer` adds `device`, which made `proof` once for this log's person. */
export function buildAdd(
  platform: Platform,
  signName: string,
  log: readonly LoggedEntry[],
  signer: Bytes,
  device: DeviceKeys,
  proof: Bytes,
): Result<SignedEntry> {
  const at = next(log);
  if (!at) return fail("bad-input");
  return seal(platform, signName, log, () => ({ ...at, kind: "add", device, proof, signer }));
}

/** `signer` removes `target`. A device never removes itself, though the log would take it (design 3.9). */
export function buildRemove(
  platform: Platform,
  signName: string,
  log: readonly LoggedEntry[],
  signer: Bytes,
  target: Bytes,
): Result<SignedEntry> {
  const at = next(log);
  if (!at || bytesEqual(target, signer)) return fail("bad-input");
  return seal(platform, signName, log, () => ({ ...at, kind: "remove", device: target, signer }));
}

/**
 * A reset (security design 5.3), signed with the current recovery key `recovery` whose signing key the
 * platform holds under `signName`: `set` is every device that stays, `newDevice` the one that made `proof`
 * once for this log's person and `replacement` the new recovery key's public keys, when the person chose one.
 */
export function buildReset(
  platform: Platform,
  signName: string,
  log: readonly LoggedEntry[],
  recovery: Bytes,
  set: readonly Bytes[],
  newDevice?: { device: DeviceKeys; proof: Bytes },
  replacement?: PublicKeys,
): Result<SignedEntry> {
  const at = next(log);
  if (!at) return fail("bad-input");
  return seal(platform, signName, log, () => ({
    ...at,
    kind: "reset",
    set: [...set],
    newDevice,
    recovery: replacement,
    signer: recovery,
  }));
}

/**
 * What an add or a remove the app kept does (design 3.6): the app reads its pending entry back to see whether the log holds its
 * effect, and rebuilds an add from its keys and proof. `device` is the id of the device named or removed.
 */
export function readDeviceEntry(
  platform: Platform,
  signed: Bytes,
): Result<{
  kind: "add" | "remove";
  seq: number;
  prev: Bytes;
  signer: Bytes;
  device: Bytes;
  keys?: DeviceKeys;
  proof?: Bytes;
}> {
  const read = decodeDeviceEntry(signed);
  if (!read.ok) return read;
  const e = read.value;
  if (!e.prev || (e.kind !== "add" && e.kind !== "remove")) return fail("bad-input");
  const at = { seq: e.seq, prev: e.prev, signer: e.signer };
  return e.kind === "add"
    ? ok({
        kind: "add",
        ...at,
        device: deviceId(platform, e.device.signing, e.device.receiving),
        keys: e.device,
        proof: e.proof,
      })
    : ok({ kind: "remove", ...at, device: e.device });
}
