/**
 * The member log (design 6.2) on real bytes and real signatures. The model has no member log
 * (security design 10), so each rule is named after the sentence of security design 4 it holds.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import {
  checkDeviceEntry,
  type DeviceEntry,
  type DeviceKeys,
  encodeDeviceEntry,
  type LoggedEntry,
} from "../../src/protocol/device-log.ts";
import { deviceId } from "../../src/protocol/ids.ts";
import {
  checkMemberEntry,
  decodeMemberEntry,
  encodeMemberEntry,
  type LoggedMember,
  type MemberEntry,
  type MemberRole,
  type MemberRule,
} from "../../src/protocol/member-log.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { runVectors } from "../../src/protocol/vectors.ts";
import { makeProof } from "./proof.ts";

const platform = createNodePlatform();
let counter = 0;

/** A key pair the platform holds, and its id as a device. */
function device() {
  const n = counter++;
  const signing = platform.makeKeyPair(`member.${n}.s`, "sign");
  const receiving = platform.makeKeyPair(`member.${n}.r`, "receive");
  assert.ok(signing.ok && receiving.ok);
  const keys = { signing: signing.value, receiving: receiving.value };
  return { name: `member.${n}.s`, keys, id: deviceId(platform, keys.signing, keys.receiving) };
}

/** Appends a device-log entry signed by `by`, checked as a device would check it. */
function extend(devices: LoggedEntry[], by: { name: string }, entry: DeviceEntry) {
  const bytes = encodeDeviceEntry(entry);
  const signature = platform.sign(by.name, bytes);
  assert.ok(signature.ok);
  const verdict = checkDeviceEntry(platform, devices, bytes, signature.value);
  assert.ok(verdict.ok);
  devices.push(verdict.value);
}

/** A person: one device, and the device log (entry 0 gives the person id) the member log's checks read. */
function party() {
  const first = device();
  const recovery = device();
  const devices: LoggedEntry[] = [];
  extend(devices, first, {
    seq: 0,
    kind: "genesis",
    device: { kind: "app", ...first.keys },
    recovery: recovery.keys,
    signer: first.id,
  });
  return { ...first, devices, person: (devices[0] as LoggedEntry).id };
}
/** A second device the person adds, or removes again; it makes its own proof of possession. */
function addDevice(who: Party): ReturnType<typeof device> {
  const other = device();
  const head = { person: who.person, seq: who.devices.length, prev: who.devices.at(-1)?.id };
  const named: DeviceKeys = { kind: "app", ...other.keys };
  extend(who.devices, who, {
    ...head,
    kind: "add",
    device: named,
    proof: makeProof(platform, other.name, who.person, named),
    signer: who.id,
  });
  return other;
}
type Party = ReturnType<typeof party>;

/** A log being built: each step is checked as a device would check it. */
class Log {
  entries: LoggedMember[] = [];
  admin = party();
  constructor() {
    this.push(this.admin, {
      seq: 0,
      kind: "create",
      nonce: new Uint8Array(16).fill(7),
      signerPerson: this.admin.person,
      signerDevice: this.admin.id,
    });
  }
  /** The pair a device receives, and the verdict on it, whatever the signer's device state. */
  verdict(
    by: { name: string; devices?: LoggedEntry[] },
    entry: MemberEntry,
    ...given: [readonly LoggedEntry[]] | []
  ) {
    const signer = given.length ? given[0] : (by.devices as LoggedEntry[]);
    const bytes = encodeMemberEntry(entry);
    const signature = platform.sign(by.name, bytes);
    assert.ok(signature.ok);
    return checkMemberEntry(platform, this.entries, bytes, signature.value, signer);
  }
  push(by: Party, entry: MemberEntry) {
    const verdict = this.verdict(by, entry);
    assert.ok(verdict.ok, `a step of the log fails: ${verdict.ok ? "" : verdict.rule}`);
    this.entries.push(verdict.value);
  }
  rule(by: Party, entry: MemberEntry): MemberRule | null {
    const verdict = this.verdict(by, entry);
    return verdict.ok ? null : verdict.rule;
  }
  next(by: Party, body: Record<string, unknown>): MemberEntry {
    return {
      ...body,
      channel: this.entries[0]?.id,
      seq: this.entries.length,
      prev: this.entries.at(-1)?.id,
      signerPerson: by.person,
      signerDevice: by.id,
    } as MemberEntry;
  }
  add(by: Party, who: Party, role: MemberRole = "member") {
    this.push(by, this.next(by, { kind: "add", person: who.person, role }));
  }
  accept(who: Party) {
    this.push(who, this.next(who, { kind: "accept" }));
  }
  join(by: Party, who: Party, role: MemberRole = "member") {
    this.add(by, who, role);
    this.accept(who);
  }
}

