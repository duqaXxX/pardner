/**
 * Design 6.2, 6.3, 6.5, 4.5 and 3.7: what a served connection's requests do, in the model's order,
 * and what the relay pushes when a round completes. A request is answered only once its round is on
 * disk, so each of these holds the round with `hold` and never fakes an `fsync` that returns at
 * once. A test named after one of the model's ends with ` [model]`.
 */
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { decodeHistorySeal, encodeHistorySeal } from "../../src/protocol/epochs.ts";
import { encodeFrame, type Frame } from "../../src/protocol/frames.ts";
import { checkHead } from "../../src/protocol/proofs.ts";
import { FrameReader, PartialBytes } from "../../src/relay/frames-in.ts";
import { makeProof } from "../protocol/proof.ts";
import { type Device, hold, relayOver, settle } from "./session.ts";
import { platform } from "./support.ts";
import { addBody, channelled, fill, type Keyed, keyed, message, signedBy } from "./world.ts";

const DEVICE = 1;
const MESSAGE = 4;
type Signed = { signed: Uint8Array; sig: Uint8Array };

/** A relay with alice's channel and its first epoch on disk, and alice's first device served. */
async function world() {
  const w = await channelled();
  const epoch = w.open();
  await w.flush();
  const relay = await relayOver(w);
  const me = await relay.connect().prove(w.alice.first, w.alice);
  let request = 0;
  /** A `submit` of `e` as `d`; returns its request id. */
  const submit = (d: Device, kind: number, e: Signed) => {
    d.frame({ type: "submit", request: ++request, kind: kind as 1, ...e });
    return request;
  };
  const text = (counter: number, over = {}) =>
    message(w.alice.first, w.channel, epoch, { counter, ...over });
  /** The code a `submit` is answered with, once it is. */
  const code = async (d: Device, kind: number, e: Signed) => {
    const id = submit(d, kind, e);
    await settle();
    return results(d).find((r) => r.request === id)?.code;
  };
  return { ...relay, epoch, me, submit, text, code };
}
type World = Awaited<ReturnType<typeof world>>;

const results = (d: Device) =>
  d.sent.filter((f): f is Extract<Frame, { type: "result" }> => f.type === "result");
const items = (d: Device) =>
  d.sent.filter((f): f is Extract<Frame, { type: "item" }> => f.type === "item");
/** A `give seal` frame of `seal`, as the device sends it. */
const give = (d: Device, request: number, seal: Signed, over = {}) => {
  const decoded = decodeHistorySeal(seal.signed);
  assert.ok(decoded.ok);
  return d.frame({
    type: "give-seal",
    request,
    seal: { ...decoded.value, ...over },
    sig: seal.sig,
  });
};
const read = async (d: Device, from = 0) => {
  d.frame({ type: "read", from });
  await settle();
};

/** A history seal of alice's first device for `recipient`. */
const sealFor = (w: World, recipient: Keyed) =>
  signedBy(
    w.alice.first,
    encodeHistorySeal({
      channel: w.channel,
      epoch: w.epoch.id,
      recipient: recipient.id,
      enc: recipient.keys.receiving,
      sealed: fill(7, 48),
      maker: w.alice.first.id,
    }),
  );

test("6.2 submit: the answer carries the request id and waits for the item's round (3.6)", async () => {
  const w = await world();
  const before = w.journal.placed.length;
  const release = hold(w);
  const id = w.submit(w.me, MESSAGE, w.text(1));
  await settle();
  assert.equal(w.journal.placed.length, before + 1, "placed in memory");
  assert.deepEqual(results(w.me), [], "nothing is answered while its round is held");
  await release();
  assert.deepEqual(results(w.me), [{ type: "result", request: id, code: 0 }]);
});

test("6.2 submit: a refusal is a result with its code (1, 2, 3, 4, 5, 7)", async () => {
  const w = await world();
  assert.equal(
    await w.code(w.me, MESSAGE, message(keyed(), w.channel, w.epoch)),
    1,
    "another sender",
  );
  assert.equal(await w.code(w.me, MESSAGE, w.text(1, { epoch: fill(1) })), 4, "an ended epoch");
  assert.equal(await w.code(w.me, MESSAGE, w.text(1)), 0);
  // A device the log holds as removed, and an epoch the log's change closed.
  const bob = keyed();
  assert.equal(await w.code(w.me, DEVICE, w.alice.entry(w.log(), addBody(w.alice, bob))), 0);
  const stale = w.alice.add(w.log().slice(0, -1), keyed());
  assert.equal(await w.code(w.me, DEVICE, stale), 2, "a position taken");
  const gone = await w.connect().prove(bob, w.alice);
  assert.equal(await w.code(w.me, DEVICE, w.alice.remove(w.log(), bob)), 0);
  assert.equal(await w.code(gone, MESSAGE, w.text(2)), 5, "a removed device");
  assert.equal(await w.code(w.me, MESSAGE, w.text(3)), 3, "the epoch is closed");
});

test("6.2 submit: an answer that rests on a write waits for it, a removal's too (3.6, SD 5.3)", async () => {
  const w = await world();
  const bob = keyed();
  w.join(bob);
  await w.flush();
  const gone = await w.connect().prove(bob, w.alice);
  const release = hold(w);
  w.submit(w.me, DEVICE, w.alice.remove(w.log(), bob)); // placed, its round held
  const id = w.submit(gone, MESSAGE, w.text(1));
  await settle();
  assert.deepEqual(results(gone), [], "result 5 is not sent from a state a restart could lose");
  await release();
  assert.deepEqual(results(gone), [{ type: "result", request: id, code: 5 }]);
  assert.equal(gone.calls.closed, true, "its connection is closed by the removal's round");
});

