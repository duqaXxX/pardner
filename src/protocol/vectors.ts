import { decode, isBytes, type Reader, Writer } from "./bytes.ts";
import {
  checkDeviceEntry,
  type DeviceEntry,
  type DeviceKeys,
  encodeDeviceEntry,
  encodeDevicePossession,
  type LoggedEntry,
  type PublicKeys,
} from "./device-log.ts";
import {
  checkEpochEntry,
  checkHistorySeal,
  decodeEpochEntry,
  type EpochEntry,
  encodeEpochEntry,
  encodeHistorySeal,
  epochCommitment,
  type LoggedEpoch,
  openEpochSeal,
  openHistorySeal,
} from "./epochs.ts";
import { openBlob, sealBlobUnderKey } from "./files.ts";
import { decodeFrame, encodeFrame, frameLength, type Side } from "./frames.ts";
import { deviceId, recoveryKeyId, relayKeyId, signedId } from "./ids.ts";
import { EXPORTER_LABEL, type LabelName, labelBytes, labelText } from "./labels.ts";
import {
  checkMemberEntry,
  decodeMemberEntry,
  encodeMemberEntry,
  isSpaceEntry,
  type LoggedMember,
  type MemberEntry,
  spaceNonce,
} from "./member-log.ts";
import {
  cutName,
  decodeBody,
  decodeHeader,
  decodeMessage,
  encodeBody,
  encodeHeader,
  encodeMessage,
  type MessageBody,
  type MessageHeader,
  messageChecker,
  openMessage,
  senderKey,
  unreadName,
} from "./messages.ts";
import type { Bytes, Platform } from "./platform.ts";
import { encodeProfile, type Profile, Profiles, readProfile } from "./profile.ts";
import {
  checkHead,
  checkProof,
  decodeHead,
  decodeProof,
  type Expect,
  encodeHead,
  encodeProof,
  type Proof,
  type ProofKind,
  runningHash,
} from "./proofs.ts";
import { createRecoveryKey, enterRecoveryKey, showRecoveryKey } from "./recovery.ts";
import type { Result } from "./result.ts";

/** The test-only constructor that puts a private key under a name (design 3.3); never part of `Platform`. */
export type ImportKey = (name: string, use: "sign" | "receive", privateKey: Bytes) => Result<Bytes>;

/** The test-only way to give a recovery its secret: a platform whose person types `secret` (design 3.3); never part of `Platform`. */
export type WithSecret = (secret: Bytes) => Platform;

/** A field of an `encoding.json` case: a type name, or `[type, ...what it holds]`. */
type Schema = string | [string, ...Schema[]];

/** The keys of a `device-entry.json` entry, in hex; a device's carry their kind. */
interface KeysJson {
  kind?: "app" | "bot";
  signing: string;
  receiving: string;
}

/** The inputs of a `device-entry.json` case: an entry, its bytes in hex. */
interface EntryJson {
  person?: string;
  seq: number;
  prev?: string;
  kind: DeviceEntry["kind"];
  signer: string;
  device?: string | KeysJson;
  recovery?: KeysJson;
  set?: string[];
  newDevice?: KeysJson;
  proof?: string;
}

/** The inputs of a `member-entry.json` case: an entry, its bytes in hex. */
interface MemberJson {
  channel?: string;
  seq: number;
  prev?: string;
  kind: MemberEntry["kind"];
  signerPerson: string;
  signerDevice: string;
  nonce?: string;
  person?: string;
  role?: string;
}

/** The inputs of an `epoch-entry.json` case: an entry, its bytes in hex. */
interface EpochJson {
  channel: string;
  seq: number;
  prev?: string;
  memberHead: { length: number; last: string };
  deviceHeads: { person: string; length: number; last: string }[];
  seals: { recipient: string; enc: string; sealed: string }[];
  commitment: string;
  signerPerson: string;
  signerDevice: string;
}

/** The inputs of a `message.json` header and body, in hex; a file's key is `fk`. */
interface HeaderJson {
  channel: string;
  counter: number;
  epoch: string;
  sender: string;
  run: string;
  incarnation: string;
  time: number;
  kind: number;
  to?: string;
  re?: { device: string; name: string };
  blobs: string[];
  name: string;
}
interface BodyJson {
  files: { blob: string; fk: string; size: number; type: string; fname: string }[];
  content: string;
}
interface AtJson {
  id: string;
  channel: string;
  recipients: string[];
  heads: { person: string; length: number; last: string }[];
}

