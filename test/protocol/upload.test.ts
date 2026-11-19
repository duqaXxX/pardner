/**
 * The give-back upload connection as a state machine (relay continuity design, 5.11): the proof and
 * the head go out together after `hello`, and `result` for request 1 or `refused` ends it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { relayKeyId } from "../../src/protocol/ids.ts";
import { checkProof } from "../../src/protocol/proofs.ts";
import { Upload, type UploadOptions } from "../../src/protocol/upload.ts";
import { platform } from "../relay/support.ts";
import { fill } from "../relay/world.ts";
import { scene } from "./reading-world.ts";

const NONCE = fill(4);
const BINDING = fill(9);
const PATIENCE = 30_000;

/** An upload of the head a scene's relay signed, dialed at 100; `opened` brings TLS up. */
function rig(over: Partial<UploadOptions> = {}) {
  const s = scene();
  s.epoch();
  const signed = s.wire.head();
  const head = {
    head: {
      relay: relayKeyId(platform, s.wire.key.keys.signing),
      n: signed.n,
      chain: signed.chain,
    },
    sig: signed.sig,
  };
  const upload = new Upload(
    { who: s.who, keys: s.bot.device, sign: s.bot.sign, head, patience: PATIENCE, ...over },
    100,
  );
  return { s, head, upload };
}
const hello = { type: "hello", relayNonce: NONCE } as const;

/** An upload that sent its proof, at 200. */
function waiting() {
  const r = rig();
  r.upload.opened(BINDING);
  const step = r.upload.frame(hello, 200);
  return { ...r, step };
}

test("it holds the dial's deadline, and no frame may arrive before TLS is up", () => {
  const { upload } = rig();
  assert.equal(upload.open, false);
  assert.equal(upload.deadline, 100 + PATIENCE);
  upload.opened(BINDING);
  assert.equal(upload.open, true);
  assert.equal(upload.deadline, 100 + PATIENCE, "hello shares the dial's deadline");
});

test("hello sends prove upload and upload done together, the proof binding this connection", () => {
  const { s, head, step, upload } = waiting();
  assert.ok(step && "send" in step);
  assert.deepEqual(
    step.send.map((f) => f.type),
    ["prove-upload", "upload-done"],
  );
  const [prove, done] = step.send;
  assert.ok(prove?.type === "prove-upload" && done?.type === "upload-done");
  assert.deepEqual(
    checkProof(platform, prove.proof, [prove.deviceSig, prove.relaySig], {
      relayPublic: s.wire.key.keys.signing,
      relayNonce: NONCE,
      binding: BINDING,
    }),
    { ok: true },
  );
  assert.deepEqual([done.request, done.head, done.sig], [1, head.head, head.sig]);
  assert.deepEqual(prove.relaySig, head.sig);
  assert.equal(upload.deadline, 200 + PATIENCE, "PATIENCE from the proof");
});

test("a result for request 1 ends it with the code: 0, and 11", () => {
  for (const code of [0, 11] as const) {
    const { upload } = waiting();
    assert.deepEqual(upload.frame({ type: "result", request: 1, code }, 300), {
      done: { code, slow: false },
    });
  }
});

test("a refusal ends it with its reason: 6 is not slow, any other is", () => {
  for (const [reason, slow] of [
    [6, false],
    [1, true],
    [2, true],
    [3, true],
    [5, true],
  ] as const) {
    const { upload } = waiting();
    assert.deepEqual(upload.frame({ type: "refused", reason }, 300), {
      done: { refusal: reason, slow },
    });
  }
});

test("a refusal before the proof ends it too", () => {
  const { upload } = rig();
  upload.opened(BINDING);
  assert.deepEqual(upload.frame({ type: "refused", reason: 5 }, 150), {
    done: { refusal: 5, slow: true },
  });
});

test("any other frame, or a result for another request, only moves the deadline", () => {
  const { upload, s } = waiting();
  const position = { type: "position", from: 0, incarnation: s.wire.incarnation } as const;
  assert.equal(upload.frame(position, 300), undefined);
  assert.equal(upload.deadline, 300 + PATIENCE);
  assert.equal(upload.frame(hello, 350), undefined, "a second hello proves nothing again");
  assert.equal(upload.frame({ type: "result", request: 2, code: 0 }, 400), undefined);
  assert.equal(upload.deadline, 400 + PATIENCE);
});

test("a platform that cannot sign throws, which the link takes as a drop", () => {
  const broke = Object.assign(Object.create(platform), {
    sign: () => ({ ok: false, error: "io-failed" }),
  });
  const s = scene();
  const { upload } = rig({ who: { ...s.who, platform: broke } });
  upload.opened(BINDING);
  assert.throws(() => upload.frame(hello, 200), /did not sign/);
});

test("before TLS is up no frame does anything, and the deadline stays the dial's", () => {
  const { upload } = rig();
  const frames = [
    hello,
    { type: "result", request: 1, code: 0 },
    { type: "refused", reason: 5 },
  ] as const;
  for (const f of frames) {
    assert.equal(upload.frame(f, 500), undefined);
    assert.equal(upload.deadline, 100 + PATIENCE);
  }
});

test("a second opened after the proof does nothing", () => {
  const { upload } = waiting();
  upload.opened(fill(1));
  assert.equal(upload.frame(hello, 300), undefined, "no second proof");
  assert.equal(upload.open, true);
});
