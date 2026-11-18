/**
 * The relay on the crash images of the six cases and of `init` (crash images design 4, 5, 7.2): each case's
 * script is recorded once, its record check must be met (a case that did not reach its state is a failure of the
 * workload, never a pass), and the images at the state the check names are started and judged. `npm test` judges a
 * few of them per case; PARDNER_CRASH_FULL=1 judges every image of every case under every configuration.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import { CASES } from "../support/crash/cases.ts";
import { checkRecording, isDefect, kept } from "../support/crash/check.ts";
import type { Image } from "../support/crash/images.ts";
import { recorded } from "../support/crash/workload.ts";
import { DARWIN } from "./process-support.ts";

after(() => {
  for (const dir of kept) rmSync(dir, { recursive: true, force: true });
});
/** Images judged per case in `npm test`: of those in the state the record check names. */
const PER_CASE = 6;
const FULL = process.env.PARDNER_CRASH_FULL;

for (const c of CASES) {
  test(`${c.name}: the state is reached, and the images there are served as answered`, {
    ...DARWIN,
    timeout: 900_000,
  }, async (t) => {
    const { platform, rec } = await recorded(c.script);
    const window = c.check(rec);
    assert.ok(typeof window !== "string", `workload failure: ${window}`);
    // The first PER_CASE images in the state the check names: each case says what that state is.
    let count = 0;
    const few = (i: Image) => i.config === "M" && window.state(i) && count++ < PER_CASE;
    const start = Date.now();
    const run = await checkRecording(rec, platform, 2, FULL ? undefined : few);
    const defects = run.findings.filter(isDefect);
    const lines = run.findings.map(
      (f) =>
        `${isDefect(f) ? "DEFECT" : "dependency"} ${f.configs.join(", ")}: ${f.how}@${f.cut} ${f.check} (${f.folder})`,
    );
    t.diagnostic(
      `${run.images} images, window ${run.window}, ${(Date.now() - start) / 1000} s, ${run.findings.length} findings, ${run.unprobed} unprobed\n${lines.join("\n")}`,
    );
    assert.deepEqual(
      [run.failures, defects.map((f) => `${f.how}@${f.cut} ${f.check}`), run.unprobed],
      [[], [], 0],
    );
    assert.ok(run.images > 0);
  });
}
