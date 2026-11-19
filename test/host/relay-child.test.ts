/**
 * The child `pardner relay init|serve` runs: a stub entry the test writes stands for the relay's
 * (a spawned real relay cannot take an injected exclusion, and the real `tmutil` costs about 11 s
 * on the Mac mini). The stub records its arguments and then acts by the `STUB_MODE` variable.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { runRelayChild } from "../../src/host/relay-child.ts";

const STUB = `
import { appendFileSync, writeFileSync } from "node:fs";
const dir = process.env.STUB_DIR;
writeFileSync(dir + "/args.json", JSON.stringify(process.argv.slice(2)));
const mode = process.env.STUB_MODE;
if (mode === "exit3") process.exit(3);
if (mode === "hangup") process.kill(process.pid, "SIGHUP");
process.on("SIGINT", () => appendFileSync(dir + "/seen", "SIGINT\\n"));
process.on("SIGTERM", () => process.exit(7));
writeFileSync(dir + "/ready", "");
setInterval(() => {}, 1000);
`;

function scratch(t: { after(fn: () => void): void }, mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "pardner-relay-child-"));
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "main.mjs");
  writeFileSync(entry, STUB);
  process.env.STUB_DIR = dir;
  process.env.STUB_MODE = mode;
  t.after(() => {
    delete process.env.STUB_DIR;
    delete process.env.STUB_MODE;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, program: { node: process.execPath, entry } };
}

const waitFor = async (path: string) => {
  for (let tries = 0; tries < 200 && !existsSync(path); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(existsSync(path), `${path} never appeared`);
};

test("the child gets the arguments and its exit code is returned", async (t) => {
  const { dir, program } = scratch(t, "exit3");
  assert.equal(
    await runRelayChild(program, ["serve", "--dir", "/d", "--listen", "h:1"], () => {}),
    3,
  );
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "args.json"), "utf8")), [
    "serve",
    "--dir",
    "/d",
    "--listen",
    "h:1",
  ]);
});

test("a child ended by a signal gives 128 plus its number, never 0", async (t) => {
  const { program } = scratch(t, "hangup");
  assert.equal(await runRelayChild(program, ["init"], () => {}), 128 + 1);
});

test("SIGINT is ignored by the parent and SIGTERM is forwarded", async (t) => {
  const { dir, program } = scratch(t, "wait");
  const had = {
    SIGINT: new Set(process.listeners("SIGINT")),
    SIGTERM: new Set(process.listeners("SIGTERM")),
  };
  const running = runRelayChild(program, ["init"], () => {});
  await waitFor(join(dir, "ready"));
  // The test runner holds a SIGINT listener of its own, so the parent's listeners are called
  // directly rather than by `process.emit`.
  const added = (name: "SIGINT" | "SIGTERM") =>
    process.listeners(name).filter((listener) => !had[name].has(listener));
  assert.equal(added("SIGINT").length, 1, "the parent takes SIGINT");
  assert.equal(added("SIGTERM").length, 1, "and SIGTERM");
  // Taking SIGINT must not forward it: the child, whose own SIGINT would be logged, never sees one.
  (added("SIGINT")[0] as () => void)();
  (added("SIGTERM")[0] as () => void)();
  assert.equal(await running, 7);
  assert.equal(existsSync(join(dir, "seen")), false);
  assert.equal(added("SIGINT").length + added("SIGTERM").length, 0, "the listeners are removed");
});

test("a terminal's SIGINT, sent to the whole group, reaches the child once and the parent returns its code", {
  timeout: 15_000,
}, async (t) => {
  const { dir, program } = scratch(t, "wait");
  // The stub stops on its first SIGINT, as the relay does; a second one, forwarded, would be
  // logged as a second line before it exits.
  writeFileSync(
    program.entry,
    `${STUB.replace('process.on("SIGINT", () => appendFileSync(dir + "/seen", "SIGINT\\n"));', 'process.on("SIGINT", () => { appendFileSync(dir + "/seen", "SIGINT\\n"); setTimeout(() => process.exit(0), 200); });')}`,
  );
  const parent = join(dir, "parent.mjs");
  const module = pathToFileURL(
    join(import.meta.dirname, "..", "..", "src", "host", "relay-child.ts"),
  );
  writeFileSync(
    parent,
    `import { runRelayChild } from ${JSON.stringify(module.href)};\n` +
      `process.exitCode = await runRelayChild(${JSON.stringify(program)}, ["serve"], () => {});\n`,
  );
  // A group of its own, as a terminal's foreground job has: the signal goes to `-pid`.
  const job = spawn(process.execPath, [parent], { detached: true, stdio: "ignore" });
  const exited = new Promise<number | null>((resolve) => job.on("exit", (code) => resolve(code)));
  let ended = false;
  void exited.then(() => {
    ended = true;
  });
  // A child that never stops (one not in the group, say) must not outlive the test.
  t.after(() => {
    if (!ended) process.kill(-(job.pid as number), "SIGKILL");
  });
  await waitFor(join(dir, "ready"));
  process.kill(-(job.pid as number), "SIGINT");
  assert.equal(await exited, 0, "the child's code, not the parent's death by SIGINT");
  assert.equal(readFileSync(join(dir, "seen"), "utf8"), "SIGINT\n", "one SIGINT, not two");
});

test("an entry that cannot start is told on stderr and gives 1", async () => {
  const told: string[] = [];
  const code = await runRelayChild(
    { node: "/nonexistent/node", entry: "/x/main.js" },
    ["init"],
    (text) => told.push(text),
  );
  assert.equal(code, 1);
  assert.match(told.join(""), /the relay could not be started/);
});
