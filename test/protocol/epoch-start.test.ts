/**
 * What a device does to start an epoch (security design 5.4 and 5.7): the entry it builds at the
 * logs it holds, and when it builds one. The same rules are driven against the relay's own process
 * in `test/relay/epoch-start.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDeviceEntry, type LoggedEntry } from "../../src/protocol/device-log.ts";
import {
  buildEpoch,
  checkEpochEntry,
  EPOCH_LIFE_MS,
  type EpochClock,
  openEpochSeal,
  tickEpoch,
  whyStart,
} from "../../src/protocol/epochs.ts";
import { checkMemberEntry, type LoggedMember } from "../../src/protocol/member-log.ts";
import { Reading } from "../../src/protocol/reading.ts";
import { platform } from "../relay/support.ts";
import { fill, memberEntry, person } from "../relay/world.ts";
import { play, receivingOf, scene } from "./reading-world.ts";

/** The bot's reading of a scene, and what it needs to build. */
function built(s = scene()) {
  const r = new Reading(s.who);
  play(r, [s.wire.served(), ...s.wire.read()]);
  const view = r.channel(s.channel);
  assert.ok(view);
  const signer = { person: s.alice.id, device: s.bot.id, sign: s.bot.sign };
  return {
    r,
    view,
    build: () => buildEpoch(platform, view.members, view.epochs, [r.devices], signer),
  };
}

test("buildEpoch: the first epoch of a channel passes the checker at the logs the device holds, and every recipient opens one key that matches its commitment", () => {
  const s = scene();
  const { r, view, build } = built(s);
  assert.equal(view.epochs.length, 0);
  const made = build();
  assert.ok(made.ok);
  const checked = checkEpochEntry(
    platform,
    view.epochs,
    view.members,
    [r.devices],
    made.value.signed,
    made.value.sig,
  );
  assert.ok(checked.ok, "the checker of the package accepts it");
  assert.equal(made.value.entry.seq, 0);
  assert.equal(made.value.entry.prev, undefined);
  assert.deepEqual(made.value.entry.signerDevice, s.bot.id);
  // alice's first device, the bot and alice's recovery key: three seals, each to its own key.
  const named = [
    [s.alice.first.id, receivingOf(s.alice.first)],
    [s.bot.id, receivingOf(s.bot)],
    [s.alice.recovery.recoveryId, receivingOf(s.alice.recovery)],
  ] as const;
  assert.equal(made.value.entry.seals.length, named.length);
  const keys = named.map(([id, name]) => {
    const key = openEpochSeal(platform, name, checked.value, id);
    assert.ok(key.ok, "its seal opens and matches the commitment");
    return key.value;
  });
  assert.deepEqual(keys[0], keys[1]);
  assert.deepEqual(keys[1], keys[2]);
  assert.equal(Object.keys(made.value).includes("key"), false, "the key leaves only in the seals");
});

test("buildEpoch: each epoch has a key of its own, and the next one names the one before and counts the heads again", () => {
  const s = scene();
  const first = s.epoch();
  const { r, view, build } = built(s);
  const a = build();
  const b = build();
  assert.ok(a.ok && b.ok);
  assert.notDeepEqual(a.value.entry.commitment, b.value.entry.commitment, "a fresh key each time");
  assert.equal(a.value.entry.seq, 1);
  assert.deepEqual(a.value.entry.prev, first.id);
  assert.deepEqual(a.value.entry.memberHead, { length: 1, last: view.members[0]?.id });
  assert.deepEqual(a.value.entry.deviceHeads, [
    { person: s.alice.id, length: r.devices.length, last: r.devices.at(-1)?.id },
  ]);
  assert.ok(
    checkEpochEntry(platform, view.epochs, view.members, [r.devices], a.value.signed, a.value.sig)
      .ok,
  );
  // alice's log holds her genesis and the bot's add: the entry says what the device held.
  assert.equal(a.value.entry.deviceHeads[0]?.length, 2);
});

test("buildEpoch fails, as a value, for no member, a member's log twice, or a log missing; it signs nothing", () => {
  const s = scene();
  const { view } = built(s);
  const lost = buildEpoch(platform, view.members, view.epochs, [], {
    person: s.alice.id,
    device: s.bot.id,
    sign: s.bot.sign,
  });
  assert.deepEqual(lost, { ok: false, error: "bad-input" });
  const { r } = built(s);
  const signer = { person: s.alice.id, device: s.bot.id, sign: s.bot.sign };
  assert.deepEqual(buildEpoch(platform, [], [], [r.devices], signer), {
    ok: false,
    error: "bad-input",
  });
  assert.deepEqual(
    buildEpoch(platform, view.members, view.epochs, [r.devices, r.devices], signer),
    { ok: false, error: "bad-input" },
  );
  const noKey = buildEpoch(platform, view.members, view.epochs, [built(s).r.devices], {
    person: s.alice.id,
    device: s.bot.id,
    sign: "a name no key holds",
  });
  assert.equal(noKey.ok, false);
});

