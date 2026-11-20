import assert from "node:assert/strict";
import { copyFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadPairing, pair } from "../../../src/chat/relay/pairing.ts";
import { ConfigError, singleInstance } from "../../../src/core/port.ts";
import { createNodePlatform } from "../../../src/platform-node/platform.ts";
import { encodeDevicePossession } from "../../../src/protocol/device-log.ts";
import { decodePairingString } from "../../../src/protocol/pairing-string.ts";
import { tempDirSync } from "../../support/temp.ts";

const platform = createNodePlatform();
const person = platform.random(32);
const relay = new Uint8Array(65).fill(7);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function privateKeysOf(dir: string): string[] {
  const file = JSON.parse(readFileSync(join(dir, "keys.json"), "utf8")) as Record<
    string,
    { sk: string }
  >;
  return Object.values(file).map((entry) => entry.sk);
}

// C1: keys made for the person id, readable by their user only, no private key anywhere else.
test("C1: pairing makes both keys and a proof for the person id, and the device can verify it", async () => {
  const dir = tempDirSync("pardner-");
  const string = await pair(dir, person, relay, "alice");
  const parsed = decodePairingString(platform, string);
  assert.ok(parsed.ok);
  const { device, proof, name } = parsed.value;
  assert.equal(name, "alice");
  assert.equal(device.kind, "bot");
  assert.ok(platform.verify(device.signing, encodeDevicePossession(person, device), proof));
  // The keys named in the string are the ones on disk, and the pairing file says what they were made for.
  const loaded = loadPairing(dir);
  assert.equal(hex(loaded.person), hex(person));
  assert.equal(hex(loaded.relay), hex(relay));
  assert.equal(hex(loaded.device.signing), hex(device.signing));
  assert.equal(statSync(join(dir, "keys.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "pairing.json")).mode & 0o777, 0o600);
});

test("C1: no private key is in the string, the pairing file or any file but the key file", async () => {
  const dir = tempDirSync("pardner-");
  const string = await pair(dir, person, relay, "alice");
  const secrets = privateKeysOf(dir);
  assert.equal(secrets.length, 2);
  for (const secret of secrets) {
    assert.ok(!string.includes(secret));
    for (const name of readdirSync(dir).filter((n) => n !== "keys.json")) {
      assert.ok(!readFileSync(join(dir, name), "utf8").includes(secret), name);
    }
  }
});

test("a new pairing makes new keys and leaves one pairing", async () => {
  const dir = tempDirSync("pardner-");
  await pair(dir, person, relay, "alice");
  const first = privateKeysOf(dir);
  const other = new Uint8Array(65).fill(9);
  await pair(dir, person, other, "alice");
  const second = privateKeysOf(dir);
  assert.equal(second.length, 2);
  for (const secret of second) assert.ok(!first.includes(secret));
  assert.equal(hex(loadPairing(dir).relay), hex(other));
});

test("C14: a crash in the middle of a reset is found at the next start and finished by the next pairing", async () => {
  const dir = tempDirSync("pardner-");
  await pair(dir, person, relay, "alice");
  const crash = new Error("crash");
  await assert.rejects(
    pair(dir, person, relay, "alice", {
      between: () => {
        throw crash;
      },
    }),
    crash,
  );
  // New keys, no pairing file: the start refuses and names the file.
  assert.throws(
    () => loadPairing(dir),
    (e) => e instanceof ConfigError && /pairing\.json/.test(e.message),
  );
  await pair(dir, person, relay, "alice");
  assert.equal(hex(loadPairing(dir).person), hex(person));
});

test("a pairing file whose keys are not the key file's is refused", async () => {
  const dir = tempDirSync("pardner-");
  await pair(dir, person, relay, "alice");
  const other = tempDirSync("pardner-");
  await pair(other, person, relay, "alice");
  const mixed = tempDirSync("pardner-");
  for (const [from, name] of [
    [other, "keys.json"],
    [dir, "pairing.json"],
  ] as const) {
    copyFileSync(join(from, name), join(mixed, name));
  }
  assert.throws(() => loadPairing(mixed), ConfigError);
});

test("a pairing file that is null, or has a field of the wrong length, is a ConfigError naming the file", async () => {
  const dir = tempDirSync("pardner-");
  await pair(dir, person, relay, "alice");
  for (const text of ["null", "[]", '{"person":"00"}']) {
    writeFileSync(join(dir, "pairing.json"), text);
    assert.throws(
      () => loadPairing(dir),
      (e) => e instanceof ConfigError && /pairing\.json/.test(e.message),
    );
  }
});

test("a leftover temporary file does not change the mode of the files", async () => {
  const dir = tempDirSync("pardner-");
  for (const name of ["keys.json.tmp", "pairing.json.tmp"])
    writeFileSync(join(dir, name), "", { mode: 0o644 });
  await pair(dir, person, relay, "alice");
  for (const name of ["keys.json", "pairing.json"]) {
    assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name);
  }
});

test("a key whose use is not its name's is refused at the start", async () => {
  const dir = tempDirSync("pardner-");
  await pair(dir, person, relay, "alice");
  const file = join(dir, "keys.json");
  const keys = JSON.parse(readFileSync(file, "utf8")) as Record<string, { use: string }>;
  for (const key of Object.values(keys)) key.use = key.use === "sign" ? "receive" : "sign";
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  assert.throws(() => loadPairing(dir), ConfigError);
});

test("pairing refuses a person id or a relay key of the wrong length, before it makes a key", async () => {
  const dir = tempDirSync("pardner-");
  await assert.rejects(pair(dir, new Uint8Array(31), relay, "alice"), /person id/);
  await assert.rejects(pair(dir, person, new Uint8Array(64), "alice"), /relay key/);
  assert.deepEqual(readdirSync(dir), []);
});

test("a name the string cannot carry is refused before the old pairing is removed", async () => {
  const dir = tempDirSync("pardner-");
  await pair(dir, person, relay, "alice");
  const keys = readFileSync(join(dir, "keys.json"), "utf8");
  await assert.rejects(pair(dir, person, relay, "bad‮name"), RangeError);
  assert.equal(readFileSync(join(dir, "keys.json"), "utf8"), keys);
  assert.equal(hex(loadPairing(dir).person), hex(person));
});
