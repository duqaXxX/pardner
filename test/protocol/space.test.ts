/**
 * A person's space (personal space design 2.1, 2.3, 2.5) on real bytes: its nonce, the class of a
 * channel read from entry 0, and the rule that no entry after entry 0 changes a space's members.
 * The model's `personal space:` tests hold the same rules as sequences; the nonce's own vectors are
 * in `space.json`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkDeviceEntry, idKey, type LoggedEntry } from "../../src/protocol/device-log.ts";
import { buildEpoch, checkEpochEntry } from "../../src/protocol/epochs.ts";
import { labelBytes } from "../../src/protocol/labels.ts";
import {
  checkMemberEntry,
  type LoggedMember,
  membersOf,
  spaceNonce,
} from "../../src/protocol/member-log.ts";
import { runVectors } from "../../src/protocol/vectors.ts";
import { platform } from "../relay/support.ts";
import { fill, memberEntry, type Person, person } from "../relay/world.ts";

/** A person's device log as a device holds it: its genesis, checked. */
function logOf(p: Person): LoggedEntry[] {
  const v = checkDeviceEntry(platform, [], p.genesis.signed, p.genesis.sig);
  assert.ok(v.ok);
  return [v.value];
}

/** The member entries `bodies` of one channel, each signed by its person's first device and checked. */
function chain(steps: [Person, Record<string, unknown>][], logs: Map<string, LoggedEntry[]>) {
  const members: LoggedMember[] = [];
  for (const [by, body] of steps) {
    const e = memberEntry(by, members, body);
    const v = checkMemberEntry(
      platform,
      members,
      e.signed,
      e.sig,
      logs.get(idKey(by.id)) as LoggedEntry[],
    );
    assert.ok(v.ok, `${body.kind} follows`);
    members.push(v.value);
  }
  return members;
}

test("2.1: the nonce of a space is the first 16 bytes of SHA-256 of its own label and the person", () => {
  const p = person();
  const nonce = spaceNonce(platform, p.id);
  const wanted = platform.sha256(Uint8Array.of(...labelBytes("personal-space"), ...p.id));
  assert.deepEqual(nonce, wanted.slice(0, 16));
  assert.notDeepEqual(nonce, spaceNonce(platform, person().id));
});

test("2.3: the class is read from entry 0 alone: a nonce that is its signer's space nonce is a space, any other a conversation", () => {
  const [p, q] = [person(), person()];
  const logs = new Map([p, q].map((x) => [idKey(x.id), logOf(x)]));
  const class0 = (by: Person, nonce: Uint8Array) =>
    (chain([[by, { kind: "create", nonce }]], logs)[0] as LoggedMember).space;
  assert.equal(class0(p, spaceNonce(platform, p.id)), true);
  assert.equal(class0(p, fill(3, 16)), false);
  // Q signs a nonce that is P's space nonce: an ordinary channel of Q (2.3, last paragraph).
  assert.equal(class0(q, spaceNonce(platform, p.id)), false);
  const [add] = chain(
    [
      [p, { kind: "create", nonce: fill(3, 16) }],
      [p, { kind: "add", person: q.id, role: "member" }],
    ],
    logs,
  ).slice(1);
  assert.equal((add as LoggedMember).space, false);
});

test("2.5, S2 on a device: an add and an accept after entry 0 of a space change no membership, and fault nothing", () => {
  const [p, q] = [person(), person()];
  const logs = new Map([p, q].map((x) => [idKey(x.id), logOf(x)]));
  const steps = (nonce: Uint8Array): [Person, Record<string, unknown>][] => [
    [p, { kind: "create", nonce }],
    [p, { kind: "add", person: q.id, role: "member" }],
    [q, { kind: "accept" }],
  ];
  const space = chain(steps(spaceNonce(platform, p.id)), logs);
  assert.deepEqual([...membersOf(space)], [idKey(p.id)]);
  assert.deepEqual([...membersOf(space.slice(0, 1))], [idKey(p.id)]);
  // The same entries in a conversation channel do make Q a member: the rule is the class's.
  const conversation = chain(steps(fill(3, 16)), logs);
  assert.deepEqual([...membersOf(conversation)].sort(), [idKey(p.id), idKey(q.id)].sort());
});

test("2.5: the next epoch of a space that holds an add and an accept is sealed to its person's devices and recovery key alone", () => {
  const [p, q] = [person(), person()];
  const [pLog, qLog] = [logOf(p), logOf(q)];
  const logs = new Map([
    [idKey(p.id), pLog],
    [idKey(q.id), qLog],
  ]);
  const members = chain(
    [
      [p, { kind: "create", nonce: spaceNonce(platform, p.id) }],
      [p, { kind: "add", person: q.id, role: "member" }],
      [q, { kind: "accept" }],
    ],
    logs,
  );
  const who = { person: p.id, device: p.first.id, sign: p.first.sign };
  // Only P's log is handed in: a membership that took Q in would need Q's too and fail.
  const built = buildEpoch(platform, members, [], [pLog], who);
  assert.ok(built.ok);
  assert.deepEqual(
    built.value.entry.seals.map((s) => idKey(s.recipient)).sort(),
    [idKey(p.first.id), idKey(p.recovery.recoveryId)].sort(),
  );
  const checked = checkEpochEntry(
    platform,
    [],
    members,
    [pLog, qLog],
    built.value.signed,
    built.value.sig,
  );
  assert.equal(checked.ok, true);
});

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "vectors", "space.json"), "utf8"),
);

test("every case of space.json has a name of its own and passes", () => {
  const names = vectors.cases.map((c: { name: string }) => c.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(runVectors(platform, vectors), []);
});
