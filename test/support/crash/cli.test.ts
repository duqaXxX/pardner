/** The hand run's argument handling and script search (crash images design 7.2); the run itself is behind PARDNER_CRASH_FULL. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Finding, isDefect } from "./check.ts";
import { main, scriptsUnder } from "./cli.ts";
import { CONFIGS } from "./replay.ts";

test("a folder gives its scripts, searched down and sorted, and a file gives itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "pardner-cli-"));
  try {
    mkdirSync(join(dir, "relay"));
    for (const f of ["b.jsonl", "a.jsonl", "notes.txt", "relay/c.jsonl"])
      writeFileSync(join(dir, f), "");
    assert.deepEqual(
      scriptsUnder(dir).map((p) => p.slice(dir.length + 1)),
      ["a.jsonl", "b.jsonl", "relay/c.jsonl"],
    );
    assert.deepEqual(scriptsUnder(join(dir, "a.jsonl")), [join(dir, "a.jsonl")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown configuration, an unknown option and a missing target are refused with the usage", async () => {
  for (const argv of [["init", "--config", "Z"], ["init", "--level", "2"], []])
    await assert.rejects(main(argv), /usage/);
});

test("a folder with no script is an error, not a clean run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pardner-cli-"));
  try {
    writeFileSync(join(dir, "notes.txt"), "");
    await assert.rejects(main([dir]), /no \.jsonl script/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a finding fails the run under M and M with A3, never under M without A2 or the split rename", () => {
  const at = (...configs: string[]) => ({ configs }) as Finding;
  assert.equal(
    CONFIGS.some((c) => c.name === "M with A3"),
    true,
  );
  assert.deepEqual(
    [["M"], ["M with A3"], ["M without A2", "M with A3"], ["M without A2"], ["M split rename"]].map(
      (c) => isDefect(at(...c)),
    ),
    [true, true, true, false, false],
  );
});

test("a recorded enrolment is judged under every configuration and found clean (PARDNER_CRASH_FULL=1)", {
  skip: !process.env.PARDNER_CRASH_FULL && "set PARDNER_CRASH_FULL=1 to run every image",
  timeout: 300_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pardner-cli-"));
  try {
    const file = join(dir, "enrol.jsonl");
    writeFileSync(file, '{"op":"prove","device":"app1","enrol":"s1","expect":"served"}\n');
    assert.equal(await main([file, "--parallel", "2"]), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Ctrl-C ends the run with 130 and leaves no folder of it and no relay (PARDNER_CRASH_FULL=1)", {
  skip: !process.env.PARDNER_CRASH_FULL && "set PARDNER_CRASH_FULL=1 to run every image",
  timeout: 120_000,
}, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pardner-cli-tmp-"));
  const cli = new URL("./cli.ts", import.meta.url).pathname;
  const child = spawn(process.execPath, [cli, "init", "--parallel", "2"], {
    env: { ...process.env, TMPDIR: tmp },
    stdio: "ignore",
  });
  const code = new Promise((resolve) => child.once("exit", (c) => resolve(c)));
  try {
    // The images' folder exists once the workload is recorded and the checks begin.
    for (
      let t = 0;
      t < 60_000 && !readdirSync(tmp).some((n) => n.startsWith("pardner-crash-images-"));
      t += 50
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    child.kill("SIGINT");
    assert.equal(await code, 130);
    assert.deepEqual(readdirSync(tmp), []);
    // A relay of the run names its folder under `tmp` on its command line.
    assert.equal(spawnSync("pgrep", ["-f", tmp]).status, 1, "a relay of the run is left");
  } finally {
    child.kill("SIGKILL");
    rmSync(tmp, { recursive: true, force: true });
  }
});
