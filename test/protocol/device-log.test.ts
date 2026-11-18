/**
 * The device log (design 6.1) on real bytes and real signatures. A test named after one of the
 * model's, with ` [model]` at its end, asserts the model's outcome on bytes (design 9).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import {
  checkDeviceEntry,
  currentRecovery,
  type DeviceEntry,
  type DeviceKeys,
  type DeviceRule,
  decodeDeviceEntry,
  encodeDeviceEntry,
  type LoggedEntry,
  type PublicKeys,
} from "../../src/protocol/device-log.ts";
import { deviceId, recoveryKeyId } from "../../src/protocol/ids.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { runVectors } from "../../src/protocol/vectors.ts";
import { makeProof } from "./proof.ts";

const platform = createNodePlatform();
let counter = 0;

/** A party with keys the platform holds: its public keys, its id as a device or as a recovery key. */
function party(kind: "app" | "bot" = "app") {
  const n = counter++;
  const signing = platform.makeKeyPair(`log.${n}.s`, "sign");
  const receiving = platform.makeKeyPair(`log.${n}.r`, "receive");
  assert.ok(signing.ok && receiving.ok);
  const keys: PublicKeys = { signing: signing.value, receiving: receiving.value };
  return {
    name: `log.${n}.s`,
    keys,
    device: { kind, ...keys } as DeviceKeys,
    id: deviceId(platform, keys.signing, keys.receiving),
    recoveryId: recoveryKeyId(platform, keys.signing, keys.receiving),
  };
}
type Party = ReturnType<typeof party>;

/** `by`'s signature over the possession bytes of `device` for `person`: the proof of a new device, made once. */
function prove(person: Bytes | undefined, device: Party, by: Party = device, as = device.device) {
  return makeProof(platform, by.name, person as Bytes, as);
}

/** An entry signed by `by`, as the pair of bytes and signature a device receives. */
function signed(by: Party, entry: DeviceEntry): { bytes: Bytes; signature: Bytes } {
  const bytes = encodeDeviceEntry(entry);
  const signature = platform.sign(by.name, bytes);
  assert.ok(signature.ok);
  return { bytes, signature: signature.value };
}

/** A log being built: the app starts it, and each step is checked as a device would check it. */
class Log {
  entries: LoggedEntry[] = [];
  app = party();
  recovery = party();
  constructor() {
    this.push(this.app, {
      seq: 0,
      kind: "genesis",
      device: this.app.device,
      recovery: this.recovery.keys,
      signer: this.app.id,
    });
  }
  push(by: Party, entry: DeviceEntry) {
    const { bytes, signature } = signed(by, entry);
    const verdict = checkDeviceEntry(platform, this.entries, bytes, signature);
    assert.ok(verdict.ok, `a step of the log fails: ${verdict.ok ? "" : verdict.rule}`);
    this.entries.push(verdict.value);
  }
  /** The head every later entry carries. */
  head() {
    return { person: this.entries[0]?.id, seq: this.entries.length, prev: this.entries.at(-1)?.id };
  }
  /** An add of `device` by `signer`, with the proof the new device makes for this log's person. */
  addOf(device: Party, signer: Party = this.app): Extract<DeviceEntry, { kind: "add" }> {
    const head = this.head();
    const proof = prove(head.person, device);
    return { ...head, kind: "add", device: device.device, proof, signer: signer.id };
  }
  add(by: Party, device: Party) {
    this.push(by, this.addOf(device, by));
  }
  remove(by: Party, device: Party) {
    this.push(by, { ...this.head(), kind: "remove", device: device.id, signer: by.id });
  }
  /** The verdict on an entry, with no change to the log. */
  rule(by: Party, entry: DeviceEntry): DeviceRule | null {
    const { bytes, signature } = signed(by, entry);
    const verdict = checkDeviceEntry(platform, this.entries, bytes, signature);
    return verdict.ok ? null : verdict.rule;
  }
  reset(set: Party[], more: Partial<{ newDevice: Party; recovery: PublicKeys }> = {}): DeviceEntry {
    return {
      ...this.head(),
      kind: "reset",
      set: set.map((p) => p.id),
      newDevice: more.newDevice && {
        device: more.newDevice.device,
        proof: prove(this.head().person, more.newDevice),
      },
      recovery: more.recovery,
      signer: this.recovery.recoveryId,
    };
  }
}

