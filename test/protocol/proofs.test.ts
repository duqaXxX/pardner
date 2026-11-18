/**
 * The proofs, the relay's head and the running hash (design 6.6, security design 5.10) on real
 * bytes and signatures. A test named after one of the model's ends with ` [model]`; the others hold
 * a sentence of 5.10 or a row of 6.6.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import { deviceId, recoveryKeyId, relayKeyId, signedId } from "../../src/protocol/ids.ts";
import { labelBytes } from "../../src/protocol/labels.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import {
  chainLink,
  checkHead,
  checkProof,
  decodeHead,
  decodeProof,
  type Expect,
  encodeHead,
  encodeProof,
  type Proof,
  type RelayHead,
  runningHash,
} from "../../src/protocol/proofs.ts";
import { runVectors } from "../../src/protocol/vectors.ts";

const platform = createNodePlatform();
const fill = (n: number, length = 32): Bytes => new Uint8Array(length).fill(n);
const join2 = (...parts: Bytes[]): Bytes => new Uint8Array(Buffer.concat(parts));
const u64 = (n: number): Bytes => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

/** A key made here, by name: its public half and a way to sign with it. */
function keyOf(name: string) {
  const made = platform.makeKeyPair(name, "sign");
  assert.ok(made.ok);
  return { name, pub: made.value };
}
const relayKey = keyOf("relay");
const device = keyOf("device");
const recovery = keyOf("recovery");
const stranger = keyOf("stranger");
const receiving = Uint8Array.of(4, ...fill(9, 64));

const relayId = relayKeyId(platform, relayKey.pub);
const session = { relay: relayId, deviceNonce: fill(2), relayNonce: fill(3), binding: fill(4) };
const expect: Expect = { relayPublic: relayKey.pub, relayNonce: fill(3), binding: fill(4) };
const deviceKeys = { kind: "app" as const, signing: device.pub, receiving };
const head: RelayHead = { relay: relayId, n: 5, chain: fill(7) };
const dev = { signing: device.pub, receiving };
const rec = { signing: recovery.pub, receiving };
const str = { signing: stranger.pub, receiving };
const deviceName = deviceId(platform, device.pub, receiving);
const recoveryName = recoveryKeyId(platform, recovery.pub, receiving);
const active: Proof = { ...session, kind: "active", person: fill(5), device: deviceName };
const recoveryProof: Proof = {
  ...session,
  kind: "recovery",
  person: fill(5),
  recovery: recoveryName,
  newDevice: deviceKeys,
};
const upload: Proof = { ...session, kind: "upload", device: deviceKeys, head };

const sign = (k: { name: string }, bytes: Bytes): Bytes => {
  const made = platform.sign(k.name, bytes);
  assert.ok(made.ok);
  return made.value;
};
const headSig = sign(relayKey, encodeHead(head));
const rule = (v: { ok: boolean; rule?: string }) => (v.ok ? "ok" : v.rule);

test("an active proof is its label, then six fields of 32 bytes (6.6)", () => {
  const want = join2(
    labelBytes("proof-active"),
    session.relay,
    session.deviceNonce,
    session.relayNonce,
    session.binding,
    fill(5),
    deviceName,
  );
  assert.deepEqual(encodeProof(active), want);
  assert.deepEqual(decodeProof(want, "active"), { ok: true, value: active });
});

test("a recovery proof names the person, the recovery key's id and the new device as D", () => {
  const want = join2(
    labelBytes("proof-recovery"),
    session.relay,
    session.deviceNonce,
    session.relayNonce,
    session.binding,
    fill(5),
    recoveryName,
    Uint8Array.of(1),
    device.pub,
    receiving,
  );
  assert.deepEqual(encodeProof(recoveryProof), want);
  assert.deepEqual(decodeProof(want, "recovery"), { ok: true, value: recoveryProof });
});

