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

// Names, review V2: the person's name is checked as kind 15 is read, in characters, not as a pairing string's bytes.
test("checkPersonName: 64 code points, whatever their bytes; no @, no hidden character, no space at either end", async () => {
  const { checkPersonName } = await import("../../src/protocol/profile.ts");
  const platform = createNodePlatform();
  assert.ok(
    checkPersonName(platform, "中".repeat(30)),
    "30 CJK characters are 90 bytes and one name",
  );
  assert.ok(checkPersonName(platform, "a".repeat(64)));
  assert.ok(!checkPersonName(platform, "a".repeat(65)));
  for (const bad of ["", " Ada", "Ada ", "Ada@home", "Ada​", "\ud800"])
    assert.ok(!checkPersonName(platform, bad), JSON.stringify(bad));
});