/** A log after one device joined and was removed, as the model's `afterRemoval`. */
function afterRemoval() {
  const log = new Log();
  const gone = party();
  log.add(log.app, gone);
  log.remove(log.app, gone);
  return { log, gone };
}

test("a reset cannot make a removed device active again [model]", () => {
  const { log, gone } = afterRemoval();
  const fresh = party();
  assert.equal(log.rule(log.recovery, log.reset([fresh, gone], { newDevice: fresh })), "set");
});

test("a device, even an active one in a thief's hands, cannot write a reset [model]", () => {
  const log = new Log();
  const stolen = party();
  log.add(log.app, stolen);
  const reset: DeviceEntry = { ...log.reset([stolen], { newDevice: stolen }), signer: stolen.id };
  assert.equal(log.rule(stolen, reset), "authority");
});

test('never allowed 9: an "add device" cannot make a removed device active again [model]', () => {
  const { log, gone } = afterRemoval();
  const add: DeviceEntry = log.addOf(gone);
  assert.equal(log.rule(log.app, add), "authority");
});

test("never allowed 9: a reset whose new device is a removed device is refused [model]", () => {
  const { log, gone } = afterRemoval();
  assert.equal(log.rule(log.recovery, log.reset([gone], { newDevice: gone })), "set");
});

test("section 4: entries signed by a removed device, or placed after the wrong entry, fail the checks [model]", () => {
  const { log, gone } = afterRemoval();
  const fresh = party();
  const add: DeviceEntry = log.addOf(fresh, gone);
  assert.equal(log.rule(gone, add), "authority");
  const remove: DeviceEntry = {
    ...log.head(),
    kind: "remove",
    device: log.app.id,
    signer: gone.id,
  };
  assert.equal(log.rule(gone, remove), "authority");
  const wrongPrev: DeviceEntry = { ...log.addOf(fresh), prev: log.entries[1]?.id };
  assert.equal(log.rule(log.app, wrongPrev), "prev");
});

test("section 4: a reset with an empty set, or one that leaves out the new device it names, is refused [model]", () => {
  const log = new Log();
  const fresh = party();
  assert.equal(log.rule(log.recovery, log.reset([], { newDevice: fresh })), "set");
  assert.equal(log.rule(log.recovery, log.reset([])), "set");
  assert.equal(log.rule(log.recovery, log.reset([log.app])), null);
  assert.equal(log.rule(log.recovery, log.reset([log.app], { newDevice: fresh })), "set");
});

test("section 4, 5.6 condition 2: a recovery key is never a device and never a sender [model] (the device half)", () => {
  const log = new Log();
  const key = log.recovery;
  const add: DeviceEntry = log.addOf(key);
  assert.equal(log.rule(log.app, add), "key named");
  assert.equal(log.rule(log.recovery, log.reset([key], { newDevice: key })), "key named");
  const fresh = party();
  assert.equal(
    log.rule(log.recovery, log.reset([fresh], { newDevice: fresh, recovery: fresh.keys })),
    "key named",
  );
  assert.equal(
    log.rule(log.recovery, log.reset([fresh], { newDevice: fresh, recovery: log.app.keys })),
    "key named",
  );
});

test("section 4: no entry names one id as a device and as a recovery key, a removed device and entry 0 included [model]", () => {
  const app = party();
  const genesis: DeviceEntry = {
    seq: 0,
    kind: "genesis",
    device: app.device,
    recovery: app.keys,
    signer: app.id,
  };
  const { bytes, signature } = signed(app, genesis);
  assert.deepEqual(checkDeviceEntry(platform, [], bytes, signature), {
    ok: false,
    rule: "genesis",
  });
  const { log: later, gone } = afterRemoval();
  const fresh = party();
  assert.equal(
    later.rule(later.recovery, later.reset([fresh], { newDevice: fresh, recovery: gone.keys })),
    "key named",
  );
});

