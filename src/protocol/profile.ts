/**
 * A bot's profile (kind 13, security design 5.13, package design 6.8): the codec of its content and
 * the rule of which profile a device shows. Written once for the bot and the app.
 */

import { idKey } from "./device-log.ts";
import { KIND_PROFILE, type MessageHeader } from "./messages.ts";
import { hidden, hiddenInName } from "./name-rule.ts";
import type { Bytes } from "./platform.ts";
import { fail, ok, type Result } from "./result.ts";

/** What a bot says of itself: its name, the agent's account where its members may read it, its icon. */
export interface Profile {
  name: string;
  account?: { name: string; plan: string | null } | undefined;
  /** A PNG or a JPEG, square, 16 to 256 pixels a side, 65,536 bytes at most. */
  icon?: Bytes | undefined;
}

const MAX_ICON = 65_536;
const MAX_ICON_TEXT = 4 * Math.ceil(MAX_ICON / 3); // its base64, refused before it is decoded

const text = (v: unknown, min: number, max: number): v is string => {
  // A code point is one or two UTF-16 units: a longer string is refused before it is split.
  if (typeof v !== "string" || v.length > 2 * max) return false;
  const points = [...v];
  return (
    points.length >= min &&
    points.length <= max &&
    points.every((p) => !hiddenInName(p.codePointAt(0) as number))
  );
};
/**
 * Whether a code point may not stand in a default name: what `hidden` names, and `@`. A default
 * name drops only these; one holding an invisible code point stops setup, which asks for a name.
 */
export const refusedInName = (c: number): boolean => hidden(c) || c === 0x40;
const nameTaken = (name: unknown): name is string =>
  text(name, 1, 32) && !name.includes("@") && !name.startsWith(" ") && !name.endsWith(" ");
const short = (v: unknown): v is string => text(v, 0, 256);

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(bytes: Bytes): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const left = bytes.length - i;
    out += ALPHABET[n >> 18] as string;
    out += ALPHABET[(n >> 12) & 63] as string;
    out += left > 1 ? (ALPHABET[(n >> 6) & 63] as string) : "=";
    out += left > 2 ? (ALPHABET[n & 63] as string) : "=";
  }
  return out;
}

/** The bytes of padded standard base64, or `undefined` for any other text: one value, one string. */
function fromBase64(text: string): Bytes | undefined {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return undefined;
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let bits = 0;
  let n = 0;
  let o = 0;
  for (const ch of text.slice(0, text.length - pad)) {
    n = (n << 6) | ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (n >> bits) & 255;
      n &= (1 << bits) - 1;
    }
  }
  return toBase64(out) === text ? out : undefined; // bits past the bytes make another string
}

// The JPEG frames of one image, its size in their header: SOF0 to SOF3 and SOF9 to SOF11.
const FRAMES = [0xc0, 0xc1, 0xc2, 0xc3, 0xc9, 0xca, 0xcb];
// What may come before the frame: APP0 to APP15, a comment, the tables (DQT, DHT, DAC) and DRI.
// Any other marker refuses, so that none whose header declares the image's size (DHP, the frames
// of a hierarchical or a JPEG-LS image) is walked past: what is not known is refused.
const before = (marker: number) =>
  (marker >= 0xe0 && marker <= 0xef) || [0xfe, 0xdb, 0xc4, 0xcc, 0xdd].includes(marker);

