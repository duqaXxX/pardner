/**
 * Model "round 4, finding 4" on real bytes: after the recovery sheet is replaced, the new sheet
 * still reads the older history, though the device that sealed it was removed by a later reset.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import {
  checkDeviceEntry,
  type DeviceEntry,
  encodeDeviceEntry,
  type LoggedEntry,
  recipientsOf,
} from "../../src/protocol/device-log.ts";
import {
  checkEpochEntry,
  encodeEpochEntry,
  encodeHistorySeal,
  epochCommitment,
  openEpochSeal,
  openHistorySeal,
  sealEpochKey,
} from "../../src/protocol/epochs.ts";
import { deviceId, recoveryKeyId } from "../../src/protocol/ids.ts";
import {
  checkMemberEntry,
  encodeMemberEntry,
  type LoggedMember,
} from "../../src/protocol/member-log.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { makeProof } from "./proof.ts";

const p = createNodePlatform();
let n = 0;
function keyed() {
  const i = n++;
  const s = p.makeKeyPair(`sheet.${i}.s`, "sign");
  const r = p.makeKeyPair(`sheet.${i}.r`, "receive");
  assert.ok(s.ok && r.ok);
  const keys = { signing: s.value, receiving: r.value };
  return {
    sign: `sheet.${i}.s`,
    receive: `sheet.${i}.r`,
    keys,
    id: deviceId(p, keys.signing, keys.receiving),
    rid: recoveryKeyId(p, keys.signing, keys.receiving),
  };
}
/** The proof of possession a new device makes for the person it joins (design 6.1). */
const proof = (d: ReturnType<typeof keyed>, person: Bytes) =>
  makeProof(p, d.sign, person, { kind: "app", ...d.keys });
function push(log: LoggedEntry[], signName: string, e: DeviceEntry) {
  const bytes = encodeDeviceEntry(e);
  const signature = p.sign(signName, bytes);
  assert.ok(signature.ok);
  const verdict = checkDeviceEntry(p, log, bytes, signature.value);
  assert.ok(verdict.ok);
  log.push(verdict.value);
}

test("the new sheet reads an epoch through a history seal whose maker a later reset removed", () => {
  const [d1, r1, d2, r2, d3] = [keyed(), keyed(), keyed(), keyed(), keyed()] as const;
  const log: LoggedEntry[] = [];
  push(log, d1.sign, {
    seq: 0,
    kind: "genesis",
    device: { kind: "app", ...d1.keys },
    recovery: r1.keys,
    signer: d1.id,
  });
  const person = (log[0] as LoggedEntry).id;
  const members: LoggedMember[] = [];
  const mb = encodeMemberEntry({
    seq: 0,
    kind: "create",
    nonce: new Uint8Array(16),
    signerPerson: person,
    signerDevice: d1.id,
  });
  const ms = p.sign(d1.sign, mb);
  assert.ok(ms.ok);
  const mv = checkMemberEntry(p, members, mb, ms.value, log);
  assert.ok(mv.ok);
  members.push(mv.value);
  const channel = (members[0] as LoggedMember).id;
  const key = p.random(32);
  const seals = recipientsOf(p, log).map((r) => {
    const s = sealEpochKey(p, channel, undefined, r.id, r.receiving, key);
    assert.ok(s.ok);
    return s.value;
  });
  const eb = encodeEpochEntry({
    channel,
    seq: 0,
    memberHead: { length: 1, last: channel },
    deviceHeads: [{ person, length: 1, last: person }],
    seals,
    commitment: epochCommitment(p, channel, undefined, key),
    signerPerson: person,
    signerDevice: d1.id,
  });
  const es = p.sign(d1.sign, eb);
  assert.ok(es.ok);
  const ev = checkEpochEntry(p, [], members, [log], eb, es.value);
  assert.ok(ev.ok);
  const epoch = ev.value;
  // d1 is lost: the sheet r1 resets to d2 and replaces itself with r2
  push(log, r1.sign, {
    person,
    seq: log.length,
    prev: log.at(-1)?.id,
    kind: "reset",
    set: [d2.id],
    newDevice: { device: { kind: "app", ...d2.keys }, proof: proof(d2, person) },
    recovery: r2.keys,
    signer: r1.rid,
  });
  const old = openEpochSeal(p, r1.receive, epoch, r1.rid);
  assert.ok(old.ok);
  const s = sealEpochKey(p, channel, undefined, r2.rid, r2.keys.receiving, old.value);
  assert.ok(s.ok);
  const hb = encodeHistorySeal({ channel, epoch: epoch.id, ...s.value, maker: d2.id });
  const hs = p.sign(d2.sign, hb);
  assert.ok(hs.ok);
  assert.ok(openHistorySeal(p, r2.receive, log, hb, hs.value, epoch).ok);
  // d2 is lost: the new sheet r2 resets to d3, which removes d2
  push(log, r2.sign, {
    person,
    seq: log.length,
    prev: log.at(-1)?.id,
    kind: "reset",
    set: [d3.id],
    newDevice: { device: { kind: "app", ...d3.keys }, proof: proof(d3, person) },
    signer: r2.rid,
  });
  const got = openHistorySeal(p, r2.receive, log, hb, hs.value, epoch);
  assert.ok(got.ok, "the new sheet reads epoch 0");
});