test("a signature verifies before any rule: a bad one is named first, whatever else is wrong", () => {
  const log = new Log();
  const fresh = party();
  const entry: DeviceEntry = { ...log.addOf(fresh), seq: 9 };
  const { bytes, signature } = signed(log.app, entry);
  const bad = Uint8Array.from(signature);
  bad[7] = (bad[7] as number) ^ 1;
  assert.deepEqual(checkDeviceEntry(platform, log.entries, bytes, bad), {
    ok: false,
    rule: "signature",
  });
  assert.deepEqual(checkDeviceEntry(platform, log.entries, bytes, signature.slice(1)), {
    ok: false,
    rule: "signature",
  });
  assert.deepEqual(checkDeviceEntry(platform, log.entries, bytes, signature), {
    ok: false,
    rule: "position",
  });
});

test("an entry whose position or person is wrong is refused", () => {
  const log = new Log();
  const fresh = party();
  const add: DeviceEntry = log.addOf(fresh);
  assert.equal(log.rule(log.app, { ...add, seq: 2 }), "position");
  const other = log.entries[0]?.id.map((b) => b ^ 1) as Bytes;
  assert.equal(log.rule(log.app, { ...add, person: other, proof: prove(other, fresh) }), "person");
  assert.equal(log.rule(log.app, add), null);
});

test("an entry encodes and decodes to the same value, and decoding copies its input", () => {
  const log = new Log();
  const fresh = party("bot");
  const entry = log.reset([log.app, fresh], { newDevice: fresh, recovery: fresh.keys });
  const bytes = encodeDeviceEntry(entry);
  const decoded = decodeDeviceEntry(bytes);
  assert.ok(decoded.ok);
  assert.deepEqual(encodeDeviceEntry(decoded.value), bytes);
  assert.equal(decoded.value.kind, "reset");
  bytes.fill(0);
  assert.notDeepEqual(encodeDeviceEntry(decoded.value), bytes);
});

test("a decoder returns a failure for bytes that are not an entry, and a wrong type is a fault", () => {
  assert.deepEqual(decodeDeviceEntry(new Uint8Array(0)), { ok: false, error: "bad-input" });
  const log = new Log();
  const { bytes, signature } = signed(log.app, log.entries[0]?.entry as DeviceEntry);
  assert.deepEqual(checkDeviceEntry(platform, [], bytes.slice(0, 40), signature), {
    ok: false,
    rule: "decode",
  });
  const notBytes = "no" as unknown as Bytes;
  assert.deepEqual(checkDeviceEntry(platform, [], bytes, notBytes), {
    ok: false,
    rule: "signature",
  });
  assert.deepEqual(checkDeviceEntry(platform, [], notBytes, signature), {
    ok: false,
    rule: "decode",
  });
});

test("an entry's id is the hash of its signed bytes, with no signature in it", () => {
  const log = new Log();
  const { bytes } = signed(log.app, log.entries[0]?.entry as DeviceEntry);
  assert.deepEqual(log.entries[0]?.id, platform.sha256(bytes));
});

test("the encoder refuses what the decoder would: a bad device kind, a bad shape of entry 0 or of a later entry", () => {
  const log = new Log();
  const genesis = log.entries[0]?.entry as DeviceEntry;
  const wrongKind = { ...log.app.device, kind: "other" } as unknown as DeviceKeys;
  assert.throws(
    () => encodeDeviceEntry({ ...genesis, device: wrongKind } as DeviceEntry),
    RangeError,
  );
  const id = log.entries[0]?.id as Bytes;
  assert.throws(() => encodeDeviceEntry({ ...genesis, seq: 1 } as DeviceEntry), RangeError);
  assert.throws(() => encodeDeviceEntry({ ...genesis, prev: id } as DeviceEntry), RangeError);
  assert.throws(() => encodeDeviceEntry({ ...genesis, person: id } as DeviceEntry), RangeError);
  const add = log.addOf(log.app);
  assert.throws(() => encodeDeviceEntry({ ...add, seq: 0 }), RangeError);
  assert.throws(() => encodeDeviceEntry({ ...add, person: undefined }), RangeError);
  assert.throws(() => encodeDeviceEntry({ ...add, prev: undefined }), RangeError);
});

