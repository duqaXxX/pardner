import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFrame, type Frame } from "../../src/protocol/frames.ts";
import { FRAME_WHOLE_MS, FrameReader, PartialBytes } from "../../src/relay/frames-in.ts";

const bytes = (n: number, length: number) => new Uint8Array(length).fill(n);
const enrol = (signed = 4): Frame => ({
  type: "enrol",
  secret: bytes(5, 32),
  signed: bytes(6, signed),
  sig: bytes(1, 64),
});
const wire = (frame: Frame, proven = false) => Buffer.from(encodeFrame(frame, proven));
const prefix = (length: number) =>
  Buffer.from([length >>> 24, length >>> 16, length >>> 8, length].map((b) => b & 255));

function reader(max?: number) {
  const clock = { now: 5_000 };
  const budget = new PartialBytes(max);
  return { clock, budget, reader: new FrameReader(budget, () => clock.now) };
}

test("a reader told to stop returns the bytes after the frame it stopped at, and takes them as the frames they are (4.5)", () => {
  const { reader: r } = reader();
  const chunk = Buffer.concat([wire(enrol(4)), wire(enrol(9)), wire(enrol(7))]);
  const first = r.push(chunk, () => false);
  assert.ok("frames" in first);
  assert.equal(first.frames.length, 1);
  assert.ok(first.rest);
  const rest = r.push(first.rest);
  assert.ok("frames" in rest);
  assert.deepEqual(
    rest.frames.map((f) => f.type === "enrol" && f.signed.length),
    [9, 7],
  );
  assert.equal(rest.rest, undefined);
});

test("bytes held by the caller's own stop are not a slow frame: the 30 s of the next frame start when it is read (4.3, 4.5)", () => {
  const { clock, reader: r } = reader();
  const next = wire(enrol(9));
  const first = r.push(Buffer.concat([wire(enrol(4)), next.subarray(0, 10)]), () => false);
  assert.ok("frames" in first && first.rest);
  assert.equal(r.deadline, null, "nothing is being read while the caller holds the rest");
  clock.now += FRAME_WHOLE_MS + 1;
  assert.deepEqual(r.push(first.rest), { frames: [] });
  assert.equal(
    r.deadline,
    clock.now + FRAME_WHOLE_MS,
    "the 30 s count from when its bytes were read",
  );
});

test("a frame is taken whole, however its bytes are cut, and two in one chunk are two frames (4.3)", () => {
  const { reader: r, budget } = reader();
  const a = wire(enrol(4));
  const b = wire(enrol(9));
  assert.deepEqual(r.push(a.subarray(0, 2)), { frames: [] });
  assert.deepEqual(r.push(a.subarray(2, 30)), { frames: [] });
  const done = r.push(Buffer.concat([a.subarray(30), b]));
  assert.ok("frames" in done);
  assert.deepEqual(
    done.frames.map((f) => f.type === "enrol" && f.signed.length),
    [4, 9],
  );
  assert.equal(budget.held, 0, "nothing is held for a frame once it is whole");
  assert.equal(r.deadline, null);
});

test("a length over 4,096, or zero, closes before the body is read, and 4,096 is taken (4.3, AD 4.2)", () => {
  assert.deepEqual(reader().reader.push(prefix(4097)), { closed: "length" });
  assert.deepEqual(reader().reader.push(prefix(0)), { closed: "length" });
  const { reader: r, budget } = reader();
  assert.deepEqual(r.push(Buffer.concat([prefix(4096), Buffer.alloc(10)])), { frames: [] });
  assert.equal(budget.held, 4100, "the body that was announced is the bound");
});

test("after a proof the length limit is 1 MiB, and one more byte closes (PD 6.7)", () => {
  const { reader: r } = reader();
  r.proven = true;
  assert.deepEqual(r.push(prefix(1_048_577)), { closed: "length" });
  const { reader: s } = reader();
  s.proven = true;
  assert.deepEqual(s.push(prefix(1_048_576)), { frames: [] });
});

