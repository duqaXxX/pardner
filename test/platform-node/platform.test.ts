import assert from "node:assert/strict";
import { ECDH, generateKeyPairSync, sign as signDer } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deriveKeyPair } from "../../src/platform-node/hpke.ts";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import type { Result } from "../../src/protocol/result.ts";

const platform = createNodePlatform();
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const text = (s: string) => platform.utf8Encode(s);

function value<T>(result: Result<T>): T {
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.value;
}

test("sha256 and hkdf answer the standard cases, as plain bytes", () => {
  const digest = platform.sha256(text("abc"));
  assert.equal(
    Buffer.from(digest).toString("hex"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(Buffer.isBuffer(digest), false);
  assert.equal(platform.hkdf(new Uint8Array(22).fill(11), new Uint8Array(0), 42).length, 42);
});

test("aes-gcm keeps the 16-byte tag after the ciphertext, and refuses a changed byte", () => {
  const key = platform.random(32);
  const nonce = platform.random(12);
  const sealed = platform.aesGcmSeal(key, nonce, text("aad"), text("hello"));
  assert.equal(sealed.length, 5 + 16);
  assert.equal(
    new TextDecoder().decode(value(platform.aesGcmOpen(key, nonce, text("aad"), sealed))),
    "hello",
  );
  for (const at of [0, sealed.length - 1]) {
    const changed = sealed.slice();
    changed[at] = (changed[at] as number) ^ 1;
    assert.deepEqual(platform.aesGcmOpen(key, nonce, text("aad"), changed), {
      ok: false,
      error: "open-failed",
    });
  }
  assert.deepEqual(platform.aesGcmOpen(key, nonce, text("aad"), sealed.slice(0, 10)), {
    ok: false,
    error: "open-failed",
  });
  assert.deepEqual(platform.aesGcmOpen(key.slice(1), nonce, text("aad"), sealed), {
    ok: false,
    error: "bad-input",
  });
});

test("a signature is 64 bytes, r then s, and verifies under its public key only", () => {
  const publicKey = value(platform.makeKeyPair("a.sign", "sign"));
  assert.equal(publicKey.length, 65);
  assert.equal(publicKey[0], 4);
  const signature = value(platform.sign("a.sign", text("m")));
  assert.equal(signature.length, 64);
  assert.equal(platform.verify(publicKey, text("m"), signature), true);
  assert.equal(platform.verify(publicKey, text("n"), signature), false);
  const other = value(platform.makeKeyPair("b.sign", "sign"));
  assert.equal(platform.verify(other, text("m"), signature), false);
  assert.equal(platform.verify(publicKey, text("m"), signature.slice(0, 63)), false);
  assert.equal(platform.verify(publicKey.slice(0, 64), text("m"), signature), false);
  assert.equal(platform.verify(new Uint8Array(65), text("m"), signature), false);
});

test("a DER signature is no signature here, whatever its key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const pub = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x as string, "base64url"),
    Buffer.from(jwk.y as string, "base64url"),
  ]);
  const der = signDer("sha256", Buffer.from("m"), privateKey);
  assert.equal(platform.verify(new Uint8Array(pub), text("m"), new Uint8Array(der)), false);
});

test("a key is used for what it was made for, and a name holds one key", () => {
  value(platform.makeKeyPair("c.receive", "receive"));
  assert.deepEqual(platform.sign("c.receive", text("m")), { ok: false, error: "no-such-key" });
  assert.deepEqual(platform.makeKeyPair("c.receive", "sign"), { ok: false, error: "key-exists" });
  assert.deepEqual(platform.publicKey("nobody"), { ok: false, error: "no-such-key" });
  platform.deleteKey("c.receive");
  assert.deepEqual(platform.publicKey("c.receive"), { ok: false, error: "no-such-key" });
});

