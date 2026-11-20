/** The device-log entry builders (device pairing design 3.6, 3.9, 4.2): each entry is one the log accepts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import {
  buildAdd,
  buildGenesis,
  buildRemove,
  readDeviceEntry,
  type SignedEntry,
} from "../../src/protocol/device-builders.ts";
import {
  checkDeviceEntry,
  type DeviceKeys,
  decodeDeviceEntry,
  encodeDeviceEntry,
  type LoggedEntry,
  type PublicKeys,
} from "../../src/protocol/device-log.ts";
import { deviceId, signedId } from "../../src/protocol/ids.ts";
import type { Result } from "../../src/protocol/result.ts";
import { makeProof } from "./proof.ts";

const platform = createNodePlatform();
let counter = 0;

function party(kind: "app" | "bot" = "app") {
  const n = counter++;
  const signing = platform.makeKeyPair(`build.${n}.s`, "sign");
  const receiving = platform.makeKeyPair(`build.${n}.r`, "receive");
  assert.ok(signing.ok && receiving.ok);
  const keys: PublicKeys = { signing: signing.value, receiving: receiving.value };
  const device: DeviceKeys = { kind, ...keys };
  return {
    name: `build.${n}.s`,
    keys,
    device,
    id: deviceId(platform, keys.signing, keys.receiving),
  };
}

/** Appends a built entry to `log` as a device reading the log would. */
function append(log: LoggedEntry[], built: Result<SignedEntry>): SignedEntry {
  assert.ok(built.ok);
  const verdict = checkDeviceEntry(platform, log, built.value.signed, built.value.sig);
  assert.ok(verdict.ok);
  assert.deepEqual(verdict.value.id, built.value.id);
  log.push(verdict.value);
  return built.value;
}

function started() {
  const first = party();
  const recovery = party();
  const log: LoggedEntry[] = [];
  append(log, buildGenesis(platform, first.name, first.device, recovery.keys));
  return { first, recovery, log };
}

test("a genesis is signed by the device that names itself, and the log takes it at 0", () => {
  const { first, log } = started();
  assert.equal(log.length, 1);
  assert.equal(log[0]?.entry.seq, 0);
  assert.deepEqual(log[0]?.entry.signer, first.id);
  const entry = log[0]?.entry;
  assert.equal(entry?.person, undefined);
});

test("an add lands at the log's length, with the person and the last id, and again after an add", () => {
  const { first, log } = started();
  const second = party();
  const third = party();
  const person = log[0]?.id as Uint8Array;
  const one = append(
    log,
    buildAdd(
      platform,
      first.name,
      log,
      first.id,
      second.device,
      makeProof(platform, second.name, person, second.device),
    ),
  );
  assert.equal(log.length, 2);
  const decoded = decodeDeviceEntry(one.signed);
  assert.ok(decoded.ok);
  assert.equal(decoded.value.seq, 1);
  assert.deepEqual(decoded.value.person, person);
  assert.deepEqual(decoded.value.prev, log[0]?.id);
  assert.deepEqual(one.id, signedId(platform, one.signed));
  append(
    log,
    buildAdd(
      platform,
      second.name,
      log,
      second.id,
      third.device,
      makeProof(platform, third.name, person, third.device),
    ),
  );
  assert.equal(log.length, 3);
  assert.equal(log[2]?.entry.seq, 2);
});

test("a remove lands at the log's length, and a device does not remove itself", () => {
  const { first, log } = started();
  const second = party();
  const person = log[0]?.id as Uint8Array;
  const proof = makeProof(platform, second.name, person, second.device);
  append(log, buildAdd(platform, first.name, log, first.id, second.device, proof));
  const self = buildRemove(platform, first.name, log, first.id, first.id);
  assert.deepEqual(self, { ok: false, error: "bad-input" });
  append(log, buildRemove(platform, first.name, log, first.id, second.id));
  assert.equal(log.length, 3);
});

test("a builder returns a failure for an entry the log would refuse, and signs nothing it returns", () => {
  const { first, log } = started();
  const second = party();
  const stranger = party();
  const person = log[0]?.id as Uint8Array;
  const proof = makeProof(platform, second.name, person, second.device);
  // A proof for another person: the log refuses the add.
  const wrong = makeProof(platform, second.name, platform.random(32), second.device);
  assert.equal(buildAdd(platform, first.name, log, first.id, second.device, wrong).ok, false);
  // A signer that is not in the log, and a target that is not active.
  assert.equal(buildAdd(platform, stranger.name, log, stranger.id, second.device, proof).ok, false);
  assert.equal(buildRemove(platform, first.name, log, first.id, stranger.id).ok, false);
  // No log, no position.
  assert.equal(buildAdd(platform, first.name, [], first.id, second.device, proof).ok, false);
});

test("a builder given a value outside its field returns a failure and does not throw", () => {
  const { log, first } = started();
  const other = party();
  const results = [
    buildRemove(platform, first.name, log, first.id, new Uint8Array(31)),
    buildAdd(
      platform,
      first.name,
      log,
      first.id,
      { ...other.device, kind: "x" as "app" },
      makeProof(platform, other.name, log[0]?.id as Uint8Array, other.device),
    ),
    buildAdd(platform, first.name, log, first.id, other.device, new Uint8Array(63)),
    buildGenesis(
      platform,
      first.name,
      { ...first.device, signing: new Uint8Array(65) },
      first.keys,
    ),
  ];
  for (const [i, r] of results.entries()) assert.ok(!r.ok, `case ${i}`);
});

test("a pending entry reads back as what it does, for the app that kept it (design 3.6)", () => {
  const { first, log } = started();
  const second = party();
  const person = log[0]?.id as Uint8Array;
  const proof = makeProof(platform, second.name, person, second.device);
  const add = buildAdd(platform, first.name, log, first.id, second.device, proof);
  assert.ok(add.ok);
  const read = readDeviceEntry(platform, add.value.signed);
  assert.ok(read.ok);
  assert.equal(read.value.kind, "add");
  assert.equal(read.value.seq, 1);
  assert.deepEqual(read.value.prev, log[0]?.id);
  assert.deepEqual(read.value.signer, first.id);
  assert.deepEqual(read.value.device, second.id);
  assert.deepEqual(read.value.keys, second.device);
  assert.deepEqual(read.value.proof, proof);
  append(log, add);
  const remove = buildRemove(platform, first.name, log, first.id, second.id);
  assert.ok(remove.ok);
  const gone = readDeviceEntry(platform, remove.value.signed);
  assert.ok(gone.ok);
  assert.equal(gone.value.kind, "remove");
  assert.equal(gone.value.seq, 2);
  assert.deepEqual(gone.value.device, second.id);
  assert.equal(gone.value.keys, undefined);
});

test("bytes that are no add or remove do not read back", () => {
  const { log } = started();
  assert.deepEqual(readDeviceEntry(platform, Uint8Array.of(1, 2, 3)), {
    ok: false,
    error: "bad-input",
  });
  const genesis = log[0];
  assert.ok(genesis);
  assert.equal(readDeviceEntry(platform, encodeDeviceEntry(genesis.entry)).ok, false);
});
