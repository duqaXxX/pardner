/**
 * Epochs and seals (design 6.3) on real bytes and real signatures. A test named after one of the
 * model's ends with ` [model]` and asserts the same outcome; a rule the model cannot hold is
 * named after the sentence of security design 4 or 5.7 it holds.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import { Writer } from "../../src/protocol/bytes.ts";
import {
  checkDeviceEntry,
  type DeviceEntry,
  type DeviceKeys,
  encodeDeviceEntry,
  idKey,
  type LoggedEntry,
  recipientsOf,
} from "../../src/protocol/device-log.ts";
import {
  checkEpochEntry,
  checkHistorySeal,
  decodeEpochEntry,
  decodeHistorySeal,
  type EpochEntry,
  type EpochRule,
  encodeEpochEntry,
  encodeHistorySeal,
  epochCommitment,
  epochSealInfo,
  type HistorySeal,
  type LoggedEpoch,
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
import { runVectors, type VectorFile } from "../../src/protocol/vectors.ts";
import { makeProof } from "./proof.ts";

const platform = createNodePlatform();
let counter = 0;

/** A device or a recovery key: a signing and a receiving key the platform holds, by name. */
function keyed() {
  const n = counter++;
  const signing = platform.makeKeyPair(`epoch.${n}.s`, "sign");
  const receiving = platform.makeKeyPair(`epoch.${n}.r`, "receive");
  assert.ok(signing.ok && receiving.ok);
  const keys = { signing: signing.value, receiving: receiving.value };
  return {
    sign: `epoch.${n}.s`,
    receive: `epoch.${n}.r`,
    keys,
    id: deviceId(platform, keys.signing, keys.receiving),
    recoveryId: recoveryKeyId(platform, keys.signing, keys.receiving),
  };
}
type Keyed = ReturnType<typeof keyed>;

/** The proof of possession a new device makes for the person it joins (design 6.1). */
const proof = (who: Keyed, person: Bytes, device: DeviceKeys) =>
  makeProof(platform, who.sign, person, device);

function extend(devices: LoggedEntry[], by: Keyed, entry: DeviceEntry) {
  const bytes = encodeDeviceEntry(entry);
  const signature = platform.sign(by.sign, bytes);
  assert.ok(signature.ok);
  const verdict = checkDeviceEntry(platform, devices, bytes, signature.value);
  assert.ok(verdict.ok);
  devices.push(verdict.value);
}

/** A person with a first device and a recovery key; `add` and `remove` extend the device log. */
function person() {
  const first = keyed();
  const recovery = keyed();
  const devices: LoggedEntry[] = [];
  extend(devices, first, {
    seq: 0,
    kind: "genesis",
    device: { kind: "app", ...first.keys },
    recovery: recovery.keys,
    signer: first.id,
  });
  const self = {
    first,
    recovery,
    devices,
    id: (devices[0] as LoggedEntry).id,
    add(): Keyed {
      const other = keyed();
      const head = { person: self.id, seq: devices.length, prev: devices.at(-1)?.id };
      extend(devices, first, {
        ...head,
        kind: "add",
        device: { kind: "app", ...other.keys },
        proof: proof(other, self.id, { kind: "app", ...other.keys }),
        signer: first.id,
      });
      return other;
    },
    remove(who: Keyed) {
      const head = { person: self.id, seq: devices.length, prev: devices.at(-1)?.id };
      extend(devices, first, { ...head, kind: "remove", device: who.id, signer: first.id });
    },
  };
  return self;
}
type Person = ReturnType<typeof person>;

/** A member log of `admin` and the persons it adds and who accept, each step checked. */
function channel(admin: Person, others: Person[]) {
  const log: LoggedMember[] = [];
  const push = (by: Person, body: Record<string, unknown>) => {
    const entry = {
      ...(log.length ? { channel: log[0]?.id, prev: log.at(-1)?.id } : {}),
      seq: log.length,
      ...body,
      signerPerson: by.id,
      signerDevice: by.first.id,
    };
    const bytes = encodeMemberEntry(entry as Parameters<typeof encodeMemberEntry>[0]);
    const signature = platform.sign(by.first.sign, bytes);
    assert.ok(signature.ok);
    const verdict = checkMemberEntry(platform, log, bytes, signature.value, by.devices);
    assert.ok(verdict.ok);
    log.push(verdict.value);
  };
  push(admin, { kind: "create", nonce: new Uint8Array(16).fill(3) });
  for (const who of others) {
    push(admin, { kind: "add", person: who.id, role: "member" });
    push(who, { kind: "accept" });
  }
  return log;
}

interface Built {
  logged: LoggedEpoch;
  bytes: Bytes;
  signature: Bytes;
  key: Bytes;
}

