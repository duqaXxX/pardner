/**
 * Design 6.2, the channel duties on real bytes with no transport: member entries, epochs and
 * messages, and the index of blobs, in the model's order. A test named after one of the model's ends
 * with ` [model]`; the others hold a row of design 6.2, or SD 4's text for the member log (the model
 * has no member log).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { idKey, type LoggedEntry } from "../../src/protocol/device-log.ts";
import { decodeMessage } from "../../src/protocol/messages.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { Code, UnknownItem } from "../../src/relay/sequence.ts";
import { platform } from "./support.ts";
import {
  addBody,
  channelled,
  DEVICE,
  enrolled,
  epochEntry,
  fill,
  type Keyed,
  keyed,
  memberEntry,
  message,
  person,
  signedBy,
} from "./world.ts";

const MEMBER = 2;
const EPOCH = 3;
const MESSAGE = 4;
const hex = (b: Bytes) => Buffer.from(b).toString("hex");

const world = channelled;
type World = Awaited<ReturnType<typeof world>>;

const messageKinds = (w: World) => w.journal.placed.filter((p) => p.kind === MESSAGE).length;

test("6.2 device entry: a device entry closes the epoch of every channel that holds the person (duty 3)", async () => {
  const w = await world();
  const epoch = w.open();
  const m = () => message(w.alice.first, w.channel, epoch, { counter: m.n++ });
  m.n = 1;
  assert.equal(w.send(w.a, MESSAGE, m()).code, Code.accepted);
  w.join(keyed());
  assert.equal(w.send(w.a, MESSAGE, m()).code, Code.closed);
});

test("an epoch with one recipient too many is refused by the relay and by a device [model]", async () => {
  const w = await world();
  const stolen = keyed();
  w.join(stolen);
  const thief = keyed();
  const e = w.epoch(stolen, {}, [{ id: thief.recoveryId, receiving: thief.keys.receiving }]);
  assert.equal(w.send(w.alice.conn(stolen), EPOCH, e).code, Code.refused);
  assert.equal(w.send(w.alice.conn(stolen), EPOCH, w.epoch(stolen)).code, Code.accepted);
});

test("an epoch built on an older state of the logs is refused by the relay [model]", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  const stale = w.epoch(second);
  w.join(keyed());
  assert.equal(w.send(w.alice.conn(second), EPOCH, stale).code, Code.position);
  assert.equal(w.send(w.alice.conn(second), EPOCH, w.epoch(second)).code, Code.accepted);
});

test("6.2 epoch entry: a signer that is not the connection's device is refused, one not active is removed", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  const e = w.epoch(second);
  assert.equal(w.send(w.a, EPOCH, e).code, Code.refused);
  assert.equal(w.send(w.alice.conn(keyed()), EPOCH, e).code, Code.removed);
  const orphan = memberEntry(w.alice, [], { kind: "create", nonce: fill(4, 16) });
  const unknown = { ...w.epoch(), signed: orphan.signed };
  assert.equal(w.send(w.a, EPOCH, unknown).code, Code.refused);
});

test('5.0 duty 5: to an active device, bytes the relay holds are "accepted" though they no longer fit; to a removed device nothing is [model]', async () => {
  const w = await world();
  const other = keyed();
  const added = w.alice.entry(w.log(), addBody(w.alice, other));
  assert.equal(w.send(w.a, DEVICE, added).code, Code.accepted);
  const otherConn = w.alice.conn(other);
  const epoch = w.open(other);
  const m = message(other, w.channel, epoch);
  assert.equal(w.send(otherConn, MESSAGE, m).code, Code.accepted);
  w.join(keyed());
  assert.equal(w.send(otherConn, EPOCH, epoch.entry).code, Code.accepted);
  assert.equal(w.send(w.a, EPOCH, epoch.entry).code, Code.accepted);
  assert.equal(w.send(w.a, DEVICE, added).code, Code.accepted);
  assert.equal(w.send(w.alice.conn(keyed()), DEVICE, added).code, Code.refused);
  w.extend({ kind: "remove", device: other.id });
  assert.equal(w.send(otherConn, EPOCH, epoch.entry).code, Code.removed);
  assert.equal(w.send(otherConn, DEVICE, added).code, Code.removed);
  assert.equal(w.send(otherConn, MESSAGE, m).code, Code.removed);
});

test('5.0 duty 5: a message the relay holds is "accepted" after its epoch closed and ended, and a second use of its counter is refused [model]', async () => {
  const w = await world();
  const epoch = w.open();
  const m = message(w.alice.first, w.channel, epoch);
  assert.equal(w.send(w.a, MESSAGE, m).code, Code.accepted);
  const again = message(w.alice.first, w.channel, epoch, { time: 1_700_000_000_001 });
  assert.equal(w.send(w.a, MESSAGE, again).code, Code.refused);
  w.join(keyed());
  assert.equal(w.send(w.a, MESSAGE, m).code, Code.accepted);
  w.open();
  assert.equal(w.send(w.a, MESSAGE, m).code, Code.accepted);
  assert.equal(messageKinds(w), 1);
});

test("6.2 message: removed, malformed, another sender, ended, closed and badly signed, each with its code", async () => {
  const w = await world();
  const epoch = w.open();
  const m = (over = {}, by = w.alice.first) => message(by, w.channel, epoch, over);
  assert.equal(w.send(w.alice.conn(keyed()), MESSAGE, m()).code, Code.removed);
  assert.equal(
    w.send(w.a, MESSAGE, { signed: new Uint8Array(4), sig: m().sig }).code,
    Code.refused,
  );
  const bot = keyed("bot");
  assert.equal(w.send(w.a, MESSAGE, m({}, bot)).code, Code.refused);
  const forged = signedBy(keyed(), m().signed);
  assert.equal(w.send(w.a, MESSAGE, forged).code, Code.refused);
  const old = message(w.alice.first, w.channel, { id: fill(99), key: epoch.key });
  assert.equal(w.send(w.a, MESSAGE, old).code, Code.ended);
  assert.equal(w.send(w.a, MESSAGE, m({ counter: 2 })).code, Code.accepted);
  w.join(keyed());
  assert.equal(w.send(w.a, MESSAGE, m({ counter: 3 })).code, Code.closed);
  w.open();
  assert.equal(w.send(w.a, MESSAGE, m({ counter: 3 })).code, Code.ended);
});

test("5.12: the relay accepts a message only once it holds its file [model]", async () => {
  const have = new Set<string>();
  const w = await world((blob) => have.has(hex(blob)));
  const epoch = w.open();
  const file = fill(70);
  const m = message(w.alice.first, w.channel, epoch, {}, [file]);
  assert.equal(w.send(w.a, MESSAGE, m).code, Code.missing);
  assert.equal(messageKinds(w), 0);
  have.add(hex(file));
  assert.equal(w.send(w.a, MESSAGE, m).code, Code.accepted);
  assert.equal(messageKinds(w), 1);
});

/** The model's `wanted()` recomputed over the whole sequence: the oracle of the incremental index. */
function recomputed(w: World) {
  const firstAt = new Map<string, number>();
  const lastBuild = new Map<string, number>();
  const msgs = w.journal.placed.flatMap((p) => {
    if (p.kind !== MESSAGE) return [];
    const decoded = decodeMessage(w.journal.read(p.position).signed);
    assert.ok(decoded.ok);
    return [{ at: p.position, h: decoded.value.header }];
  });
  for (const { at, h } of msgs) {
    const key = `${hex(h.sender)}|${hex(h.name)}`;
    if (h.kind !== 12 || firstAt.has(key)) continue;
    firstAt.set(key, at);
    lastBuild.set(hex(h.sender), at);
  }
  const named = new Map<string, boolean>();
  for (const { h } of msgs) {
    const gone =
      h.kind === 12 &&
      firstAt.get(`${hex(h.sender)}|${hex(h.name)}`) !== lastBuild.get(hex(h.sender));
    for (const b of h.blobs) named.set(hex(b), named.get(hex(b)) || !gone);
  }
  return named;
}
function agrees(w: World, blobs: Bytes[]) {
  const oracle = recomputed(w);
  for (const b of blobs) assert.equal(w.seq.wanted(b), oracle.get(hex(b)), hex(b));
  assert.equal(w.seq.wanted(fill(200)), undefined);
}
/** A bot of alice's, added before the epoch, and a way to send its builds. */
async function builds(held: (blob: Bytes) => boolean = () => true) {
  const w = await world(held);
  const bots = [keyed("bot"), keyed("bot")];
  for (const bot of bots) w.join(bot);
  const epoch = w.open();
  let counter = 1;
  const build = (bot: Keyed, name: number, file: number, expected: number = Code.accepted) => {
    const m = message(
      bot,
      w.channel,
      epoch,
      { kind: 12, name: fill(name, 16), counter: counter++ },
      [fill(file)],
    );
    assert.equal(w.send(w.alice.conn(bot), MESSAGE, m).code, expected);
  };
  return { w, bots, build };
}