/** One case of a vector file; the fields an `op` reads are its own. */
interface Case {
  name: string;
  op: string;
  k?: string;
  nonce?: string;
  aad?: string;
  ikm?: string;
  info?: string;
  length?: number;
  input?: string;
  output?: string;
  fails?: string;
  error?: string;
  public?: string;
  message?: string;
  signature?: string;
  valid?: boolean;
  text?: string;
  bytes?: string;
  signing?: string;
  receiving?: string;
  schema?: Schema[];
  values?: unknown[];
  log?: { bytes: string; signature: string; devices?: string }[];
  devices?: string;
  inputs?: EntryJson | MemberJson | EpochJson | HeaderJson | BodyJson;
  /** `message.json`: the epoch a `message-check` runs under. */
  at?: AtJson;
  /** `message-check`: whether the channel is a person's space; a case that leaves it out is a conversation channel. */
  space?: boolean;
  rule?: string;
  /** `epoch-entry.json`: the persons whose device logs the check reads, and the seals to open. */
  persons?: string[];
  opens?: { recipient: string; sk?: string; k?: string; fails?: string }[];
  /** `history-seal.json`: the epoch's own entry in hex, and the recipient's private key. */
  epoch?: string;
  sk?: string;
  channel?: string;
  prev?: string;
  /** `recovery.json`: the secret, the two HKDF outputs, the two private scalars; `blob.json`: the blob's id. */
  s?: string;
  ikmSign?: string;
  ikmReceive?: string;
  skSigning?: string;
  skReceiving?: string;
  id?: string;
  /** `proofs.json`, `frames.json`, `chain.json`: a proof's kind, its signatures, the key of the first, what the checker holds, the items, whether a frame follows a proof. */
  proofKind?: string;
  signatures?: string[];
  signer?: KeysJson;
  expect?: unknown;
  items?: string[];
  proven?: boolean;
  /** `frames.json`: the side that reads the frame. */
  reader?: string;
}

export interface VectorFile {
  structure: string;
  /** `member-entry.json`: device logs by name, which a case or a log entry of it names. */
  deviceLogs?: Record<string, { bytes: string; signature: string }[]>;
  /** `epoch-entry.json`: the channel's member log, each entry with the device log of its signer. */
  memberLog?: { bytes: string; signature: string; devices: string }[];
  cases: Case[];
}

const fromHex = (hex = ""): Bytes => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const toHex = (bytes: Bytes): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const idOf = (item: unknown[], schema: Schema[]): Bytes => {
  const w = new Writer();
  put(w, schema[0] as Schema, item[0]);
  return w.bytes();
};

function put(w: Writer, field: Schema, value: unknown): void {
  const [type, ...inner] = typeof field === "string" ? [field] : field;
  const each = (x: Writer, item: unknown) => put(x, inner[0] as Schema, item);
  switch (type) {
    case "label":
      w.label(inner[0] as LabelName);
      break;
    case "u8":
    case "u16":
    case "u32":
    case "u64":
      w[type](value as number);
      break;
    case "b16":
    case "b32":
    case "pk":
    case "sig":
      w[type](fromHex(value as string));
      break;
    case "var":
      w.var(fromHex(value as string));
      break;
    case "opt":
      w.opt(value === null ? undefined : value, each);
      break;
    case "list":
      w.list(value as unknown[], each);
      break;
    case "set":
      w.set(
        value as unknown[][],
        (e) => idOf(e, inner),
        (x, e) => {
          for (const [i, f] of inner.entries()) put(x, f, e[i]);
        },
      );
      break;
    default:
      throw new TypeError(`unknown type ${type}`);
  }
}

function take(r: Reader, field: Schema): unknown {
  const [type, ...inner] = typeof field === "string" ? [field] : field;
  const item = (x: Reader) => take(x, inner[0] as Schema);
  switch (type) {
    case "label":
      r.label(inner[0] as LabelName);
      return null;
    case "u8":
    case "u16":
    case "u32":
    case "u64":
      return r[type]();
    case "b16":
    case "b32":
    case "pk":
    case "sig":
    case "var":
      return toHex(r[type]());
    case "opt":
      return r.opt(item) ?? null;
    case "list":
      return r.list(item);
    case "set": {
      const row = (x: Reader) => inner.map((f) => take(x, f));
      return r.set(row, (e) => idOf(e, inner));
    }
    default:
      throw new TypeError(`unknown type ${type}`);
  }
}

/** The bytes an `encoding.json` case's values encode to. */
function encodeValues(c: Case): string {
  const w = new Writer();
  for (const [i, f] of (c.schema ?? []).entries()) put(w, f, (c.values ?? [])[i]);
  return toHex(w.bytes());
}

/** An `encoding.json` case: the values encode to the bytes, which decode to the same values. */
function roundtrip(c: Case): string {
  const schema = c.schema ?? [];
  if (c.fails === "throws") return `taken ${encodeValues(c)}`; // reaching here means nothing threw
  const decoded = decode(fromHex(c.bytes), (r) => schema.map((f) => take(r, f)));
  if (!decoded.ok) return `error:${decoded.error === "bad-input" ? "decode" : decoded.error}`;
  if (c.fails !== undefined) return "decoded";
  const same = JSON.stringify(decoded.value) === JSON.stringify(c.values);
  return same ? encodeValues(c) : "differs";
}

const keysOf = (j: KeysJson): PublicKeys => ({
  signing: fromHex(j.signing),
  receiving: fromHex(j.receiving),
});
function deviceOf(j: KeysJson): DeviceKeys {
  if (j.kind !== "app" && j.kind !== "bot") throw new TypeError("a device is an app or a bot");
  return { kind: j.kind, ...keysOf(j) };
}

/** The entry a `device-entry.json` case's inputs describe. */
function entryOf(j: EntryJson): DeviceEntry {
  const head = {
    person: j.person === undefined ? undefined : fromHex(j.person),
    seq: j.seq,
    prev: j.prev === undefined ? undefined : fromHex(j.prev),
    signer: fromHex(j.signer),
  };
  const device = j.device as KeysJson;
  switch (j.kind) {
    case "genesis":
      return {
        ...head,
        kind: j.kind,
        device: deviceOf(device),
        recovery: keysOf(j.recovery as KeysJson),
      };
    case "add":
      return { ...head, kind: j.kind, device: deviceOf(device), proof: fromHex(j.proof as string) };
    case "remove":
      return { ...head, kind: j.kind, device: fromHex(j.device as string) };
    case "reset":
      return {
        ...head,
        kind: j.kind,
        set: (j.set ?? []).map((id) => fromHex(id)),
        newDevice: j.newDevice && {
          device: deviceOf(j.newDevice),
          proof: fromHex(j.proof as string),
        },
        recovery: j.recovery && keysOf(j.recovery),
      };
    default:
      throw new TypeError("unknown entry kind");
  }
}