/** An epoch entry for the persons at the heads of their logs, the key sealed to `recipients`. */
function build(
  members: LoggedMember[],
  persons: Person[],
  epochs: LoggedEpoch[],
  by: { person: Person; device: Keyed },
  over: Partial<EpochEntry> = {},
  extra: { id: Bytes; receiving: Bytes }[] = [],
  memberCount = members.length,
): Built {
  const key = platform.random(32);
  const channelId = (members[0] as LoggedMember).id;
  const prev = epochs.at(-1)?.id;
  const heads = persons.map((p) => ({
    person: p.id,
    length: p.devices.length,
    last: (p.devices.at(-1) as LoggedEntry).id,
  }));
  const recipients = [...persons.flatMap((p) => recipientsOf(platform, p.devices)), ...extra];
  const seals = recipients.map((r) => {
    const sealed = sealEpochKey(platform, channelId, prev, r.id, r.receiving, key);
    assert.ok(sealed.ok);
    return sealed.value;
  });
  const entry: EpochEntry = {
    channel: channelId,
    seq: epochs.length,
    prev,
    memberHead: { length: memberCount, last: (members[memberCount - 1] as LoggedMember).id },
    deviceHeads: heads,
    seals,
    commitment: epochCommitment(platform, channelId, prev, key),
    signerPerson: by.person.id,
    signerDevice: by.device.id,
    ...over,
  };
  const bytes = encodeEpochEntry(entry);
  const signature = platform.sign(by.device.sign, bytes);
  assert.ok(signature.ok);
  return { logged: { entry, id: platform.sha256(bytes) }, bytes, signature: signature.value, key };
}

const verdict = (
  members: LoggedMember[],
  persons: Person[],
  epochs: LoggedEpoch[],
  b: { bytes: Bytes; signature: Bytes },
) =>
  checkEpochEntry(
    platform,
    epochs,
    members,
    persons.map((p) => p.devices),
    b.bytes,
    b.signature,
  );
const rule = (
  members: LoggedMember[],
  persons: Person[],
  epochs: LoggedEpoch[],
  b: { bytes: Bytes; signature: Bytes },
): EpochRule | null => {
  const v = verdict(members, persons, epochs, b);
  return v.ok ? null : v.rule;
};

/** Alice with two devices and Bob in one channel, and its first epoch. */
function world() {
  const alice = person();
  const bob = person();
  const second = alice.add();
  const members = channel(alice, [bob]);
  const persons = [alice, bob];
  const first = build(members, persons, [], { person: alice, device: alice.first });
  return { alice, bob, second, members, persons, first };
}

test("a built epoch entry checks, and decodes and encodes back to the same bytes [model]", () => {
  const w = world();
  assert.equal(rule(w.members, w.persons, [], w.first), null);
  const decoded = decodeEpochEntry(w.first.bytes);
  assert.ok(decoded.ok);
  assert.equal(decoded.value.seals.length, w.first.logged.entry.seals.length);
  assert.deepEqual(decoded.value.commitment, w.first.logged.entry.commitment);
  assert.deepEqual(encodeEpochEntry(decoded.value), w.first.bytes);
  assert.equal(w.first.logged.entry.seals.length, 5); // Alice's two devices, Bob's one, two recovery keys
});

test("an epoch with one recipient too many is refused by the relay and by a device [model]", () => {
  const w = world();
  const thief = keyed();
  const entry = build(w.members, w.persons, [], { person: w.alice, device: w.alice.first }, {}, [
    { id: thief.id, receiving: thief.keys.receiving },
  ]);
  assert.equal(rule(w.members, w.persons, [], entry), "recipients");
});

test("R6: the epoch after a removal is not sealed to the removed device [model]", () => {
  const w = world();
  w.alice.remove(w.second);
  const second = build(w.members, w.persons, [w.first.logged], {
    person: w.alice,
    device: w.alice.first,
  });
  assert.equal(rule(w.members, w.persons, [w.first.logged], second), null);
  assert.ok(!second.logged.entry.seals.some((s) => idKey(s.recipient) === idKey(w.second.id)));
  const stale = build(
    w.members,
    w.persons,
    [w.first.logged],
    { person: w.alice, device: w.alice.first },
    {},
    [{ id: w.second.id, receiving: w.second.keys.receiving }],
  );
  assert.equal(rule(w.members, w.persons, [w.first.logged], stale), "recipients");
});