test("an hpke seal opens to its plaintext, under its info and aad alone", () => {
  const recipient = value(platform.makeKeyPair("d.receive", "receive"));
  const { enc, sealed } = value(
    platform.hpkeSeal(recipient, text("info"), text("aad"), text("secret")),
  );
  assert.equal(enc.length, 65);
  const opened = platform.hpkeOpen("d.receive", enc, text("info"), text("aad"), sealed);
  assert.equal(new TextDecoder().decode(value(opened)), "secret");
  for (const [info, aad] of [
    ["other", "aad"],
    ["info", "other"],
  ] as const) {
    assert.deepEqual(platform.hpkeOpen("d.receive", enc, text(info), text(aad), sealed), {
      ok: false,
      error: "open-failed",
    });
  }
  // Well formed, and not a point of the curve: the check that fails is not told.
  const offCurve = new Uint8Array(65);
  offCurve[0] = 4;
  assert.deepEqual(platform.hpkeOpen("d.receive", offCurve, text("info"), text("aad"), sealed), {
    ok: false,
    error: "open-failed",
  });
  assert.deepEqual(platform.hpkeSeal(new Uint8Array(65), text("i"), text("a"), text("p")), {
    ok: false,
    error: "bad-input",
  });
});

test("two seals of one plaintext differ: the ephemeral key is fresh", () => {
  const recipient = value(platform.makeKeyPair("e.receive", "receive"));
  const one = value(platform.hpkeSeal(recipient, text("i"), text("a"), text("p")));
  const two = value(platform.hpkeSeal(recipient, text("i"), text("a"), text("p")));
  assert.notDeepEqual(one.enc, two.enc);
});

test("utf-8 round-trips a character outside the BMP and refuses what is not utf-8", () => {
  const encoded = text("a\u{1F600}");
  assert.equal(encoded.length, 5);
  assert.deepEqual(platform.utf8Decode(encoded), { ok: true, value: "a\u{1F600}" });
  assert.deepEqual(platform.utf8Decode(bytes("ff")), { ok: false, error: "bad-input" });
  // A byte order mark is content: dropping it would change the bytes the text came from.
  assert.deepEqual(platform.utf8Decode(bytes("efbbbf61")), { ok: true, value: "﻿" + "a" });
});

test("a seal under AES-128 or a short nonce is a fault, not a ciphertext", () => {
  const [key, nonce] = [platform.random(32), platform.random(12)];
  assert.throws(() => platform.aesGcmSeal(key.slice(0, 16), nonce, text("a"), text("p")));
  assert.throws(() => platform.aesGcmSeal(key.slice(0, 24), nonce, text("a"), text("p")));
  assert.throws(() => platform.aesGcmSeal(key, nonce.slice(0, 8), text("a"), text("p")));
  assert.throws(() => platform.aesGcmSeal(key, new Uint8Array(16), text("a"), text("p")));
});

test("hkdf takes an info of at most 1,024 bytes and a length of 1 to 8,160", () => {
  const ikm = platform.random(32);
  assert.equal(platform.hkdf(ikm, new Uint8Array(1024), 1).length, 1);
  assert.equal(platform.hkdf(ikm, new Uint8Array(0), 8160).length, 8160);
  assert.throws(() => platform.hkdf(ikm, new Uint8Array(1025), 1));
  assert.throws(() => platform.hkdf(ikm, new Uint8Array(0), 0));
  assert.throws(() => platform.hkdf(ikm, new Uint8Array(0), 8161));
  assert.throws(() => platform.hkdf(ikm, new Uint8Array(0), 1.5));
});

test("a malformed public key or enc is bad-input to the hpke functions", () => {
  const recipient = value(platform.makeKeyPair("f.receive", "receive"));
  // The real forms of an on-curve point: only the format check can refuse them.
  const form = (name: "compressed" | "hybrid") =>
    new Uint8Array(ECDH.convertKey(recipient, "prime256v1", undefined, undefined, name) as Buffer);
  const [compressed, hybrid] = [form("compressed"), form("hybrid")];
  for (const bad of [compressed, hybrid, recipient.slice(0, 64)]) {
    assert.deepEqual(platform.hpkeSeal(bad, text("i"), text("a"), text("p")), {
      ok: false,
      error: "bad-input",
    });
    assert.deepEqual(
      platform.hpkeOpen("f.receive", bad, text("i"), text("a"), new Uint8Array(32)),
      {
        ok: false,
        error: "bad-input",
      },
    );
  }
});

