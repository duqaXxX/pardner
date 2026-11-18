/**
 * The frames of the relay's connection (design 6.7): each type's bytes by hand from the table, the
 * length and its limits, and what is refused. The model carries no frames, so these tests hold the
 * design's text (design 9).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import { encodeDeviceEntry } from "../../src/protocol/device-log.ts";
import type { HistorySeal } from "../../src/protocol/epochs.ts";
import {
  decodeFrame,
  encodeFrame,
  type Frame,
  frameLength,
  fromRelay,
  namesOf,
} from "../../src/protocol/frames.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { runVectors } from "../../src/protocol/vectors.ts";

/** The frames that cross before a proof; the handshake ones never cross after it. */
const BEFORE = ["hello", "refused", "prove-active", "prove-recovery", "prove-upload", "enrol"];
const HANDSHAKE = BEFORE.filter((n) => n !== "refused");
/** Decodes as the side that reads this type: the relay reads a device's types, a device the relay's. */
const readFrame = (bytes: Bytes, proven: boolean, side?: "device" | "relay") =>
  decodeFrame(bytes, proven, side ?? ((bytes[4] ?? 0) >= 0x40 ? "device" : "relay"));
const fill = (n: number, length = 32): Bytes => new Uint8Array(length).fill(n);
const cat = (...parts: Bytes[]): Bytes => new Uint8Array(Buffer.concat(parts));
const u = (value: number, size: number): Bytes => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(value));
  return new Uint8Array(b.subarray(8 - size));
};
const pk = Uint8Array.of(4, ...fill(9, 64));
const session = { relay: fill(1), deviceNonce: fill(2), relayNonce: fill(3), binding: fill(4) };
const device = { kind: "app" as const, signing: pk, receiving: pk };
const seal: HistorySeal = {
  channel: fill(5),
  epoch: fill(6),
  recipient: fill(7),
  enc: pk,
  sealed: fill(8, 48),
  maker: fill(9),
};
const sealBytes = (): Bytes => {
  const label = Buffer.from("blind-relay/1 history-seal");
  return cat(
    Uint8Array.of(label.length),
    label,
    fill(5),
    fill(6),
    fill(7),
    pk,
    fill(8, 48),
    fill(9),
  );
};
const head = { relay: fill(1), n: 3, chain: fill(7) };
const sig = (n: number): Bytes => fill(n, 64);
const label = (text: string): Bytes => {
  const t = Buffer.from(`blind-relay/1 ${text}`);
  return cat(Uint8Array.of(t.length), t);
};
const D = cat(Uint8Array.of(1), pk, pk);
const common = cat(fill(1), fill(2), fill(3), fill(4));
const headBytes = cat(label("relay-head"), fill(1), u(3, 8), fill(7));

