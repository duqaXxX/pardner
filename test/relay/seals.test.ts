/**
 * Design 3.4 and 6.2, the history seals: kept for each epoch, recipient and maker, given back only
 * once on disk, read at start with the journal's rule for a bad entry. A test named after one of
 * the model's ends with ` [model]`.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { encodeHistorySeal } from "../../src/protocol/epochs.ts";
import { fileHeader } from "../../src/relay/journal.ts";
import { Seals } from "../../src/relay/seals.ts";
import { SealsFile } from "../../src/relay/seals-file.ts";
import { Code } from "../../src/relay/sequence.ts";
import { makeProof } from "../protocol/proof.ts";
import { openAppending, platform } from "./support.ts";
import {
  channelled,
  DEVICE,
  epochEntry,
  fill,
  type Keyed,
  keyed,
  memberEntry,
  person,
  signedBy,
} from "./world.ts";

/** A relay with alice's channel and a seals file, and a way to make a seal of her key for a device. */
async function world() {
  const w = await channelled();
  const path = join(w.dir, "seals");
  const seals = await Seals.open(
    platform,
    w.s.rounds,
    w.seq,
    openAppending(path),
    w.relay,
    w.s.log,
  );
  const epoch = w.open().id;
  const seal = (maker: Keyed, recipient: Keyed, over = {}, by: Keyed = maker) =>
    signedBy(
      by,
      encodeHistorySeal({
        channel: w.channel,
        epoch,
        recipient: recipient.id,
        enc: recipient.keys.receiving,
        sealed: fill(7, 48),
        maker: maker.id,
        ...over,
      }),
    );
  return { ...w, seals, path, epoch, seal };
}

test("6.2 give seal: an active device's seal is kept, answered after its round, and served", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  const s = w.seal(w.alice.first, second);
  await w.flush();
  w.pending.hold = true;
  const out = w.seals.give(w.a, s.signed, s.sig);
  assert.equal(out.code, Code.accepted);
  assert.ok(out.ticket > w.s.rounds.synced);
  assert.deepEqual(w.seals.list(w.a), [], "a seal not on disk is given to no device");
  w.pending.hold = false;
  w.pending.release?.();
  await w.s.rounds.wait(out.ticket);
  assert.deepEqual(w.seals.list(w.a), [s]);
});

test("5.0 duty 5: the relay refuses a history seal from a removed device [model]", async () => {
  const w = await world();
  const gone = keyed();
  w.join(gone);
  w.extend({ kind: "remove", device: gone.id });
  const s = w.seal(gone, w.alice.first);
  assert.equal(w.seals.give(w.alice.conn(gone), s.signed, s.sig).code, Code.refused);
  assert.deepEqual(w.seals.list(w.a), []);
});

test("6.2 give seal: a seal another device made, one badly signed or one that does not decode is refused", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  const other = w.seal(second, w.alice.first);
  assert.equal(w.seals.give(w.a, other.signed, other.sig).code, Code.refused);
  const forged = w.seal(w.alice.first, second, {}, keyed());
  assert.equal(w.seals.give(w.a, forged.signed, forged.sig).code, Code.refused);
  assert.equal(w.seals.give(w.a, new Uint8Array(3), forged.sig).code, Code.refused);
  assert.equal(w.seals.give(w.alice.conn(keyed()), other.signed, other.sig).code, Code.refused);
  assert.deepEqual(w.seals.list(w.a), []);
});

test("3.4: one seal is kept for each epoch, recipient and maker; the same again is accepted and appended once", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  const s = w.seal(w.alice.first, second);
  const again = w.seal(w.alice.first, second, { sealed: fill(8, 48) });
  assert.equal(w.seals.give(w.a, s.signed, s.sig).code, Code.accepted);
  const size = statSync(w.path).size;
  const second2 = w.seals.give(w.a, again.signed, again.sig);
  assert.equal(second2.code, Code.accepted);
  assert.ok(second2.ticket >= w.s.rounds.written);
  assert.equal(statSync(w.path).size, size);
  await w.flush();
  assert.deepEqual(w.seals.list(w.a), [s]);
  const other = w.seal(w.alice.first, w.alice.first);
  assert.equal(w.seals.give(w.a, other.signed, other.sig).code, Code.accepted);
  await w.flush();
  assert.equal(w.seals.list(w.a).length, 2);
});

