import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ExclusionFailed,
  type Exec,
  excludeFromBackup,
  execWithTimeout,
} from "../../src/relay/exclusion.ts";

test("on macOS the sticky exclusion is asked of tmutil, by its path, for the folder given", async () => {
  const calls: [string, string[]][] = [];
  const exec: Exec = (file, args) => void calls.push([file, args]);
  await excludeFromBackup("/some/dir", exec, "darwin");
  assert.deepEqual(calls, [["/usr/bin/tmutil", ["addexclusion", "/some/dir"]]]);
});

test("elsewhere nothing is run", async () => {
  const calls: unknown[] = [];
  await excludeFromBackup("/some/dir", () => void calls.push(1), "linux");
  assert.deepEqual(calls, []);
});

test("a failure of tmutil is the caller's to handle", async () => {
  const exec: Exec = () => {
    throw new Error("tmutil failed");
  };
  await assert.rejects(excludeFromBackup("/some/dir", exec, "darwin"), ExclusionFailed);
});

test("a failure names tmutil's exit status or a timeout, and nothing of a path (2-CR9)", async () => {
  const fail = (over: object) => async () => {
    throw Object.assign(
      new Error("Command failed: /usr/bin/tmutil addexclusion /secret/path"),
      over,
    );
  };
  await assert.rejects(
    excludeFromBackup("/secret/path", fail({ code: 3 }), "darwin"),
    (e) =>
      e instanceof ExclusionFailed && /exit status 3/.test(e.message) && !/secret/.test(e.message),
  );
  await assert.rejects(
    excludeFromBackup("/secret/path", fail({ killed: true, signal: "SIGTERM" }), "darwin"),
    (e) => e instanceof ExclusionFailed && /timed out/.test(e.message),
  );
});

test("the real runner is asynchronous and bounded by a timeout (2-CR7)", async () => {
  const { nodeExec } = await import("../../src/relay/exclusion.ts");
  const started = Date.now();
  const pending = nodeExec(process.execPath, ["-e", "setTimeout(() => {}, 300)"]);
  assert.ok(pending instanceof Promise, "it returns a promise, so the loop is free meanwhile");
  assert.ok(Date.now() - started < 200, "it did not wait for the child");
  await pending;
});

test("the runner kills a program that outlives its timeout (2-R2-2)", {
  skip: process.platform === "win32" ? "no /bin/sleep" : false,
}, async () => {
  const started = Date.now();
  await assert.rejects(
    Promise.resolve(execWithTimeout(200)("/bin/sleep", ["30"])),
    (error: { killed?: boolean }) => error.killed === true,
  );
  assert.ok(Date.now() - started < 5000, "it did not wait for the program");
});

test("the real runner is built with its timeout (2-R2-2)", async () => {
  const { EXEC_TIMEOUT_MS, nodeExec } = await import("../../src/relay/exclusion.ts");
  assert.equal(EXEC_TIMEOUT_MS, 10_000);
  assert.equal(nodeExec.timeout, EXEC_TIMEOUT_MS);
  assert.equal(execWithTimeout(200).timeout, 200);
});
