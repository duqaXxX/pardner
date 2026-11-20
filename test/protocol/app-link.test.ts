/**
 * The app's link (app data design, 3.3 to 5): the store's writes as `AppLink` hands them to Swift,
 * the state it is given back, a message opened with its own epoch's key or delivered again once that
 * key arrives, and the shown profile of a bot. The relay is the frames of `reading-world.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recipientsOf } from "../../src/protocol/device-log.ts";
import { sealEpochKey } from "../../src/protocol/epochs.ts";
import { encodeFrame, type Frame } from "../../src/protocol/frames.ts";
import {
  type AppEffect,
  type AppLinkOptions,
  type AppPersist,
  appLink,
  type MessageView,
  RECEIVE,
  SIGN,
} from "../../src/protocol/index.ts";
import { KIND_PROFILE, sealMessage } from "../../src/protocol/messages.ts";
import type { Bytes, Platform } from "../../src/protocol/platform.ts";
import { encodeProfile } from "../../src/protocol/profile.ts";
import { platform } from "../relay/support.ts";
import { fill, message, signedBy } from "../relay/world.ts";
import { historySeal, prompt, receivingOf, type Scene, scene } from "./reading-world.ts";

const BINDING = fill(9);

/** The scene's bot as the app's device: the platform holds its keys under the app's two names. */
function deviceOf(s: Scene): Platform {
  const names: Record<string, string> = { [SIGN]: s.bot.sign, [RECEIVE]: receivingOf(s.bot) };
  return Object.assign(Object.create(platform), {
    sign: (n: string, m: Bytes) => platform.sign(names[n] ?? n, m),
    hpkeOpen: (n: string, ...rest: [Bytes, Bytes, Bytes, Bytes]) =>
      platform.hpkeOpen(names[n] ?? n, ...rest),
  });
}

/** An app link on the scene's wire; `write` answers each `persist` (true unless told otherwise) and records it. */
function rig(s: Scene, over: Partial<AppLinkOptions> = {}) {
  const link = appLink(deviceOf(s), {
    relay: s.wire.key.keys.signing,
    person: s.alice.id,
    signing: s.bot.keys.signing,
    receiving: s.bot.keys.receiving,
    ...over,
  });
  const writes: AppPersist[] = [];
  let fail = (_w: AppPersist) => false;
  let conn = 0;
  // Every list the link returns ends with its one `persist`, if it has one (design 3.3).
  const ends = (fx: AppEffect[]) => {
    const at = fx.findIndex((e) => e.do === "persist");
    assert.ok(at === -1 || at === fx.length - 1, "nothing follows a persist in its list");
    return fx;
  };
  const settle = (raw: AppEffect[], now: number): AppEffect[] => {
    const fx = ends(raw);
    const out = [...fx];
    for (let last = fx.at(-1); last?.do === "persist"; ) {
      writes.push(last.what);
      const more = ends(link.persisted(!fail(last.what), now));
      out.push(...more);
      last = more.at(-1);
    }
    return out;
  };
  const give = (frames: Frame[], now: number, proven = true) =>
    frames.flatMap((f) => settle(link.received(conn, encodeFrame(f, proven), now), now));
  return {
    link,
    writes,
    /** The store fails the writes `which` picks. */
    failWrites: (which: (w: AppPersist) => boolean) => {
      fail = which;
    },
    /** Dial, hello, then the relay serves and answers a read from `from`. */
    connect(now = 0, from = 0): AppEffect[] {
      const fx = settle(now === 0 ? link.start(now) : link.tick(now), now);
      const dial = fx.find((e) => e.do === "dial");
      assert.ok(dial && dial.do === "dial", "the link dials");
      conn = dial.conn;
      return [
        ...fx,
        ...settle(link.opened(conn, BINDING, now), now),
        ...give([{ type: "hello", relayNonce: fill(4) }], now, false),
        ...give([s.wire.served(), ...s.wire.read(from)], now),
      ];
    },
    give,
    /** Dial and hello, then the relay's whole answer in one chunk, as a socket may hand it over. */
    connectInOne(now: number, from = 0): AppEffect[] {
      const fx = settle(link.tick(now), now);
      const dial = fx.find((e) => e.do === "dial");
      assert.ok(dial && dial.do === "dial", "the link dials");
      conn = dial.conn;
      const frames = [s.wire.served(), ...s.wire.read(from)].map((f) => encodeFrame(f, true));
      return [
        ...fx,
        ...settle(link.opened(conn, BINDING, now), now),
        ...give([{ type: "hello", relayNonce: fill(4) }], now, false),
        ...settle(link.received(conn, new Uint8Array(frames.flatMap((f) => [...f])), now), now),
      ];
    },
    drop: (now: number) => settle(link.closed(conn, now), now),
  };
}

const messages = (fx: AppEffect[]): MessageView[] =>
  fx.flatMap((e) => (e.do === "deliver" && e.out.do === "message" ? [e.out] : []));
const kept = (w: AppPersist | undefined) => {
  assert.ok(w, "a write");
  return w.kept;
};