test("6.2 submit: a message the relay holds is accepted again, and a second use of its counter is refused [model]", async () => {
  const w = await world();
  const first = w.text(1);
  assert.equal(await w.code(w.me, MESSAGE, first), 0);
  assert.equal(await w.code(w.me, MESSAGE, first), 0, "bytes the relay holds");
  assert.equal(
    await w.code(w.me, MESSAGE, w.text(1, { time: 1_700_000_000_001 })),
    1,
    "the counter's slot is taken",
  );
  w.join(keyed());
  assert.equal(await w.code(w.me, MESSAGE, first), 0, "accepted after its epoch closed");
});

test("6.2 read: position, seals, every item up to durable, then the head the relay signed (6.2, 3.6)", async () => {
  const w = await world();
  const second = keyed();
  assert.equal(await w.code(w.me, MESSAGE, w.text(1)), 0);
  w.join(second);
  const seal = sealFor(w, second);
  give(w.me, 90, seal);
  await settle();
  const reader = await w.connect().prove(w.alice.first, w.alice);
  await read(reader, 2);
  const n = w.journal.placed.length;
  assert.deepEqual(reader.types(1), ["position", "seals", ...Array(n - 2).fill("item"), "head"]);
  assert.deepEqual(reader.sent[1], { type: "position", from: 2, incarnation: fill(7, 16) });
  assert.deepEqual(
    items(reader).map((f) => f.position),
    Array.from({ length: n - 2 }, (_, i) => i + 2),
  );
  const head = reader.sent.at(-1) as Extract<Frame, { type: "head" }>;
  assert.equal(head.n, n);
  assert.ok(
    checkHead(platform, w.publicKey, { relay: w.relay, n: head.n, chain: head.chain }, head.sig),
  );
});

test("6.2 read: it gives only what a completed round covers, and waits for the round of what it was judged on (3.6)", async () => {
  const w = await world();
  const reader = await w.connect().prove(w.alice.first, w.alice);
  const release = hold(w);
  w.submit(w.me, MESSAGE, w.text(1)); // placed, held
  await read(reader);
  assert.deepEqual(reader.types(1), [], "no answer while a write the read follows is held");
  await release();
  const n = w.journal.placed.length;
  assert.equal(items(reader).length, n, "the item whose round completed is given");
  assert.equal((reader.sent.at(-1) as Extract<Frame, { type: "head" }>).n, n);
});

test("6.2 read: a removed device is refused 1 and its connection closed, after the removal's round (6.2, 6.3)", async () => {
  const w = await world();
  const bob = keyed();
  w.join(bob);
  await w.flush();
  const gone = await w.connect().prove(bob, w.alice);
  const release = hold(w);
  w.submit(w.me, DEVICE, w.alice.remove(w.log(), bob));
  await read(gone);
  assert.deepEqual(gone.types(1), []);
  await release();
  assert.deepEqual(gone.sent.slice(1), [{ type: "refused", reason: 1 }]);
  assert.equal(gone.calls.closed, true);
});

test("6.3 follow: a read stays open and each later round pushes the items it put on disk, then the head, after the round and not before", async () => {
  const w = await world();
  const watcher = await w.connect().prove(w.alice.first, w.alice);
  await read(watcher);
  const seen = watcher.sent.length;
  const release = hold(w);
  w.submit(w.me, MESSAGE, w.text(1));
  await settle();
  assert.equal(watcher.sent.length, seen, "nothing is pushed while the round is held");
  await release();
  assert.deepEqual(watcher.types(seen), ["item", "head"]);
  const pushed = watcher.sent[seen] as Extract<Frame, { type: "item" }>;
  assert.equal(pushed.position, w.journal.placed.length - 1);
});

test("6.3 follow: a seal added since the last push goes before the items of the round (6.3, PD 6.7)", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  await w.flush();
  const watcher = await w.connect().prove(w.alice.first, w.alice);
  await read(watcher);
  const seen = watcher.sent.length;
  const seal = sealFor(w, second);
  const release = hold(w);
  give(w.me, 91, seal);
  w.submit(w.me, DEVICE, w.alice.entry(w.log(), addBody(w.alice, keyed())));
  await release();
  assert.deepEqual(watcher.types(seen), ["seals", "item", "head"]);
});

test("6.3 follow: a new read replaces the follow, and nothing is pushed twice", async () => {
  const w = await world();
  const watcher = await w.connect().prove(w.alice.first, w.alice);
  await read(watcher);
  await read(watcher, 2);
  const seen = watcher.sent.length;
  assert.equal(await w.code(w.me, MESSAGE, w.text(1)), 0);
  assert.deepEqual(watcher.types(seen), ["item", "head"]);
});

test("6.3 follow: the round that removes a device tells it refused 1 and closes it before anything is pushed; the others get the round's items (6.3 steps 2 and 4)", async () => {
  const w = await world();
  const bob = keyed();
  w.join(bob);
  await w.flush();
  const gone = await w.connect().prove(bob, w.alice);
  const stays = await w.connect().prove(w.alice.first, w.alice);
  await read(gone);
  await read(stays);
  const [goneSeen, staysSeen] = [gone.sent.length, stays.sent.length];
  const release = hold(w);
  w.submit(w.me, DEVICE, w.alice.remove(w.log(), bob));
  w.submit(w.me, DEVICE, w.alice.entry(w.log(), addBody(w.alice, keyed())));
  await settle();
  assert.equal(gone.sent.length, goneSeen, "told nothing before the round completes");
  await release();
  assert.deepEqual(
    gone.sent.slice(goneSeen),
    [{ type: "refused", reason: 1 }],
    "no item reaches it",
  );
  assert.equal(gone.calls.closed, true);
  assert.deepEqual(stays.types(staysSeen), ["item", "item", "head"]);
});