test("a vector case with a missing device kind or an unknown entry kind fails, not passes", () => {
  const file = JSON.parse(
    readFileSync(join(import.meta.dirname, "vectors", "device-entry.json"), "utf8"),
  );
  const withInputs = file.cases.find(
    (c: { inputs?: { kind: string } }) => c.inputs?.kind === "add",
  );
  const noKind = structuredClone(withInputs);
  noKind.inputs.device.kind = undefined;
  const unknown = structuredClone(withInputs);
  unknown.inputs.kind = "reset ";
  assert.deepEqual(runVectors(platform, { ...file, cases: [noKind, unknown] }), [
    noKind.name,
    unknown.name,
  ]);
  // Failing is not enough: each must be a fault of the file, the `TypeError` path.
  const faults = [noKind, unknown].map((c) => ({ ...c, fails: "throws", error: "TypeError" }));
  assert.deepEqual(runVectors(platform, { ...file, cases: faults }), []);
});

/** A device made of one party's signing key and another's receiving key. */
const mixed = (signing: Party, receiving: Party, kind: "app" | "bot" = "app") => {
  const keys: PublicKeys = { signing: signing.keys.signing, receiving: receiving.keys.receiving };
  return {
    ...party(),
    name: signing.name, // the signing half is held by `signing`, so the proof of this device can be made
    keys,
    device: { kind, ...keys } as DeviceKeys,
    id: deviceId(platform, keys.signing, keys.receiving),
  };
};
const addOf = (log: Log, d: Party): DeviceEntry => log.addOf(d);

test("section 4: a removed device's key comes back with another key, in an add and in a reset's new device", () => {
  const { log, gone } = afterRemoval();
  const back = mixed(gone, party());
  assert.equal(log.rule(log.app, addOf(log, back)), "key named");
  assert.equal(log.rule(log.recovery, log.reset([back], { newDevice: back })), "key named");
  const other = mixed(party(), gone);
  assert.equal(log.rule(log.app, addOf(log, other)), "key named");
});

test("section 4: a reset whose new device is a device the log holds is refused, of another kind too", () => {
  const log = new Log();
  const held = { ...log.app, device: { ...log.app.device, kind: "bot" as const } };
  assert.equal(log.rule(log.recovery, log.reset([log.app], { newDevice: log.app })), "key named");
  assert.equal(log.rule(log.recovery, log.reset([held], { newDevice: held })), "key named");
});

test("section 4: a device whose signing key equals its receiving key is refused in genesis, add and reset", () => {
  const log = new Log();
  const p = party();
  const same = {
    ...p,
    device: { kind: "app", signing: p.keys.signing, receiving: p.keys.signing } as DeviceKeys,
    id: deviceId(platform, p.keys.signing, p.keys.signing),
  };
  assert.equal(log.rule(log.app, addOf(log, same)), "key named");
  assert.equal(log.rule(log.recovery, log.reset([same], { newDevice: same })), "key named");
  const genesis: DeviceEntry = {
    seq: 0,
    kind: "genesis",
    device: same.device,
    recovery: party().keys,
    signer: same.id,
  };
  const { bytes, signature } = signed(p, genesis);
  assert.deepEqual(checkDeviceEntry(platform, [], bytes, signature), {
    ok: false,
    rule: "genesis",
  });
});

test("section 4: a recovery key whose two keys are equal is refused, in genesis and in a reset", () => {
  const log = new Log();
  const fresh = party();
  const flat: PublicKeys = { signing: fresh.keys.signing, receiving: fresh.keys.signing };
  assert.equal(log.rule(log.recovery, log.reset([log.app], { recovery: flat })), "key named");
  const app = party();
  const genesis: DeviceEntry = {
    seq: 0,
    kind: "genesis",
    device: app.device,
    recovery: flat,
    signer: app.id,
  };
  const { bytes, signature } = signed(app, genesis);
  assert.deepEqual(checkDeviceEntry(platform, [], bytes, signature), {
    ok: false,
    rule: "genesis",
  });
});

