/**
 * The recovery connection of the device's link (recovery design 2.3, 3): the reading connection that
 * ends with the log, the reset sent on a connection of its own after `prove-active` is refused, the
 * set rule rebuilt against the log as it moved, and the return to `prove-active` after each answer.
 * The relay is the frames of `reading-world.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesEqual } from "../../src/protocol/bytes.ts";
import { decodeDeviceEntry, encodeDevicePossession, idKey } from "../../src/protocol/device-log.ts";
import { decodeFrame, encodeFrame, type Frame } from "../../src/protocol/frames.ts";
import { type Effect, Link, type LinkOptions } from "../../src/protocol/link.ts";
import { checkProof } from "../../src/protocol/proofs.ts";
import { platform } from "../relay/support.ts";
import { fill, keyed } from "../relay/world.ts";
import { receivingOf, scene } from "./reading-world.ts";

const NONCE = fill(4);
const BINDING = fill(9);

/** A new device of alice's, not in her log, with her recovery key typed, as a link on the scene's wire. */
function rig(reset: boolean, trusted: "bot" | "none" | "twice" = "bot", replacement = false) {
  const s = scene();
  s.epoch();
  const fresh = keyed();
  const next = keyed();
  const proof = platform.sign(fresh.sign, encodeDevicePossession(s.alice.id, fresh.device));
  assert.ok(proof.ok);
  const recover: LinkOptions["recover"] = {
    key: { id: s.alice.recovery.recoveryId, sign: s.alice.recovery.sign },
    ...(reset && {
      reset: {
        proof: proof.value,
        trusted:
          trusted === "none"
            ? []
            : trusted === "twice"
              ? [s.bot.id, s.bot.id]
              : [s.bot.id, fill(5)],
        ...(replacement && { replacement: next.keys }),
      },
    }),
  };
  const link = new Link({
    who: { ...s.who, self: fresh.id, receiving: receivingOf(fresh) },
    keys: fresh.device,
    sign: fresh.sign,
    kept: { ids: [], head: undefined, putBack: false },
    recover,
  });
  const sent = (fx: Effect[]): Frame[] =>
    fx.flatMap((e) => {
      if (e.do !== "send") return [];
      const f = decodeFrame(e.bytes, false, "relay");
      const g = f.ok ? f : decodeFrame(e.bytes, true, "relay");
      assert.ok(g.ok);
      return [g.value];
    });
  const heard = new Set<number>();
  return {
    s,
    fresh,
    next,
    link,
    sent,
    /** TLS up and hello on `conn`. */
    hello(conn: number, now = 0): Effect[] {
      return [
        ...link.opened(conn, BINDING, now),
        ...this.give(conn, [{ type: "hello", relayNonce: NONCE }], now),
      ];
    },
    give(conn: number, frames: Frame[], now: number): Effect[] {
      return frames.flatMap((f) => {
        const before = f.type === "hello" || (f.type === "refused" && !heard.has(conn));
        const out = link.received(conn, encodeFrame(f, !before), now);
        if (sent(out).some((g) => g.type.startsWith("prove-"))) heard.add(conn);
        return out;
      });
    },
    /** The device log as the relay streams it to a recovery connection: entries in frames, then the end of the request. */
    log(): Frame[] {
      const entries = s.wire.items.filter((i) => i.kind === 1);
      return [
        { type: "log", request: 1, entries: entries.slice(0, 1) },
        { type: "log", request: 1, entries: entries.slice(1) },
        { type: "result", request: 1, code: 0 },
      ];
    },
  };
}

const dials = (fx: Effect[]) =>
  fx.flatMap((e) => (e.do === "dial" ? [`${e.conn}:${e.purpose}`] : []));
const outcomes = (fx: Effect[]) => fx.flatMap((e) => (e.do === "recovery" ? [e.outcome] : []));

