/**
 * The device's connection as a state machine (step 6.3 design, 4 and 7.1): events with the time in,
 * effects out, on a clock that is only the numbers the tests pass. The relay is the frames of
 * `reading-world.ts`; each test is named after the line of 2.1, the row of 4.3 or the invariant of
 * 4.4 it holds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoggedEpoch } from "../../src/protocol/epochs.ts";
import { decodeFrame, encodeFrame, type Frame } from "../../src/protocol/frames.ts";
import { type Effect, Link, type LinkOptions } from "../../src/protocol/link.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { checkProof } from "../../src/protocol/proofs.ts";
import type { Kept } from "../../src/protocol/reading.ts";
import { platform } from "../relay/support.ts";
import { fill, keyed } from "../relay/world.ts";
import { historySeal, prompt, scene } from "./reading-world.ts";

const NONCE = fill(4);
const BINDING = fill(9);
const SHORT = { first: 1000, max: 60_000, patience: 30_000, ask: 600_000 };

/** A link on a scene's wire, with the relay's side of each connection played by `give`. */
function rig(over: Partial<LinkOptions> = {}, items = 0) {
  const s = scene();
  const epoch = s.epoch();
  for (let i = 0; i < items; i++) s.wire.put(4, prompt(s, epoch, fill(20 + i, 16), i + 1));
  const kept: Kept = { ids: [], head: undefined, putBack: false };
  const link = new Link({
    who: s.who,
    keys: s.bot.device,
    sign: s.bot.sign,
    kept,
    ...over,
  });
  const log: Effect[] = [];
  let frames: Frame[] | undefined; // one read of the wire: a head signs afresh each time
  const heard = new Set<number>(); // connections the device proved on
  const note = (fx: Effect[]) => {
    for (const e of fx) {
      log.push(e);
      if (e.do === "send" && sent(e.bytes).type.startsWith("prove-")) heard.add(e.conn);
    }
    return fx;
  };
  return {
    s,
    epoch,
    link,
    /** The frames of a read of the wire as it stands at the first call. */
    read: () => (frames ??= s.wire.read()),
    log,
    note,
    /** The relay sends each of `frames` on `conn` and the store answers every `persist` with success. */
    give(conn: number, frames: Frame[], now: number): Effect[] {
      return frames.flatMap((f) => {
        const before = f.type === "hello" || (f.type === "refused" && !heard.has(conn));
        const out = note(link.received(conn, encodeFrame(f, !before), now));
        for (let more = out; more.some((e) => e.do === "persist"); ) {
          more = note(link.persisted(true, now));
          out.push(...more);
        }
        return out;
      });
    },
    /** One chunk of proven frames, with no answer to a `persist`. */
    chunk(conn: number, frames: Frame[], now: number): Effect[] {
      const parts = frames.map((f) => encodeFrame(f, true));
      return note(link.received(conn, new Uint8Array(parts.flatMap((p) => [...p])), now));
    },
    /** The device dials, TLS comes up and `hello` arrives. */
    hello(now = 0, conn = 1): Effect[] {
      return [
        ...note(link.opened(conn, BINDING, now)),
        ...this.give(conn, [{ type: "hello", relayNonce: NONCE }], now),
      ];
    },
    /** Dial, hello, served, a read of the wire: the link is at rest at `now`. */
    toRest(now = 0): Effect[] {
      const fx = [...note(link.start(now)), ...this.hello(now)];
      return [...fx, ...this.give(1, [s.wire.served(), ...this.read()], now)];
    },
  };
}

const sent = (bytes: Bytes): Frame => {
  const f = decodeFrame(bytes, false, "relay");
  const g = f.ok ? f : decodeFrame(bytes, true, "relay");
  assert.ok(g.ok);
  return g.value;
};
const sends = (fx: Effect[]): Frame[] =>
  fx.flatMap((e) => (e.do === "send" ? [sent(e.bytes)] : []));
const dos = (fx: Effect[]) => fx.map((e) => e.do);
const wake = (fx: Effect[]) => fx.filter((e) => e.do === "wake").at(-1);
const dials = (fx: Effect[]) => fx.filter((e) => e.do === "dial");

test("2.1.1 start dials at once, and a stored put-back or fault delivers itself and never dials", () => {
  const a = rig();
  assert.deepEqual(a.link.start(5), [
    { do: "dial", conn: 1, purpose: "active" },
    { do: "wake", at: 5 + 30_000 },
  ]);
  const putBack = rig({ kept: { ids: [], head: undefined, putBack: true } });
  assert.deepEqual(putBack.link.start(0), [{ do: "deliver", out: { do: "put-back" } }]);
  assert.equal(putBack.link.state, "put-back");
  const fault = rig({ stored: { fault: true } });
  assert.deepEqual(fault.link.start(0), [{ do: "deliver", out: { do: "fault", why: "stored" } }]);
  assert.deepEqual(fault.link.tick(10 ** 9), []);
});

test("2.1.2 one PATIENCE covers the handshake and the wait for hello", () => {
  const a = rig();
  a.link.start(0);
  assert.deepEqual(a.link.tick(29_999), [{ do: "wake", at: 30_000 }]);
  assert.equal(a.link.state, "dialing");
  assert.deepEqual(dos(a.link.tick(30_000)).slice(0, 1), ["close"]);
  assert.equal(a.link.state, "waiting", "a dial that never came up is dropped");
  const b = rig();
  b.link.start(0);
  b.link.opened(1, BINDING, 10_000);
  assert.equal(b.link.state, "hello");
  assert.deepEqual(
    b.link.tick(20_000),
    [{ do: "wake", at: 30_000 }],
    "the dial's deadline still holds",
  );
  assert.equal(b.link.tick(30_000)[0]?.do, "close", "no hello within PATIENCE of the dial");
});

test("2.1.3 the proof goes out as soon as hello arrives, and a link with no frame for PATIENCE before rest is dropped", () => {
  const a = rig();
  a.link.start(0);
  const fx = a.hello(1000);
  assert.deepEqual(
    sends(fx).map((f) => f.type),
    ["prove-active"],
  );
  assert.equal(a.link.state, "proving");
  assert.deepEqual(wake(fx), { do: "wake", at: 31_000 });
  const fed = a.give(1, [a.s.wire.served()], 20_000);
  assert.deepEqual(wake(fed), { do: "wake", at: 50_000 }, "a frame moves the deadline");
  assert.deepEqual(dos(a.link.tick(50_000)).slice(0, 1), ["close"]);
  assert.equal(a.link.state, "waiting");
});

test("2.1.4 at rest a read goes out ASK after the last frame sent, a position answers it, none within PATIENCE drops", () => {
  const a = rig();
  const fx = a.toRest(0);
  assert.equal(a.link.state, "rest");
  assert.deepEqual(wake(fx), { do: "wake", at: 600_000 });
  const ping = a.link.tick(600_000);
  assert.deepEqual(sends(ping), [{ type: "read", from: a.link.reading.cursor }]);
  assert.deepEqual(wake(ping), { do: "wake", at: 630_000 });
  const answered = a.give(
    1,
    [{ type: "position", from: 0, incarnation: a.s.wire.incarnation }],
    610_000,
  );
  assert.deepEqual(wake(answered), { do: "wake", at: 1_200_000 }, "the next keepalive is ASK on");
  assert.equal(a.link.state, "rest");
  a.link.tick(1_200_000);
  const dropped = a.link.tick(1_230_000);
  assert.equal(dropped[0]?.do, "close");
  assert.equal(a.link.state, "waiting");
});

test("2.1.5 and 7.1 a tick before the earliest deadline emits that wake again and nothing else", () => {
  const a = rig();
  a.toRest(0);
  assert.deepEqual(a.link.tick(599_999), [{ do: "wake", at: 600_000 }]);
  assert.deepEqual(
    a.link.tick(599_999),
    [{ do: "wake", at: 600_000 }],
    "the timer is spent each time",
  );
  assert.equal(a.link.state, "rest");
});

test("2.1.6 submit sends only at rest, and a result for no request in flight is ignored", () => {
  const a = rig();
  const item = a.s.alice.genesis;
  assert.equal(a.link.submit(1, item.signed, item.sig, 0), "busy", "not even dialed");
  a.toRest(0);
  const r = a.link.submit(1, item.signed, item.sig, 100);
  assert.ok(r !== "busy");
  assert.equal(r.request, 2);
  assert.deepEqual(sends(r.effects), [
    { type: "submit", request: 2, kind: 1, signed: item.signed, sig: item.sig },
  ]);
  assert.ok(a.link.submit(1, item.signed, item.sig, 100) !== "busy", "several in flight (D5)");
  assert.deepEqual(
    a.give(1, [{ type: "result", request: 9, code: 0 }], 200).filter((e) => e.do === "answer"),
    [],
  );
  assert.deepEqual(
    a.give(1, [{ type: "result", request: 2, code: 0 }], 300).filter((e) => e.do === "answer"),
    [{ do: "answer", request: 2, code: 0 }],
  );
  assert.ok(a.link.submit(1, item.signed, item.sig, 400) !== "busy", "free again");
});