test("section 4: a new recovery key may not reuse any key named before, a removed device's included", () => {
  const { log, gone } = afterRemoval();
  for (const old of [log.recovery, log.app, gone]) {
    assert.equal(log.rule(log.recovery, log.reset([log.app], { recovery: old.keys })), "key named");
    const half = mixed(old, party()).keys;
    assert.equal(log.rule(log.recovery, log.reset([log.app], { recovery: half })), "key named");
  }
  assert.equal(log.rule(log.recovery, log.reset([log.app], { recovery: party().keys })), null);
});

/**
 * The bytes of `entry` with its 64 proof bytes cut out, as an entry written with no proof would
 * read. After the proof come the signer (32) and, in a reset, the recovery `opt` flag (1, absent here).
 */
function withoutProof(entry: DeviceEntry): Bytes {
  assert.ok(entry.kind === "add" || (entry.kind === "reset" && !entry.recovery));
  const bytes = encodeDeviceEntry(entry);
  const at = bytes.length - (entry.kind === "reset" ? 1 : 0) - 32 - 64;
  return Uint8Array.from([...bytes.slice(0, at), ...bytes.slice(at + 64)]);
}

test("section 4, proof of possession: an add whose proof is missing, made by another key, or over the other kind is refused [model]", () => {
  const log = new Log();
  const fresh = party("bot");
  const base = log.addOf(fresh);
  // Missing: the bytes do not decode, and the encoder will not write an add without 64 proof bytes.
  const none = withoutProof(base);
  assert.deepEqual(decodeDeviceEntry(none), { ok: false, error: "bad-input" });
  const sig = platform.sign(log.app.name, none);
  assert.ok(sig.ok);
  assert.deepEqual(checkDeviceEntry(platform, log.entries, none, sig.value), {
    ok: false,
    rule: "decode",
  });
  assert.throws(() => encodeDeviceEntry({ ...base, proof: new Uint8Array(0) }), RangeError);
  const byApprover = prove(log.head().person, fresh, log.app);
  const byOther = prove(log.head().person, fresh, party());
  const otherKind = prove(log.head().person, fresh, fresh, { ...fresh.device, kind: "app" });
  for (const proof of [byApprover, byOther, otherKind])
    assert.equal(log.rule(log.app, { ...base, proof }), "proof");
  assert.equal(log.rule(log.app, base), null);
  // One proof per entry: the same entry is the same bytes on every send.
  assert.deepEqual(encodeDeviceEntry(base), encodeDeviceEntry({ ...base }));
});

test("section 4, proof of possession: a device of one person, its proof copied, cannot be named in another person's log, under either kind [model]", () => {
  const alice = new Log();
  const bot = party("bot");
  alice.add(alice.app, bot);
  const botAdd = alice.entries[1]?.entry as Extract<DeviceEntry, { kind: "add" }>;
  const mallory = new Log();
  for (const kind of ["bot", "app"] as const) {
    const copied: DeviceEntry = {
      ...mallory.addOf(bot, mallory.app),
      device: { ...bot.device, kind },
      proof: botAdd.proof,
    };
    assert.equal(mallory.rule(mallory.app, copied), "proof");
    // Her own proof, made with her own key, is refused too: the key is not hers.
    const hers = { ...copied, proof: prove(mallory.head().person, party(), party(), bot.device) };
    assert.equal(mallory.rule(mallory.app, hers), "proof");
  }
  // Her own new device, with its own proof, she names.
  assert.equal(mallory.rule(mallory.app, mallory.addOf(party("bot"), mallory.app)), null);
});