test("section 4, 5.3: every epoch is sealed to the recovery key, so the sheet opens it with no history given [model]", () => {
  const w = world();
  const entry = w.first.logged;
  const aliceRecovery = w.alice.recovery;
  assert.ok(entry.entry.seals.some((s) => idKey(s.recipient) === idKey(aliceRecovery.recoveryId)));
  const opened = openEpochSeal(platform, aliceRecovery.receive, entry, aliceRecovery.recoveryId);
  assert.ok(opened.ok);
  assert.deepEqual(opened.value, w.first.key);
  const without = build(
    w.members,
    w.persons,
    [],
    { person: w.alice, device: w.alice.first },
    {
      seals: entry.entry.seals.filter(
        (s) => idKey(s.recipient) !== idKey(aliceRecovery.recoveryId),
      ),
    },
  );
  assert.equal(rule(w.members, w.persons, [], without), "recipients");
});

test("5.7: a seal that fails its commitment gives no key and stops nobody [model]", () => {
  const w = world();
  const wrong = platform.random(32);
  const bobId = w.bob.first.id;
  const bad = sealEpochKey(
    platform,
    w.first.logged.entry.channel,
    undefined,
    bobId,
    w.bob.first.keys.receiving,
    wrong,
  );
  assert.ok(bad.ok);
  const seals = w.first.logged.entry.seals.map((s) =>
    idKey(s.recipient) === idKey(bobId) ? bad.value : s,
  );
  const entry = build(
    w.members,
    w.persons,
    [],
    { person: w.alice, device: w.alice.first },
    {
      seals,
      commitment: w.first.logged.entry.commitment,
    },
  );
  assert.equal(rule(w.members, w.persons, [], entry), null); // the entry stands: the relay cannot tell
  assert.deepEqual(openEpochSeal(platform, w.bob.first.receive, entry.logged, bobId), {
    ok: false,
    error: "open-failed",
  });
  const mine = openEpochSeal(platform, w.alice.first.receive, entry.logged, w.alice.first.id);
  assert.ok(mine.ok); // the others' seals open
});

test("5.3 step 6: a history seal that does not match the commitment is never taken as the key [model]", () => {
  const w = world();
  const epoch = w.first.logged;
  const make = (maker: Keyed, recipient: Keyed, key: Bytes) =>
    historySeal(epoch, maker, recipient, key);
  const bad = make(w.alice.first, w.second, platform.random(32));
  const open = (s: { bytes: Bytes; signature: Bytes }) =>
    openHistorySeal(platform, w.second.receive, w.alice.devices, s.bytes, s.signature, epoch);
  assert.deepEqual(open(bad), { ok: false, error: "open-failed" });
  const good = open(make(w.alice.first, w.second, w.first.key));
  assert.ok(good.ok);
  assert.deepEqual(good.value, w.first.key);
});

test("section 4, 5.3 step 4, 5.7: a device given an entry that fails a check stops on a fault and does not take it [model]", () => {
  const w = world();
  const thief = keyed();
  const entry = build(w.members, w.persons, [], { person: w.alice, device: w.second }, {}, [
    { id: thief.id, receiving: thief.keys.receiving },
  ]);
  const checked = verdict(w.members, w.persons, [], entry);
  assert.equal(checked.ok, false);
  assert.equal(checked.ok ? undefined : checked.rule, "recipients");
  // nothing is taken: a failed verdict carries no LoggedEpoch, the only thing a seal opens from
  assert.equal("value" in checked, false);
});

test("the recipients of a log are its active devices and its current recovery key, by their ids", () => {
  const w = world();
  const ids = recipientsOf(platform, w.alice.devices).map((r) => idKey(r.id));
  const want = [w.alice.first.id, w.second.id, w.alice.recovery.recoveryId].map(idKey);
  assert.deepEqual([...ids].sort(), want.sort());
});

test("section 4: the commitment is HKDF of the key under its label, the channel and the epoch before", () => {
  const w = world();
  const key = new Uint8Array(32).fill(9);
  const channelId = w.first.logged.entry.channel;
  const prev = new Uint8Array(32).fill(5);
  const label = new Writer().label("commit").b32(channelId).u8(1).b32(prev).bytes();
  assert.deepEqual(epochCommitment(platform, channelId, prev, key), platform.hkdf(key, label, 32));
  const first = new Writer().label("commit").b32(channelId).u8(0).bytes();
  assert.deepEqual(
    epochCommitment(platform, channelId, undefined, key),
    platform.hkdf(key, first, 32),
  );
  assert.notDeepEqual(
    epochCommitment(platform, channelId, undefined, key),
    epochCommitment(platform, channelId, prev, key),
  );
  assert.notDeepEqual(
    epochCommitment(platform, channelId, prev, key),
    epochCommitment(platform, new Uint8Array(32), prev, key),
  );
  assert.throws(() => epochCommitment(platform, channelId, prev, new Uint8Array(31)), RangeError);
});