test("an upload proof carries the device as D and the relay's head after it", () => {
  const want = join2(
    labelBytes("proof-upload"),
    session.relay,
    session.deviceNonce,
    session.relayNonce,
    session.binding,
    Uint8Array.of(1),
    device.pub,
    receiving,
    labelBytes("relay-head"),
    relayId,
    u64(5),
    fill(7),
  );
  assert.deepEqual(encodeProof(upload), want);
  assert.deepEqual(decodeProof(want, "upload"), { ok: true, value: upload });
});

test("a proof decodes under its own kind alone, and refuses damage", () => {
  for (const [p, other] of [
    [active, "recovery"],
    [recoveryProof, "upload"],
    [upload, "active"],
  ] as const) {
    const bytes = encodeProof(p);
    assert.equal(decodeProof(bytes, p.kind).ok, true);
    assert.equal(decodeProof(bytes, other).ok, false, "another kind's label");
    assert.equal(decodeProof(join2(bytes, Uint8Array.of(0)), p.kind).ok, false, "a byte left over");
    assert.equal(decodeProof(bytes.slice(0, -1), p.kind).ok, false, "a byte missing");
  }
  const tooBig = Buffer.from(encodeHead(head));
  tooBig.writeBigUInt64BE(2n ** 53n, tooBig.length - 40);
  assert.equal(decodeHead(tooBig).ok, false, "a u64 past 2^53 - 1");
});

test("a field of the wrong length or a device of an unknown kind does not encode", () => {
  assert.throws(() => encodeProof({ ...active, binding: fill(4, 31) } as Proof), RangeError);
  assert.throws(() => encodeProof({ ...active, relayNonce: fill(3, 33) } as Proof), RangeError);
  assert.throws(
    () => encodeProof({ ...upload, device: { ...deviceKeys, kind: "x" } } as unknown as Proof),
    RangeError,
  );
  assert.throws(() => encodeHead({ ...head, n: 2 ** 53 }), RangeError);
});

test("an active proof verifies under the device's signing key, bound to the relay's nonce and the TLS binding", () => {
  const sig = sign(device, encodeProof(active));
  assert.equal(rule(checkProof(platform, active, [sig], expect, dev)), "ok");
  assert.equal(rule(checkProof(platform, active, [sig], expect, str)), "signer");
  assert.equal(rule(checkProof(platform, active, [sig], expect, undefined)), "signer");
  assert.equal(rule(checkProof(platform, active, [], expect, dev)), "signature");
  assert.equal(rule(checkProof(platform, active, [sig, sig], expect, dev)), "signature");
});

test("a proof made for another connection is refused: the binding, the relay's nonce and the relay's id each bind it", () => {
  const sig = sign(device, encodeProof(active));
  const other = (e: Partial<Expect>) =>
    checkProof(platform, active, [sig], { ...expect, ...e }, dev);
  assert.equal(rule(other({ binding: fill(5) })), "session");
  assert.equal(rule(other({ relayNonce: fill(5) })), "session");
  assert.equal(rule(other({ relayPublic: stranger.pub })), "session");
  const named = { ...active, relay: fill(1) };
  assert.equal(
    rule(checkProof(platform, named, [sign(device, encodeProof(named))], expect, dev)),
    "session",
  );
});

test("the recovery proof needs the recovery key's signature, then the new device's, over the same bytes", () => {
  const bytes = encodeProof(recoveryProof);
  const both = [sign(recovery, bytes), sign(device, bytes)];
  assert.equal(rule(checkProof(platform, recoveryProof, both, expect, rec)), "ok");
  assert.equal(
    rule(checkProof(platform, recoveryProof, [both[1], both[0]] as Bytes[], expect, rec)),
    "signature",
    "swapped",
  );
  assert.equal(
    rule(checkProof(platform, recoveryProof, [both[0], both[0]] as Bytes[], expect, rec)),
    "signature",
    "the recovery key alone",
  );
  assert.equal(
    rule(checkProof(platform, recoveryProof, [both[1], both[1]] as Bytes[], expect, rec)),
    "signature",
    "the new device alone",
  );
  assert.equal(
    rule(checkProof(platform, recoveryProof, [both[0] as Bytes], expect, rec)),
    "signature",
    "one signature",
  );
  assert.equal(
    rule(checkProof(platform, recoveryProof, both, expect, str)),
    "signer",
    "not the current recovery key",
  );
});