/** Every type with its code and the bytes after the code that the design's table gives. */
const TYPES: [string, number, Frame, Bytes][] = [
  ["hello", 0x40, { type: "hello", relayNonce: fill(3) }, fill(3)],
  [
    "prove-active",
    0x01,
    {
      type: "prove-active",
      proof: { ...session, kind: "active", person: fill(5), device: fill(6) },
      sig: sig(1),
    },
    cat(label("proof-active"), common, fill(5), fill(6), sig(1)),
  ],
  [
    "prove-recovery",
    0x02,
    {
      type: "prove-recovery",
      proof: {
        ...session,
        kind: "recovery",
        person: fill(5),
        recovery: fill(8),
        newDevice: device,
      },
      recoverySig: sig(1),
      deviceSig: sig(2),
    },
    cat(label("proof-recovery"), common, fill(5), fill(8), D, sig(1), sig(2)),
  ],
  [
    "prove-upload",
    0x0a,
    {
      type: "prove-upload",
      proof: { ...session, kind: "upload", device, head },
      deviceSig: sig(1),
      relaySig: sig(2),
    },
    cat(label("proof-upload"), common, D, headBytes, sig(1), sig(2)),
  ],
  ["refused", 0x48, { type: "refused", reason: 6 }, Uint8Array.of(6)],
  ["served", 0x41, { type: "served", incarnation: fill(5, 16) }, fill(5, 16)],
  ["read", 0x03, { type: "read", from: 7 }, u(7, 8)],
  [
    "position",
    0x42,
    { type: "position", from: 7, incarnation: fill(5, 16) },
    cat(u(7, 8), fill(5, 16)),
  ],
  [
    "head",
    0x49,
    { type: "head", n: 3, chain: fill(7), sig: sig(1) },
    cat(u(3, 8), fill(7), sig(1)),
  ],
  [
    "item",
    0x43,
    { type: "item", position: 2, kind: 4, signed: fill(5, 10), sig: sig(1) },
    cat(u(2, 8), Uint8Array.of(4), u(10, 4), fill(5, 10), sig(1)),
  ],
  [
    "submit",
    0x04,
    { type: "submit", request: 9, kind: 1, signed: fill(5, 10), sig: sig(1) },
    cat(u(9, 4), Uint8Array.of(1), u(10, 4), fill(5, 10), sig(1)),
  ],
  ["result", 0x44, { type: "result", request: 9, code: 11 }, cat(u(9, 4), Uint8Array.of(11))],
  [
    "give-seal",
    0x05,
    { type: "give-seal", request: 9, seal, sig: sig(1) },
    cat(u(9, 4), sealBytes(), sig(1)),
  ],
  [
    "seals",
    0x45,
    {
      type: "seals",
      items: [
        { seal, sig: sig(1) },
        { seal, sig: sig(2) },
      ],
    },
    cat(u(2, 4), sealBytes(), sig(1), sealBytes(), sig(2)),
  ],
  [
    "put-blob",
    0x06,
    { type: "put-blob", request: 9, blob: fill(5), size: 100, offset: 40, chunk: fill(6, 3) },
    cat(u(9, 4), fill(5), u(100, 8), u(40, 8), u(3, 4), fill(6, 3)),
  ],
  [
    "get-blob",
    0x07,
    { type: "get-blob", request: 9, blob: fill(5), offset: 40 },
    cat(u(9, 4), fill(5), u(40, 8)),
  ],
  [
    "blob",
    0x46,
    { type: "blob", request: 9, size: 100, offset: 40, chunk: fill(6, 3) },
    cat(u(9, 4), u(100, 8), u(40, 8), u(3, 4), fill(6, 3)),
  ],
  ["recovery-log", 0x08, { type: "recovery-log", request: 9 }, u(9, 4)],
  [
    "log",
    0x47,
    {
      type: "log",
      request: 9,
      entries: [
        { signed: fill(5, 4), sig: sig(1) },
        { signed: fill(6, 2), sig: sig(2) },
      ],
    },
    cat(u(9, 4), u(2, 4), u(4, 4), fill(5, 4), sig(1), u(2, 4), fill(6, 2), sig(2)),
  ],
  [
    "upload-done",
    0x0c,
    { type: "upload-done", request: 9, head, sig: sig(1) },
    cat(u(9, 4), headBytes, sig(1)),
  ],
  [
    "enrol",
    0x0d,
    { type: "enrol", secret: fill(5), signed: fill(6, 4), sig: sig(1) },
    cat(fill(5), u(4, 4), fill(6, 4), sig(1)),
  ],
];

for (const [name, code, frame, body] of TYPES) {
  test(`a ${name} frame is its length, ${code.toString(16)}, then its fields (6.7)`, () => {
    const bytes = cat(u(body.length + 1, 4), Uint8Array.of(code), body);
    const proven = !BEFORE.includes(name);
    assert.deepEqual(encodeFrame(frame, proven), bytes);
    assert.deepEqual(readFrame(bytes, proven), { ok: true, value: frame });
    assert.equal(fromRelay(frame), code >= 0x40);
  });
}

const framed = (code: number, body: Bytes): Bytes =>
  cat(u(body.length + 1, 4), Uint8Array.of(code), body);

test("before a proof a frame is at most 4,096 bytes, after it 1 MiB; one past its limit is refused", () => {
  assert.deepEqual(frameLength(u(4096, 4), false), { ok: true, value: 4096 });
  assert.equal(frameLength(u(4097, 4), false).ok, false);
  assert.deepEqual(frameLength(u(1_048_576, 4), true), { ok: true, value: 1_048_576 });
  assert.equal(frameLength(u(1_048_577, 4), true).ok, false);
  assert.equal(frameLength(u(0, 4), true).ok, false, "no type byte");
  assert.equal(frameLength(u(5, 3), true).ok, false, "a length of three bytes");
  const rest = 1_048_576 - (1 + 4 + 1 + 4 + 64); // the type, request, kind, length and signature
  const biggest: Frame = {
    type: "submit",
    request: 1,
    kind: 1,
    signed: fill(1, rest),
    sig: sig(1),
  };
  assert.equal(encodeFrame(biggest, true).length, 4 + 1_048_576);
  assert.equal(readFrame(encodeFrame(biggest, true), true).ok, true);
  assert.throws(() => encodeFrame({ ...biggest, signed: fill(1, rest + 1) }, true), RangeError);
  assert.equal(
    readFrame(
      framed(0x04, cat(u(1, 4), Uint8Array.of(1), u(rest + 1, 4), fill(1, rest + 1), sig(1))),
      true,
    ).ok,
    false,
  );
  const proof = TYPES[1] as (typeof TYPES)[number];
  assert.equal(readFrame(encodeFrame(proof[2], false), false).ok, true, "a proof fits before one");
  assert.equal(readFrame(cat(u(4097, 4), Uint8Array.of(0x40), fill(1, 4096)), false).ok, false);
});