test("section 4, proof of possession: a reset that names a new device needs that device's proof; the recovery key's signature is not one [model]", () => {
  const log = new Log();
  const fresh = party();
  const base = log.reset([fresh], { newDevice: fresh }) as Extract<DeviceEntry, { kind: "reset" }>;
  assert.equal(log.rule(log.recovery, base), null);
  const none = withoutProof(base);
  const sig = platform.sign(log.recovery.name, none);
  assert.ok(sig.ok);
  assert.deepEqual(checkDeviceEntry(platform, log.entries, none, sig.value), {
    ok: false,
    rule: "decode",
  });
  const person = log.head().person;
  for (const proof of [
    prove(person, fresh, log.recovery),
    prove(person, fresh, fresh, { ...fresh.device, kind: "bot" }),
    prove(person, fresh, party()),
  ])
    assert.equal(
      log.rule(log.recovery, { ...base, newDevice: { device: fresh.device, proof } }),
      "proof",
    );
});

test("section 4, every key named once: a reset names no active device as new, even with the proof its add carried, and no recovery key again [model]", () => {
  const log = new Log();
  const bot = party("bot");
  log.add(log.app, bot);
  const botAdd = log.entries[1]?.entry as Extract<DeviceEntry, { kind: "add" }>;
  // The add's proof is valid for this person and this device, so the rule that refuses is `key named`.
  const replayed = {
    ...log.reset([bot], { newDevice: bot }),
    newDevice: { device: bot.device, proof: botAdd.proof },
  };
  assert.equal(log.rule(log.recovery, replayed), "key named");
  const fresh = party();
  assert.equal(
    log.rule(log.recovery, log.reset([fresh], { newDevice: fresh, recovery: log.recovery.keys })),
    "key named",
  );
});

test("the proof is checked after the entry's signature and before the position, prev, person and key rules", () => {
  const log = new Log();
  const fresh = party();
  const bad = { ...log.addOf(fresh), proof: prove(log.head().person, fresh, party()) };
  const elsewhere = log.entries[0]?.id.map((b) => b ^ 1) as Bytes;
  assert.equal(log.rule(log.app, { ...bad, seq: 9 }), "proof");
  assert.equal(log.rule(log.app, { ...bad, prev: elsewhere }), "proof");
  assert.equal(log.rule(log.app, { ...bad, person: elsewhere }), "proof");
  assert.equal(log.rule(log.app, { ...bad, device: log.app.device }), "proof");
  const { bytes, signature } = signed(log.app, bad);
  const flipped = Uint8Array.from(signature);
  flipped[3] = (flipped[3] as number) ^ 1;
  assert.deepEqual(checkDeviceEntry(platform, log.entries, bytes, flipped), {
    ok: false,
    rule: "signature",
  });
});

test("an add's id covers its proof, and a reset's new device carries one too", () => {
  const log = new Log();
  const fresh = party();
  const add = log.addOf(fresh);
  const { bytes, signature } = signed(log.app, add);
  const verdict = checkDeviceEntry(platform, log.entries, bytes, signature);
  assert.ok(verdict.ok);
  assert.deepEqual(verdict.value.id, platform.sha256(bytes));
  const other = Uint8Array.from(add.proof);
  other[0] = (other[0] as number) ^ 1;
  assert.notDeepEqual(
    platform.sha256(encodeDeviceEntry({ ...add, proof: other })),
    verdict.value.id,
  );
  const reset = log.reset([fresh], { newDevice: fresh });
  const decoded = decodeDeviceEntry(encodeDeviceEntry(reset));
  assert.ok(decoded.ok && decoded.value.kind === "reset");
  assert.deepEqual(decoded.value.newDevice, (reset as { newDevice?: unknown }).newDevice);
});

test("the current recovery key is the last one a genesis or a reset named", () => {
  const log = new Log();
  assert.equal(currentRecovery(platform, []), undefined);
  assert.deepEqual(currentRecovery(platform, log.entries), log.recovery.keys);
  const fresh = party();
  const next = party();
  log.push(log.recovery, log.reset([fresh], { newDevice: fresh, recovery: next.keys }));
  assert.deepEqual(currentRecovery(platform, log.entries), next.keys);
  log.push(next, { ...log.reset([fresh]), signer: next.recoveryId });
  assert.deepEqual(currentRecovery(platform, log.entries), next.keys);
});