test("3.4: the seals are read back at start in the order taken", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  const a = w.seal(w.alice.first, second);
  const b = w.seal(w.alice.first, w.alice.first);
  w.seals.give(w.a, a.signed, a.sig);
  w.seals.give(w.a, b.signed, b.sig);
  await w.flush();
  const again = await Seals.open(
    platform,
    w.s.rounds,
    w.seq,
    openAppending(w.path),
    w.relay,
    w.s.log,
  );
  assert.deepEqual(again.list(w.a), [a, b]);
});

test("3.4: a torn tail, a bad check and another relay's header end the file where it stops being whole", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  const a = w.seal(w.alice.first, second);
  const b = w.seal(w.alice.first, w.alice.first);
  w.seals.give(w.a, a.signed, a.sig);
  w.seals.give(w.a, b.signed, b.sig);
  await w.flush();
  const whole = readFileSync(w.path);
  const cut = whole.subarray(0, whole.length - 5);
  writeFileSync(w.path, cut);
  const torn = await Seals.open(
    platform,
    w.s.rounds,
    w.seq,
    openAppending(w.path),
    w.relay,
    w.s.log,
  );
  assert.deepEqual(torn.list(w.a), [a]);
  assert.ok(statSync(w.path).size < cut.length, "the tail is truncated");
  const bad = Buffer.from(whole);
  bad.writeUInt8((bad.at(-1) ?? 0) ^ 1, bad.length - 1);
  writeFileSync(w.path, bad);
  assert.deepEqual(
    (await Seals.open(platform, w.s.rounds, w.seq, openAppending(w.path), w.relay, w.s.log)).list(
      w.a,
    ),
    [a],
  );
  writeFileSync(w.path, fileHeader("seals", fill(9)));
  await assert.rejects(
    Seals.open(platform, w.s.rounds, w.seq, openAppending(w.path), w.relay, w.s.log),
  );
});

test("6.2 read: a removed device is given no seals", async () => {
  const w = await world();
  assert.deepEqual(w.seals.list(w.alice.conn(keyed())), []);
});

test("duty 6: what the relay keeps is a copy, so a frame buffer that is reused changes nothing served", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  const s = w.seal(w.alice.first, second);
  const signed = Uint8Array.from(s.signed);
  const sig = Uint8Array.from(s.sig);
  assert.equal(w.seals.give(w.a, signed, sig).code, Code.accepted);
  signed.fill(0);
  sig.fill(0);
  await w.flush();
  assert.deepEqual(w.seals.list(w.a), [s]);
});

test("5.3 step 6: a history seal that does not match the commitment is never taken as the key: two makers and two epochs are all kept, in order [model]", async () => {
  const w = await world();
  const dishonest = keyed();
  const late = keyed();
  w.join(dishonest);
  w.join(late);
  const wrong = w.seal(dishonest, late, { sealed: fill(1, 48) });
  const right = w.seal(w.alice.first, late, { sealed: fill(2, 48) });
  const next = w.seal(w.alice.first, late, { epoch: w.open().id });
  for (const [conn, s] of [
    [w.alice.conn(dishonest), wrong],
    [w.a, right],
    [w.a, next],
  ] as const) {
    assert.equal(w.seals.give(conn, s.signed, s.sig).code, Code.accepted);
  }
  await w.flush();
  assert.deepEqual(w.seals.list(w.alice.conn(late)), [wrong, right, next]);
});

test("5.0 duty 5, 6: a device removed after seals exist is given none and gives none; its earlier seal stays for the others", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  const s = w.seal(second, w.alice.first);
  assert.equal(w.seals.give(w.alice.conn(second), s.signed, s.sig).code, Code.accepted);
  await w.flush();
  assert.equal(w.seals.list(w.alice.conn(second)).length, 1);
  w.extend({ kind: "remove", device: second.id });
  assert.deepEqual(w.seals.list(w.alice.conn(second)), []);
  assert.equal(w.seals.give(w.alice.conn(second), s.signed, s.sig).code, Code.refused);
  assert.deepEqual(w.seals.list(w.a), [s]);
});

