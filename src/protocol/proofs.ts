import { bytesEqual, decode, isBytes, type Reader, Writer } from "./bytes.ts";
import { type DeviceKeys, type PublicKeys, readDevice, writeDevice } from "./device-log.ts";
import { deviceId, recoveryKeyId, relayKeyId } from "./ids.ts";
import type { LabelName } from "./labels.ts";
import type { Bytes, Platform } from "./platform.ts";
import { fail, type Result } from "./result.ts";

/** The relay's head (design 6.6): the running hash of its first `n` items, which its key signs. */
export type RelayHead = { relay: Bytes; n: number; chain: Bytes };

/** What every proof binds: the relay's key id, both nonces and the TLS session's exported binding. */
export type Session = { relay: Bytes; deviceNonce: Bytes; relayNonce: Bytes; binding: Bytes };

/** A proof of design 6.6; `kind` names its label. A recovery proof's `recovery` is the key's id. */
export type Proof = Session &
  (
    | { kind: "active"; person: Bytes; device: Bytes }
    | { kind: "recovery"; person: Bytes; recovery: Bytes; newDevice: DeviceKeys }
    | { kind: "upload"; device: DeviceKeys; head: RelayHead }
  );
export type ProofKind = Proof["kind"];

const LABELS: Record<ProofKind, LabelName> = {
  active: "proof-active",
  recovery: "proof-recovery",
  upload: "proof-upload",
};

/** `head`: label, the relay's id, `n` and the running hash. */
export const writeHead = (w: Writer, h: RelayHead): Writer =>
  w.label("relay-head").b32(h.relay).u64(h.n).b32(h.chain);
export const readHead = (r: Reader): RelayHead => {
  r.label("relay-head");
  return { relay: r.b32(), n: r.u64(), chain: r.b32() };
};
export const encodeHead = (h: RelayHead): Bytes => writeHead(new Writer(), h).bytes();
export const decodeHead = (bytes: Bytes): Result<RelayHead> => decode(bytes, readHead);

/** A proof as a frame carries it: its label and fields, no signature. A value outside its field throws. */
export function writeProof(w: Writer, p: Proof): Writer {
  w.label(LABELS[p.kind]);
  for (const field of [p.relay, p.deviceNonce, p.relayNonce, p.binding]) w.b32(field);
  if (p.kind === "active") return w.b32(p.person).b32(p.device);
  if (p.kind === "recovery") return writeDevice(w.b32(p.person).b32(p.recovery), p.newDevice);
  return writeHead(writeDevice(w, p.device), p.head);
}

/** Reads a proof of the given kind; another label refuses. */
export function readProof(r: Reader, kind: ProofKind): Proof {
  r.label(LABELS[kind]);
  const [relay, deviceNonce, relayNonce, binding] = [r.b32(), r.b32(), r.b32(), r.b32()];
  const s: Session = { relay, deviceNonce, relayNonce, binding };
  if (kind === "active") return { ...s, kind, person: r.b32(), device: r.b32() };
  if (kind === "recovery")
    return { ...s, kind, person: r.b32(), recovery: r.b32(), newDevice: readDevice(r) };
  return { ...s, kind, device: readDevice(r), head: readHead(r) };
}

/** The bytes a proof's signatures cover: the platform's `sign` over them signs the proof. */
export const encodeProof = (p: Proof): Bytes => writeProof(new Writer(), p).bytes();
export const decodeProof = (bytes: Bytes, kind: ProofKind): Result<Proof> =>
  Object.hasOwn(LABELS, kind) ? decode(bytes, (r) => readProof(r, kind)) : fail("bad-input");

const isSig = (s: unknown): s is Bytes => isBytes(s) && s.length === 64;

/** Whether `signature` is the relay key `relayKey`'s over `head`, and `head` names that key's id. */
export const checkHead = (
  platform: Platform,
  relayKey: Bytes,
  head: RelayHead,
  signature: Bytes,
): boolean => headHolds(platform, relayKey, relayKeyId(platform, relayKey), head, signature);

const headHolds = (platform: Platform, key: Bytes, id: Bytes, head: RelayHead, sig: Bytes) =>
  isSig(sig) && bytesEqual(head.relay, id) && platform.verify(key, encodeHead(head), sig);

/** What the checking side knows of the connection: the pinned relay key, the nonce it sent, its binding. */
export type Expect = { relayPublic: Bytes; relayNonce: Bytes; binding: Bytes };
export type ProofVerdict =
  | { ok: true }
  | { ok: false; rule: "session" | "signer" | "signature" | "head" };

/**
 * Whether a proof's signatures hold (design 6.6, security design 5.10), in this order: it names this
 * relay, this relay nonce and this binding (`session`); `signer`, the keys the caller's log gives for
 * the device an active proof names or for the current recovery key a recovery proof names, hash to
 * the id the proof names (`signer`); its signatures, one for an active proof, two for the others,
 * are 64 bytes and verify (`signature`); an upload's second is the relay's own over its head
 * (`head`). An upload and the new device of a recovery carry their own keys. `proof` comes from
 * `decodeProof`: a hand-built one with a field of the wrong length throws.
 */
export function checkProof(
  platform: Platform,
  proof: Proof,
  signatures: readonly Bytes[],
  expect: Expect,
  signer?: PublicKeys,
): ProofVerdict {
  const relay = relayKeyId(platform, expect.relayPublic);
  if (
    !bytesEqual(proof.relay, relay) ||
    !bytesEqual(proof.relayNonce, expect.relayNonce) ||
    !bytesEqual(proof.binding, expect.binding)
  )
    return { ok: false, rule: "session" };
  const named = proof.kind === "active" ? deviceId : recoveryKeyId;
  if (
    proof.kind !== "upload" &&
    !(
      signer &&
      bytesEqual(
        named(platform, signer.signing, signer.receiving),
        proof.kind === "active" ? proof.device : proof.recovery,
      )
    )
  )
    return { ok: false, rule: "signer" };
  const bytes = encodeProof(proof);
  const keys =
    proof.kind === "active"
      ? [signer?.signing]
      : proof.kind === "recovery"
        ? [signer?.signing, proof.newDevice.signing]
        : [proof.device.signing];
  if (
    signatures.length !== (proof.kind === "active" ? 1 : 2) ||
    !signatures.every(isSig) ||
    !keys.every((k, i) => k && platform.verify(k, bytes, signatures[i] as Bytes))
  )
    return { ok: false, rule: "signature" };
  if (
    proof.kind === "upload" &&
    !headHolds(platform, expect.relayPublic, relay, proof.head, signatures[1] as Bytes)
  )
    return { ok: false, rule: "head" };
  return { ok: true };
}

/** One link of the running hash (design 6.6, 5.10): SHA-256 of its label, the link before and the item's id. */
export function chainLink(platform: Platform, previous: Bytes, id: Bytes): Bytes {
  return platform.sha256(new Writer().label("relay-chain").b32(previous).b32(id).bytes());
}

/** The running hash of a sequence of item ids: 32 zero bytes for none, the last link otherwise. */
export const runningHash = (platform: Platform, ids: readonly Bytes[]): Bytes =>
  ids.reduce((chain, id) => chainLink(platform, chain, id), new Uint8Array(32));