test("before a proof only the proofs, hello, refused and enrol are taken; after it hello, the proofs and enrol are not", () => {
  for (const [name, , frame] of TYPES) {
    const state = !BEFORE.includes(name);
    const bytes = encodeFrame(frame, state);
    assert.equal(readFrame(bytes, false).ok, BEFORE.includes(name), `${name} before a proof`);
    assert.equal(readFrame(bytes, true).ok, !HANDSHAKE.includes(name), `${name} after a proof`);
    // encode follows the same rule as decode (7b-CR4)
    if (state) assert.throws(() => encodeFrame(frame, false), RangeError, name);
    if (HANDSHAKE.includes(name)) assert.throws(() => encodeFrame(frame, true), RangeError, name);
  }
});

test("each side decodes only the other's types: below 0x40 from a device, from 0x40 on from the relay", () => {
  for (const [name, code, frame] of TYPES) {
    const bytes = encodeFrame(frame, !BEFORE.includes(name));
    const [reader, other] =
      code >= 0x40 ? (["device", "relay"] as const) : (["relay", "device"] as const);
    assert.equal(
      decodeFrame(bytes, !BEFORE.includes(name), reader).ok,
      true,
      `${name} read by the ${reader}`,
    );
    assert.equal(
      decodeFrame(bytes, !BEFORE.includes(name), other).ok,
      false,
      `${name} read by the ${other}`,
    );
  }
});

test("a type that is not in the table is no relay frame", () => {
  assert.equal(fromRelay({ type: "nothing" } as unknown as Frame), false);
  assert.equal(fromRelay({ type: "constructor" } as unknown as Frame), false);
});

test("a retired or unknown code is refused: refused 4, results 6 and 10, and types no table names", () => {
  assert.equal(
    readFrame(framed(0x48, Uint8Array.of(4)), true).ok,
    false,
    "4 (restoring) is retired",
  );
  for (const reason of [0, 7, 255])
    assert.equal(readFrame(framed(0x48, Uint8Array.of(reason)), true).ok, false);
  for (const reason of [1, 2, 3, 5, 6])
    assert.equal(readFrame(framed(0x48, Uint8Array.of(reason)), true).ok, true);
  for (const code of [6, 10, 12, 255])
    assert.equal(
      readFrame(framed(0x44, cat(u(1, 4), Uint8Array.of(code))), true).ok,
      false,
      `result ${code}`,
    );
  for (const code of [0, 1, 2, 3, 4, 5, 7, 8, 9, 11])
    assert.equal(
      readFrame(framed(0x44, cat(u(1, 4), Uint8Array.of(code))), true).ok,
      true,
      `result ${code}`,
    );
  // @ts-expect-error a retired code is no value of the field's type
  assert.throws(() => encodeFrame({ type: "refused", reason: 4 }, true), RangeError);
  // @ts-expect-error a retired code is no value of the field's type
  assert.throws(() => encodeFrame({ type: "result", request: 1, code: 6 }, true), RangeError);
  // @ts-expect-error a retired code is no value of the field's type
  assert.throws(() => encodeFrame({ type: "result", request: 1, code: 10 }, true), RangeError);
  for (const type of [0x00, 0x09, 0x0b, 0x3f, 0x4a, 0x7f, 0xff])
    assert.equal(readFrame(framed(type, fill(1, 8)), true).ok, false, `type ${type}`);
  assert.throws(() => encodeFrame({ type: "nothing" } as unknown as Frame, true), RangeError);
  assert.throws(
    () => encodeFrame({ type: "upload-items", request: 9, items: [] } as unknown as Frame, true),
    RangeError,
  );
});