test("3.6: a seal held again, and a refusal, wait for everything written", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  const s = w.seal(w.alice.first, second);
  w.pending.hold = true;
  const first = w.seals.give(w.a, s.signed, s.sig);
  const again = w.seals.give(w.a, s.signed, s.sig);
  assert.ok(again.ticket >= first.ticket && again.ticket > w.s.rounds.synced);
  assert.equal(w.seals.give(w.a, new Uint8Array(3), s.sig).ticket, w.s.rounds.written);
  assert.deepEqual(w.seals.list(w.a), []);
});

test("3.4 CR3: a start drops a seal whose maker no log names, and says how many", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  const kept = w.seal(w.alice.first, second);
  assert.equal(w.seals.give(w.a, kept.signed, kept.sig).code, Code.accepted);
  const stranger = keyed();
  const lost = w.seal(stranger, second);
  await w.flush();
  const keptSize = statSync(w.path).size;
  const { file } = await SealsFile.open(platform, w.s.rounds, openAppending(w.path), w.relay);
  file.append(lost); // synced before the journal entry that names its maker: a power cut kept only this
  await w.flush();
  const lostBytes = statSync(w.path).size - keptSize;
  const again = await Seals.open(
    platform,
    w.s.rounds,
    w.seq,
    openAppending(w.path),
    w.relay,
    w.s.log,
  );
  assert.deepEqual(again.list(w.a), [kept]);
  const cut = statSync(w.path).size;
  assert.ok(again.dropped.bytes > 0);
  assert.deepEqual(again.dropped, { bytes: lostBytes, seals: 1 });
  assert.ok(w.s.lines.some((l) => l.includes(`seals: dropped ${lostBytes} bytes, 1 entries`)));
  assert.equal(cut, keptSize, "the file ends before the seal whose maker no log names");
  const third = await Seals.open(
    platform,
    w.s.rounds,
    w.seq,
    openAppending(w.path),
    w.relay,
    w.s.log,
  );
  assert.deepEqual(third.dropped, { bytes: 0, seals: 0 });
});

test("3.4 4a-N1: a seal served before a restart is still served after it", async () => {
  const w = await world();
  const late = keyed();
  w.join(late);
  const device = keyed();
  const s1 = w.seal(device, late);
  const { file } = await SealsFile.open(platform, w.s.rounds, openAppending(w.path), w.relay);
  file.append(s1); // a round held the add of `device` and this seal: the power cut kept the seal alone
  await w.flush();
  const start1 = await Seals.open(
    platform,
    w.s.rounds,
    w.seq,
    openAppending(w.path),
    w.relay,
    w.s.log,
  );
  assert.equal(start1.dropped.seals, 1);
  w.join(device);
  const s2 = w.seal(device, late, { sealed: fill(8, 48) });
  assert.equal(start1.give(w.alice.conn(device), s2.signed, s2.sig).code, Code.accepted);
  await w.flush();
  assert.deepEqual(start1.list(w.alice.conn(late)), [s2]);
  const start2 = await Seals.open(
    platform,
    w.s.rounds,
    w.seq,
    openAppending(w.path),
    w.relay,
    w.s.log,
  );
  assert.deepEqual(start2.list(w.alice.conn(late)), [s2], "served after the restart");
});

test("6.2 give seal: a recipient no device log names is refused and nothing is stored", async () => {
  const w = await world();
  const s = w.seal(w.alice.first, keyed());
  assert.equal(w.seals.give(w.a, s.signed, s.sig).code, Code.refused);
  await w.flush();
  assert.deepEqual(w.seals.list(w.a), []);
});

test("6.2 give seal: an epoch its channel never placed is refused and nothing is stored", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  const s = w.seal(w.alice.first, second, { epoch: platform.sha256(fill(6)) });
  assert.equal(w.seals.give(w.a, s.signed, s.sig).code, Code.refused);
  await w.flush();
  assert.deepEqual(w.seals.list(w.a), []);
});