test("design 6.3: a seal's info is the label, the channel, the epoch before and the recipient", () => {
  const info = epochSealInfo(new Uint8Array(32).fill(1), undefined, new Uint8Array(32).fill(2));
  assert.deepEqual(
    info,
    new Writer()
      .label("epoch-seal")
      .b32(new Uint8Array(32).fill(1))
      .u8(0)
      .b32(new Uint8Array(32).fill(2))
      .bytes(),
  );
});

test("a seal opens only in its own context: the channel, the epoch before and the recipient are bound", () => {
  const w = world();
  const epoch = w.first.logged;
  const mine = w.alice.first;
  assert.ok(openEpochSeal(platform, mine.receive, epoch, mine.id).ok);
  const otherPrev = {
    ...epoch,
    entry: { ...epoch.entry, prev: new Uint8Array(32).fill(1), seq: 1 },
  };
  assert.deepEqual(openEpochSeal(platform, mine.receive, otherPrev, mine.id), {
    ok: false,
    error: "open-failed",
  });
  const otherChannel = { ...epoch, entry: { ...epoch.entry, channel: new Uint8Array(32).fill(1) } };
  assert.deepEqual(openEpochSeal(platform, mine.receive, otherChannel, mine.id), {
    ok: false,
    error: "open-failed",
  });
  // Bob's seal moved under Alice's id: the recipient is in the info, so it does not open
  const bobSeal = epoch.entry.seals.find((s) => idKey(s.recipient) === idKey(w.bob.first.id));
  assert.ok(bobSeal);
  const moved = {
    ...epoch,
    entry: {
      ...epoch.entry,
      seals: epoch.entry.seals.map((s) =>
        idKey(s.recipient) === idKey(mine.id) ? { ...bobSeal, recipient: mine.id } : s,
      ),
    },
  };
  assert.equal(openEpochSeal(platform, w.bob.first.receive, moved, mine.id).ok, false);
  assert.deepEqual(openEpochSeal(platform, mine.receive, epoch, new Uint8Array(32)), {
    ok: false,
    error: "open-failed",
  });
  assert.equal(openEpochSeal(platform, "no.such.key", epoch, mine.id).ok, false);
});

test("crypto 9: every refusal of an opening is open-failed, whatever the platform said", () => {
  const w = world();
  const epoch = w.first.logged;
  const mine = w.alice.first;
  const seal = epoch.entry.seals.find((s) => idKey(s.recipient) === idKey(mine.id));
  assert.ok(seal);
  const offCurve = new Uint8Array(65).fill(1);
  offCurve[0] = 4; // 65 bytes and a leading 4, but no point of the curve
  const bad = { ...epoch, entry: { ...epoch.entry, seals: [{ ...seal, enc: offCurve }] } };
  assert.deepEqual(openEpochSeal(platform, mine.receive, bad, mine.id), {
    ok: false,
    error: "open-failed",
  });
  for (const error of ["bad-input", "no-such-key", "key-exists"] as const) {
    const says = { ...platform, hpkeOpen: () => ({ ok: false as const, error }) };
    assert.deepEqual(openEpochSeal(says, mine.receive, epoch, mine.id), {
      ok: false,
      error: "open-failed",
    });
  }
});

test("a commitment that does not match the key opened gives no key", () => {
  const w = world();
  const epoch = w.first.logged;
  const other = { ...epoch, entry: { ...epoch.entry, commitment: new Uint8Array(32) } };
  assert.deepEqual(openEpochSeal(platform, w.alice.first.receive, other, w.alice.first.id), {
    ok: false,
    error: "open-failed",
  });
});

test("section 4: the signer is an active device of a member at the heads, and the signature verifies first", () => {
  const w = world();
  const by = (p: Person, d: Keyed) => build(w.members, w.persons, [], { person: p, device: d });
  assert.equal(rule(w.members, w.persons, [], by(w.alice, w.second)), null);
  assert.equal(rule(w.members, w.persons, [], by(w.bob, w.bob.first)), null);
  assert.equal(rule(w.members, w.persons, [], by(w.alice, w.bob.first)), "device"); // another person's device
  const stranger = person();
  assert.equal(rule(w.members, w.persons, [], by(stranger, stranger.first)), "device"); // not a member
  const forged = { ...w.first, signature: new Uint8Array(64) };
  assert.equal(rule(w.members, w.persons, [], forged), "signature");
  const short = { ...w.first, signature: new Uint8Array(63) };
  assert.equal(rule(w.members, w.persons, [], short), "signature");
});

test("section 4: a device removed at the heads does not sign an epoch", () => {
  const w = world();
  w.alice.remove(w.second);
  const e = build(w.members, w.persons, [], { person: w.alice, device: w.second });
  assert.equal(rule(w.members, w.persons, [], e), "device");
});