test("a key pair is made for sign or receive alone", () => {
  assert.deepEqual(platform.makeKeyPair("g.other", "other" as "sign"), {
    ok: false,
    error: "bad-input",
  });
  assert.deepEqual(platform.publicKey("g.other"), { ok: false, error: "no-such-key" });
});

test("an imported private key is a scalar of 32 bytes", () => {
  for (const length of [0, 1, 31, 33]) {
    assert.deepEqual(platform.importKey(`h.${length}`, "sign", new Uint8Array(length).fill(1)), {
      ok: false,
      error: "bad-input",
    });
  }
});

/** A person who types a copy of `secret`, and keeps what `show` was given, for a test to look at. */
const person = (secret = new Uint8Array(32).fill(7)) => {
  const seen: {
    shown?: Uint8Array;
    context?: string;
    answer: boolean;
    asked: number;
    showed: number;
  } = { answer: true, asked: 0, showed: 0 };
  const made = createNodePlatform({
    show: (s, context) => {
      seen.showed += 1;
      seen.shown = s;
      seen.context = context;
      return seen.answer;
    },
    enter: () => {
      seen.asked += 1;
      return secret.slice();
    },
  });
  return { platform: made, seen };
};
const [signInfo, receiveInfo] = [text("sign-info"), text("receive-info")];
const noKey = { ok: false, error: "no-such-key" };

test("createRecovery shows nothing, returns the two keys DeriveKeyPair gives, and holds no key", () => {
  const { platform: p, seen } = person();
  const keys = value(p.createRecovery("r", signInfo, receiveInfo));
  assert.equal(seen.showed, 0);
  assert.equal("forgetRecovery" in p, false);
  assert.deepEqual(p.publicKey("r.sign"), noKey);
  assert.deepEqual(p.publicKey("r.receive"), noKey);
  assert.deepEqual(p.sign("r.sign", text("m")), noKey);
  assert.notDeepEqual(keys.signing, keys.receiving);
});

test("showRecovery shows the held secret with its context, then erases the copy; the keys are the ones createRecovery returned", () => {
  const { platform: p, seen } = person();
  const held = new Uint8Array(32).fill(5);
  p.random = () => held;
  const keys = value(p.createRecovery("r", signInfo, receiveInfo));
  assert.deepEqual(p.showRecovery("r", "id and relay"), { ok: true, value: undefined });
  assert.equal(seen.shown?.length, 32);
  assert.equal(seen.context, "id and relay");
  assert.ok(seen.shown?.every((b) => b === 0)); // the platform's copy of what it showed is erased
  assert.ok(held.every((b) => b === 0)); // and the held secret itself
  const again = person(new Uint8Array(32).fill(7));
  again.platform.random = () => new Uint8Array(32).fill(7);
  assert.deepEqual(value(again.platform.createRecovery("r", signInfo, receiveInfo)), {
    signing: value(again.platform.enterRecovery("e", signInfo, receiveInfo)).signing,
    receiving: value(again.platform.enterRecovery("f", signInfo, receiveInfo)).receiving,
  });
  assert.notDeepEqual(keys.signing, keys.receiving);
});

test("showRecovery without a created secret, or a second time, is bad-input and shows nothing", () => {
  const { platform: p, seen } = person();
  const refused = { ok: false, error: "bad-input" };
  assert.deepEqual(p.showRecovery("r", "c"), refused);
  value(p.createRecovery("r", signInfo, receiveInfo));
  assert.ok(p.showRecovery("r", "c").ok);
  assert.deepEqual(p.showRecovery("r", "c"), refused);
  assert.equal(seen.showed, 1);
});

test("a secret made and not yet shown holds its name; shown, the name is free", () => {
  const { platform: p } = person();
  value(p.createRecovery("r", signInfo, receiveInfo));
  assert.deepEqual(p.createRecovery("r", signInfo, receiveInfo), {
    ok: false,
    error: "key-exists",
  });
  assert.ok(p.showRecovery("r", "c").ok);
  assert.ok(p.createRecovery("r", signInfo, receiveInfo).ok);
});