test("5.12: a build replaces the one before it on the relay [model]", async () => {
  const { w, bots, build } = await builds();
  build(bots[0] as Keyed, 1, 51);
  assert.equal(w.seq.wanted(fill(51)), true);
  build(bots[0] as Keyed, 2, 52);
  assert.equal(w.seq.wanted(fill(51)), false);
  assert.equal(w.seq.wanted(fill(52)), true);
  agrees(w, [fill(51), fill(52)]);
});

test("5.12: a build of one bot does not replace the build of another [model]", async () => {
  const { w, bots, build } = await builds();
  build(bots[0] as Keyed, 1, 51);
  build(bots[1] as Keyed, 2, 52);
  assert.equal(w.seq.wanted(fill(51)), true);
  assert.equal(w.seq.wanted(fill(52)), true);
  agrees(w, [fill(51), fill(52)]);
});

test("5.12 point 8: a build sent again by a bot whose folder went back does not replace a newer build [model]", async () => {
  const absent = new Set<string>();
  const { w, bots, build } = await builds((b) => !absent.has(hex(b)));
  build(bots[0] as Keyed, 1, 51);
  build(bots[0] as Keyed, 2, 52);
  absent.add(hex(fill(51))); // the relay removed the replaced build's blob
  build(bots[0] as Keyed, 1, 51, Code.gone);
  assert.equal(w.seq.wanted(fill(52)), true);
  assert.equal(w.seq.wanted(fill(51)), false);
  agrees(w, [fill(51), fill(52)]);
});