test("4.5 follow: a socket that does not drain holds one slice, and the rest follows on 'drain' with no gap", async () => {
  const w = await world();
  const watcher = await w.connect().prove(w.alice.first, w.alice);
  await read(watcher);
  const given = items(watcher).length;
  watcher.block();
  for (let i = 1; i <= 3; i++) w.submit(w.me, MESSAGE, w.text(i));
  await settle();
  assert.equal(
    items(watcher).length - given,
    1,
    "the first item went out and the writer then waited",
  );
  assert.equal(watcher.drains(), 1, "it waits for 'drain'");
  await watcher.flush();
  await watcher.flush();
  await watcher.flush();
  const positions = items(watcher).map((f) => f.position);
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    "in order",
  );
  assert.equal(new Set(positions).size, positions.length, "no item twice");
  assert.equal(positions.at(-1), w.journal.placed.length - 1, "no gap");
  assert.equal(watcher.sent.at(-1)?.type, "head");
});

test("4.5 answers: past 64 waiting for their round a connection is paused, and resumed once they fall to 32", async () => {
  const w = await world();
  const release = hold(w);
  w.submit(w.me, MESSAGE, w.text(1)); // a write whose round is held: what follows waits for it
  const wrong = () => message(keyed(), w.channel, w.epoch);
  for (let i = 0; i < 63; i++) w.submit(w.me, MESSAGE, wrong());
  await settle();
  assert.equal(w.me.calls.pause, 0, "64 answers wait");
  w.submit(w.me, MESSAGE, wrong());
  assert.equal(w.me.calls.pause, 1, "the 65th pauses");
  await release();
  assert.equal(results(w.me).length, 65);
  assert.equal(w.me.calls.resume, 1);
});

test("6.2 give seal: kept and answered after its round; a seal of another maker is refused (6.2)", async () => {
  const w = await world();
  const second = keyed();
  w.join(second);
  await w.flush();
  const seal = sealFor(w, second);
  const release = hold(w);
  give(w.me, 5, seal);
  await settle();
  assert.deepEqual(results(w.me), []);
  await release();
  assert.deepEqual(results(w.me), [{ type: "result", request: 5, code: 0 }]);
  give(w.me, 6, sealFor(w, second), { maker: second.id });
  await settle();
  assert.equal(results(w.me).at(-1)?.code, 1);
});

test("6.5 failing closed with requests: answers queued behind a round, a follow and a read in slices stop at the decision, and the round that follows sends nothing of them (6.5)", async () => {
  const w = await world();
  const watcher = await w.connect().prove(w.alice.first, w.alice);
  await read(watcher);
  const other = await w.connect().prove(w.alice.first, w.alice);
  const seen = [watcher.sent.length, other.sent.length];
  const release = hold(w);
  const id = w.submit(other, MESSAGE, w.text(1));
  await settle();
  const uploader = w.connect();
  const { head, sig } = w.headOf(w.journal.placed.length + 3, fill(4));
  uploader.upload(keyed(), head, sig);
  uploader.frame({ type: "upload-done", request: 9, head, sig });
  await release();
  await settle();
  assert.deepEqual(watcher.sent.slice(seen[0]), [{ type: "refused", reason: 6 }], "no item pushed");
  assert.deepEqual(other.sent.slice(seen[1]), [{ type: "refused", reason: 6 }]);
  assert.equal(
    results(other).some((r) => r.request === id),
    false,
    "its answer was dropped",
  );
  assert.deepEqual(uploader.sent.at(-1), { type: "result", request: 9, code: 11 });
});

test("3.7 rule 11: a request on a journal that is not what the relay wrote gets no answer, every connection closes and the relay stops with 75", async () => {
  const w = await world();
  const bystander = await w.connect().prove(w.alice.first, w.alice);
  const before = w.me.sent.length;
  appendFileSync(join(w.dir, "journal"), "a copy put by hand");
  w.submit(w.me, MESSAGE, w.text(1));
  await settle();
  assert.equal(w.me.sent.length, before, "no answer");
  assert.equal(w.me.calls.closed && bystander.calls.closed, true, "every connection is closed");
  assert.deepEqual(w.s.stops, [75]);
  assert.match(w.s.lines.join("\n"), /rule 11.*size/);
  await read(bystander);
  assert.equal(bystander.sent.length, 1, "nothing more is sent to anyone");
});

test("3.7 rule 11: a directory renamed away and another put at its path is found at the next request", async () => {
  const w = await world();
  renameSync(w.dir, `${w.dir}-away`);
  mkdirSync(w.dir);
  copyFileSync(join(`${w.dir}-away`, "journal"), join(w.dir, "journal"));
  rmSync(`${w.dir}-away`, { recursive: true });
  await read(w.me);
  assert.deepEqual(w.s.stops, [75]);
  assert.match(w.s.lines.join("\n"), /rule 11.*directory/);
});

