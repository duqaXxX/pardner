/**
 * The outbox of a served connection (design 4.5): what it builds while the socket has room, and
 * what it holds when the socket does not. The socket is a fake that says when it is full.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Frame } from "../../src/protocol/frames.ts";
import { Outbox } from "../../src/relay/outbox.ts";
import type { Peer } from "../../src/relay/server.ts";
import { tick } from "./support.ts";

/** A peer that records what it is sent, and is full from the `full`th frame until `empty()`. */
function fake(full = Number.POSITIVE_INFINITY) {
  const sent: string[] = [];
  const ended: Frame[] = [];
  const drains: (() => void)[] = [];
  let room = true;
  const peer = {
    send: (frame: Frame) => {
      sent.push(
        frame.type === "result"
          ? `result ${frame.request}`
          : frame.type === "head"
            ? `head ${frame.n}`
            : frame.type,
      );
      if (sent.length >= full) room = false;
      return room;
    },
    end: (frame: Frame) => void ended.push(frame),
    drain: (fn: () => void) => void drains.push(fn),
  } as unknown as Peer;
  return {
    peer,
    sent,
    ended,
    drains,
    empty: () => {
      room = true;
      for (const fn of drains.splice(0)) fn();
    },
  };
}
const result = (request: number): Frame => ({ type: "result", request, code: 0 });
/** A stream of `n` heads numbered from `from`, one per step; `built.n` counts the steps taken. */
function* frames(out: Outbox, n: number, built = { n: 0 }, from = 0): Generator<void> {
  for (let i = 0; i < n; i++) {
    built.n++;
    out.send({ type: "head", n: from + i, chain: new Uint8Array(32), sig: new Uint8Array(64) });
    yield;
  }
}

test("4.5 an answer that comes while a stream runs is built before the stream's next step", () => {
  const f = fake();
  const out = new Outbox(f.peer, () => false, assert.ifError);
  out.stream(
    (function* () {
      out.send({ type: "head", n: 0, chain: new Uint8Array(32), sig: new Uint8Array(64) });
      yield;
      out.answer(() => out.send(result(1)));
      yield;
      out.send({ type: "head", n: 1, chain: new Uint8Array(32), sig: new Uint8Array(64) });
    })(),
  );
  assert.deepEqual(f.sent, ["head 0", "result 1", "head 1"]);
});

test("4.5 a socket that queued a write stops the outbox: no answer is built and no step taken until 'drain'", async () => {
  const f = fake(2);
  const built = { n: 0 };
  const out = new Outbox(f.peer, () => false, assert.ifError);
  out.stream(frames(out, 1000, built));
  assert.deepEqual([f.sent.length, built.n], [2, 2], "the second frame filled the socket");
  let made = 0;
  for (let i = 0; i < 100; i++) out.answer(() => made++);
  assert.equal(made, 0, "no answer is built for a peer that does not read");
  assert.equal(f.drains.length, 1, "one wait for 'drain', however many answers queue");
  f.empty();
  await tick();
  assert.equal(made, 100, "the answers go first once it drained");
  assert.equal(built.n, 3, "then the stream goes on");
});

test("4.5 one stream runs at a time: the next starts when the one before it is done", async () => {
  const f = fake(1);
  const out = new Outbox(f.peer, () => false, assert.ifError);
  out.stream(frames(out, 2, undefined, 10));
  out.stream(frames(out, 2, undefined, 20));
  for (let i = 0; i < 4; i++) {
    f.empty();
    await tick();
  }
  assert.deepEqual(f.sent, ["head 10", "head 11", "head 20", "head 21"]);
});

test("3.10 a long stream yields to the event loop every 256 steps", async () => {
  const f = fake();
  const built = { n: 0 };
  const out = new Outbox(f.peer, () => false, assert.ifError);
  out.stream(frames(out, 600, built));
  assert.equal(built.n, 256);
  await tick();
  await tick();
  assert.equal(built.n, 600);
});

test("6.5 a relay that went silent builds nothing more and drops what waits", () => {
  const f = fake();
  let silent = false;
  const out = new Outbox(f.peer, () => silent, assert.ifError);
  out.stream(frames(out, 3));
  silent = true;
  out.answer(() => out.send(result(1)));
  out.stream(frames(out, 3));
  silent = false;
  out.answer(() => out.send(result(2)));
  assert.deepEqual(f.sent, ["head 0", "head 1", "head 2"], "nothing after the relay went silent");
});

