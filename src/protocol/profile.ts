/**
 * A bot's profile (kind 13, security design 5.13, package design 6.8): the codec of its content and
 * the rule of which profile a device shows. Written once for the bot and the app.
 */

import { bytesEqual, toHex } from "./bytes.ts";
import { idKey } from "./device-log.ts";
import {
  KIND_ARRANGEMENT,
  KIND_CHANNEL_NAME,
  KIND_DEVICE_NAME,
  KIND_PERSON_NAME,
  KIND_PROFILE,
  type MessageHeader,
} from "./messages.ts";
import { hidden, hiddenInName } from "./name-rule.ts";
import type { Bytes, Platform } from "./platform.ts";
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

// A channel's name is ASCII, as Slack's rule is (names design, header of 2026-11-22).
const CHANNEL_NAME = /^[a-z0-9_-]{1,80}$/;

/**
 * Whether `name` may name something that a message of `kind` names: a channel in ASCII `a-z 0-9 - _`,
 * 1 to 80 characters; a person or a device in free text of 1 to 64 code points under `hiddenInName`,
 * no space at either end, and a person without `@` (a person may be mentioned once a second exists).
 */
function nameFits(kind: number, name: unknown): name is string {
  if (kind === KIND_CHANNEL_NAME) return typeof name === "string" && CHANNEL_NAME.test(name);
  if (kind !== KIND_PERSON_NAME && kind !== KIND_DEVICE_NAME) return false;
  return (
    text(name, 1, 64) &&
    !name.startsWith(" ") &&
    !name.endsWith(" ") &&
    (kind === KIND_DEVICE_NAME || !name.includes("@"))
  );
}

/**
 * The name a message of `kind` (14, 15 or 16) carries (names design 2.1), or `bad-input`. A field it
 * does not know is ignored; one that does not read is no name, and the device shows the previous one.
 */
export function readName(kind: number, content: string): Result<string> {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return fail("bad-input");
  }
  return record(json) && nameFits(kind, json.name) ? ok(json.name) : fail("bad-input");
}

/** Whether `name` may be a person's: the rule kind 15 is read under (the app checks the name typed at setup with it; the platform is unused). */
export function checkPersonName(_platform: Platform, name: string): boolean {
  return nameFits(KIND_PERSON_NAME, name);
}

/** The content of a name message of `kind`; a name `readName` would refuse throws. */
export function encodeName(kind: number, name: string): string {
  if (!nameFits(kind, name)) throw new RangeError("a name readName refuses");
  return JSON.stringify({ name });
}

const MAX_ARRANGEMENT = 131_072; // bytes of content; above the sum of the limits below, so what is within them encodes
export const MAX_SECTIONS = 64;
export const MAX_CHANNELS = 1_024;
const MAX_CARRIED = 8_192; // bytes of the carried fields as a writer emits them, in the whole content
const MAX_DEPTH = 32;
const HEX_ID = /^[0-9a-f]{32}$/; // a section id, a base's message name
const HEX_CHANNEL = /^[0-9a-f]{64}$/; // a channel id, a base's sender

/** One section of the sidebar: its id, its name, its channels in order, and the fields of a later version, carried. */
export interface ArrangementSection {
  id: string;
  name: string;
  channels: string[];
  carried: Record<string, unknown>;
}

/** The arrangement of the sidebar's sections (kind 17, sidebar sections design 2); ids in lowercase hex. */
export interface Arrangement {
  base: { sender: string; name: string } | null;
  sections: ArrangementSection[];
  carried: Record<string, unknown>;
}

// The bytes of a string in UTF-8, counted by hand: the protocol uses no text API of an engine. A lone surrogate counts 3.
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// Whether a container of the parsed value sits deeper than `MAX_DEPTH` (the top one is level 1): an explicit stack, so no depth of input can exhaust the engine's.
function nestsPast(root: unknown): boolean {
  const stack: [unknown, number][] = [[root, 1]];
  for (let top = stack.pop(); top; top = stack.pop()) {
    const [v, depth] = top;
    if (typeof v !== "object" || v === null) continue;
    if (depth > MAX_DEPTH) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, depth + 1]);
  }
  return false;
}