test("6.2 give seal: a recipient added after the epoch, a recovery key and a removed device are accepted", async () => {
  const w = await world();
  const late = keyed();
  w.join(late);
  const gone = keyed();
  w.join(gone);
  w.extend({ kind: "remove", device: gone.id });
  const toLate = w.seal(w.alice.first, late);
  const toRecovery = w.seal(w.alice.first, w.alice.recovery, {
    recipient: w.alice.recovery.recoveryId,
  });
  const toGone = w.seal(w.alice.first, gone);
  for (const s of [toLate, toRecovery, toGone])
    assert.equal(w.seals.give(w.a, s.signed, s.sig).code, Code.accepted);
  await w.flush();
  assert.deepEqual(w.seals.list(w.a), [toLate, toRecovery, toGone]);
});

test("5.3 step 6: the relay takes a history seal only to a device or recovery key the log names, for a placed epoch [model]", async () => {
  const w = await world();
  const stored = async () => {
    await w.flush();
    return w.seals.list(w.a).length;
  };
  const nobody = w.seal(w.alice.first, keyed());
  assert.equal(w.seals.give(w.a, nobody.signed, nobody.sig).code, Code.refused); // a recipient the log never names
  const unplaced = w.seal(w.alice.first, w.alice.first, { epoch: platform.sha256(fill(6)) });
  assert.equal(w.seals.give(w.a, unplaced.signed, unplaced.sig).code, Code.refused); // an epoch never placed
  assert.equal(await stored(), 0);
  const later = keyed(); // added after the epoch: the purpose of history seals
  w.join(later);
  const toLater = w.seal(w.alice.first, later);
  assert.equal(w.seals.give(w.a, toLater.signed, toLater.sig).code, Code.accepted);
  const toRecovery = w.seal(w.alice.first, w.alice.recovery, {
    recipient: w.alice.recovery.recoveryId,
  });
  assert.equal(w.seals.give(w.a, toRecovery.signed, toRecovery.sig).code, Code.accepted); // the recovery key
  assert.equal(await stored(), 2);
  const gone = keyed();
  w.join(gone);
  w.extend({ kind: "remove", device: gone.id });
  const toGone = w.seal(w.alice.first, gone);
  assert.equal(w.seals.give(w.a, toGone.signed, toGone.sig).code, Code.accepted); // named once: the log keeps it
});

test("3.4 4a-N1: a start cuts at the first seal whose recipient's add or whose epoch was lost, and counts it as it counts a lost maker", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  const kept = w.seal(w.alice.first, second);
  assert.equal(w.seals.give(w.a, kept.signed, kept.sig).code, Code.accepted);
  await w.flush();
  const keptSize = statSync(w.path).size;
  const ghost = keyed(); // its add was in the round the power cut lost
  const lostRecipient = w.seal(w.alice.first, ghost);
  const lostEpoch = w.seal(w.alice.first, second, { epoch: platform.sha256(fill(6)) });
  const after = w.seal(w.alice.first, w.alice.first); // whole and valid, but behind the cut
  const { file } = await SealsFile.open(platform, w.s.rounds, openAppending(w.path), w.relay);
  for (const s of [lostRecipient, lostEpoch, after]) file.append(s);
  await w.flush();
  const lostBytes = statSync(w.path).size - keptSize;
  const again = await Seals.open(
    platform,
    w.s.rounds,
    w.seq,
    openAppending(w.path),
    w.relay,
    w.s.log,
  );
  assert.deepEqual(again.list(w.a), [kept]);
  assert.deepEqual(again.dropped, { bytes: lostBytes, seals: 3 });
  assert.equal(statSync(w.path).size, keptSize, "the file ends before the first such seal");
  const third = await Seals.open(
    platform,
    w.s.rounds,
    w.seq,
    openAppending(w.path),
    w.relay,
    w.s.log,
  );
  assert.deepEqual(third.dropped, { bytes: 0, seals: 0 });
});

