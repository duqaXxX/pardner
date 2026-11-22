/**
 * Messages (design 6.4) on real bytes and real signatures. The structure tests of the model that
 * apply to bytes are here under the model's own words; a rule the model cannot hold is named after
 * the sentence of security design 5.6 it holds.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import { Writer } from "../../src/protocol/bytes.ts";
import { signedId } from "../../src/protocol/ids.ts";
import { labelBytes } from "../../src/protocol/labels.ts";
import {
  cutName,
  decodeBody,
  decodeHeader,
  decodeMessage,
  encodeBody,
  encodeHeader,
  encodeMessage,
  type MessageBody,
  type MessageHeader,
  openMessage,
  sealMessage,
  unreadName,
} from "../../src/protocol/messages.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { runVectors } from "../../src/protocol/vectors.ts";

const platform = createNodePlatform();
const fill = (n: number, length = 32): Bytes => new Uint8Array(length).fill(n);
const epochKey = fill(7);
const empty: MessageBody = { files: [], content: "{}" };

const base: Omit<MessageHeader, "blobs"> = {
  channel: fill(1),
  counter: 1,
  epoch: fill(2),
  sender: fill(3),
  run: fill(4, 16),
  incarnation: fill(5, 16),
  time: 1_700_000_000_000,
  kind: 1,
  name: fill(6, 16),
};
const header = (over: Partial<MessageHeader> = {}): MessageHeader => ({
  ...base,
  blobs: [],
  ...over,
});
const re = { device: fill(8), name: fill(9, 16) };
const err = (result: { ok: boolean; error?: string }) => (result.ok ? "ok" : result.error);

/** The header's bytes written field by field, with none of the package's checks: a decoder's input. */
function raw(over: {
  kind?: number;
  counter?: number;
  to?: boolean;
  re?: boolean;
  blobs?: Bytes[];
}) {
  const w = new Writer()
    .b32(base.channel)
    .u32(over.counter ?? 1)
    .b32(base.epoch)
    .b32(base.sender)
    .b16(base.run)
    .b16(base.incarnation)
    .u64(base.time)
    .u8(over.kind ?? 1);
  w.opt(over.to ? fill(10) : undefined, (x, v) => x.b32(v));
  w.opt(over.re ? re : undefined, (x, v) => x.b32(v.device).b16(v.name));
  w.list(over.blobs ?? [], (x, b) => x.b32(b));
  return w.b16(base.name).bytes();
}

// What the table of 6.4 allows, by kind, spelled out apart from the code's own table.
const ALLOWED: Record<number, string[]> = {
  1: ["none", "re"],
  2: ["to"],
  3: ["re"],
  4: ["re"],
  5: ["re"],
  6: ["re"],
  7: ["re"],
  8: ["none"],
  9: ["re"],
  10: ["to+re"],
  11: ["re", "to+re"],
  12: ["none"],
  13: ["none"],
  14: ["none"],
  15: ["none"],
  16: ["none"],
};
const shapes: Record<string, { to: boolean; re: boolean }> = {
  none: { to: false, re: false },
  to: { to: true, re: false },
  re: { to: false, re: true },
  "to+re": { to: true, re: true },
};

test("a header of each kind encodes and decodes back to the same bytes", () => {
  for (const [kind, list] of Object.entries(ALLOWED)) {
    const shape = shapes[list[0] as string] as { to: boolean; re: boolean };
    const h = header({
      kind: Number(kind),
      to: shape.to ? fill(10) : undefined,
      re: shape.re ? re : undefined,
      blobs: [fill(12), fill(11)],
    });
    const bytes = encodeHeader(h);
    const back = decodeHeader(bytes);
    assert.ok(back.ok);
    assert.deepEqual(back.value.blobs, [fill(11), fill(12)], "sorted on the wire");
    assert.deepEqual(encodeHeader(back.value), bytes);
    assert.deepEqual(back.value.re, h.re);
  }
});

test("the kind table both ways: the decoder takes exactly the shapes the table allows", () => {
  for (let kind = 1; kind <= 16; kind++)
    for (const [shape, flags] of Object.entries(shapes)) {
      const allowed = (ALLOWED[kind] as string[]).includes(shape);
      assert.equal(decodeHeader(raw({ kind, ...flags })).ok, allowed, `kind ${kind} ${shape}`);
      const h = header({
        kind,
        to: flags.to ? fill(10) : undefined,
        re: flags.re ? re : undefined,
      });
      if (allowed) encodeHeader(h);
      else assert.throws(() => encodeHeader(h), RangeError, `kind ${kind} ${shape}`);
    }
});