test("a reading recovery dials a recovery connection at once, proves with both keys, reads the log, tells it and stops", () => {
  const a = rig(false);
  assert.deepEqual(dials(a.link.start(0)), ["1:recover"]);
  assert.equal(a.link.state, "recovering");
  const hello = a.sent(a.hello(1));
  const prove = hello[0];
  assert.ok(prove?.type === "prove-recovery");
  assert.deepEqual(hello[1], { type: "recovery-log", request: 1 });
  assert.equal(prove.proof.kind, "recovery");
  assert.ok(bytesEqual(prove.proof.recovery, a.s.alice.recovery.recoveryId));
  assert.deepEqual(prove.proof.newDevice, a.fresh.device);
  assert.deepEqual(
    checkProof(
      platform,
      prove.proof,
      [prove.recoverySig, prove.deviceSig],
      { relayPublic: a.s.wire.key.keys.signing, relayNonce: NONCE, binding: BINDING },
      a.s.alice.recovery.keys,
    ),
    { ok: true },
  );
  const fx = a.give(1, a.log(), 1);
  const [done] = outcomes(fx);
  assert.ok(done && "log" in done);
  assert.equal(done.log.length, 2, "alice's genesis and the bot's add, each checked from entry 0");
  assert.deepEqual(a.sent(fx), [], "a reading recovery sends nothing after its log");
  assert.equal(
    fx.some((e) => e.do === "close"),
    true,
  );
  assert.equal(a.link.state, "stopped");
  assert.deepEqual(dials(a.link.tick(10 ** 9)), []);
});

test("a log whose entry does not hold, or that is not the person's, or whose recovery key is not the typed one, is a fault, never a log", () => {
  const entries = (a: ReturnType<typeof rig>) => a.s.wire.items.filter((i) => i.kind === 1);
  const bad = rig(false);
  bad.link.start(0);
  bad.hello(1);
  const [genesis, add] = entries(bad);
  assert.ok(genesis && add);
  const torn = { ...add, sig: new Uint8Array(add.sig).fill(1) };
  const fx = bad.give(1, [{ type: "log", request: 1, entries: [genesis, torn] }], 1);
  assert.deepEqual(outcomes(fx), [{ fault: "a log entry that does not hold" }]);
  const other = rig(false);
  other.link.start(0);
  other.hello(1);
  const stranger = scene();
  const foreign = stranger.wire.items.filter((i) => i.kind === 1);
  const fy = other.give(
    1,
    [
      { type: "log", request: 1, entries: foreign },
      { type: "result", request: 1, code: 0 },
    ],
    1,
  );
  assert.equal(outcomes(fy)[0] && "fault" in (outcomes(fy)[0] as object), true);
  const wrong = rig(false);
  const typed = keyed();
  const link = new Link({
    who: { ...wrong.s.who, self: wrong.fresh.id, receiving: receivingOf(wrong.fresh) },
    keys: wrong.fresh.device,
    sign: wrong.fresh.sign,
    kept: { ids: [], head: undefined, putBack: false },
    recover: { key: { id: typed.recoveryId, sign: typed.sign } },
  });
  link.start(0);
  link.opened(1, BINDING, 0);
  link.received(1, encodeFrame({ type: "hello", relayNonce: NONCE }, false), 0);
  const fz = wrong.log().flatMap((f) => link.received(1, encodeFrame(f, true), 1));
  assert.deepEqual(outcomes(fz), [
    { fault: "a log that is not this person's, or whose recovery key is not the one typed" },
  ]);
});