/** A `device-entry.json` case: its log replays, then the entry is checked, encoded both ways and given its id. */
function deviceEntry(p: Platform, c: Case): string {
  const log: LoggedEntry[] = [];
  for (const held of c.log ?? []) {
    const done = checkDeviceEntry(p, log, fromHex(held.bytes), fromHex(held.signature));
    if (!done.ok) return `the log's own entry fails: ${done.rule}`;
    log.push(done.value);
  }
  const verdict = checkDeviceEntry(p, log, fromHex(c.bytes), fromHex(c.signature));
  if (!verdict.ok)
    return verdict.rule === "decode" ? "error:decode" : `error:check:${verdict.rule}`;
  const written = c.inputs ? toHex(encodeDeviceEntry(entryOf(c.inputs as EntryJson))) : c.bytes;
  const again = toHex(encodeDeviceEntry(verdict.value.entry));
  return written === c.bytes && again === c.bytes ? toHex(verdict.value.id) : "differs";
}

/** A `device-entry.json` case of the bytes a new device signs: the person id and the device in the inputs. */
function devicePossession(c: Case): string {
  const { person, device } = c.inputs as { person: string; device: KeysJson };
  return toHex(encodeDevicePossession(fromHex(person), deviceOf(device)));
}

/** The entry a `member-entry.json` case's inputs describe. */
function memberOf(j: MemberJson): MemberEntry {
  const head = {
    channel: j.channel === undefined ? undefined : fromHex(j.channel),
    seq: j.seq,
    prev: j.prev === undefined ? undefined : fromHex(j.prev),
    signerPerson: fromHex(j.signerPerson),
    signerDevice: fromHex(j.signerDevice),
  };
  const field = (hex: string | undefined): Bytes => {
    if (hex === undefined) throw new TypeError("a case lacks a field its kind needs");
    return fromHex(hex);
  };
  switch (j.kind) {
    case "create":
      return { ...head, kind: j.kind, nonce: field(j.nonce) };
    case "accept":
      return { ...head, kind: j.kind };
    case "remove":
      return { ...head, kind: j.kind, person: field(j.person) };
    case "add":
    case "role":
      if (j.role !== "member" && j.role !== "admin")
        throw new TypeError("a role is member or admin");
      return { ...head, kind: j.kind, person: field(j.person), role: j.role };
    default:
      throw new TypeError("unknown entry kind");
  }
}

/** The checked entries of the device log a case names; none when it names none. */
const replayed = new WeakMap<Platform, WeakMap<VectorFile, Map<string, unknown>>>();
/** What `make` replays for a file, once for each platform: another platform may refuse what this one took. */
const cached = <T>(p: Platform, file: VectorFile, key: string, make: () => T): T => {
  const byFile = replayed.get(p) ?? new WeakMap();
  replayed.set(p, byFile);
  const held = byFile.get(file) ?? new Map();
  byFile.set(file, held);
  if (!held.has(key)) held.set(key, make());
  return held.get(key) as T;
};

const deviceLogOf = (p: Platform, file: VectorFile, name: string | undefined): LoggedEntry[] =>
  cached(p, file, `device ${name}`, () => {
    const held = name === undefined ? [] : file.deviceLogs?.[name];
    if (held === undefined) throw new TypeError(`no device log ${name} in the file`);
    const log: LoggedEntry[] = [];
    for (const { bytes, signature } of held) {
      const done = checkDeviceEntry(p, log, fromHex(bytes), fromHex(signature));
      if (!done.ok) throw new TypeError(`the device log ${name} fails: ${done.rule}`);
      log.push(done.value);
    }
    return log;
  });

/** A `member-entry.json` case: its log replays, then the entry is checked, encoded both ways and given its id. */
function memberEntry(p: Platform, file: VectorFile, c: Case): string {
  const log: LoggedMember[] = [];
  for (const held of c.log ?? []) {
    const devices = deviceLogOf(p, file, held.devices);
    const done = checkMemberEntry(p, log, fromHex(held.bytes), fromHex(held.signature), devices);
    if (!done.ok) return `the log's own entry fails: ${done.rule}`;
    log.push(done.value);
  }
  const devices = deviceLogOf(p, file, c.devices);
  const verdict = checkMemberEntry(p, log, fromHex(c.bytes), fromHex(c.signature), devices);
  if (!verdict.ok)
    return verdict.rule === "decode" ? "error:decode" : `error:check:${verdict.rule}`;
  const written = c.inputs ? toHex(encodeMemberEntry(memberOf(c.inputs as MemberJson))) : c.bytes;
  const again = toHex(encodeMemberEntry(verdict.value.entry));
  return written === c.bytes && again === c.bytes ? toHex(verdict.value.id) : "differs";
}

