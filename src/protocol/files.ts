import { bytesEqual, isBytes } from "./bytes.ts";
import { labelBytes } from "./labels.ts";
import type { Bytes, Platform } from "./platform.ts";
import { fail, type Result } from "./result.ts";

/** A file key encrypts one file once, so the nonce is fixed (SD 5.12). */
const NONCE = new Uint8Array(12);

/** What sealing adds to a file: the GCM tag, so a blob is its file's size and this. */
export const SEAL_OVERHEAD = 16;

/** A sealed file (design 6.5): its fresh key, the blob, and the blob's id, the SHA-256 of the blob. */
export interface SealedBlob {
  key: Bytes;
  blob: Bytes;
  id: Bytes;
}

/**
 * Test-only: the blob of `file` under a key the vector gives. The app calls `sealBlob`, which makes
 * the key: a key that seals twice under the fixed nonce is broken (crypto.md 1).
 */
export function sealBlobUnderKey(platform: Platform, key: Bytes, file: Bytes): SealedBlob {
  const blob = platform.aesGcmSeal(key, NONCE, labelBytes("file"), file);
  return { key, blob, id: platform.sha256(blob) };
}

/** Seals a file under a key made for it alone, so that the fixed nonce is never reused. */
export const sealBlob = (platform: Platform, file: Bytes): SealedBlob =>
  sealBlobUnderKey(platform, platform.random(32), file);

/** The file of a blob; the hash is checked before the key is tried, and any failure is `open-failed`. */
export function openBlob(platform: Platform, id: Bytes, key: Bytes, blob: Bytes): Result<Bytes> {
  if (!isBytes(id) || !isBytes(key) || !isBytes(blob)) throw new TypeError("not bytes");
  if (!bytesEqual(platform.sha256(blob), id)) return fail("open-failed");
  const opened = platform.aesGcmOpen(key, NONCE, labelBytes("file"), blob);
  return opened.ok ? opened : fail("open-failed"); // a key of another length is a key that fails
}
