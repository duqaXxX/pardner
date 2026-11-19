/**
 * The joined script (protocol-package design, 2.3) in a `vm` context with none of Node's globals,
 * which is how JavaScriptCore sees it, running the vectors against the platform on Node.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { runInNewContext } from "node:vm";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import { tempDirSync } from "../support/temp.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const folder = tempDirSync("pardner-joined-");
const script = join(folder, "protocol.js");
const platformVectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "vectors", "platform.json"), "utf8"),
);

type Runner = {
  runVectors(platform: unknown, file: unknown, importKey?: unknown, withSecret?: unknown): string[];
};
let runner: Runner;

/** A platform whose person types `secret`: the test-only way to give a recovery its secret. */
const secretPlatform = (secret: Uint8Array) =>
  createNodePlatform({ show: () => {}, enter: () => secret });

before(() => {
  execFileSync(
    process.execPath,
    [join(ROOT, ".github/scripts/join-protocol.mjs"), script, "vectors.js"],
    {
      cwd: ROOT,
      timeout: 120_000,
      stdio: "pipe",
    },
  );
  const context: { protocol?: Runner } = {};
  runInNewContext(readFileSync(script, "utf8"), context);
  runner = context.protocol as Runner;
});

after(() => rmSync(folder, { recursive: true, force: true }));

test("the bare context holds none of Node's globals", () => {
  assert.equal(
    runInNewContext("typeof process + typeof Buffer + typeof require"),
    "undefinedundefinedundefined",
  );
});

test("every case of platform.json passes on the joined script, platform on Node", () => {
  assert.deepEqual([...runner.runVectors(createNodePlatform(), platformVectors)], []);
});

for (const name of [
  "encoding",
  "labels",
  "ids",
  "device-entry",
  "member-entry",
  "epoch-entry",
  "history-seal",
  "recovery",
  "blob",
  "message",
  "proofs",
  "frames",
  "chain",
  "profile",
]) {
  test(`every case of ${name}.json passes on the joined script, platform on Node`, () => {
    const file = JSON.parse(
      readFileSync(join(import.meta.dirname, "vectors", `${name}.json`), "utf8"),
    );
    const platform = createNodePlatform();
    assert.deepEqual(
      [...runner.runVectors(platform, file, platform.importKey, secretPlatform)],
      [],
    );
  });
}

test("a case whose expected bytes are wrong is reported by name", () => {
  const changed = structuredClone(platformVectors);
  changed.cases[0].output = "00".repeat(32);
  changed.cases[7].valid = false;
  const failed = runner.runVectors(createNodePlatform(), changed);
  assert.deepEqual([...failed], [changed.cases[0].name, changed.cases[7].name]);
});

test("a file of an unknown structure fails whole", () => {
  const failed = runner.runVectors(createNodePlatform(), { structure: "nothing", cases: [] });
  assert.deepEqual([...failed], ["unknown structure nothing"]);
});

test("the join leaves out a module its entry does not reach", () => {
  const joined = readFileSync(script, "utf8");
  assert.match(joined, /"\.\/vectors\.js": function/);
  assert.doesNotMatch(joined, /"\.\/(platform)\.js": function/);
});