/** The checked member log of an epoch file; an entry that fails is a fault of the file. */
const memberLogOf = (p: Platform, file: VectorFile): LoggedMember[] =>
  cached(p, file, "members", () => replayMembers(p, file));

function replayMembers(p: Platform, file: VectorFile): LoggedMember[] {
  if (file.memberLog === undefined) throw new TypeError("no member log in the file");
  const log: LoggedMember[] = [];
  for (const { bytes, signature, devices } of file.memberLog) {
    const done = checkMemberEntry(
      p,
      log,
      fromHex(bytes),
      fromHex(signature),
      deviceLogOf(p, file, devices),
    );
    if (!done.ok) throw new TypeError(`the member log fails: ${done.rule}`);
    log.push(done.value);
  }
  return log;
}

const epochOf = (j: EpochJson): EpochEntry => ({
  channel: fromHex(j.channel),
  seq: j.seq,
  prev: j.prev === undefined ? undefined : fromHex(j.prev),
  memberHead: { length: j.memberHead.length, last: fromHex(j.memberHead.last) },
  deviceHeads: j.deviceHeads.map((h) => ({
    person: fromHex(h.person),
    length: h.length,
    last: fromHex(h.last),
  })),
  seals: j.seals.map((s) => ({
    recipient: fromHex(s.recipient),
    enc: fromHex(s.enc),
    sealed: fromHex(s.sealed),
  })),
  commitment: fromHex(j.commitment),
  signerPerson: fromHex(j.signerPerson),
  signerDevice: fromHex(j.signerDevice),
});

/** What `open` gives when the private key `sk` is imported under a name, which is dropped after it. */
function opening(
  p: Platform,
  importKey: ImportKey | undefined,
  sk: string | undefined,
  open: (name: string) => Result<Bytes>,
): string {
  if (!importKey || sk === undefined)
    throw new TypeError("a seal needs its private key and an import function");
  if (!importKey("vector.receive", "receive", fromHex(sk)).ok)
    throw new TypeError("the private key does not import");
  try {
    const opened = open("vector.receive");
    return opened.ok ? toHex(opened.value) : `error:${opened.error}`;
  } finally {
    p.deleteKey("vector.receive");
  }
}

/** An `epoch-entry.json` case: the logs replay, the entry is checked, encoded both ways, its seals opened, and given its id. */
function epochEntry(
  p: Platform,
  file: VectorFile,
  c: Case,
  importKey: ImportKey | undefined,
): string {
  const members = memberLogOf(p, file);
  const devices = (c.persons ?? []).map((name) => deviceLogOf(p, file, name));
  const epochs: LoggedEpoch[] = [];
  for (const held of c.log ?? []) {
    const done = checkEpochEntry(
      p,
      epochs,
      members,
      devices,
      fromHex(held.bytes),
      fromHex(held.signature),
    );
    if (!done.ok) return `the log's own entry fails: ${done.rule}`;
    epochs.push(done.value);
  }
  const verdict = checkEpochEntry(
    p,
    epochs,
    members,
    devices,
    fromHex(c.bytes),
    fromHex(c.signature),
  );
  if (!verdict.ok)
    return verdict.rule === "decode" ? "error:decode" : `error:check:${verdict.rule}`;
  const written = c.inputs ? toHex(encodeEpochEntry(epochOf(c.inputs as EpochJson))) : c.bytes;
  if (written !== c.bytes || toHex(encodeEpochEntry(verdict.value.entry)) !== c.bytes)
    return "differs";
  for (const o of c.opens ?? []) {
    const got = opening(p, importKey, o.sk, (name) =>
      openEpochSeal(p, name, verdict.value, fromHex(o.recipient)),
    );
    if (got !== (o.fails === undefined ? o.k : `error:${o.fails}`))
      return `the seal of ${o.recipient} opens otherwise`; // never `got`: it may be a key
  }
  return toHex(verdict.value.id);
}

/** A `history-seal.json` case: the seal is checked against its maker's device log, encoded both ways, and opened for its epoch. */
function historySeal(
  p: Platform,
  file: VectorFile,
  c: Case,
  importKey: ImportKey | undefined,
): string {
  const epoch = c.epoch === undefined ? undefined : decodeEpochEntry(fromHex(c.epoch));
  if (c.epoch === undefined || !epoch?.ok) throw new TypeError("the case's epoch does not decode");
  const logged = { entry: epoch.value, id: signedId(p, fromHex(c.epoch)) };
  const devices = deviceLogOf(p, file, c.devices);
  const verdict = checkHistorySeal(p, devices, fromHex(c.bytes), fromHex(c.signature));
  if (!verdict.ok)
    return verdict.rule === "decode" ? "error:decode" : `error:check:${verdict.rule}`;
  if (toHex(encodeHistorySeal(verdict.value)) !== c.bytes) return "differs";
  return opening(p, importKey, c.sk, (name) =>
    openHistorySeal(p, name, devices, fromHex(c.bytes), fromHex(c.signature), logged),
  );
}

/** A field a case names, in hex; a file that lacks it is at fault. */
function given(hex: string | undefined): Bytes {
  if (hex === undefined) throw new TypeError("a case lacks a field its kind needs");
  return fromHex(hex);
}

/**
 * A `recovery.json` case: the secret gives the two HKDF outputs, an engine that is given the secret
 * derives the two public keys, each private scalar of the file belongs to its public key on this
 * engine, and the id comes out.
 */