test("5.12 point 8: the index of builds is the same after a start, which places the journal again [model]", async () => {
  const { w, bots, build } = await builds();
  build(bots[0] as Keyed, 1, 51);
  build(bots[1] as Keyed, 3, 53);
  build(bots[0] as Keyed, 2, 52);
  await w.flush();
  const again = await w.restart();
  for (const b of [51, 52, 53]) assert.equal(again.seq.wanted(fill(b)), w.seq.wanted(fill(b)));
  assert.equal(again.seq.wanted(fill(51)), false);
  assert.equal(again.seq.wanted(fill(53)), true);
});

test("6.2 member entry: a create makes the channel, closed until an epoch; the next entries follow it", async () => {
  const w = await world();
  const held = w.seq.channels.get(idKey(w.channel));
  assert.equal(held?.members.length, 1);
  assert.equal(held?.closed, true);
  const second = memberEntry(w.alice, held?.members ?? [], {
    kind: "add",
    person: fill(60),
    role: "member",
  });
  assert.equal(w.send(w.a, MEMBER, second).code, Code.accepted);
  assert.equal(w.send(w.a, MEMBER, second).code, Code.accepted);
  assert.equal(w.send(w.a, MEMBER, w.create).code, Code.accepted);
  assert.equal(w.seq.channels.get(idKey(w.channel))?.members.length, 2);
  assert.equal(w.journal.placed.filter((p) => p.kind === MEMBER).length, 2);
});