test("section 4: entry 0 names the creator as admin, and the creator can then sign as an admin", () => {
  const log = new Log();
  const bob = party();
  assert.equal(
    log.rule(log.admin, log.next(log.admin, { kind: "add", person: bob.person, role: "member" })),
    null,
  );
});

test("section 4: later entries are signed by a person who is admin at that entry", () => {
  const log = new Log();
  const bob = party();
  const carol = party();
  log.join(log.admin, bob);
  const add = (by: Party) => log.next(by, { kind: "add", person: carol.person, role: "member" });
  assert.equal(log.rule(bob, add(bob)), "authority");
  assert.equal(log.rule(log.admin, add(log.admin)), null);
  const remove = log.next(bob, { kind: "remove", person: log.admin.person });
  assert.equal(log.rule(bob, remove), "authority");
  const promote = log.next(bob, { kind: "role", person: bob.person, role: "admin" });
  assert.equal(log.rule(bob, promote), "authority");
  log.push(log.admin, log.next(log.admin, { kind: "role", person: bob.person, role: "admin" }));
  assert.equal(log.rule(bob, add(bob)), null);
});

test('section 4: an "add person" makes a member only once that person accepts', () => {
  const log = new Log();
  const bob = party();
  const carol = party();
  log.add(log.admin, bob, "admin");
  const add = log.next(bob, { kind: "add", person: carol.person, role: "member" });
  assert.equal(log.rule(bob, add), "authority");
  log.accept(bob);
  assert.equal(
    log.rule(bob, { ...add, seq: log.entries.length, prev: log.entries.at(-1)?.id }),
    null,
  );
});

test('section 4: an "accept" follows an "add person" for that person, and only once', () => {
  const log = new Log();
  const bob = party();
  const carol = party();
  assert.equal(log.rule(bob, log.next(bob, { kind: "accept" })), "accept");
  log.add(log.admin, bob);
  assert.equal(log.rule(carol, log.next(carol, { kind: "accept" })), "accept");
  assert.equal(log.rule(log.admin, log.next(log.admin, { kind: "accept" })), "accept");
  log.accept(bob);
  assert.equal(log.rule(bob, log.next(bob, { kind: "accept" })), "accept");
});

test("section 4: the last admin cannot be removed or lose that role", () => {
  const log = new Log();
  const bob = party();
  log.join(log.admin, bob);
  const removed = log.next(log.admin, { kind: "remove", person: log.admin.person });
  const demoted = log.next(log.admin, { kind: "role", person: log.admin.person, role: "member" });
  assert.equal(log.rule(log.admin, removed), "last admin");
  assert.equal(log.rule(log.admin, demoted), "last admin");
  log.push(log.admin, log.next(log.admin, { kind: "role", person: bob.person, role: "admin" }));
  assert.equal(log.rule(log.admin, log.next(log.admin, removed)), null);
  assert.equal(log.rule(log.admin, log.next(log.admin, demoted)), null);
});

test("section 4: a pending admin is not an admin, so the one accepted admin is still the last", () => {
  const log = new Log();
  const bob = party();
  log.add(log.admin, bob, "admin");
  const removed = log.next(log.admin, { kind: "remove", person: log.admin.person });
  assert.equal(log.rule(log.admin, removed), "last admin");
});

test("section 4: a person who was removed can be added, and accept, again", () => {
  const log = new Log();
  const bob = party();
  log.join(log.admin, bob);
  log.push(log.admin, log.next(log.admin, { kind: "remove", person: bob.person }));
  const add = log.next(log.admin, { kind: "add", person: bob.person, role: "admin" });
  assert.equal(log.rule(log.admin, add), null);
  log.push(log.admin, add);
  log.accept(bob);
  const again = log.next(bob, { kind: "add", person: log.admin.person, role: "member" });
  assert.equal(log.rule(bob, again), "member");
  assert.equal(log.rule(bob, log.next(bob, { kind: "remove", person: log.admin.person })), null);
});

test("a person who is a member or invited is not added again, and only a member is given a role", () => {
  const log = new Log();
  const bob = party();
  const carol = party();
  log.add(log.admin, bob);
  const addBob = log.next(log.admin, { kind: "add", person: bob.person, role: "admin" });
  assert.equal(log.rule(log.admin, addBob), "member");
  log.accept(bob);
  assert.equal(log.rule(log.admin, log.next(log.admin, addBob)), "member");
  assert.equal(
    log.rule(log.admin, log.next(log.admin, { kind: "remove", person: carol.person })),
    "member",
  );
  const role = { kind: "role", person: carol.person, role: "admin" };
  assert.equal(log.rule(log.admin, log.next(log.admin, role)), "member");
  log.add(log.admin, carol);
  assert.equal(log.rule(log.admin, log.next(log.admin, role)), "member");
});