test("5.3 recovery: the proof of recovery allows one submit, the reset that names its device, answered after its round, and the connection ends [model]", async () => {
  const w = await world();
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
  const rec = await w.connect().recover(fresh, w.alice);
  assert.equal(rec.frame({ type: "read", from: 0 }), false, "a recovery connection reads nothing");
  assert.equal(rec.calls.closed, true);
  const second = await w.connect().recover(fresh, w.alice);
  const release = hold(w);
  const id = w.submit(second, DEVICE, reset);
  await settle();
  assert.deepEqual(second.sent, [], "not answered before its round");
  await release();
  assert.deepEqual(second.sent, [{ type: "result", request: id, code: 0 }]);
  assert.equal(second.calls.closed, true, "a recovery is a few frames");
  assert.equal(w.me.sent.at(-1)?.type, "refused", "the reset removed the devices it left out");
});

test("5.10 recovery: with the recovery proof the relay takes only the reset that names the device that brings it [model]", async () => {
  const w = await world();
  const [fresh, other] = [keyed(), keyed()];
  const entry = (named: Keyed) =>
    w.alice.entry(
      w.log(),
      {
        kind: "reset",
        set: [named.id],
        newDevice: {
          device: named.device,
          proof: makeProof(platform, named.sign, w.alice.id, named.device),
        },
      },
      w.alice.recovery,
    );
  const rec = await w.connect().recover(fresh, w.alice);
  assert.equal(await w.code(rec, DEVICE, entry(other)), 1);
});

test("5.3 recovery: a submit of a message on a recovery connection closes it", async () => {
  const w = await world();
  const rec = await w.connect().recover(keyed(), w.alice);
  assert.equal(rec.frame({ type: "submit", request: 1, kind: MESSAGE, ...w.text(1) }), false);
  assert.equal(rec.calls.closed, true);
});

test("6.3 follow: a device entry is pushed like any item", async () => {
  const w = await world();
  const watcher = await w.connect().prove(w.alice.first, w.alice);
  await read(watcher);
  const seen = watcher.sent.length;
  assert.equal(await w.code(w.me, DEVICE, w.alice.entry(w.log(), addBody(w.alice, keyed()))), 0);
  assert.deepEqual(watcher.types(seen), ["item", "head"]);
});

test("4.5 follow: a round that completes while the writer waits for 'drain' is given in the same follow, after the first run's head", async () => {
  const w = await world();
  const watcher = await w.connect().prove(w.alice.first, w.alice);
  await read(watcher);
  watcher.block();
  for (let i = 1; i <= 2; i++) w.submit(w.me, MESSAGE, w.text(i));
  await settle();
  assert.equal(await w.code(w.me, MESSAGE, w.text(3)), 0, "a second round completes meanwhile");
  await watcher.flush();
  await watcher.flush();
  await watcher.flush();
  await watcher.flush();
  const positions = items(watcher).map((f) => f.position);
  assert.equal(positions.at(-1), w.journal.placed.length - 1, "the second round's item arrived");
  assert.equal(new Set(positions).size, positions.length);
  assert.equal(watcher.sent.at(-1)?.type, "head");
});

test("3.7 rule 11: a round that completes on a journal that was changed pushes nothing and stops the relay", async () => {
  const w = await world();
  const watcher = await w.connect().prove(w.alice.first, w.alice);
  await read(watcher);
  const seen = watcher.sent.length;
  const release = hold(w);
  w.submit(w.me, MESSAGE, w.text(1));
  await settle();
  appendFileSync(join(w.dir, "journal"), "a copy put by hand");
  await release();
  assert.equal(watcher.sent.length, seen, "nothing is pushed from a directory that changed");
  assert.deepEqual(w.s.stops, [75]);
});

test("5.3 recovery: a second submit on a recovery connection closes it", async () => {
  const w = await world();
  const fresh = keyed();
  const rec = await w.connect().recover(fresh, w.alice);
  const stale = w.alice.add(w.log(), keyed());
  w.submit(rec, DEVICE, stale);
  assert.equal(rec.frame({ type: "submit", request: 99, kind: DEVICE, ...stale }), false);
  assert.equal(rec.calls.closed, true);
});

test("6.1 a second proof on a served connection never reaches the session: a proven connection's reader refuses a handshake frame (C2)", async () => {
  const w = await world();
  const second = await w.connect().prove(w.alice.first, w.alice);
  const proof = second.proveFrame(w.alice.first, w.alice);
  const proven = new FrameReader(new PartialBytes());
  proven.proven = true;
  assert.deepEqual(proven.push(Buffer.from(encodeFrame(proof, false))), { closed: "frame" });
});

test("6.7 a submit whose item frame would pass 1 MiB is answered 8 and placed nowhere; one whose item fits is evaluated (S1a)", async () => {
  const w = await world();
  const placed = w.journal.placed.length;
  const sized = (signed: number) => ({ signed: new Uint8Array(signed), sig: new Uint8Array(64) });
  // The item frame is the submit frame and 4 bytes more: 78 bytes around the signed bytes, against 74.
  assert.equal(await w.code(w.me, MESSAGE, sized(1_048_576 - 77)), 8);
  assert.equal(await w.code(w.me, MESSAGE, sized(1_048_576 - 74)), 8);
  assert.equal(
    await w.code(w.me, MESSAGE, sized(1_048_576 - 78)),
    1,
    "an item at the limit is evaluated",
  );
  assert.equal(w.journal.placed.length, placed);
});

test("3.7 rule 11: an answer released by a round is not sent when the journal changed during the round (M1)", async () => {
  const w = await world();
  const release = hold(w);
  const id = w.submit(w.me, MESSAGE, w.text(1));
  await settle();
  appendFileSync(join(w.dir, "journal"), "a copy put by hand");
  await release();
  assert.deepEqual(w.s.stops, [75]);
  assert.equal(
    results(w.me).some((r) => r.request === id),
    false,
    "no answer",
  );
});

