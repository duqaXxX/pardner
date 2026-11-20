/**
 * The keeper (device pairing design 3.11, security design 5.3 steps 6 and 7, 5.7): what a device owes
 * after it reads its person's logs, the channels' epochs and the history seals. The reading is real,
 * on the frames of `reading-world.ts`; the model's `giveHistory` is the reference behaviour.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesEqual } from "../../src/protocol/bytes.ts";
import { activeDevices, idKey } from "../../src/protocol/device-log.ts";
import {
  checkHistorySeal,
  EPOCH_LIFE_MS,
  encodeHistorySeal,
  type LoggedEpoch,
  openHistorySeal,
} from "../../src/protocol/epochs.ts";
import { makeSeal, type OwedSeal, seals, soleHolders, starts } from "../../src/protocol/keeper.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { Reading, type Who } from "../../src/protocol/reading.ts";
import { platform } from "../relay/support.ts";
import { keyed } from "../relay/world.ts";
import { historySeal, play, receivingOf, type Scene, scene } from "./reading-world.ts";

const whoOf = (s: Scene, k: { id: Bytes; sign: string }): Who => ({
  ...s.who,
  self: k.id,
  receiving: receivingOf(k as never),
});

/** The reading of `who` (the scene's bot by default) at rest on the scene's wire. */
function readOf(s: Scene, who: Who = s.who): Reading {
  const r = new Reading(who);
  play(r, [s.wire.served(), ...s.wire.read()]);
  assert.equal(r.state, "rest");
  return r;
}

const epochOf = (s: Scene): LoggedEpoch => s.epochs[0] as LoggedEpoch;

const owes = (owed: OwedSeal[], epoch: Bytes, to: Bytes) =>
  owed.some((o) => bytesEqual(o.epoch.id, epoch) && bytesEqual(o.to.id, to));

test("a device added after two epochs gets a history seal for each, from the keeper of an older device", () => {
  const s = scene();
  const [e1, e2] = [s.epoch(), s.epoch()];
  const late = keyed("app");
  s.entry(s.alice.add(s.log, late));
  const r = readOf(s);
  const owed = seals(platform, r, s.bot.id);
  assert.equal(owed.length, 2);
  assert.ok(owes(owed, e1.id, late.id) && owes(owed, e2.id, late.id));
  // The seal it makes is signed by this device and opens, under the epoch's own info, for the new device.
  for (const o of owed) {
    const made = makeSeal(platform, r, o, s.bot.sign, s.bot.id);
    assert.ok(made.ok);
    const signed = encodeHistorySeal(made.value.seal);
    assert.ok(checkHistorySeal(platform, s.log, signed, made.value.sig).ok);
    const key = openHistorySeal(
      platform,
      receivingOf(late),
      s.log,
      signed,
      made.value.sig,
      o.epoch,
    );
    assert.ok(key.ok);
    assert.ok(bytesEqual(key.value, (bytesEqual(o.epoch.id, e1.id) ? e1 : e2).key));
  }
});

test("the keeper starts the epoch of a closed channel, and none when the channel is open", () => {
  const s = scene();
  s.epoch();
  assert.deepEqual(
    starts(readOf(s), () => undefined, 0),
    [],
  );
  s.entry(s.alice.add(s.log, keyed("app")));
  const [start] = starts(readOf(s), () => undefined, 0);
  assert.equal(start?.why, "closed");
  assert.ok(bytesEqual(start?.channel as Bytes, s.channel));
});

test("the keeper gives the reasons of whyStart a reading shows: no epoch, and aged by the clock", () => {
  const s = scene();
  assert.equal(starts(readOf(s), () => undefined, 0)[0]?.why, "no-epoch");
  const e = s.epoch();
  const clock = { epoch: e.id, since: 1000 };
  assert.deepEqual(
    starts(readOf(s), () => clock, 1000 + EPOCH_LIFE_MS - 1),
    [],
  );
  assert.equal(starts(readOf(s), () => clock, 1000 + EPOCH_LIFE_MS)[0]?.why, "aged");
});

test("the recovery key gets a seal when the epoch's own entry lacks it (a recovery key that replaced another)", () => {
  const s = scene();
  const e1 = s.epoch();
  const next = keyed("app");
  s.entry(
    s.alice.entry(
      s.log,
      { kind: "reset", set: [s.alice.first.id, s.bot.id], recovery: next.keys },
      s.alice.recovery,
    ),
  );
  const owed = seals(platform, readOf(s), s.bot.id);
  assert.equal(owed.length, 1);
  assert.ok(owes(owed, e1.id, next.recoveryId));
});