test("section 4: a device of another person cannot sign as this person", () => {
  const log = new Log();
  const bob = party();
  const carol = party();
  log.join(log.admin, bob);
  const add = (by: Party, as: Party) => ({
    ...log.next(as, { kind: "add", person: carol.person, role: "member" }),
    signerDevice: by.id,
  });
  const forged = add(bob, log.admin);
  assert.equal(log.rule(bob, forged), "device");
  assert.deepEqual(log.verdict(bob, forged, log.admin.devices), { ok: false, rule: "device" });
  const create = { ...(log.entries[0]?.entry as MemberEntry), signerDevice: bob.id };
  const bytes = encodeMemberEntry(create);
  const signature = platform.sign(bob.name, bytes);
  assert.ok(signature.ok);
  assert.deepEqual(checkMemberEntry(platform, [], bytes, signature.value, log.admin.devices), {
    ok: false,
    rule: "device",
  });
});

test("section 4, 6.2: the signer device is an active device of the signer person's device log", () => {
  const log = new Log();
  const bob = party();
  const second = addDevice(log.admin);
  const entry = log.next(log.admin, { kind: "add", person: bob.person, role: "member" });
  assert.deepEqual(log.verdict(log.admin, entry, []), { ok: false, rule: "device" });
  assert.deepEqual(log.verdict(log.admin, entry, bob.devices), { ok: false, rule: "device" });
  assert.deepEqual(log.verdict(log.admin, entry, "no" as unknown as LoggedEntry[]), {
    ok: false,
    rule: "device",
  });
  assert.equal(log.verdict(log.admin, entry).ok, true);
  // a device the person added later signs; once the person removes it, it is not active
  const byTwo = { ...entry, signerDevice: second.id };
  assert.equal(log.verdict(second, byTwo, log.admin.devices).ok, true);
  const head = {
    person: log.admin.person,
    seq: log.admin.devices.length,
    prev: log.admin.devices.at(-1)?.id,
  };
  extend(log.admin.devices, log.admin, {
    ...head,
    kind: "remove",
    device: second.id,
    signer: log.admin.id,
  });
  assert.deepEqual(log.verdict(second, byTwo, log.admin.devices), { ok: false, rule: "device" });
});

test("an entry's position, predecessor and channel must follow the log", () => {
  const log = new Log();
  const bob = party();
  log.join(log.admin, bob);
  const add = log.next(log.admin, { kind: "add", person: party().person, role: "member" });
  assert.equal(log.rule(log.admin, { ...add, seq: 5 }), "position");
  assert.equal(log.rule(log.admin, { ...add, prev: log.entries[1]?.id }), "prev");
  assert.equal(log.rule(log.admin, { ...add, channel: log.entries[1]?.id }), "channel");
  const second = { ...log.entries[0]?.entry, seq: 0 } as MemberEntry;
  assert.equal(log.rule(log.admin, second), "position");
});

test("a signature verifies before any rule: a bad one is named first, whatever else is wrong", () => {
  const log = new Log();
  const entry = { ...log.next(log.admin, { kind: "accept" }), seq: 9 } as MemberEntry;
  const bytes = encodeMemberEntry(entry);
  const signature = platform.sign(log.admin.name, bytes);
  assert.ok(signature.ok);
  const bad = Uint8Array.from(signature.value);
  bad[7] = (bad[7] as number) ^ 1;
  const check = (s: Bytes) => checkMemberEntry(platform, log.entries, bytes, s, log.admin.devices);
  assert.deepEqual(check(bad), { ok: false, rule: "signature" });
  assert.deepEqual(check(signature.value.slice(1)), { ok: false, rule: "signature" });
  assert.deepEqual(check("no" as unknown as Bytes), { ok: false, rule: "signature" });
  assert.deepEqual(check(signature.value), { ok: false, rule: "position" });
});

test("a decoder returns a failure for bytes that are not an entry, and a check never throws on them", () => {
  assert.deepEqual(decodeMemberEntry(new Uint8Array(0)), { ok: false, error: "bad-input" });
  const log = new Log();
  const bytes = encodeMemberEntry(log.entries[0]?.entry as MemberEntry);
  const signature = new Uint8Array(64);
  const check = (b: Bytes) => checkMemberEntry(platform, [], b, signature, log.admin.devices);
  assert.deepEqual(check(bytes.slice(0, 40)), { ok: false, rule: "decode" });
  assert.deepEqual(check(Uint8Array.of(...bytes, 0)), { ok: false, rule: "decode" });
  assert.deepEqual(check("no" as unknown as Bytes), { ok: false, rule: "decode" });
});