function recovery(
  p: Platform,
  c: Case,
  importKey: ImportKey | undefined,
  withSecret: WithSecret | undefined,
): string {
  if (!importKey || !withSecret)
    throw new TypeError("a recovery needs an import function and a way to give a secret");
  const secret = given(c.s);
  const ikm = (label: "recovery-signing" | "recovery-receiving") =>
    toHex(p.hkdf(secret, labelBytes(label), 32));
  if (ikm("recovery-signing") !== toHex(given(c.ikmSign))) return "hkdf output differs";
  if (ikm("recovery-receiving") !== toHex(given(c.ikmReceive))) return "hkdf output differs";
  const entered = enterRecoveryKey(withSecret(secret.slice()), "vector.recovery"); // the platform erases what it is given
  if (!entered.ok) return `error:${entered.error}`;
  const { signing, receiving, id } = entered.value;
  if (toHex(signing) !== c.signing || toHex(receiving) !== c.receiving) return "public keys differ";
  const a = importKey("vector.sign", "sign", given(c.skSigning));
  const b = importKey("vector.receive", "receive", given(c.skReceiving));
  if (!a.ok || !b.ok) throw new TypeError("a private scalar does not import");
  if (toHex(a.value) !== c.signing || toHex(b.value) !== c.receiving)
    return "private scalar differs";
  return toHex(id);
}

/**
 * What a platform does with a recovery, on each engine: `holds` (a created key holds no private key
 * and its secret is shown once, or erased by `deleteKey`; an entered one holds both pairs for
 * their use until `deleteKey`), `same-info` and `taken` (refused).
 */
function recoveryBehaviour(c: Case, withSecret: WithSecret | undefined): string {
  if (!withSecret) throw new TypeError("a recovery needs a way to give a secret");
  const w = withSecret(given(c.s));
  const [signInfo, receiveInfo] = [
    labelBytes("recovery-signing"),
    labelBytes("recovery-receiving"),
  ];
  const refusal = (r: { ok: boolean; error?: string }) => (r.ok ? "taken" : `error:${r.error}`);
  switch (c.op) {
    case "recovery-same-info":
      return [w.createRecovery, w.enterRecovery]
        .map((call) => refusal(call.call(w, "vector.recovery", signInfo, signInfo.slice())))
        .reduce((both, one) => (both === one ? one : `${both}/${one}`));
    case "recovery-taken": {
      w.makeKeyPair("vector.recovery.receive", "receive");
      const refused = w.enterRecovery("vector.recovery", signInfo, receiveInfo);
      return !refused.ok && w.publicKey("vector.recovery.sign").ok ? "held" : refusal(refused);
    }
    default: {
      const noKey = (name: string) => !w.publicKey(name).ok && !w.sign(name, signInfo).ok;
      if (!createRecoveryKey(w, "vector.recovery").ok) return "create failed";
      if (!noKey("vector.recovery.sign") || !noKey("vector.recovery.receive"))
        return "created holds";
      if (showRecoveryKey(w, "vector.unmade", "sheet").ok) return "shown without a secret";
      if (createRecoveryKey(w, "vector.recovery").ok) return "created twice";
      if (!showRecoveryKey(w, "vector.recovery", "sheet").ok) return "show failed";
      if (showRecoveryKey(w, "vector.recovery", "sheet").ok) return "shown twice";
      if (!createRecoveryKey(w, "vector.recovery").ok) return "create after show failed";
      if (w.enterRecovery("vector.recovery", signInfo, receiveInfo).ok)
        return "entered over a secret";
      if (w.showRecovery("vector.recovery", undefined as never).ok) return "shown without context";
      if (createRecoveryKey(w, "vector.recovery").ok) return "context wiped the secret";
      if (!w.deleteKey("vector.recovery").ok) return "delete of a secret failed"; // never shown: erased
      if (!w.deleteKey("vector.never").ok) return "delete of nothing failed"; // a name never made
      if (!createRecoveryKey(w, "vector.held").ok) return "create failed";
      if (w.makeKeyPair("vector.held", "sign").ok) return "made over a secret";
      if (!createRecoveryKey(w, "vector.held.sign").ok) return "create failed";
      if (w.enterRecovery("vector.held", signInfo, receiveInfo).ok)
        return "entered over a secret name";
      if (!w.deleteKey("vector.held").ok || !w.deleteKey("vector.held.sign").ok)
        return "delete of a secret failed";
      if (!w.makeKeyPair("vector.bare", "sign").ok) return "make failed";
      if (createRecoveryKey(w, "vector.bare").ok) return "created over a key";
      if (w.enterRecovery("vector.bare", signInfo, receiveInfo).ok) return "entered over a key";
      if (!w.publicKey("vector.bare").ok) return "key lost to a refusal";
      w.deleteKey("vector.bare");
      if (showRecoveryKey(w, "vector.recovery", "sheet").ok) return "deleted secret shown";
      if (!enterRecoveryKey(w, "vector.recovery").ok) return "enter failed";
      if (
        !w.sign("vector.recovery.sign", signInfo).ok ||
        !w.publicKey("vector.recovery.receive").ok
      )
        return "enter holds nothing";
      w.deleteKey("vector.recovery.sign");
      w.deleteKey("vector.recovery.receive");
      return noKey("vector.recovery.sign") && noKey("vector.recovery.receive") ? "held" : "kept";
    }
  }
}