test("section 4: the heads must be the ones the member log and each member's device log hold", () => {
  const w = world();
  const by = { person: w.alice, device: w.alice.first };
  const lastOf = (p: Person) => (p.devices.at(-1) as LoggedEntry).id;
  const heads = (over: object[]) =>
    build(w.members, w.persons, [], by, { deviceHeads: over as EpochEntry["deviceHeads"] });
  const headA = { person: w.alice.id, length: w.alice.devices.length, last: lastOf(w.alice) };
  const headB = { person: w.bob.id, length: w.bob.devices.length, last: lastOf(w.bob) };
  assert.equal(rule(w.members, w.persons, [], heads([headA, headB])), null);
  assert.equal(rule(w.members, w.persons, [], heads([headA])), "heads"); // a member left out
  const stranger = person();
  const headS = { person: stranger.id, length: 1, last: stranger.devices[0]?.id as Bytes };
  assert.equal(rule(w.members, w.persons, [], heads([headA, headB, headS])), "heads"); // one too many
  const instead = build(w.members, [stranger], [], by, {}, [], 1); // a stranger's head in place of the one member
  assert.equal(rule(w.members, [...w.persons, stranger], [], instead), "heads");
  assert.equal(rule(w.members, w.persons, [], heads([{ ...headA, length: 9 }, headB])), "heads");
  assert.equal(
    rule(w.members, w.persons, [], heads([{ ...headA, last: lastOf(w.bob) }, headB])),
    "heads",
  );
  assert.equal(
    rule(
      w.members,
      w.persons,
      [],
      build(w.members, w.persons, [], by, {
        memberHead: { length: 99, last: w.members[0]?.id as Bytes },
      }),
    ),
    "heads",
  );
  assert.equal(
    rule(
      w.members,
      w.persons,
      [],
      build(w.members, w.persons, [], by, {
        memberHead: { length: 1, last: w.members[2]?.id as Bytes },
      }),
    ),
    "heads",
  );
});

test("section 4: the recipients are those of the members at the heads, not at the end of the logs", () => {
  const w = world();
  const by = { person: w.alice, device: w.alice.first };
  const early = build(w.members, [w.alice], [], by, {}, [], 1); // Alice alone: the member log's first entry
  assert.equal(rule(w.members, w.persons, [], early), null);
  assert.equal(early.logged.entry.seals.length, 3);
  const added = w.alice.add(); // a device added after the entry's heads: no recipient, and still valid
  assert.equal(rule(w.members, w.persons, [], early), null);
  assert.ok(added.id);
});

test("section 4: an entry follows the epoch before it, in the channel it names, at its position", () => {
  const w = world();
  const by = { person: w.alice, device: w.alice.first };
  const second = build(w.members, w.persons, [w.first.logged], by);
  assert.equal(rule(w.members, w.persons, [w.first.logged], second), null);
  assert.equal(rule(w.members, w.persons, [], second), "position");
  assert.equal(rule(w.members, w.persons, [w.first.logged, w.first.logged], second), "position");
  const wrongPrev = build(w.members, w.persons, [w.first.logged], by, {
    prev: new Uint8Array(32).fill(1),
  });
  assert.equal(rule(w.members, w.persons, [w.first.logged], wrongPrev), "prev");
  const other = build(w.members, w.persons, [w.first.logged], by, {
    channel: new Uint8Array(32).fill(1),
  });
  assert.equal(rule(w.members, w.persons, [w.first.logged], other), "channel");
  const again = build(w.members, w.persons, [], by, { seq: 0 });
  assert.equal(rule(w.members, w.persons, [w.first.logged], again), "position"); // a second first epoch
});

test("a check given anything but bytes, or a log that is not a log, returns a failure", () => {
  const w = world();
  const call = (...args: unknown[]) =>
    (checkEpochEntry as (...a: unknown[]) => { ok: boolean; rule?: string })(
      platform,
      [],
      w.members,
      w.persons.map((p) => p.devices),
      ...args,
    );
  assert.deepEqual(call(5, w.first.signature), { ok: false, rule: "decode" });
  assert.deepEqual(call(w.first.bytes, 5), { ok: false, rule: "signature" });
  const noLogs = checkEpochEntry(platform, [], w.members, [], w.first.bytes, w.first.signature);
  assert.deepEqual(noLogs, { ok: false, rule: "heads" });
  assert.equal(decodeEpochEntry(5 as unknown as Bytes).ok, false);
  assert.equal(decodeHistorySeal("x" as unknown as Bytes).ok, false);
});

