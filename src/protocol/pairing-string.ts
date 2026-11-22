/**
 * The pairing string a new device hands to the app that approves it (device pairing design 3.1,
 * 3.2, 3.4): the device, its proof of possession and its name as hex text, and the short form the
 * person compares on both screens. Written once for the bot and the app.
 */
import { decode, type Reader, Writer } from "./bytes.ts";
import {
  type DeviceKeys,
  encodeDevicePossession,
  type PublicKeys,
  readDevice,
  writeDevice,
} from "./device-log.ts";
import { deviceId } from "./ids.ts";
import { hiddenInName } from "./name-rule.ts";
import type { Bytes, Platform } from "./platform.ts";
import { fail, ok, type Result } from "./result.ts";

const MAX_NAME_BYTES = 64;
/** The device (kind byte and two keys) and the proof, before the name. */
const FIXED_BYTES = 1 + 65 + 65 + 64;
const HEX = /^(?:[0-9a-f]{2})+$/i;

const toHex = (bytes: Bytes): string =>
  Array.from(bytes, (b) => (b < 16 ? "0" : "") + b.toString(16)).join("");
const fromHex = (text: string): Bytes =>
  Uint8Array.from({ length: text.length / 2 }, (_, i) =>
    Number.parseInt(text.slice(i * 2, i * 2 + 2), 16),
  );

/**
 * Whether `name` may travel: 1 to 64 bytes of UTF-8 (a lone surrogate is not), with no hidden
 * character and no space at either end, as a bot's profile name (`name-rule.ts`).
 */
export function checkPairingName(platform: Platform, name: string): boolean {
  const bytes = platform.utf8Encode(name);
  if (bytes.length < 1 || bytes.length > MAX_NAME_BYTES) return false;
  if (name.startsWith(" ") || name.endsWith(" ")) return false;
  for (const p of name) if (hiddenInName(p.codePointAt(0) as number)) return false;
  const back = platform.utf8Decode(bytes);
  return back.ok && back.value === name;
}

/** The string for `device`, its proof of possession (made once) and its name; a bad name throws. */
export function encodePairingString(
  platform: Platform,
  device: DeviceKeys,
  proof: Bytes,
  name: string,
): string {
  if (!checkPairingName(platform, name)) throw new RangeError("not a name a device may carry");
  const w = writeDevice(new Writer(), device).sig(proof);
  return toHex(w.bytes()) + toHex(platform.utf8Encode(name));
}

/** Why a pasted string is refused: it is no pairing string, or it is one whose name may not travel (design 3.4). */
export type PairingRefusal = "not-a-string" | "bad-name";

function parse(
  platform: Platform,
  text: string,
):
  | { ok: true; value: { device: DeviceKeys; proof: Bytes; name: string } }
  | { ok: false; error: PairingRefusal } {
  const trimmed = text.trim();
  // Refused by its length before any work: a pasted text of megabytes is not scanned.
  if (trimmed.length > 2 * (FIXED_BYTES + MAX_NAME_BYTES) || !HEX.test(trimmed)) {
    return { ok: false, error: "not-a-string" };
  }
  const bytes = fromHex(trimmed);
  const head = decode(bytes, (r: Reader) => ({
    device: readDevice(r),
    proof: r.sig(),
    name: r.raw(Math.max(0, bytes.length - FIXED_BYTES)),
  }));
  if (!head.ok) return { ok: false, error: "not-a-string" };
  const name = platform.utf8Decode(head.value.name);
  if (!name.ok || !checkPairingName(platform, name.value)) return { ok: false, error: "bad-name" };
  return {
    ok: true,
    value: { device: head.value.device, proof: head.value.proof, name: name.value },
  };
}

/** What the string says; the proof is for `checkPairingProof`, and the name is only for the eye. */
export function decodePairingString(
  platform: Platform,
  text: string,
): Result<{ device: DeviceKeys; proof: Bytes; name: string }> {
  const read = parse(platform, text);
  return read.ok ? read : fail("bad-input");
}

/** `decodePairingString` for the approving app: the refusal says which it is, and the short form comes with the keys. */
export function inspectPairingString(
  platform: Platform,
  text: string,
):
  | { ok: true; value: { device: DeviceKeys; proof: Bytes; name: string; short: string } }
  | { ok: false; error: PairingRefusal } {
  const read = parse(platform, text);
  return read.ok
    ? { ok: true, value: { ...read.value, short: shortForm(platform, read.value.device) } }
    : read;
}

/** The proof of possession a joining device makes once, with its own signing key, for the person it joins (design 3.7). */
export function makePairingProof(
  platform: Platform,
  signName: string,
  person: Bytes,
  device: DeviceKeys,
): Result<Bytes> {
  let possession: Bytes;
  try {
    possession = encodeDevicePossession(person, device);
  } catch {
    // A person or a key of the wrong length: a refusal for the caller across JavaScriptCore, never a throw. No `instanceof` here.
    return fail("bad-input");
  }
  return platform.sign(signName, possession);
}

/** `encodePairingString` for a caller that cannot catch: a name that may not travel is a failure. */
export function pairingString(
  platform: Platform,
  device: DeviceKeys,
  proof: Bytes,
  name: string,
): Result<string> {
  if (!checkPairingName(platform, name)) return fail("bad-input");
  try {
    return ok(encodePairingString(platform, device, proof, name));
  } catch {
    // A key or a proof of the wrong length: only the encoding throws, and a caller across JavaScriptCore cannot catch.
    return fail("bad-input");
  }
}

/** The first 8 bytes of the device's id in four groups of four hex digits; its first 8 digits are the window's short id. */
export function shortForm(platform: Platform, device: PublicKeys): string {
  const id = toHex(deviceId(platform, device.signing, device.receiving)).slice(0, 16);
  return id.match(/.{4}/g)?.join("-") as string;
}

/** Whether `proof` is `device`'s own signature over its possession bytes for `person`. */
export function checkPairingProof(
  platform: Platform,
  person: Bytes,
  device: DeviceKeys,
  proof: Bytes,
): boolean {
  return (
    proof.length === 64 &&
    platform.verify(device.signing, encodeDevicePossession(person, device), proof)
  );
}