test("2.1.6 giveSeal sends a give-seal at rest only, numbered with the submits, and its result is answered", () => {
  const a = rig();
  const e = a.epoch;
  const late = keyed("app");
  const made = historySeal(a.s.epochs[0] as LoggedEpoch, a.s.alice.first, late, e.key);
  assert.equal(a.link.giveSeal(made.seal, made.sig, 0), "busy", "not even dialed");
  a.toRest(0);
  const r = a.link.giveSeal(made.seal, made.sig, 100);
  assert.ok(r !== "busy");
  assert.deepEqual(sends(r.effects), [
    { type: "give-seal", request: r.request, seal: made.seal, sig: made.sig },
  ]);
  const item = a.s.alice.genesis;
  const next = a.link.submit(1, item.signed, item.sig, 100);
  assert.ok(next !== "busy" && next.request === r.request + 1, "one request counter");
  assert.deepEqual(
    a
      .give(1, [{ type: "result", request: r.request, code: 0 }], 200)
      .filter((x) => x.do === "answer"),
    [{ do: "answer", request: r.request, code: 0 }],
  );
});

test("2.1.6 two submits in flight are each answered by their own result", () => {
  const a = rig();
  a.toRest(0);
  const item = a.s.alice.genesis;
  const [one, two] = [
    a.link.submit(1, item.signed, item.sig, 100),
    a.link.submit(1, item.signed, item.sig, 200),
  ];
  assert.ok(one !== "busy" && two !== "busy");
  assert.deepEqual([one.request, two.request], [2, 3]);
  const answers = (id: number, code: 0 | 1, now: number) =>
    a.give(1, [{ type: "result", request: id, code }], now).filter((e) => e.do === "answer");
  assert.deepEqual(answers(3, 1, 300), [{ do: "answer", request: 3, code: 1 }]);
  assert.deepEqual(answers(2, 0, 400), [{ do: "answer", request: 2, code: 0 }]);
  assert.deepEqual(answers(2, 0, 500), [], "answered once");
});

test("2.1.6 a request deadline that passes drops the connection and answers every request in flight unanswered", () => {
  const a = rig();
  a.toRest(0);
  const item = a.s.alice.genesis;
  a.link.submit(1, item.signed, item.sig, 100);
  const second = a.link.submit(1, item.signed, item.sig, 20_000);
  assert.ok(second !== "busy");
  assert.deepEqual(wake(second.effects), { do: "wake", at: 30_100 }, "the earliest request's");
  const fx = a.link.tick(30_100);
  assert.deepEqual(
    fx.filter((e) => e.do === "answer"),
    [
      { do: "answer", request: 2, code: "unanswered" },
      { do: "answer", request: 3, code: "unanswered" },
    ],
  );
  assert.deepEqual(
    fx.find((e) => e.do === "close"),
    {
      do: "close",
      conn: 1,
      why: "no answer to a request for 30 s, connection dropped",
    },
  );
  assert.equal(a.link.state, "waiting");
});

test("an upload's deadline says hello before its proof is sent and the give-back's answer after", () => {
  const upload = (hello: boolean) => {
    const a = rig({}, 1);
    a.toRest(0);
    a.link.tick(600_000);
    a.link.tick(630_000);
    a.link.tick(631_000);
    a.hello(631_000, 2);
    a.give(
      2,
      [
        a.s.wire.served(),
        { type: "position", from: 0, incarnation: a.s.wire.incarnation },
        a.s.wire.head(0),
      ],
      632_000,
    );
    a.link.opened(3, BINDING, 632_000);
    if (hello) a.give(3, [{ type: "hello", relayNonce: NONCE }], 632_000);
    return (a.link.tick(662_000).find((e) => e.do === "close") as { why: string }).why;
  };
  assert.equal(upload(false), "no hello for 30 s, connection dropped");
  assert.equal(upload(true), "no answer to the give-back for 30 s, connection dropped");
});

test("a deadline that passes says which in `why`", () => {
  const closeAt = (a: ReturnType<typeof rig>, now: number) =>
    a.link.tick(now).find((e) => e.do === "close");
  const dialing = rig();
  dialing.link.start(0);
  assert.equal(
    (closeAt(dialing, 30_000) as { why: string }).why,
    "no hello for 30 s, connection dropped",
  );
  const reading = rig();
  reading.link.start(0);
  reading.hello(0);
  reading.give(1, [reading.s.wire.served()], 1);
  assert.equal(
    (closeAt(reading, 30_001) as { why: string }).why,
    "no frame for 30 s, connection dropped",
  );
});

test("2.1.6 and 7.1 a lost result answers unanswered after PATIENCE and closes the link, while keepalive reads are answered", () => {
  const a = rig();
  a.toRest(0);
  const item = a.s.alice.genesis;
  const r = a.link.submit(1, item.signed, item.sig, 100);
  assert.ok(r !== "busy");
  assert.deepEqual(wake(r.effects), { do: "wake", at: 30_100 });
  const fx = a.link.tick(30_100);
  assert.deepEqual(dos(fx).slice(0, 2), ["close", "answer"]);
  assert.deepEqual(fx[1], { do: "answer", request: 2, code: "unanswered" });
  assert.equal(a.link.state, "waiting");
  // A request still waiting while keepalives run: ASK is past PATIENCE, so the request goes first;
  // here the keepalive is answered and the link stays until the request's own deadline.
  const b = rig({ constants: { ...SHORT, ask: 10_000 } });
  b.toRest(0);
  const s = b.link.submit(1, item.signed, item.sig, 5000);
  assert.ok(s !== "busy");
  assert.deepEqual(sends(b.link.tick(10_000)), [{ type: "read", from: b.link.reading.cursor }]);
  b.give(1, [{ type: "position", from: 0, incarnation: b.s.wire.incarnation }], 12_000);
  assert.equal(b.link.state, "rest", "the keepalive was answered");
  assert.deepEqual(b.link.tick(35_000)[1], { do: "answer", request: 2, code: "unanswered" });
});

test("2.1.7 a changed incarnation is persisted before it is delivered; rest persists kept when it changed, resets the back-off and clears slow", () => {
  const a = rig();
  const fx = a.toRest(0);
  const at = (d: string) => fx.findIndex((e) => e.do === d);
  assert.equal(
    fx.find((e) => e.do === "persist" && "what" in e && "incarnation" in e.what) !== undefined,
    true,
  );
  const persists = fx.flatMap((e, i) => (e.do === "persist" ? [i] : []));
  assert.equal(persists.length, 2, "the incarnation, and kept at rest");
  const deliverInc = fx.findIndex((e) => e.do === "deliver" && e.out.do === "incarnation");
  assert.ok((persists[0] as number) < deliverInc, "persist precedes the deliver it covers");
  const deliverRest = fx.findIndex((e) => e.do === "deliver" && e.out.do === "rest");
  assert.ok((persists[1] as number) < deliverRest);
  assert.ok(at("deliver") > 0);
  // The same incarnation and nothing new read: nothing to persist.
  a.link.tick(600_000);
  a.link.tick(630_000); // dropped, waiting 1000 (back-off was reset at rest)
  assert.equal(a.link.state, "waiting");
  const back = a.link.tick(631_000);
  assert.equal(dials(back).length, 1);
  a.hello(631_000, 2);
  const again = a.give(2, [a.s.wire.served(), ...a.read()], 631_000);
  assert.deepEqual(
    again.filter((e) => e.do === "persist"),
    [],
    "nothing changed",
  );
});

test("2.1.7 put-back and fault persist, deliver, close and dial no more", () => {
  const a = rig();
  a.toRest(0);
  a.s.wire.incarnation = fill(8, 16);
  a.give(1, [{ type: "refused", reason: 6 }], 10);
  assert.equal(a.link.state, "put-back");
  const b = rig();
  b.link.start(0);
  b.hello(0);
  const bad = { ...b.s.wire.head(), sig: fill(1, 64) };
  const fx = b.give(1, [b.s.wire.served(), bad], 1);
  const i = fx.findIndex((e) => e.do === "persist" && "fault" in e.what);
  assert.deepEqual(fx[i], { do: "persist", what: { fault: true } });
  assert.deepEqual(fx[i + 1]?.do, "deliver");
  assert.equal(b.link.state, "fault");
  assert.equal(
    fx.some((e) => e.do === "close"),
    true,
  );
  assert.deepEqual(b.link.tick(10 ** 9), [], "no wake, no dial");
  assert.deepEqual(b.link.networkUp(10 ** 9), []);
});

test("2.1.8 refused 1 and 5, and 2 with a head held, wait ASK; the others the back-off", () => {
  for (const [reason, slow] of [
    [1, true],
    [5, true],
    [3, false],
    [2, false],
  ] as const) {
    const a = rig();
    a.link.start(0);
    a.hello(0);
    a.give(1, [{ type: "refused", reason }], 10);
    assert.equal(a.link.state, "waiting");
    assert.equal(
      a.link.tick(10 + (slow ? 599_999 : 999)).some((e) => e.do === "dial"),
      false,
    );
    assert.equal(
      a.link.tick(10 + (slow ? 600_000 : 1000)).some((e) => e.do === "dial"),
      true,
    );
  }
});

test("2.1.8 refused 2 with a head held gives it back first, and a give-back refused with 2 waits ASK", () => {
  const a = rig({ constants: SHORT });
  a.toRest(0);
  a.link.tick(600_000);
  a.link.tick(630_000);
  a.link.tick(631_000);
  a.hello(631_000, 2);
  const fx = a.give(2, [{ type: "refused", reason: 2 }], 632_000);
  assert.deepEqual(dials(fx), [{ do: "dial", conn: 3, purpose: "upload" }]);
  a.link.opened(3, BINDING, 632_000);
  a.give(3, [{ type: "hello", relayNonce: NONCE }], 632_000);
  const end = a.give(3, [{ type: "refused", reason: 2 }], 633_000);
  assert.deepEqual(
    wake(end),
    { do: "wake", at: 633_000 + 600_000 },
    "the give-back refused with 2 waits ASK",
  );
  assert.equal(a.link.state, "waiting");
});

