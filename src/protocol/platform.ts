import type { Result } from "./result.ts";

export type Bytes = Uint8Array;

/**
 * What the package asks of the machine, and all it asks. Synchronous, and a failure on another
 * party's input is a `Result`; a function that returns plain bytes throws on an input outside its
 * limits (the key 32 bytes, the nonce 12, the `hkdf` info at most 1,024 bytes, its length 1 to
 * 8,160), on both engines, which is a fault of the package. A private key never crosses.
 */
export interface Platform {
  /** SHA-256: 32 bytes. */
  sha256(data: Bytes): Bytes;
  /** HKDF-SHA256 (RFC 5869) with an empty salt; `info` at most 1,024 bytes, `length` 1 to 8,160. */
  hkdf(ikm: Bytes, info: Bytes, length: number): Bytes;
  /** AES-256-GCM: a 32-byte key, a 12-byte nonce; the ciphertext with its 16-byte tag after it. */
  aesGcmSeal(key: Bytes, nonce: Bytes, aad: Bytes, plaintext: Bytes): Bytes;
  aesGcmOpen(key: Bytes, nonce: Bytes, aad: Bytes, sealed: Bytes): Result<Bytes>;
  /** ECDSA P-256 with SHA-256; a 65-byte uncompressed public key; a 64-byte signature, r then s. */
  verify(publicKey: Bytes, message: Bytes, signature: Bytes): boolean;
  /** HPKE base mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM: `enc` is 65 bytes. */
  hpkeSeal(
    recipient: Bytes,
    info: Bytes,
    aad: Bytes,
    plaintext: Bytes,
  ): Result<{ enc: Bytes; sealed: Bytes }>;

  /** A key pair made and kept by the platform under `name`; the 65-byte public key. */
  makeKeyPair(name: string, use: "sign" | "receive"): Result<Bytes>;
  publicKey(name: string): Result<Bytes>;
  sign(name: string, message: Bytes): Result<Bytes>;
  hpkeOpen(name: string, enc: Bytes, info: Bytes, aad: Bytes, sealed: Bytes): Result<Bytes>;
  /** Zeroes and forgets the key; `io-failed` when the platform could not record the removal, the key then kept. */
  deleteKey(name: string): Result<void>;

  /**
   * The recovery secret, on one HKDF `info` per half (the two must differ). Each half is
   * DeriveKeyPair(HKDF(secret, info, 32)) (RFC 9180, 7.1.3).
   * `createRecovery` makes 32 random bytes, derives both pairs, shows the secret to the person, and
   * returns the two public keys: it holds nothing, so no private recovery key exists afterwards.
   * `enterRecovery` takes the secret from the person, derives, and holds the two pairs under
   * `<name>.sign` and `<name>.receive` for their use; the caller removes them with `deleteKey`.
   * Neither keeps the secret: it, the HKDF outputs and the candidate scalars are erased on every
   * path, a refusal and an exception too. A name that is taken is refused before the person is
   * shown or asked anything.
   */
  createRecovery(
    name: string,
    signInfo: Bytes,
    receiveInfo: Bytes,
  ): Result<{ signing: Bytes; receiving: Bytes }>;
  enterRecovery(
    name: string,
    signInfo: Bytes,
    receiveInfo: Bytes,
  ): Result<{ signing: Bytes; receiving: Bytes }>;

  random(length: number): Bytes;
  /** Milliseconds since 1970-01-01 UTC, on this machine's clock. */
  now(): number;
  utf8Encode(text: string): Bytes;
  /** Fails on bytes that are not UTF-8; a byte order mark stays in the text. */
  utf8Decode(bytes: Bytes): Result<string>;
}
