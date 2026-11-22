import { bytesEqual, decode, isBytes, type Reader, refuse, Writer } from "./bytes.ts";
import { activeDevices, type DeviceKeys, idKey, type LoggedEntry } from "./device-log.ts";
import { cut, type LoggedEpoch } from "./epochs.ts";
import { signedId } from "./ids.ts";
import type { LabelName } from "./labels.ts";
import type { Bytes, Platform } from "./platform.ts";
import { fail, type Result } from "./result.ts";

/** A message named by its sender and its name: `re` of a header, and a notice's prompt. */
export interface Reference {
  device: Bytes;
  name: Bytes;
}

/** A message's header (design 6.4): in clear, and the additional data of its body. */
export interface MessageHeader {
  channel: Bytes;
  counter: number;
  epoch: Bytes;
  sender: Bytes;
  run: Bytes;
  incarnation: Bytes;
  time: number;
  kind: number;
  to?: Bytes | undefined;
  re?: Reference | undefined;
  blobs: Bytes[];
  name: Bytes;
}

/** A file of a body: the blob's id, the key that opens it, its size, its type and its name. */
export interface MessageFile {
  blob: Bytes;
  fileKey: Bytes;
  size: number;
  type: string;
  name: string;
}

/** The body, once opened: its files, then the seam's JSON as UTF-8 text. */
export interface MessageBody {
  files: MessageFile[];
  content: string;
}

/** What is signed, minus the label: the header and the sealed body. */
export interface Message {
  header: MessageHeader;
  ciphertext: Bytes;
}

/** Why a message may not be shown: `decode` is the structure, the rest are security design 5.6's conditions. */
export type MessageRule =
  | "decode"
  | "epoch"
  | "heads"
  | "sender"
  | "signature"
  | "counter"
  | "kind"
  | "class"
  | "to"
  | "re";
export type MessageVerdict =
  | { ok: true; value: { message: Message; id: Bytes } }
  | { ok: false; rule: MessageRule };

/** The kind of a bot's start (6.4): a start belongs to the run that wrote it. */
export const KIND_START = 3;
/** The kind of a build of the app (6.4): the relay keeps the newest of a bot's builds (SD 5.12, point 8). */
export const KIND_BUILD = 12;
/** The kind of a bot's profile (6.4, 6.8): it names its sender alone, so it has no `to` and no `re`. */
export const KIND_PROFILE = 13;
/** The kind of a channel's name (6.4, 6.8): sent by an app into its own conversation channel. */
export const KIND_CHANNEL_NAME = 14;
/** The kind of a person's name: sent by an app into the person's space. */
export const KIND_PERSON_NAME = 15;
/** The kind of a device's name: sent by that app into the person's space. */
export const KIND_DEVICE_NAME = 16;
/** The kinds of a person's space, which no conversation channel holds; every other kind, a channel's name included, is the conversation channels' (personal space design 4, S5). */
const SPACE_KINDS: readonly number[] = [KIND_PROFILE, KIND_PERSON_NAME, KIND_DEVICE_NAME];
// By kind, 1 to 16: how 6.4's table treats `to` and `re` (0 none, 1 required, 2 either), and who sends it.
const KINDS = [
  [0, 2, undefined],
  [1, 0, "app"],
  [0, 1, "bot"],
  [0, 1, "bot"],
  [0, 1, "bot"],
  [0, 1, "bot"],
  [0, 1, "bot"],
  [0, 0, "bot"],
  [0, 1, "bot"],
  [1, 1, "app"],
  [2, 1, undefined],
  [0, 0, "bot"],
  [0, 0, "bot"],
  [0, 0, "app"],
  [0, 0, "app"],
  [0, 0, "app"],
] as const;
/** Whether only a bot may send `kind` (6.4's table, sender column): `fits` reads the `to` and `re` columns alone. */
export const botOnly = (kind: number): boolean => KINDS[kind - 1]?.[2] === "bot";
/** A sender never seals past this many messages in an epoch (SD 5.7). */
export const MAX_COUNTER = 100_000;
const allowed = (rule: number, present: boolean) => rule === 2 || (rule === 1) === present;
/** Whether 6.4's table allows the kind with this `to` and `re`: the encoder's check, and the outbox's. */
export function fits(h: Pick<MessageHeader, "kind" | "to" | "re">): boolean {
  const rules = KINDS[h.kind - 1];
  return !!rules && allowed(rules[0], h.to !== undefined) && allowed(rules[1], h.re !== undefined);
}

/** The header's bytes; a kind outside the table, a `to` or `re` it does not allow, or a counter of 0 throws. */
export function encodeHeader(h: MessageHeader): Bytes {
  if (h.counter < 1) throw new RangeError("a counter starts at 1");
  if (!fits(h)) throw new RangeError("a kind outside the table, or a to or re it does not allow");
  return new Writer()
    .b32(h.channel)
    .u32(h.counter)
    .b32(h.epoch)
    .b32(h.sender)
    .b16(h.run)
    .b16(h.incarnation)
    .u64(h.time)
    .u8(h.kind)
    .opt(h.to, (w, v) => w.b32(v))
    .opt(h.re, (w, v) => w.b32(v.device).b16(v.name))
    .set(
      h.blobs,
      (b) => b,
      (w, b) => w.b32(b),
    )
    .b16(h.name)
    .bytes();
}