test("a kind outside the table fails to decode, and does not encode", () => {
  for (const kind of [0, 17, 255]) {
    assert.equal(decodeHeader(raw({ kind })).ok, false);
    assert.throws(() => encodeHeader(header({ kind })), RangeError);
  }
  assert.throws(() => encodeHeader(header({ kind: 1.5 })), RangeError);
});

test("a counter of 0 is refused, in both directions", () => {
  assert.equal(decodeHeader(raw({ counter: 0 })).ok, false);
  assert.throws(() => encodeHeader(header({ counter: 0 })), RangeError);
  assert.equal(decodeHeader(raw({ counter: 4_294_967_295 })).ok, true);
});

test("the blobs are a set: out of order or twice refuse to decode, twice does not encode", () => {
  assert.equal(decodeHeader(raw({ blobs: [fill(2), fill(1)] })).ok, false);
  assert.equal(decodeHeader(raw({ blobs: [fill(1), fill(1)] })).ok, false);
  assert.equal(decodeHeader(raw({ blobs: [fill(1), fill(2)] })).ok, true);
  assert.throws(() => encodeHeader(header({ blobs: [fill(1), fill(1)] })), RangeError);
});

test("a header or a message with a byte left over, a byte missing or another label fails to decode", () => {
  const bytes = encodeHeader(header());
  assert.equal(decodeHeader(Uint8Array.from([...bytes, 0])).ok, false);
  assert.equal(decodeHeader(bytes.slice(0, -1)).ok, false);
  const signed = sealMessage(platform, epochKey, base, empty);
  assert.equal(decodeMessage(signed).ok, true);
  assert.equal(decodeMessage(Uint8Array.from([...signed, 0])).ok, false);
  assert.equal(decodeMessage(signed.slice(0, -1)).ok, false);
  const other = Uint8Array.from(signed);
  other.set(labelBytes("epoch-entry"), 0);
  assert.equal(decodeMessage(other).ok, false);
  assert.deepEqual(decodeMessage("nope" as unknown as Bytes), { ok: false, error: "bad-input" });
});

test("a message seals, decodes, opens, and encodes back to its bytes", () => {
  const body: MessageBody = {
    files: [
      { blob: fill(21), fileKey: fill(22), size: 5, type: "text/plain", name: "näme.txt" },
      { blob: fill(20), fileKey: fill(23), size: 2 ** 40, type: "image/png", name: "p.png" },
    ],
    content: '{"text":"héllo"}',
  };
  const signed = sealMessage(platform, epochKey, base, body);
  const message = decodeMessage(signed);
  assert.ok(message.ok);
  assert.deepEqual(encodeMessage(message.value), signed);
  assert.deepEqual(message.value.header.blobs, [fill(20), fill(21)]);
  const opened = openMessage(platform, epochKey, message.value);
  assert.ok(opened.ok);
  assert.deepEqual(opened.value.content, body.content);
  assert.deepEqual(opened.value.files, [...body.files].reverse());
});

test("the body is list(file) then var(content), the files written sorted, read as a list", () => {
  const files = [
    { blob: fill(1), fileKey: fill(2), size: 3, type: "t", name: "f" },
    { blob: fill(5), fileKey: fill(6), size: 7, type: "", name: "" },
  ];
  const w = new Writer().u32(2);
  for (const f of files)
    w.b32(f.blob)
      .b32(f.fileKey)
      .u64(f.size)
      .var(platform.utf8Encode(f.type))
      .var(platform.utf8Encode(f.name));
  const bytes = w.var(platform.utf8Encode("hi")).bytes();
  assert.deepEqual(encodeBody(platform, { files: [...files].reverse(), content: "hi" }), bytes);
  assert.deepEqual(decodeBody(platform, bytes), { ok: true, value: { files, content: "hi" } });
  const unsorted = new Writer().u32(2);
  for (const f of [...files].reverse())
    unsorted
      .b32(f.blob)
      .b32(f.fileKey)
      .u64(f.size)
      .var(platform.utf8Encode(f.type))
      .var(platform.utf8Encode(f.name));
  const listed = decodeBody(platform, unsorted.var(platform.utf8Encode("hi")).bytes());
  assert.deepEqual(listed, { ok: true, value: { files: [...files].reverse(), content: "hi" } });
  const notUtf8 = new Writer().u32(0).var(Uint8Array.of(0xff)).bytes();
  assert.equal(decodeBody(platform, notUtf8).ok, false);
});

