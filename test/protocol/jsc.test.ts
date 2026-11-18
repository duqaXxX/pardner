/**
 * The vectors inside JavaScriptCore, with CryptoKit behind the platform interface: the joined
 * script and the Swift program of `test/protocol/jsc/` built into a temporary folder and run.
 * Only a Mac with the Command Line Tools can do it.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
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
const JSC = join(import.meta.dirname, "jsc");

function skipReason(): string | false {
  if (process.platform !== "darwin") return "JavaScriptCore with CryptoKit runs on macOS only";
  const swiftc = spawnSync("swiftc", ["--version"], { stdio: "ignore" });
  return swiftc.status === 0 ? false : "swiftc is not on the path";
}

test("every vector file passes in JavaScriptCore on CryptoKit", {
  skip: skipReason(),
  timeout: 450_000,
}, () => {
  const folder = tempDirSync("pardner-jsc-");
  try {
    const script = join(folder, "protocol.js");
    const program = join(folder, "run");
    execFileSync(
      process.execPath,
      [join(ROOT, ".github/scripts/join-protocol.mjs"), script, "vectors.js"],
      {
        cwd: ROOT,
        timeout: 120_000,
      },
    );
    execFileSync(
      "swiftc",
      [
        "-O",
        "-parse-as-library",
        join(JSC, "platform.swift"),
        join(JSC, "run.swift"),
        "-o",
        program,
      ],
      { timeout: 240_000, stdio: "pipe" },
    );
    const run = spawnSync(program, [script, join(import.meta.dirname, "vectors")], {
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /0 failed cases/);
    // DeriveKeyPair on CryptoKit gives the private key of RFC 9180's own vector (A.3, 7.1.3).
    const rfc = JSON.parse(
      readFileSync(join(import.meta.dirname, "vectors", "hpke-rfc9180.json"), "utf8"),
    ).vector as { ikmR: string; skRm: string };
    const derived = spawnSync(program, ["derive", rfc.ikmR], { encoding: "utf8", timeout: 30_000 });
    assert.equal(derived.stdout.trim(), rfc.skRm, derived.stderr);
    // The boundary of DeriveKeyPair's acceptance, which no ikm reaches: 0, 1, n-1, n, 2^256-1.
    const n = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
    const scalar = (v: bigint) => v.toString(16).padStart(64, "0");
    const accepts = (v: bigint) =>
      spawnSync(program, ["accepts", scalar(v)], {
        encoding: "utf8",
        timeout: 30_000,
      }).stdout.trim();
    assert.deepEqual([0n, 1n, n - 1n, n, 2n ** 256n - 1n].map(accepts), [
      "false",
      "true",
      "true",
      "false",
      "false",
    ]);
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