test("the decoder refuses what the encoder never writes", () => {
  const w = world();
  const bytes = w.first.bytes;
  const refuses = (b: Bytes) => assert.equal(decodeEpochEntry(b).ok, false);
  refuses(new Uint8Array([...bytes, 0]));
  refuses(bytes.slice(0, bytes.length - 1));
  const at = (offset: number) => {
    const b = Uint8Array.from(bytes);
    return (value: number) => {
      b[offset] = value;
      return b;
    };
  };
  const label = 1 + "blind-relay/1 epoch-entry".length;
  refuses(at(label + 32 + 8)(2)); // the opt byte of prev
  // seq 0 with a prev, and a later seq without one
  const second = build(w.members, w.persons, [w.first.logged], {
    person: w.alice,
    device: w.alice.first,
  });
  const raw = (e: EpochEntry, patch: (b: Bytes) => void) => {
    const b = Uint8Array.from(encodeEpochEntry(e));
    patch(b);
    return b;
  };
  refuses(
    raw(second.logged.entry, (b) => {
      b[label + 32 + 7] = 0;
    }),
  ); // seq 1 -> 0, prev still there
  const seq0 = w.first.logged.entry;
  refuses(
    raw(seq0, (b) => {
      b[label + 32 + 7] = 1;
    }),
  ); // seq 0 -> 1, no prev
  // a head of length 0
  const lengthAt = label + 32 + 8 + 1; // member head length, first byte after the opt byte (seq 0: no prev bytes)
  refuses(
    raw(seq0, (b) => {
      b.fill(0, lengthAt, lengthAt + 8);
    }),
  );
  // a public key that does not start with 4
  const encAt = bytes.length - 96 - 48 - 65; // the last seal's enc, before its sealed and the three ids
  refuses(
    raw(seq0, (b) => {
      b[encAt] = 2;
    }),
  );
});

test("the decoder refuses seals and heads out of order, an id twice, and an empty set", () => {
  const w = world();
  const decoded = decodeEpochEntry(w.first.bytes);
  assert.ok(decoded.ok);
  const e = decoded.value;
  const written = (heads: EpochEntry["deviceHeads"], seals: EpochEntry["seals"]) => {
    const wr = new Writer().label("epoch-entry").b32(e.channel).u64(0).u8(0);
    wr.u64(e.memberHead.length).b32(e.memberHead.last);
    wr.list(heads, (x, h) => x.b32(h.person).u64(h.length).b32(h.last));
    wr.list(seals, (x, s) => x.b32(s.recipient).pk(s.enc).raw(s.sealed));
    return wr.b32(e.commitment).b32(e.signerPerson).b32(e.signerDevice).bytes();
  };
  assert.ok(decodeEpochEntry(written(e.deviceHeads, e.seals)).ok);
  const reversed = (xs: unknown[]) => [...xs].reverse();
  assert.equal(
    decodeEpochEntry(written(reversed(e.deviceHeads) as EpochEntry["deviceHeads"], e.seals)).ok,
    false,
  );
  assert.equal(
    decodeEpochEntry(written(e.deviceHeads, reversed(e.seals) as EpochEntry["seals"])).ok,
    false,
  );
  const twice = [e.seals[0], e.seals[0]] as EpochEntry["seals"];
  assert.equal(decodeEpochEntry(written(e.deviceHeads, twice)).ok, false);
  assert.equal(decodeEpochEntry(written([], e.seals)).ok, false);
  assert.equal(decodeEpochEntry(written(e.deviceHeads, [])).ok, false);
});

test("the encoder throws on anything the decoder refuses", () => {
  const w = world();
  const e = w.first.logged.entry;
  const seal0 = e.seals[0] as EpochEntry["seals"][number];
  const bad: Partial<EpochEntry>[] = [
    { prev: new Uint8Array(32) }, // seq 0 with a prev
    { seq: 1 }, // a later epoch with none
    { seq: -1 },
    { memberHead: { length: 0, last: e.memberHead.last } },
    { deviceHeads: [] },
    { deviceHeads: [{ ...(e.deviceHeads[0] as EpochEntry["deviceHeads"][number]), length: 0 }] },
    { seals: [] },
    { seals: [{ ...seal0, sealed: new Uint8Array(47) }] },
    { seals: [{ ...seal0, enc: new Uint8Array(65) }] },
    { seals: [seal0, seal0] },
    { commitment: new Uint8Array(31) },
    { signerPerson: "x" as unknown as Bytes },
  ];
  for (const over of bad) assert.throws(() => encodeEpochEntry({ ...e, ...over }), RangeError);
});

test("encoding sorts the seals and heads by id, whatever order they are given in", () => {
  const w = world();
  const e = w.first.logged.entry;
  const shuffled = {
    ...e,
    seals: [...e.seals].reverse(),
    deviceHeads: [...e.deviceHeads].reverse(),
  };
  assert.deepEqual(encodeEpochEntry(shuffled), w.first.bytes);
});

