/**
 * What the tests of the device's reading share: a person, a bot, the entries and messages of a
 * channel, all real bytes, and a relay reduced to the frames of a read (design 6.7). The relay's own
 * process is driven by `reading-relay.test.ts`.
 */
import assert from "node:assert/strict";
import { bytesEqual } from "../../src/protocol/bytes.ts";
import { checkDeviceEntry, idKey, type LoggedEntry } from "../../src/protocol/device-log.ts";
import {
  encodeHistorySeal,
  type HistorySeal,
  type LoggedEpoch,
  sealEpochKey,
} from "../../src/protocol/epochs.ts";
import type { Frame } from "../../src/protocol/frames.ts";
import { relayKeyId, signedId } from "../../src/protocol/ids.ts";
import { checkMemberEntry, type LoggedMember } from "../../src/protocol/member-log.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { encodeHead, runningHash } from "../../src/protocol/proofs.ts";
import type { Out, Reading, Who } from "../../src/protocol/reading.ts";
import type { Sequence } from "../../src/relay/sequence.ts";
import { platform } from "../relay/support.ts";
import {
  epochEntry,
  fill,
  type Keyed,
  keyed,
  memberEntry,
  message,
  type Person,
  person,
} from "../relay/world.ts";

export type Signed = { signed: Bytes; sig: Bytes };
export type Item = Signed & { kind: 1 | 2 | 3 | 4 };

/** The name the platform holds a keyed device's receiving key under. */
export const receivingOf = (k: Keyed): string => k.sign.replace(/\.s$/, ".r");

/** The relay's sequence as a list, and the frames it answers a read with. */
export class Wire {
  items: Item[] = [];
  seals: { seal: HistorySeal; sig: Bytes }[] = [];
  incarnation: Bytes = fill(7, 16);
  readonly key: Keyed;
  constructor(key = keyed()) {
    this.key = key;
  }
  put(kind: Item["kind"], e: Signed): number {
    this.items.push({ kind, ...e });
    return this.items.length - 1;
  }
  /** The head over the first `n` items, signed by the relay's key; `chain` signs a running hash that is not theirs. */
  head(
    n = this.items.length,
    chain = runningHash(
      platform,
      this.items.slice(0, n).map((i) => signedId(platform, i.signed)),
    ),
  ): Extract<Frame, { type: "head" }> {
    const head = { relay: relayKeyId(platform, this.key.keys.signing), n, chain };
    const sig = platform.sign(this.key.sign, encodeHead(head));
    assert.ok(sig.ok);
    return { type: "head", n, chain, sig: sig.value };
  }
  served = (): Frame => ({ type: "served", incarnation: this.incarnation });
  /** A read from `from`: the position, the seals, each item, the head. */
  read(from = 0): Frame[] {
    return [
      { type: "position", from, incarnation: this.incarnation },
      { type: "seals", items: this.seals },
      ...this.items
        .slice(from)
        .map((i, at): Frame => ({ type: "item", position: from + at, ...i })),
      this.head(),
    ];
  }
  /** A push: the items from `from` up to `to`, and the head over them. */
  push(from: number, to = this.items.length): Frame[] {
    return [
      ...this.items
        .slice(from, to)
        .map((i, at): Frame => ({ type: "item", position: from + at, ...i })),
      this.head(to),
    ];
  }
}

export const play = (r: Reading, frames: Frame[]): Out[] => frames.flatMap((f) => r.take(f));
export const kinds = (outs: Out[]) => outs.map((o) => o.do);

/** alice (an app) and a bot, the entries that pair them, a channel and the first epoch, on a wire. */
export function scene() {
  const alice = person();
  const bot = keyed("bot");
  const wire = new Wire();
  const log: LoggedEntry[] = [];
  const members: LoggedMember[] = [];
  const epochs: LoggedEpoch[] = [];
  const genesis = alice.genesis;
  wire.put(1, genesis);
  const checked = checkDeviceEntry(platform, [], genesis.signed, genesis.sig);
  assert.ok(checked.ok);
  log.push(checked.value);
  /** Puts a device entry of alice's on the wire and in the tracked log. */
  const entry = (e: Signed) => {
    const v = checkDeviceEntry(platform, log, e.signed, e.sig);
    assert.ok(v.ok, "the entry holds");
    log.push(v.value);
    return wire.put(1, e);
  };
  entry(alice.add(log, bot));
  const create = memberEntry(alice, [], { kind: "create", nonce: fill(3, 16) });
  const channel = signedId(platform, create.signed);
  const m = checkMemberEntry(platform, [], create.signed, create.sig, log);
  assert.ok(m.ok);
  members.push(m.value);
  wire.put(2, create);
  /** A new epoch at the heads of the tracked logs, sealed to alice's devices; it is put on the wire. */
  const epoch = (over = {}) => {
    const seq = {
      channels: new Map([[idKey(channel), { members, epochs }]]),
      devices: new Map([[idKey(alice.id), log]]),
    } as unknown as Sequence;
    const e = epochEntry(seq, channel, { person: alice, device: alice.first }, [alice], over);
    const logged = { entry: e.entry, id: signedId(platform, e.signed) };
    epochs.push(logged);
    wire.put(3, e);
    return { id: logged.id, key: e.key, entry: e.entry };
  };
  const who: Who = {
    platform,
    relay: wire.key.keys.signing,
    person: alice.id,
    self: bot.id,
    receiving: receivingOf(bot),
  };
  return { alice, bot, wire, log, members, epochs, channel, entry, epoch, who };
}
export type Scene = ReturnType<typeof scene>;

/** A prompt from alice's app to the bot, sealed in `epoch`. */
export function prompt(
  s: Scene,
  epoch: { id: Bytes; key: Bytes },
  name = fill(6, 16),
  counter = 1,
  incarnation = s.wire.incarnation,
) {
  return message(s.alice.first, s.channel, epoch, {
    kind: 2,
    to: s.bot.id,
    name,
    counter,
    incarnation,
  });
}

/** A history seal by `maker` of `epoch`'s key to `to`. */
export function historySeal(epoch: LoggedEpoch, maker: Keyed, to: Keyed, key: Bytes) {
  const sealed = sealEpochKey(
    platform,
    epoch.entry.channel,
    epoch.entry.prev,
    to.id,
    to.keys.receiving,
    key,
  );
  assert.ok(sealed.ok);
  const seal: HistorySeal = {
    channel: epoch.entry.channel,
    epoch: epoch.id,
    ...sealed.value,
    maker: maker.id,
  };
  const sig = platform.sign(maker.sign, encodeHistorySeal(seal));
  assert.ok(sig.ok);
  return { seal, sig: sig.value };
}

export type { Person };
export { bytesEqual };