/** A `blob.json` case: the file seals to the blob and its id, and the blob opens back to the file. */
function blob(p: Platform, c: Case): string {
  const [fileKey, file, id] = [given(c.k), given(c.input), given(c.id)];
  const sealed = sealBlobUnderKey(p, fileKey, file);
  const opened = openBlob(p, sealed.id, fileKey, sealed.blob);
  if (toHex(sealed.id) !== toHex(id)) return "id differs";
  return opened.ok && toHex(opened.value) === toHex(file) ? toHex(sealed.blob) : "differs";
}

const answer = (r: Result<Bytes>) => (r.ok ? toHex(r.value) : `error:${r.error}`);
const maybe = (hex: string | undefined) => (hex === undefined ? undefined : fromHex(hex));

/** The header a `message.json` case's inputs describe, and its body's. */
const headerOf = (j: HeaderJson): MessageHeader => ({
  ...j,
  channel: fromHex(j.channel),
  epoch: fromHex(j.epoch),
  sender: fromHex(j.sender),
  run: fromHex(j.run),
  incarnation: fromHex(j.incarnation),
  to: maybe(j.to),
  re: j.re && { device: fromHex(j.re.device), name: fromHex(j.re.name) },
  blobs: j.blobs.map((b) => fromHex(b)),
  name: fromHex(j.name),
});
const bodyOf = (j: BodyJson): MessageBody => ({
  content: j.content,
  files: j.files.map((f) => ({
    ...f,
    blob: fromHex(f.blob),
    fileKey: fromHex(f.fk),
    name: f.fname,
  })),
});

/**
 * A `message.json` case: a header or a body reads and writes back to its bytes, and encodes from
 * its inputs; a message does the same, has the id `c.id` and opens under `c.k`; `message-check`
 * runs the checker with the device logs `c.persons` name and a stand-in for the epoch (the
 * checker reads its id, channel, recipients and heads); a notice's name comes from the prompt's
 * sender (`c.input`) and name (`c.id`); a sender key from `c.k` and `c.bytes` (channel, epoch, sender, run).
 */
function messageCase(p: Platform, file: VectorFile, c: Case): string {
  const bytes = fromHex(c.bytes);
  const prompt = { device: fromHex(c.input), name: fromHex(c.id) };
  const written = (r: Result<Bytes>, inputs: Bytes | undefined) =>
    inputs && toHex(inputs) !== c.bytes ? "differs" : answer(r);
  switch (c.op) {
    case "message-header": {
      const h = decodeHeader(bytes);
      const inputs = c.inputs && encodeHeader(headerOf(c.inputs as HeaderJson));
      return written(h.ok ? { ok: true, value: encodeHeader(h.value) } : h, inputs);
    }
    case "message-body": {
      const b = decodeBody(p, bytes);
      const inputs = c.inputs && encodeBody(p, bodyOf(c.inputs as BodyJson));
      return written(b.ok ? { ok: true, value: encodeBody(p, b.value) } : b, inputs);
    }
    case "cut-name":
      return toHex(cutName(p, prompt));
    case "unread-name":
      return toHex(unreadName(p, prompt));
    case "sender-key": {
      const [channel, epoch, sender, run] = [0, 32, 64, 96].map((at, i) =>
        bytes.slice(at, at + (i === 3 ? 16 : 32)),
      );
      return toHex(senderKey(p, given(c.k), { channel, epoch, sender, run } as MessageHeader));
    }
    case "message-check": {
      const at = c.at as AtJson;
      const epoch = {
        id: fromHex(at.id),
        entry: {
          channel: fromHex(at.channel),
          deviceHeads: at.heads.map((h) => ({
            ...h,
            person: fromHex(h.person),
            last: fromHex(h.last),
          })),
          seals: at.recipients.map((r) => ({ recipient: fromHex(r) })),
        },
      } as unknown as LoggedEpoch;
      const logs = (c.persons ?? []).map((name) => deviceLogOf(p, file, name));
      const v = messageChecker(p, [epoch], logs, c.space === true)(bytes, fromHex(c.signature));
      if (v.ok) return toHex(v.value.id);
      return v.rule === "decode" ? "error:decode" : `error:check:${v.rule}`;
    }
    default: {
      const m = decodeMessage(bytes);
      if (!m.ok) return `error:${m.error}`;
      if (toHex(encodeMessage(m.value)) !== c.bytes) return "differs";
      if (toHex(signedId(p, bytes)) !== c.id) return "id differs";
      const body = openMessage(p, given(c.k), m.value);
      return answer(body.ok ? { ok: true, value: encodeBody(p, body.value) } : body);
    }
  }
}

/** A proof, head or frame as a vector writes it: bytes in hex, so every string but a `kind` or a `type` is bytes. */
const fromJson = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (k, v) =>
    typeof v === "string" && k !== "kind" && k !== "type" ? fromHex(v) : v,
  );
const toJson = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (isBytes(v) ? toHex(v) : v));

/**
 * Decodes the case's bytes, checks the decoding against the inputs the case gives and the inputs
 * against the bytes, then answers with what `then` makes of the value and the bytes.
 */
function structure<T>(
  c: Case,
  read: (bytes: Bytes) => Result<T>,
  write: (v: T) => Bytes,
  then: (v: T, bytes: string) => string,
): string {
  const decoded = read(fromHex(c.bytes));
  if (!decoded.ok) return "error:decode";
  const bytes = c.bytes ?? "";
  const same =
    toHex(write(decoded.value)) === bytes &&
    (c.inputs === undefined ||
      (toJson(decoded.value) === JSON.stringify(c.inputs) &&
        toHex(write(fromJson(c.inputs) as T)) === bytes));
  return same ? then(decoded.value, bytes) : "differs";
}