function readHeader(r: Reader): MessageHeader {
  const h = {
    channel: r.b32(),
    counter: r.u32(),
    epoch: r.b32(),
    sender: r.b32(),
    run: r.b16(),
    incarnation: r.b16(),
    time: r.u64(),
    kind: r.u8(),
    to: r.opt((x) => x.b32()),
    re: r.opt((x) => ({ device: x.b32(), name: x.b16() })),
    blobs: r.set(
      (x) => x.b32(),
      (b) => b,
    ),
    name: r.b16(),
  };
  if (h.counter < 1 || !fits(h)) refuse();
  return h;
}

/** Reads a header; a kind outside the table, a `to` or `re` against it and a counter of 0 are refused. */
export const decodeHeader = (bytes: Bytes): Result<MessageHeader> => decode(bytes, readHeader);

/** The signed bytes of a message, label first, signature excluded. */
export const encodeMessage = (m: Message): Bytes =>
  new Writer().label("message").raw(encodeHeader(m.header)).var(m.ciphertext).bytes();

/** Reads signed bytes; the header is the additional data of the body, so it is not kept apart. */
export const decodeMessage = (signed: Bytes): Result<Message> =>
  decode(signed, (r) => {
    r.label("message");
    return { header: readHeader(r), ciphertext: r.var() };
  });

/** The body's bytes; the files are written sorted by blob, as the header lists them. */
export const encodeBody = (platform: Platform, b: MessageBody): Bytes =>
  new Writer()
    .set(
      b.files,
      (f) => f.blob,
      (w, f) =>
        w
          .b32(f.blob)
          .b32(f.fileKey)
          .u64(f.size)
          .var(platform.utf8Encode(f.type))
          .var(platform.utf8Encode(f.name)),
    )
    .var(platform.utf8Encode(b.content))
    .bytes();

/** Reads a body; text that is not UTF-8 is refused. The order of the files is `openMessage`'s to check. */
export function decodeBody(platform: Platform, bytes: Bytes): Result<MessageBody> {
  const text = (r: Reader) => {
    const decoded = platform.utf8Decode(r.var());
    return decoded.ok ? decoded.value : refuse();
  };
  return decode(bytes, (r) => ({
    files: r.list((x) => ({
      blob: x.b32(),
      fileKey: x.b32(),
      size: x.u64(),
      type: text(x),
      name: text(x),
    })),
    content: text(r),
  }));
}

/** HKDF of the epoch key under the sender label, the channel, the epoch, the sender and its run. */
export function senderKey(
  platform: Platform,
  epochKey: Bytes,
  h: Pick<MessageHeader, "channel" | "epoch" | "sender" | "run">,
): Bytes {
  if (!isBytes(epochKey) || epochKey.length !== 32)
    throw new RangeError("an epoch key is 32 bytes");
  const info = new Writer().label("sender").b32(h.channel).b32(h.epoch).b32(h.sender).b16(h.run);
  return platform.hkdf(epochKey, info.bytes(), 32);
}
const nonceOf = (counter: number): Bytes =>
  new Writer().raw(new Uint8Array(8)).u32(counter).bytes();

/**
 * The signed bytes of a message whose body is sealed under the sender key; the caller signs them.
 * The header lists the body's files, so the two cannot differ. The counter is the caller's: it
 * lives in memory, starts at 1 in each run and epoch, and is never used twice (crypto.md 1).
 */
export function sealMessage(
  platform: Platform,
  epochKey: Bytes,
  h: Omit<MessageHeader, "blobs">,
  body: MessageBody,
): Bytes {
  if (h.counter > MAX_COUNTER) throw new RangeError("a sender seals 100,000 messages at most");
  const header = { ...h, blobs: body.files.map((f) => f.blob) };
  const aad = encodeHeader(header);
  const ciphertext = platform.aesGcmSeal(
    senderKey(platform, epochKey, header),
    nonceOf(h.counter),
    aad,
    encodeBody(platform, body),
  );
  return encodeMessage({ header, ciphertext });
}

/**
 * Opens a message a check gave back. Any failure is `open-failed`, and says no more: the tag, a
 * body that does not read, and files that are not the header's blobs in the header's order.
 */
export function openMessage(platform: Platform, epochKey: Bytes, m: Message): Result<MessageBody> {
  if (!isBytes(epochKey) || epochKey.length !== 32) return fail("open-failed");
  const opened = platform.aesGcmOpen(
    senderKey(platform, epochKey, m.header),
    nonceOf(m.header.counter),
    encodeHeader(m.header),
    m.ciphertext,
  );
  const body = opened.ok ? decodeBody(platform, opened.value) : undefined;
  const same =
    body?.ok &&
    body.value.files.length === m.header.blobs.length &&
    body.value.files.every((f, i) => bytesEqual(f.blob, m.header.blobs[i] as Bytes));
  return same ? body : fail("open-failed");
}