test("section 6.2: all five kinds encode and decode to the same value, and decoding copies its input", () => {
  const log = new Log();
  const bob = party();
  const head = log.next(log.admin, {});
  const bodies = [
    { kind: "add", person: bob.person, role: "admin" },
    { kind: "accept" },
    { kind: "remove", person: bob.person },
    { kind: "role", person: bob.person, role: "member" },
  ];
  for (const body of [...bodies, { kind: "create" }]) {
    const entry = (
      body.kind === "create" ? log.entries[0]?.entry : { ...head, ...body }
    ) as MemberEntry;
    const bytes = encodeMemberEntry(entry);
    const decoded = decodeMemberEntry(bytes);
    assert.ok(decoded.ok, body.kind);
    assert.deepEqual(decoded.value, entry);
    assert.deepEqual(encodeMemberEntry(decoded.value), bytes);
  }
  const bytes = encodeMemberEntry({ ...head, kind: "accept" } as MemberEntry);
  const decoded = decodeMemberEntry(bytes);
  bytes.fill(0);
  assert.ok(decoded.ok);
  assert.notDeepEqual(encodeMemberEntry(decoded.value), bytes);
});

test("a role other than member or admin is refused by the decoder and by the encoder", () => {
  const log = new Log();
  const entry = log.next(log.admin, { kind: "add", person: party().person, role: "admin" });
  const bytes = encodeMemberEntry(entry);
  const at = bytes.length - 65; // the role byte precedes the two signer ids
  assert.equal(bytes[at], 1);
  for (const role of [2, 255]) {
    const changed = Uint8Array.from(bytes);
    changed[at] = role;
    assert.deepEqual(decodeMemberEntry(changed), { ok: false, error: "bad-input" });
  }
  assert.throws(
    () => encodeMemberEntry({ ...entry, role: "owner" } as unknown as MemberEntry),
    RangeError,
  );
});

test("the encoder refuses what the decoder would: a bad shape of entry 0 or of a later entry", () => {
  const log = new Log();
  const create = log.entries[0]?.entry as MemberEntry;
  const id = log.entries[0]?.id as Bytes;
  assert.throws(() => encodeMemberEntry({ ...create, seq: 1 } as MemberEntry), RangeError);
  assert.throws(() => encodeMemberEntry({ ...create, channel: id } as MemberEntry), RangeError);
  assert.throws(() => encodeMemberEntry({ ...create, prev: id } as MemberEntry), RangeError);
  const accept = log.next(log.admin, { kind: "accept" });
  assert.throws(() => encodeMemberEntry({ ...accept, seq: 0 }), RangeError);
  assert.throws(() => encodeMemberEntry({ ...accept, channel: undefined }), RangeError);
  assert.throws(() => encodeMemberEntry({ ...accept, prev: undefined }), RangeError);
  assert.throws(
    () => encodeMemberEntry({ ...create, nonce: new Uint8Array(15) } as MemberEntry),
    RangeError,
  );
});

test("an entry's id is the hash of its signed bytes, and entry 0's id is the channel id", () => {
  const log = new Log();
  const bytes = encodeMemberEntry(log.entries[0]?.entry as MemberEntry);
  assert.deepEqual(log.entries[0]?.id, platform.sha256(bytes));
  assert.deepEqual(log.next(log.admin, {}).channel, log.entries[0]?.id);
});

test("section 6.2: the first version's create alone, with two nonces, makes two channels of one person", () => {
  const one = new Log();
  const entry = one.entries[0]?.entry as MemberEntry & { kind: "create" };
  const other = encodeMemberEntry({ ...entry, nonce: new Uint8Array(16).fill(8) });
  assert.notDeepEqual(platform.sha256(other), one.entries[0]?.id);
});

test("every case of member-entry.json passes, and a bad kind or a missing role is a fault of the file", () => {
  const file = JSON.parse(
    readFileSync(join(import.meta.dirname, "vectors", "member-entry.json"), "utf8"),
  );
  assert.deepEqual(runVectors(platform, file), []);
  const withRole = file.cases.find((c: { inputs?: { kind: string } }) => c.inputs?.kind === "add");
  const unknown = structuredClone(withRole);
  unknown.inputs.kind = "add ";
  const noRole = structuredClone(withRole);
  noRole.inputs.role = undefined;
  const faults = [unknown, noRole].map((c) => ({ ...c, fails: "throws", error: "TypeError" }));
  assert.deepEqual(runVectors(platform, { ...file, cases: [unknown, noRole] }), [
    unknown.name,
    noRole.name,
  ]);
  assert.deepEqual(runVectors(platform, { ...file, cases: faults }), []);
});