const T0 = 1_700_000_000_000;
const e1 = { id: fill(21), entry: {} } as never;
const view = (over = {}) => ({ open: true, epochs: [e1], key: fill(1), ...over });
const clock = (since: number): EpochClock => ({ epoch: fill(21), since });

test("whyStart: no epoch, a closed channel, no key, a rollover and 30 days are the reasons; an open epoch with its key and no age is none (5.4, 5.7)", () => {
  assert.equal(whyStart(view({ epochs: [], key: undefined }), undefined, T0, false), "no-epoch");
  assert.equal(whyStart(view({ open: false }), clock(T0), T0, false), "closed");
  assert.equal(whyStart(view({ key: undefined }), clock(T0), T0, false), "no-key");
  assert.equal(whyStart(view(), clock(T0), T0, true), "rollover");
  assert.equal(whyStart(view(), clock(T0), T0, false), undefined);
  assert.equal(
    whyStart(view(), undefined, T0, false),
    undefined,
    "no clock yet: it counts from its first read",
  );
  assert.equal(whyStart(view({ open: false, key: undefined }), clock(T0), T0, true), "closed");
});

test("whyStart: an epoch is aged at 30 days exactly, and not a millisecond before; a clock of another epoch counts for nothing", () => {
  assert.equal(EPOCH_LIFE_MS, 2_592_000_000);
  assert.equal(whyStart(view(), clock(T0), T0 + EPOCH_LIFE_MS - 1, false), undefined);
  assert.equal(whyStart(view(), clock(T0), T0 + EPOCH_LIFE_MS, false), "aged");
  const old: EpochClock = { epoch: fill(22), since: T0 - 2 * EPOCH_LIFE_MS };
  assert.equal(whyStart(view(), old, T0, false), undefined, "a new epoch starts its own count");
});

test("tickEpoch: the first read of an entry starts its count, a later read keeps it, another epoch restarts it, and a channel with none has none", () => {
  const logged = (id: Uint8Array) => [{ id, entry: {} }] as never;
  const started = tickEpoch(undefined, logged(fill(21)), T0, true);
  assert.deepEqual(started, { epoch: fill(21), since: T0 });
  assert.equal(
    tickEpoch(started, logged(fill(21)), T0 + 5, true),
    started,
    "kept: the first read's time",
  );
  assert.deepEqual(tickEpoch(started, logged(fill(22)), T0 + 9, true), {
    epoch: fill(22),
    since: T0 + 9,
  });
  assert.equal(tickEpoch(started, [], T0, true), undefined);
  // Mid-read the last epoch is only the latest so far: the clock does not move to it.
  assert.equal(tickEpoch(started, logged(fill(22)), T0 + 9, false), started);
  // A bot started again, which reads the sequence from 0 and finds the epoch, keeps the stored time.
  const stored = tickEpoch(
    { epoch: fill(21), since: T0 - EPOCH_LIFE_MS },
    logged(fill(21)),
    T0,
    true,
  );
  assert.equal(whyStart(view(), stored, T0, false), "aged");
});

test("buildEpoch fails for a two-person channel when one person's log is given twice and the other's is missing", () => {
  const s = scene();
  const { r, view } = built(s);
  const bob = person();
  const bobLog: LoggedEntry[] = [];
  const g = checkDeviceEntry(platform, [], bob.genesis.signed, bob.genesis.sig);
  assert.ok(g.ok);
  bobLog.push(g.value);
  const members: LoggedMember[] = [...view.members];
  const push = (e: { signed: Uint8Array; sig: Uint8Array }, devices: LoggedEntry[]) => {
    const v = checkMemberEntry(platform, members, e.signed, e.sig, devices);
    assert.ok(v.ok);
    members.push(v.value);
  };
  push(memberEntry(s.alice, members, { kind: "add", person: bob.id, role: "member" }), [
    ...r.devices,
  ]);
  push(memberEntry(bob, members, { kind: "accept" }), bobLog);
  const signer = { person: s.alice.id, device: s.bot.id, sign: s.bot.sign };
  assert.deepEqual(buildEpoch(platform, members, view.epochs, [r.devices, r.devices], signer), {
    ok: false,
    error: "bad-input",
  });
  assert.equal(buildEpoch(platform, members, view.epochs, [r.devices, bobLog], signer).ok, true);
});
