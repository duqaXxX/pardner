/**
 * The give-back of design 3.12, decided on the head alone. The cases are those of the model's
 * "5.10, 5.11: a give-back is the head alone..." and "5.11: a head of the relay's own key that its
 * sequence does not hold fails it closed..." (`model.test.mjs`), as sequences of real items.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import { relayKeyId } from "../../src/protocol/ids.ts";
import { encodeHead, type RelayHead } from "../../src/protocol/proofs.ts";
import { relayPublicKey, relaySigner } from "../../src/relay/directory.ts";
import { giveBack } from "../../src/relay/giveback.ts";
import { Code } from "../../src/relay/sequence.ts";
import { platform } from "./support.ts";
import { enrolled, fill, keyed } from "./world.ts";

/** A relay with three items placed (a genesis and two devices added), and what signs heads as it does. */
async function grown() {
  const r = await enrolled();
  r.join(keyed());
  r.join(keyed());
  const signer = relaySigner(createNodePlatform(), readFileSync(join(r.dir, "key.pem")));
  const placed = r.journal.placed;
  assert.equal(placed.length, 3);
  const headAt = (n: number, chain = n === 0 ? fill(0) : (placed[n - 1]?.chain as Uint8Array)) => {
    const head: RelayHead = { relay: r.relay, n, chain };
    return { head, sig: signer(encodeHead(head)) };
  };
  const give = (given: { head: RelayHead; sig: Uint8Array }) =>
    giveBack(platform, r.publicKey, r.journal.placed, given.head, given.sig);
  return { r, placed, headAt, give };
}

test("a head of the relay's own sequence is accepted, at its length, below it and at zero; nothing is taken (model 5.10)", async () => {
  const { r, headAt, give } = await grown();
  for (const n of [3, 2, 1, 0])
    assert.deepEqual(give(headAt(n)), { verdict: "accepted" }, `n ${n}`);
  assert.equal(r.journal.placed.length, 3);
});

test("a signature the relay never made, a key of a stranger and another relay's id are refused and stop nothing (model 5.10)", async () => {
  const { r, headAt, give } = await grown();
  const { head, sig } = headAt(2);
  assert.deepEqual(give({ head, sig: fill(9, 64) }), { verdict: "refused" }, "a bad signature");
  const stranger = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  const own = relaySigner(createNodePlatform(), stranger);
  const other = { head: { ...head, relay: relayKeyId(platform, relayPublicKey(stranger)) }, sig };
  assert.deepEqual(
    give({ head, sig: own(encodeHead(head)) }),
    { verdict: "refused" },
    "another key",
  );
  assert.deepEqual(give({ ...other, sig: own(encodeHead(other.head)) }), { verdict: "refused" });
  assert.deepEqual(
    give(other),
    { verdict: "refused" },
    "another relay's id with this relay's old signature",
  );
  assert.deepEqual(
    give({ head, sig: sig.subarray(1) }),
    { verdict: "refused" },
    "a short signature",
  );
  assert.equal(r.journal.placed.length, 3);
});

test("a head of its own key that the sequence does not hold fails it closed: another running hash at n (model 5.11)", async () => {
  const { headAt, give } = await grown();
  assert.deepEqual(give(headAt(2, fill(7))), { verdict: "closed", first: 2 });
  assert.deepEqual(
    give(headAt(0, fill(7))),
    { verdict: "closed", first: 0 },
    "n 0 has the zero hash",
  );
});

test("a sequence shorter than n fails it closed (model 5.11)", async () => {
  const { r, headAt, placed } = await grown();
  const given = headAt(3);
  const shorter = placed.slice(0, 1);
  assert.deepEqual(giveBack(platform, r.publicKey, shorter, given.head, given.sig), {
    verdict: "closed",
    first: 1,
  });
});

test("a head longer than the sequence whose hash is the one the relay holds at its end fails it closed (model 5.11)", async () => {
  const { headAt, give, placed } = await grown();
  assert.deepEqual(give(headAt(4, placed[2]?.chain)), { verdict: "closed", first: 3 });
});

test("the code the uploader is answered when the relay fails closed is design 6.7's 11", () => {
  assert.equal(Code.putBack, 11);
});
