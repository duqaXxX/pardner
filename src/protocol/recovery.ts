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
 * Makes a recovery secret the platform keeps under `name` (design 3.2, 3.8). The keys come back as
 * public keys and an id; nothing is shown until `showRecoveryKey`, once entry 0 has an id. The
 * caller sends nothing that carries the returned keys (entry 0) until `showRecoveryKey` has
 * confirmed: a decline or a stop before it wipes the only copy of the secret, and the attempt then
 * starts over with new keys (design 3.5).
 */
export const createRecoveryKey = (platform: Platform, name: string): Result<RecoveryKey> =>
  keyOf(
    platform,
    platform.createRecovery(name, labelBytes("recovery-signing"), labelBytes("recovery-receiving")),
  );

/**
 * Shows the held secret with the sheet's public `context`, then the platform erases it. `bad-input`
 * when the person did not confirm, `context` is not a string or nothing is held under `name`. The
 * secret is wiped whatever the answer, so a decline ends the attempt: nothing carrying the keys
 * from `createRecoveryKey` may have been sent before this returned `ok` (design 3.5).
 */
export const showRecoveryKey = (platform: Platform, name: string, context: string): Result<void> =>
  platform.showRecovery(name, context);

/**
 * Takes the recovery secret back from the person and holds the two private keys under
 * `<name>.sign` and `<name>.receive` for their use; the caller deletes both with `deleteKey`.
 */
export const enterRecoveryKey = (platform: Platform, name: string): Result<RecoveryKey> =>
  keyOf(
    platform,
    platform.enterRecovery(name, labelBytes("recovery-signing"), labelBytes("recovery-receiving")),
  );
