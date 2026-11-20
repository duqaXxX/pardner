/**
 * Two of the app's devices against a real relay (device pairing design 3.4, 3.6, 3.7, 3.9, 3.10): a relay on a fresh `init` directory
 * gives its port, key and enrolment secret to the Swift `DevicesRelayTests`, where the first device enrols, a second joins and is added,
 * and the first removes it. Only a Mac with Xcode can run it.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RelayProcess } from "../support/scripted-device/relay-process.ts";
import { tempDirSync } from "../support/temp.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const APP = join(ROOT, "app");

function skipReason(): string | false {
  if (process.platform !== "darwin")
    return "Network.framework and JavaScriptCore run on macOS only";
  const developer = spawnSync("xcode-select", ["-p"], { encoding: "utf8" });
  return /\.app\/Contents\/Developer/.test(developer.stdout) ? false : "no Xcode is selected";
}

test("a second device joins, the first adds it and removes it, and the second ends removed", {
  skip: skipReason(),
  timeout: 900_000, // the build of the package from nothing, and the run
}, async () => {
  const folder = tempDirSync("pardner-app-devices-");
  const relay = new RelayProcess();
  try {
    const script = join(folder, "protocol-app.js");
    execFileSync(process.execPath, [join(ROOT, ".github/scripts/join-protocol.mjs"), script], {
      cwd: ROOT,
      timeout: 120_000,
    });
    const target = await relay.open();
    const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
    if (!target.secret) throw new Error("the fresh relay gave no enrolment secret");
    const swift = spawnSync(
      "swift",
      ["test", "--filter", "DevicesRelayTests", "--scratch-path", join(folder, "build")],
      {
        cwd: APP,
        encoding: "utf8",
        timeout: 800_000,
        env: {
          ...process.env,
          PARDNER_APP_SCRIPT: script,
          PARDNER_RELAY_PORT: String(target.port),
          PARDNER_RELAY_PIN: hex(target.relay),
          PARDNER_ENROL_SECRET: hex(target.secret),
        },
      },
    );
    if (swift.status !== 0)
      throw new Error(`swift test ended with ${swift.status}:\n${swift.stdout}\n${swift.stderr}`);
    // A run that executes nothing is no pass: the filter can match no test and still exit 0.
    const defined = (
      readFileSync(join(APP, "Tests", "VectorTests", "DevicesRelayTests.swift"), "utf8").match(
        /func test\w+\(/g,
      ) ?? []
    ).length;
    const executed = [
      ...(swift.stdout + swift.stderr).matchAll(
        /Test Suite '(?:All|Selected) tests' passed[^\n]*\n\s*Executed (\d+) tests?, with 0 failures/g,
      ),
    ].reduce((sum, m) => sum + Number(m[1]), 0);
    assert.ok(defined > 0 && executed >= defined, `executed ${executed} of ${defined} tests`);
  } finally {
    await relay.close();
  }
});