test("deleteKey wipes a secret never shown: it cannot be shown and the name is free", () => {
  const { platform: p, seen } = person();
  const held = new Uint8Array(32).fill(5);
  p.random = () => held;
  value(p.createRecovery("r", signInfo, receiveInfo));
  assert.ok(held.some((b) => b !== 0));
  assert.ok(p.deleteKey("r").ok);
  assert.ok(held.every((b) => b === 0));
  assert.deepEqual(p.showRecovery("r", "c"), { ok: false, error: "bad-input" });
  assert.equal(seen.showed, 0);
  assert.ok(p.createRecovery("r", signInfo, receiveInfo).ok);
});

test("a person who declines is bad-input and the secret is gone and erased", () => {
  const { platform: p, seen } = person();
  seen.answer = false;
  value(p.createRecovery("r", signInfo, receiveInfo));
  assert.deepEqual(p.showRecovery("r", "c"), { ok: false, error: "bad-input" });
  assert.ok(seen.shown?.every((b) => b === 0));
  assert.deepEqual(p.showRecovery("r", "c"), { ok: false, error: "bad-input" });
  assert.equal(seen.showed, 1);
});

test("a person who answers nothing has not confirmed: the answer must be true", () => {
  const p = createNodePlatform({
    show: (() => undefined) as unknown as (s: Uint8Array, c: string) => boolean,
    enter: () => new Uint8Array(32),
  });
  value(p.createRecovery("r", signInfo, receiveInfo));
  assert.deepEqual(p.showRecovery("r", "c"), { ok: false, error: "bad-input" });
});

test("createRecovery refuses a name a key holds as the name itself, and enterRecovery one with an unshown secret", () => {
  const { platform: p, seen } = person();
  value(p.makeKeyPair("k", "sign"));
  assert.deepEqual(p.createRecovery("k", signInfo, receiveInfo), {
    ok: false,
    error: "key-exists",
  });
  assert.ok(p.publicKey("k").ok); // the key is untouched
  value(p.createRecovery("r", signInfo, receiveInfo));
  assert.deepEqual(p.enterRecovery("r", signInfo, receiveInfo), {
    ok: false,
    error: "key-exists",
  });
  assert.equal(seen.asked, 0); // refused before the person types
  assert.ok(p.showRecovery("r", "c").ok); // the secret was kept
});

test("showRecovery with a context that is not a string is bad-input and keeps the secret", () => {
  const { platform: p, seen } = person();
  value(p.createRecovery("r", signInfo, receiveInfo));
  for (const context of [undefined, null, 7, new Uint8Array(1)]) {
    assert.deepEqual(p.showRecovery("r", context as unknown as string), {
      ok: false,
      error: "bad-input",
    });
  }
  assert.equal(seen.showed, 0);
  assert.ok(p.showRecovery("r", "c").ok);
});

test("erase wipes a secret never shown", () => {
  const { platform: p, seen } = person();
  const made = new Uint8Array(32).fill(5);
  p.random = () => made;
  value(p.createRecovery("r", signInfo, receiveInfo));
  assert.ok(made.some((b) => b !== 0)); // held, not yet erased
  p.erase();
  assert.ok(made.every((b) => b === 0));
  assert.deepEqual(p.showRecovery("r", "c"), { ok: false, error: "bad-input" });
  assert.equal(seen.showed, 0);
});

test("enterRecovery holds the two pairs under their names until deleteKey, and they match createRecovery's", () => {
  const first = person();
  const made = value(first.platform.createRecovery("r", signInfo, receiveInfo));
  const secret = new Uint8Array(32).fill(7);
  const again = person(secret);
  const entered = value(again.platform.enterRecovery("r", signInfo, receiveInfo));
  const expected = deriveKeyPair(again.platform.hkdf(secret, receiveInfo, 32));
  assert.deepEqual(entered.receiving, new Uint8Array(expected.pk));
  assert.notDeepEqual(entered.signing, made.signing); // another secret: another keys
  assert.equal(value(again.platform.sign("r.sign", text("m"))).length, 64);
  assert.equal(again.platform.publicKey("r.receive").ok, true);
  again.platform.deleteKey("r.sign");
  again.platform.deleteKey("r.receive");
  assert.deepEqual(again.platform.publicKey("r.sign"), noKey);
  assert.deepEqual(again.platform.publicKey("r.receive"), noKey);
});