/** The side of a square PNG or JPEG, read from its own header; `undefined` for anything else. */
function iconSide(b: Bytes): number | undefined {
  const u16 = (i: number) => ((b[i] as number) << 8) | (b[i + 1] as number);
  const u32 = (i: number) => u16(i) * 65_536 + u16(i + 2);
  const square = (w: number, h: number) => (w === h ? w : undefined);
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (PNG.every((x, i) => b[i] === x)) {
    // IHDR is the first chunk: its length (13) at bytes 8 to 11, its type at 12 to 15, then the
    // width and the height.
    const ihdr = [0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52].every((x, i) => b[8 + i] === x);
    return b.length >= 24 && ihdr ? square(u32(16), u32(20)) : undefined;
  }
  if (b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return undefined;
  // From SOI, segment by segment by their lengths, never a scan of the bytes: an EXIF thumbnail
  // inside APP1 carries a frame header of its own.
  for (let i = 2; i + 1 < b.length; ) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1] as number;
    if (marker === 0xff) {
      i += 1; // a fill byte
      continue;
    }
    if (FRAMES.includes(marker)) {
      // Length, precision, height, width, the count of components, then three bytes for each: a
      // header whose length says otherwise, or that runs past the end, is no size to trust.
      if (i + 10 > b.length) return undefined;
      const length = u16(i + 2);
      const components = b[i + 9] as number;
      const whole = components >= 1 && length === 8 + 3 * components && i + 2 + length <= b.length;
      return whole ? square(u16(i + 7), u16(i + 5)) : undefined;
    }
    if (!before(marker) || i + 4 > b.length || u16(i + 2) < 2) return undefined;
    i += 2 + u16(i + 2);
  }
  return undefined;
}

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The profile of a message's content (design 3.1), or `bad-input`. A field it does not know is
 * ignored, so that a profile written by a later version still names its bot; a known field that
 * does not read refuses the whole profile (crypto.md 9), so a later version that changes a known
 * field's rule writes it under a new field. The one exception is `name`, tightened in place on
 * 2026-11-22 to the rule of a device's name (`hiddenInName`): an older profile whose name holds an
 * invisible code point no longer reads, and a device shows the last profile that does, else the id.
 */
export function readProfile(content: string): Result<Profile> {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return fail("bad-input");
  }
  if (!record(json) || !nameTaken(json.name)) return fail("bad-input");
  const profile: Profile = { name: json.name };
  if ("account" in json) {
    const a = json.account;
    if (!record(a) || !short(a.name) || !(a.plan === null || short(a.plan)))
      return fail("bad-input");
    profile.account = { name: a.name, plan: a.plan };
  }
  if ("icon" in json) {
    const icon =
      typeof json.icon === "string" && json.icon.length <= MAX_ICON_TEXT
        ? fromBase64(json.icon)
        : undefined;
    const side = icon && icon.length <= MAX_ICON ? iconSide(icon) : undefined;
    if (!icon || side === undefined || side < 16 || side > 256) return fail("bad-input");
    profile.icon = icon;
  }
  return ok(profile);
}

/** The content of a profile; a profile `readProfile` would refuse throws. */
export function encodeProfile(p: Profile): string {
  const content = JSON.stringify({
    name: p.name,
    ...(p.account && { account: { name: p.account.name, plan: p.account.plan } }),
    ...(p.icon && { icon: toBase64(p.icon) }),
  });
  if (!readProfile(content).ok) throw new RangeError("a profile readProfile refuses");
  return content;
}

/**
 * Which profile a device shows for each bot (design 3.3, the model's `profileOf`). The caller hands
 * in every message it accepted (SD 5.6) and opened, in any order, with its position in the relay's
 * sequence, in any channel. Copies of one name count once, at the place of the first, which counts
 * only if its content reads; a kind 13 with files is no profile; the latest place wins, whatever
 * arrived last. Positions of two incarnations are no one order: a caller builds a new one when the
 * reading starts again from the start, as it does its `Seen`.
 */
export class Profiles {
  // By sender, then by name: the place of the name's first copy, and its profile if that copy reads.
  #bots = new Map<string, Map<string, { position: number; profile: Profile | undefined }>>();

  take(
    position: number,
    h: Pick<MessageHeader, "kind" | "sender" | "name" | "blobs">,
    content: string,
  ): void {
    if (h.kind !== KIND_PROFILE) return;
    const names = this.#bots.get(idKey(h.sender)) ?? new Map();
    this.#bots.set(idKey(h.sender), names);
    const had = names.get(idKey(h.name));
    // The same place is the same message, taken again once it opens: it replaces what was taken.
    if (had && had.position < position) return;
    // A copy with files is no profile, as one whose content does not read: its name still counts here.
    const read = h.blobs.length === 0 ? readProfile(content) : undefined;
    names.set(idKey(h.name), { position, profile: read?.ok ? read.value : undefined });
  }

  /** The profile shown for `bot`, or `undefined`: the device then names it by its id. */
  of(bot: Bytes): Profile | undefined {
    let shown: { position: number; profile: Profile | undefined } | undefined;
    for (const n of this.#bots.get(idKey(bot))?.values() ?? [])
      if (n.profile && (!shown || n.position > shown.position)) shown = n;
    return shown?.profile;
  }
}