test("section 4: an entry that changes no role changes nobody's admin standing and is refused", () => {
  const log = new Log();
  const bob = party();
  log.join(log.admin, bob);
  const same = log.next(log.admin, { kind: "role", person: bob.person, role: "member" });
  assert.equal(log.rule(log.admin, same), "member");
  const admin = log.next(log.admin, { kind: "role", person: log.admin.person, role: "admin" });
  assert.equal(log.rule(log.admin, admin), "member");
});

test("a case of member-entry.json without a person or a nonce is a fault of the file", () => {
  const file = JSON.parse(
    readFileSync(join(import.meta.dirname, "vectors", "member-entry.json"), "utf8"),
  );
  for (const [kind, field] of [
    ["add", "person"],
    ["remove", "person"],
    ["create", "nonce"],
  ]) {
    const held = file.cases.find((c: { inputs?: { kind: string } }) => c.inputs?.kind === kind);
    const missing = structuredClone(held);
    delete missing.inputs[field as string];
    const fault = { ...missing, fails: "throws", error: "TypeError" };
    assert.deepEqual(
      runVectors(platform, { ...file, cases: [fault] }),
      [],
      `${kind} without ${field}`,
    );
  }
});

test("a case of member-entry.json naming a device log the file does not hold is a fault of the file", () => {
  const file = JSON.parse(
    readFileSync(join(import.meta.dirname, "vectors", "member-entry.json"), "utf8"),
  );
  const refused = file.cases.find(
    (c: { devices?: string; fails?: string }) => c.devices !== undefined && c.fails === "check",
  );
  assert.ok(refused);
  const typo = { ...refused, devices: "Typo", fails: "throws", error: "TypeError" };
  assert.deepEqual(runVectors(platform, { ...file, cases: [typo] }), []);
});

test("section 4: a remove of an invited person withdraws the invitation; the person cannot accept, and can be added again", () => {
  const log = new Log();
  const bob = party();
  log.add(log.admin, bob);
  log.push(log.admin, log.next(log.admin, { kind: "remove", person: bob.person }));
  assert.equal(log.rule(bob, log.next(bob, { kind: "accept" })), "accept");
  assert.equal(
    log.rule(log.admin, log.next(log.admin, { kind: "remove", person: bob.person })),
    "member",
  );
  log.join(log.admin, bob, "admin");
});

test("section 4: only an admin withdraws an invitation", () => {
  const log = new Log();
  const bob = party();
  const carol = party();
  log.join(log.admin, bob);
  log.add(log.admin, carol);
  assert.equal(log.rule(bob, log.next(bob, { kind: "remove", person: carol.person })), "authority");
  assert.equal(
    log.rule(carol, log.next(carol, { kind: "remove", person: carol.person })),
    "authority",
  );
});

test("section 4: withdrawing an admin invitation does not count against the last admin", () => {
  const log = new Log();
  const carol = party();
  log.add(log.admin, carol, "admin");
  assert.equal(
    log.rule(log.admin, log.next(log.admin, { kind: "remove", person: carol.person })),
    null,
  );
});

test("section 4: a removed admin's invitee cannot accept once an admin withdraws the invitation", () => {
  const log = new Log();
  const mallory = party();
  const eve = party();
  log.join(log.admin, mallory, "admin");
  log.add(mallory, eve, "admin");
  log.push(log.admin, log.next(log.admin, { kind: "remove", person: mallory.person }));
  log.push(log.admin, log.next(log.admin, { kind: "remove", person: eve.person }));
  assert.equal(log.rule(eve, log.next(eve, { kind: "accept" })), "accept");
});

test("section 4: only an accept and a remove of a member change the set of members, read after the entry is stored", () => {
  const log = new Log();
  const bob = party();
  const carol = party();
  const flag = () => (log.entries.at(-1) as LoggedMember).changesMembers;
  log.add(log.admin, bob);
  assert.equal(flag(), false);
  log.add(log.admin, carol);
  log.push(log.admin, log.next(log.admin, { kind: "remove", person: carol.person }));
  assert.equal(flag(), false);
  log.accept(bob);
  assert.equal(flag(), true);
  log.push(log.admin, log.next(log.admin, { kind: "role", person: bob.person, role: "admin" }));
  assert.equal(flag(), false);
  log.push(log.admin, log.next(log.admin, { kind: "remove", person: bob.person }));
  assert.equal(flag(), true);
});
