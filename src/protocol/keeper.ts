/**
 * The keeper (device pairing design 3.11): what one device owes its person's channels after it has
 * read them to their end, the same function for the bot and the app. An epoch is owed where
 * `whyStart` says (security design 5.4, 5.7); a history seal where an earlier epoch's key, held by
 * this device, has no counting seal to an active device or to the current recovery key (5.3, steps 6
 * and 7). Pure and holding no secret: the key of a seal is read again by `makeSeal`.
 */
import { bytesEqual } from "./bytes.ts";
import { foldLog, idKey } from "./device-log.ts";
import {
  type EpochClock,
  encodeHistorySeal,
  type HistorySeal,
  type LoggedEpoch,
  type StartReason,
  sealEpochKey,
  whyStart,
} from "./epochs.ts";
import { deviceId, recoveryKeyId } from "./ids.ts";
import type { Bytes, Platform } from "./platform.ts";
import type { Reading } from "./reading.ts";
import { fail, ok, type Result } from "./result.ts";

/** A channel whose next epoch this device owes, and why. A rollover is the build's to report. */
export interface OwedStart {
  channel: Bytes;
  why: StartReason;
}

/** A seal of `epoch`'s key to `to` this device owes; `to.receiving` is the key it is sealed to. */
export interface OwedSeal {
  channel: Bytes;
  epoch: LoggedEpoch;
  to: { id: Bytes; receiving: Bytes };
}

/** Why `channel` needs an epoch of this device's, when it does; `clock` is the device's stored age of its epoch. */
export function startOf(
  reading: Reading,
  channel: Bytes,
  clock: EpochClock | undefined,
  now: number,
): StartReason | undefined {
  const view = reading.channel(channel);
  return view && whyStart(view, clock, now, false);
}

/** The channels read to their end that need an epoch, by `whyStart`; `clock` is the device's stored age of each channel's epoch. */
export function starts(
  reading: Reading,
  clock: (channel: Bytes) => EpochClock | undefined,
  now: number,
): OwedStart[] {
  return reading.channels().flatMap((channel) => {
    const why = startOf(reading, channel, clock(channel), now);
    return why ? [{ channel, why }] : [];
  });
}

/** What names a seal in flight, for a device that tracks the ones it sent and not yet answered. */
export const sealKey = (o: OwedSeal): string =>
  [o.channel, o.epoch.id, o.to.id].map(idKey).join(" ");

const heldKey = (channel: Bytes, epoch: Bytes, to: Bytes) =>
  [channel, epoch, to].map(idKey).join(" ");

/**
 * Every earlier or current epoch of every channel, with who was sealed its key: `sealed` by any verified
 * seal, `given` by one whose maker is still active (5.3 step 7). The log is folded once.
 */
function counted(platform: Platform, reading: Reading) {
  const { active, recovery } = foldLog(platform, reading.devices);
  const devices = [...active.values()].map((d) => ({
    id: deviceId(platform, d.signing, d.receiving),
    receiving: d.receiving,
  }));
  const recipients = recovery
    ? [
        ...devices,
        {
          id: recoveryKeyId(platform, recovery.signing, recovery.receiving),
          receiving: recovery.receiving,
        },
      ]
    : devices;
  // Version 1 has one person per relay: a second person's epochs need the member log (security design 9.10)
  // before a maker found in this person's active set can be taken to be this person's.
  const counts = (maker: Bytes | undefined) => !!maker && active.has(idKey(maker));
  const [sealed, given] = [new Set<string>(), new Set<string>()];
  const note = (maker: Bytes | undefined, channel: Bytes, epoch: Bytes, to: Bytes) => {
    const k = heldKey(channel, epoch, to);
    sealed.add(k);
    if (counts(maker)) given.add(k);
  };
  for (const h of reading.seals) note(h.maker, h.channel, h.epoch, h.recipient);
  const epochs = reading
    .channels()
    .flatMap((channel) =>
      (reading.channel(channel)?.epochs ?? []).map((epoch) => ({ channel, epoch })),
    );
  for (const { channel, epoch } of epochs)
    for (const sl of epoch.entry.seals)
      note(epoch.entry.signerDevice, channel, epoch.id, sl.recipient);
  return { active, devices, recipients, epochs, sealed, given };
}

/**
 * The seals `self` owes: for each epoch whose key it holds and each recipient (the person's active
 * devices and current recovery key) with no counting seal. Nothing when `self` is not active.
 */
export function seals(platform: Platform, reading: Reading, self: Bytes): OwedSeal[] {
  const { active, given, epochs, recipients } = counted(platform, reading);
  if (!active.has(idKey(self))) return [];
  return epochs.flatMap(({ channel, epoch }) =>
    reading.key(channel, epoch.id)
      ? recipients
          .filter((to) => !bytesEqual(to.id, self) && !given.has(heldKey(channel, epoch.id, to.id)))
          .map((to) => ({ channel, epoch, to }))
      : [],
  );
}

/** The epochs for which a device is the only active one sealed the key (design 3.9's warning before a removal), by `idKey` of the device. It counts who was sealed the key whatever the maker's state: what a removal loses is the key of the device holding it. */
export function soleHolders(
  platform: Platform,
  reading: Reading,
): Map<string, { channel: Bytes; epoch: Bytes }[]> {
  const { devices, sealed, epochs } = counted(platform, reading);
  const sole = new Map<string, { channel: Bytes; epoch: Bytes }[]>();
  for (const { channel, epoch } of epochs) {
    const holders = devices
      .map((d) => d.id)
      .filter((id) => sealed.has(heldKey(channel, epoch.id, id)));
    const [only] = holders;
    if (only && holders.length === 1)
      sole.set(idKey(only), [...(sole.get(idKey(only)) ?? []), { channel, epoch: epoch.id }]);
  }
  return sole;
}

/**
 * Makes and signs the history seal `owed` (design 6.3): the epoch key this device holds, sealed under the epoch's own `info`,
 * signed by this device `self` under `sign`. A value, never a throw: the package runs inside JavaScriptCore.
 */
export function makeSeal(
  platform: Platform,
  reading: Reading,
  owed: OwedSeal,
  sign: string,
  self: Bytes,
): Result<{ seal: HistorySeal; sig: Bytes }> {
  const key = reading.key(owed.channel, owed.epoch.id);
  if (!key) return fail("bad-input");
  try {
    const sealed = sealEpochKey(
      platform,
      owed.channel,
      owed.epoch.entry.prev,
      owed.to.id,
      owed.to.receiving,
      key,
    );
    if (!sealed.ok) return sealed;
    const seal = { ...sealed.value, channel: owed.channel, epoch: owed.epoch.id, maker: self };
    const sig = platform.sign(sign, encodeHistorySeal(seal));
    return sig.ok ? ok({ seal, sig: sig.value }) : sig;
  } catch {
    return fail("bad-input"); // a value outside its field: the caller's, handled as a refusal
  }
}