test("5.3 step 7: after the maker of a seal is removed, a holder seals again to the device that only had that maker's seal", () => {
  const s = scene();
  const e1 = s.epoch();
  const [stolen, late] = [keyed("app"), keyed("app")];
  s.entry(s.alice.add(s.log, stolen));
  s.entry(s.alice.add(s.log, late));
  s.wire.seals.push(historySeal(epochOf(s), stolen, late, e1.key));
  const before = seals(platform, readOf(s), s.bot.id);
  assert.ok(!owes(before, e1.id, late.id), "while its maker is active the seal counts as given");
  assert.ok(owes(before, e1.id, stolen.id));
  s.entry(s.alice.remove(s.log, stolen));
  const after = seals(platform, readOf(s), s.bot.id);
  assert.ok(owes(after, e1.id, late.id), "the removed maker's seal no longer counts");
  assert.ok(!owes(after, e1.id, stolen.id), "a removed device is never a recipient");
  assert.equal(after.length, 1);
});

test("a seal this device made counts, and a duplicate by another maker is harmless", () => {
  const s = scene();
  const e1 = s.epoch();
  const late = keyed("app");
  s.entry(s.alice.add(s.log, late));
  const bot = readOf(s);
  const first = readOf(s, whoOf(s, s.alice.first));
  assert.ok(owes(seals(platform, bot, s.bot.id), e1.id, late.id));
  assert.ok(owes(seals(platform, first, s.alice.first.id), e1.id, late.id));
  // Both keepers made theirs before reading each other's.
  s.wire.seals.push(historySeal(epochOf(s), s.bot, late, e1.key));
  s.wire.seals.push(historySeal(epochOf(s), s.alice.first, late, e1.key));
  assert.deepEqual(seals(platform, readOf(s), s.bot.id), []);
  assert.deepEqual(seals(platform, readOf(s, whoOf(s, s.alice.first)), s.alice.first.id), []);
  const opened = readOf(s, whoOf(s, late)).key(s.channel, e1.id);
  assert.ok(opened && bytesEqual(opened, e1.key), "the new device opens the first seal it reads");
});

test("nothing is owed when every recipient has a counting seal", () => {
  const s = scene();
  s.epoch();
  s.epoch();
  assert.deepEqual(seals(platform, readOf(s), s.bot.id), []);
});

test("an epoch whose key this device lacks is not sealed", () => {
  const s = scene();
  s.epoch();
  const [late, later] = [keyed("app"), keyed("app")];
  s.entry(s.alice.add(s.log, late));
  s.entry(s.alice.add(s.log, later));
  const r = readOf(s, whoOf(s, late));
  assert.equal(r.key(s.channel, epochOf(s).id), undefined);
  // A device added after the epoch holds no key of it, so it cannot seal it to the device added after it.
  assert.deepEqual(seals(platform, r, late.id), []);
  assert.equal(seals(platform, readOf(s), s.bot.id).length, 2, "a holder owes both");
});

test("a device the log does not name active owes nothing", () => {
  const s = scene();
  s.epoch();
  s.entry(s.alice.add(s.log, keyed("app")));
  assert.equal(seals(platform, readOf(s), s.bot.id).length, 1, "owed while it is active");
  s.entry(s.alice.remove(s.log, s.bot));
  assert.ok(!activeDevices(platform, s.log).has(idKey(s.bot.id)));
  assert.deepEqual(seals(platform, readOf(s), s.bot.id), []);
});

test("soleHolders names the epochs a device alone holds a counting seal for", () => {
  const s = scene();
  const e1 = s.epoch();
  assert.equal(soleHolders(platform, readOf(s)).size, 0, "two devices hold it");
  s.entry(s.alice.remove(s.log, s.bot));
  const sole = soleHolders(platform, readOf(s));
  assert.deepEqual([...sole.keys()], [idKey(s.alice.first.id)]);
  const [held] = sole.get(idKey(s.alice.first.id)) ?? [];
  assert.ok(held && bytesEqual(held.epoch, e1.id) && bytesEqual(held.channel, s.channel));
});

test("soleHolders counts who was sealed the key, whatever the maker's state", () => {
  const s = scene();
  const e1 = s.epoch(); // alice's first device made the entry, sealed to it and to the bot
  s.entry(s.alice.entry(s.log, { kind: "remove", device: s.alice.first.id }, s.bot)); // the maker is removed
  const sole = soleHolders(platform, readOf(s)).get(idKey(s.bot.id)) ?? [];
  assert.equal(sole.length, 1, "the bot is the only active device sealed e1");
  assert.ok(sole[0] && bytesEqual(sole[0].epoch, e1.id));
});

test("crypto.md 9: a served seal that is not signed by its maker does not count, and soleHolders still warns", () => {
  const s = scene();
  const e1 = s.epoch();
  s.entry(s.alice.remove(s.log, s.bot));
  const real = historySeal(epochOf(s), s.alice.first, s.alice.first, e1.key);
  // Maker: the only active device; recipient: itself; the signature is zero.
  s.wire.seals.push({ seal: { ...real.seal, maker: s.alice.first.id }, sig: new Uint8Array(64) });
  const r = readOf(s);
  assert.equal(r.seals.length, 0);
  assert.deepEqual([...soleHolders(platform, r).keys()], [idKey(s.alice.first.id)]);
});