// The fields of `from` a reader does not know, in an object with no prototype and set with `defineProperty`, so that one named `__proto__` is a field.
function carry(from: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(from))
    if (!known.includes(key))
      Object.defineProperty(out, key, {
        value: from[key],
        enumerable: true,
        writable: true,
        configurable: true,
      });
  return out;
}

// The bytes a carried object takes when written, braces included; one with no field counts nothing.
const carriedBytes = (c: Record<string, unknown>): number =>
  Object.keys(c).length === 0 ? 0 : utf8Length(JSON.stringify(c));

const hexOf = (v: unknown, pattern: RegExp): v is string =>
  typeof v === "string" && pattern.test(v);

/**
 * The arrangement of a message's content (sidebar sections design 2), or `bad-input`: whole, or not
 * at all (crypto.md 9). A field it does not know is carried, so that a later version's field
 * survives an older app's edit. The files of the body are the caller's to refuse, as `Names` does.
 * Any exception inside is a refusal, so that no content can stop the caller.
 */
export function readArrangement(content: string): Result<Arrangement> {
  try {
    if (typeof content !== "string" || utf8Length(content) > MAX_ARRANGEMENT)
      return fail("bad-input");
    const json: unknown = JSON.parse(content);
    if (nestsPast(json) || !record(json) || !Array.isArray(json.sections)) return fail("bad-input");
    const b = json.base;
    if (b !== null && !(record(b) && hexOf(b.sender, HEX_CHANNEL) && hexOf(b.name, HEX_ID)))
      return fail("bad-input");
    if (json.sections.length > MAX_SECTIONS) return fail("bad-input");
    const ids = new Set<string>();
    const channels = new Set<string>();
    const sections: ArrangementSection[] = [];
    for (const raw of json.sections as unknown[]) {
      if (!record(raw) || !hexOf(raw.id, HEX_ID) || !Array.isArray(raw.channels))
        return fail("bad-input");
      const name = raw.name;
      if (!nameFits(KIND_DEVICE_NAME, name) || ids.has(raw.id)) return fail("bad-input");
      ids.add(raw.id);
      for (const c of raw.channels as unknown[]) {
        if (!hexOf(c, HEX_CHANNEL) || channels.has(c)) return fail("bad-input");
        channels.add(c);
      }
      if (channels.size > MAX_CHANNELS) return fail("bad-input");
      sections.push({
        id: raw.id,
        name,
        channels: raw.channels as string[],
        carried: carry(raw, ["id", "name", "channels"]),
      });
    }
    const carried = carry(json, ["base", "sections"]);
    const size = [carried, ...sections.map((s) => s.carried)].reduce(
      (n, c) => n + carriedBytes(c),
      0,
    );
    if (size > MAX_CARRIED) return fail("bad-input");
    return ok({
      base: b === null ? null : { sender: b.sender as string, name: b.name as string },
      sections,
      carried,
    });
  } catch {
    return fail("bad-input");
  }
}

/** The content of an arrangement, its carried fields written beside the known ones in the same objects; one `readArrangement` would refuse throws. */
export function encodeArrangement(a: Arrangement): string {
  const clashes = (carried: Record<string, unknown>, known: string[]) =>
    Object.keys(carried).some((k) => known.includes(k));
  if (
    clashes(a.carried, ["base", "sections"]) ||
    a.sections.some((s) => clashes(s.carried, ["id", "name", "channels"]))
  )
    throw new RangeError("a carried field named as a known one");
  const content = JSON.stringify({
    base: a.base && { sender: a.base.sender, name: a.base.name },
    sections: a.sections.map((s) => ({
      id: s.id,
      name: s.name,
      channels: s.channels,
      ...s.carried,
    })),
    ...a.carried,
  });
  if (!readArrangement(content).ok) throw new RangeError("an arrangement readArrangement refuses");
  return content;
}

