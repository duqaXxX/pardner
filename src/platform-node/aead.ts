import { createCipheriv, createDecipheriv } from "node:crypto";

const TAG = 16;

/** AES-256-GCM: the ciphertext with its full 16-byte tag after it. */
export function gcmSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plain: Uint8Array) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG });
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

/** Throws when the tag does not verify; a tag of any other length is no tag. */
export function gcmOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array) {
  if (sealed.length < TAG) throw new Error("sealed bytes shorter than a tag");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG });
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - TAG)),
    decipher.final(),
  ]);
}