test("2.1.9 every drop tells the Reading and the wait doubles from FIRST to MAX, back to FIRST at rest", () => {
  const a = rig();
  a.toRest(0);
  assert.equal(a.link.reading.state, "rest");
  a.link.closed(1, 100);
  assert.equal(a.link.reading.state, "reading", "dropped() was called");
  let now = 100;
  let conn = 1;
  const waits: number[] = [];
  for (let i = 0; i < 9; i++) {
    const at = (wake(a.link.tick(now)) as { at: number }).at;
    waits.push(at - now);
    now = at;
    assert.equal(dials(a.link.tick(now))[0]?.conn, ++conn);
    a.link.closed(conn, now);
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  a.link.tick(now + 60_000);
  a.hello(now + 60_000, ++conn);
  a.give(conn, [a.s.wire.served(), ...a.read()], now + 60_000);
  assert.equal(a.link.state, "rest");
  const after = a.link.closed(conn, now + 70_000);
  assert.deepEqual(wake(after), { do: "wake", at: now + 71_000 }, "rest reset the back-off");
});

test("2.1.10 a reading that turns to giving-back dials an upload at once, sends both frames, and tells the Reading the answer", () => {
  const a = rig({ kept: { ids: [], head: undefined, putBack: false } }, 1);
  a.toRest(0);
  // The relay now lacks what was read: an older head than the one held.
  a.link.tick(600_000);
  a.link.tick(630_000);
  a.link.tick(631_000);
  a.hello(631_000, 2);
  const lacking = a.s.wire.head(0);
  const fx = a.give(
    2,
    [a.s.wire.served(), { type: "position", from: 0, incarnation: a.s.wire.incarnation }, lacking],
    632_000,
  );
  assert.deepEqual(
    dos(fx).filter((d) => d === "dial"),
    ["dial"],
  );
  assert.equal(a.link.state, "uploading");
  assert.deepEqual(
    fx.find((e) => e.do === "dial"),
    { do: "dial", conn: 3, purpose: "upload" },
  );
  const closeAt = fx.findIndex((e) => e.do === "close");
  const dialAt = fx.findIndex((e) => e.do === "dial");
  assert.ok(closeAt < dialAt, "the active connection is torn down first");
  const up = a.link.opened(3, BINDING, 632_000);
  assert.deepEqual(
    up.filter((e) => e.do !== "wake"),
    [],
  );
  const out = a.give(3, [{ type: "hello", relayNonce: NONCE }], 640_000);
  assert.deepEqual(
    sends(out).map((f) => f.type),
    ["prove-upload", "upload-done"],
  );
  assert.deepEqual(wake(out), { do: "wake", at: 670_000 });
  const done = a.give(3, [{ type: "result", request: 1, code: 0 }], 641_000);
  assert.equal(a.link.reading.state, "put-back", "result 0 puts the relay back");
  assert.equal(
    done.some((e) => e.do === "persist"),
    true,
  );
});

test("2.1.10 an upload that is refused with a reason other than 6 waits ASK; one cut waits the back-off", () => {
  const upload = () => {
    const a = rig({}, 1);
    a.toRest(0);
    a.link.tick(600_000);
    a.link.tick(630_000);
    a.link.tick(631_000);
    a.hello(631_000, 2);
    a.give(
      2,
      [
        a.s.wire.served(),
        { type: "position", from: 0, incarnation: a.s.wire.incarnation },
        a.s.wire.head(0),
      ],
      632_000,
    );
    a.link.opened(3, BINDING, 632_000);
    a.give(3, [{ type: "hello", relayNonce: NONCE }], 632_000);
    return a;
  };
  const refused = upload();
  const ended = refused.give(3, [{ type: "refused", reason: 3 }], 633_000);
  assert.deepEqual(
    ended.find((e) => e.do === "close"),
    { do: "close", conn: 3, why: "give-back refused, reason 3" },
  );
  assert.equal(refused.link.state, "waiting");
  assert.equal(
    refused.link.tick(633_000 + 599_999).some((e) => e.do === "dial"),
    false,
  );
  assert.equal(
    refused.link.tick(633_000 + 600_000).some((e) => e.do === "dial"),
    true,
  );
  const cut = upload();
  const fx = cut.link.closed(3, 633_000);
  assert.deepEqual(dials(fx), [], "a cut upload does not dial again at once");
  assert.equal(cut.link.state, "waiting");
  assert.deepEqual(wake(fx), { do: "wake", at: 633_000 + 2000 });
  assert.equal(
    cut.link.reading.state,
    "reading",
    "gaveBack(undefined): the next read finds it again",
  );
});

test("2.1.11 a failed sign is a drop", () => {
  const broke = Object.assign(Object.create(platform), {
    sign: () => ({ ok: false, error: "io-failed" }),
  });
  const a = rig();
  const link = new Link({
    who: { ...a.s.who, platform: broke },
    keys: a.s.bot.device,
    sign: a.s.bot.sign,
    kept: { ids: [], head: undefined, putBack: false },
  });
  link.start(0);
  link.opened(1, BINDING, 0);
  const fx = link.received(1, encodeFrame({ type: "hello", relayNonce: NONCE }, false), 0);
  assert.deepEqual(fx[0], {
    do: "close",
    conn: 1,
    why: "connection error: the platform did not sign",
  });
  assert.equal(link.state, "waiting");
});

test("2.1.12 a bad length or an undecodable frame closes the connection", () => {
  const a = rig();
  a.link.start(0);
  a.link.opened(1, BINDING, 0);
  const fx = a.link.received(1, new Uint8Array([0, 0, 0, 0]), 0);
  assert.equal(fx[0]?.do, "close");
  const b = rig();
  b.link.start(0);
  b.link.opened(1, BINDING, 0);
  const junk = b.link.received(1, new Uint8Array([0, 0, 0, 1, 0xee]), 0);
  assert.equal(junk[0]?.do, "close");
  assert.equal(b.link.state, "waiting");
});

test("4.3 hello: a frame other than hello or refused is dropped; refused before the proof goes through the Reading", () => {
  const a = rig();
  a.link.start(0);
  a.link.opened(1, BINDING, 0);
  const fx = a.link.received(1, encodeFrame({ type: "served", incarnation: fill(1, 16) }, true), 0);
  assert.equal(fx[0]?.do, "close", "served does not cross before a proof");
  const b = rig();
  b.link.start(0);
  b.link.opened(1, BINDING, 0);
  const refused = b.give(1, [{ type: "refused", reason: 5 }], 0);
  assert.deepEqual(
    refused.find((e) => e.do === "deliver"),
    { do: "deliver", out: { do: "refused", reason: 5 } },
  );
  assert.equal(b.link.state, "waiting");
});

test("4.3 reading and rest: a frame that leaves rest returns to reading; networkUp probes with a read", () => {
  const a = rig();
  a.toRest(0);
  const from = a.s.wire.items.length;
  a.s.wire.put(4, prompt(a.s, a.epoch, fill(30, 16), 1));
  a.give(1, a.s.wire.push(from).slice(0, 1), 100);
  assert.equal(a.link.state, "reading");
  const probe = a.link.networkUp(200);
  assert.deepEqual(sends(probe), [{ type: "read", from: a.link.reading.cursor }]);
  assert.deepEqual(wake(probe), { do: "wake", at: 30_200 });
  assert.deepEqual(sends(a.link.networkUp(201)), [], "one probe at a time");
});

test("4.3 waiting: networkUp dials at once after a back-off and keeps the wait after a refusal", () => {
  const a = rig();
  a.link.start(0);
  a.link.closed(1, 10);
  assert.deepEqual(dials(a.link.networkUp(20)), [{ do: "dial", conn: 2, purpose: "active" }]);
  const b = rig();
  b.link.start(0);
  b.hello(0);
  b.give(1, [{ type: "refused", reason: 1 }], 10);
  assert.deepEqual(dials(b.link.networkUp(20)), []);
});

test("4.3 stopped: stop closes, answers the request in flight, and never dials again", () => {
  const a = rig();
  a.toRest(0);
  const item = a.s.alice.genesis;
  a.link.submit(1, item.signed, item.sig, 1);
  const fx = a.link.stop(2);
  assert.deepEqual(fx, [
    { do: "close", conn: 1 },
    { do: "answer", request: 2, code: "unanswered" },
  ]);
  assert.equal(a.link.state, "stopped");
  assert.deepEqual(a.link.tick(10 ** 9), []);
  assert.deepEqual(a.link.networkUp(10 ** 9), []);
  assert.deepEqual(a.link.stop(3), []);
});

test("7.1 stop in the middle of a dial never dials, and its late closed is ignored", () => {
  const a = rig();
  a.link.start(0);
  assert.deepEqual(a.link.stop(1), [{ do: "close", conn: 1 }]);
  assert.deepEqual(a.link.closed(1, 2), []);
  assert.deepEqual(a.link.tick(10 ** 9), []);
});

test("7.1 a closed for an old token is ignored, and does not tear down the upload that replaced it", () => {
  const a = rig({}, 1);
  a.toRest(0);
  a.link.tick(600_000);
  a.link.tick(630_000);
  a.link.tick(631_000);
  a.hello(631_000, 2);
  a.give(
    2,
    [
      a.s.wire.served(),
      { type: "position", from: 0, incarnation: a.s.wire.incarnation },
      a.s.wire.head(0),
    ],
    632_000,
  );
  assert.equal(a.link.state, "uploading");
  assert.deepEqual(
    dos(a.link.closed(2, 632_001)),
    ["wake"],
    "the socket the link closed reports its end late",
  );
  assert.equal(a.link.state, "uploading");
  assert.deepEqual(dos(a.link.received(2, new Uint8Array([0, 0, 0, 0]), 632_002)), ["wake"]);
});

test("7.1 under the Clock seam of section 5, a clock that does not move yields the recorded delays", () => {
  // The driver's shape: a `wake` in `waiting` goes to `wait(at - now)`, which returns at once
  // without moving `now`; the driver then ticks `max(now, at)`. connection.test.ts records [1000, 2000].
  const a = rig();
  const delays: number[] = [];
  let now = 0;
  let fx = a.link.start(now);
  for (let cycle = 0; cycle < 3; cycle++) {
    const dial = dials(fx).at(-1);
    assert.ok(dial);
    fx = a.link.closed(dial.conn, now);
    const w = wake(fx);
    assert.equal(a.link.state, "waiting");
    assert.ok(w?.do === "wake");
    delays.push(w.at - now);
    assert.deepEqual(a.link.tick(now), [w], "no dial from a stale deadline: now has not moved");
    fx = a.link.tick(Math.max(now, w.at));
    assert.deepEqual(
      wake(fx),
      { do: "wake", at: Math.max(now, w.at) + 30_000 },
      "the dial's own deadline",
    );
    now = 0;
  }
  assert.deepEqual(delays, [1000, 2000, 4000]);
  const refused = rig();
  refused.link.start(0);
  refused.hello(0);
  refused.give(1, [{ type: "refused", reason: 5 }], 0);
  const slow: number[] = [];
  for (let i = 0; i < 2; i++) {
    const w = wake(refused.link.tick(0)) as { at: number };
    slow.push(w.at);
    const dialed = refused.link.tick(Math.max(0, w.at));
    assert.equal(dials(dialed).length, 1);
    refused.link.closed(dials(dialed)[0]?.conn as number, 0);
  }
  assert.deepEqual(slow, [600_000, 600_000]);
});

test("4.4.1 no frame is sent before opened or before hello", () => {
  const a = rig();
  a.link.start(0);
  const early = a.link.received(1, encodeFrame({ type: "hello", relayNonce: NONCE }, false), 0);
  assert.deepEqual(sends(early), []);
  assert.deepEqual(sends(a.log), []);
  const opened = a.link.opened(1, BINDING, 0);
  assert.deepEqual(sends(opened), [], "opened sends nothing: the proof waits for hello");
});

test("4.4.2 the proof binds the binding of the connection it is sent on", () => {
  const a = rig();
  a.link.start(0);
  a.link.opened(1, fill(1), 0);
  a.link.closed(1, 0);
  a.link.tick(1000);
  a.link.opened(2, fill(2), 1000);
  const fx = a.give(2, [{ type: "hello", relayNonce: NONCE }], 1000);
  const prove = sends(fx)[0];
  assert.ok(prove?.type === "prove-active");
  const verdict = checkProof(
    platform,
    prove.proof,
    [prove.sig],
    { relayPublic: a.s.wire.key.keys.signing, relayNonce: NONCE, binding: fill(2) },
    a.s.bot.keys,
  );
  assert.deepEqual(verdict, { ok: true });
  assert.deepEqual(prove.proof.binding, fill(2));
});

test("4.4.3 no submit while the Reading is not sendable", () => {
  const a = rig();
  a.link.start(0);
  a.hello(0);
  const item = a.s.alice.genesis;
  assert.equal(a.link.submit(1, item.signed, item.sig, 0), "busy", "proving");
  a.give(1, [a.s.wire.served()], 1);
  assert.equal(a.link.submit(1, item.signed, item.sig, 1), "busy", "reading");
  assert.deepEqual(
    sends(a.log).filter((f) => f.type === "submit"),
    [],
  );
});

test("4.4.4 at most one connection is current: no dial while one is", () => {
  const a = rig();
  const fx = [
    ...a.link.start(0),
    ...a.link.networkUp(1),
    ...a.link.tick(2),
    ...a.link.tick(30_000),
  ];
  assert.equal(dials(fx).length, 1, "the dial, then the drop and a wait");
  a.link.closed(1, 30_000);
  const next = a.link.tick(31_000);
  assert.deepEqual(
    dials(next).map((d) => d.conn),
    [2],
  );
  assert.deepEqual(dials(a.link.networkUp(31_001)), []);
});

test("4.4.5 networkUp never cuts the ASK wait after a refusal or a refused upload", () => {
  const a = rig();
  a.link.start(0);
  a.hello(0);
  a.give(1, [{ type: "refused", reason: 5 }], 0);
  for (let t = 1; t < 5; t++) assert.deepEqual(dials(a.link.networkUp(t * 1000)), []);
  assert.equal(a.link.state, "waiting");
  assert.deepEqual(wake(a.link.tick(10)), { do: "wake", at: 600_000 });
});

test("4.4.6 every request in flight gets exactly one answer", () => {
  for (const end of ["result", "drop", "stop", "late"] as const) {
    const a = rig();
    a.toRest(0);
    const item = a.s.alice.genesis;
    a.link.submit(1, item.signed, item.sig, 0);
    const fx: Effect[] = [];
    if (end === "result") fx.push(...a.give(1, [{ type: "result", request: 2, code: 0 }], 1));
    if (end === "drop") fx.push(...a.link.closed(1, 1));
    if (end === "stop") fx.push(...a.link.stop(1));
    if (end === "late") fx.push(...a.link.tick(30_000));
    fx.push(...a.link.closed(1, 40_000), ...a.link.tick(100_000));
    assert.equal(fx.filter((e) => e.do === "answer").length, 1, end);
  }
});

test("4.4.7 every state but put-back, fault and stopped holds a deadline", () => {
  const a = rig();
  const seen: string[] = [];
  const check = () => {
    assert.equal(
      a.link.tick(0).some((e) => e.do === "wake"),
      true,
      a.link.state,
    );
    seen.push(a.link.state);
  };
  a.link.start(0);
  check();
  a.link.opened(1, BINDING, 0);
  check();
  a.give(1, [{ type: "hello", relayNonce: NONCE }], 0);
  check();
  a.give(1, [a.s.wire.served()], 0);
  check();
  a.give(1, a.read(), 0);
  check();
  a.link.closed(1, 0);
  check();
  assert.deepEqual(seen, ["dialing", "hello", "proving", "reading", "rest", "waiting"]);
});

test("4.4.8 put-back, fault and stopped dial no more", () => {
  const a = rig();
  a.link.start(0);
  a.link.stop(0);
  for (const t of [1, 10 ** 6, 10 ** 12]) {
    assert.deepEqual(a.link.tick(t), []);
    assert.deepEqual(a.link.networkUp(t), []);
  }
});

test("4.4.9 a length over the limit of the state closes the connection before its body is read", () => {
  const a = rig();
  a.link.start(0);
  a.link.opened(1, BINDING, 0);
  const over = new Uint8Array(4);
  new DataView(over.buffer).setUint32(0, 4097);
  assert.equal(a.link.received(1, over, 0)[0]?.do, "close", "4,096 before a proof");
  const b = rig();
  b.toRest(0);
  const big = new Uint8Array(4);
  new DataView(big.buffer).setUint32(0, 1_048_577);
  assert.equal(b.link.received(1, big, 1)[0]?.do, "close", "1 MiB after it");
  const ok = new Uint8Array(4);
  new DataView(ok.buffer).setUint32(0, 1_048_576);
  const c = rig();
  c.toRest(0);
  assert.deepEqual(dos(c.link.received(1, ok, 1)), ["wake"], "at the limit, the body is awaited");
});

test("B: a frame arriving one byte at a time is cut once it is whole", () => {
  const a = rig();
  a.link.start(0);
  a.link.opened(1, BINDING, 0);
  const bytes = encodeFrame({ type: "hello", relayNonce: NONCE }, false);
  const out = [...bytes].flatMap((b) => a.link.received(1, new Uint8Array([b]), 0));
  assert.deepEqual(
    sends(out).map((f) => f.type),
    ["prove-active"],
  );
});

test("bytes of one frame in pieces are one frame", () => {
  const a = rig();
  a.link.start(0);
  a.link.opened(1, BINDING, 0);
  const bytes = encodeFrame({ type: "hello", relayNonce: NONCE }, false);
  const half = a.link.received(1, bytes.subarray(0, 3), 0);
  assert.deepEqual(sends(half), []);
  const rest = a.link.received(1, bytes.subarray(3, 9), 0);
  assert.deepEqual(sends(rest), []);
  const done = a.link.received(1, bytes.subarray(9), 0);
  assert.deepEqual(
    sends(done).map((f) => f.type),
    ["prove-active"],
  );
});

test("W: a call that leaves the link live ends with its wake even when the deadline did not move", () => {
  const a = rig();
  a.toRest(0);
  const fx = a.give(1, [{ type: "refused", reason: 3 }], 599_000);
  assert.equal(dos(fx).includes("close"), true);
  assert.deepEqual(
    wake(fx),
    { do: "wake", at: 600_000 },
    "the wait ends where the keepalive deadline was",
  );
  const b = rig();
  b.toRest(0);
  const frozen = b.give(1, [{ type: "refused", reason: 5 }], 0);
  assert.deepEqual(wake(frozen), { do: "wake", at: 600_000 }, "ASK from the frozen clock");
});

test("P: a persist that fails drops the connection, and what it covered is emitted again on the next one", () => {
  const a = rig({}, 1);
  a.link.start(0);
  a.hello(0);
  const first = a.chunk(1, [a.s.wire.served(), ...a.read()], 1);
  const persist = first.find((e) => e.do === "persist");
  assert.deepEqual(persist?.do === "persist" && "incarnation" in persist.what, true);
  assert.deepEqual(dos(first), ["persist"], "the persist ends the call: nothing else, no wake");
  const failed = a.link.persisted(false, 2);
  assert.deepEqual(dos(failed).slice(0, 1), ["close"]);
  assert.equal(a.link.state, "waiting");
  assert.equal(
    failed.some((e) => e.do === "deliver"),
    false,
    "the held frames are dropped with the connection",
  );
  a.link.tick(1002);
  a.hello(1002, 2);
  const again: Effect[] = a.chunk(2, [a.s.wire.served(), ...a.read()], 1003);
  assert.equal(
    again.some((e) => e.do === "persist" && "incarnation" in e.what),
    true,
    "emitted again",
  );
  const held = a.link.persisted(true, 1003);
  assert.deepEqual(
    dos(held),
    ["deliver", "send", "deliver", "persist"],
    "incarnation, the read, the message, then the kept write ends the call",
  );
  const kept = held.at(-1);
  assert.ok(kept?.do === "persist" && "kept" in kept.what);
  const done = a.link.persisted(true, 1004);
  assert.deepEqual(dos(done), ["deliver", "wake"]);
  assert.equal(done[0]?.do === "deliver" && done[0].out.do, "rest");
  assert.equal(a.link.state, "rest");
});

test("P: a rest whose persist failed does not reset the back-off", () => {
  const a = rig();
  a.link.start(0);
  a.link.closed(1, 0); // waits 1000, the next 2000
  a.link.tick(1000);
  a.link.closed(2, 1000); // waits 2000, the next 4000
  a.link.tick(3000);
  a.hello(3000, 3);
  a.give(3, [a.s.wire.served()], 3000);
  const held = a.chunk(3, a.read(), 3000);
  assert.equal(
    held.some((e) => e.do === "persist" && "kept" in e.what),
    true,
  );
  const failed = a.link.persisted(false, 3001);
  assert.deepEqual(wake(failed), { do: "wake", at: 3001 + 4000 });
  const b = rig();
  b.link.start(0);
  b.link.closed(1, 0);
  b.link.tick(1000);
  b.hello(1000, 2);
  b.give(2, [b.s.wire.served(), ...b.read()], 1000);
  assert.deepEqual(
    wake(b.link.closed(2, 1001)),
    { do: "wake", at: 1001 + 1000 },
    "a saved rest resets it",
  );
});

test("P: put-back and fault leave the link final, delivered and closed, whatever persisted says", () => {
  for (const ok of [true, false]) {
    for (const [name, frame] of [
      ["put-back", { type: "refused", reason: 6 }],
      ["fault", undefined],
    ] as const) {
      const a = rig();
      a.link.start(0);
      a.hello(0);
      const bad = { ...a.s.wire.head(), sig: fill(1, 64) };
      if (!frame) a.give(1, [a.s.wire.served()], 1);
      const first = a.chunk(1, frame ? [frame] : [bad], 1);
      assert.deepEqual(dos(first).at(-1), "persist");
      const rest = a.link.persisted(ok, 2);
      assert.equal(
        rest.some((e) => e.do === "deliver" && e.out.do === name),
        true,
        name,
      );
      assert.equal(
        rest.some((e) => e.do === "close"),
        true,
      );
      assert.deepEqual(dials(rest), []);
      assert.equal(a.link.state, name);
      assert.deepEqual(a.link.tick(10 ** 9), []);
    }
  }
});

test("S: start acts once, and never after stop", () => {
  const a = rig();
  a.link.start(0);
  assert.deepEqual(dos(a.link.start(1)), ["wake"], "a second start only gives the wake");
  assert.equal(dos(a.link.tick(10 ** 9)).filter((d) => d === "dial").length, 0, "no second dial");
  const b = rig();
  b.link.stop(0);
  assert.deepEqual(b.link.start(1), [], "stopped: no wake");
  assert.equal(b.link.state, "stopped");
});

test("K: a persisted kept is a copy that later frames do not change", () => {
  const a = rig({}, 1);
  const fx = a.toRest(0);
  const persist = fx.find((e) => e.do === "persist" && "kept" in e.what);
  assert.ok(persist?.do === "persist" && "kept" in persist.what);
  const [ids, head] = [persist.what.kept.ids.length, persist.what.kept.head];
  const from = a.s.wire.items.length;
  a.s.wire.put(4, prompt(a.s, a.epoch, fill(31, 16), 2));
  a.give(1, a.s.wire.push(from), 10);
  assert.equal(a.link.reading.kept.ids.length, ids + 1);
  assert.equal(persist.what.kept.ids.length, ids);
  assert.equal(persist.what.kept.head, head);
});

test("N1: a call the link ignores still gives the wake of a live link", () => {
  const a = rig();
  a.toRest(0);
  a.give(1, [{ type: "refused", reason: 3 }], 10);
  assert.deepEqual(a.link.closed(1, 11), [{ do: "wake", at: 1010 }], "an old token's closed");
  assert.deepEqual(a.link.received(1, new Uint8Array([0]), 12), [{ do: "wake", at: 1010 }]);
  assert.deepEqual(a.link.opened(1, BINDING, 13), [{ do: "wake", at: 1010 }]);
  assert.deepEqual(a.link.persisted(true, 14), [{ do: "wake", at: 1010 }], "a stale persisted");
  const b = rig();
  b.link.start(0);
  assert.deepEqual(b.link.opened(9, BINDING, 1), [{ do: "wake", at: 30_000 }], "an unknown token");
  b.hello(0);
  assert.deepEqual(b.link.opened(1, BINDING, 2), [{ do: "wake", at: 30_000 }], "opened twice");
});

test("N2: a call that emits a persist ends with it, and persisted gives the rest in the order connection.ts acts", () => {
  const a = rig();
  a.link.start(0);
  a.hello(0);
  const first = a.chunk(1, [a.s.wire.served(), { type: "refused", reason: 3 }], 5);
  assert.deepEqual(dos(first), ["persist"], "no deliver, send or wake after it");
  const rest = a.link.persisted(true, 5);
  assert.deepEqual(dos(rest), ["deliver", "send", "deliver", "close", "wake"]);
  assert.equal(rest[0]?.do === "deliver" && rest[0].out.do, "incarnation");
  assert.deepEqual(sends(rest), [{ type: "read", from: 0 }]);
  assert.equal(rest[2]?.do === "deliver" && rest[2].out.do, "refused");
  assert.deepEqual(rest.at(-1), { do: "wake", at: 1005 });
  assert.equal(a.link.state, "waiting");
});

test("pre-start: before start only start and stop act, and no wake exists", () => {
  const a = rig({ kept: { ids: [], head: undefined, putBack: true } });
  const item = a.s.alice.genesis;
  assert.equal(a.link.state, "unstarted");
  assert.deepEqual(a.link.networkUp(0), []);
  assert.deepEqual(a.link.tick(0), []);
  assert.deepEqual(a.link.opened(1, BINDING, 0), []);
  assert.deepEqual(a.link.received(1, new Uint8Array([0]), 0), []);
  assert.deepEqual(a.link.closed(1, 0), []);
  assert.deepEqual(a.link.persisted(true, 0), []);
  assert.equal(a.link.submit(1, item.signed, item.sig, 0), "busy");
  assert.deepEqual(a.link.start(0), [{ do: "deliver", out: { do: "put-back" } }]);
  const b = rig();
  assert.deepEqual(b.link.tick(10 ** 9), []);
  assert.deepEqual(b.link.stop(0), []);
  assert.equal(b.link.state, "stopped");
});

test("a head read again with a fresh signature is the same head: nothing to persist", () => {
  const a = rig();
  a.toRest(0);
  a.link.closed(1, 1);
  a.link.tick(1001);
  a.hello(1001, 2);
  const again = a.give(2, [a.s.wire.served(), ...a.s.wire.read()], 1002);
  assert.equal(
    again.some((e) => e.do === "persist"),
    false,
  );
  assert.equal(a.link.state, "rest");
});

test("P: a kept write that failed is emitted again at the next rest", () => {
  const a = rig();
  a.link.start(0);
  a.hello(0);
  a.give(1, [a.s.wire.served()], 0);
  const first = a.chunk(1, a.read(), 0);
  assert.equal(
    first.some((e) => e.do === "persist" && "kept" in e.what),
    true,
  );
  a.link.persisted(false, 1);
  a.link.tick(1001);
  a.hello(1001, 2);
  a.give(2, [a.s.wire.served()], 1001);
  const again = a.chunk(2, a.read(), 1001);
  assert.equal(
    again.some((e) => e.do === "persist" && "kept" in e.what),
    true,
  );
});

test("a throw with an empty message, or none, still closes the connection", () => {
  for (const thrown of [new Error(""), "not an error"]) {
    const broke = Object.assign(Object.create(platform), {
      sign: () => {
        throw thrown;
      },
    });
    const a = rig();
    const link = new Link({
      who: { ...a.s.who, platform: broke },
      keys: a.s.bot.device,
      sign: a.s.bot.sign,
      kept: { ids: [], head: undefined, putBack: false },
    });
    link.start(0);
    link.opened(1, BINDING, 0);
    const fx = link.received(1, encodeFrame({ type: "hello", relayNonce: NONCE }, false), 0);
    assert.deepEqual(dos(fx), ["close", "wake"]);
    assert.equal(link.state, "waiting");
  }
});

test("contract: while a persist is held every call but persisted and stop throws", () => {
  const a = rig();
  a.link.start(0);
  a.hello(0);
  a.chunk(1, [a.s.wire.served()], 1);
  const item = a.s.alice.genesis;
  const calls = [
    () => a.link.received(1, new Uint8Array([0]), 2),
    () => a.link.closed(1, 2),
    () => a.link.opened(1, BINDING, 2),
    () => a.link.tick(2),
    () => a.link.networkUp(2),
    () => a.link.submit(1, item.signed, item.sig, 2),
    () => a.link.start(2),
  ];
  for (const call of calls)
    assert.throws(call, /a persist is held: the driver must answer persisted first/);
});

test("contract: stop while a persist is held drops the rest of its call and answers the request", () => {
  const a = rig({}, 1);
  a.toRest(0);
  const item = a.s.alice.genesis;
  a.link.submit(1, item.signed, item.sig, 1);
  const from = a.s.wire.items.length;
  a.s.wire.put(4, prompt(a.s, a.epoch, fill(31, 16), 2));
  const held = a.chunk(1, a.s.wire.push(from), 2);
  assert.deepEqual(dos(held).at(-1), "persist");
  assert.deepEqual(a.link.stop(3), [
    { do: "close", conn: 1 },
    { do: "answer", request: 2, code: "unanswered" },
  ]);
  assert.equal(a.link.state, "stopped");
  assert.deepEqual(a.link.persisted(true, 4), [], "the continuation is gone");
});

test("token: a closed, opened or received for conn 0 changes nothing before start, after stop or while waiting", () => {
  const a = rig();
  assert.deepEqual(a.link.closed(0, 1), []);
  assert.deepEqual(a.link.opened(0, BINDING, 1), []);
  assert.deepEqual(a.link.received(0, new Uint8Array([0]), 1), []);
  assert.equal(a.link.state, "unstarted");
  a.link.stop(2);
  a.link.closed(0, 3);
  assert.equal(a.link.state, "stopped");
  const b = rig();
  b.link.start(0);
  b.link.closed(1, 1);
  const fx = b.link.closed(0, 2);
  assert.deepEqual(
    fx,
    [{ do: "wake", at: 1001 }],
    "waiting stays waiting, nothing is closed twice",
  );
});

test("networkUp in reading sends no read while the Reading's own read waits for its position", () => {
  const a = rig({}, 1);
  a.link.start(0);
  a.hello(0);
  const served = a.give(1, [a.s.wire.served()], 1);
  assert.deepEqual(sends(served), [{ type: "read", from: 0 }]);
  assert.deepEqual(sends(a.link.networkUp(2)), [], "its read is outstanding");
  const outs = a.give(1, a.read(), 3);
  assert.equal(outs.filter((e) => e.do === "deliver" && e.out.do === "rest").length, 1);
});

test("a held continuation takes the time persisted is given, not the emitting call's", () => {
  const a = rig();
  a.link.start(0);
  a.hello(0);
  a.chunk(1, [a.s.wire.served()], 5);
  const fx = a.link.persisted(true, 50_000);
  assert.deepEqual(wake(fx), { do: "wake", at: 80_000 }, "the read waits patience from 50,000");
  const b = rig();
  b.link.start(0);
  b.hello(0);
  b.chunk(1, [b.s.wire.served(), { type: "refused", reason: 3 }], 5);
  assert.deepEqual(
    wake(b.link.persisted(true, 50_000)),
    { do: "wake", at: 51_000 },
    "the back-off",
  );
});

test("P: a changed incarnation whose write failed is still delivered changed, at the next connection [app data design 3.4]", () => {
  const a = rig({}, 1);
  a.toRest(0);
  a.link.closed(1, 10);
  a.s.wire.incarnation = fill(8, 16); // the relay was recreated
  a.link.tick(2000);
  a.hello(2000, 2);
  const first = a.chunk(2, [a.s.wire.served(), ...a.s.wire.read()], 2001);
  assert.ok(first.some((e) => e.do === "persist" && "incarnation" in e.what));
  a.link.persisted(false, 2002);
  assert.equal(a.link.state, "waiting");
  a.link.tick(10_000);
  a.hello(10_000, 3);
  const again = a.give(3, [a.s.wire.served(), ...a.s.wire.read()], 10_001);
  const out = again.find((e) => e.do === "deliver" && e.out.do === "incarnation");
  assert.ok(out?.do === "deliver" && out.out.do === "incarnation");
  assert.equal(
    out.out.changed,
    true,
    "the Reading says false: the link carries the flag a failed write owed",
  );
});

test("P: a first rest whose write failed is still delivered first, at the next connection [app data design 3.4]", () => {
  const a = rig({}, 1);
  a.link.start(0);
  a.hello(0);
  a.chunk(1, [a.s.wire.served(), ...a.read()], 1);
  const held = a.link.persisted(true, 1); // the incarnation is stored; the rest's kept write ends the call
  assert.ok(held.at(-1)?.do === "persist");
  a.link.persisted(false, 2);
  assert.equal(a.link.state, "waiting");
  a.link.tick(2000);
  a.hello(2000, 2);
  const again = a.give(2, [a.s.wire.served(), ...a.s.wire.read()], 2001);
  const rest = again.find((e) => e.do === "deliver" && e.out.do === "rest");
  assert.ok(rest?.do === "deliver" && rest.out.do === "rest");
  assert.equal(
    rest.out.first,
    true,
    "the Reading says false: the link carries the flag a failed write owed",
  );
});

test("P: an owed flag survives a second failed write [app data design 3.4]", () => {
  const a = rig({}, 1);
  a.toRest(0);
  a.link.closed(1, 10);
  a.s.wire.incarnation = fill(8, 16);
  for (const [at, conn] of [
    [2000, 2],
    [10_000, 3],
  ] as const) {
    a.link.tick(at);
    a.hello(at, conn);
    a.chunk(conn, [a.s.wire.served(), ...a.s.wire.read()], at + 1);
    a.link.persisted(false, at + 2);
  }
  a.link.tick(80_000);
  a.hello(80_000, 4);
  const again = a.give(4, [a.s.wire.served(), ...a.s.wire.read()], 80_001);
  const out = again.find((e) => e.do === "deliver" && e.out.do === "incarnation");
  assert.ok(out?.do === "deliver" && out.out.do === "incarnation" && out.out.changed);
});

test("P: the flags are read from what the store holds: a failed first write then another incarnation is first, not changed", () => {
  const a = rig({}, 1);
  a.link.start(0);
  a.hello(0);
  a.chunk(1, [a.s.wire.served(), ...a.read()], 1);
  a.link.persisted(false, 2); // the store still holds no incarnation
  a.s.wire.incarnation = fill(8, 16);
  a.link.tick(2000);
  a.hello(2000, 2);
  const again = a.give(2, [a.s.wire.served(), ...a.s.wire.read()], 2001);
  const out = again.find((e) => e.do === "deliver" && e.out.do === "incarnation");
  assert.ok(out?.do === "deliver" && out.out.do === "incarnation");
  assert.deepEqual([out.out.first, out.out.changed], [true, false]);
});

test("P: only the first rest of a run, and the first under a new incarnation, is first", () => {
  const a = rig({}, 1);
  const rests = (fx: Effect[]) =>
    fx.flatMap((e) => (e.do === "deliver" && e.out.do === "rest" ? [e.out.first] : []));
  assert.deepEqual(rests(a.toRest(0)), [true]);
  const n = a.s.wire.items.length;
  a.s.wire.put(4, prompt(a.s, a.epoch, fill(60, 16), 2));
  assert.deepEqual(
    rests(a.give(1, a.s.wire.push(n), 10)),
    [false],
    "a later rest of the same pass",
  );
  a.link.closed(1, 20);
  a.s.wire.incarnation = fill(8, 16);
  a.link.tick(2000);
  a.hello(2000, 2);
  assert.deepEqual(
    rests(a.give(2, [a.s.wire.served(), ...a.s.wire.read()], 2001)),
    [true],
    "the first rest under a relay recreated",
  );
});

test("P: a failed write of another incarnation, then the stored one served again, is changed: the reading rewound", () => {
  const a = rig({}, 1);
  a.toRest(0);
  const stored = a.s.wire.incarnation;
  a.link.closed(1, 10);
  a.s.wire.incarnation = fill(8, 16);
  a.link.tick(2000);
  a.hello(2000, 2);
  a.chunk(2, [a.s.wire.served(), ...a.s.wire.read()], 2001);
  a.link.persisted(false, 2002);
  a.s.wire.incarnation = stored;
  a.link.tick(10_000);
  a.hello(10_000, 3);
  const again = a.give(3, [a.s.wire.served(), ...a.s.wire.read()], 10_001);
  const out = again.find((e) => e.do === "deliver" && e.out.do === "incarnation");
  assert.ok(out?.do === "deliver" && out.out.do === "incarnation");
  assert.deepEqual([out.out.first, out.out.changed], [false, true]);
  const rest = again.find((e) => e.do === "deliver" && e.out.do === "rest");
  assert.equal(rest?.do === "deliver" && rest.out.do === "rest" && rest.out.first, true);
});

const ENROL = { secret: fill(3), signed: fill(1, 40), sig: fill(2, 64) };
const enrolFrame: Frame = { type: "enrol", ...ENROL };

test("device pairing 3.5.7 enrol goes before the proof on every connection until the first served, and never after", () => {
  const a = rig({ enrol: ENROL });
  a.link.start(0);
  assert.deepEqual(
    sends(a.hello(0)).map((f) => f.type),
    ["enrol", "prove-active"],
  );
  assert.deepEqual(
    sends(a.log).find((f) => f.type === "enrol"),
    enrolFrame,
  );
  // The connection drops before any answer: the next one sends it again.
  a.link.closed(1, 10);
  a.link.tick(1010);
  assert.deepEqual(
    sends(a.hello(1010, 2)).map((f) => f.type),
    ["enrol", "prove-active"],
  );
  a.give(2, [a.s.wire.served(), ...a.read()], 1020);
  a.link.closed(2, 1030);
  a.link.tick(2030);
  assert.deepEqual(
    sends(a.hello(2030, 3)).map((f) => f.type),
    ["prove-active"],
    "served: the secret is never sent again",
  );
});

test("device pairing 3.5.7 a link given no enrol sends the proof alone", () => {
  const a = rig();
  a.link.start(0);
  assert.deepEqual(
    sends(a.hello(0)).map((f) => f.type),
    ["prove-active"],
  );
});

test("device pairing 3.5.7 a refusal 2 on a connection that carried enrol drops it and says so; a drop with no answer keeps it", () => {
  const a = rig({ enrol: ENROL });
  a.link.start(0);
  a.hello(0);
  const fx = a.give(1, [{ type: "refused", reason: 2 }], 10);
  assert.equal(fx.filter((e) => e.do === "enrol-refused").length, 1);
  a.link.tick(10 + 1000);
  assert.deepEqual(
    sends(a.hello(1010, 2)).map((f) => f.type),
    ["prove-active"],
    "the refused secret is not sent again",
  );
  // The setter hands a retyped secret to the running link: the next connection sends it again.
  assert.deepEqual(a.link.enrol(ENROL), { ok: true, value: undefined });
  a.link.closed(2, 1020);
  a.link.tick(3020);
  assert.deepEqual(
    sends(a.hello(3020, 3)).map((f) => f.type),
    ["enrol", "prove-active"],
  );
  // A drop with no answer keeps it.
  a.link.closed(3, 3030);
  a.link.tick(65_000);
  assert.deepEqual(
    sends(a.hello(65_000, 4)).map((f) => f.type),
    ["enrol", "prove-active"],
  );
});

test("device pairing 3.5.7 a secret set while a connection proves without it waits for the next one, and that connection's refusal keeps it", () => {
  const a = rig();
  a.link.start(0);
  assert.deepEqual(
    sends(a.hello(0)).map((f) => f.type),
    ["prove-active"],
  );
  assert.deepEqual(a.link.enrol(ENROL), { ok: true, value: undefined });
  const fx = a.give(1, [{ type: "refused", reason: 2 }], 10);
  assert.equal(
    fx.filter((e) => e.do === "enrol-refused").length,
    0,
    "this connection carried no secret",
  );
  assert.ok(
    fx.some((e) => e.do === "deliver"),
    "the refusal itself is delivered",
  );
  a.link.tick(1010);
  assert.deepEqual(
    sends(a.hello(1010, 2)).map((f) => f.type),
    ["enrol", "prove-active"],
  );
});

test("device pairing 3.5.7 the first served that clears enrol says so once", () => {
  const a = rig({ enrol: ENROL });
  a.link.start(0);
  a.hello(0);
  const fx = a.give(1, [a.s.wire.served(), ...a.read()], 10);
  assert.equal(fx.filter((e) => e.do === "enrolled").length, 1);
  a.link.closed(1, 20);
  a.link.tick(1020);
  a.hello(1020, 2);
  assert.equal(
    a.give(2, [a.s.wire.served(), ...a.read()], 1030).filter((e) => e.do === "enrolled").length,
    0,
  );
});

test("device pairing 3.5.7 the setter refuses once the link has told enrolled, and changes nothing", () => {
  const a = rig({ enrol: ENROL });
  a.link.start(0);
  a.hello(0);
  a.give(1, [a.s.wire.served(), ...a.read()], 10);
  assert.deepEqual(a.link.enrol(ENROL), { ok: false, error: "bad-input" });
  a.link.closed(1, 20);
  a.link.tick(1020);
  assert.deepEqual(
    sends(a.hello(1020, 2)).map((f) => f.type),
    ["prove-active"],
    "the refused setter left nothing for the next connection to send",
  );
});

test("device pairing 3.5.7 an enrol that cannot be framed is refused at construction and in the setter", () => {
  const bad = [
    { ...ENROL, secret: fill(3, 31) },
    { ...ENROL, sig: fill(2, 63) },
    { ...ENROL, signed: fill(1, 5000) },
    { ...ENROL, signed: "x" },
  ];
  for (const enrol of bad) {
    assert.throws(() => rig({ enrol: enrol as never }), RangeError);
    const a = rig();
    assert.deepEqual(a.link.enrol(enrol as never), { ok: false, error: "bad-input" });
  }
});

// A blob of two chunks and a little over; a get frame is as long as the test says.
const CHUNK = 524_288;
const big = new Uint8Array(CHUNK * 2 + 1000).map((_, i) => i % 251);
const blobId = fill(30);
const TOO_LARGE = 8; // the relay's result code (relay `sequence.ts`)
const puts = (fx: Effect[]) => sends(fx).flatMap((f) => (f.type === "put-blob" ? [f] : []));
const gets = (fx: Effect[]) => sends(fx).flatMap((f) => (f.type === "get-blob" ? [f] : []));
const answers = (fx: Effect[]) => fx.filter((e) => e.do === "answer");
const closes = (fx: Effect[]) => fx.filter((e) => e.do === "close");

/** A put started at 100 on a link at rest: its driver name, its request on the wire and the effects. */
function started(a: ReturnType<typeof rig>, bytes = big) {
  a.toRest(0);
  const put = a.link.putBlob(blobId, bytes, 100);
  assert.ok(typeof put !== "string");
  const wire = puts(put.effects)[0]?.request as number;
  return { handle: put.request, wire, effects: put.effects };
}

test("G 3.5: a put sends one chunk at a time, a submit goes between two, and the deadline starts at the last write", () => {
  const a = rig();
  const { handle, wire, effects } = started(a);
  assert.equal(puts(effects).length, 1, "only the first chunk goes");
  assert.deepEqual(
    puts(effects).map((f) => [f.offset, f.size, f.chunk.length]),
    [[0, big.length, CHUNK]],
  );
  assert.ok(
    effects.some((e) => e.do === "send" && e.paced),
    "the driver is told to report its write",
  );
  assert.notEqual(handle, wire);
  // The socket is slow: nothing more goes by itself, and a submit is sent at once.
  const item = a.s.alice.genesis;
  const submitted = a.link.submit(1, item.signed, item.sig, 200);
  assert.ok(submitted !== "busy");
  assert.deepEqual(puts(submitted.effects), []);
  assert.deepEqual(
    sends(submitted.effects).map((f) => f.type),
    ["submit"],
  );
  assert.ok(!submitted.effects.some((e) => e.do === "send" && e.paced), "a submit is not paced");
  // A tick past `patience` of the put's start finds no deadline on it: it has none until its last chunk is out.
  assert.deepEqual(closes(a.link.tick(30_150)), []);
  a.give(1, [{ type: "result", request: submitted.request, code: 0 }], 30_160);
  const second = a.link.written(1, 31_000);
  assert.deepEqual(
    puts(second).map((f) => [f.request, f.offset, f.chunk.length]),
    [[wire, CHUNK, CHUNK]],
  );
  const third = a.link.written(1, 32_000);
  assert.deepEqual(
    puts(third).map((f) => [f.request, f.offset, f.chunk.length]),
    [[wire, CHUNK * 2, 1000]],
  );
  assert.deepEqual(puts(a.link.written(1, 33_000)), [], "no chunk after the last");
  // Its deadline is `patience` after the last write.
  assert.deepEqual(closes(a.link.tick(62_999)), []);
  const dropped = a.link.tick(63_000);
  assert.equal(closes(dropped).length, 1);
  assert.deepEqual(answers(dropped), [], "not answered: the put goes on next connection");
  assert.equal(a.link.state, "waiting");
});

test("G 3.5: a blob the relay holds is answered at the first chunk, which ends the put: no chunk is sent after it", () => {
  const a = rig();
  const { handle, wire } = started(a);
  const done = a.give(1, [{ type: "result", request: wire, code: 0 }], 150);
  assert.deepEqual(answers(done), [{ do: "answer", request: handle, code: 0 }]);
  assert.deepEqual(
    puts(a.link.written(1, 160)),
    [],
    "the chunk's write is reported late: nothing follows",
  );
  assert.deepEqual(puts(a.link.written(1, 170)), []);
  // The put's deadline does not outlive it.
  assert.deepEqual(closes(a.link.tick(100_000)), []);
});

test("G 3.5: tooLarge at the first chunk ends the put, and the next put in the queue starts", () => {
  const a = rig();
  const { handle, wire } = started(a);
  const next = a.link.putBlob(fill(31), Uint8Array.of(1, 2, 3), 120);
  assert.ok(typeof next !== "string");
  assert.deepEqual(puts(next.effects), [], "one put at a time per connection");
  const done = a.give(1, [{ type: "result", request: wire, code: TOO_LARGE }], 150);
  assert.deepEqual(answers(done), [{ do: "answer", request: handle, code: TOO_LARGE }]);
  const [second] = puts(done);
  assert.equal(second?.size, 3, "the queued put starts");
  assert.notEqual(second?.request, wire);
  assert.deepEqual(
    puts(a.link.written(1, 160)),
    [],
    "the first put's stale write sends nothing of the second",
  );
  assert.deepEqual(puts(a.link.written(1, 170)), [], "a one-chunk put has no second chunk");
});

test("G 3.5: a drop before the answer starts the put again on the next connection, from its first chunk", () => {
  const a = rig();
  const { handle } = started(a);
  a.link.written(1, 150);
  const dropped = a.link.closed(1, 200);
  assert.deepEqual(answers(dropped), [], "not answered: it is not over");
  a.link.tick(1200);
  a.hello(1200, 2);
  const again = a.give(2, [a.s.wire.served(), ...a.read()], 1200);
  const [chunk] = puts(again);
  assert.deepEqual([chunk?.offset, chunk?.chunk.length], [0, CHUNK]);
  const done = a.give(2, [{ type: "result", request: chunk?.request as number, code: 0 }], 1300);
  assert.deepEqual(answers(done), [{ do: "answer", request: handle, code: 0 }]);
});

test("G 3.5: a put queued before the link is at rest goes at the rest, and a stopped link answers it unanswered", () => {
  const a = rig();
  const early = a.link.putBlob(blobId, big, 0);
  assert.ok(typeof early !== "string");
  assert.deepEqual(puts(early.effects), []);
  const rest = a.toRest(0);
  assert.equal(puts(rest).length, 1);
  assert.deepEqual(answers(a.link.stop(10)), [
    { do: "answer", request: early.request, code: "unanswered" },
  ]);
  assert.equal(a.link.putBlob(blobId, big, 20), "busy");
  assert.equal(a.link.getBlob(blobId, 10, 20), "busy");
});

/** `size` bytes of a blob as `blob` frames of `step`. */
const frames = (
  request: number,
  size: number,
  step: number,
  from = 0,
): Extract<Frame, { type: "blob" }>[] =>
  Array.from({ length: Math.ceil((size - from) / step) }, (_, i) => ({
    type: "blob" as const,
    request,
    size,
    offset: from + i * step,
    chunk: new Uint8Array(Math.min(step, size - from - i * step)).fill(i + 1),
  }));

test("G 3.6: a streamed get is closed on the frame that reaches the size, with no result, and holds no deadline", () => {
  const a = rig();
  a.toRest(0);
  const get = a.link.getBlob(blobId, 10, 100);
  assert.ok(typeof get !== "string");
  const [ask] = gets(get.effects);
  assert.deepEqual([ask?.blob, ask?.offset], [blobId, 0]);
  const wire = ask?.request as number;
  const [f1, f2, f3] = frames(wire, 10, 4);
  assert.ok(f1 && f2 && f3);
  assert.deepEqual(closes(a.link.tick(100_000)), [], "no deadline while it streams");
  const one = a.give(1, [f1], 200_000);
  assert.deepEqual(
    one.filter((e) => e.do === "blob"),
    [{ do: "blob", request: get.request, size: 10, offset: 0, chunk: f1.chunk }],
  );
  assert.deepEqual(answers(one), []);
  const two = a.give(1, [f2, f3], 300_000);
  assert.deepEqual(
    two.filter((e) => e.do === "blob").map((e) => e.do === "blob" && e.offset),
    [4, 8],
  );
  assert.deepEqual(
    answers(two),
    [{ do: "answer", request: get.request, code: 0 }],
    "answered on the last frame",
  );
  assert.deepEqual(closes(a.link.tick(1_000_000)), [], "nothing of the get is left waiting");
});

test("G 3.6: the get's request id is not given to another request while it streams", () => {
  const a = rig();
  a.toRest(0);
  const get = a.link.getBlob(blobId, 10, 100);
  assert.ok(typeof get !== "string");
  const wire = gets(get.effects)[0]?.request as number;
  a.give(1, [frames(wire, 10, 4)[0] as Frame], 200);
  const item = a.s.alice.genesis;
  const ids = new Set<number>();
  for (let i = 0; i < 3; i++) {
    const r = a.link.submit(1, item.signed, item.sig, 300 + i);
    assert.ok(r !== "busy");
    ids.add(r.request);
  }
  const put = a.link.putBlob(blobId, Uint8Array.of(1), 400);
  assert.ok(typeof put !== "string");
  ids
    .add(put.request)
    .add(puts(put.effects)[0]?.request as number)
    .add(get.request);
  assert.equal(ids.size, 6, "every id of every request, put and get is its own");
  assert.ok(!ids.has(wire) || wire === get.request);
});

test("G 3.6: a result ends a get: the refusal, and no more frames are taken", () => {
  const a = rig();
  a.toRest(0);
  const get = a.link.getBlob(blobId, 10, 100);
  assert.ok(typeof get !== "string");
  const wire = gets(get.effects)[0]?.request as number;
  const done = a.give(1, [{ type: "result", request: wire, code: 9 }], 200);
  assert.deepEqual(answers(done), [{ do: "answer", request: get.request, code: 9 }]);
  assert.deepEqual(
    a.give(1, [frames(wire, 10, 4)[0] as Frame], 300).filter((e) => e.do === "blob"),
    [],
  );
});

test("G 3.6: a drop mid-get asks again from the last offset received on the next connection", () => {
  const a = rig();
  a.toRest(0);
  const get = a.link.getBlob(blobId, 10, 100);
  assert.ok(typeof get !== "string");
  const wire = gets(get.effects)[0]?.request as number;
  const all = frames(wire, 10, 4);
  a.give(1, [all[0] as Frame], 200);
  const dropped = a.link.closed(1, 250);
  assert.deepEqual(answers(dropped), [], "the get is not over");
  a.link.tick(1250);
  a.hello(1250, 2);
  const again = a.give(2, [a.s.wire.served(), ...a.read()], 1250);
  const [ask] = gets(again);
  assert.deepEqual([ask?.blob, ask?.offset], [blobId, 4], "from the last offset received");
  assert.notEqual(ask?.request, wire);
  const rest = frames(ask?.request as number, 10, 4, 4);
  const done = a.give(2, rest, 1300);
  assert.deepEqual(
    done.filter((e) => e.do === "blob").map((e) => e.do === "blob" && e.offset),
    [4, 8],
  );
  assert.deepEqual(answers(done), [{ do: "answer", request: get.request, code: 0 }]);
});

test("G 3.6: a frame out of order, with another size or past the size drops the connection", () => {
  const bad = (change: (f: Frame & { type: "blob" }) => Frame & { type: "blob" }, seen = 1) => {
    const a = rig();
    a.toRest(0);
    const get = a.link.getBlob(blobId, 10, 100);
    assert.ok(typeof get !== "string");
    const wire = gets(get.effects)[0]?.request as number;
    const all = frames(wire, 10, 4);
    a.give(1, all.slice(0, seen - 1), 200);
    const out = a.give(1, [change(all[seen - 1] as Frame & { type: "blob" })], 300);
    assert.equal(closes(out).length, 1);
    assert.deepEqual(
      out.filter((e) => e.do === "blob"),
      [],
    );
    assert.deepEqual(answers(out), [], "the get is asked again, not answered");
  };
  bad((f) => ({ ...f, offset: 4 })); // the first frame skips ahead
  bad((f) => ({ ...f, chunk: new Uint8Array(11) })); // past the size
  bad((f) => ({ ...f, chunk: new Uint8Array(0) })); // a frame that does not move
});

test("G 3.6: a frame that says another size than the body declared ends the get as refused and drops the connection, whatever its position", () => {
  for (const seen of [1, 2]) {
    const a = rig();
    a.toRest(0);
    const get = a.link.getBlob(blobId, 10, 100);
    assert.ok(typeof get !== "string");
    const wire = gets(get.effects)[0]?.request as number;
    const all = frames(wire, 10, 4);
    a.give(1, all.slice(0, seen - 1), 200);
    const out = a.give(1, [{ ...(all[seen - 1] as Frame & { type: "blob" }), size: 11 }], 300);
    assert.equal(closes(out).length, 1, "the stream is not read to its end");
    assert.deepEqual(answers(out), [{ do: "answer", request: get.request, code: 1 }]);
    assert.deepEqual(out.filter((e) => e.do === "blob").length, 0);
    a.link.tick(1300);
    a.hello(1300, 2);
    assert.deepEqual(
      gets(a.give(2, [a.s.wire.served(), ...a.read()], 1300)),
      [],
      "not asked again",
    );
  }
});

test("CR-1: a blob id that is not 32 bytes is refused before anything is queued", () => {
  const a = rig();
  a.toRest(0);
  assert.equal(a.link.putBlob(fill(30, 31), big, 100), "bad-input");
  assert.equal(a.link.putBlob(blobId, "x" as never, 100), "bad-input");
  assert.equal(a.link.getBlob(fill(30, 33), 10, 100), "bad-input");
  assert.equal(a.link.getBlob(blobId, -1, 100), "bad-input");
  const put = a.link.putBlob(blobId, big, 200);
  assert.ok(typeof put !== "string", "nothing queued before it, so the next put starts");
  assert.equal(puts(put.effects).length, 1);
});

test("CR-4: a put or a get queued before the start of a link holding a put-back or a fault is answered", () => {
  for (const stored of [{ fault: true }, undefined]) {
    const a = rig(stored ? { stored } : { kept: { ids: [], head: undefined, putBack: true } });
    const put = a.link.putBlob(blobId, big, 0);
    const get = a.link.getBlob(blobId, 10, 0);
    assert.ok(typeof put !== "string" && typeof get !== "string");
    const fx = a.link.start(1);
    assert.deepEqual(
      answers(fx).map((e) => e.do === "answer" && [e.request, e.code]),
      [
        [put.request, "unanswered"],
        [get.request, "unanswered"],
      ],
    );
  }
});