/** Kind 17 takes a body from the copy at `first` alone (sidebar sections design 3.2). */
const firstCopyOnly = (kind: number): boolean => kind === KIND_ARRANGEMENT;

/** A name message's header as `Names` takes it: where it is, what it names, and who sent it. */
type NameHeader = Pick<MessageHeader, "kind" | "channel" | "sender" | "name">;
const copyKey = (h: NameHeader): string =>
  `${h.kind} ${idKey(h.channel)} ${idKey(h.sender)} ${idKey(h.name)}`;
interface Copy {
  kind: number;
  channel: Bytes;
  sender: Bytes;
  name: Bytes;
  /** The place of the first copy seen, from its header, whether or not the body opened. */
  first: number;
  /** The place of the first copy opened (kind 17: the first copy only, opened or not under a held key), and its name when it reads and carries no file. */
  opened?: number;
  shown?: string | undefined;
  /** The arrangement of a kind 17 copy that opened, reads and carries no file. */
  arrangement?: Arrangement | undefined;
}

/** One kind 17 message of the walk (sidebar sections design 3.2): `passed` while its body has not opened, `none` when it takes no part, `stands` when it became the standing tree. */
export interface ArrangementStep {
  sender: Bytes;
  name: Bytes;
  status: "passed" | "none" | "stands";
}

/** The walk over the kind 17 messages of a space: each message's outcome in place order, and the tree that stands. */
export interface ArrangementWalk {
  steps: ArrangementStep[];
  standing?: { sender: Bytes; name: Bytes; arrangement: Arrangement };
}

/**
 * Which name a device shows (names design 3, the model's `channelNameOf`, `personNameOf` and
 * `deviceNameOf`). The caller hands in the header of every message of kinds 14 to 17 it accepted
 * (SD 5.6), opened or not, and the content of those it opened, in any order, each with its place in
 * the relay's sequence. Copies of one name count once, at the place of the first copy, which the
 * header gives; the latest place wins whatever arrived last; a body that does not read or carries
 * files is no name. Kinds 15 and 16 count in the space the caller names alone. Kind 17 takes a body from the first copy alone and is read by `arrangement`, not by the name getters. A caller builds a new
 * one when the reading starts again from the start, as it does its `Profiles`.
 */
export class Names {
  // By kind, channel, sender and message name: the same name sent into two channels, or as two kinds, is two messages.
  #copies = new Map<string, Copy>();

