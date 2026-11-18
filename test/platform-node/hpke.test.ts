/**
 * HPKE on Node against the vector RFC 9180 pins for this suite (its `[TestVectors]` reference),
 * on the Node of CI and, in the local runs, on the floor. The vector fixes the one-time key, which the
 * platform never lets a caller do.
 */
import assert from "node:assert/strict";
import { ECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gcmSeal } from "../../src/platform-node/aead.ts";
import {
  acceptsScalar,
  deriveKeyPair,
  encap,
  generateKeyPair,
  keySchedule,
  open,
  seal,
  sealWith,
} from "../../src/platform-node/hpke.ts";

const { vector: v } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "protocol", "vectors", "hpke-rfc9180.json"), "utf8"),
) as {
  vector: {
    info: string;
    ikmR: string;
    ikmE: string;
    skRm: string;
    pkRm: string;
    skEm: string;
    pkEm: string;
    enc: string;
    ss: string;
    ks_context: string;
    ks_s: string;
    aead_k: string;
    base_nonce: string;
    encryptions: { aad: string; ct: string; nonce: string; pt: string }[];
  };
};
const hex = (s: string) => Buffer.from(s, "hex");

test("DeriveKeyPair gives the vector's key pairs", () => {
  const r = deriveKeyPair(hex(v.ikmR));
  assert.equal(r.sk.toString("hex"), v.skRm);
  assert.equal(r.pk.toString("hex"), v.pkRm);
  const e = deriveKeyPair(hex(v.ikmE));
  assert.equal(e.sk.toString("hex"), v.skEm);
  assert.equal(e.pk.toString("hex"), v.pkEm);
});

test("Encap and the key schedule give the vector's values", () => {
  const sent = encap(deriveKeyPair(hex(v.ikmE)), hex(v.pkRm));
  assert.equal(sent.enc.toString("hex"), v.enc);
  assert.equal(sent.sharedSecret.toString("hex"), v.ss);
  const schedule = keySchedule(sent.sharedSecret, hex(v.info));
  assert.equal(schedule.context.toString("hex"), v.ks_context);
  assert.equal(schedule.secret.toString("hex"), v.ks_s);
  assert.equal(schedule.key.toString("hex"), v.aead_k);
  assert.equal(schedule.baseNonce.toString("hex"), v.base_nonce);
});

test("every encryption of the vector is the AEAD under its key and nonce", () => {
  for (const x of v.encryptions) {
    const sealed = gcmSeal(hex(v.aead_k), hex(x.nonce), hex(x.aad), hex(x.pt));
    assert.equal(sealed.toString("hex"), x.ct);
  }
});

test("a seal under the vector's fixed key is the vector's first encryption", () => {
  const first = v.encryptions[0] as (typeof v.encryptions)[number];
  const sealed = sealWith(
    deriveKeyPair(hex(v.ikmE)),
    hex(v.pkRm),
    hex(v.info),
    hex(first.aad),
    hex(first.pt),
  );
  assert.equal(sealed.enc.toString("hex"), v.enc);
  assert.equal(sealed.sealed.toString("hex"), first.ct);
});

test("the recipient opens the vector's first encryption", () => {
  const first = v.encryptions[0] as (typeof v.encryptions)[number];
  const r = deriveKeyPair(hex(v.ikmR));
  const plain = open(r, hex(v.enc), hex(v.info), hex(first.aad), hex(first.ct));
  assert.equal(plain.toString("hex"), first.pt);
  assert.throws(() => open(r, hex(v.enc), hex("00"), hex(first.aad), hex(first.ct)));
  assert.throws(() => open(r, hex(v.enc), hex(v.info), hex("00"), hex(first.ct)));
});

// RFC 9180, 7.1.1: a P-256 public key is the 65-byte uncompressed point, and nothing else. Node
// parses the compressed and the hybrid forms of the same point too; CryptoKit refuses them.
const forms = ["compressed", "hybrid"] as const;
const pointIn = (form: (typeof forms)[number], point: Buffer) =>
  Buffer.from(ECDH.convertKey(point, "prime256v1", undefined, undefined, form) as Buffer);

test("a recipient key that is not an uncompressed point is refused by seal", () => {
  const recipient = generateKeyPair();
  for (const form of forms) {
    const other = pointIn(form, recipient.pk);
    assert.throws(() => seal(other, hex("00"), hex("00"), hex("00")), form);
  }
  assert.throws(() => seal(recipient.pk.subarray(0, 64), hex("00"), hex("00"), hex("00")));
});

test("an enc that is not an uncompressed point is refused by open, though its seal is well formed", () => {
  const recipient = generateKeyPair();
  const sender = generateKeyPair();
  const good = sealWith(sender, recipient.pk, hex("00"), hex("00"), hex("00"));
  assert.doesNotThrow(() => open(recipient, good.enc, hex("00"), hex("00"), good.sealed));
  for (const form of forms) {
    // The same ephemeral key, its point written in another form and bound into the seal as such.
    const written = { sk: sender.sk, pk: pointIn(form, sender.pk) };
    const sealed = sealWith(written, recipient.pk, hex("00"), hex("00"), hex("00"));
    assert.throws(() => open(recipient, sealed.enc, hex("00"), hex("00"), sealed.sealed), form);
  }
});

test("DeriveKeyPair accepts a candidate scalar from 1 to n-1 and no other", () => {
  const n = "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551";
  const plus = (delta: number) => (BigInt(`0x${n}`) + BigInt(delta)).toString(16).padStart(64, "0");
  const accepted = (h: string) => acceptsScalar(hex(h));
  assert.equal(accepted("00".repeat(32)), false);
  assert.equal(accepted("00".repeat(31) + "01"), true);
  assert.equal(accepted(plus(-1)), true);
  assert.equal(accepted(plus(0)), false);
  assert.equal(accepted(plus(1)), false);
  assert.equal(accepted("ff".repeat(32)), false);
});