/** The sender key the way 6.4 gives it, to craft what the package would not make. */
const senderKey = (h: MessageHeader) =>
  platform.hkdf(
    epochKey,
    new Writer().label("sender").b32(h.channel).b32(h.epoch).b32(h.sender).b16(h.run).bytes(),
    32,
  );
const nonce = (counter: number) => new Writer().raw(new Uint8Array(8)).u32(counter).bytes();

/** A message whose header and body the caller chose, sealed correctly: only what they say can fail it. */
function crafted(h: MessageHeader, plain: Bytes) {
  const ciphertext = platform.aesGcmSeal(senderKey(h), nonce(h.counter), encodeHeader(h), plain);
  return { header: h, ciphertext };
}
const file = (n: number) => ({
  blob: fill(n),
  fileKey: fill(n + 1),
  size: n,
  type: "t",
  name: "f",
});

test("the files of the body must equal the header's blobs, in the same order, else it fails to open", () => {
  const two = encodeBody(platform, { files: [file(1), file(5)], content: "{}" });
  const one = encodeBody(platform, { files: [file(1)], content: "{}" });
  const open = (blobs: Bytes[], plain: Bytes) =>
    err(openMessage(platform, epochKey, crafted(header({ blobs }), plain)));
  assert.equal(open([fill(1), fill(5)], two), "ok");
  assert.equal(open([fill(1)], two), "open-failed", "a file the header does not list");
  assert.equal(open([fill(1), fill(5)], one), "open-failed", "a blob with no file");
  assert.equal(open([fill(1), fill(6)], two), "open-failed", "another blob");
  assert.equal(open([], two), "open-failed");
  const swapped = new Writer().u32(2);
  for (const n of [5, 1]) {
    const f = file(n);
    swapped
      .b32(f.blob)
      .b32(f.fileKey)
      .u64(f.size)
      .var(platform.utf8Encode("t"))
      .var(platform.utf8Encode("f"));
  }
  assert.equal(
    open([fill(1), fill(5)], swapped.var(platform.utf8Encode("{}")).bytes()),
    "open-failed",
    "the order",
  );
});

test("every way a message fails to open is open-failed", () => {
  const signed = sealMessage(platform, epochKey, base, empty);
  const m = decodeMessage(signed);
  assert.ok(m.ok);
  const { header: h, ciphertext } = m.value;
  const flip = (b: Bytes, at: number) => Uint8Array.from(b, (x, i) => (i === at ? x ^ 1 : x));
  const attempts: [string, Parameters<typeof openMessage>][] = [
    ["another epoch key", [platform, fill(8), m.value]],
    ["a ciphertext changed", [platform, epochKey, { header: h, ciphertext: flip(ciphertext, 0) }]],
    [
      "a tag changed",
      [platform, epochKey, { header: h, ciphertext: flip(ciphertext, ciphertext.length - 1) }],
    ],
    ["a ciphertext cut", [platform, epochKey, { header: h, ciphertext: ciphertext.slice(0, 5) }]],
    ["a counter changed", [platform, epochKey, { header: { ...h, counter: 2 }, ciphertext }]],
    [
      "a time changed (the header is the AAD)",
      [platform, epochKey, { header: { ...h, time: h.time + 1 }, ciphertext }],
    ],
    [
      "a run changed (the run is in the key)",
      [platform, epochKey, { header: { ...h, run: fill(44, 16) }, ciphertext }],
    ],
    ["a sender changed", [platform, epochKey, { header: { ...h, sender: fill(45) }, ciphertext }]],
    ["an epoch changed", [platform, epochKey, { header: { ...h, epoch: fill(46) }, ciphertext }]],
    ["a name changed", [platform, epochKey, { header: { ...h, name: fill(47, 16) }, ciphertext }]],
    ["a body that is not a body", [platform, epochKey, crafted(h, Uint8Array.of(1, 2, 3))]],
    [
      "a body with bytes left over",
      [platform, epochKey, crafted(h, Uint8Array.from([...encodeBody(platform, empty), 0]))],
    ],
    [
      "a content that is not UTF-8",
      [platform, epochKey, crafted(h, new Writer().u32(0).var(Uint8Array.of(0xff)).bytes())],
    ],
  ];
  assert.equal(err(openMessage(platform, epochKey, m.value)), "ok");
  for (const [name, args] of attempts)
    assert.deepEqual(openMessage(...args), { ok: false, error: "open-failed" }, name);
});