test("the proof of an upload needs the relay's own signature over its head", () => {
  const mine = sign(device, encodeProof(upload));
  assert.equal(rule(checkProof(platform, upload, [mine, headSig], expect)), "ok");
  assert.equal(
    rule(checkProof(platform, upload, [sign(stranger, encodeProof(upload)), headSig], expect)),
    "signature",
    "a device's signature by another key",
  );
  const other = { ...upload, head: { ...head, relay: fill(1) } };
  const sigs = [sign(device, encodeProof(other)), sign(relayKey, encodeHead(other.head))];
  assert.equal(rule(checkProof(platform, other, sigs, expect)), "head", "a head of another relay");
});

test("a signature of one proof is no signature of another: each kind has its own label", () => {
  const sig = sign(device, encodeProof(active));
  const twin: Proof = { ...upload, ...session };
  assert.equal(rule(checkProof(platform, twin, [sig, headSig], expect)), "signature");
});

test("a head is its label, the relay's id, n and the running hash, signed by the relay key", () => {
  const want = join2(labelBytes("relay-head"), relayId, u64(5), fill(7));
  assert.deepEqual(encodeHead(head), want);
  assert.deepEqual(decodeHead(want), { ok: true, value: head });
  assert.equal(decodeHead(join2(want, Uint8Array.of(0))).ok, false);
  const made = { value: headSig };
  assert.equal(checkHead(platform, relayKey.pub, head, made.value), true);
  assert.equal(
    checkHead(platform, relayKey.pub, { ...head, n: 4 }, made.value),
    false,
    "another length",
  );
  assert.equal(
    checkHead(platform, relayKey.pub, { ...head, chain: fill(8) }, made.value),
    false,
    "another running hash",
  );
  const foreign = { ...head, relay: fill(1) };
  assert.equal(
    checkHead(platform, relayKey.pub, foreign, sign(relayKey, encodeHead(foreign))),
    false,
    "another relay's id",
  );
  assert.equal(checkHead(platform, stranger.pub, head, made.value), false, "a stranger's key");
});

test("the running hash starts at 32 zero bytes, and each link hashes its label, the one before and the item's id", () => {
  const first = platform.sha256(join2(labelBytes("relay-chain"), new Uint8Array(32), fill(1)));
  assert.deepEqual(runningHash(platform, []), new Uint8Array(32));
  assert.deepEqual(chainLink(platform, new Uint8Array(32), fill(1)), first);
  assert.deepEqual(runningHash(platform, [fill(1)]), first);
  const second = platform.sha256(join2(labelBytes("relay-chain"), first, fill(2)));
  assert.deepEqual(runningHash(platform, [fill(1), fill(2)]), second);
  assert.notDeepEqual(runningHash(platform, [fill(2), fill(1)]), second, "the order counts");
  assert.throws(() => chainLink(platform, fill(1, 31), fill(2)), RangeError);
});

test("fail closed, SD 8: a head under a key of a stranger's own is refused, and stops nothing [model]", () => {
  const forged = sign(stranger, encodeHead(head));
  assert.equal(checkHead(platform, relayKey.pub, head, forged), false);
  const mine = sign(device, encodeProof(upload));
  // "stops nothing": the refusal is a verdict, and the same proof with the relay's own head still passes
  assert.equal(rule(checkProof(platform, upload, [mine, forged], expect)), "head");
  assert.equal(rule(checkProof(platform, upload, [mine, headSig], expect)), "ok");
});

