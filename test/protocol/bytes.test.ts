/** The byte writer and reader of the protocol package, and its vector files on the sources. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import { decode, type Reader, Writer } from "../../src/protocol/bytes.ts";
import { deviceId, recoveryKeyId, relayKeyId, signedId } from "../../src/protocol/ids.ts";
import { EXPORTER_LABEL, labelBytes } from "../../src/protocol/labels.ts";
import { runVectors } from "../../src/protocol/vectors.ts";

const platform = createNodePlatform();

for (const name of ["encoding", "labels", "ids", "device-entry"]) {
  test(`every case of ${name}.json passes on the sources`, () => {
    const file = JSON.parse(
      readFileSync(join(import.meta.dirname, "vectors", `${name}.json`), "utf8"),
    );
    assert.ok(file.cases.length > 0);
    assert.deepEqual(runVectors(platform, file), []);
  });
}

test("a refusal case whose schema names an unknown type fails, not passes", () => {
  const file = JSON.parse(
    readFileSync(join(import.meta.dirname, "vectors", "encoding.json"), "utf8"),
  );
  const refusal = file.cases.find(
    (c: { name: string }) => c.name === "u64 at 2^53 does not encode",
  );
  assert.ok(refusal);
  const typo = { ...file, cases: [{ ...refusal, schema: ["u46"], values: [1] }] };
  assert.deepEqual(runVectors(platform, typo), [refusal.name]);
});

test("the writer refuses a value outside its field", () => {
  assert.throws(() => new Writer().u8(256));
  assert.throws(() => new Writer().u16(-1));
  assert.throws(() => new Writer().u32(1.5));
  assert.throws(() => new Writer().u64(2 ** 53));
  assert.throws(() => new Writer().b16(new Uint8Array(15)));
  assert.throws(() => new Writer().pk(new Uint8Array(65)));
  assert.throws(() => new Writer().raw([1, 2] as unknown as Uint8Array));
  assert.throws(() => new Writer().label("é" as never));
  assert.throws(() => new Writer().label("blind-relay/1 message" as never));
  assert.throws(() => new Writer().raw(new DataView(new ArrayBuffer(4)) as never));
});

test("a set is written sorted by its ids, and an id twice is refused", () => {
  const a = new Uint8Array(16).fill(1);
  const b = new Uint8Array(16).fill(2);
  const id = (x: Uint8Array) => x;
  const write = new Writer().set([b, a], id, (w, x) => w.b16(x)).bytes();
  assert.equal(write[4], 1);
  assert.throws(() => new Writer().set([a, a], id, (w, x) => w.b16(x)));
});

test("a decoder returns a failure for every input of another party and never throws", () => {
  const read = (r: Reader) => r.list((x) => x.u16());
  for (const hex of ["", "00", "00000002000100", "ffffffff", "0000000100010000"]) {
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    assert.deepEqual(decode(bytes, read).ok, false, hex);
  }
  assert.deepEqual(decode(Uint8Array.from([0, 0, 0, 1, 0, 9]), read), { ok: true, value: [9] });
  assert.deepEqual(decode("x" as unknown as Uint8Array, read).ok, false);
});

test("a fault inside a read callback is not turned into a failure", () => {
  assert.throws(
    () =>
      decode(new Uint8Array(1), () => {
        throw new TypeError("bug");
      }),
    TypeError,
  );
});

test("the labels come from one table, and a caller gets a copy", () => {
  assert.equal(labelBytes("device-entry")[0], "blind-relay/1 device-entry".length);
  labelBytes("message")[1] = 0;
  assert.equal(labelBytes("message")[1], "blind-relay/1 message".charCodeAt(0));
  assert.throws(() => labelBytes("nothing" as never));
  assert.equal(EXPORTER_LABEL, "EXPORTER-blind-relay/1 binding");
});

test("ids are hashes of their label and the keys", () => {
  const pk = Uint8Array.from([4, ...new Array<number>(64).fill(7)]);
  const label = (name: "device-id" | "recovery-id" | "relay-id") => labelBytes(name);
  const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
  assert.deepEqual(deviceId(platform, pk, pk), platform.sha256(join(label("device-id"), pk, pk)));
  assert.deepEqual(
    recoveryKeyId(platform, pk, pk),
    platform.sha256(join(label("recovery-id"), pk, pk)),
  );
  assert.deepEqual(relayKeyId(platform, pk), platform.sha256(join(label("relay-id"), pk)));
  assert.notDeepEqual(deviceId(platform, pk, pk), recoveryKeyId(platform, pk, pk));
  assert.deepEqual(signedId(platform, pk), platform.sha256(pk));
  assert.throws(() => deviceId(platform, pk.slice(1), pk));
});

test("what a decoder returns does not alias its input (a Node Buffer is a view)", () => {
  const frame = Buffer.from("01".repeat(16), "hex");
  const got = decode(frame, (r) => r.b16());
  assert.ok(got.ok);
  frame.fill(0xff);
  assert.equal(got.ok && got.value[0], 1);
});

test("a view that is not a Uint8Array is a failure for decode, never a throw", () => {
  const fake = new DataView(new ArrayBuffer(4));
  Object.defineProperty(fake, Symbol.toStringTag, { value: "Uint8Array" });
  assert.equal(decode(fake as never, (r) => r.u8()).ok, false);
  assert.equal(decode(new Int8Array(1) as never, (r) => r.u8()).ok, false);
});