test("3.7 rule 11: upload done is checked against the directory too (M2)", async () => {
  const w = await world();
  const uploader = w.connect();
  const { head, sig } = w.headOf(w.journal.placed.length, w.journal.placed.at(-1)?.chain);
  uploader.upload(keyed(), head, sig);
  appendFileSync(join(w.dir, "journal"), "a copy put by hand");
  uploader.frame({ type: "upload-done", request: 9, head, sig });
  await settle();
  assert.deepEqual(uploader.sent, []);
  assert.deepEqual(w.s.stops, [75]);
});

test("2.4 an error nothing expected stops the relay with 75 and a log line without a path or a message, from a frame and from an answer (C3, C8)", async () => {
  const w = await world();
  const bystander = await w.connect().prove(w.alice.first, w.alice);
  mock.method(w.seq, "submit", () => {
    throw Object.assign(new TypeError(`a path ${"/Us" + "ers/x"}`), {
      code: "EIO",
      syscall: "write",
    });
  });
  assert.equal(w.me.frame({ type: "submit", request: 1, kind: MESSAGE, ...w.text(1) }), false);
  assert.deepEqual(w.s.stops, [75]);
  assert.match(w.s.lines.join("\n"), /unexpected TypeError \(code=EIO syscall=write\)/);
  assert.doesNotMatch(w.s.lines.join("\n"), /ers\/x/);
  assert.equal(bystander.calls.closed, true, "every connection closes");
  mock.restoreAll();
});

test("2.4 a send that throws in an answer stops the relay with 75 instead of escaping (C3)", async () => {
  const w = await world();
  w.me.breakSend();
  assert.equal(await w.code(w.me, MESSAGE, w.text(1)), undefined);
  assert.deepEqual(w.s.stops, [75]);
  assert.match(w.s.lines.join("\n"), /unexpected Error \(code=EPIPE syscall=write\)/);
});

test("6.3 step 2: a removed device is told after the removal's round and not before, after the answer of the entry that removed it and before the round's items are pushed (T1, T2)", async () => {
  const w = await world();
  const bob = keyed();
  w.join(bob);
  await w.flush();
  const gone = await w.connect().prove(bob, w.alice);
  const stays = await w.connect().prove(w.alice.first, w.alice);
  await read(stays);
  const release = hold(w);
  w.submit(w.me, DEVICE, w.alice.remove(w.log(), bob));
  await settle();
  assert.equal(gone.calls.closed, false);
  assert.deepEqual(gone.types(1), [], "nothing before the round");
  await release();
  const trace = w.order.filter((o) => /result|refused|item/.test(o));
  assert.deepEqual(
    [trace.at(-3), trace.at(-2), w.order.lastIndexOf("c3:item") > w.order.indexOf("c2:refused")],
    ["c1:result", "c2:refused", true],
  );
});

test("4.5 answers: a connection resumes at 32 waiting, not at the end (T2)", async () => {
  const w = await world();
  w.pending.hold = true;
  w.submit(w.me, MESSAGE, w.text(1));
  await settle();
  const first = w.pending.release;
  const wrong = () => message(keyed(), w.channel, w.epoch);
  for (let i = 0; i < 35; i++) w.submit(w.me, MESSAGE, wrong());
  w.submit(w.me, MESSAGE, w.text(2)); // written after the round began: the next round's
  for (let i = 0; i < 28; i++) w.submit(w.me, MESSAGE, wrong());
  await settle();
  assert.equal(w.me.calls.pause, 1, "paused at the 65th");
  first?.();
  await settle();
  assert.equal(results(w.me).length, 36, "the first round's answers");
  const trace = w.order.filter((o) => o.startsWith("c1:") && /result|resume/.test(o));
  assert.equal(
    trace.indexOf("c1:resume"),
    32,
    "resumed as the 33rd answer's turn came, with 32 waiting",
  );
});

test("6.3 a connection that closes while its answer waits is sent nothing, and a read that waits is no follow after it (T2, S4)", async () => {
  const w = await world();
  const gone = await w.connect().prove(w.alice.first, w.alice);
  const release = hold(w);
  w.submit(w.me, MESSAGE, w.text(1));
  await settle();
  w.submit(gone, MESSAGE, w.text(2));
  gone.frame({ type: "read", from: 0 });
  gone.closed();
  await release();
  const before = gone.sent.length;
  assert.equal(await w.code(w.me, MESSAGE, w.text(3)), 0);
  assert.equal(gone.sent.length, before, "no answer, no follow");
});

test("4.5 a peer that never drains is built nothing for after the write that filled its socket: many reads, then answers (C1, S3, M4)", async () => {
  const w = await world();
  for (let i = 1; i <= 3; i++) assert.equal(await w.code(w.me, MESSAGE, w.text(i)), 0);
  const reader = await w.connect().prove(w.alice.first, w.alice);
  reader.block();
  for (let i = 0; i < 3000; i++) reader.frame({ type: "read", from: 0 });
  await settle();
  assert.deepEqual(reader.types(1), ["position"], "one frame queued, the rest of its reads wait");
  await reader.flush();
  assert.ok(reader.types(1).length > 1, "and are served once it drains");
});

test("4.5 answers released by a round are built one by one while the socket has room, none once a write filled it (S3)", async () => {
  const w = await world();
  const release = hold(w);
  w.submit(w.me, MESSAGE, w.text(1));
  w.submit(w.me, MESSAGE, message(keyed(), w.channel, w.epoch));
  w.submit(w.me, MESSAGE, message(keyed(), w.channel, w.epoch));
  await settle();
  w.me.block();
  await release();
  assert.equal(results(w.me).length, 1, "the first filled the socket");
  await w.me.flush();
  assert.equal(results(w.me).length, 3);
});

