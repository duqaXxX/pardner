/** `loadBase` and `build` (design 3.1): a folder with modes survives the round trip. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDirSync } from "../temp.ts";
import { build, loadBase } from "./folder.ts";
import { digest } from "./replay.ts";

test("modes are read, hashed and written back, a read-only folder included", () => {
  const folder = tempDirSync("pardner-crash-");
  mkdirSync(join(folder, "d"));
  writeFileSync(join(folder, "d", "g"), "2");
  chmodSync(join(folder, "d"), 0o500);
  writeFileSync(join(folder, "f"), "1");
  chmodSync(join(folder, "f"), 0o600);
  const base = loadBase(folder);
  chmodSync(join(folder, "f"), 0o644);
  assert.notEqual(digest(base), digest(loadBase(folder)), "a mode changes the digest");
  const copy = join(tempDirSync("pardner-crash-"), "copy");
  build(base, copy);
  assert.equal(digest(loadBase(copy)), digest(base));
  chmodSync(join(copy, "d"), 0o700);
  chmodSync(join(folder, "d"), 0o700);
});
