/**
 * The names of channels, persons and devices (names design 2.1 and 3; security design 5.15): the
 * vectors of name.json, written apart from the package by a generator of their own, on Node. The
 * joined script and JavaScriptCore run the same file (joined.test.ts, jsc.test.ts).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import { Names } from "../../src/protocol/profile.ts";
import { runVectors } from "../../src/protocol/vectors.ts";

test("the vectors of name.json pass, and a changed expectation is named", () => {
  const file = JSON.parse(readFileSync(join(import.meta.dirname, "vectors", "name.json"), "utf8"));
  const platform = createNodePlatform();
  assert.deepEqual(runVectors(platform, file), []);
  for (const op of ["name-read", "name-encode", "name-shown"])
    assert.ok(
      file.cases.some((c: { op: string }) => c.op === op),
      `a case of ${op}`,
    );
  const changed = structuredClone(file);
  const shown = changed.cases.findIndex((c: { op: string }) => c.op === "name-shown");
  changed.cases[0].output = "other";
  changed.cases[shown].output = "someone else";
  assert.deepEqual(runVectors(platform, changed), [
    changed.cases[0].name,
    changed.cases[shown].name,
  ]);
});

const bytes = (n: number, len = 32) => new Uint8Array(len).fill(n);
const header = (kind: number, channel: Uint8Array) => ({
  kind,
  channel,
  sender: bytes(1),
  name: bytes(9, 16),
  blobs: [] as Uint8Array[],
});
const content = (name: string) => JSON.stringify({ name });

test("review L7: first copies are kept by kind, channel, sender and name", () => {
  const [c1, c2, space] = [bytes(11), bytes(12), bytes(13)];
  const names = new Names();
  names.take(10, header(14, c1), content("alpha"));
  names.take(20, header(14, c2), content("beta"));
  assert.equal(names.channel(c1), "alpha", "one name sent into two channels is two messages");
  assert.equal(names.channel(c2), "beta");
  const other = new Names();
  other.see(10, header(14, c1)); // the device lacks the key of this channel
  other.take(20, header(16, space), content("Not A Channel Name"));
  assert.equal(other.channel(c1), undefined, "a kind 16 never places a kind 14");
  assert.equal(other.device(space, bytes(1)), "Not A Channel Name");
});
