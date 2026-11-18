/**
 * HPKE (RFC 9180) base mode, DHKEM(P-256, HKDF-SHA256) 0x0010, HKDF-SHA256 0x0001, AES-256-GCM
 * 0x0002, composed from the primitives of `node:crypto`. Not `crypto.encapsulate`: Node 22, the
 * floor when this was written, had none. Moving to it is a change of its own, held to the RFC's
 * vector. A context seals or opens once, at sequence number 0, so the number never advances and
 * cannot overflow.
 */
import { createECDH, createHmac } from "node:crypto";
import { gcmOpen, gcmSeal } from "./aead.ts";

const ORDER = Buffer.from(
  "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
  "hex",
);
const ascii = (s: string) => Buffer.from(s, "ascii");
const i2osp = (n: number, width: number) => {
  const out = Buffer.alloc(width);
  out.writeUIntBE(n, 0, width);
  return out;
};
const kemSuite = Buffer.concat([ascii("KEM"), i2osp(0x0010, 2)]);
const hpkeSuite = Buffer.concat([
  ascii("HPKE"),
  i2osp(0x0010, 2),
  i2osp(0x0001, 2),
  i2osp(0x0002, 2),
]);

export interface KeyPair {
  /** The private scalar, 32 bytes. */
  readonly sk: Buffer;
  /** The uncompressed point, 65 bytes. */
  readonly pk: Buffer;
}

const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();

/** Runs `use` on the concatenation of `parts`, which is erased after it: Node's pool would keep it. */
function withConcat<T>(parts: Uint8Array[], use: (joined: Buffer) => T): T {
  const joined = Buffer.concat(parts);
  try {
    return use(joined);
  } finally {
    joined.fill(0);
  }
}

function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  const blocks: Buffer[] = [];
  let last = Buffer.alloc(0);
  for (let i = 1; blocks.length * 32 < length; i++) {
    const previous = last;
    last = withConcat([previous, info, Buffer.from([i])], (joined) => hmac(prk, joined));
    blocks.push(last);
  }
  const out = Buffer.concat(blocks);
  for (const block of blocks) block.fill(0); // the chain's blocks are key material too
  return out.subarray(0, length);
}

const labeledExtract = (suite: Buffer, salt: Uint8Array, label: string, ikm: Uint8Array) =>
  withConcat([ascii("HPKE-v1"), suite, ascii(label), ikm], (joined) =>
    hmac(salt.length > 0 ? salt : Buffer.alloc(32), joined),
  );
const labeledExpand = (suite: Buffer, prk: Buffer, label: string, info: Buffer, length: number) =>
  expand(
    prk,
    Buffer.concat([i2osp(length, 2), ascii("HPKE-v1"), suite, ascii(label), info]),
    length,
  );

/** The key pair of a private scalar of 32 bytes; throws on a scalar the curve refuses. */
export function keyPairOf(sk: Buffer): KeyPair {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(sk);
  return { sk, pk: ecdh.getPublicKey() };
}

/** Whether a 32-byte candidate is a private scalar of P-256: from 1 to n-1, as bytes. */
export const acceptsScalar = (scalar: Uint8Array): boolean =>
  scalar.length === 32 && scalar.some((b) => b !== 0) && Buffer.compare(scalar, ORDER) < 0;

/**
 * RFC 9180, 7.1.3: a key pair from input keying material that serves no other purpose. The
 * pseudorandom key and each rejected candidate are erased, on every path.
 */
export function deriveKeyPair(ikm: Uint8Array): KeyPair {
  const prk = labeledExtract(kemSuite, new Uint8Array(0), "dkp_prk", ikm);
  try {
    for (let counter = 0; counter < 256; counter++) {
      const sk = labeledExpand(kemSuite, prk, "candidate", i2osp(counter, 1), 32);
      if (!acceptsScalar(sk)) {
        sk.fill(0);
        continue;
      }
      try {
        return keyPairOf(sk);
      } catch (error) {
        sk.fill(0);
        throw error;
      }
    }
  } finally {
    prk.fill(0);
  }
  throw new Error("DeriveKeyPairError");
}

/** A fresh key pair from the platform generator. */
export function generateKeyPair(): KeyPair {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const raw = ecdh.getPrivateKey();
  const sk = Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
  raw.fill(0); // the copy before the padding is key material too
  return { sk, pk: ecdh.getPublicKey() };
}

function sharedSecretOf(dh: Buffer, kemContext: Buffer): Buffer {
  const prk = labeledExtract(kemSuite, new Uint8Array(0), "eae_prk", dh);
  return labeledExpand(kemSuite, prk, "shared_secret", kemContext, 32);
}

/** DH on P-256; a public key is the 65-byte point starting with 4 and nothing else (RFC 9180, 7.1.1). */
const diffieHellman = (sk: Buffer, pk: Uint8Array) => {
  if (pk.length !== 65 || pk[0] !== 4) throw new Error("not an uncompressed point");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(sk);
  return ecdh.computeSecret(pk); // throws on a point that is not on the curve
};

/** Encap (RFC 9180, 4.1): the encapsulated key and the shared secret under a one-time key. */
export function encap(oneTime: KeyPair, recipient: Uint8Array) {
  const kemContext = Buffer.concat([oneTime.pk, recipient]);
  return {
    enc: oneTime.pk,
    sharedSecret: sharedSecretOf(diffieHellman(oneTime.sk, recipient), kemContext),
  };
}

/** KeySchedule (RFC 9180, 5.1), base mode: the context, the secret, the AEAD key and base nonce. */
export function keySchedule(sharedSecret: Buffer, info: Uint8Array) {
  const pskIdHash = labeledExtract(hpkeSuite, new Uint8Array(0), "psk_id_hash", new Uint8Array(0));
  const infoHash = labeledExtract(hpkeSuite, new Uint8Array(0), "info_hash", info);
  const context = Buffer.concat([Buffer.from([0]), pskIdHash, infoHash]); // mode 0, base
  const secret = labeledExtract(hpkeSuite, sharedSecret, "secret", new Uint8Array(0));
  return {
    context,
    secret,
    key: labeledExpand(hpkeSuite, secret, "key", context, 32),
    baseNonce: labeledExpand(hpkeSuite, secret, "base_nonce", context, 12),
  };
}

/** The oneTime key is a parameter for the RFC's vector alone; `seal` makes a fresh one. */
export function sealWith(
  oneTime: KeyPair,
  recipient: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  plain: Uint8Array,
) {
  const { enc, sharedSecret } = encap(oneTime, recipient);
  const { key, baseNonce } = keySchedule(sharedSecret, info);
  return { enc, sealed: gcmSeal(key, baseNonce, aad, plain) };
}

/** HPKE seal to `recipient` under a fresh one-time key. */
export const seal = (recipient: Uint8Array, info: Uint8Array, aad: Uint8Array, plain: Uint8Array) =>
  sealWith(generateKeyPair(), recipient, info, aad, plain);

/** Throws on a point that is not on the curve and on a tag that does not verify. */
export function open(
  recipient: KeyPair,
  enc: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  sealed: Uint8Array,
) {
  const kemContext = Buffer.concat([enc, recipient.pk]);
  const { key, baseNonce } = keySchedule(
    sharedSecretOf(diffieHellman(recipient.sk, enc), kemContext),
    info,
  );
  return gcmOpen(key, baseNonce, aad, sealed);
}
