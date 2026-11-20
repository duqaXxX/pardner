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
import type { Bytes, Platform } from "./platform.ts";
import { hidden as refusedInProfile } from "./profile.ts";
import { fail, ok, type Result } from "./result.ts";

const MAX_NAME_BYTES = 64;
/** The device (kind byte and two keys) and the proof, before the name. */
const FIXED_BYTES = 1 + 65 + 65 + 64;
// No name can pass for another: the bot profile's own refusals (a control, a line or paragraph
// separator, a lone surrogate), Unicode's default-ignorable code points, which render as nothing
// (DerivedCoreProperties.txt, Unicode 18.0.0, read 2026-11-20), and the interlinear annotations. The
// ranges are written here rather than read from an engine's Unicode tables, so that Node and
// JavaScriptCore give one verdict, as profile.ts does.
const INVISIBLE: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];
const hiddenInName = (c: number): boolean =>
  refusedInProfile(c) || INVISIBLE.some(([from, to]) => c >= from && c <= to);
const HEX = /^(?:[0-9a-f]{2})+$/i;

const toHex = (bytes: Bytes): string =>
  Array.from(bytes, (b) => (b < 16 ? "0" : "") + b.toString(16)).join("");
const fromHex = (text: string): Bytes =>
  Uint8Array.from({ length: text.length / 2 }, (_, i) =>
    Number.parseInt(text.slice(i * 2, i * 2 + 2), 16),
  );

/**
 * Whether `name` may travel: 1 to 64 bytes of UTF-8 (a lone surrogate is not), with no hidden
 * character and no space at either end, as a bot's profile name (profile.ts).
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

/** What the string says; the proof is for `checkPairingProof`, and the name is only for the eye. */
export function decodePairingString(
  platform: Platform,
  text: string,
): Result<{ device: DeviceKeys; proof: Bytes; name: string }> {
  const trimmed = text.trim();
  // Refused by its length before any work: a pasted text of megabytes is not scanned.
  if (trimmed.length > 2 * (FIXED_BYTES + MAX_NAME_BYTES) || !HEX.test(trimmed)) {
    return fail("bad-input");
  }
  const bytes = fromHex(trimmed);
  const head = decode(bytes, (r: Reader) => ({
    device: readDevice(r),
    proof: r.sig(),
    name: r.raw(Math.max(0, bytes.length - FIXED_BYTES)),
  }));
  if (!head.ok) return head;
  const name = platform.utf8Decode(head.value.name);
  if (!name.ok || !checkPairingName(platform, name.value)) return fail("bad-input");
  return ok({ device: head.value.device, proof: head.value.proof, name: name.value });
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