test("6.3 step 2 and 4: a read answered in the round that removes a device is given its items after that device was told (C4)", async () => {
  const w = await world();
  const bob = keyed();
  w.join(bob);
  await w.flush();
  await w.connect().prove(bob, w.alice);
  const reader = await w.connect().prove(w.alice.first, w.alice);
  const release = hold(w);
  w.submit(w.me, DEVICE, w.alice.remove(w.log(), bob));
  reader.frame({ type: "read", from: 0 });
  await settle();
  await release();
  const told = w.order.indexOf("c2:refused");
  const given = w.order.indexOf("c3:position");
  assert.ok(
    told >= 0 && given >= 0 && told < given,
    `told ${told}, given ${given}: ${w.order.join(" ")}`,
  );
});

test("4.5 a connection that closes while a follow waits for its socket is given nothing more when the socket drains (T2)", async () => {
  const w = await world();
  for (let i = 1; i <= 3; i++) assert.equal(await w.code(w.me, MESSAGE, w.text(i)), 0);
  const reader = await w.connect().prove(w.alice.first, w.alice);
  reader.block();
  reader.frame({ type: "read", from: 0 });
  await settle();
  assert.deepEqual(reader.types(1), ["position"]);
  reader.closed();
  await reader.flush();
  assert.deepEqual(reader.types(1), ["position"]);
});

test("6.2 submit: a removed device's submit is answered 5 whatever its size, the removal's check comes before the size's (6.2 order)", async () => {
  const w = await world();
  const bob = keyed();
  w.join(bob);
  await w.flush();
  const gone = await w.connect().prove(bob, w.alice);
  assert.equal(await w.code(w.me, DEVICE, w.alice.remove(w.log(), bob)), 0);
  const sized = (signed: number) => ({ signed: new Uint8Array(signed), sig: new Uint8Array(64) });
  assert.equal(await w.code(gone, MESSAGE, sized(1_048_576 - 77)), 5);
});

test("6.3 follow: a read replaces a follow that is mid-run, and the replaced run sends no more items (R1)", async () => {
  const w = await world();
  // More items than the outbox's slice, so that the first run is cut by the event loop and the second read comes between its slices.
  for (let i = 1; i <= 300; i++) w.submit(w.me, MESSAGE, w.text(i));
  await settle();
  const reader = await w.connect().prove(w.alice.first, w.alice);
  const from = w.journal.placed.length;
  reader.frame({ type: "read", from: 0 });
  reader.frame({ type: "read", from });
  await settle();
  const types = reader.sent.map((f) => f.type);
  const old = types.slice(0, types.lastIndexOf("position")).filter((t) => t === "item").length;
  assert.ok(
    old < from,
    `${old} of ${from} items of the replaced run came before the new read's position`,
  );
});

test("6.1 a removal placed while an earlier round runs is not told at that earlier round (SD 5.3)", async () => {
  const w = await world();
  const bob = keyed();
  w.join(bob);
  await w.flush();
  const gone = await w.connect().prove(bob, w.alice);
  w.pending.hold = true;
  w.submit(w.me, DEVICE, w.alice.add(w.log(), keyed()));
  await settle();
  const earlier = w.pending.release;
  w.submit(w.me, DEVICE, w.alice.remove(w.log(), bob));
  const removal = w.s.rounds.written;
  await settle();
  earlier?.();
  await settle();
  assert.ok(w.s.rounds.synced < removal, "the removal is not on disk");
  assert.equal(
    gone.sent.some((f) => f.type === "refused"),
    false,
    "bob is told nothing before his removal's round",
  );
});

test("3.7 rule 11: a frame on a journal that was swapped appends no record", async () => {
  const w = await world();
  const placed = w.journal.placed.length;
  appendFileSync(join(w.dir, "journal"), "a copy put by hand");
  assert.equal(w.me.frame({ type: "submit", request: 1, kind: MESSAGE, ...w.text(1) }), false);
  await settle();
  assert.equal(w.journal.placed.length, placed, "nothing is placed");
  assert.deepEqual(w.s.stops, [75]);
});

test("3.7 rule 11: a round that releases no answer finds a directory renamed away and stops the relay", async () => {
  const w = await world();
  const release = hold(w);
  w.submit(w.me, MESSAGE, w.text(1));
  await settle();
  w.me.closed(); // the round's one answer goes nowhere
  renameSync(w.dir, `${w.dir}-away`);
  mkdirSync(w.dir);
  copyFileSync(join(`${w.dir}-away`, "journal"), join(w.dir, "journal"));
  rmSync(`${w.dir}-away`, { recursive: true });
  await release();
  assert.deepEqual(w.s.stops, [75]);
});

test("6.3 follow: a read that replaces a follow held at its position or its seals leaves nothing of the old run to send (F5)", async () => {
  for (const held of [1, 2]) {
    const w = await world();
    const reader = await w.connect().prove(w.alice.first, w.alice);
    const start = reader.sent.length;
    reader.blockAfter(held);
    reader.frame({ type: "read", from: 0 });
    await settle();
    const cut = reader.sent.length;
    assert.equal(cut - start, held, "the run is held after its frame");
    // The replacing read is handed over at once: a server would hold it behind the full socket.
    reader.session.frame({ type: "read", from: 0 });
    await settle();
    await reader.flush();
    assert.equal(reader.types(cut)[0], "position", `the old run sent no more after frame ${held}`);
    assert.equal(reader.types(cut).filter((t) => t === "head").length, 1, "one run is finished");
  }
});

