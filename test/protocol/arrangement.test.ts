/**
 * The arrangement message (kind 17, sidebar sections design 2): the vectors of arrangement.json,
 * written apart from the package by a generator of their own, on Node, and the checks only Node
 * can make. The joined script and JavaScriptCore run the same file (joined.test.ts, jsc.test.ts).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import { encodeArrangement, Names, readArrangement } from "../../src/protocol/profile.ts";
import { runVectors } from "../../src/protocol/vectors.ts";

const file = JSON.parse(
  readFileSync(join(import.meta.dirname, "vectors", "arrangement.json"), "utf8"),
);
const empty = `{"base":null,"sections":[]}`;

test("the vectors of arrangement.json pass, and a changed expectation is named", () => {
  const platform = createNodePlatform();
  assert.deepEqual(runVectors(platform, file), []);
  for (const op of [
    "arrangement-read",
    "arrangement-encode",
    "arrangement-shown",
    "arrangement-act",
  ])
    assert.ok(
      file.cases.some((c: { op: string }) => c.op === op),
      `a case of ${op}`,
    );
  const changed = structuredClone(file);
  const encode = changed.cases.findIndex((c: { op: string }) => c.op === "arrangement-encode");
  changed.cases[0].output = "{}";
  changed.cases[encode].output = "other";
  assert.deepEqual(runVectors(platform, changed), [
    changed.cases[0].name,
    changed.cases[encode].name,
  ]);
});

test("the largest content within the limits is 97,484 bytes, under the cap of 131,072", () => {
  const largest = file.cases.find((c: { name: string }) =>
    c.name.startsWith("the largest content"),
  );
  assert.equal(Buffer.byteLength(largest.text), 97_484);
  assert.ok(readArrangement(largest.text).ok);
});

test("a carried field named __proto__ is an own field of a prototype-less object", () => {
  const r = readArrangement(`{"base":null,"sections":[],"__proto__":{"x":1}}`);
  assert.ok(r.ok);
  assert.equal(Object.getPrototypeOf(r.value.carried), null);
  assert.deepEqual(Object.keys(r.value.carried), ["__proto__"]);
  assert.equal(encodeArrangement(r.value), `{"base":null,"sections":[],"__proto__":{"x":1}}`);
});

test("a read that reaches a stack or other limit of the engine is a refusal, never a throw", () => {
  for (const depth of [33, 65_000, 100_000]) {
    const r = readArrangement(
      `{"base":null,"sections":[],"d":${"[".repeat(depth)}${"]".repeat(depth)}}`,
    );
    assert.deepEqual(r, { ok: false, error: "bad-input" }, `${depth} levels`);
  }
  assert.deepEqual(readArrangement(undefined as unknown as string), {
    ok: false,
    error: "bad-input",
  });
});

test("encodeArrangement gives the bytes readArrangement reads back", () => {
  const r = readArrangement(empty);
  assert.ok(r.ok);
  assert.equal(encodeArrangement(r.value), empty);
});

// The reading rule (design 3.2): which arrangement stands.
const fill = (n: number, len = 32) => new Uint8Array(len).fill(n);
const SPACE = fill(0x21);
const ADA = fill(0xa1);
const BO = fill(0xb1);
const msg = (n: number) => ({
  kind: 17,
  channel: SPACE,
  sender: ADA,
  name: fill(n, 16),
  blobs: [],
});
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const tree = (base: { sender: Uint8Array; name: Uint8Array } | null, label: string) =>
  `{"base":${base ? `{"sender":"${hex(base.sender)}","name":"${hex(base.name)}"}` : "null"},"sections":[{"id":"${"1".repeat(32)}","name":"${label}","channels":[]}]}`;
const stateOf = (names: Names) => {
  const w = names.arrangement(SPACE);
  return {
    steps: w.steps.map((s) => s.status),
    standing: w.standing?.arrangement.sections[0]?.name,
  };
};

test("the walk: the first in place stands, one built over a tree that no longer stands takes no part", () => {
  const names = new Names();
  names.take(1, msg(1), tree(null, "First"));
  names.take(2, { ...msg(2), sender: BO }, tree(null, "Second"));
  names.take(3, msg(3), tree({ sender: ADA, name: fill(1, 16) }, "Third"));
  assert.deepEqual(stateOf(names), { steps: ["stands", "none", "stands"], standing: "Third" });
});

test("the walk passes over a message not opened yet, and runs again when it opens", () => {
  const names = new Names();
  names.see(1, msg(1));
  names.take(2, msg(2), tree(null, "Second"));
  assert.deepEqual(stateOf(names), { steps: ["passed", "stands"], standing: "Second" });
  names.take(1, msg(1), tree(null, "First"));
  assert.deepEqual(stateOf(names), { steps: ["stands", "none"], standing: "First" });
});

test("a body with files, or one that does not read, takes no part; kind 17 elsewhere is not walked", () => {
  const names = new Names();
  names.take(1, { ...msg(1), blobs: [fill(1)] }, tree(null, "Files"));
  names.take(2, msg(2), "{");
  names.take(3, { ...msg(3), channel: fill(0x22) }, tree(null, "Spare"));
  assert.deepEqual(stateOf(names), { steps: ["none", "none"], standing: undefined });
});

test("only the first copy's body counts for kind 17, in any loading order", () => {
  const h = msg(1);
  const run = (...steps: Array<(n: Names) => void>) => {
    const names = new Names();
    for (const step of steps) step(names);
    return stateOf(names).standing;
  };
  const early = (n: Names) => n.take(1, h, tree(null, "Early"));
  const late = (n: Names) => n.take(5, h, tree(null, "Late"));
  assert.equal(run(early, late), "Early");
  assert.equal(run(late, early), "Early");
  assert.equal(
    run((n) => n.see(1, h), late),
    undefined,
    "first copy unopened",
  );
});

test("a kind 17 body that did not open under a held key takes no part, and a later copy does not stand in", () => {
  const names = new Names();
  names.take(1, msg(1), undefined);
  names.take(2, { ...msg(2), sender: BO }, tree(null, "Second"));
  names.take(3, msg(1), tree(null, "Late"));
  assert.deepEqual(stateOf(names), { steps: ["none", "stands"], standing: "Second" });
});

test("kinds 14, 15 and 16 keep the earliest opened copy rule", () => {
  for (const kind of [14, 15, 16]) {
    const names = new Names();
    const h = { ...msg(1), kind, channel: kind === 14 ? fill(0x11) : SPACE };
    names.see(1, h);
    names.take(5, h, '{"name":"docs"}');
    const shown =
      kind === 14
        ? names.channel(fill(0x11))
        : kind === 15
          ? names.person(SPACE)
          : names.device(SPACE, ADA);
    assert.equal(shown, "docs", `kind ${kind}`);
  }
});
