/** The recovery derivation (design 3.1, 3.2) and the file blob (6.5): the package's calls and their vectors. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodePlatform, type NodePlatform } from "../../src/platform-node/platform.ts";
import { bytesEqual } from "../../src/protocol/bytes.ts";
import { openBlob, sealBlob, sealBlobUnderKey } from "../../src/protocol/files.ts";
import { recoveryKeyId } from "../../src/protocol/ids.ts";
import { labelBytes } from "../../src/protocol/labels.ts";
import type { Platform } from "../../src/protocol/platform.ts";
import { createRecoveryKey, enterRecoveryKey } from "../../src/protocol/recovery.ts";
import { runVectors } from "../../src/protocol/vectors.ts";

const secret = new Uint8Array(32).fill(9);
/** A platform on Node whose person shows and types `secret`, and the secret `show` was given. */
const withPerson = (typed: Uint8Array = secret) => {
  const seen: { shown?: Uint8Array } = {};
  const platform = createNodePlatform({
    show: (s) => {
      seen.shown = s.slice();
    },
    enter: () => typed.slice(),
  });
  return { platform, seen };
};
const value = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.value;
};

test("a recovery key is made under its two labels, and its id is the recovery id of its keys", () => {
  const { platform, seen } = withPerson();
  const infos: Uint8Array[] = [];
  const spy: Platform = {
    ...platform,
    createRecovery: (name, a, b) => {
      infos.push(a, b);
      return platform.createRecovery(name, a, b);
    },
  };
  const made = value(createRecoveryKey(spy, "r"));
  assert.equal(seen.shown?.length, 32);
  assert.deepEqual(infos, [labelBytes("recovery-signing"), labelBytes("recovery-receiving")]);
  assert.deepEqual(made.id, recoveryKeyId(platform, made.signing, made.receiving));
  assert.notDeepEqual(made.id, platform.sha256(new Uint8Array(0)));
});

test("entering the secret again gives the same keys and the same id", () => {
  const first = withPerson();
  const made = value(createRecoveryKey(first.platform, "r"));
  const again = withPerson(first.seen.shown);
  assert.deepEqual(value(enterRecoveryKey(again.platform, "r")), made);
});

test("creating holds no private key; entering holds both for their use until deleteKey", () => {
  const { platform } = withPerson();
  const noKey = { ok: false, error: "no-such-key" };
  value(createRecoveryKey(platform, "r"));
  assert.deepEqual(platform.sign("r.sign", new Uint8Array(1)), noKey);
  assert.deepEqual(platform.publicKey("r.receive"), noKey);
  const made = value(enterRecoveryKey(platform, "r"));
  assert.deepEqual(value(platform.publicKey("r.sign")), made.signing);
  assert.equal(value(platform.sign("r.sign", new Uint8Array(1))).length, 64);
  platform.deleteKey("r.sign");
  platform.deleteKey("r.receive");
  assert.deepEqual(platform.sign("r.sign", new Uint8Array(1)), noKey);
});

test("the two halves come from their own labels: swapped, the keys swap", () => {
  const made = value(enterRecoveryKey(withPerson().platform, "r"));
  const { signing, receiving } = value(
    withPerson().platform.enterRecovery(
      "r",
      labelBytes("recovery-receiving"),
      labelBytes("recovery-signing"),
    ),
  );
  assert.ok(!bytesEqual(made.signing, made.receiving));
  assert.deepEqual([signing, receiving], [made.receiving, made.signing]);
});

test("a platform failure comes back as it is, and no key is derived from a secret of another length", () => {
  const { platform } = withPerson();
  value(platform.makeKeyPair("r.sign", "sign"));
  assert.deepEqual(createRecoveryKey(platform, "r"), { ok: false, error: "key-exists" });
  assert.deepEqual(enterRecoveryKey(withPerson(new Uint8Array(31)).platform, "r"), {
    ok: false,
    error: "bad-input",
  });
});

const vectors = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "vectors", `${name}.json`), "utf8"));

/** The test-only way to give a recovery a known secret: a platform whose person types it. */
const secretPlatform = (s: Uint8Array): NodePlatform => withPerson(s).platform;

test("every case of recovery.json passes", () => {
  const platform = createNodePlatform();
  assert.deepEqual(
    runVectors(platform, vectors("recovery"), platform.importKey, secretPlatform),
    [],
  );
});

test("a recovery case with a wrong key, a wrong input or a wrong id is reported by name", () => {
  const platform = createNodePlatform();
  const file = vectors("recovery");
  const [first, second] = file.cases;
  const flip = (hex: string) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
  const changed = [
    { ...first, ikmSign: flip(first.ikmSign) },
    { ...first, signing: flip(first.signing) },
    { ...first, skReceiving: flip(first.skReceiving) },
    { ...first, output: flip(first.output) },
  ];
  assert.deepEqual(
    runVectors(
      platform,
      { ...file, cases: [...changed, second] },
      platform.importKey,
      secretPlatform,
    ),
    changed.map(() => first.name),
  );
});