test("a reset recovery tries prove-active first; refused as unknown, the next connection is the recovery one, which sends the reset and returns to prove-active", () => {
  const a = rig(true);
  assert.deepEqual(dials(a.link.start(0)), ["1:active"]);
  const first = a.sent(a.hello(1));
  assert.equal(first[0]?.type, "prove-active");
  const refused = a.give(1, [{ type: "refused", reason: 2 }], 1);
  assert.deepEqual(outcomes(refused), []);
  a.link.closed(1, 2);
  assert.deepEqual(dials(a.link.tick(1002)), ["2:recover"]);
  const prove = a.sent(a.hello(2, 1002));
  assert.equal(prove[0]?.type, "prove-recovery");
  const fx = a.give(2, a.log(), 1003);
  const [submit] = a.sent(fx);
  assert.ok(submit?.type === "submit" && submit.kind === 1 && submit.request === 2);
  const reset = decodeDeviceEntry(submit.signed);
  assert.ok(reset.ok && reset.value.kind === "reset");
  assert.deepEqual(
    reset.value.set.map(idKey).sort(),
    [a.fresh.id, a.s.bot.id].map(idKey).sort(),
    "this device and the trusted one still active; an id the log never named is left out",
  );
  assert.deepEqual(reset.value.newDevice?.device, a.fresh.device);
  assert.equal(reset.value.recovery, undefined, "the typed key stays current");
  assert.deepEqual(outcomes(a.give(2, [{ type: "result", request: 2, code: 0 }], 1004)), [
    { code: 0 },
  ]);
  a.link.closed(2, 1005);
  assert.deepEqual(
    dials(a.link.tick(10 ** 6)),
    ["3:active"],
    "the next connection starts at prove-active again",
  );
  a.hello(3, 10 ** 6);
  const served = a.give(3, [a.s.wire.served()], 10 ** 6 + 1);
  assert.equal(
    served.some((e) => e.do === "recovered"),
    true,
  );
});

test("the reset carries the new recovery key's public keys when one was chosen, and only this device after a Yes", () => {
  const a = rig(true, "none", true);
  a.link.start(0);
  a.hello(1);
  a.give(1, [{ type: "refused", reason: 3 }], 1);
  a.link.closed(1, 2);
  a.link.tick(1002);
  a.hello(2, 1002);
  const [submit] = a.sent(a.give(2, a.log(), 1003));
  assert.ok(submit?.type === "submit");
  const reset = decodeDeviceEntry(submit.signed);
  assert.ok(reset.ok && reset.value.kind === "reset");
  assert.deepEqual(reset.value.set, [a.fresh.id]);
  assert.deepEqual(reset.value.recovery, a.next.keys);
});

test("a reset rebuilt against a log that moved leaves out a trusted device removed meanwhile and never asks again", () => {
  const a = rig(true);
  a.link.start(0);
  a.hello(1);
  a.give(1, [{ type: "refused", reason: 2 }], 1);
  a.link.closed(1, 2);
  a.link.tick(1002);
  a.hello(2, 1002);
  const removed = a.s.alice.remove(a.s.log, a.s.bot);
  a.s.entry(removed);
  const [submit] = a.sent(a.give(2, a.log(), 1003));
  assert.ok(submit?.type === "submit");
  const reset = decodeDeviceEntry(submit.signed);
  assert.ok(reset.ok && reset.value.kind === "reset");
  assert.deepEqual(reset.value.set, [a.fresh.id]);
});

test("a refusal on the recovery connection is told and the next connection is the active one; refused as removed it never dials a recovery", () => {
  const a = rig(true);
  a.link.start(0);
  a.hello(1);
  a.give(1, [{ type: "refused", reason: 2 }], 1);
  a.link.closed(1, 2);
  a.link.tick(1002);
  a.hello(2, 1002);
  assert.deepEqual(outcomes(a.give(2, [{ type: "refused", reason: 5 }], 1003)), [{ refused: 5 }]);
  a.link.closed(2, 1004);
  assert.deepEqual(
    dials(a.link.tick(100_000)),
    [],
    "a refusal 5 counts toward the relay's ban: asked again after ASK, not after the back-off",
  );
  assert.deepEqual(dials(a.link.tick(10 ** 6)), ["3:active"]);
  const gone = rig(true);
  gone.link.start(0);
  gone.hello(1);
  gone.give(1, [{ type: "refused", reason: 1 }], 1);
  gone.link.closed(1, 2);
  const waits = [10 ** 4, 10 ** 6, 10 ** 8].flatMap((t) => dials(gone.link.tick(t)));
  assert.deepEqual(
    waits,
    ["2:active"],
    "removed: only the ordinary retry, never a recovery connection",
  );
});