test("a write of kept carries only the ids after the ones the store confirmed, and a head without the relay's id", () => {
  const s = scene();
  const epoch = s.epoch();
  s.wire.put(4, prompt(s, epoch));
  const r = rig(s);
  r.connect();
  assert.ok(r.writes[0]?.incarnation, "the incarnation's write comes first");
  assert.deepEqual(kept(r.writes[0]).ids, [], "and carries kept, as every write does [ledger M1]");
  const first = kept(r.writes.at(-1));
  assert.equal(first.from, 0);
  assert.equal(first.ids.length, s.wire.items.length);
  assert.ok(first.head);
  assert.deepEqual(Object.keys(first.head).sort(), ["chain", "n", "sig"]);
  assert.equal(first.head.n, s.wire.items.length);
  const n = s.wire.items.length;
  s.wire.put(4, prompt(s, epoch, fill(30, 16), 2));
  r.give(s.wire.push(n), 1);
  const second = kept(r.writes.at(-1));
  assert.equal(second.from, n);
  assert.equal(second.ids.length, 1);
});

test("a failed write is asked again from the same count: the ids it may have appended are written over", () => {
  const s = scene();
  s.epoch();
  const r = rig(s);
  let failures = 1;
  r.failWrites((w) => w.kept.ids.length > 0 && failures-- > 0);
  r.connect();
  const [failed, ...rest] = r.writes.filter((w) => w.kept.ids.length > 0);
  assert.equal(kept(failed).from, 0);
  assert.equal(rest.length, 0, "the failed write dropped the connection");
  r.connect(60_000);
  const again = r.writes.at(-1);
  assert.equal(kept(again).from, 0, "asked again from the count the store confirmed");
  assert.equal(kept(again).ids.length, s.wire.items.length);
});

test("the stored state is given back: an id that differs from the relay's is a relay put back, and a stored fault never dials", () => {
  const s = scene();
  s.epoch();
  const r = rig(s);
  r.connect();
  const w = kept(r.writes.at(-1));
  const ids = w.ids.map((id, i) => (i === 1 ? fill(77) : id));
  const again = rig(s, { stored: { ids, head: w.head, putBack: false, fault: false } });
  const fx = again.connect();
  assert.ok(
    fx.some((e) => e.do === "dial" && e.purpose === "upload") ||
      again.writes.some((x) => x.kept.putBack),
    "the item read at a position differs: give back or put back",
  );
  const faulted = appLink(deviceOf(s), {
    relay: s.wire.key.keys.signing,
    person: s.alice.id,
    signing: s.bot.keys.signing,
    receiving: s.bot.keys.receiving,
    stored: { ids: [], putBack: false, fault: true },
  });
  const start = faulted.start(0);
  assert.ok(!start.some((e) => e.do === "dial"));
  assert.ok(start.some((e) => e.do === "deliver" && e.out.do === "fault"));
});

test("a message of an older epoch opens with its own epoch's key [ledger F4]", () => {
  const s = scene();
  const old = s.epoch();
  s.epoch();
  const m = message(s.alice.first, s.channel, old, { kind: 1, name: fill(31, 16) });
  s.wire.put(4, m);
  const r = rig(s);
  const [view] = messages(r.connect());
  assert.ok(view);
  assert.equal(view.text, "{}");
  assert.equal(view.again, false);
  assert.equal(view.position, s.wire.items.length - 1);
  assert.equal(view.kind, 1);
  assert.deepEqual(view.files, []);
});

test("a message whose key arrives later by a history seal is delivered unopened, then again, opened", () => {
  const s = scene();
  const wrong = platform.random(32);
  const seals = recipientsOf(platform, s.log).map((x) => {
    const sealed = sealEpochKey(platform, s.channel, undefined, x.id, x.receiving, wrong);
    assert.ok(sealed.ok);
    return sealed.value;
  });
  const epoch = s.epoch({ seals });
  s.wire.put(4, message(s.alice.first, s.channel, epoch, { kind: 1, name: fill(32, 16) }));
  const r = rig(s);
  const [unopened] = messages(r.connect());
  assert.ok(unopened);
  assert.equal(unopened.text, undefined);
  assert.equal(unopened.files, undefined);
  const held = s.epochs.at(-1);
  assert.ok(held);
  s.wire.seals = [historySeal(held, s.alice.first, s.bot, epoch.key)];
  r.drop(1);
  const fx = r.connect(60_000, s.wire.items.length);
  const [opened] = messages(fx);
  assert.ok(opened, "delivered again once the key is held");
  assert.equal(opened.again, true);
  assert.equal(opened.position, unopened.position);
  assert.equal(opened.text, "{}");
  const n = s.wire.items.length;
  s.wire.put(
    4,
    message(s.alice.first, s.channel, epoch, { kind: 1, name: fill(34, 16), counter: 2 }),
  );
  const later = messages(r.give(s.wire.push(n), 61_000));
  assert.deepEqual(
    later.map((v) => [v.position, v.again]),
    [[n, false]],
    "the waiting message is delivered again once",
  );
});

