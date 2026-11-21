/**
 * Two of the app's devices against a real relay (device pairing design 3.4, 3.6, 3.7, 3.9, 3.10): a relay on a fresh `init` directory
 * gives its port, key and enrolment secret to the Swift `DevicesRelayTests`, where the first device enrols, a second joins and is added,
 * and the first removes it. Only a Mac with Xcode can run it.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { encodePairingString } from "../../src/protocol/pairing-string.ts";
import { RelayProcess } from "../support/scripted-device/relay-process.ts";
import { tempDirSync } from "../support/temp.ts";
import { makeProof } from "./proof.ts";
import { Party, SIGN } from "./sequence.ts";

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
    const child = spawn(
      "swift",
      ["test", "--filter", "DevicesRelayTests", "--scratch-path", join(folder, "build")],
      {
        cwd: APP,
        env: {
          ...process.env,
          PARDNER_APP_SCRIPT: script,
          PARDNER_RELAY_PORT: String(target.port),
          PARDNER_RELAY_PIN: hex(target.relay),
          PARDNER_ENROL_SECRET: hex(target.secret),
          PARDNER_SYNC_DIR: folder,
        },
      },
    );
    const swift = { status: null as number | null, stdout: "", stderr: "" };
    child.stdout.on("data", (d) => {
      swift.stdout += d;
    });
    child.stderr.on("data", (d) => {
      swift.stderr += d;
    });
    const exited = new Promise<void>((resolve) =>
      child.on("close", (code) => {
        swift.status = code;
        resolve();
      }),
    );
    // The Swift side gives the person id once its first device is paired and waits for a bot's pairing string for that person:
    // a proof is made for one person, which only the first device's setup decides.
    const bot = new Party();
    const personFile = join(folder, "person.txt");
    let told = false;
    for (const deadline = Date.now() + 780_000; swift.status === null; await delay(200)) {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error("the swift run did not end in time");
      }
      if (told || !existsSync(personFile)) continue;
      const person = new Uint8Array(Buffer.from(readFileSync(personFile, "utf8").trim(), "hex"));
      const device = { kind: "bot" as const, ...bot.keys };
      const text = encodePairingString(
        bot.platform,
        device,
        makeProof(bot.platform, SIGN, person, device),
        "Test bot",
      );
      writeFileSync(join(folder, "bot.tmp"), text);
      renameSync(join(folder, "bot.tmp"), join(folder, "bot.txt"));
      told = true;
    }
    await exited;
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