test("the secret is erased on every path: typed bytes, a shown copy, a refusal, an exception", () => {
  const typed = new Uint8Array(32).fill(7);
  const platformA = createNodePlatform({ show: () => true, enter: () => typed });
  assert.ok(platformA.enterRecovery("r", signInfo, receiveInfo).ok);
  assert.ok(typed.every((b) => b === 0));
  const short = new Uint8Array(31).fill(7);
  const platformB = createNodePlatform({ show: () => true, enter: () => short });
  assert.deepEqual(platformB.enterRecovery("r", signInfo, receiveInfo), {
    ok: false,
    error: "bad-input",
  });
  assert.ok(short.every((b) => b === 0));
  let shown: Uint8Array | undefined;
  const platformC = createNodePlatform({
    show: (s) => {
      shown = s;
      throw new Error("screen closed");
    },
    enter: () => new Uint8Array(32),
  });
  assert.ok(platformC.createRecovery("r", signInfo, receiveInfo).ok);
  assert.throws(() => platformC.showRecovery("r", "c"), /screen closed/);
  assert.ok(shown?.every((b) => b === 0));
  assert.deepEqual(platformC.showRecovery("r", "c"), { ok: false, error: "bad-input" }); // wiped on the exception too
  assert.deepEqual(platformC.publicKey("r.sign"), noKey);
});

test("the recovery secret is not left in Node's shared buffer pool", () => {
  const typed = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 ^ i);
  const marker = Buffer.from(typed); // one copy in the pool: this one
  const p = createNodePlatform({ show: () => true, enter: () => typed });
  assert.ok(p.enterRecovery("r", signInfo, receiveInfo).ok);
  const pool = Buffer.from(Buffer.allocUnsafe(1).buffer);
  const count = () => {
    let n = 0;
    for (let at = pool.indexOf(marker); at !== -1; at = pool.indexOf(marker, at + 1)) n += 1;
    return n;
  };
  assert.equal(count(), 1); // the marker itself
});

/** A marker built in the heap, so that it does not count itself when the shared pool is searched. */
const heapBytes = (hex: string) =>
  Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
    Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16),
  );
const inPool = (marker: Uint8Array) =>
  Buffer.from(Buffer.allocUnsafe(1).buffer).indexOf(marker) !== -1;
const recoveryCase = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "protocol", "vectors", "recovery.json"), "utf8"),
).cases[0];
const leaks = () =>
  ["s", "ikmSign", "ikmReceive", "skSigning", "skReceiving"].filter((f) =>
    inPool(heapBytes(recoveryCase[f])),
  );

test("enterRecovery then deleteKey leaves no secret, HKDF output or private scalar in the buffer pool", () => {
  const p = createNodePlatform({ show: () => true, enter: () => heapBytes(recoveryCase.s) });
  const infos = [
    text("blind-relay/1 recovery-signing"),
    text("blind-relay/1 recovery-receiving"),
  ].map((b) => new Uint8Array([b.length, ...b]));
  assert.ok(p.enterRecovery("r", infos[0] as Uint8Array, infos[1] as Uint8Array).ok);
  p.sign("r.sign", text("m")); // a use of the held key
  p.deleteKey("r.sign");
  p.deleteKey("r.receive");
  assert.deepEqual(leaks(), []);
});

test("createRecovery and showRecovery leave no secret, HKDF output or private scalar in the buffer pool", () => {
  const p = createNodePlatform({ show: () => true, enter: () => new Uint8Array(32) });
  p.random = () => heapBytes(recoveryCase.s);
  const infos = [
    text("blind-relay/1 recovery-signing"),
    text("blind-relay/1 recovery-receiving"),
  ].map((b) => new Uint8Array([b.length, ...b]));
  assert.ok(p.createRecovery("r", infos[0] as Uint8Array, infos[1] as Uint8Array).ok);
  assert.ok(p.showRecovery("r", "c").ok);
  assert.deepEqual(leaks(), []);
});

