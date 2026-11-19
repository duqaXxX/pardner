/**
 * A bot's profile (bot-profile design 3.1 and 3.3; security design 5.13; package design 6.8): the
 * vectors of profile.json, written apart from the package by a generator of their own, on Node.
 * The joined script and JavaScriptCore run the same file (joined.test.ts, jsc.test.ts).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import { runVectors } from "../../src/protocol/vectors.ts";

test("the vectors of profile.json pass, and a changed expectation is named", () => {
  const file = JSON.parse(
    readFileSync(join(import.meta.dirname, "vectors", "profile.json"), "utf8"),
  );
  const platform = createNodePlatform();
  assert.deepEqual(runVectors(platform, file), []);
  assert.ok(file.cases.length >= 120);
  for (const op of ["profile-read", "profile-encode", "profile-shown"])
    assert.ok(
      file.cases.some((c: { op: string }) => c.op === op),
      `a case of ${op}`,
    );
  const changed = structuredClone(file);
  const shown = changed.cases.findIndex((c: { op: string }) => c.op === "profile-shown");
  changed.cases[0].output = "{}";
  changed.cases[shown].output = "someone else";
  assert.deepEqual(runVectors(platform, changed), [
    changed.cases[0].name,
    changed.cases[shown].name,
  ]);
});
