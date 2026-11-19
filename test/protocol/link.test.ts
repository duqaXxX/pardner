/**
 * The device's connection as a state machine (step 6.3 design, 4 and 7.1): events with the time in,
 * effects out, on a clock that is only the numbers the tests pass. The relay is the frames of
 * `reading-world.ts`; each test is named after the line of 2.1, the row of 4.3 or the invariant of
 * 4.4 it holds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFrame, encodeFrame, type Frame } from "../../src/protocol/frames.ts";
import { type Effect, Link, type LinkOptions } from "../../src/protocol/link.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { checkProof } from "../../src/protocol/proofs.ts";
import type { Kept } from "../../src/protocol/reading.ts";
import { platform } from "../relay/support.ts";
import { fill } from "../relay/world.ts";
import { prompt, scene } from "./reading-world.ts";

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
