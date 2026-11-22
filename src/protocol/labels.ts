import type { Bytes } from "./platform.ts";

const PREFIX = "blind-relay/1 ";

/** Every label of design section 5, by its use: the text after the protocol and version. */
const TEXT = {
  "device-id": "hashed: a device's id, with its two keys",
  "recovery-id": "hashed: a recovery key's id, with its two keys",
  "relay-id": "hashed: the relay key's id, with its key",
  "relay-chain": "hashed: one link of the relay's running hash",
  "device-entry": "signed: a device-log entry",
  "device-possession": "signed: a new device's proof of possession, by that device",
  "member-entry": "signed: a member-log entry",
  "epoch-entry": "signed: an epoch-log entry",
  message: "signed: a message",
  "proof-active": "signed: the proof of an active device",
  "proof-recovery": "signed, twice: the recovery proof",
  "proof-upload": "signed: the proof of an upload",
  "relay-head": "signed by the relay key: a head",
  "history-seal": "signed: a seal of history",
  "epoch-seal": "HPKE info: an epoch key sealed to a recipient",
  "store-seal": "HPKE info: an epoch key sealed to the device's own key",
  commit: "HKDF info: the commitment to an epoch key",
  sender: "HKDF info: a sender key",
  "recovery-signing": "HKDF info: the input of the recovery signing key",
  "recovery-receiving": "HKDF info: the input of the recovery receiving key",
  file: "AES-GCM additional data of a blob",
  "cut-name": "hashed: the name of a bot's cut notice",
  "unread-name": "hashed: the name of a bot's not-read notice",
  "personal-space": "hashed: the nonce of the entry 0 of a person's space",
} as const;

export type LabelName = keyof typeof TEXT;

/** The label's full text: the protocol, its version and the name. */
export function labelText(name: LabelName): string {
  if (!Object.hasOwn(TEXT, name)) throw new RangeError("not a label");
  return PREFIX + name;
}

/** `L(...)` of a label: a length byte, then the ASCII text; a fresh copy at each call. */
export function labelBytes(name: LabelName): Bytes {
  const text = labelText(name);
  const out = new Uint8Array(text.length + 1);
  out[0] = text.length;
  for (let i = 0; i < text.length; i++) out[i + 1] = text.charCodeAt(i);
  return out;
}

/** The label's text, as the platform's TLS exporter takes it: `exportKeyingMaterial(32, ...)`, no context. */
export const EXPORTER_LABEL = `EXPORTER-${PREFIX}binding`;
