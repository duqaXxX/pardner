/**
 * Case (b) can fail for a recipient (crash images design 3.4, 5.3): a relay start that keeps a seal whose
 * recipient no log names is reported on every image of the case's window. The mutant is a copy of `src` whose
 * seals keep callback checks the maker and the epoch only, as before the recipient was bounded. It is slow, so it
 * runs with PARDNER_CRASH_FULL=1; the relay as built passes case (b) in crash-images.test.ts.
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { CASES } from "../support/crash/cases.ts";
import { checkRecording, isDefect, kept } from "../support/crash/check.ts";
import type { Image } from "../support/crash/images.ts";
import { CONFIGS } from "../support/crash/replay.ts";
import { recorded } from "../support/crash/workload.ts";
import { DARWIN } from "./process-support.ts";

const KEPT = "!seal.ok || !bounded(seq, seal.value)";
const MUTANT =
  "!seal.ok || !(seq.namesDevice(seal.value.maker) && seq.placed(seal.value.channel, seal.value.epoch))";

after(() => {
  for (const dir of kept) rmSync(dir, { recursive: true, force: true });
});

test("(b) is reported against a start that keeps a seal whose recipient no log names", {
  ...DARWIN,
  skip: !process.env.PARDNER_CRASH_FULL,
  timeout: 900_000,
}, async () => {
  const copy = mkdtempSync(join(tmpdir(), "pardner-seal-mutant-"));
  try {
    cpSync(new URL("../../src", import.meta.url), join(copy, "src"), { recursive: true });
    const file = join(copy, "src/relay/seals.ts");
    const source = readFileSync(file, "utf8");
    assert.equal(source.split(KEPT).length, 2, "the keep callback is the one the mutant patches");
    writeFileSync(file, source.replace(KEPT, MUTANT));
    const c = CASES.find((x) => x.name.startsWith("(b)"));
    assert.ok(c);
    const { platform, rec } = await recorded(c.script);
    const window = c.check(rec);
    assert.ok(typeof window !== "string", `workload failure: ${window}`);
    const main = pathToFileURL(join(copy, "src/relay/main.ts")).href;
    const only = (i: Image) => i.config === "M" && window.state(i);
    const run = await checkRecording(rec, platform, 2, only, () => {}, CONFIGS, main);
    const seals = run.findings.filter((f) => isDefect(f) && f.check.includes("recipient"));
    assert.ok(run.images > 0);
    assert.equal(seals.length, run.images, "every window image is reported");
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
