/**
 * The vectors inside JavaScriptCore, with CryptoKit behind the platform interface: `swift test` in
 * `app/` runs the vector files and the checks only Swift can make, on the joined script this file
 * builds into a temporary folder. The checks that need both engines stay here: a seal CryptoKit
 * makes opens on Node. Only a Mac with Xcode can do it.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import {
  epochCommitment,
  epochSealInfo,
  type LoggedEpoch,
  openEpochSeal,
} from "../../src/protocol/epochs.ts";
import { tempDirSync } from "../support/temp.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const APP = join(ROOT, "app");

function skipReason(): string | false {
  if (process.platform !== "darwin") return "JavaScriptCore with CryptoKit runs on macOS only";
  // The Command Line Tools alone have `swiftc` and not what `swift test` needs.
  const developer = spawnSync("xcode-select", ["-p"], { encoding: "utf8" });
  return /\.app\/Contents\/Developer/.test(developer.stdout) ? false : "no Xcode is selected";
}

test("every vector file passes in JavaScriptCore on CryptoKit", {
  skip: skipReason(),
  timeout: 1_260_000, // the sum of the steps below: 120 + 750 + 240 + 60 + 30 s, and the Node checks,
}, () => {
  const folder = tempDirSync("pardner-jsc-");
  try {
    const script = join(folder, "protocol.js");
    execFileSync(
      process.execPath,
      [join(ROOT, ".github/scripts/join-protocol.mjs"), script, "vectors.js"],
      {
        cwd: ROOT,
        timeout: 120_000,
      },
    );
    // The package's own entry (AppLink, the genesis and recovery exports) for the controller's tests, which need no relay.
    const appScript = join(folder, "protocol-app.js");
    execFileSync(process.execPath, [join(ROOT, ".github/scripts/join-protocol.mjs"), appScript], {
      cwd: ROOT,
      timeout: 120_000,
    });
    // The build output stays in the temporary folder: none lands in the repository, and two runs
    // never share a build lock.
    const scratch = ["--scratch-path", join(folder, "build")];
    const swift = (args: string[], timeout: number, env?: NodeJS.ProcessEnv) =>
      spawnSync("swift", [...args, ...scratch], {
        cwd: APP,
        encoding: "utf8",
        // A build of the whole package from nothing prints megabytes of warnings: spawnSync kills a child past its 1 MiB default.
        maxBuffer: 64 * 1024 * 1024,
        timeout,
        env: { ...process.env, ...env },
      });
    // RelayConnectionTests, FirstDeviceRelayTests and DevicesRelayTests need a relay: app-relay.test.ts, app-first-device.test.ts and app-devices.test.ts run them.
    const tests = swift(
      [
        "test",
        "--skip",
        "RelayConnectionTests",
        "--skip",
        "FirstDeviceRelayTests",
        "--skip",
        "DevicesRelayTests",
      ],
      // The app's tests took 284 s here (Mac mini M4, 2026-11-28) and passed 450 s on the macos-latest runner with the
      // message selection's offscreen bitmap tests (#194).
      750_000,
      {
        PARDNER_JOINED_SCRIPT: script,
        PARDNER_APP_SCRIPT: appScript,
      },
    );
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);
    // Never zero, and never fewer than the package defines: a run that executes nothing is no pass.
    // Every test file of every bundle counts, since `executed` below is the total over all of them.
    const testsDir = join(APP, "Tests");
    const defined = readdirSync(testsDir, { recursive: true, encoding: "utf8" })
      .filter(
        (file) =>
          file.endsWith(".swift") &&
          !file.endsWith("RelayConnectionTests.swift") &&
          !file.endsWith("FirstDeviceRelayTests.swift") &&
          !file.endsWith("DevicesRelayTests.swift"),
      )
      .reduce(
        (sum, file) =>
          sum + (readFileSync(join(testsDir, file), "utf8").match(/func test\w+\(/g) ?? []).length,
        0,
      );
    // Each test bundle runs on its own and ends with its own "All tests" line ("Selected tests" under `--skip`): the total is their sum.
    const executed = [
      ...(tests.stdout + tests.stderr).matchAll(
        // XCTest adds "with N test(s) skipped and" when a test throws XCTSkip (the copy test does on a runner whose SwiftUI lacks the view it reads).
        /Test Suite '(?:All|Selected) tests' passed[^\n]*\n\s*Executed (\d+) tests?, with (?:\d+ tests? skipped and )?0 failures/g,
      ),
    ].reduce((sum, m) => sum + Number(m[1]), 0);
    assert.ok(defined > 0 && executed >= defined, `executed ${executed} of ${defined} tests`);
    const built = swift(["build", "--product", "vector-tool"], 240_000);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const program = join(swift(["build", "--show-bin-path"], 60_000).stdout.trim(), "vector-tool");
    // The other direction: a seal CryptoKit makes, under the package's `info`, opens on Node. The
    // vector files hold the first: seals Node made, which the run above opened in JavaScriptCore.
    const node = createNodePlatform();
    const made = node.makeKeyPair("receiver", "receive");
    assert.ok(made.ok);
    const [channel, recipient] = [node.random(32), node.random(32)];
    const epochKey = node.random(32);
    const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
    const info = epochSealInfo(channel, undefined, recipient);
    const sealed = spawnSync(program, ["seal", hex(made.value), hex(info), hex(epochKey)], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(sealed.status, 0, sealed.stderr);
    const [enc, box] = sealed.stdout
      .trim()
      .split(" ")
      .map((h) => Uint8Array.from(Buffer.from(h, "hex")));
    const epoch = {
      id: node.random(32),
      entry: {
        channel,
        seq: 0,
        seals: [{ recipient, enc, sealed: box }],
        commitment: epochCommitment(node, channel, undefined, epochKey),
      },
    } as unknown as LoggedEpoch;
    const opened = openEpochSeal(node, "receiver", epoch, recipient);
    assert.ok(opened.ok);
    assert.deepEqual(opened.value, epochKey);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