test("a bot's profile is told once when it changes", () => {
  const s = scene();
  const epoch = s.epoch();
  const profile = (name: string, n: number) =>
    signedBy(
      s.bot,
      sealMessage(
        platform,
        epoch.key,
        {
          channel: s.channel,
          counter: n,
          epoch: epoch.id,
          sender: s.bot.id,
          run: fill(4, 16),
          incarnation: s.wire.incarnation,
          time: 1_700_000_000_000,
          kind: KIND_PROFILE,
          name: fill(40 + n, 16),
        },
        { files: [], content: encodeProfile({ name }) },
      ),
    );
  s.wire.put(4, profile("mini", 1));
  s.wire.put(4, message(s.alice.first, s.channel, epoch, { kind: 1, name: fill(33, 16) }));
  const r = rig(s);
  const told = r.connect().filter((e) => e.do === "profile");
  assert.equal(told.length, 1);
  assert.equal(told[0]?.do === "profile" && told[0].profile?.name, "mini");
  const n = s.wire.items.length;
  s.wire.put(4, profile("mini-dev", 2));
  const next = r.give(s.wire.push(n), 1).filter((e) => e.do === "profile");
  assert.equal(next.length, 1);
  assert.equal(next[0]?.do === "profile" && next[0].profile?.name, "mini-dev");
});

test("a relay recreated reads the profiles again, and tells nothing when the shown one is the same", () => {
  const s = scene();
  const epoch = s.epoch();
  s.wire.put(
    4,
    signedBy(
      s.bot,
      sealMessage(
        platform,
        epoch.key,
        {
          channel: s.channel,
          counter: 1,
          epoch: epoch.id,
          sender: s.bot.id,
          run: fill(4, 16),
          incarnation: s.wire.incarnation,
          time: 1_700_000_000_000,
          kind: KIND_PROFILE,
          name: fill(41, 16),
        },
        { files: [], content: encodeProfile({ name: "mini" }) },
      ),
    ),
  );
  const r = rig(s);
  assert.equal(r.connect().filter((e) => e.do === "profile").length, 1);
  r.drop(1);
  s.wire.incarnation = fill(8, 16);
  const fx = r.connect(60_000);
  const inc = fx.find((e) => e.do === "deliver" && e.out.do === "incarnation");
  assert.ok(inc?.do === "deliver" && inc.out.do === "incarnation" && inc.out.changed);
  assert.deepEqual(
    fx.filter((e) => e.do === "profile"),
    [],
    "the same profile read again is no change",
  );
});

/** An epoch whose own seals hold another key: the device holds its key only once a history seal comes. */
function lateEpoch(s: Scene) {
  const wrong = platform.random(32);
  const seals = recipientsOf(platform, s.log).map((x) => {
    const sealed = sealEpochKey(platform, s.channel, undefined, x.id, x.receiving, wrong);
    assert.ok(sealed.ok);
    return sealed.value;
  });
  const epoch = s.epoch({ seals });
  const held = s.epochs.at(-1);
  assert.ok(held);
  return { epoch, seal: () => historySeal(held, s.alice.first, s.bot, epoch.key) };
}

test("a message opened by a key that came in a call ending with a persist is delivered before that persist", () => {
  const s = scene();
  const { epoch, seal } = lateEpoch(s);
  s.wire.put(4, message(s.alice.first, s.channel, epoch, { kind: 1, name: fill(35, 16) }));
  const r = rig(s);
  r.connect();
  r.drop(1);
  s.wire.seals = [seal()];
  s.wire.put(
    4,
    message(s.alice.first, s.channel, epoch, { kind: 1, name: fill(36, 16), counter: 2 }),
  );
  const fx = r.connectInOne(60_000, s.wire.items.length - 1);
  assert.equal(messages(fx).filter((v) => v.again).length, 1);
});

test("a waiting message that does not open under its key is not delivered again", () => {
  const s = scene();
  const { epoch, seal } = lateEpoch(s);
  const other = { id: epoch.id, key: platform.random(32) }; // sealed under a key that is not the epoch's
  s.wire.put(4, message(s.alice.first, s.channel, other, { kind: 1, name: fill(37, 16) }));
  const r = rig(s);
  assert.equal(messages(r.connect()).length, 1);
  r.drop(1);
  s.wire.seals = [seal()];
  assert.deepEqual(messages(r.connect(60_000, s.wire.items.length)), []);
});

test("a relay recreated empties the waiting list: a message is delivered again once, from the new pass", () => {
  const s = scene();
  const { epoch, seal } = lateEpoch(s);
  s.wire.put(4, message(s.alice.first, s.channel, epoch, { kind: 1, name: fill(38, 16) }));
  const r = rig(s);
  r.connect();
  r.drop(1);
  s.wire.incarnation = fill(8, 16);
  s.wire.seals = [seal()];
  const views = messages(r.connect(60_000));
  assert.deepEqual(
    views.map((v) => [v.again, v.text]),
    [[false, "{}"]],
    "the new pass opens it at once; the old waiting entry is gone",
  );
});