test("3.4 duty 6: a seal to a replaced recovery key survives a start, and one to it is still accepted [model]", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  const toK1 = w.seal(w.alice.first, w.alice.recovery, { recipient: w.alice.recovery.recoveryId });
  const after = w.seal(w.alice.first, second);
  for (const s of [toK1, after])
    assert.equal(w.seals.give(w.a, s.signed, s.sig).code, Code.accepted);
  await w.flush();
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
      recovery: keyed().keys,
    },
    w.alice.recovery,
  );
  const by = { person: w.alice.id, device: fresh.id, recovery: w.alice.recovery.recoveryId };
  assert.equal(w.send(by, 1, reset).code, Code.accepted, "the key is rotated");
  await w.flush();
  const again = await Seals.open(
    platform,
    w.s.rounds,
    w.seq,
    openAppending(w.path),
    w.relay,
    w.s.log,
  );
  const now = w.alice.conn(fresh);
  assert.deepEqual(again.list(now), [toK1, after]);
  assert.deepEqual(again.dropped, { bytes: 0, seals: 0 });
  const late = w.seal(fresh, w.alice.recovery, { recipient: w.alice.recovery.recoveryId });
  assert.equal(again.give(now, late.signed, late.sig).code, Code.accepted);
});

test("3.4 duty 6: a seal to a device or recovery key of another person the relay holds is accepted and survives a start", async () => {
  const w = await world();
  const bob = person();
  // The relay's `enrol` refuses a second genesis, so bob's log is placed through the journal, as a relay that held two persons would hold it.
  w.journal.append({ kind: DEVICE, signed: bob.genesis.signed, sig: bob.genesis.sig });
  const started = await w.restart();
  const open = () =>
    Seals.open(platform, w.s.rounds, started.seq, openAppending(w.path), w.relay, w.s.log);
  const seals = await open();
  const toDevice = w.seal(w.alice.first, bob.first);
  const toRecovery = w.seal(w.alice.first, bob.recovery, { recipient: bob.recovery.recoveryId });
  for (const s of [toDevice, toRecovery])
    assert.equal(seals.give(w.a, s.signed, s.sig).code, Code.accepted);
  await w.flush();
  const again = await open();
  assert.deepEqual(again.list(w.a), [toDevice, toRecovery]);
  assert.deepEqual(again.dropped, { bytes: 0, seals: 0 });
});

test("6.2 give seal: an epoch another channel placed does not place it in the seal's own channel", async () => {
  const w = await world();
  const create = memberEntry(w.alice, [], { kind: "create", nonce: fill(4, 16) });
  assert.equal(w.send(w.a, 2, create).code, Code.accepted);
  const other = platform.sha256(create.signed);
  const placed = epochEntry(w.seq, other, { person: w.alice, device: w.alice.first }, [w.alice]);
  assert.equal(w.send(w.a, 3, placed).code, Code.accepted);
  const second = keyed();
  w.join(second);
  const elsewhere = w.seal(w.alice.first, second, { epoch: platform.sha256(placed.signed) });
  assert.equal(w.seals.give(w.a, elsewhere.signed, elsewhere.sig).code, Code.refused);
  await w.flush();
  assert.deepEqual(w.seals.list(w.a), []);
});

test("3.4 4a-N1: a start cuts at a first seal whose recipient is known and whose epoch was lost", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  const size = statSync(w.path).size;
  const lostEpoch = w.seal(w.alice.first, second, { epoch: platform.sha256(fill(6)) });
  const after = w.seal(w.alice.first, w.alice.first);
  const { file } = await SealsFile.open(platform, w.s.rounds, openAppending(w.path), w.relay);
  for (const s of [lostEpoch, after]) file.append(s);
  await w.flush();
  const lostBytes = statSync(w.path).size - size;
  const again = await Seals.open(
    platform,
    w.s.rounds,
    w.seq,
    openAppending(w.path),
    w.relay,
    w.s.log,
  );
  assert.deepEqual(again.list(w.a), []);
  assert.deepEqual(again.dropped, { bytes: lostBytes, seals: 2 });
  assert.equal(statSync(w.path).size, size);
});