const noticeName = (platform: Platform, label: LabelName, prompt: Reference): Bytes =>
  platform
    .sha256(new Writer().label(label).b32(prompt.device).b16(prompt.name).bytes())
    .slice(0, 16);

/** The name of a bot's cut notice for a prompt: a bot that says it twice says it once (SD 5.8). */
export const cutName = (platform: Platform, prompt: Reference): Bytes =>
  noticeName(platform, "cut-name", prompt);

/** The name of a bot's not-read notice for a prompt. */
export const unreadName = (platform: Platform, prompt: Reference): Bytes =>
  noticeName(platform, "unread-name", prompt);

/** The recipients of an epoch and the kinds of the devices its members' logs show active at its heads. */
interface View {
  recipients: Set<string>;
  kinds: Map<string, DeviceKeys>;
}

/** The view of `epoch`, or `undefined` when a member's log is missing or does not reach its head. */
function viewOf(
  platform: Platform,
  epoch: LoggedEpoch,
  devices: readonly (readonly LoggedEntry[])[],
): View | undefined {
  const kinds = new Map<string, DeviceKeys>();
  const twice = new Set<string>();
  for (const head of epoch.entry.deviceHeads) {
    const log = devices.find((l) => l[0] && bytesEqual(l[0].id, head.person));
    const seen = log && cut(log, head);
    if (!seen) return undefined;
    for (const [id, d] of activeDevices(platform, seen)) {
      if (kinds.has(id) && kinds.get(id)?.kind !== d.kind) twice.add(id);
      kinds.set(id, d);
    }
  }
  for (const id of twice) kinds.delete(id);
  return { recipients: new Set(epoch.entry.seals.map((s) => idKey(s.recipient))), kinds };
}

/**
 * The check of a message (security design 5.6, conditions 2 and 3, and 6.4's table), built once for
 * `epochs` and the device logs `devices`. A caller builds a new one when an epoch is added. A log
 * that grows changes no verdict, since each epoch's heads cut the logs where they were, so a caller
 * may keep one checker while the logs grow (the arrays it passed may be appended to). The epoch is one of `epochs` and of the message's channel, and each
 * member's log reaches its head; the sender is a recipient of it and a device active in its log at
 * the heads (a recovery key is none), whose signature verifies; the counter is at most 100,000; the
 * sender's kind is the one 6.4 gives the message's kind; `to` is a bot among the recipients; and
 * `re` names the sender's own message for an edit or a part, the message of `to` for a reply, and
 * another sender's for a start, an answer, a cut, a not-read notice or a request; a text may answer
 * any message, its sender's own included. An id two logs name with two kinds is no device. A message
 * belongs to the class of its channel: `space` is whether the channel is a person's space, where a
 * profile (and a name) goes and no other kind, while a conversation channel takes the rest (design 4,
 * S5). Holding the epoch's key (condition 1) is `openMessage`'s; a counter seen before (condition 4)
 * is the reader's.
 */
export function messageChecker(
  platform: Platform,
  epochs: readonly LoggedEpoch[],
  devices: readonly (readonly LoggedEntry[])[],
  space: boolean,
): (signed: Bytes, signature: Bytes) => MessageVerdict {
  const held = new Map(
    epochs.map((e) => [
      idKey(e.id),
      { channel: e.entry.channel, view: viewOf(platform, e, devices) },
    ]),
  );
  return (signed, signature) => {
    const refused = (rule: MessageRule): MessageVerdict => ({ ok: false, rule });
    const decoded = decodeMessage(signed);
    if (!decoded.ok) return refused("decode");
    const { header: h } = decoded.value;
    const epoch = held.get(idKey(h.epoch));
    if (!epoch || !bytesEqual(epoch.channel, h.channel)) return refused("epoch");
    const { view } = epoch;
    if (!view) return refused("heads");
    const device = (id: Bytes) =>
      view.recipients.has(idKey(id)) ? view.kinds.get(idKey(id)) : undefined;
    const sender = device(h.sender);
    if (!sender) return refused("sender");
    if (
      !isBytes(signature) ||
      signature.length !== 64 ||
      !platform.verify(sender.signing, signed, signature)
    )
      return refused("signature");
    if (h.counter > MAX_COUNTER) return refused("counter");
    const by = (KINDS[h.kind - 1] as readonly [number, number, string | undefined])[2];
    if (by && sender.kind !== by) return refused("kind");
    if (SPACE_KINDS.includes(h.kind) !== space) return refused("class");
    if (h.to && device(h.to)?.kind !== "bot") return refused("to");
    const own = h.kind === 10 ? h.to : h.kind === 4 || h.kind === 11 ? h.sender : undefined;
    const self = h.re && h.kind !== 1 && bytesEqual(h.re.device, h.sender);
    if (own ? !(h.re && bytesEqual(h.re.device, own)) : self) return refused("re");
    return { ok: true, value: { message: decoded.value, id: signedId(platform, signed) } };
  };
}