test("6.3 follow: a read gives its own follow its pass and asks no other follower (F7)", async () => {
  const w = await world();
  const bob = keyed();
  w.join(bob);
  await w.flush();
  const other = await w.connect().prove(bob, w.alice);
  const reader = await w.connect().prove(w.alice.first, w.alice);
  await read(other);
  const since = mock.method(w.seals, "since");
  await read(reader);
  const asked = since.mock.calls.map((c) => Buffer.from(c.arguments[0].device).toString("hex"));
  assert.deepEqual(asked, [Buffer.from(w.alice.first.id).toString("hex")], "the reader's own pass");
  assert.equal(reader.types().includes("head"), true);
  mock.restoreAll();
});

const logs = (d: Device) =>
  d.sent.filter((f): f is Extract<Frame, { type: "log" }> => f.type === "log");

test("6.2 recovery log: a recovery connection is given the person's device log up to what is on disk, after the round of what it rests on (3.6)", async () => {
  const w = await world();
  const fresh = keyed();
  const rec = await w.connect().recover(fresh, w.alice);
  const bob = keyed();
  const release = hold(w);
  w.submit(w.me, DEVICE, w.alice.entry(w.log(), addBody(w.alice, bob)));
  rec.frame({ type: "recovery-log", request: 4 });
  await settle();
  assert.deepEqual(logs(rec), [], "not answered from a state not on disk");
  await release();
  const [answer] = logs(rec);
  assert.equal(answer?.request, 4);
  assert.equal(answer?.entries.length, 2, "the genesis and the add");
  assert.deepEqual(answer?.entries[0]?.signed, w.alice.genesis.signed);
  assert.deepEqual(answer?.entries[0]?.sig, w.alice.genesis.sig);
  assert.equal(rec.calls.closed, false, "the connection stays for its reset");
  assert.deepEqual(
    rec.sent.at(-1),
    { type: "result", request: 4, code: 0 },
    "a result closes the log",
  );
});

test("6.2 recovery log: only a recovery connection asks for it", async () => {
  const w = await world();
  assert.equal(w.me.frame({ type: "recovery-log", request: 1 }), false);
  assert.equal(w.me.calls.closed, true);
});

test("6.7 recovery log: a log that does not fit one frame spans several log frames of the request, each whole, closed by result 0 (S1b)", async () => {
  const w = await world();
  const rec = await w.connect().recover(keyed(), w.alice);
  const entry = (n: number) => ({
    signed: new Uint8Array(400_000).fill(n),
    sig: new Uint8Array(64),
  });
  const big = [1, 2, 3, 4, 5].map(entry);
  mock.method(w.seq, "recoveryLog", () => big);
  rec.frame({ type: "recovery-log", request: 8 });
  await settle();
  const frames = logs(rec);
  assert.deepEqual(
    frames.map((f) => f.entries.length),
    [2, 2, 1],
  );
  assert.deepEqual(
    frames.flatMap((f) => f.entries.map((e) => e.signed[0])),
    [1, 2, 3, 4, 5],
    "in order",
  );
  assert.ok(frames.every((f) => f.request === 8));
  assert.deepEqual(
    rec.sent.slice(-2).map((f) => f.type),
    ["log", "result"],
  );
  assert.deepEqual(rec.sent.at(-1), { type: "result", request: 8, code: 0 });
  mock.restoreAll();
});

test("6.2 recovery log: a log of one entry that fills a frame, and an empty one, are one frame each (S1b)", async () => {
  const w = await world();
  const rec = await w.connect().recover(keyed(), w.alice);
  mock.method(w.seq, "recoveryLog", () => [
    { signed: new Uint8Array(1_048_000), sig: new Uint8Array(64) },
  ]);
  rec.frame({ type: "recovery-log", request: 1 });
  await settle();
  assert.equal(logs(rec).length, 1);
  mock.restoreAll();
  mock.method(w.seq, "recoveryLog", () => []);
  const empty = await w.connect().recover(keyed(), w.alice);
  empty.frame({ type: "recovery-log", request: 2 });
  await settle();
  assert.deepEqual(
    empty.sent.map((f) => f.type),
    ["log", "result"],
  );
  mock.restoreAll();
});

test("5.10 recovery log: a connection whose recovery key is no longer the current one is refused 3 and closed, and given nothing [model] (S5)", async () => {
  const w = await world();
  const attacker = await w.connect().recover(keyed(), w.alice);
  const fresh = keyed();
  const newSheet = keyed();
  const reset = w.alice.entry(
    w.log(),
    {
      kind: "reset",
      set: [fresh.id],
      newDevice: {
        device: fresh.device,
        proof: makeProof(platform, fresh.sign, w.alice.id, fresh.device),
      },
      recovery: newSheet.keys,
    },
    w.alice.recovery,
  );
  const owner = await w.connect().recover(fresh, w.alice);
  owner.frame({ type: "submit", request: 1, kind: DEVICE, ...reset });
  await settle();
  assert.equal(results(owner).at(-1)?.code, 0, "the reset is placed");
  attacker.frame({ type: "recovery-log", request: 9 });
  await settle();
  assert.deepEqual(attacker.sent, [{ type: "refused", reason: 3 }]);
  assert.equal(attacker.calls.closed, true);
});