test("a list too large for one frame spans several frames, each of which encodes and decodes (6.7)", () => {
  const rows = Array.from({ length: 3200 }, () => ({ seal, sig: sig(1) }));
  assert.throws(() => encodeFrame({ type: "seals", items: rows }, true), RangeError);
  const parts: Frame[] = [];
  for (let at = 0; at < rows.length; at += 1600)
    parts.push({ type: "seals", items: rows.slice(at, at + 1600) });
  const back = parts.flatMap((part) => {
    const read = readFrame(encodeFrame(part, true), true);
    assert.ok(read.ok && read.value.type === "seals");
    return read.ok && read.value.type === "seals" ? read.value.items : [];
  });
  assert.deepEqual(back, rows);
});

test("a SPEC entry that reuses a retired code throws when the names are built", () => {
  assert.throws(() => namesOf({ again: [0x09, ""] }, new Set([0x09])), RangeError);
});

test("a frame whose bytes do not fit its length or its fields is refused", () => {
  const good = encodeFrame({ type: "read", from: 7 }, true);
  assert.equal(readFrame(cat(good, Uint8Array.of(0)), true).ok, false, "a byte past the length");
  assert.equal(readFrame(good.slice(0, -1), true).ok, false, "a byte short");
  assert.equal(
    readFrame(framed(0x03, cat(u(7, 8), Uint8Array.of(0))), true).ok,
    false,
    "a byte left in the body",
  );
  assert.equal(readFrame(framed(0x03, u(7, 7)), true).ok, false, "a field cut");
  assert.equal(readFrame(framed(0x03, fill(0xff, 8)), true).ok, false, "a u64 past 2^53 - 1");
  assert.equal(
    readFrame(framed(0x43, cat(u(1, 8), Uint8Array.of(5), u(0, 4), sig(1))), true).ok,
    false,
    "item kind 5",
  );
  assert.equal(
    readFrame(framed(0x43, cat(u(1, 8), Uint8Array.of(0), u(0, 4), sig(1))), true).ok,
    false,
    "item kind 0",
  );
  assert.equal(
    readFrame(framed(0x47, cat(u(1, 4), u(0xffffff, 4))), true).ok,
    false,
    "a count past the bytes",
  );
  assert.equal(readFrame(framed(0x40, fill(3, 33)), false).ok, false);
  assert.equal(readFrame(new Uint8Array(3), true).ok, false);
  assert.equal(readFrame("a" as unknown as Bytes, true).ok, false);
});

test("a proof frame carries the proof of its own kind, and a signature that is not 64 bytes does not encode", () => {
  const body = cat(label("proof-active"), common, fill(5), fill(6), sig(1), sig(2));
  assert.equal(
    readFrame(framed(0x02, body), false).ok,
    false,
    "an active proof in a recovery frame",
  );
  const [, , active] = TYPES[1] as (typeof TYPES)[number];
  const proof = (active as Extract<Frame, { type: "prove-active" }>).proof;
  const wrong = { type: "prove-recovery", proof, recoverySig: sig(1), deviceSig: sig(2) };
  assert.throws(() => encodeFrame(wrong as unknown as Frame, false), RangeError);
  const short = { ...(active as Extract<Frame, { type: "prove-active" }>), sig: fill(1, 63) };
  assert.throws(() => encodeFrame(short, false), RangeError);
});

test("the vectors of frames.json pass, and a changed expectation is named", () => {
  const file = JSON.parse(
    readFileSync(join(import.meta.dirname, "vectors", "frames.json"), "utf8"),
  );
  const platform = createNodePlatform();
  assert.deepEqual(runVectors(platform, file), []);
  assert.ok(file.cases.length >= 28);
  const changed = structuredClone(file);
  changed.cases[0].output = "00";
  assert.deepEqual(runVectors(platform, changed), [changed.cases[0].name]);
});

test("an enrol frame carrying a real genesis entry fits the 4,096 bytes before a proof, and has no request id (6.7)", () => {
  const signed = encodeDeviceEntry({
    seq: 0,
    kind: "genesis",
    device,
    recovery: device,
    signer: fill(1),
  });
  const frame: Frame = { type: "enrol", secret: fill(5), signed, sig: sig(1) };
  const bytes = encodeFrame(frame, false);
  assert.ok(bytes.length < 1024, `${bytes.length} bytes`);
  assert.deepEqual(readFrame(bytes, false), { ok: true, value: frame });
  assert.equal(readFrame(bytes, true).ok, false, "refused after a proof");
  assert.equal(decodeFrame(bytes, false, "device").ok, false, "a device never reads it");
});
