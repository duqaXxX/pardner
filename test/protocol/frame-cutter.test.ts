/** `FrameCutter`: whole frames out of a byte stream, with the length limit of the state it is asked in. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFrame, type Frame, FrameCutter } from "../../src/protocol/frames.ts";
import type { Bytes } from "../../src/protocol/platform.ts";

const hello: Frame = { type: "hello", relayNonce: new Uint8Array(32).fill(4) };
const refused: Frame = { type: "refused", reason: 5 };
const bytesOf = (...frames: Frame[]): Bytes =>
  new Uint8Array(frames.flatMap((f) => [...encodeFrame(f, false)]));

/** Every whole frame the cutter holds, as the bytes it returns. */
function drain(cutter: FrameCutter, proven = false): Bytes[] {
  const out: Bytes[] = [];
  for (;;) {
    const next = cutter.next(proven);
    assert.ok(next.ok);
    if (!next.value) return out;
    out.push(next.value);
  }
}

test("a frame arriving one byte at a time comes out once, when it is whole", () => {
  const cutter = new FrameCutter();
  const frame = bytesOf(hello);
  const got: Bytes[] = [];
  for (const b of frame) {
    cutter.push(new Uint8Array([b]));
    got.push(...drain(cutter));
  }
  assert.deepEqual(got, [frame]);
});

test("several frames in one chunk come out in order, and the rest waits", () => {
  const cutter = new FrameCutter();
  const all = bytesOf(hello, refused, hello);
  cutter.push(all.subarray(0, all.length - 3));
  assert.deepEqual(drain(cutter), [bytesOf(hello), bytesOf(refused)]);
  cutter.push(all.subarray(all.length - 3));
  assert.deepEqual(drain(cutter), [bytesOf(hello)]);
});

test("a prefix split across chunks is read once its four bytes are in", () => {
  const cutter = new FrameCutter();
  const frame = bytesOf(refused);
  cutter.push(frame.subarray(0, 2));
  assert.deepEqual(drain(cutter), []);
  cutter.push(frame.subarray(2, 4));
  assert.deepEqual(drain(cutter), []);
  cutter.push(frame.subarray(4));
  assert.deepEqual(drain(cutter), [frame]);
});

test("the limit is the caller's: 4,096 before a proof, 1 MiB after it", () => {
  const prefix = (n: number) => {
    const p = new Uint8Array(4);
    new DataView(p.buffer).setUint32(0, n);
    return p;
  };
  for (const [proven, over, at] of [
    [false, 4097, 4096],
    [true, 1_048_577, 1_048_576],
  ] as const) {
    const bad = new FrameCutter();
    bad.push(prefix(over));
    assert.deepEqual(bad.next(proven), { ok: false, error: "bad-input" });
    const edge = new FrameCutter();
    edge.push(prefix(at));
    assert.deepEqual(edge.next(proven), { ok: true, value: undefined }, "the body is awaited");
  }
});

test("a zero length is bad, before any body", () => {
  const cutter = new FrameCutter();
  cutter.push(new Uint8Array(4));
  assert.equal(cutter.next(false).ok, false);
});

test("reset forgets the bytes held", () => {
  const cutter = new FrameCutter();
  cutter.push(bytesOf(hello).subarray(0, 10));
  cutter.reset();
  cutter.push(bytesOf(refused));
  assert.deepEqual(drain(cutter), [bytesOf(refused)]);
});

test("push keeps its own copy: the caller may reuse its buffer", () => {
  const cutter = new FrameCutter();
  const frame = bytesOf(hello);
  const buffer = frame.slice();
  cutter.push(buffer.subarray(0, 10));
  buffer.fill(0);
  cutter.push(frame.subarray(10));
  assert.deepEqual(drain(cutter), [frame]);
});