test("6.2 member entry: another signer device or person, a channel it does not hold and a taken position are refused", async () => {
  const w = await world();
  const other = keyed();
  w.join(other);
  const log = w.seq.channels.get(idKey(w.channel))?.members ?? [];
  const body = { kind: "add", person: fill(60), role: "member" };
  const entry = memberEntry(w.alice, log, body);
  const late = memberEntry(w.alice, log.slice(), { kind: "add", person: fill(61), role: "member" });
  assert.equal(w.send(w.alice.conn(other), MEMBER, entry).code, Code.refused);
  assert.equal(
    w.send({ person: fill(1), device: w.alice.first.id }, MEMBER, entry).code,
    Code.refused,
  );
  const lost = memberEntry(w.alice, [{ id: fill(77) }], body);
  assert.equal(w.send(w.a, MEMBER, lost).code, Code.refused);
  assert.equal(w.send(w.alice.conn(keyed()), MEMBER, entry).code, Code.removed);
  assert.equal(w.send(w.a, MEMBER, entry).code, Code.accepted);
  assert.equal(w.send(w.a, MEMBER, late).code, Code.position);
});

test("6.2 member entry: an accept changes the set and closes the channel's epoch (duty 3)", async () => {
  const w = await world();
  const bob = person();
  const members = w.seq.channels.get(idKey(w.channel))?.members ?? [];
  const add = memberEntry(w.alice, members, { kind: "add", person: bob.id, role: "member" });
  assert.equal(w.send(w.a, MEMBER, add).code, Code.accepted);
  await w.flush();
  // Bob's log is placed through the journal, as a relay that held two persons would hold it.
  w.journal.append({ kind: DEVICE, signed: bob.genesis.signed, sig: bob.genesis.sig });
  const started = await w.restart();
  const epoch = epochEntry(started.seq, w.channel, { person: w.alice, device: w.alice.first }, [
    w.alice,
  ]);
  assert.equal(started.seq.submit(w.a, EPOCH, epoch.signed, epoch.sig).code, Code.accepted);
  const m = message(w.alice.first, w.channel, {
    id: platform.sha256(epoch.signed),
    key: epoch.key,
  });
  assert.equal(started.seq.submit(w.a, MESSAGE, m.signed, m.sig).code, Code.accepted);
  const accept = memberEntry(bob, started.seq.channels.get(idKey(w.channel))?.members ?? [], {
    kind: "accept",
  });
  assert.equal(
    started.seq.submit(bob.conn(), MEMBER, accept.signed, accept.sig).code,
    Code.accepted,
  );
  const next = message(
    w.alice.first,
    w.channel,
    { id: platform.sha256(epoch.signed), key: epoch.key },
    { counter: 2 },
  );
  assert.equal(started.seq.submit(w.a, MESSAGE, next.signed, next.sig).code, Code.closed);
});

test("F2, 5.12 point 8: a replaced build's blob is still wanted as of what is on disk, until the new build is", async () => {
  const { w, bots, build } = await builds();
  build(bots[0] as Keyed, 1, 51);
  await w.flush();
  w.pending.hold = true;
  build(bots[0] as Keyed, 2, 52);
  assert.equal(w.seq.wanted(fill(51)), false);
  assert.equal(w.seq.wanted(fill(51), "durable"), true);
  assert.equal(w.seq.wanted(fill(52), "durable"), undefined);
  w.pending.hold = false;
  w.pending.release?.();
  await w.flush();
  assert.equal(w.seq.wanted(fill(51), "durable"), false);
  assert.equal(w.seq.wanted(fill(52), "durable"), true);
});

test("SD 5.6: a message for a channel the relay does not hold is refused, not told to wait for an epoch", async () => {
  const w = await world();
  const e = w.open();
  const m = message(w.alice.first, fill(77), e);
  assert.equal(w.send(w.a, MESSAGE, m).code, Code.refused);
});