/** A `profile-shown` case's message: its place, kind, sender and name (hex), content, and how many files it lists. */
interface ShownJson {
  position: number;
  kind: number;
  sender: string;
  name: string;
  content: string;
  files?: number;
}

/**
 * A `profile.json` case: `profile-read` reads `c.text` and writes the profile back; `profile-encode`
 * writes `c.inputs` (its icon in hex); `profile-shown` hands `c.values` to a `Profiles` in their
 * order and names the profile shown for the bot `c.text`, or "none".
 */
function profileCase(c: Case): string {
  switch (c.op) {
    case "profile-read": {
      const r = readProfile(c.text ?? "");
      return r.ok ? encodeProfile(r.value) : `error:${r.error}`;
    }
    case "profile-encode": {
      const j = c.inputs as unknown as Omit<Profile, "icon"> & { icon?: string };
      return encodeProfile({ ...j, icon: maybe(j.icon) });
    }
    default: {
      const profiles = new Profiles();
      for (const m of (c.values ?? []) as ShownJson[])
        profiles.take(
          m.position,
          {
            kind: m.kind,
            sender: fromHex(m.sender),
            name: fromHex(m.name),
            blobs: Array.from({ length: m.files ?? 0 }, (_, i) => new Uint8Array(32).fill(i)),
          },
          m.content,
        );
      return profiles.of(fromHex(c.text))?.name ?? "none";
    }
  }
}

function outcome(
  p: Platform,
  file: VectorFile,
  c: Case,
  importKey?: ImportKey,
  withSecret?: WithSecret,
): string {
  const hex = [c.k, c.nonce, c.aad, c.input].map((h) => fromHex(h));
  const [key, nonce, aad, input] = hex as [Bytes, Bytes, Bytes, Bytes];
  const info = fromHex(c.info);
  const refusal = (r: { ok: boolean; error?: string }) => (r.ok ? "taken" : `error:${r.error}`);
  switch (c.op) {
    case "roundtrip":
      return roundtrip(c);
    case "encode":
      return encodeValues(c);
    case "device-entry":
      return deviceEntry(p, c);
    case "device-possession":
      return devicePossession(c);
    case "member-entry":
      return memberEntry(p, file, c);
    case "epoch-entry":
      return epochEntry(p, file, c, importKey);
    case "history-seal":
      return historySeal(p, file, c, importKey);
    case "recovery":
      return recovery(p, c, importKey, withSecret);
    case "recovery-holds":
    case "recovery-same-info":
    case "recovery-taken":
      return recoveryBehaviour(c, withSecret);
    case "blob":
      return blob(p, c);
    case "message-header":
    case "message-body":
    case "message":
    case "message-check":
    case "sender-key":
    case "cut-name":
    case "unread-name":
      return messageCase(p, file, c);
    case "profile-read":
    case "profile-encode":
    case "profile-shown":
      return profileCase(c);
    case "blob-open": {
      const opened = openBlob(p, given(c.id), key, input);
      return opened.ok ? toHex(opened.value) : `error:${opened.error}`;
    }
    case "epoch-commitment":
      return toHex(
        epochCommitment(
          p,
          fromHex(c.channel),
          c.prev === undefined ? undefined : fromHex(c.prev),
          fromHex(c.k),
        ),
      );
    case "proof": {
      const signatures = (c.signatures ?? []).map(fromHex);
      const signer = c.signer && keysOf(c.signer);
      return structure(
        c,
        (b) => decodeProof(b, c.proofKind as ProofKind),
        encodeProof,
        (proof, bytes) => {
          const v = checkProof(p, proof, signatures, fromJson(c.expect) as Expect, signer);
          return v.ok ? bytes : `error:check:${v.rule}`;
        },
      );
    }
    case "proof-encode": // an encode that must throw is a case with `fails: "throws"`
      return toHex(encodeProof(fromJson(c.inputs) as Proof));
    case "head":
      return structure(c, decodeHead, encodeHead, (head, bytes) =>
        checkHead(p, fromHex(c.public), head, fromHex(c.signature)) ? bytes : "error:check:head",
      );
    case "frame": {
      const proven = c.proven ?? true; // false: before a proof
      return structure(
        c,
        (b) => decodeFrame(b, proven, c.reader as Side),
        (f) => encodeFrame(f, proven),
        (_f, bytes) => bytes,
      );
    }
    case "frame-length": {
      const length = frameLength(fromHex(c.bytes), c.proven ?? true);
      return length.ok ? String(length.value) : "error:decode";
    }
    case "chain":
      return toHex(
        runningHash(
          p,
          (c.items ?? []).map((i) => signedId(p, fromHex(i))),
        ),
      );
    case "space-nonce":
      return toHex(spaceNonce(p, fromHex(c.input)));
    case "space-class": {
      const e = decodeMemberEntry(fromHex(c.bytes));
      return e.ok && isSpaceEntry(p, e.value) ? "space" : "conversation";
    }
    case "label":
      return labelText(c.name as LabelName) === c.text
        ? toHex(labelBytes(c.name as LabelName))
        : "text differs";
    case "exporter-label":
      return EXPORTER_LABEL === c.text ? toHex(p.utf8Encode(EXPORTER_LABEL)) : "text differs";
    case "device-id":
      return toHex(deviceId(p, fromHex(c.signing), fromHex(c.receiving)));
    case "recovery-id":
      return toHex(recoveryKeyId(p, fromHex(c.signing), fromHex(c.receiving)));
    case "relay-id":
      return toHex(relayKeyId(p, fromHex(c.public)));
    case "signed-id":
      return toHex(signedId(p, fromHex(c.bytes)));
    case "sha256":
      return toHex(p.sha256(input));
    case "hkdf":
      return toHex(p.hkdf(fromHex(c.ikm), info, c.length ?? 0));
    case "aes-seal":
      return toHex(p.aesGcmSeal(key, nonce, aad, input));
    case "aes-open":
      return answer(p.aesGcmOpen(key, nonce, aad, input));
    case "verify":
      return String(p.verify(fromHex(c.public), fromHex(c.message), fromHex(c.signature)));
    case "utf8": {
      const decoded = p.utf8Decode(fromHex(c.bytes));
      return `${toHex(p.utf8Encode(c.text ?? ""))}/${decoded.ok ? decoded.value : ""}`;
    }
    case "utf8-refuses":
      return p.utf8Decode(fromHex(c.bytes)).ok ? "decoded" : "refused";
    case "sign-roundtrip": {
      const made = p.makeKeyPair("vector.sign", "sign");
      const signature = p.sign("vector.sign", fromHex(c.message));
      return made.ok && signature.ok && p.verify(made.value, fromHex(c.message), signature.value)
        ? "verified"
        : "failed";
    }
    case "hpke-seal-refuses":
      return refusal(p.hpkeSeal(fromHex(c.public), info, aad, input));
    case "hpke-open-refuses": {
      p.makeKeyPair("vector.receive", "receive");
      const opened = p.hpkeOpen(
        "vector.receive",
        fromHex(c.bytes),
        info,
        aad,
        c.input === undefined ? new Uint8Array(32) : input,
      );
      return answer(opened);
    }
    case "make-key-refuses": {
      p.makeKeyPair("vector.other", "sign"); // the name is taken, so the use is what is refused
      return refusal(p.makeKeyPair("vector.other", c.text as "sign"));
    }
    case "not-bytes": {
      const call = (p as unknown as Record<string, (...args: unknown[]) => unknown>)[c.text ?? ""];
      return String(call?.(5, 5, 5, 5, 5));
    }
    case "hpke-roundtrip": {
      const made = p.makeKeyPair("vector.receive", "receive");
      const sealed = made.ok ? p.hpkeSeal(made.value, info, aad, input) : made;
      if (!sealed.ok) return `error:${sealed.error}`;
      const { enc, sealed: box } = sealed.value;
      const right = p.hpkeOpen("vector.receive", enc, info, aad, box);
      const wrong = p.hpkeOpen("vector.receive", enc, fromHex("00"), aad, box);
      return right.ok && toHex(right.value) === c.input && !wrong.ok ? "opened" : "failed";
    }
    default:
      return `unknown op ${c.op}`;
  }
}