test("a frame the package refuses closes: a type a device does not send, a frame not allowed first, junk (4.3)", () => {
  const hello = wire({ type: "hello", relayNonce: bytes(1, 32) });
  assert.deepEqual(reader().reader.push(hello), { closed: "frame" });
  const read = Buffer.from(encodeFrame({ type: "read", from: 0 }, true));
  assert.deepEqual(reader().reader.push(read), { closed: "frame" }, "a request before a proof");
  assert.deepEqual(reader().reader.push(Buffer.concat([prefix(3), Buffer.from([0x0d, 1, 2])])), {
    closed: "frame",
  });
  assert.deepEqual(reader().reader.push(Buffer.concat([prefix(1), Buffer.from([0x09])])), {
    closed: "frame",
  });
});

test("a frame is whole within 30 s of its first byte, and the clock restarts for the next one (review S1)", () => {
  const { clock, reader: r } = reader();
  const frame = wire(enrol());
  assert.equal(r.deadline, null);
  r.push(frame.subarray(0, 1));
  assert.equal(r.deadline, 5_000 + FRAME_WHOLE_MS);
  clock.now += 29_000;
  r.push(frame.subarray(1, 10));
  assert.equal(r.deadline, 5_000 + FRAME_WHOLE_MS, "a trickle does not move it");
  clock.now += 500;
  const done = r.push(Buffer.concat([frame.subarray(10), frame.subarray(0, 3)]));
  assert.ok("frames" in done && done.frames.length === 1);
  assert.equal(
    r.deadline,
    clock.now + FRAME_WHOLE_MS,
    "the next frame's first bytes start its own clock",
  );
});

test("a length that would pass the relay's 64 MiB of partial frames closes that connection, and what a connection held is given back (4.3)", () => {
  const { budget, reader: a } = reader(10_000);
  const b = new FrameReader(budget);
  assert.deepEqual(a.push(prefix(4096)), { frames: [] });
  assert.deepEqual(b.push(prefix(4096)), { frames: [] });
  assert.equal(budget.held, 8200);
  const c = new FrameReader(budget);
  assert.deepEqual(c.push(prefix(4096)), { closed: "bytes" });
  assert.equal(budget.held, 8200, "the refused one holds nothing");
  a.release();
  assert.equal(budget.held, 4100);
  assert.deepEqual(c.push(prefix(4096)), { frames: [] }, "the next try is admitted");
  b.release();
  c.release();
  assert.equal(budget.held, 0);
  a.release();
  assert.equal(budget.held, 0, "a second release gives nothing back");
});

test("a closing frame gives its reservation back at once", () => {
  const { budget, reader: r } = reader();
  r.push(prefix(4096));
  assert.equal(budget.held, 4100);
  r.push(Buffer.alloc(5000).fill(0xff));
  assert.equal(budget.held, 0);
});

test("frames cut at every byte, the prefix included, come out the same as whole ones (4.3, 2-C8)", () => {
  const { reader: r, budget } = reader();
  const stream = Buffer.concat([wire(enrol(4)), wire(enrol(9)), wire(enrol(1))]);
  const seen: number[] = [];
  for (let i = 0; i < stream.length; i++) {
    const taken = r.push(stream.subarray(i, i + 1));
    assert.ok("frames" in taken);
    for (const f of taken.frames) seen.push(f.type === "enrol" ? f.signed.length : -1);
  }
  assert.deepEqual(seen, [4, 9, 1]);
  assert.equal(budget.held, 0);
  assert.equal(r.deadline, null);
});

test("a restart gives a frame partly read its 30 s again, and a reader with none being read stays without a deadline (F2)", () => {
  const { clock, reader: r } = reader();
  r.restart();
  assert.equal(r.deadline, null);
  r.push(wire(enrol()).subarray(0, 3));
  clock.now += 20_000;
  r.restart();
  assert.equal(r.deadline, clock.now + FRAME_WHOLE_MS);
});