test("SD 5.12 point 4 [model]: a copy of a replaced build whose blob is not on disk is gone, not missing; one whose blob is on disk is placed", async () => {
  const absent = new Set<string>();
  const { w, bots, build } = await builds((b) => !absent.has(hex(b)));
  build(bots[0] as Keyed, 1, 51);
  build(bots[0] as Keyed, 2, 52);
  build(bots[1] as Keyed, 1, 53);
  await w.flush();
  assert.equal(w.seq.wanted(fill(51), "durable"), false);
  build(bots[0] as Keyed, 1, 51); // still on disk: the model places it
  assert.equal(messageKinds(w), 4);
  absent.add(hex(fill(51))); // PR 4 removes it at the round
  build(bots[0] as Keyed, 1, 51, Code.gone);
  assert.equal(messageKinds(w), 4);
});

test("SD 5.12 point 3: a blob not on disk that a message still wants is missing, not gone", async () => {
  const absent = new Set<string>();
  const { w, bots, build } = await builds((b) => !absent.has(hex(b)));
  absent.add(hex(fill(52)));
  build(bots[0] as Keyed, 2, 52, Code.missing);
  assert.equal(messageKinds(w), 0);
});

/** Bob's log, journaled as a relay holding two persons would have it, with `shared` added to it. */
async function withBob(w: World, shared?: Keyed) {
  const bob = person();
  await w.flush();
  w.journal.append({ kind: DEVICE, signed: bob.genesis.signed, sig: bob.genesis.sig });
  const started = await w.restart();
  if (shared) {
    const add = bob.add(started.seq.devices.get(idKey(bob.id)) as LoggedEntry[], shared);
    assert.equal(started.seq.submit(bob.conn(), DEVICE, add.signed, add.sig).code, Code.accepted);
  }
  return { bob, seq: started.seq };
}

test("6.2 epoch entry: a signer person that is not the connection's person is refused", async () => {
  const w = await world();
  const { bob, seq } = await withBob(w, w.alice.first);
  const e = epochEntry(seq, w.channel, { person: w.alice, device: w.alice.first }, [w.alice]);
  const theirs = { person: bob.id, device: w.alice.first.id };
  assert.equal(seq.submit(theirs, EPOCH, e.signed, e.sig).code, Code.refused);
  assert.equal(seq.submit(w.a, EPOCH, e.signed, e.sig).code, Code.accepted);
});

/** Two channels alice created, each with an epoch. */
async function twoChannels(w: Awaited<ReturnType<typeof enrolled>>) {
  return [3, 4].map((n) => {
    const c = memberEntry(w.alice, [], { kind: "create", nonce: fill(n, 16) });
    assert.equal(w.send(w.a, MEMBER, c).code, Code.accepted);
    const channel = platform.sha256(c.signed);
    const e = epochEntry(w.seq, channel, { person: w.alice, device: w.alice.first }, [w.alice]);
    assert.equal(w.send(w.a, EPOCH, e).code, Code.accepted);
    return channel;
  });
}

test("duty 3: a device entry closes every channel of the person, not only the first", async () => {
  const w = await enrolled();
  const ids = await twoChannels(w);
  w.join(keyed());
  for (const c of ids) assert.equal(w.seq.channels.get(idKey(c))?.closed, true);
});

test("duty 3: a device entry of a member who joined, not the creator, closes the channel", async () => {
  const w = await world();
  const bob = person();
  const members = () => w.seq.channels.get(idKey(w.channel))?.members ?? [];
  const invite = memberEntry(w.alice, members(), { kind: "add", person: bob.id, role: "member" });
  assert.equal(w.send(w.a, MEMBER, invite).code, Code.accepted);
  await w.flush();
  w.journal.append({ kind: DEVICE, signed: bob.genesis.signed, sig: bob.genesis.sig });
  const s = (await w.restart()).seq;
  const joined = () => s.channels.get(idKey(w.channel))?.members ?? [];
  const accept = memberEntry(bob, joined(), { kind: "accept" });
  assert.equal(s.submit(bob.conn(), MEMBER, accept.signed, accept.sig).code, Code.accepted);
  const e = epochEntry(s, w.channel, { person: w.alice, device: w.alice.first }, [w.alice, bob]);
  assert.equal(s.submit(w.a, EPOCH, e.signed, e.sig).code, Code.accepted);
  assert.equal(s.channels.get(idKey(w.channel))?.closed, false);
  const add = bob.add(s.devices.get(idKey(bob.id)) as LoggedEntry[], keyed());
  assert.equal(s.submit(bob.conn(), DEVICE, add.signed, add.sig).code, Code.accepted);
  assert.equal(s.channels.get(idKey(w.channel))?.closed, true);
  // The epoch after the accept: a remove of the member closes it, an invite does not.
  const next = epochEntry(s, w.channel, { person: w.alice, device: w.alice.first }, [w.alice, bob]);
  assert.equal(s.submit(w.a, EPOCH, next.signed, next.sig).code, Code.accepted);
  const another = memberEntry(w.alice, joined(), { kind: "add", person: fill(61), role: "member" });
  assert.equal(s.submit(w.a, MEMBER, another.signed, another.sig).code, Code.accepted);
  assert.equal(s.channels.get(idKey(w.channel))?.closed, false);
  const remove = memberEntry(w.alice, joined(), { kind: "remove", person: bob.id });
  assert.equal(s.submit(w.a, MEMBER, remove.signed, remove.sig).code, Code.accepted);
  assert.equal(s.channels.get(idKey(w.channel))?.closed, true);
});