/** A history seal by `maker` of `epoch`'s key to `recipient`. */
function historySeal(
  epoch: LoggedEpoch,
  maker: Keyed,
  recipient: Keyed,
  key: Bytes,
  over: Partial<HistorySeal> = {},
) {
  const sealed = sealEpochKey(
    platform,
    epoch.entry.channel,
    epoch.entry.prev,
    recipient.id,
    recipient.keys.receiving,
    key,
  );
  assert.ok(sealed.ok);
  const seal: HistorySeal = {
    channel: epoch.entry.channel,
    epoch: epoch.id,
    ...sealed.value,
    maker: maker.id,
    ...over,
  };
  const bytes = encodeHistorySeal(seal);
  const signature = platform.sign(maker.sign, bytes);
  assert.ok(signature.ok);
  return { seal, bytes, signature: signature.value };
}

test("a history seal encodes and decodes back to the same bytes, and the encoder refuses a wrong length", () => {
  const w = world();
  const s = historySeal(w.first.logged, w.alice.first, w.second, w.first.key);
  const decoded = decodeHistorySeal(s.bytes);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.value, s.seal);
  assert.deepEqual(encodeHistorySeal(decoded.value), s.bytes);
  assert.equal(decodeHistorySeal(new Uint8Array([...s.bytes, 0])).ok, false);
  assert.equal(decodeHistorySeal(s.bytes.slice(0, 40)).ok, false);
  assert.throws(() => encodeHistorySeal({ ...s.seal, sealed: new Uint8Array(32) }), RangeError);
  assert.throws(() => encodeHistorySeal({ ...s.seal, maker: new Uint8Array(31) }), RangeError);
});

test("5.3 step 6: a history seal is taken only if its maker, a device of the person's log, signed it", () => {
  const w = world();
  const s = historySeal(w.first.logged, w.alice.first, w.second, w.first.key);
  const check = (devices: LoggedEntry[], sig = s.signature, bytes = s.bytes) =>
    checkHistorySeal(platform, devices, bytes, sig);
  assert.ok(check(w.alice.devices).ok);
  assert.deepEqual(check(w.bob.devices), { ok: false, rule: "device" });
  assert.deepEqual(check([]), { ok: false, rule: "device" });
  assert.deepEqual(check(w.alice.devices, new Uint8Array(64)), { ok: false, rule: "signature" });
  assert.deepEqual(check(w.alice.devices, s.signature, new Uint8Array(5)), {
    ok: false,
    rule: "decode",
  });
  const other = historySeal(w.first.logged, w.bob.first, w.second, w.first.key); // made by Bob, shown with Alice's log
  assert.deepEqual(check(w.alice.devices, other.signature, other.bytes), {
    ok: false,
    rule: "device",
  });
  const swapped = historySeal(w.first.logged, w.alice.first, w.second, w.first.key);
  assert.deepEqual(check(w.alice.devices, other.signature, swapped.bytes), {
    ok: false,
    rule: "signature",
  });
  const gone = w.alice.add();
  w.alice.remove(gone);
  const byGone = historySeal(w.first.logged, gone, w.second, w.first.key);
  // a seal its maker signed counts after the maker's removal: the sheet reads history through it (E1)
  assert.ok(check(w.alice.devices, byGone.signature, byGone.bytes).ok);
  // the id of a recovery key is no maker, though its signing key could sign
  const rec = w.alice.recovery;
  const byRecovery = historySeal(w.first.logged, rec, w.second, w.first.key, {
    maker: rec.recoveryId,
  });
  assert.deepEqual(check(w.alice.devices, byRecovery.signature, byRecovery.bytes), {
    ok: false,
    rule: "device",
  });
});

test("crypto 5, 9: a history seal opens only after its signature verifies, and only for its own epoch", () => {
  const w = world();
  const epoch = w.first.logged;
  const s = historySeal(epoch, w.alice.first, w.second, w.first.key);
  const open = (b: { bytes: Bytes; signature: Bytes }, log = epoch, name = w.second.receive) =>
    openHistorySeal(platform, name, w.alice.devices, b.bytes, b.signature, log);
  assert.ok(open(s).ok);
  assert.deepEqual(open({ ...s, signature: new Uint8Array(64) }), {
    ok: false,
    error: "open-failed",
  }); // a valid HPKE seal, an unsigned one
  const next = build(w.members, w.persons, [epoch], {
    person: w.alice,
    device: w.alice.first,
  }).logged;
  assert.deepEqual(open(s, next), { ok: false, error: "open-failed" }); // another epoch's entry
  assert.deepEqual(open(s, epoch, w.bob.first.receive), { ok: false, error: "open-failed" }); // not the recipient
  const other = historySeal(epoch, w.alice.first, w.second, w.first.key, {
    channel: new Uint8Array(32).fill(4),
  });
  assert.deepEqual(open(other), { ok: false, error: "open-failed" });
  assert.deepEqual(open({ bytes: new Uint8Array(3), signature: s.signature }), {
    ok: false,
    error: "open-failed",
  });
});