test("2.4 an error a job or a step throws is handed to `fail`, and nothing more is built", () => {
  const f = fake();
  const errors: unknown[] = [];
  const out = new Outbox(
    f.peer,
    () => false,
    (e) => errors.push(e),
  );
  out.answer(() => {
    throw new RangeError("a frame past its limit");
  });
  out.answer(() => out.send(result(1)));
  assert.equal(errors.length, 1);
  assert.deepEqual(f.sent, []);
  out.stream(frames(out, 2));
  assert.deepEqual(f.sent, [], "the outbox is closed");
});

test("4.5 end sends the frame and closes: no answer or step is built after it", () => {
  const f = fake();
  const out = new Outbox(f.peer, () => false, assert.ifError);
  out.stream(frames(out, 1000));
  out.end(result(9));
  out.answer(() => out.send(result(1)));
  assert.deepEqual(f.ended, [result(9)]);
  assert.ok(f.sent.length <= 256, "the stream stopped");
  const before = f.sent.length;
  out.answer(() => out.send(result(2)));
  assert.equal(f.sent.length, before);
});

/** One head per step, as a pass sends: numbered from `from`. */
const head = (n: number): Frame => ({
  type: "head",
  n,
  chain: new Uint8Array(32),
  sig: new Uint8Array(64),
});

test("3.1 a pass queued during a stream runs before the stream's next step, and the stream resumes where it stopped", () => {
  const f = fake();
  const out = new Outbox(f.peer, () => false, assert.ifError);
  out.stream(
    (function* () {
      out.send(head(0));
      yield;
      out.follow(frames(out, 2, undefined, 100));
      out.send(head(1));
      yield;
      out.send(head(2));
      yield;
    })(),
  );
  assert.deepEqual(f.sent, ["head 0", "head 1", "head 100", "head 101", "head 2"]);
});

test("3.1 two passes run in order, the first to its end", () => {
  const f = fake();
  const out = new Outbox(f.peer, () => false, assert.ifError);
  out.stream(
    (function* () {
      out.send(head(0));
      yield;
      out.follow(frames(out, 2, undefined, 100));
      out.follow(frames(out, 2, undefined, 200));
      yield;
      out.send(head(1));
    })(),
  );
  assert.deepEqual(f.sent, ["head 0", "head 100", "head 101", "head 200", "head 201", "head 1"]);
});

test("3.1 an answer queued during a pass goes before that pass's next step", () => {
  const f = fake();
  const out = new Outbox(f.peer, () => false, assert.ifError);
  out.follow(
    (function* () {
      out.send(head(100));
      yield;
      out.answer(() => out.send(result(1)));
      yield;
      out.send(head(101));
    })(),
  );
  assert.deepEqual(f.sent, ["head 100", "result 1", "head 101"]);
});

test("3.3 'drain' stops both lanes: a pass and a stream take one step each time the socket empties, the pass first", async () => {
  const f = fake(1);
  const out = new Outbox(f.peer, () => false, assert.ifError);
  out.follow(frames(out, 2, undefined, 100));
  out.stream(frames(out, 2, undefined, 0));
  assert.deepEqual(f.sent, ["head 100"], "the first frame filled the socket");
  assert.equal(f.drains.length, 1);
  for (let i = 0; i < 4; i++) {
    f.empty();
    await tick();
  }
  assert.deepEqual(f.sent, ["head 100", "head 101", "head 0", "head 1"]);
});

test("3.1 a pass queued while the socket is full takes the first step after 'drain', ahead of the stream", async () => {
  const f = fake(1);
  const out = new Outbox(f.peer, () => false, assert.ifError);
  out.stream(frames(out, 3, undefined, 0));
  assert.deepEqual(f.sent, ["head 0"]);
  out.follow(frames(out, 1, undefined, 100));
  assert.deepEqual(f.sent, ["head 0"], "nothing is sent while the socket is full");
  f.empty();
  await tick();
  assert.deepEqual(f.sent, ["head 0", "head 100"]);
  f.empty();
  await tick();
  assert.deepEqual(f.sent, ["head 0", "head 100", "head 1"]);
});

test("3.3 after 'drain' no step runs before the next turn of the event loop", async () => {
  const f = fake(1);
  const built = { n: 0 };
  const out = new Outbox(f.peer, () => false, assert.ifError);
  out.stream(frames(out, 3, built));
  assert.equal(built.n, 1);
  f.empty();
  assert.equal(built.n, 1, "not inside the 'drain' emit");
  await tick();
  assert.equal(built.n, 2);
});

test("3.6 close drops both lanes: nothing is built when the socket drains", async () => {
  const f = fake(1);
  const out = new Outbox(f.peer, () => false, assert.ifError);
  out.stream(frames(out, 3, undefined, 0));
  out.follow(frames(out, 3, undefined, 100));
  out.close();
  f.empty();
  await tick();
  await tick();
  assert.deepEqual(f.sent, ["head 0"]);
});
