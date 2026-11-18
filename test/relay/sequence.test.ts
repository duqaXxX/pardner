/**
 * Design 6.2 and 6.6, the device log's duties on real bytes with no transport: each frame's
 * evaluation, in the model's order. A test named after one of the model's ends with ` [model]`; the
 * others hold a row of design 6.2.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { idKey, type LoggedEntry } from "../../src/protocol/device-log.ts";
import { checkHead } from "../../src/protocol/proofs.ts";
import { Code, UnknownItem } from "../../src/relay/sequence.ts";
import { makeProof } from "../protocol/proof.ts";
import { platform } from "./support.ts";
import type { Keyed } from "./world.ts";
import { addBody, DEVICE, enrolled, fill, keyed, person, rig, served, signedBy } from "./world.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ok = () => true;

test("6.6: a genesis is placed once; the same again places nothing; another, once a log is held, nothing", async () => {
  const r = await rig();
  const alice = person();
  const ticket = r.seq.enrol(alice.genesis.signed, alice.genesis.sig, ok);
  assert.equal(ticket, r.s.rounds.written);
  assert.equal(r.journal.placed.length, 1);
  assert.equal(r.journal.placed[0]?.kind, DEVICE);
  assert.equal(typeof r.seq.enrol(alice.genesis.signed, alice.genesis.sig, ok), "number");
  const bob = person();
  assert.equal(r.seq.enrol(bob.genesis.signed, bob.genesis.sig, ok), null);
  assert.equal(r.journal.placed.length, 1);
});

test("6.6: the secret is checked after the identical genesis and the empty journal, and before the genesis itself", async () => {
  const r = await rig();
  const alice = person();
  const asked: string[] = [];
  const check = (answer: boolean) => () => {
    asked.push("secret");
    return answer;
  };
  assert.equal(r.seq.enrol(new Uint8Array(5), alice.genesis.sig, check(false)), null);
  assert.deepEqual(asked, ["secret"], "asked before the genesis is looked at");
  assert.equal(r.seq.enrol(alice.genesis.signed, alice.genesis.sig, check(false)), null);
  assert.equal(r.journal.placed.length, 0, "a secret that does not hold places nothing");
  assert.equal(typeof r.seq.enrol(alice.genesis.signed, alice.genesis.sig, check(true)), "number");
  asked.length = 0;
  r.seq.enrol(alice.genesis.signed, alice.genesis.sig, check(false));
  const bob = person();
  r.seq.enrol(bob.genesis.signed, bob.genesis.sig, check(true));
  assert.deepEqual(asked, [], "not asked for a genesis held, nor once a log is held");
});

test("6.1: standing carries the id of the current recovery key", async () => {
  const w = await enrolled();
  assert.deepEqual(w.seq.standing(w.alice.id)?.recoveryId, w.alice.recovery.recoveryId);
});

test("6.6: a genesis that is malformed, not signed by its own device or not a genesis places nothing", async () => {
  const r = await rig();
  const alice = person();
  assert.equal(r.seq.enrol(new Uint8Array(5), alice.genesis.sig, ok), null);
  const forged = signedBy(keyed(), alice.genesis.signed);
  assert.equal(r.seq.enrol(forged.signed, forged.sig, ok), null);
  const add = alice.add([{ id: alice.id } as LoggedEntry], keyed());
  assert.equal(r.seq.enrol(add.signed, add.sig, ok), null);
  assert.equal(r.journal.placed.length, 0);
});

test("6.2: a placed entry's answer waits for its own ticket, and a refusal for what is written", async () => {
  const w = await enrolled();
  const before = w.s.rounds.synced;
  const out = w.extend(addBody(w.alice, keyed()));
  assert.equal(out.ticket, w.s.rounds.written);
  assert.ok(out.ticket > before);
  const refused = w.send(w.a, DEVICE, w.alice.entry(w.log(), { kind: "remove", device: fill(1) }));
  assert.equal(refused.code, Code.refused);
  assert.equal(refused.ticket, w.s.rounds.written);
  await w.flush();
  assert.ok(w.s.rounds.synced >= out.ticket);
});

test("6.2 device entry: the signer must be the connection's device, and a stale position is taken", async () => {
  const w = await enrolled();
  const other = keyed();
  w.join(other);
  const stale = w.alice.entry(w.log().slice(0, 1), { kind: "remove", device: other.id });
  assert.equal(w.send(w.a, DEVICE, stale).code, Code.position);
  const byOther = w.alice.entry(w.log(), addBody(w.alice, keyed()), other);
  assert.equal(w.send(w.a, DEVICE, byOther).code, Code.refused);
  assert.equal(w.send(w.alice.conn(other), DEVICE, byOther).code, Code.accepted);
  assert.equal(w.send(w.a, 9, byOther).code, Code.refused);
});

test("6.2 device entry: a removal names the devices it removes, a reset those it leaves out", async () => {
  const w = await enrolled();
  const other = keyed();
  const third = keyed();
  w.join(other);
  w.join(third);
  const out = w.extend({ kind: "remove", device: other.id });
  assert.deepEqual(out.removed.map(hex), [hex(other.id)]);
  assert.equal(w.extend(addBody(w.alice, keyed())).removed.length, 0);
  const fresh = keyed();
  const reset = w.alice.entry(
    w.log(),
    {
      kind: "reset",
      set: [fresh.id],
      newDevice: {
        device: fresh.device,
        proof: makeProof(platform, fresh.sign, w.alice.id, fresh.device),
      },
    },
    w.alice.recovery,
  );
  const done = w.send(
    { ...w.alice.conn(fresh), recovery: w.alice.recovery.recoveryId },
    DEVICE,
    reset,
  );
  assert.equal(done.code, Code.accepted);
  assert.equal(done.removed.length, 3);
  assert.ok(done.removed.some((id) => hex(id) === hex(w.alice.first.id)));
});

test("5.10: the relay takes a reset from a device in no log only with the recovery proof [model]", async () => {
  const w = await enrolled();
  const fresh = keyed();
  const reset = w.alice.entry(
    w.log(),
    {
      kind: "reset",
      set: [fresh.id],
      newDevice: {
        device: fresh.device,
        proof: makeProof(platform, fresh.sign, w.alice.id, fresh.device),
      },
    },
    w.alice.recovery,
  );
  assert.equal(w.send(w.alice.conn(fresh), DEVICE, reset).code, Code.refused);
  assert.equal(
    w.send({ ...w.alice.conn(fresh), recovery: fill(8) }, DEVICE, reset).code,
    Code.refused,
  );
  const proven = { ...w.alice.conn(fresh), recovery: w.alice.recovery.recoveryId };
  assert.equal(w.send(proven, DEVICE, reset).code, Code.accepted);
});

test("5.10: with the recovery proof the relay takes only the reset that names the device that brings it [model]", async () => {
  const w = await enrolled();
  const fresh = keyed();
  const other = keyed();
  const reset = w.alice.entry(
    w.log(),
    {
      kind: "reset",
      set: [other.id],
      newDevice: {
        device: other.device,
        proof: makeProof(platform, other.sign, w.alice.id, other.device),
      },
    },
    w.alice.recovery,
  );
  const proven = { ...w.alice.conn(fresh), recovery: w.alice.recovery.recoveryId };
  assert.equal(w.send(proven, DEVICE, reset).code, Code.refused);
});

test("5.0 duty 5: a removed device that brings the recovery proof is refused, even for a reset the relay holds [model]", async () => {
  const w = await enrolled();
  const fresh = keyed();
  const reset = w.alice.entry(
    w.log(),
    {
      kind: "reset",
      set: [fresh.id],
      newDevice: {
        device: fresh.device,
        proof: makeProof(platform, fresh.sign, w.alice.id, fresh.device),
      },
    },
    w.alice.recovery,
  );
  const proven = { ...w.alice.conn(fresh), recovery: w.alice.recovery.recoveryId };
  assert.equal(w.send(proven, DEVICE, reset).code, Code.accepted);
  const gone = w.alice.entry(w.log(), { kind: "remove", device: fresh.id }, fresh);
  assert.equal(w.send(w.alice.conn(fresh), DEVICE, gone).code, Code.accepted);
  assert.equal(w.send(proven, DEVICE, reset).code, Code.removed);
});

test("F2, 5.10: an item written and not yet on disk is given to no device; the head signs only what is on disk [model]", async () => {
  const w = await enrolled();
  w.join(keyed());
  await w.flush();
  const len = w.journal.placed.length;
  w.pending.hold = true;
  const out = w.join(keyed());
  assert.equal(w.journal.placed.length, len + 1);
  const read = served(w.seq.fetch(w.a, 0));
  assert.equal(read.head.n, len);
  assert.equal([...read.items()].length, len);
  assert.ok(checkHead(platform, w.publicKey, read.head, read.sig));
  w.pending.hold = false;
  w.pending.release?.();
  await w.s.rounds.wait(out.ticket);
  const later = served(w.seq.fetch(w.a, len));
  assert.equal(later.head.n, len + 1);
  assert.deepEqual(
    [...later.items()].map((i) => i.position),
    [len],
  );
});

test("6.3 every read at one length is given the same signed head: it is signed once (C6)", async () => {
  const w = await enrolled();
  w.join(keyed());
  await w.flush();
  const first = served(w.seq.fetch(w.a, 0));
  const second = served(w.seq.fetch(w.a, 1));
  assert.equal(second.sig, first.sig, "the signature of the head at this length is kept");
  assert.ok(checkHead(platform, w.publicKey, second.head, second.sig));
  w.join(keyed());
  await w.flush();
  assert.notEqual(served(w.seq.fetch(w.a, 0)).sig, first.sig, "a longer sequence has its own head");
});

test("F2: a relay that restarts with no power cut keeps what it wrote, and gives it [model]", async () => {
  const w = await enrolled();
  const added = w.alice.entry(w.log(), addBody(w.alice, keyed()));
  assert.equal(w.send(w.a, DEVICE, added).code, Code.accepted);
  await w.flush();
  const again = await w.restart();
  const count = again.journal.placed.length;
  assert.equal(again.seq.submit(w.a, DEVICE, added.signed, added.sig).code, Code.accepted);
  assert.equal(again.journal.placed.length, count);
  const read = served(again.seq.fetch(w.a, 0));
  assert.equal(read.head.n, count);
  assert.equal(again.seq.devices.get(idKey(w.alice.id))?.length, w.log().length);
});

test("6.2 read: the head names the relay and holds the running hash; a removed device gets none", async () => {
  const w = await enrolled();
  w.join(keyed());
  await w.flush();
  const read = served(w.seq.fetch(w.a, 1));
  assert.deepEqual(hex(read.head.relay), hex(w.relay));
  assert.deepEqual(hex(read.head.chain), hex(w.journal.chain));
  assert.deepEqual(
    [...read.items()].map((i) => i.position),
    [1],
  );
  assert.equal(w.seq.fetch(w.alice.conn(keyed()), 0).removed, true);
});

test("3.6: a read answers removed on a removal not yet on disk, with the ticket that covers it", async () => {
  const w = await enrolled();
  const other = keyed();
  w.join(other);
  await w.flush();
  w.pending.hold = true;
  const out = w.extend({ kind: "remove", device: other.id });
  const answer = w.seq.fetch(w.alice.conn(other), 0);
  assert.equal(answer.removed, true);
  assert.ok(answer.ticket >= out.ticket, "the answer waits for the removal's round");
  assert.ok(answer.ticket > w.s.rounds.synced);
});

test("5.0 duty 5, 6: a device the log removed gets no read, a device it never named gets none", async () => {
  const w = await enrolled();
  const other = keyed();
  w.join(other);
  assert.equal(w.seq.fetch(w.alice.conn(other), 0).removed, false);
  w.extend({ kind: "remove", device: other.id });
  assert.equal(w.seq.fetch(w.alice.conn(other), 0).removed, true);
  assert.equal(w.seq.fetch(w.alice.conn(keyed()), 0).removed, true);
});

test("6.6, 3.6: a retried enrolment waits for the round that holds the first", async () => {
  const r = await rig();
  const alice = person();
  r.pending.hold = true;
  const first = r.seq.enrol(alice.genesis.signed, alice.genesis.sig, ok);
  const retry = r.seq.enrol(alice.genesis.signed, alice.genesis.sig, ok);
  assert.ok(typeof first === "number" && typeof retry === "number");
  assert.ok(retry >= first && retry > r.s.rounds.synced);
});

test("3.6: bytes the relay holds are accepted only after the round that holds them", async () => {
  const w = await enrolled();
  w.pending.hold = true;
  const added = w.alice.entry(w.log(), addBody(w.alice, keyed()));
  const placed = w.send(w.a, DEVICE, added);
  const again = w.send(w.a, DEVICE, added);
  assert.equal(again.code, Code.accepted);
  assert.ok(again.ticket >= placed.ticket && again.ticket > w.s.rounds.synced);
});

test("5.10: a reset that names a new recovery key makes it the one that proves, and the old one stops", async () => {
  const w = await enrolled();
  const fresh = keyed();
  const next = keyed();
  const body = (newRecovery?: Keyed["keys"]) => ({
    kind: "reset",
    set: [fresh.id],
    newDevice: {
      device: fresh.device,
      proof: makeProof(platform, fresh.sign, w.alice.id, fresh.device),
    },
    recovery: newRecovery,
  });
  const old = { ...w.alice.conn(fresh), recovery: w.alice.recovery.recoveryId };
  const reset = w.alice.entry(w.log(), body(next.keys), w.alice.recovery);
  assert.equal(w.send(old, DEVICE, reset).code, Code.accepted);
  const other = keyed();
  const second = w.alice.entry(
    w.log(),
    {
      kind: "reset",
      signer: next.recoveryId,
      set: [other.id],
      newDevice: {
        device: other.device,
        proof: makeProof(platform, other.sign, w.alice.id, other.device),
      },
    },
    next,
  );
  assert.equal(
    w.send({ ...w.alice.conn(other), recovery: w.alice.recovery.recoveryId }, DEVICE, second).code,
    Code.refused,
  );
  assert.equal(
    w.send({ ...w.alice.conn(other), recovery: next.recoveryId }, DEVICE, second).code,
    Code.accepted,
  );
});

test("6.2 read: an offset that is no position is refused at the boundary", async () => {
  const w = await enrolled();
  for (const from of [-1, 1.5, Number.NaN, 2 ** 53])
    assert.throws(() => w.seq.fetch(w.a, from), RangeError);
});

test("5.10: a start that finds an item of a kind this part does not place says so", async () => {
  const w = await enrolled();
  w.journal.append({ kind: 2, signed: new Uint8Array(3), sig: new Uint8Array(64) });
  await w.flush();
  await assert.rejects(w.restart(), UnknownItem);
});

test("5.10: a start that finds a device entry filed under another kind says so", async () => {
  const w = await enrolled();
  w.journal.append({ kind: 5, ...w.alice.genesis });
  await w.flush();
  await assert.rejects(w.restart(), UnknownItem);
});

test("6.2 recovery log: the person's entries as signed, only those a completed round covers, null for a person not held", async () => {
  const w = await enrolled();
  await w.flush();
  const entries = () => [...(w.seq.recoveryLog(w.alice.id) ?? [])];
  w.pending.hold = true;
  w.join(keyed());
  assert.equal(entries().length, 1, "the add is not on disk");
  assert.deepEqual(entries()[0]?.signed, w.alice.genesis.signed);
  w.pending.hold = false;
  w.pending.release?.();
  await w.flush();
  assert.equal(entries().length, 2);
  assert.equal(w.seq.recoveryLog(fill(1)), null);
});

test("6.2 recovery on disk: the id of the recovery key the entries on disk hold, null for a person not held", async () => {
  const w = await enrolled();
  await w.flush();
  assert.deepEqual(w.seq.recoveryOnDisk(w.alice.id), w.alice.recovery.recoveryId);
  assert.equal(w.seq.recoveryOnDisk(fill(1)), null);
});
