import { recoveryKeyId } from "./ids.ts";
import { labelBytes } from "./labels.ts";
import type { Bytes, Platform } from "./platform.ts";
import { ok, type Result } from "./result.ts";

/** A recovery key: its two public keys and its id. The private halves never leave the platform. */
export interface RecoveryKey {
  signing: Bytes;
  receiving: Bytes;
  id: Bytes;
}

function keyOf(
  platform: Platform,
  made: Result<{ signing: Bytes; receiving: Bytes }>,
): Result<RecoveryKey> {
  if (!made.ok) return made;
  const { signing, receiving } = made.value;
  return ok({ signing, receiving, id: recoveryKeyId(platform, signing, receiving) });
}

/**
 * Makes a recovery secret and shows it to the person (design 3.2). The platform holds no private
 * key afterwards: the keys come back as public keys and an id.
 */
export const createRecoveryKey = (platform: Platform, name: string): Result<RecoveryKey> =>
  keyOf(
    platform,
    platform.createRecovery(name, labelBytes("recovery-signing"), labelBytes("recovery-receiving")),
  );

/**
 * Takes the recovery secret back from the person and holds the two private keys under
 * `<name>.sign` and `<name>.receive` for their use; the caller deletes both with `deleteKey`.
 */
export const enterRecoveryKey = (platform: Platform, name: string): Result<RecoveryKey> =>
  keyOf(
    platform,
    platform.enterRecovery(name, labelBytes("recovery-signing"), labelBytes("recovery-receiving")),
  );