test("never allowed 5: two runs of a sender seal one counter under two keys [model]", () => {
  const a = sealMessage(platform, epochKey, base, empty);
  const b = sealMessage(platform, epochKey, { ...base, run: fill(40, 16) }, empty);
  const ct = (s: Bytes) => (decodeMessage(s) as { value: { ciphertext: Bytes } }).value.ciphertext;
  assert.notDeepEqual(ct(a), ct(b));
  const c = sealMessage(platform, epochKey, { ...base, counter: 2 }, empty);
  assert.notDeepEqual(ct(a), ct(c));
});

test("the cut name and the not-read name come from their own labels, the prompt's sender and its name", () => {
  const prompt = { device: fill(3), name: fill(9, 16) };
  const cut = cutName(platform, prompt);
  const unread = unreadName(platform, prompt);
  assert.equal(cut.length, 16);
  const by = (label: "cut-name" | "unread-name") =>
    platform
      .sha256(new Writer().label(label).b32(prompt.device).b16(prompt.name).bytes())
      .slice(0, 16);
  assert.deepEqual(cut, by("cut-name"));
  assert.deepEqual(unread, by("unread-name"));
  assert.notDeepEqual(cut, unread);
  assert.deepEqual(cutName(platform, prompt), cut, "a bot that says it twice says it once");
  assert.notDeepEqual(cutName(platform, { ...prompt, name: fill(10, 16) }), cut);
  assert.notDeepEqual(cutName(platform, { ...prompt, device: fill(4) }), cut);
});

test("R1-5: a counter past 100,000 is not sealed", () => {
  assert.doesNotThrow(() => sealMessage(platform, epochKey, { ...base, counter: 100_000 }, empty));
  assert.throws(
    () => sealMessage(platform, epochKey, { ...base, counter: 100_001 }, empty),
    RangeError,
  );
  assert.throws(() => sealMessage(platform, epochKey, { ...base, counter: 2 ** 32 }, empty));
});

test("R1-6: an epoch key of the wrong length fails to open, and nothing throws", () => {
  const m = decodeMessage(sealMessage(platform, epochKey, base, empty));
  assert.ok(m.ok);
  for (const bad of [fill(7, 31), fill(7, 33), new Uint8Array(0)])
    assert.deepEqual(openMessage(platform, bad, m.value), { ok: false, error: "open-failed" });
});

test("the id of a message is the hash of its signed bytes, which hold no signature", () => {
  const signed = sealMessage(platform, epochKey, base, empty);
  assert.deepEqual(signedId(platform, signed), platform.sha256(signed));
  const other = sealMessage(platform, epochKey, { ...base, counter: 2 }, empty);
  assert.notDeepEqual(signedId(platform, other), signedId(platform, signed));
});

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "vectors", "message.json"), "utf8"),
);

test("every case of message.json has a name of its own, since a failure is reported by name", () => {
  const names = vectors.cases.map((c: { name: string }) => c.name);
  assert.equal(new Set(names).size, names.length);
});

test("every case of message.json passes", () => {
  assert.deepEqual(runVectors(platform, vectors), []);
  assert.ok(vectors.cases.length >= 12);
});

test("a message case with a wrong output, a wrong id or a wrong key is reported by name", () => {
  const flip = (hex: string) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
  const sealed = vectors.cases.find((c: { op: string }) => c.op === "message");
  const changed = [
    { ...sealed, output: flip(sealed.output) },
    { ...sealed, id: flip(sealed.id) },
    { ...sealed, k: flip(sealed.k) },
  ];
  assert.deepEqual(
    runVectors(platform, { ...vectors, cases: changed }),
    changed.map((c) => c.name),
  );
});