test("a recovery case the file cannot run is a fault of the file", () => {
  const platform = createNodePlatform();
  const [first] = vectors("recovery").cases;
  const noSecret = { ...first, s: undefined };
  const run = (c: unknown, ...rest: unknown[]) =>
    runVectors(
      platform,
      { structure: "recovery", cases: [c as never] },
      ...(rest as [never, never]),
    );
  assert.deepEqual(run(first), [first.name]); // no import function, no way to give a secret
  assert.deepEqual(run(noSecret, platform.importKey, secretPlatform), [first.name]);
  assert.deepEqual(run(first, platform.importKey, undefined), [first.name]);
  const noIkm = { ...first, ikmSign: undefined, fails: "throws", output: undefined };
  assert.deepEqual(run(noIkm, platform.importKey, secretPlatform), []); // a fault of the file, not a mismatch
});

const key = new Uint8Array(32).fill(5);
const file = new TextEncoder().encode("a file");

test("a blob is the file under its key at a zero nonce, and its id is the hash of the bytes", () => {
  const platform = createNodePlatform();
  const sealed = sealBlobUnderKey(platform, key, file);
  assert.deepEqual(
    sealed.blob,
    platform.aesGcmSeal(key, new Uint8Array(12), labelBytes("file"), file),
  );
  assert.deepEqual(sealed.id, platform.sha256(sealed.blob));
  assert.deepEqual(openBlob(platform, sealed.id, key, sealed.blob), { ok: true, value: file });
});

test("sealing a file makes its own fresh key, and never takes one", () => {
  const platform = createNodePlatform();
  const drawn: number[] = [];
  const spy: Platform = {
    ...platform,
    random: (length) => {
      drawn.push(length);
      return platform.random(length);
    },
  };
  const [one, two] = [sealBlob(spy, file), sealBlob(spy, file)];
  assert.deepEqual(drawn, [32, 32]);
  assert.equal(one.key.length, 32);
  assert.ok(!bytesEqual(one.key, two.key));
  assert.ok(!bytesEqual(one.blob, two.blob)); // one key, one file, one zero nonce
  assert.deepEqual(one.id, platform.sha256(one.blob));
  assert.deepEqual(openBlob(platform, one.id, one.key, one.blob), { ok: true, value: file });
  assert.equal(sealBlob.length, 2);
});

test("a blob under another additional data does not open as a file", () => {
  const platform = createNodePlatform();
  const foreign = platform.aesGcmSeal(key, new Uint8Array(12), labelBytes("message"), file);
  assert.deepEqual(openBlob(platform, platform.sha256(foreign), key, foreign), {
    ok: false,
    error: "open-failed",
  });
});

test("a blob whose hash differs is refused before its key is tried, as one failure value", () => {
  const platform = createNodePlatform();
  const sealed = sealBlobUnderKey(platform, key, file);
  let opened = 0;
  const spy: Platform = {
    ...platform,
    aesGcmOpen: (...args) => {
      opened += 1;
      return platform.aesGcmOpen(...args);
    },
  };
  const tampered = sealed.blob.slice();
  tampered[0] = (tampered[0] ?? 0) ^ 1;
  const refused = { ok: false, error: "open-failed" };
  assert.deepEqual(openBlob(spy, sealed.id, key, tampered), refused);
  assert.equal(opened, 0);
  assert.deepEqual(openBlob(spy, sealed.id, new Uint8Array(32).fill(6), sealed.blob), refused);
  assert.deepEqual(openBlob(spy, new Uint8Array(32), key, sealed.blob), refused);
  assert.deepEqual(openBlob(spy, sealed.id.slice(0, 31), key, sealed.blob), refused);
  assert.deepEqual(openBlob(spy, sealed.id, key.slice(0, 16), sealed.blob), refused); // a key of another length
});

test("a call with something that is not bytes, or a seal under a short key, is a fault", () => {
  const platform = createNodePlatform();
  assert.throws(() => sealBlobUnderKey(platform, new Uint8Array(16), file));
  assert.throws(() => sealBlob(platform, "a file" as unknown as Uint8Array));
  assert.throws(() => openBlob(platform, "id" as unknown as Uint8Array, key, file), TypeError);
  assert.throws(
    () => openBlob(platform, new Uint8Array(32), key, "x" as unknown as Uint8Array),
    TypeError,
  );
  assert.throws(
    () => openBlob(platform, new Uint8Array(32), "k" as unknown as Uint8Array, file),
    TypeError,
  );
});

test("every case of blob.json passes", () => {
  const platform = createNodePlatform();
  assert.deepEqual(runVectors(platform, vectors("blob")), []);
});

test("a blob case whose hash check or key check is wrong is reported by name", () => {
  const platform = createNodePlatform();
  const file = vectors("blob");
  const [made, , mismatch, wrongKey] = file.cases;
  const refused = { ...mismatch, fails: undefined, output: "" };
  assert.deepEqual(
    runVectors(platform, {
      ...file,
      cases: [
        { ...made, id: made.id.replace(/^./, "0") },
        refused,
        { ...wrongKey, fails: "bad-input" },
      ],
    }),
    [made.name, mismatch.name, wrongKey.name],
  );
});