function expected(c: Case): string {
  if (c.fails === "throws") return c.error === undefined ? "throws" : `throws:${c.error}`;
  if (c.fails === "check") return `error:check:${c.rule}`;
  if (c.fails !== undefined) return `error:${c.fails}`;
  switch (c.op) {
    case "verify":
      return String(c.valid);
    case "utf8":
      return `${c.bytes}/${c.text}`;
    case "utf8-refuses":
      return "refused";
    case "sign-roundtrip":
      return "verified";
    case "hpke-roundtrip":
      return "opened";
    case "roundtrip":
      return c.bytes ?? "";
    default:
      return c.output ?? "";
  }
}

/** The ops that make platform keys, which are deleted after them. */
const KEYED = [
  "sign-roundtrip",
  "hpke-open-refuses",
  "make-key-refuses",
  "hpke-roundtrip",
  "recovery",
];

/** The structures a vector file may name. */
const STRUCTURES = [
  "platform",
  "encoding",
  "labels",
  "ids",
  "device-entry",
  "member-entry",
  "epoch-entry",
  "history-seal",
  "recovery",
  "blob",
  "message",
  "proofs",
  "frames",
  "chain",
  "profile",
  "space",
];

/**
 * Runs a parsed vector file against a platform; returns the names of the cases that failed. A
 * case that opens a seal needs `importKey`, the platform's test-only constructor, and a recovery
 * case `withSecret` beside it.
 */
export function runVectors(
  platform: Platform,
  file: VectorFile,
  importKey?: ImportKey,
  withSecret?: WithSecret,
): string[] {
  if (!STRUCTURES.includes(file.structure)) return [`unknown structure ${file.structure}`];
  return file.cases
    .filter((c) => {
      let got: string;
      try {
        got = outcome(platform, file, c, importKey, withSecret);
      } catch (error) {
        // a fault of the caller's input, which the case may expect, by its kind
        got = c.error === undefined ? "throws" : `throws:${(error as { name?: string }).name}`;
      } finally {
        if (KEYED.includes(c.op))
          for (const name of ["vector.sign", "vector.receive", "vector.other"])
            platform.deleteKey(name);
      }
      return got !== expected(c);
    })
    .map((c) => c.name);
}
