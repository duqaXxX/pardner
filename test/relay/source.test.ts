import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { blank } from "../support/source-scan.ts";

const RELAY = join(import.meta.dirname, "..", "..", "src", "relay");

/** Whether a string or an identifier of `source` holds the product's name, old or new. */
export function naming(source: string): boolean {
  return /allaboard|pardner/i.test(blank(source, { keepText: true }));
}

test("the scan finds a name in a string or an identifier and skips a comment", () => {
  assert.equal(naming('const m = "Pardner";'), true);
  assert.equal(naming("const allaboardKey = 1;"), true);
  assert.equal(naming("// allaboard in a comment"), false);
});

test("the relay's sources hold no product name", () => {
  const files = readdirSync(RELAY).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0);
  const named = files.filter((name) => naming(readFileSync(join(RELAY, name), "utf8")));
  assert.deepEqual(named, []);
  assert.equal(files.filter((name) => /allaboard|pardner/i.test(name)).length, 0);
});