test("createRecovery draws its secret from the platform's random, and showRecovery shows that one", () => {
  const { platform: p, seen } = person();
  p.random = (length) => new Uint8Array(length).fill(0x42);
  assert.ok(p.createRecovery("r", signInfo, receiveInfo).ok);
  assert.ok(p.showRecovery("r", "c").ok);
  assert.equal(seen.shown?.length, 32);
  const expected = createNodePlatform();
  const keys = value(p.createRecovery("q", signInfo, receiveInfo));
  const pair = deriveKeyPair(expected.hkdf(new Uint8Array(32).fill(0x42), signInfo, 32));
  assert.deepEqual(keys.signing, new Uint8Array(pair.pk));
});

test("an info over the limit throws before the person is shown or asked anything", () => {
  const { platform: p, seen } = person();
  const tooLong = new Uint8Array(1025);
  assert.throws(() => p.createRecovery("r", signInfo, tooLong), RangeError);
  assert.throws(() => p.enterRecovery("r", tooLong, receiveInfo), RangeError);
  assert.equal(seen.showed, 0);
  assert.equal(seen.asked, 1); // enter asks, derives, and throws; the secret it took is erased
  assert.deepEqual(p.publicKey("r.sign"), noKey);
});

test("one info for both halves is refused: the scalar would serve ECDSA and HPKE", () => {
  const { platform: p, seen } = person();
  const same = { ok: false, error: "bad-input" };
  assert.deepEqual(p.createRecovery("r", signInfo, signInfo.slice()), same);
  assert.deepEqual(p.enterRecovery("r", signInfo, signInfo.slice()), same);
  assert.equal(seen.showed, 0);
  assert.equal(seen.asked, 0);
});

test("a name taken before the person is shown or asked stops the call there", () => {
  const { platform: p, seen } = person();
  value(p.makeKeyPair("r.receive", "receive"));
  const taken = { ok: false, error: "key-exists" };
  assert.deepEqual(p.createRecovery("r", signInfo, receiveInfo), taken);
  assert.deepEqual(p.enterRecovery("r", signInfo, receiveInfo), taken);
  assert.equal(seen.showed + seen.asked, 0);
});

test("a name taken while the person types holds neither key", () => {
  const holder: { p?: ReturnType<typeof createNodePlatform> } = {};
  holder.p = createNodePlatform({
    show: () => true,
    enter: () => {
      holder.p?.makeKeyPair("r.receive", "receive");
      return new Uint8Array(32).fill(7);
    },
  });
  assert.deepEqual(holder.p.enterRecovery("r", signInfo, receiveInfo), {
    ok: false,
    error: "key-exists",
  });
  assert.deepEqual(holder.p.publicKey("r.sign"), noKey);
});

test("a recovery with no person is bad-input, for the creation and the showing", () => {
  const bare = createNodePlatform();
  const refused = { ok: false, error: "bad-input" };
  assert.deepEqual(bare.createRecovery("r", signInfo, receiveInfo), refused);
  assert.deepEqual(bare.showRecovery("r", "c"), refused);
});

test("an imported key is for sign or receive alone", () => {
  assert.deepEqual(platform.importKey("i.other", "other" as "sign", new Uint8Array(32).fill(1)), {
    ok: false,
    error: "bad-input",
  });
});

test("every maker refuses a name a held secret takes, and deleteKey of a name never made is ok", () => {
  const { platform: p } = person();
  const exists = { ok: false, error: "key-exists" };
  assert.ok(p.createRecovery("r", signInfo, receiveInfo).ok);
  assert.deepEqual(p.makeKeyPair("r", "sign"), exists);
  assert.deepEqual(p.importKey("r", "sign", new Uint8Array(32).fill(1)), exists);
  assert.ok(p.createRecovery("x.sign", signInfo, receiveInfo).ok);
  assert.deepEqual(p.enterRecovery("x", signInfo, receiveInfo), exists);
  assert.deepEqual(p.deleteKey("never-made"), { ok: true, value: undefined });
  assert.ok(p.deleteKey("r").ok);
  assert.ok(p.makeKeyPair("r", "sign").ok); // the secret is gone, the name is free
});
