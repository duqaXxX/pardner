/** The proof of possession a new device makes (design 6.1), shared by the tests that build device logs. */
import assert from "node:assert/strict";
import { type DeviceKeys, encodeDevicePossession } from "../../src/protocol/device-log.ts";
import type { Bytes, Platform } from "../../src/protocol/platform.ts";

/** `signName`'s signature over the possession bytes of `device` for `person`; the kind is the device's own. */
export function makeProof(
  platform: Platform,
  signName: string,
  person: Bytes,
  device: DeviceKeys,
): Bytes {
  const made = platform.sign(signName, encodeDevicePossession(person, device));
  assert.ok(made.ok);
  return made.value;
}