// The relay half of this model test (the relay takes nothing from a record given back and checks the
// items against the head) lives with the relay; the package holds the head and the running hash it uses.
test("5.10: a device gives back only the relay's own signed past, and the relay takes nothing from it: an item added, another running hash or a head it did not sign is refused; a genuine record is accepted and changes nothing [model]", () => {
  const items = [1, 2, 3, 4, 5].map((n) => fill(n, 40));
  const chainOf = (given: Bytes[]) =>
    runningHash(
      platform,
      given.map((i) => signedId(platform, i)),
    );
  const signed: RelayHead = { relay: relayId, n: 5, chain: chainOf(items) };
  const sig = sign(relayKey, encodeHead(signed));
  assert.equal(checkHead(platform, relayKey.pub, signed, sig), true);
  assert.deepEqual(chainOf(items), signed.chain, "a genuine record hashes to its head");
  assert.notDeepEqual(chainOf([...items, fill(6, 40)]), signed.chain, "an item added");
  assert.notDeepEqual(chainOf([...items.slice(0, 4), fill(6, 40)]), signed.chain, "another item");
  const other = { ...signed, chain: chainOf([...items.slice(0, 4), fill(6, 40)]) };
  assert.equal(checkHead(platform, relayKey.pub, other, sig), false, "another running hash");
  assert.equal(
    checkHead(platform, relayKey.pub, signed, sign(stranger, encodeHead(signed))),
    false,
    "a head it did not sign",
  );
});

test("a signature that is not 64 bytes is refused before the platform sees it", () => {
  const seen: number[] = [];
  const watched = {
    ...platform,
    verify: (k: Bytes, m: Bytes, sg: Bytes) => {
      seen.push(sg.length);
      return platform.verify(k, m, sg);
    },
  };
  const sig = sign(device, encodeProof(active));
  const mine = sign(device, encodeProof(upload));
  assert.equal(rule(checkProof(watched, active, [sig], expect, dev)), "ok");
  seen.length = 0;
  for (const bad of [sig.slice(0, 63), Uint8Array.of(...sig, 0), new Uint8Array(0)])
    assert.equal(rule(checkProof(watched, active, [bad], expect, dev)), "signature");
  for (const bad of [headSig.slice(0, 63), Uint8Array.of(...headSig, 0)]) {
    assert.equal(checkHead(watched, relayKey.pub, head, bad), false);
    assert.equal(rule(checkProof(watched, upload, [mine, bad], expect)), "signature");
  }
  assert.deepEqual(
    seen.filter((n) => n !== 64),
    [],
    "no other length reached the platform",
  );
});

test("the signer's keys must be the ones the proof names", () => {
  const sig = sign(device, encodeProof(active));
  const other = { signing: device.pub, receiving: Uint8Array.of(4, ...fill(8, 64)) };
  assert.equal(
    rule(checkProof(platform, active, [sig], expect, other)),
    "signer",
    "B named, A's keys",
  );
  const bytes = encodeProof(recoveryProof);
  const old = { ...recoveryProof, recovery: fill(1) } as Proof;
  const oldBytes = encodeProof(old);
  const sigs = [sign(recovery, oldBytes), sign(device, oldBytes)];
  assert.equal(rule(checkProof(platform, old, sigs, expect, rec)), "signer", "an old recovery id");
  assert.equal(
    rule(
      checkProof(
        platform,
        recoveryProof,
        [sign(recovery, bytes), sign(device, bytes)],
        expect,
        rec,
      ),
    ),
    "ok",
  );
});

test("a proof of an unknown kind is refused, not thrown", () => {
  assert.equal(decodeProof(encodeProof(active), "nothing" as never).ok, false);
  assert.equal(decodeProof(encodeProof(active), "constructor" as never).ok, false);
});

test("the vectors of proofs.json and chain.json pass, and a changed expectation is named", () => {
  for (const name of ["proofs", "chain"]) {
    const file = JSON.parse(
      readFileSync(join(import.meta.dirname, "vectors", `${name}.json`), "utf8"),
    );
    assert.deepEqual(runVectors(platform, file), []);
    assert.ok(file.cases.length >= 8);
    const changed = structuredClone(file);
    changed.cases[0].output = "00";
    assert.deepEqual(runVectors(platform, changed), [changed.cases[0].name]);
  }
});