  /** The header of an accepted message: the place of its sender's first copy of this name. */
  see(position: number, h: NameHeader): void {
    if (h.kind < KIND_CHANNEL_NAME || h.kind > KIND_ARRANGEMENT) return;
    const key = copyKey(h);
    const had = this.#copies.get(key);
    if (!had || position < had.first) {
      // A body taken from a later copy no longer counts, for kind 17, where only the first copy's does.
      this.#copies.set(key, {
        ...(firstCopyOnly(h.kind) ? undefined : had),
        kind: h.kind,
        channel: h.channel,
        sender: h.sender,
        name: h.name,
        first: position,
      });
    }
  }

  /** A message once opened. The same place is the same message, taken again: it replaces what was taken. `content` is undefined for a kind 17 body that did not open under a key the device holds: it takes no part (design 3.1). */
  take(
    position: number,
    h: NameHeader & Pick<MessageHeader, "blobs">,
    content: string | undefined,
  ): void {
    this.see(position, h);
    const copy = this.#copies.get(copyKey(h));
    if (!copy) return;
    if (
      firstCopyOnly(h.kind)
        ? position !== copy.first
        : copy.opened !== undefined && copy.opened < position
    )
      return;
    copy.opened = position;
    if (h.kind === KIND_ARRANGEMENT) {
      const read =
        h.blobs.length === 0 && content !== undefined ? readArrangement(content) : undefined;
      copy.arrangement = read?.ok ? read.value : undefined;
      return;
    }
    const read =
      h.blobs.length === 0 && content !== undefined ? readName(h.kind, content) : undefined;
    copy.shown = read?.ok ? read.value : undefined;
  }

  /**
   * Which arrangement stands in `space` (sidebar sections design 3.2, the model's `arrangementWalk`): the kind 17
   * messages of the space in the place of their first copies, each in its turn. A message whose first copy has not
   * opened is passed over; one that does not read takes no part; one built over the standing tree, or over none
   * while none stands, becomes the standing tree; any other takes no part. Run again whenever a body opens.
   */
  arrangement(space: Bytes): ArrangementWalk {
    const steps: ArrangementStep[] = [];
    let standing: ArrangementWalk["standing"];
    const copies = [...this.#copies.values()]
      .filter((c) => c.kind === KIND_ARRANGEMENT && bytesEqual(c.channel, space))
      .sort((a, b) => a.first - b.first);
    for (const c of copies) {
      const step: ArrangementStep = { sender: c.sender, name: c.name, status: "none" };
      steps.push(step);
      if (c.opened === undefined) step.status = "passed";
      else if (c.arrangement) {
        const { base } = c.arrangement;
        const over = base
          ? standing && base.sender === toHex(standing.sender) && base.name === toHex(standing.name)
          : !standing;
        if (over) {
          step.status = "stands";
          standing = { sender: c.sender, name: c.name, arrangement: c.arrangement };
        }
      }
    }
    return standing ? { steps, standing } : { steps };
  }

  #latest(of: (c: Copy) => boolean): string | undefined {
    let at = -1;
    let shown: string | undefined;
    for (const c of this.#copies.values())
      if (c.shown !== undefined && c.first > at && of(c)) [at, shown] = [c.first, c.shown];
    return shown;
  }

  /** The name of a conversation channel. */
  channel(channel: Bytes): string | undefined {
    return this.#latest((c) => c.kind === KIND_CHANNEL_NAME && bytesEqual(c.channel, channel));
  }

  /** The person's name, from `space` alone. */
  person(space: Bytes): string | undefined {
    return this.#latest((c) => c.kind === KIND_PERSON_NAME && bytesEqual(c.channel, space));
  }

  /** The name of `device`, from `space` alone and sent by that device itself. */
  device(space: Bytes, device: Bytes): string | undefined {
    return this.#latest(
      (c) =>
        c.kind === KIND_DEVICE_NAME && bytesEqual(c.channel, space) && bytesEqual(c.sender, device),
    );
  }

  /** Whether the sequence holds a kind 15 in `space` whose message name is not `name`: the person named themselves since (names design 4.2). */
  personNamedOtherwise(space: Bytes, name: Bytes): boolean {
    for (const c of this.#copies.values())
      if (c.kind === KIND_PERSON_NAME && bytesEqual(c.channel, space) && !bytesEqual(c.name, name))
        return true;
    return false;
  }

  /** Whether the sequence holds any kind 15 in `space`: the person is named (names design 4.2). */
  hasPerson(space: Bytes): boolean {
    for (const c of this.#copies.values())
      if (c.kind === KIND_PERSON_NAME && bytesEqual(c.channel, space)) return true;
    return false;
  }

  /** Whether the sequence holds a kind 16 in `space` sent by `device`, opened or not (names design 4.3). */
  hasDevice(space: Bytes, device: Bytes): boolean {
    for (const c of this.#copies.values())
      if (
        c.kind === KIND_DEVICE_NAME &&
        bytesEqual(c.channel, space) &&
        bytesEqual(c.sender, device)
      )
        return true;
    return false;
  }
}