test("5.10 recovery log: a stale sheet's refused reset leaves its pipelined log refused 3 (S5)", async () => {
  const w = await world();
  const thief = keyed();
  const attacker = await w.connect().recover(thief, w.alice);
  const fresh = keyed();
  const newSheet = keyed();
  const resetBy = (named: Keyed, sheet?: Keyed) =>
    w.alice.entry(
      w.log(),
      {
        kind: "reset",
        set: [named.id],
        newDevice: {
          device: named.device,
          proof: makeProof(platform, named.sign, w.alice.id, named.device),
        },
        ...(sheet ? { recovery: sheet.keys } : {}),
      },
      w.alice.recovery,
    );
  const owner = await w.connect().recover(fresh, w.alice);
  // Built on the log before the owner's rotation, so that it is refused once the rotation is placed.
  const stale = resetBy(thief);
  w.pending.hold = true;
  owner.frame({ type: "submit", request: 1, kind: DEVICE, ...resetBy(fresh, newSheet) });
  await settle();
  attacker.frame({ type: "recovery-log", request: 3 });
  attacker.frame({ type: "submit", request: 2, kind: DEVICE, ...stale });
  w.pending.hold = false;
  w.pending.release?.();
  await settle();
  assert.equal(results(owner).at(-1)?.code, 0, "the owner's rotation is placed");
  assert.equal(
    attacker.sent.some((f) => f.type === "log"),
    false,
    "the old sheet is given no entry",
  );
  assert.deepEqual(attacker.sent.at(-1), { type: "refused", reason: 3 });
});

test("3.6 recovery log: only the entries on disk are given, not one placed while the round it waited for ran (T1)", async () => {
  const w = await world();
  const rec = await w.connect().recover(keyed(), w.alice);
  w.pending.hold = true;
  w.submit(w.me, DEVICE, w.alice.entry(w.log(), addBody(w.alice, keyed())));
  await settle();
  const first = w.pending.release;
  rec.frame({ type: "recovery-log", request: 5 });
  await settle();
  w.submit(w.me, DEVICE, w.alice.entry(w.log(), addBody(w.alice, keyed())));
  await settle();
  first?.();
  await settle();
  assert.equal(
    logs(rec)[0]?.entries.length,
    2,
    "the genesis and the first add; the second is not on disk",
  );
  w.pending.hold = false;
  w.pending.release?.();
});

/** The reset that brings `fresh` as alice's new device and gives her a new recovery key, signed with the old one. */
const resetFor = (w: World, fresh: Keyed) =>
  w.alice.entry(
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

test("3.6 recovery log: the log asked for before the connection's own reset, in one chunk, is no refusal 3, and the reset's result 0 is sent (F1)", async () => {
  const w = await world();
  const fresh = keyed();
  const rec = await w.connect().recover(fresh, w.alice);
  const release = hold(w);
  // A write the log waits for, in the round that also holds the connection's own reset.
  w.submit(w.me, DEVICE, w.alice.entry(w.log(), addBody(w.alice, keyed())));
  rec.frame({ type: "recovery-log", request: 90 });
  const id = w.submit(rec, DEVICE, resetFor(w, fresh));
  await release();
  assert.equal(
    rec.sent.some((f) => f.type === "refused"),
    false,
    "the reset it submitted is no reason to refuse it",
  );
  assert.deepEqual(
    results(rec).filter((f) => f.request === id),
    [{ type: "result", request: id, code: 0 }],
  );
});

test("3.6 recovery log: another connection's reset that is placed and not on disk refuses nothing; the log is given from disk (F1)", async () => {
  const w = await world();
  const rec = await w.connect().recover(keyed(), w.alice);
  const other = keyed();
  const rival = await w.connect().recover(other, w.alice);
  w.pending.hold = true;
  w.submit(w.me, DEVICE, w.alice.entry(w.log(), addBody(w.alice, keyed())));
  await settle();
  const first = w.pending.release;
  rec.frame({ type: "recovery-log", request: 5 });
  await settle();
  w.submit(rival, DEVICE, resetFor(w, other));
  await settle();
  first?.();
  await settle();
  assert.equal(
    rec.sent.some((f) => f.type === "refused"),
    false,
    "the reset is not on disk: the key is still the current one",
  );
  assert.equal(logs(rec)[0]?.entries.length, 2, "the genesis and the first add");
  w.pending.hold = false;
  w.pending.release?.();
  await settle();
});

test("4.6 recovery log: a second recovery-log on one recovery connection closes it (F8)", async () => {
  const w = await world();
  const rec = await w.connect().recover(keyed(), w.alice);
  assert.equal(rec.frame({ type: "recovery-log", request: 1 }), true);
  await settle();
  const seen = rec.sent.length;
  assert.equal(rec.frame({ type: "recovery-log", request: 2 }), false);
  await settle();
  assert.equal(rec.calls.closed, true);
  assert.equal(rec.sent.length, seen, "nothing more is read or sent for it");
});

test("4.5 recovery log: the entries are read a frame at a time, not all before the first frame goes (F8)", async () => {
  const w = await world();
  const rec = await w.connect().recover(keyed(), w.alice);
  for (let i = 0; i < 6; i++) {
    w.submit(w.me, DEVICE, w.alice.entry(w.log(), addBody(w.alice, keyed())));
  }
  await settle();
  const read = mock.method(w.journal, "read", () => ({
    signed: new Uint8Array(600_000),
    sig: new Uint8Array(64),
  }));
  rec.block();
  rec.frame({ type: "recovery-log", request: 3 });
  await settle();
  assert.deepEqual(logs(rec).length, 1, "the socket is full after one frame");
  assert.ok(read.mock.callCount() <= 2, `${read.mock.callCount()} entries read for one frame`);
  mock.restoreAll();
});