test("a history seal's epoch field names the epoch's own id", () => {
  const w = world();
  const epoch = w.first.logged;
  const wrong = historySeal(epoch, w.alice.first, w.second, w.first.key, {
    epoch: new Uint8Array(32),
  });
  assert.deepEqual(
    openHistorySeal(
      platform,
      w.second.receive,
      w.alice.devices,
      wrong.bytes,
      wrong.signature,
      epoch,
    ),
    { ok: false, error: "open-failed" },
  );
});

for (const name of ["epoch-entry", "history-seal"]) {
  test(`every case of ${name}.json passes`, () => {
    const file = JSON.parse(
      readFileSync(join(import.meta.dirname, "vectors", `${name}.json`), "utf8"),
    );
    assert.deepEqual(runVectors(platform, file, platform.importKey), []);
  });
}

/** A case of a vector file, for a test to change. */
type Found = { name: string; opens: { sk?: string }[]; output?: string; [field: string]: unknown };

/** The first case of `name` that `pick` accepts, as a copy to change. */
const vector = (name: string, pick: (c: Record<string, unknown>) => boolean) => {
  const file = JSON.parse(
    readFileSync(join(import.meta.dirname, "vectors", `${name}.json`), "utf8"),
  );
  const found = file.cases.find(pick);
  assert.ok(found, `a case of ${name}`);
  return { file, found: structuredClone(found) as Found };
};
const fault = (file: VectorFile, c: object): VectorFile => ({
  ...file,
  cases: [{ ...c, fails: "throws", error: "TypeError" } as VectorFile["cases"][number]],
});

test("a case of epoch-entry.json naming a device log, a member log or a key the file lacks is a fault of the file", () => {
  const { file, found } = vector(
    "epoch-entry",
    (c) => Array.isArray(c.opens) && c.opens.length > 1,
  );
  assert.deepEqual(
    runVectors(platform, fault(file, { ...found, persons: ["Typo"] }), platform.importKey),
    [],
  );
  assert.deepEqual(
    runVectors(platform, fault({ ...file, memberLog: undefined }, found), platform.importKey),
    [],
  );
  const noKey = structuredClone(found);
  (noKey.opens[0] as { sk?: string }).sk = undefined;
  assert.deepEqual(runVectors(platform, fault(file, noKey), platform.importKey), []);
  const noImport = runVectors(platform, { ...file, cases: [found] });
  assert.deepEqual(noImport, [found.name]); // a runner given no import function cannot open a seal
});

test("a case of history-seal.json without its epoch or device log is a fault of the file", () => {
  const { file, found } = vector("history-seal", (c) => c.output !== undefined);
  assert.deepEqual(
    runVectors(platform, fault(file, { ...found, devices: "Typo" }), platform.importKey),
    [],
  );
  assert.deepEqual(
    runVectors(platform, fault(file, { ...found, epoch: undefined }), platform.importKey),
    [],
  );
  assert.deepEqual(
    runVectors(platform, fault(file, { ...found, sk: undefined }), platform.importKey),
    [],
  );
});

test("a wrong expected key in a case is reported by name", () => {
  const { file, found } = vector("history-seal", (c) => c.output !== undefined);
  assert.deepEqual(
    runVectors(
      platform,
      { ...file, cases: [{ ...found, output: "00".repeat(32) }] },
      platform.importKey,
    ),
    [found.name],
  );
});

test("the epoch-commitment case of epoch-entry.json is fixed whole", () => {
  const { file, found } = vector("epoch-entry", (c) => c.op === "epoch-commitment");
  assert.deepEqual(runVectors(platform, file, platform.importKey), []);
  assert.notEqual(found.output, "");
});

test("one parsed file run on two platforms replays its logs on each", () => {
  const file = JSON.parse(
    readFileSync(join(import.meta.dirname, "vectors", "epoch-entry.json"), "utf8"),
  ) as VectorFile;
  const first = file.cases.find((c) => c.op === "epoch-entry" && c.output !== undefined);
  assert.ok(first);
  // on a platform that verifies nothing the file's own logs fail, which is a fault of the file
  const throws = { ...file, cases: [{ ...first, fails: "throws", error: "TypeError" }] };
  assert.deepEqual(runVectors(platform, throws, platform.importKey), [first.name]); // no fault on a sound platform
  const refusing = { ...platform, verify: () => false };
  assert.deepEqual(runVectors(refusing, throws, platform.importKey), []);
});