test("6.2 message: a message in a second epoch, its counter starting again, is accepted", async () => {
  const w = await world();
  const e1 = w.open();
  assert.equal(w.send(w.a, MESSAGE, message(w.alice.first, w.channel, e1)).code, Code.accepted);
  w.join(keyed());
  const e2 = w.open();
  assert.equal(w.send(w.a, MESSAGE, message(w.alice.first, w.channel, e2)).code, Code.accepted);
});

test("6.2 epoch entry: an epoch built before a member entry that changes no set is stale", async () => {
  const w = await world();
  const e = w.epoch();
  const members = w.seq.channels.get(idKey(w.channel))?.members ?? [];
  const add = memberEntry(w.alice, members, { kind: "add", person: fill(60), role: "member" });
  assert.equal(w.send(w.a, MEMBER, add).code, Code.accepted);
  assert.equal(w.send(w.a, EPOCH, e).code, Code.position);
});

test("6.2 message: a message of one device sent over another device's connection is refused", async () => {
  const w = await world();
  const two = keyed();
  w.join(two);
  const e = w.open();
  assert.equal(w.send(w.a, MESSAGE, message(two, w.channel, e)).code, Code.refused);
});

test("6.2 message: a message of an ended epoch on a closed channel is ended, not closed", async () => {
  const w = await world();
  const e1 = w.open();
  w.join(keyed());
  const m = message(w.alice.first, w.channel, { id: fill(99), key: e1.key });
  assert.equal(w.send(w.a, MESSAGE, m).code, Code.ended);
});

test("6.2 member entry: a signer person that is not the connection's person is refused", async () => {
  const w = await world();
  const { bob, seq } = await withBob(w, w.alice.first);
  const members = seq.channels.get(idKey(w.channel))?.members ?? [];
  const add = memberEntry(w.alice, members, { kind: "add", person: fill(60), role: "member" });
  const theirs = { person: bob.id, device: w.alice.first.id };
  assert.equal(seq.submit(theirs, MEMBER, add.signed, add.sig).code, Code.refused);
});

test("6.2 epoch entry: an epoch whose prev is not the last epoch is a taken position", async () => {
  const w = await world();
  w.open();
  const bad = w.epoch(w.alice.first, { prev: fill(88) });
  assert.equal(w.send(w.a, EPOCH, bad).code, Code.position);
});

test("5.10: a start that finds an item of an unknown kind whose bytes decode says so", async () => {
  const w = await world();
  const e = w.open();
  w.journal.append({ kind: 5, ...message(w.alice.first, w.channel, e) });
  await w.flush();
  await assert.rejects(w.restart(), UnknownItem);
});

test("5.10: a start that finds a member entry that no longer checks says so", async () => {
  const w = await world();
  const stray = memberEntry(w.alice, [{ id: fill(77) }], {
    kind: "add",
    person: fill(60),
    role: "member",
  });
  w.journal.append({ kind: MEMBER, ...stray });
  await w.flush();
  await assert.rejects(w.restart(), UnknownItem);
});