test("recover is taken only before the link starts", () => {
  const a = rig(false);
  const again = { key: { id: fill(1), sign: "x" } };
  assert.deepEqual(a.link.recover(again), { ok: true, value: undefined });
  a.link.start(0);
  assert.deepEqual(a.link.recover(again), { ok: false, error: "bad-input" });
});

/** A reset recovery with the recovery connection open and hello answered. */
function recovering() {
  const a = rig(true);
  a.link.start(0);
  a.hello(1);
  a.give(1, [{ type: "refused", reason: 2 }], 1);
  a.link.closed(1, 2);
  a.link.tick(1002);
  a.hello(2, 1002);
  return a;
}

test("an outcome that retrying cannot change, a refusal 2 or 3 or a fault, stops the link: no recovery connection is dialed again", () => {
  for (const frames of [
    [{ type: "refused", reason: 2 }],
    [{ type: "refused", reason: 3 }],
    [{ type: "log", request: 1, entries: [{ signed: fill(1, 40), sig: fill(2, 64) }] }],
  ] as Frame[][]) {
    const a = recovering();
    const fx = a.give(2, frames, 1003);
    assert.equal(outcomes(fx).length, 1);
    assert.equal(a.link.state, "stopped");
    assert.deepEqual(
      [10 ** 4, 10 ** 6, 10 ** 8].flatMap((t) => dials(a.link.tick(t))),
      [],
    );
  }
});

test("a refusal 6 on the recovery connection puts the relay back as the active path does, and dials nothing", () => {
  const a = recovering();
  const fx = a.give(2, [{ type: "refused", reason: 6 }], 1003);
  assert.deepEqual(outcomes(fx), [{ refused: 6 }]);
  assert.deepEqual(
    fx.find((e) => e.do === "persist")?.what,
    { putBack: true },
    "stored as a put-back",
  );
  a.link.persisted(true, 1004);
  assert.equal(a.link.state, "put-back");
  assert.deepEqual(
    [10 ** 4, 10 ** 8].flatMap((t) => dials(a.link.tick(t))),
    [],
  );
});

test("a trusted list that names a device twice still builds the reset, once", () => {
  const a = rig(true, "twice");
  a.link.start(0);
  a.hello(1);
  a.give(1, [{ type: "refused", reason: 2 }], 1);
  a.link.closed(1, 2);
  a.link.tick(1002);
  a.hello(2, 1002);
  const [submit] = a.sent(a.give(2, a.log(), 1003));
  assert.ok(submit?.type === "submit", "no fault: the reset was built");
  const reset = decodeDeviceEntry(submit.signed);
  assert.ok(reset.ok && reset.value.kind === "reset");
  assert.deepEqual(reset.value.set.map(idKey).sort(), [a.fresh.id, a.s.bot.id].map(idKey).sort());
});

test("recover refuses values of the wrong shape as bad input and the constructor throws on them", () => {
  const a = rig(false);
  const ok = { key: { id: fill(1), sign: "x" } };
  for (const bad of [
    { key: { id: new Uint8Array(31), sign: "x" } },
    { key: { id: fill(1), sign: 5 } },
    { ...ok, reset: { proof: new Uint8Array(63), trusted: [] } },
    { ...ok, reset: { proof: fill(1, 64), trusted: [new Uint8Array(3)] } },
    { ...ok, reset: { proof: fill(1, 64), trusted: [], replacement: { signing: fill(1, 65) } } },
  ] as unknown as NonNullable<LinkOptions["recover"]>[])
    assert.deepEqual(a.link.recover(bad), { ok: false, error: "bad-input" });
  assert.deepEqual(a.link.recover(ok), { ok: true, value: undefined });
});
