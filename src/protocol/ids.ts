import { isBytes, Writer } from "./bytes.ts";
import type { Bytes, Platform } from "./platform.ts";

/** An id: SHA-256 of the signed bytes, label included, signature excluded. */
export function signedId(platform: Platform, signed: Bytes): Bytes {
  if (!isBytes(signed)) throw new TypeError("not bytes");
  return platform.sha256(signed);
}

/** A device's id: SHA-256 of its label, its signing key and its receiving key. */
export const deviceId = (platform: Platform, signing: Bytes, receiving: Bytes): Bytes =>
  platform.sha256(new Writer().label("device-id").pk(signing).pk(receiving).bytes());

/** A recovery key's id: SHA-256 of its label, its signing key and its receiving key. */
export const recoveryKeyId = (platform: Platform, signing: Bytes, receiving: Bytes): Bytes =>
  platform.sha256(new Writer().label("recovery-id").pk(signing).pk(receiving).bytes());

/** The relay key's id: SHA-256 of its label and its one public key. */
export const relayKeyId = (platform: Platform, relay: Bytes): Bytes =>
  platform.sha256(new Writer().label("relay-id").pk(relay).bytes());
