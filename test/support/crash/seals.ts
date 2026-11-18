/**
 * The checks of design 5.3 that need more than the sequence: the seals a device is served, the seals
 * answered `result 0`, and the blobs the messages of the sequence name (never allowed 13, RD 3.6).
 */
import {
  type DeviceEntry,
  decodeDeviceEntry,
  foldLog,
  idKey,
  type LoggedEntry,
} from "../../../src/protocol/device-log.ts";
import { deviceId } from "../../../src/protocol/ids.ts";
import { decodeMessage } from "../../../src/protocol/messages.ts";
import type { Bytes, Platform } from "../../../src/protocol/platform.ts";
import { dial, type Link, type Pass } from "../scripted-device/link.ts";
import type { Answer } from "./segments.ts";

const hex = (b: Bytes) => Buffer.from(b).toString("hex");

/** The ids of the devices a sequence's device entries name. */
function devicesOf(platform: Platform, got: Pass): Set<string> {
  const ids = new Set<string>();
  for (const item of got.items.filter((i) => i.kind === 1)) {
    const e = decodeDeviceEntry(item.signed);
    const d = e.ok ? (e.value as DeviceEntry) : undefined;
    const keys =
      d &&
      (d.kind === "genesis" || d.kind === "add"
        ? d.device
        : d.kind === "reset"
          ? d.newDevice?.device
          : undefined);
    if (keys) ids.add(hex(deviceId(platform, keys.signing, keys.receiving)));
  }
  return ids;
}

/** The ids (by `idKey`) of the devices and recovery keys the sequence's device entries name, folded as the protocol folds them. */
function recipientsOf(platform: Platform, got: Pass): Set<string> {
  const log: LoggedEntry[] = [];
  for (const item of got.items.filter((i) => i.kind === 1)) {
    const e = decodeDeviceEntry(item.signed);
    if (e.ok) log.push({ entry: e.value, id: item.id });
  }
  const f = foldLog(platform, log);
  return new Set([...f.named.keys(), ...f.recoveries.keys()]);
}

/**
 * What a device served `got` (and the relay it is served by) must find: each seal it is served names an
 * epoch, a maker and a recipient of the sequence (RD 3.4), each seal answered `result 0` is served to its recipient,
 * and each blob a message names is held, with bytes that hash to its id. `unprobed` counts a recipient
 * that is not a device (a recovery key), whose reads the checker cannot make.
 */
export async function sealsAndBlobs(
  link: Link,
  got: Pass,
  told: Answer[],
  platform: Platform,
  port: number,
  note: { unprobed: number },
): Promise<string | undefined> {
  const epochs = new Set(got.items.filter((i) => i.kind === 3).map((i) => hex(i.id)));
  const makers = devicesOf(platform, got);
  const recipients = recipientsOf(platform, got);
  const named = (seals: Pass["seals"]) =>
    seals.every(
      (s) =>
        epochs.has(hex(s.seal.epoch)) &&
        makers.has(hex(s.seal.maker)) &&
        recipients.has(idKey(s.seal.recipient)),
    );
  if (!named(got.seals))
    return "a seal is served that names an epoch, a maker or a recipient the sequence lacks (RD 3.4)";
  for (const a of told) {
    if (a.kind !== "seal") continue;
    if (!a.recipient) {
      note.unprobed++;
      continue;
    }
    const to = await dial(platform, port, a.relay);
    const proof = await to.proveActive(a.person, a.recipient.id, a.recipient.sign);
    const read = proof.type === "served" ? await to.read(0) : undefined;
    to.close();
    // The recipient is a device the sequence added before the seal was answered: a refusal is a defect, not a gap.
    if (!read) return "a seal answered result 0 went to a device the relay does not serve (RD 3.4)";
    if (read.type !== "pass" || !named(read.seals))
      return "a seal is served that names an epoch, a maker or a recipient the sequence lacks (RD 3.4)";
    if (
      !read.seals.some(
        (s) => hex(s.seal.epoch) === hex(a.epoch) && hex(s.seal.maker) === hex(a.maker),
      )
    )
      return "a seal answered result 0 is not served to its recipient (RD 3.4)";
  }
  for (const item of got.items.filter((i) => i.kind === 4)) {
    const m = decodeMessage(item.signed);
    for (const blob of m.ok ? m.value.header.blobs : []) {
      const bytes = await link.getBlob(blob);
      if (!("bytes" in bytes) || hex(platform.sha256(bytes.bytes)) !== hex(blob))
        return "a message of the sequence names a blob the relay does not hold (never allowed 13, RD 3.6)";
    }
  }
}
