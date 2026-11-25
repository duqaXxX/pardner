/**
 * The app's link (app data design, 3.3 to 5): the store's writes as `AppLink` hands them to Swift,
 * the state it is given back, a message opened with its own epoch's key or delivered again once that
 * key arrives, and the shown profile of a bot. The relay is the frames of `reading-world.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesEqual, toHex } from "../../src/protocol/bytes.ts";
import { checkDeviceEntry, idKey, recipientsOf } from "../../src/protocol/device-log.ts";
import {
  checkHistorySeal,
  decodeEpochEntry,
  encodeHistorySeal,
  sealEpochKey,
} from "../../src/protocol/epochs.ts";
import { SEAL_OVERHEAD, sealBlobUnderKey } from "../../src/protocol/files.ts";
import { decodeFrame, encodeFrame, type Frame } from "../../src/protocol/frames.ts";
import { signedId } from "../../src/protocol/ids.ts";
import {
  type AppEffect,
  type AppLinkOptions,
  type AppOutbox,
  type AppPersist,
  appLink,
  type MessageView,
  RECEIVE,
  SIGN,
} from "../../src/protocol/index.ts";
import { decodeMemberEntry, spaceNonce } from "../../src/protocol/member-log.ts";
import { decodeMessage, KIND_PROFILE, sealMessage } from "../../src/protocol/messages.ts";
import { Run } from "../../src/protocol/outbox.ts";
import { shortForm } from "../../src/protocol/pairing-string.ts";
import type { Bytes, Platform } from "../../src/protocol/platform.ts";
import {
  type Arrangement,
  encodeArrangement,
  encodeName,
  encodeProfile,
  readArrangement,
} from "../../src/protocol/profile.ts";
import { platform } from "../relay/support.ts";
import { epochEntry, fill, type Keyed, keyed, message, signedBy } from "../relay/world.ts";
import { makeProof } from "./proof.ts";
import {
  addChannel,
  historySeal,
  prompt,
  receivingOf,
  type Scene,
  scene,
} from "./reading-world.ts";

const BINDING = fill(9);

/** `app` (the scene's bot unless told) as the app's device: the platform holds its keys under the app's two names. */
function deviceOf(s: Scene, app: Keyed = s.bot): Platform {
  const names: Record<string, string> = { [SIGN]: app.sign, [RECEIVE]: receivingOf(app) };
  return Object.assign(Object.create(platform), {
    sign: (n: string, m: Bytes) => platform.sign(names[n] ?? n, m),
    publicKey: (n: string) => platform.publicKey(names[n] ?? n),
    hpkeOpen: (n: string, ...rest: [Bytes, Bytes, Bytes, Bytes]) =>
      platform.hpkeOpen(names[n] ?? n, ...rest),
  });
}

/** An app link on the scene's wire; `write` answers each `persist` (true unless told otherwise) and records it. */
function rig(s: Scene, over: Partial<AppLinkOptions> = {}, app: Keyed = s.bot) {
  const link = appLink(deviceOf(s, app), {
    relay: s.wire.key.keys.signing,
    person: s.alice.id,
    signing: app.keys.signing,
    receiving: app.keys.receiving,
    ...over,
  });
  const writes: AppPersist[] = [];
  const outWrites: AppOutbox[] = []; // the app outbox's writes, in order
  const lists: AppEffect[][] = []; // every list the link returned
  let fail = (_w: AppPersist) => false;
  let failOutbox = (_w: AppOutbox) => false;
  let hold = false; // the test answers the outbox's write itself
  let conn = 0;
  // Every list the link returns ends with its one `persist` or `write`, if it has one, never both (design 3.3; new channel design 3.1).
  const ends = (fx: AppEffect[]) => {
    const at = fx.findIndex((e) => e.do === "persist" || e.do === "write");
    assert.ok(
      at === -1 || at === fx.length - 1,
      "nothing follows a persist or a write in its list",
    );
    lists.push(fx);
    return fx;
  };
  const settle = (raw: AppEffect[], now: number): AppEffect[] => {
    const out = [...ends(raw)];
    for (let last = out.at(-1); last; ) {
      let more: AppEffect[];
      if (last.do === "persist") {
        writes.push(last.what);
        more = link.persisted(!fail(last.what), now);
      } else if (last.do === "write") {
        outWrites.push(last.outbox);
        if (hold) break;
        more = link.written(!failOutbox(last.outbox), now);
      } else break;
      out.push(...ends(more));
      last = more.at(-1);
    }
    return out;
  };
  const give = (frames: Frame[], now: number, proven = true) =>
    frames.flatMap((f) => settle(link.received(conn, encodeFrame(f, proven), now), now));
  return {
    link,
    writes,
    outWrites,
    lists,
    settle,
    /** While held, the outbox's writes wait for `answer`. */
    hold: (on: boolean) => {
      hold = on;
    },
    /** The store's answer to the outbox's write. */
    answer: (ok: boolean, now: number) => settle(link.written(ok, now), now),
    /** The store fails the outbox's writes `which` picks. */
    failOutboxWrites: (which: (w: AppOutbox) => boolean) => {
      failOutbox = which;
    },
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
    /** The frames in one chunk, as a socket may hand them over. */
    chunk: (frames: Frame[], now: number) => {
      const bytes = frames.map((f) => encodeFrame(f, true));
      return settle(link.received(conn, new Uint8Array(bytes.flatMap((b) => [...b])), now), now);
    },
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
  const s = scene({ space: true });
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
  const talk = addChannel(s, fill(9, 16));
  const talkEpoch = talk.epoch();
  s.wire.put(4, message(s.alice.first, talk.id, talkEpoch, { kind: 1, name: fill(33, 16) }));
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

/** A profile of `bot` in `channel`, sealed in `epoch`. */
function profileIn(
  s: Scene,
  channel: Bytes,
  epoch: { id: Bytes; key: Bytes },
  name: string,
  n: number,
) {
  return signedBy(
    s.bot,
    sealMessage(
      platform,
      epoch.key,
      {
        channel,
        counter: n,
        epoch: epoch.id,
        sender: s.bot.id,
        run: fill(4, 16),
        incarnation: s.wire.incarnation,
        time: 1_700_000_000_000,
        kind: KIND_PROFILE,
        name: fill(60 + n, 16),
      },
      { files: [], content: encodeProfile({ name }) },
    ),
  );
}

test("personal space 2.3, review K1: the space and a spare are no conversation: no message view of theirs reaches the screen, and the profile still does", () => {
  const s = scene({ space: true });
  const home = s.epoch();
  s.wire.put(4, profileIn(s, s.channel, home, "mini", 1));
  const spare = addChannel(s, spaceNonce(platform, s.alice.id), "bot");
  s.wire.put(4, profileIn(s, spare.id, spare.epoch(), "rogue", 2));
  const talk = addChannel(s, fill(9, 16));
  s.wire.put(4, message(s.alice.first, talk.id, talk.epoch(), { kind: 1, name: fill(33, 16) }));
  const fx = rig(s).connect();
  assert.deepEqual(
    messages(fx).map((m) => Buffer.from(m.channel).toString("hex")),
    [Buffer.from(talk.id).toString("hex")],
    "only the conversation channel's message",
  );
  const told = fx.flatMap((e) => (e.do === "profile" && e.profile ? [e.profile.name] : []));
  assert.deepEqual(told, ["mini"], "review K5: the space's profile, not the spare's");
});

test("a relay recreated reads the profiles again, and tells nothing when the shown one is the same", () => {
  const s = scene({ space: true });
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

type Devices = Extract<AppEffect, { do: "devices" }>;
const devicesOf = (fx: AppEffect[]): Devices[] =>
  fx.flatMap((e) => (e.do === "devices" ? [e] : []));
const frameTypes = (fx: AppEffect[]) =>
  fx.flatMap((e) => {
    if (e.do !== "send") return [];
    const f = decodeFrame(e.bytes, false, "relay");
    const g = f.ok ? f : decodeFrame(e.bytes, true, "relay");
    assert.ok(g.ok);
    return [g.value.type];
  });

test("device pairing 3.5.7 enrol goes before the proof until the first served, then never", () => {
  const s = scene({ space: true });
  s.epoch(); // a channel with no epoch is the keeper's to start, which sends a submit after the read
  const enrol = { secret: fill(3), signed: s.alice.genesis.signed, sig: s.alice.genesis.sig };
  const r = rig(s, { enrol });
  assert.deepEqual(frameTypes(r.connect()), ["enrol", "prove-active", "read"]);
  r.drop(10);
  assert.deepEqual(frameTypes(r.connect(2000)).slice(0, 2), ["prove-active", "read"]);
});

test("device pairing 3.5 AppLink.enrol refuses a secret that cannot be framed, and any once served has cleared it", () => {
  const s = scene();
  const enrol = { secret: fill(3), signed: s.alice.genesis.signed, sig: s.alice.genesis.sig };
  const r = rig(s, { enrol });
  const first = r.connect();
  assert.equal(first.filter((e) => e.do === "enrolled").length, 1, "served tells the app once");
  assert.throws(() => rig(s, { enrol: { ...enrol, secret: fill(3, 31) } }), RangeError);
  assert.deepEqual(r.link.enrol(fill(3, 31), enrol.signed, enrol.sig), {
    ok: false,
    error: "bad-input",
  });
  assert.deepEqual(r.link.enrol(enrol.secret, enrol.signed, enrol.sig), {
    ok: false,
    error: "bad-input",
  });
  r.drop(10);
  assert.deepEqual(
    frameTypes(r.connect(2000)).slice(0, 2),
    ["prove-active", "read"],
    "served cleared the enrolment: the setter does not bring it back",
  );
});

test("device pairing 3.5 AppLink.enrol on a link not yet served hands the secret to the next connection", () => {
  const s = scene();
  s.epoch();
  const enrol = { secret: fill(3), signed: s.alice.genesis.signed, sig: s.alice.genesis.sig };
  const r = rig(s);
  assert.deepEqual(r.link.enrol(enrol.secret, enrol.signed, enrol.sig), {
    ok: true,
    value: undefined,
  });
  assert.deepEqual(frameTypes(r.connect()).slice(0, 2), ["enrol", "prove-active"]);
});

test("device pairing 3.6 addDevice and removeDevice are busy until the log is at rest", () => {
  const s = scene();
  const r = rig(s);
  const other = keyed();
  const proof = makeProof(platform, other.sign, s.alice.id, other.device);
  assert.deepEqual(r.link.addDevice({ device: other.device, proof }, 5), {
    ok: false,
    error: "busy",
  });
  assert.deepEqual(r.link.removeDevice(s.alice.first.id, 5), { ok: false, error: "busy" });
});

test("device pairing 3.6 addDevice answers bad-input to a pairing of the wrong shape, never throws", () => {
  const s = scene();
  const r = rig(s);
  r.connect();
  const other = keyed();
  const proof = makeProof(platform, other.sign, s.alice.id, other.device);
  const cases = [
    { device: { ...other.device, kind: "robot" }, proof },
    { device: { ...other.device, signing: fill(1, 64) }, proof },
    { device: other.device, proof: "x" },
    { device: other.device, proof: fill(1, 63) },
    {},
  ];
  for (const bad of cases)
    assert.deepEqual(r.link.addDevice(bad as never, 5), { ok: false, error: "bad-input" });
});

test("device pairing 4.2 the devices effect: every device the log names, at the first rest", () => {
  const s = scene();
  const fx = devicesOf(rig(s).connect());
  assert.equal(fx.length, 1);
  assert.deepEqual(fx[0], {
    do: "devices",
    person: s.alice.id,
    length: 2,
    last: s.log[1]?.id,
    self: s.bot.id,
    devices: [
      {
        id: s.alice.first.id,
        kind: "app",
        active: true,
        addedBy: null,
        position: 0,
        onlyHolder: [],
        short: shortForm(platform, s.alice.first.keys),
      },
      {
        id: s.bot.id,
        kind: "bot",
        active: true,
        addedBy: s.alice.first.id,
        position: 1,
        onlyHolder: [],
        short: shortForm(platform, s.bot.keys),
      },
    ],
  });
});

test("device pairing 4.2 the devices effect comes again only when the log changed, removed devices kept", () => {
  const s = scene();
  const epoch = s.epoch();
  const r = rig(s);
  r.connect();
  let n = s.wire.items.length;
  s.wire.put(4, prompt(s, epoch));
  assert.deepEqual(devicesOf(r.give(s.wire.push(n), 1)), [], "no change in the log, no effect");
  const other = keyed();
  n = s.wire.items.length;
  s.entry(s.alice.add(s.log, other));
  const added = devicesOf(r.give(s.wire.push(n), 2));
  assert.equal(added.length, 1);
  assert.equal(added[0]?.length, 3);
  assert.equal(added[0]?.devices.at(-1)?.active, true);
  n = s.wire.items.length;
  s.entry(s.alice.remove(s.log, other));
  const removed = devicesOf(r.give(s.wire.push(n), 3));
  assert.equal(removed[0]?.length, 4);
  assert.deepEqual(removed[0]?.devices.at(-1), {
    id: other.id,
    kind: "app",
    active: false,
    addedBy: s.alice.first.id,
    position: 2,
    onlyHolder: [],
    short: shortForm(platform, other.keys),
  });
});

test("device pairing 3.4, 3.6 addDevice builds an entry the log accepts and sends nothing", () => {
  const s = scene();
  const r = rig(s);
  r.connect();
  const other = keyed();
  const proof = makeProof(platform, other.sign, s.alice.id, other.device);
  const built = r.link.addDevice({ device: other.device, proof }, 5);
  assert.ok(built.ok);
  const verdict = checkDeviceEntry(platform, s.log, built.value.signed, built.value.sig);
  assert.ok(verdict.ok);
  assert.deepEqual(verdict.value.id, built.value.id);
  assert.equal((verdict.value.entry as { signer: Bytes }).signer.join(), s.bot.id.join());
});

test("device pairing 3.4 addDevice refuses a proof for another person and a device already named", () => {
  const s = scene();
  const r = rig(s);
  r.connect();
  const other = keyed();
  const stranger = makeProof(platform, other.sign, fill(8), other.device);
  assert.deepEqual(r.link.addDevice({ device: other.device, proof: stranger }, 5), {
    ok: false,
    error: "proof",
  });
  const own = makeProof(platform, s.bot.sign, s.alice.id, s.bot.device);
  assert.deepEqual(r.link.addDevice({ device: s.bot.device, proof: own }, 5), {
    ok: false,
    error: "named",
  });
});

test("device pairing 3.9 removeDevice builds a remove the log accepts, and refuses this device", () => {
  const s = scene();
  const r = rig(s);
  r.connect();
  assert.deepEqual(r.link.removeDevice(s.bot.id, 5), { ok: false, error: "bad-input" });
  const built = r.link.removeDevice(s.alice.first.id, 5);
  assert.ok(built.ok);
  assert.ok(checkDeviceEntry(platform, s.log, built.value.signed, built.value.sig).ok);
});

/** The frames the effects send, decoded, in order. */
const sentFrames = (fx: AppEffect[]): Frame[] =>
  fx.flatMap((e) => {
    if (e.do !== "send") return [];
    const f = decodeFrame(e.bytes, false, "relay");
    const g = f.ok ? f : decodeFrame(e.bytes, true, "relay");
    assert.ok(g.ok);
    return [g.value];
  });
type Sent<T extends Frame["type"]> = Extract<Frame, { type: T }>;
const only = <T extends Frame["type"]>(fx: AppEffect[], type: T): Sent<T>[] =>
  sentFrames(fx).filter((f): f is Sent<T> => f.type === type);
const epochSubmits = (fx: AppEffect[]) => only(fx, "submit").filter((f) => f.kind === 3);

test("device pairing 3.11 the app starts the epoch of a closed channel, and no epoch when one is open", () => {
  const s = scene();
  const first = s.epoch();
  s.entry(s.alice.add(s.log, keyed()));
  const [start] = epochSubmits(rig(s).connect());
  assert.ok(start, "the closed channel gets its next epoch");
  const decoded = decodeEpochEntry(start.signed);
  assert.ok(decoded.ok);
  assert.equal(decoded.value.seq, 1);
  assert.deepEqual(decoded.value.prev, first.id);
  assert.deepEqual(decoded.value.signerDevice, s.bot.id);
  // Another device started it first: the channel is open, nothing is submitted.
  const t = scene();
  t.epoch();
  t.entry(t.alice.add(t.log, keyed()));
  t.epoch();
  assert.deepEqual(epochSubmits(rig(t).connect()), []);
});

test("device pairing 3.11 the app gives a history seal for each earlier epoch to a new device, never twice while pending, again when the relay's list lacks it, never once read back", () => {
  const s = scene();
  const [e1, e2] = [s.epoch(), s.epoch()];
  const late = keyed();
  s.entry(s.alice.add(s.log, late));
  const r = rig(s);
  const given = only(r.connect(), "give-seal");
  assert.equal(given.length, 2);
  assert.deepEqual(given.map((g) => g.seal.epoch).sort(), [e1.id, e2.id].sort());
  for (const g of given) {
    assert.deepEqual(g.seal.recipient, late.id);
    assert.deepEqual(g.seal.maker, s.bot.id);
    assert.ok(checkHistorySeal(platform, s.log, encodeHistorySeal(g.seal), g.sig).ok);
  }
  // A rest before any answer: the same seals are pending, not given again.
  const n = s.wire.items.length;
  s.wire.put(4, prompt(s, e2));
  const again = r.give(s.wire.push(n), 5);
  assert.deepEqual(only(again, "give-seal"), []);
  assert.deepEqual(epochSubmits(again), [], "nor is the start sent again");
  // Answered: the relay's list, read before the seals, still lacks them, so the next rest gives them again (5.10).
  r.give(
    given.map((g): Frame => ({ type: "result", request: g.request, code: 0 })),
    6,
  );
  const m = s.wire.items.length;
  s.wire.put(4, prompt(s, e2, fill(9, 16), 2));
  assert.equal(only(r.give(s.wire.push(m), 7), "give-seal").length, 2);
  // The connection ends and the relay's list lacks them (a new incarnation, a put-back): owed again; read back, they are not.
  r.drop(8);
  assert.equal(
    only(r.connect(2000), "give-seal").length,
    2,
    "a seal the relay's list lacks is given",
  );
  r.drop(2100);
  s.wire.seals = given.map((g) => ({ seal: g.seal, sig: g.sig }));
  assert.deepEqual(only(r.connect(4000), "give-seal"), []);
});

test("device pairing 3.11 no more history seals than the window are in flight; the rest follow the answers, which stay with the link", () => {
  const s = scene();
  const epochs = Array.from({ length: 18 }, () => s.epoch());
  s.entry(s.alice.add(s.log, keyed()));
  const r = rig(s);
  const first = only(r.connect(), "give-seal");
  assert.equal(first.length, 16, "the window");
  const answer = (g: Sent<"give-seal">): Frame => ({ type: "result", request: g.request, code: 0 });
  const next = r.give(first.slice(0, 2).map(answer), 1);
  assert.equal(only(next, "give-seal").length, 2, "one for each answer");
  assert.equal(
    next.some((e) => e.do === "answer"),
    false,
    "the keeper's answers are not the driver's",
  );
  const given = new Set([...first, ...only(next, "give-seal")].map((g) => g.seal.epoch.join()));
  assert.equal(given.size, 18);
  assert.equal(epochs.length, 18);
});

test("device pairing 3.11 a seal whose answer never came is given again on the next connection", () => {
  const s = scene();
  s.epoch();
  s.entry(s.alice.add(s.log, keyed()));
  const r = rig(s);
  assert.equal(only(r.connect(), "give-seal").length, 1);
  r.drop(10);
  assert.equal(only(r.connect(2000), "give-seal").length, 1, "unanswered, so owed again");
});

test("device pairing 3.9 the devices effect names the epochs a device alone holds a counting seal for", () => {
  const s = scene();
  const seq = {
    channels: new Map([[idKey(s.channel), s]]),
    devices: new Map([[idKey(s.alice.id), s.log]]),
  };
  const made = epochEntry(seq as never, s.channel, { person: s.alice, device: s.bot }, [s.alice]);
  s.epochs.push({ entry: made.entry, id: signedId(platform, made.signed) });
  s.wire.put(3, made);
  const [both] = devicesOf(rig(s).connect());
  assert.deepEqual(
    both?.devices.map((d) => d.onlyHolder),
    [[], []],
    "two active devices hold it",
  );
  s.entry(s.alice.remove(s.log, s.alice.first));
  const [alone] = devicesOf(rig(s).connect());
  assert.deepEqual(
    alone?.devices.map((d) => [d.active, d.onlyHolder]),
    [
      [false, []],
      [true, [{ channel: s.channel, epoch: s.epochs[0]?.id }]],
    ],
  );
});

test("device pairing 3.4 checkPairing says what addDevice would refuse, without signing", () => {
  const s = scene();
  const r = rig(s);
  assert.deepEqual(r.link.checkPairing({ device: keyed().device, proof: fill(1, 64) }, 5), {
    ok: false,
    error: "busy",
  });
  r.connect();
  const other = keyed();
  const proof = makeProof(platform, other.sign, s.alice.id, other.device);
  assert.deepEqual(r.link.checkPairing({ device: other.device, proof }, 5), { ok: true });
  const stranger = makeProof(platform, other.sign, fill(8), other.device);
  assert.deepEqual(r.link.checkPairing({ device: other.device, proof: stranger }, 5), {
    ok: false,
    error: "proof",
  });
  const own = makeProof(platform, s.bot.sign, s.alice.id, s.bot.device);
  assert.deepEqual(r.link.checkPairing({ device: s.bot.device, proof: own }, 5), {
    ok: false,
    error: "named",
  });
  assert.deepEqual(r.link.checkPairing({} as never, 5), { ok: false, error: "bad-input" });
});

// New channel and the app's outbox (design 2026-11-21, 3 and 7): the app is alice's first device, the bot is the scene's.
type Rig = ReturnType<typeof rig>;
const homed = new WeakSet<Scene>();
// The app finds the person's space at rest or makes it (personal space design 3): these scenes already hold one, so a creation here is the test's own.
const appRig = (s: Scene, over: Partial<AppLinkOptions> = {}) => {
  if (!homed.has(s) && !s.members[0]?.space) {
    homed.add(s);
    addChannel(s, spaceNonce(platform, s.alice.id)).epoch();
  }
  return rig(s, over, s.alice.first);
};
const outboxes = (fx: AppEffect[]): AppOutbox[] =>
  fx.flatMap((e) => (e.do === "write" ? [e.outbox] : []));
const draftTo = (s: Scene, text = "hi") => ({
  kind: 2,
  to: s.bot.id,
  content: JSON.stringify({ text }),
});
const fxOf = <D extends AppEffect["do"]>(fx: AppEffect[], d: D) =>
  fx.filter((e): e is Extract<AppEffect, { do: D }> => e.do === d);
const itemsOf = (o: AppOutbox | undefined, channel: Bytes) =>
  o?.channels.find((c) => bytesEqual(c.channel, channel))?.items ?? [];
type Code = Sent<"result">["code"];
const results = (fx: AppEffect[], code: Code): Frame[] =>
  only(fx, "submit").map((f): Frame => ({ type: "result", request: f.request, code }));

/** The relay takes what the effects submitted, in order, answers `code`, and pushes it to the reading. */
function place(s: Scene, r: Rig, fx: AppEffect[], now: number, code: Code = 0): AppEffect[] {
  const from = s.wire.items.length;
  for (const f of only(fx, "submit"))
    if (!s.wire.items.some((i) => bytesEqual(i.signed, f.signed)))
      s.wire.put(f.kind, { signed: f.signed, sig: f.sig });
  return r.give([...results(fx, code), ...s.wire.push(from)], now);
}

/** `place`, again and again on what each pass submitted, until nothing is submitted: the effects of all. */
function drive(s: Scene, r: Rig, fx: AppEffect[], now: number): AppEffect[] {
  const all = [...fx];
  for (let last = fx, n = 0; only(last, "submit").length; n++) {
    assert.ok(n < 12, "the exchange ends");
    last = place(s, r, last, now + n);
    all.push(...last);
  }
  return all;
}

/** `createChannel` and `send`, their effects taken through the rig's store. */
const create = (r: Rig, s: Scene, now = 10, folder = "/work/x") => {
  const made = r.link.createChannel({ bot: s.bot.id, folder }, now);
  assert.ok(typeof made === "object", `a channel is made, not ${made}`);
  return { channel: made.channel, effects: r.settle(made.effects, now) };
};
const post = (r: Rig, channel: Bytes, draft: Parameters<Rig["link"]["send"]>[1], now = 10) => {
  const sent = r.link.send(channel, draft, now);
  assert.ok(typeof sent === "object", `a message is queued, not ${sent}`);
  return { name: sent.name, effects: r.settle(sent.effects, now) };
};

test("new channel 3.2 createChannel writes entry 0 and the bind in one write, then submits the same bytes", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  r.hold(true);
  const made = create(r, s);
  assert.deepEqual(only(made.effects, "submit"), [], "nothing is submitted before the write");
  const [w] = outboxes(made.effects);
  assert.ok(w?.pending, "entry 0 is in the write");
  const entry = decodeMemberEntry(w.pending.signed);
  assert.ok(entry.ok);
  assert.equal(entry.value.kind, "create");
  assert.equal(entry.value.seq, 0);
  assert.deepEqual(entry.value.signerDevice, s.alice.first.id);
  assert.deepEqual(entry.value.signerPerson, s.alice.id);
  assert.deepEqual(signedId(platform, w.pending.signed), made.channel);
  const [bind] = itemsOf(w, made.channel);
  assert.equal(bind?.kind, 2);
  assert.deepEqual(bind?.to, s.bot.id);
  assert.equal(bind?.content, JSON.stringify({ text: "/bind /work/x" }));
  assert.equal(bind?.built, undefined, "the bind is built once its epoch is read");
  const after = r.answer(true, 11);
  const [sent] = only(after, "submit");
  assert.equal(sent?.kind, 2);
  assert.deepEqual(sent?.signed, w.pending.signed);
  assert.deepEqual(sent?.sig, w.pending.sig);
  const answered = r.give([{ type: "result", request: sent?.request ?? 0, code: 0 }], 12);
  assert.deepEqual(fxOf(answered, "answer"), [], "the request is the link's own, not the driver's");
});

test("new channel 3.2 createChannel is not-ready before the log reads active, busy while one is pending, bad-input for a bot that is none", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  assert.equal(r.link.createChannel({ bot: s.bot.id, folder: "/x" }, 1), "not-ready");
  r.connect();
  assert.equal(
    r.link.createChannel({ bot: s.alice.first.id, folder: "/x" }, 2),
    "bad-input",
    "an app",
  );
  assert.equal(r.link.createChannel({ bot: fill(1), folder: "/x" }, 2), "bad-input", "no device");
  assert.equal(
    r.link.createChannel({ bot: s.bot.id, folder: 5 as unknown as string }, 2),
    "bad-input",
  );
  create(r, s, 3);
  assert.equal(r.link.createChannel({ bot: s.bot.id, folder: "/y" }, 4), "busy");
});

test("new channel 3.2 entry 0 is sent as the same bytes after a reconnection and a restart, and at the next rest after a busy", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  const made = create(r, s);
  const first = only(made.effects, "submit")[0];
  assert.ok(first, "submitted when the reading is at rest");
  r.drop(11);
  const [again] = only(r.connect(2000), "submit");
  assert.deepEqual(again?.signed, first.signed, "a reconnection sends the entry as it is");
  assert.deepEqual(again?.sig, first.sig);
  const stored = r.outWrites.at(-1);
  const t = appRig(s, stored && { outbox: stored });
  const [restart] = only(t.connect(), "submit").filter((f) => f.kind === 2);
  assert.deepEqual(restart?.signed, first.signed, "a restart sends the stored entry");
  assert.deepEqual(restart?.sig, first.sig);
  // Written while the reading is not at rest: the submit is owed to the next rest.
  const u = appRig(s);
  u.connect();
  u.drop(5);
  const late = create(u, s, 6);
  assert.deepEqual(only(late.effects, "submit"), []);
  assert.equal(only(u.connect(2000), "submit").filter((f) => f.kind === 2).length, 1);
});

test("new channel 3.2 a read back entry 0 drops the pending creation by a write, the keeper starts the first epoch, and the bind waits for its key then goes", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  r.hold(true);
  const made = create(r, s);
  const sent = r.answer(true, 11);
  const placed = place(s, r, sent, 12);
  const dropped = outboxes(placed).at(-1);
  assert.equal(dropped?.pending, null, "read back: the pending creation is dropped");
  assert.equal(itemsOf(dropped, made.channel).length, 1, "the bind stays");
  const [start] = only(placed, "submit").filter((f) => f.kind === 3);
  assert.ok(start, "the keeper owes the first epoch");
  const epoch = decodeEpochEntry(start.signed);
  assert.ok(epoch.ok);
  assert.deepEqual(epoch.value.channel, made.channel);
  assert.deepEqual(
    only(placed, "submit").filter((f) => f.kind === 4),
    [],
    "no bind while the channel has no open epoch",
  );
  // The epoch read: the bind is built, its bytes written, and only then submitted.
  r.answer(true, 12);
  const withEpoch = place(s, r, placed, 13);
  assert.deepEqual(only(withEpoch, "submit"), [], "written first");
  const built = itemsOf(outboxes(withEpoch).at(-1), made.channel)[0]?.built;
  assert.ok(built, "the built bytes are in the write");
  const [bind] = only(r.answer(true, 14), "submit");
  assert.equal(bind?.kind, 4);
  assert.deepEqual(bind?.signed, built.signed);
});

test("new channel 3.2 a result 1 or 5 for entry 0 drops the creation and its outbox with channel-refused; 2 is treated as 1; 0 keeps it", () => {
  for (const [code, dropped] of [
    [1, true],
    [2, true],
    [5, true],
    [0, false],
  ] as const) {
    const s = scene();
    s.epoch();
    const r = appRig(s);
    r.connect();
    const made = create(r, s);
    const fx = r.give(results(made.effects, code), 12);
    assert.deepEqual(
      fxOf(fx, "channel-refused").map((e) => [e.channel, e.code]),
      dropped ? [[made.channel, code]] : [],
    );
    const last = r.outWrites.at(-1);
    assert.equal(last?.pending === null, dropped, `result ${code}`);
    assert.equal(itemsOf(last, made.channel).length, dropped ? 0 : 1);
    if (dropped)
      assert.deepEqual(
        fxOf(fx, "outbox").flatMap((e) => e.items.map((i) => i.state)),
        ["refused"],
        "the bind is told refused",
      );
  }
});

test("new channel 3.3 send queues and writes first, builds in the open epoch and writes the built bytes before it submits", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  r.hold(true);
  const sent = post(r, s.channel, draftTo(s));
  assert.deepEqual(only(sent.effects, "submit"), [], "queued and written first");
  assert.equal(itemsOf(outboxes(sent.effects)[0], s.channel)[0]?.built, undefined);
  const second = r.answer(true, 11);
  assert.deepEqual(only(second, "submit"), [], "the built bytes are written before the submit");
  const built = itemsOf(outboxes(second)[0], s.channel)[0]?.built;
  assert.ok(built);
  const header = decodeMessage(built.signed);
  assert.ok(header.ok);
  assert.deepEqual(header.value.header.name, sent.name);
  assert.deepEqual(header.value.header.sender, s.alice.first.id);
  const third = r.answer(true, 12);
  const [submit] = only(third, "submit");
  assert.equal(submit?.kind, 4);
  assert.deepEqual(submit?.signed, built.signed);
  // The effect lets a screen draw the pending message.
  const told = fxOf(sent.effects, "outbox")[0];
  assert.deepEqual(
    told?.items.map((i) => i.state),
    ["waiting"],
  );
  assert.deepEqual(told?.items[0]?.name, sent.name);
});

test("new channel 3.3 the outbox effect carries each item's content, so a screen can draw the text after a restart", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  const draft = draftTo(s);
  const sent = post(r, s.channel, draft);
  const told = fxOf(sent.effects, "outbox")[0];
  assert.equal(told?.items[0]?.content, draft.content);
});

test("new channel 3.3 send refuses a draft the package refuses, a channel it does not hold, and a faulted channel", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  const bad = [
    { ...draftTo(s), files: [{ bytes: fill(1, 4), type: "x", name: "f" }] },
    { ...draftTo(s), to: fill(1, 5) },
    { kind: 99, content: "{}" },
  ];
  for (const d of bad) assert.equal(r.link.send(s.channel, d, 5), "bad-input");
  assert.equal(r.link.send(fill(8), draftTo(s), 5), "not-member");
  const faulted = appRig(s, { outbox: { pending: null, channels: [], faults: [s.channel] } });
  faulted.connect();
  assert.equal(faulted.link.send(s.channel, draftTo(s), 5), "fault");
  assert.equal(r.outWrites.length, 0, "a refusal writes nothing");
});

test("new channel 3.1 a failed write sends nothing more, says store-failed, and refuses what follows", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  r.hold(true);
  post(r, s.channel, draftTo(s));
  assert.deepEqual(r.answer(false, 11), [{ do: "store-failed" }]);
  assert.equal(r.link.send(s.channel, draftTo(s), 12), "not-ready");
  assert.equal(r.link.createChannel({ bot: s.bot.id, folder: "/x" }, 12), "not-ready");
  assert.deepEqual(only(r.link.tick(5000), "submit"), []);
  assert.equal(r.outWrites.length, 1, "no other write is emitted");
});

test("new channel 3.1 the outbox's write never shares a list with Link's persist: a change made in the list that ends with one is written in the next", () => {
  const s = scene();
  const epoch = s.epoch();
  const r = appRig(s);
  r.connect();
  const sent = post(r, s.channel, draftTo(s));
  // The answer 3 and the next read in one chunk: the answer changes the outbox in the list whose rest ends with Link's persist.
  const n = s.wire.items.length;
  s.wire.put(4, prompt(s, epoch, fill(31, 16), 1));
  const before = r.lists.length;
  r.chunk([...results(sent.effects, 3), ...s.wire.push(n)], 20);
  const ends = r.lists.slice(before).map((l) => l.at(-1)?.do);
  assert.ok(ends.includes("persist"), "the list ended with a persist");
  assert.ok(ends.indexOf("persist") < ends.lastIndexOf("write"), "the write comes in a later list");
  assert.equal(itemsOf(r.outWrites.at(-1), s.channel).length, 1, "the change is written");
});

test("new channel 3.3 result 0 keeps the item until its device reads it back by name", () => {
  const s = scene();
  const epoch = s.epoch();
  const r = appRig(s);
  r.connect();
  const sent = post(r, s.channel, draftTo(s));
  const [submit] = only(sent.effects, "submit");
  assert.ok(submit);
  const kept = r.give(results(sent.effects, 0), 11);
  assert.deepEqual(
    fxOf(kept, "outbox")[0]?.items.map((i) => i.state),
    ["sent"],
  );
  assert.equal(itemsOf(r.outWrites.at(-1), s.channel).length, 1, "kept until read back");
  const n = s.wire.items.length;
  s.wire.put(4, { signed: submit.signed, sig: submit.sig });
  const back = r.give(s.wire.push(n), 12);
  assert.equal(
    itemsOf(outboxes(back).at(-1), s.channel).length,
    0,
    "read back: removed by a write",
  );
  assert.equal(epoch.id.length, 32);
});

test("new channel 3.3 results 3 and 4 build the same message again in the next epoch, never in the epoch that answered", () => {
  for (const code of [3, 4] as const) {
    const s = scene();
    const first = s.epoch();
    const r = appRig(s);
    r.connect();
    const sent = post(r, s.channel, draftTo(s));
    const [one] = only(sent.effects, "submit");
    assert.ok(one);
    const again = r.give(results(sent.effects, code), 11);
    assert.deepEqual(only(again, "submit"), [], `result ${code}: not in the same epoch`);
    const held = itemsOf(r.outWrites.at(-1), s.channel);
    assert.equal(held.length, 1);
    assert.equal(held[0]?.built, undefined, "rebuilt: to be built again");
    assert.deepEqual(held[0]?.name, sent.name, "the same name");
    // The next epoch is read: built in it, with the same name and under its own epoch.
    const next = s.epoch();
    const n = s.wire.items.length - 1;
    const read = r.give(s.wire.push(n), 12);
    const [two] = only(read, "submit");
    assert.ok(two, "built in the next epoch");
    const [h1, h2] = [decodeMessage(one.signed), decodeMessage(two.signed)];
    assert.ok(h1.ok && h2.ok);
    assert.deepEqual(h1.value.header.epoch, first.id);
    assert.deepEqual(h2.value.header.epoch, next.id);
    assert.deepEqual(h2.value.header.name, sent.name);
    assert.deepEqual(h2.value.header.incarnation, h1.value.header.incarnation);
  }
});

test("new channel 3.3 a result 1 that the package's checks explain drops the item as refused; a result 8 and a result 5 drop it too", () => {
  for (const code of [1, 8, 5] as const) {
    const s = scene();
    s.epoch();
    const r = appRig(s);
    r.connect();
    // `to` an app, not a bot: the package's own check refuses it (kind 2 goes to a bot).
    const sent = post(r, s.channel, { kind: 2, to: s.alice.first.id, content: "{}" });
    const fx = r.give(results(sent.effects, code), 11);
    assert.equal(itemsOf(r.outWrites.at(-1), s.channel).length, 0, `result ${code}: dropped`);
    assert.deepEqual(fxOf(fx, "channel-fault"), [], `result ${code}: no fault`);
    assert.deepEqual(
      fxOf(fx, "outbox")[0]?.items.map((i) => i.state),
      ["refused"],
    );
    assert.deepEqual(r.link.send(s.channel, draftTo(s), 12) !== "fault", true);
  }
});

test("new channel 3.5 a result 1 no check explains is a channel fault: stored, told, nothing more built or sent there, across a restart", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  const sent = post(r, s.channel, draftTo(s));
  const fx = r.give(results(sent.effects, 1), 11);
  assert.deepEqual(
    fxOf(fx, "channel-fault").map((e) => e.channel),
    [s.channel],
  );
  const stored = r.outWrites.at(-1);
  assert.deepEqual(stored?.faults, [s.channel]);
  assert.equal(r.link.send(s.channel, draftTo(s), 12), "fault");
  const t = appRig(s, stored && { outbox: stored });
  t.connect();
  assert.deepEqual(only(t.link.tick(5000), "submit"), [], "nothing is sent in a faulted channel");
  assert.equal(t.link.send(s.channel, draftTo(s), 13), "fault");
});

test("new channel 3.3 a rollover starts the next epoch once, and the mark ends with the epoch it was met in", () => {
  const s = scene();
  const first = s.epoch();
  // A run with no counter left in the first epoch, as after 100,000 messages.
  class Spent extends Run {
    override next(epoch: Bytes): number | undefined {
      return bytesEqual(epoch, first.id) ? undefined : super.next(epoch);
    }
  }
  const r = appRig(s, { run: new Spent(platform) });
  const connected = r.connect();
  assert.deepEqual(epochSubmits(connected), []);
  const sent = post(r, s.channel, draftTo(s));
  const [start] = epochSubmits(sent.effects);
  assert.ok(start, "the keeper starts the next epoch");
  assert.deepEqual(
    only(sent.effects, "submit").filter((f) => f.kind === 4),
    [],
  );
  // Not sent twice while its answer is pending.
  assert.deepEqual(epochSubmits(r.link.tick(11)), []);
  const read = place(s, r, sent.effects, 12);
  const [message] = only(drive(s, r, read, 13), "submit").filter((f) => f.kind === 4);
  assert.ok(message, "the message goes in the new epoch");
  const decoded = decodeMessage(message.signed);
  assert.ok(decoded.ok);
  assert.notDeepEqual(decoded.value.header.epoch, first.id);
  // Another rest: the mark is gone with its epoch, so no further start.
  const n = s.wire.items.length;
  s.wire.put(4, prompt(s, first, fill(21, 16), 1));
  assert.deepEqual(epochSubmits(r.give(s.wire.push(n), 20)), []);
});

test("new channel 3.3 an incarnation change gives an item not built the new incarnation and leaves a built one its own", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  const old = post(r, s.channel, draftTo(s, "a"));
  const [builtOld] = only(old.effects, "submit");
  assert.ok(builtOld);
  r.drop(11);
  s.wire.incarnation = fill(8, 16);
  const again = r.connect(2000);
  const [resent] = only(again, "submit");
  assert.deepEqual(resent?.signed, builtOld.signed, "a built item is sent as it is");
  const fresh = post(r, s.channel, draftTo(s, "b"), 2001);
  assert.deepEqual(
    only(fresh.effects, "submit"),
    [],
    "one item in flight: the new one follows its answer",
  );
  const bytes = only(r.give(results(again, 0), 2002), "submit")[0];
  assert.ok(bytes);
  const [h1, h2] = [decodeMessage(builtOld.signed), decodeMessage(bytes.signed)];
  assert.ok(h1.ok && h2.ok);
  assert.deepEqual(h1.value.header.incarnation, fill(7, 16));
  assert.deepEqual(h2.value.header.incarnation, fill(8, 16));
});

test("fix round: a result no rule handles holds the channel until the next rest, with no resubmit loop", () => {
  for (const code of [2, 7, 9, 11] as const) {
    const s = scene();
    const epoch = s.epoch();
    const r = appRig(s);
    r.connect();
    const sent = post(r, s.channel, draftTo(s));
    assert.deepEqual(only(r.give(results(sent.effects, code), 11), "submit"), [], `result ${code}`);
    assert.deepEqual(only(r.link.tick(12), "submit"), []);
    const n = s.wire.items.length;
    s.wire.put(4, prompt(s, epoch, fill(40, 16), 1));
    assert.equal(only(r.give(s.wire.push(n), 20), "submit").length, 1, "sent again at the rest");
  }
});

test("fix round: after 3 or 4 the epoch to avoid is the one the item was built in, so a newer epoch already read is used at once", () => {
  const s = scene();
  const first = s.epoch();
  const r = appRig(s);
  r.connect();
  const sent = post(r, s.channel, draftTo(s));
  const next = s.epoch();
  const n = s.wire.items.length - 1;
  r.give(s.wire.push(n), 12);
  const [again] = only(r.give(results(sent.effects, 4), 13), "submit");
  assert.ok(again, "built in the newer epoch without waiting for another rest");
  const h = decodeMessage(again.signed);
  assert.ok(h.ok);
  assert.deepEqual(h.value.header.epoch, next.id);
  assert.notDeepEqual(h.value.header.epoch, first.id);
});

test("fix round: a stored outbox with a malformed item or entry is cleaned at load, and nothing throws", () => {
  const s = scene();
  s.epoch();
  const good = { name: fill(1, 16), kind: 2, to: s.bot.id, content: "{}", files: [] };
  const stored = {
    pending: { signed: "x", sig: fill(1, 64) },
    channels: [
      {
        channel: s.channel,
        items: [
          { ...good, name: fill(2, 16), to: fill(2, 31) },
          { ...good, name: fill(3, 16), kind: 99 },
          { ...good, name: fill(4, 16), re: { device: fill(1, 5), name: fill(1, 16) } },
          { ...good, name: fill(5, 16), built: { signed: "x", signature: fill(1, 64) } },
          good,
        ],
      },
    ],
    faults: [fill(1, 5)],
  } as unknown as AppOutbox;
  const r = appRig(s, { outbox: stored });
  assert.doesNotThrow(() => r.connect());
  const sent = post(r, s.channel, draftTo(s, "after"));
  const held = itemsOf(r.outWrites.at(-1), s.channel);
  assert.deepEqual(
    held.map((i) => i.name).filter((n) => !bytesEqual(n, good.name) && !bytesEqual(n, fill(5, 16))),
    [sent.name],
  );
  assert.equal(r.outWrites.at(-1)?.pending, null);
  assert.deepEqual(r.outWrites.at(-1)?.faults, []);
});

test("fix round: a faulted channel gets no epoch start", () => {
  const s = scene();
  s.epoch();
  s.entry(s.alice.add(s.log, keyed()));
  const open = appRig(s);
  assert.equal(epochSubmits(open.connect()).length, 1, "a closed channel is started");
  const faulted = appRig(s, { outbox: { pending: null, channels: [], faults: [s.channel] } });
  assert.deepEqual(epochSubmits(faulted.connect()), []);
});

test("fix round: a name already in the channel's outbox is refused", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  const name = fill(5, 16);
  post(r, s.channel, { ...draftTo(s), name });
  assert.equal(r.link.send(s.channel, { ...draftTo(s, "again"), name }, 11), "bad-input");
});

test("fix round: nothing is submitted while the store's write is unanswered", () => {
  const s = scene();
  s.epoch();
  const first = appRig(s);
  first.connect();
  const a = post(first, s.channel, draftTo(s, "a"));
  first.give(results(a.effects, 0), 11);
  post(first, s.channel, draftTo(s, "b"), 12);
  const r = appRig(s, { outbox: first.outWrites.at(-1) });
  const connected = r.connect();
  const [one] = only(connected, "submit");
  assert.ok(one, "the first item goes at the rest");
  r.hold(true);
  create(r, s, 20);
  assert.equal(r.outWrites.length, 1, "a write is held");
  const fx = r.give(results(connected, 0), 21);
  assert.deepEqual(only(fx, "submit"), [], "the next item waits for the write");
  assert.deepEqual(only(r.link.tick(22), "submit"), []);
});

test("fix round: on the same connection, an answer to a request sent before a second served frees and changes nothing", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  const a = post(r, s.channel, draftTo(s, "a"));
  const [old] = only(a.effects, "submit");
  assert.ok(old);
  const made = create(r, s, 12);
  const [oldEntry] = only(made.effects, "submit");
  assert.ok(oldEntry, "entry 0 is in flight");
  // The relay serves again with another incarnation on the same connection: the pass reads again, and the next rest submits again.
  s.wire.incarnation = fill(8, 16);
  const again = r.give([s.wire.served(), ...s.wire.read(0)], 13);
  const [item, entry] = [
    only(again, "submit").find((f) => f.kind === 4),
    only(again, "submit").find((f) => f.kind === 2),
  ];
  assert.ok(
    item && entry && item.request !== old.request && entry.request !== oldEntry.request,
    "sent again as new requests",
  );
  const writes = r.outWrites.length;
  // The old requests' answers arrive late: nothing is rebuilt, refused or freed.
  const stale = r.give(
    [
      { type: "result", request: old.request, code: 4 },
      { type: "result", request: oldEntry.request, code: 1 },
    ],
    14,
  );
  assert.equal(r.outWrites.length, writes, "no write");
  assert.deepEqual(fxOf(stale, "channel-refused"), []);
  assert.deepEqual(only(stale, "submit"), [], "the new requests are still in flight");
  const held = itemsOf(r.outWrites.at(-1), s.channel).find((i) => bytesEqual(i.name, a.name));
  assert.ok(held?.built, "not rebuilt");
  assert.ok(r.outWrites.at(-1)?.pending, "entry 0 is still pending");
});

test("new channel 5 start tells the stored outbox: an outbox effect for each channel and a creating effect for a pending creation", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  const made = create(r, s, 10, "/work/y");
  const told = fxOf(made.effects, "creating").flatMap((e) => (e.channel ? [e] : []));
  assert.deepEqual(
    told.map((e) => [e.channel, e.bot, e.folder]),
    [[made.channel, s.bot.id, "/work/y"]],
    "createChannel tells the creation",
  );
  const stored = r.outWrites.at(-1);
  assert.ok(stored?.pending, "the creation is stored");
  const t = appRig(s, { outbox: stored });
  const start = t.connect();
  assert.deepEqual(
    fxOf(start, "creating")
      .flatMap((e) => (e.channel ? [e] : []))
      .map((e) => [e.channel, e.bot, e.folder]),
    [[made.channel, s.bot.id, "/work/y"]],
    "a restart tells the stored creation",
  );
  const items = fxOf(start, "outbox").filter((e) => bytesEqual(e.channel, made.channel));
  assert.equal(items.length >= 1 && items[0]?.items.length, 1, "and the stored bind, first");
  assert.equal(fxOf(appRig(s).connect(), "creating").length, 0, "nothing stored, nothing told");
});

test("new channel 5 a creation read back or refused is told as creating null", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  const made = create(r, s);
  const placed = place(s, r, made.effects, 12);
  assert.deepEqual(
    fxOf(placed, "creating").map((e) => e.channel),
    [null],
  );
  const u = appRig(s);
  u.connect();
  const refused = create(u, s);
  const fx = u.give(results(refused.effects, 1), 12);
  assert.deepEqual(
    fxOf(fx, "creating").map((e) => e.channel),
    [null],
  );
});

test("new channel 3.5 start tells each stored channel fault again, so a restart or a Retry shows it", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  const made = create(r, s);
  const stored = r.outWrites.at(-1);
  assert.ok(stored);
  const faulted = appRig(s, { outbox: { ...stored, faults: [made.channel] } });
  assert.deepEqual(
    fxOf(faulted.connect(), "channel-fault").map((e) => e.channel),
    [made.channel],
  );
  assert.deepEqual(fxOf(appRig(s, { outbox: stored }).connect(), "channel-fault"), []);
});

test("review: send refuses a kind only a bot may send", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  for (const kind of [3, 4, 8, 12, 13])
    assert.equal(r.link.send(s.channel, { kind, content: "{}" }, 5), "bad-input", `kind ${kind}`);
  assert.equal(r.outWrites.length, 0);
});

test("review: at a rest the accepted items go back to waiting and the screen is told", () => {
  const s = scene();
  const epoch = s.epoch();
  const r = appRig(s);
  r.connect();
  const sent = post(r, s.channel, draftTo(s));
  const kept = r.give(results(sent.effects, 0), 11);
  assert.deepEqual(
    fxOf(kept, "outbox")[0]?.items.map((i) => i.state),
    ["sent"],
  );
  const n = s.wire.items.length;
  s.wire.put(4, prompt(s, epoch, fill(41, 16), 1));
  const rest = r.give(s.wire.push(n), 20);
  assert.deepEqual(
    fxOf(rest, "outbox")[0]?.items.map((i) => i.state),
    ["waiting"],
  );
});

test("a reading recovery tells the devices of the log it read, with the id of the recovery key, and stops (recovery design 2.3, 2.4)", () => {
  const s = scene();
  s.epoch();
  const fresh = keyed();
  const r = rig(s, {}, fresh);
  const key = { id: s.alice.recovery.recoveryId, sign: s.alice.recovery.sign };
  assert.deepEqual(r.link.recover({ key }), { ok: true, value: undefined });
  const dial = r.settle(r.link.start(0), 0).find((e) => e.do === "dial");
  assert.ok(dial?.do === "dial" && dial.purpose === "recover");
  r.settle(r.link.opened(dial.conn, BINDING, 0), 0);
  const entries = s.wire.items.filter((i) => i.kind === 1);
  const fx = [
    { type: "hello", relayNonce: fill(4) },
    { type: "log", request: 1, entries },
    { type: "result", request: 1, code: 0 },
  ].flatMap((f, i) => r.settle(r.link.received(dial.conn, encodeFrame(f as Frame, i > 0), 1), 1));
  const told = fx.find((e) => e.do === "recovery-log");
  assert.ok(told?.do === "recovery-log");
  assert.deepEqual(told.person, s.alice.id);
  assert.equal(told.length, 2);
  assert.deepEqual(told.recovery, s.alice.recovery.recoveryId);
  assert.deepEqual(told.recoveries, [s.alice.recovery.recoveryId]);
  assert.deepEqual(
    told.devices.map((d) => [d.active, d.kind]),
    [
      [true, "app"],
      [true, "bot"],
    ],
    "no secret and no entry crosses: the devices as the person sees them",
  );
  assert.equal(
    r.link.tick(10 ** 9).some((e) => e.do === "dial"),
    false,
    "the link is spent",
  );
  assert.deepEqual(r.link.recover({ key }), { ok: false, error: "bad-input" });
});

test("a recovery key held after the read opens the epochs it was sealed in, and done reads the epochs and the current recovery key from the link", () => {
  const s = scene();
  const epoch = s.epoch();
  s.wire.put(4, prompt(s, epoch));
  const fresh = keyed();
  const r = rig(s, {}, fresh);
  const fx = r.connect();
  assert.deepEqual(
    messages(fx).map((m) => m.text),
    [undefined],
    "no seal to this device: delivered unopened",
  );
  assert.deepEqual(r.link.currentRecovery(), s.alice.recovery.recoveryId);
  assert.equal(r.link.epochs()[0]?.open, false);
  const opened = r.link.holdRecovery(
    { id: s.alice.recovery.recoveryId, receiving: receivingOf(s.alice.recovery) },
    2,
  );
  assert.equal(r.link.epochs()[0]?.open, true);
  assert.ok(opened.ok);
  assert.equal(
    messages(opened.ok ? opened.effects : []).length,
    1,
    "the waiting message is opened and delivered again",
  );
});

const DAY = 86_400_000;
const FLOOR = Date.UTC(2026, 10, 14);

/** A recovering app that holds none of the scene's keys, with a message at each of `times` in one epoch it cannot open. */
function unopened(times: number[]) {
  const s = scene();
  const epoch = s.epoch();
  times.forEach((time, i) => {
    s.wire.put(
      4,
      message(s.alice.first, s.channel, epoch, {
        kind: 1,
        time,
        counter: i + 1,
        name: fill(20 + i, 16),
      }),
    );
  });
  const r = rig(s, {}, keyed());
  r.connect();
  return { s, r, epoch };
}

test("epoch dates: an epoch not open tells how many messages it holds unopened and the smallest and largest signed time, whatever the order (issue 95)", () => {
  const t = Date.now() - 5 * DAY;
  const { r } = unopened([t + 3000, t, t + 1000]);
  assert.deepEqual(r.link.epochs()[0]?.unopened, { count: 3, first: t, last: t + 3000 });
});

test("epoch dates: a time a day ahead of the clock or before 2026-11-14 is counted and left out of the range, and none left gives no dates", () => {
  const ok = Date.now() - DAY;
  const wild = [Date.now() + DAY + 60_000, FLOOR - 1];
  assert.deepEqual(unopened([...wild, ok]).r.link.epochs()[0]?.unopened, {
    count: 3,
    first: ok,
    last: ok,
  });
  assert.deepEqual(unopened(wild).r.link.epochs()[0]?.unopened, { count: 2 });
});

test("epoch dates: an epoch of the person's space tells so, and one of a conversation does not (review D3)", () => {
  const s = scene({ space: true });
  s.epoch();
  const talk = addChannel(s, fill(9, 16));
  talk.epoch();
  const r = rig(s, {}, keyed());
  r.connect();
  const by = (c: Bytes) => r.link.epochs().find((e) => bytesEqual(e.channel, c));
  assert.equal(by(s.channel)?.space, true);
  assert.equal(by(talk.id)?.space, false);
});

test("epoch dates: an epoch not open with no message has a count of 0 and no dates", () => {
  assert.deepEqual(unopened([]).r.link.epochs()[0]?.unopened, { count: 0 });
});

test("epoch dates: an epoch whose key arrives is open and carries no unopened; an open epoch never does", () => {
  const { s, r } = unopened([Date.now() - DAY]);
  assert.ok(r.link.epochs()[0]?.unopened);
  const held = r.link.holdRecovery(
    { id: s.alice.recovery.recoveryId, receiving: receivingOf(s.alice.recovery) },
    2,
  );
  assert.ok(held.ok);
  const e = r.link.epochs()[0];
  assert.equal(e?.open, true);
  assert.equal(e && "unopened" in e, false);
});

test("epoch dates: after an incarnation change the dates are those of the new pass, not the sum of both", () => {
  const t = Date.now() - 2 * DAY;
  const { s, r } = unopened([t]);
  assert.deepEqual(r.link.epochs()[0]?.unopened, { count: 1, first: t, last: t });
  r.drop(1);
  s.wire.incarnation = fill(8, 16);
  r.connect(60_000);
  assert.deepEqual(r.link.epochs()[0]?.unopened, { count: 1, first: t, last: t });
});

test("the recovery keys this person's log named come in order from the link and on the recovery-log effect, apart from the keys other seals name (recovery design 2.6)", () => {
  const s = scene();
  const epoch = s.epoch();
  const held = s.epochs.at(-1);
  assert.ok(held);
  const other = keyed(); // an id a device of the person sealed to, outside the log
  s.wire.seals = [historySeal(held, s.alice.first, { ...other, id: other.recoveryId }, epoch.key)];
  const next = keyed();
  const reset = s.alice.entry(
    s.log,
    {
      kind: "reset",
      set: [s.alice.first.id],
      recovery: next.keys,
    },
    s.alice.recovery,
  );
  s.entry(reset);
  const fresh = keyed();
  const r = rig(s, {}, fresh);
  r.connect();
  const ids = r.link.recoveries();
  assert.deepEqual(
    ids,
    [s.alice.recovery.recoveryId, next.recoveryId],
    "oldest first; the last is current",
  );
  assert.deepEqual(r.link.currentRecovery(), next.recoveryId);
  const sealed = r.link.epochs()[0]?.sealedTo ?? [];
  assert.ok(
    sealed.some((id) => bytesEqual(id, other.recoveryId)),
    "another key is among the seals",
  );
  assert.equal(
    ids.some((id) => bytesEqual(id, other.recoveryId)),
    false,
  );
});

test("AppLink.recover and holdRecovery refuse values of the wrong shape as bad input", () => {
  const s = scene();
  const r = rig(s, {}, keyed());
  assert.deepEqual(r.link.recover({ key: { id: new Uint8Array(3), sign: "x" } }), {
    ok: false,
    error: "bad-input",
  });
  const bad = r.link.holdRecovery({ id: new Uint8Array(3), receiving: "x" }, 0);
  assert.deepEqual(bad, { ok: false, error: "bad-input" });
  const good = r.link.holdRecovery({ id: fill(1), receiving: "x" }, 0);
  assert.ok(good.ok);
});

test("the recovery-log effect names both recovery keys of a log whose reset replaced the first, the current last", () => {
  const s = scene();
  s.epoch();
  const next = keyed();
  s.entry(
    s.alice.entry(
      s.log,
      { kind: "reset", set: [s.alice.first.id], recovery: next.keys },
      s.alice.recovery,
    ),
  );
  const r = rig(s, {}, keyed());
  assert.deepEqual(r.link.recover({ key: { id: next.recoveryId, sign: next.sign } }), {
    ok: true,
    value: undefined,
  });
  const dial = r.settle(r.link.start(0), 0).find((e) => e.do === "dial");
  assert.ok(dial?.do === "dial");
  r.settle(r.link.opened(dial.conn, BINDING, 0), 0);
  const entries = s.wire.items.filter((i) => i.kind === 1);
  const told = [
    { type: "hello", relayNonce: fill(4) },
    { type: "log", request: 1, entries },
    { type: "result", request: 1, code: 0 },
  ]
    .flatMap((f, i) => r.settle(r.link.received(dial.conn, encodeFrame(f as Frame, i > 0), 1), 1))
    .find((e) => e.do === "recovery-log");
  assert.ok(told?.do === "recovery-log");
  assert.deepEqual(told.recoveries, [s.alice.recovery.recoveryId, next.recoveryId]);
  assert.deepEqual(told.recovery, next.recoveryId);
});

// The personal space in the app (personal space design 2.3, 2.6, 3): made at rest, never a fault target, spares skipped.
const entryZeros = (fx: AppEffect[]) =>
  only(fx, "submit").flatMap((f) => {
    const e = f.kind === 2 ? decodeMemberEntry(f.signed) : undefined;
    return e?.ok && e.value.kind === "create" ? [e.value] : [];
  });

test("personal space 3: an app that reads to rest and finds no space makes it with the space nonce, once, and the keeper opens its first epoch", () => {
  const s = scene();
  s.epoch();
  const r = rig(s, {}, s.alice.first);
  const fx = r.connect();
  const [made] = entryZeros(fx);
  assert.ok(made, "entry 0 of the space is submitted");
  assert.deepEqual(made.nonce, spaceNonce(platform, s.alice.id));
  assert.deepEqual(made.signerDevice, s.alice.first.id);
  assert.deepEqual(fxOf(fx, "channel-refused"), []);
  const all = drive(s, r, fx, 5);
  assert.equal(
    only(all, "submit").filter((f) => f.kind === 3).length > 0,
    true,
    "the keeper starts its first epoch",
  );
  assert.equal(r.outWrites.at(-1)?.space ?? null, null, "read back: no space creation left");
  r.drop(100);
  assert.deepEqual(entryZeros(r.connect(2000)), [], "the next rest finds it");
});

test("personal space 3: no second space is made where one is read", () => {
  const s = scene({ space: true });
  s.epoch();
  assert.deepEqual(entryZeros(rig(s, {}, s.alice.first).connect()), []);
});

test("personal space 3: a space another device placed first answers 2: no refusal for the screen, no second try in the run", () => {
  const s = scene();
  s.epoch();
  const r = rig(s, {}, s.alice.first);
  const fx = r.connect();
  const from = s.wire.items.length;
  addChannel(s, spaceNonce(platform, s.alice.id), "bot").epoch(); // the bot placed it first
  const refused = r.give([...results(fx, 2), ...s.wire.push(from)], 5);
  assert.deepEqual(fxOf(refused, "channel-refused"), []);
  assert.deepEqual(fxOf(refused, "creating"), [], "the space is no creation for the screen");
  assert.equal(r.outWrites.at(-1)?.space ?? null, null);
  assert.deepEqual(entryZeros(refused), [], "its own entry is not made again");
});

test("personal space 2.6: a fault an older app stored on the space is dropped at the first rest, with a write and a note; a conversation channel's stays", () => {
  const s = scene({ space: true });
  s.epoch();
  const talk = addChannel(s, fill(9, 16));
  talk.epoch();
  const r = rig(
    s,
    { outbox: { pending: null, channels: [], faults: [s.channel, talk.id] } },
    s.alice.first,
  );
  const fx = r.connect();
  assert.deepEqual(
    fxOf(fx, "channel-fault").map((e) => e.channel),
    [s.channel, talk.id],
    "start tells both: nothing names the space yet",
  );
  assert.deepEqual(
    fxOf(fx, "channel-fault-dropped").map((e) => e.channel),
    [s.channel],
  );
  assert.deepEqual(r.outWrites.at(-1)?.faults, [talk.id]);
  assert.notEqual(r.link.send(s.channel, draftTo(s), 9), "fault");
  assert.equal(r.link.send(talk.id, draftTo(s), 9), "fault");
});

test("personal space 2.3: a spare takes no message, a fault stored on it is dropped, and its stored items are dropped as not delivered", () => {
  const s = scene({ space: true });
  s.epoch();
  const spare = addChannel(s, spaceNonce(platform, s.alice.id), "bot");
  spare.epoch();
  const stale = {
    name: fill(70, 16),
    kind: 1,
    content: "{}",
    to: null,
    re: null,
    files: [],
    built: null,
  };
  const r = rig(
    s,
    {
      outbox: {
        pending: null,
        channels: [{ channel: spare.id, items: [stale as never] }],
        faults: [spare.id],
      },
    },
    s.alice.first,
  );
  const fx = r.connect();
  assert.deepEqual(only(fx, "submit"), [], "nothing is built or sent into a spare");
  assert.deepEqual(
    fxOf(fx, "channel-fault-dropped").map((e) => e.channel),
    [spare.id],
  );
  assert.deepEqual(itemsOf(r.outWrites.at(-1), spare.id), [], "its items are gone");
  assert.deepEqual(
    fxOf(fx, "outbox").flatMap((e) =>
      bytesEqual(e.channel, spare.id) ? e.items.filter((i) => i.state === "refused") : [],
    ),
    [],
    "review P6: a spare's items are dropped silently, no refused row waits for a screen that never clears it",
  );
  assert.equal(r.link.send(spare.id, draftTo(s), 9), "not-member");
});

/** A name message (kind 14 to 16) of alice's first device in `channel`, sealed in `epoch`. */
function nameIn(
  s: Scene,
  channel: Bytes,
  epoch: { id: Bytes; key: Bytes },
  kind: number,
  content: string,
  n: number,
) {
  return signedBy(
    s.alice.first,
    sealMessage(
      platform,
      epoch.key,
      {
        channel,
        counter: n,
        epoch: epoch.id,
        sender: s.alice.first.id,
        run: fill(4, 16),
        incarnation: s.wire.incarnation,
        time: 1_700_000_000_000,
        kind,
        name: fill(80 + n, 16),
      },
      { files: [], content },
    ),
  );
}
const namesOf = (fx: AppEffect[]) =>
  fx.flatMap((e) =>
    e.do === "names" ? e.names.map((n) => [n.kind, idKey(n.target), n.name] as const) : [],
  );

test("names 3: a channel's, the person's and a device's names are told from their own channels, the latest place winning", () => {
  const s = scene({ space: true });
  const home = s.epoch();
  const talk = addChannel(s, fill(9, 16));
  const spare = addChannel(s, spaceNonce(platform, s.alice.id), "bot");
  s.wire.put(4, nameIn(s, talk.id, talk.epoch(), 14, encodeName(14, "docs"), 1));
  s.wire.put(4, nameIn(s, s.channel, home, 15, encodeName(15, "Alice"), 2));
  s.wire.put(4, nameIn(s, s.channel, home, 16, encodeName(16, "Mac one"), 3));
  s.wire.put(4, nameIn(s, spare.id, spare.epoch(), 15, encodeName(15, "From a spare"), 4));
  s.wire.put(4, nameIn(s, talk.id, talk.epoch(), 14, encodeName(14, "web"), 5));
  s.wire.put(4, nameIn(s, talk.id, talk.epoch(), 14, "not json", 6));
  const r = rig(s);
  const fx = r.connect();
  // Told as the reading goes, one call at a time: the last word of each target is its shown name.
  const last = new Map(namesOf(fx).map(([kind, target, name]) => [`${kind} ${target}`, name]));
  assert.deepEqual(
    [...last],
    [
      [`14 ${idKey(talk.id)}`, "web"],
      [`15 ${idKey(s.alice.id)}`, "Alice"],
      [`16 ${idKey(s.alice.first.id)}`, "Mac one"],
    ],
  );
});

test("names 3: a relay recreated reads the names again, and tells nothing when the shown one is the same", () => {
  const s = scene({ space: true });
  const talk = addChannel(s, fill(9, 16));
  s.wire.put(4, nameIn(s, talk.id, talk.epoch(), 14, encodeName(14, "docs"), 1));
  const r = rig(s);
  assert.equal(namesOf(r.connect()).length, 1);
  r.drop(1);
  s.wire.incarnation = fill(8, 16);
  assert.deepEqual(namesOf(r.connect(60_000)), []);
});

test("names 2.2 (D-N3 A): a kind 14 refused with result 1 by a relay older than the kind is no channel fault", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  const sent = post(r, s.channel, { kind: 14, content: encodeName(14, "general") });
  assert.equal(only(sent.effects, "submit").length, 1, "submitted");
  const fx = r.give(results(sent.effects, 1), 11);
  assert.deepEqual(fxOf(fx, "channel-fault"), [], "no fault on a refused name");
  assert.notEqual(r.link.send(s.channel, draftTo(s), 12), "fault", "the channel goes on");
});

test("personal space 2.6, review K4: a kind 15 refused with result 1 in the space drops the item and is no fault", () => {
  const s = scene({ space: true });
  s.epoch();
  const r = appRig(s);
  r.connect();
  const sent = post(r, s.channel, { kind: 15, content: encodeName(15, "Alice") });
  assert.equal(only(sent.effects, "submit").length, 1, "submitted");
  const fx = r.give(results(sent.effects, 1), 11);
  assert.deepEqual(fxOf(fx, "channel-fault"), [], "no fault in the space");
  assert.equal(itemsOf(r.outWrites.at(-1), s.channel).length, 0, "dropped");
});

test("names 2.1: a name is queued only in its own class and only when its content reads, with no file", () => {
  const conv = scene();
  conv.epoch();
  const rc = appRig(conv);
  rc.connect();
  const space = scene({ space: true });
  space.epoch();
  const rs = appRig(space);
  rs.connect();
  const bytes = new Uint8Array([1]);
  const file = [{ bytes, type: "text/plain", name: "a" }];
  assert.equal(
    rc.link.send(conv.channel, { kind: 15, content: encodeName(15, "Alice") }, 10),
    "bad-input",
    "a person name in a conversation channel",
  );
  assert.equal(
    rc.link.send(conv.channel, { kind: 16, content: encodeName(16, "Mac") }, 10),
    "bad-input",
    "a device name in a conversation channel",
  );
  assert.equal(
    rs.link.send(space.channel, { kind: 14, content: encodeName(14, "docs") }, 10),
    "bad-input",
    "a channel name in the space",
  );
  assert.equal(
    rc.link.send(conv.channel, { kind: 14, content: JSON.stringify({ name: "Docs" }) }, 10),
    "bad-input",
    "a content readName refuses",
  );
  assert.equal(
    rc.link.send(conv.channel, { kind: 14, content: encodeName(14, "docs"), files: file }, 10),
    "bad-input",
    "a name with a file",
  );
  assert.equal(
    rs.link.send(space.channel, { kind: 17, content: `{"base":null,"sections":[]}` }, 10),
    "bad-input",
    "an arrangement, which `arrange` alone writes",
  );
  assert.equal(
    typeof rc.link.send(conv.channel, { kind: 14, content: encodeName(14, "docs") }, 10),
    "object",
  );
  assert.equal(
    typeof rs.link.send(space.channel, { kind: 16, content: encodeName(16, "Mac") }, 10),
    "object",
  );
});

test("names 3: a name whose message opens in a later call, when its epoch key arrives, is told then", () => {
  const s = scene();
  const { epoch, seal } = lateEpoch(s);
  s.wire.put(4, nameIn(s, s.channel, epoch, 14, encodeName(14, "docs"), 1));
  const r = rig(s);
  assert.deepEqual(namesOf(r.connect()), [], "no key yet");
  r.drop(1);
  s.wire.seals = [seal()];
  assert.deepEqual(namesOf(r.connect(60_000, s.wire.items.length)), [
    [14, idKey(s.channel), "docs"],
  ]);
});

test("names 3: a first copy the device cannot open still places its later copy", () => {
  const s = scene();
  const late = lateEpoch(s); // its key never arrives
  const open = s.epoch();
  s.wire.put(4, nameIn(s, s.channel, late.epoch, 14, encodeName(14, "docs"), 1)); // the first copy of "docs"
  s.wire.put(4, nameIn(s, s.channel, open, 14, encodeName(14, "web"), 2));
  s.wire.put(4, nameIn(s, s.channel, open, 14, encodeName(14, "docs"), 1)); // the same name sent again, after "web"
  const last = namesOf(rig(s).connect()).at(-1);
  assert.deepEqual(last, [14, idKey(s.channel), "web"]);
});

test("names 3: a relay put back to before a history seal loses the epoch key, and the name that key opened is told as none", () => {
  const s = scene();
  const { epoch, seal } = lateEpoch(s);
  s.wire.put(4, nameIn(s, s.channel, epoch, 14, encodeName(14, "docs"), 1));
  s.wire.seals = [seal()];
  const r = rig(s);
  assert.deepEqual(
    namesOf(r.connect()).map((n) => n[2]),
    ["docs"],
    "shown once the history seal opened it",
  );
  r.drop(1);
  s.wire.incarnation = fill(8, 16); // a relay started again: a new incarnation, the same items
  s.wire.seals = []; // its seals put back to before the history seal (SD 5.10)
  assert.deepEqual(
    namesOf(r.connect(60_000)).map((n) => n[2]),
    [null],
    "the key is gone with the rewind: the name is told as none",
  );
});

test("review P1: the space's entry 0 has a slot of its own, so the person's New channel is never busy for it", () => {
  const s = scene();
  s.epoch();
  const r = rig(s, {}, s.alice.first);
  const fx = r.connect();
  assert.equal(entryZeros(fx).length, 1, "the space is being made");
  const w = r.outWrites.at(-1);
  assert.ok(w?.space, "kept in its own slot");
  assert.equal(w.pending, null, "the creation slot is free");
  const made = r.link.createChannel({ bot: s.bot.id, folder: "/work/x" }, 10);
  assert.ok(typeof made === "object", `a channel is made, not ${made}`);
  const sent = only(r.settle(made.effects, 10), "submit").filter((f) => f.kind === 2);
  assert.equal(sent.length, 1, "its entry goes beside the space's");
});

test("review P1: a restart with the space's creation kept sends the same entry again, in its slot", () => {
  const s = scene();
  s.epoch();
  const r = rig(s, {}, s.alice.first);
  const first = entryZeros(r.connect());
  const stored = r.outWrites.at(-1);
  assert.ok(stored?.space);
  r.drop(10);
  const t = rig(s, { outbox: stored }, s.alice.first);
  const [again] = only(t.connect(), "submit").filter((f) => f.kind === 2);
  assert.deepEqual(again?.signed, stored.space.signed);
  assert.equal(first.length, 1);
  assert.deepEqual(t.outWrites.at(-1)?.space ?? stored.space, stored.space);
});

test("review P1: a restart with the space's creation pending, the bot having placed the space meanwhile: no second space, nothing kept, no refusal shown", () => {
  const s = scene();
  s.epoch();
  const r = rig(s, {}, s.alice.first);
  assert.equal(entryZeros(r.connect()).length, 1, "made");
  const stored = r.outWrites.at(-1);
  assert.ok(stored?.space, "kept before it is sent");
  r.drop(10);
  addChannel(s, spaceNonce(platform, s.alice.id), "bot").epoch(); // the bot placed its space first
  const t = rig(s, { outbox: stored }, s.alice.first);
  const again = t.connect();
  assert.deepEqual(entryZeros(again), [], "review P3: not sent again once another space is read");
  assert.deepEqual(fxOf(again, "channel-refused"), []);
  assert.equal(t.outWrites.at(-1)?.space ?? null, null, "nothing kept");
});

test("review P7: a send() write that fails before the first rest's head leaves the stored space fault undropped and untold", () => {
  const s = scene({ space: true });
  s.epoch();
  const talk = addChannel(s, fill(9, 16));
  talk.epoch();
  const r = rig(s, { outbox: { pending: null, channels: [], faults: [s.channel] } }, s.alice.first);
  const started = r.settle(r.link.start(0), 0);
  const dial = started.find((e) => e.do === "dial");
  assert.ok(dial && dial.do === "dial");
  const conn = dial.conn;
  r.settle(r.link.opened(conn, BINDING, 0), 0);
  // The connection as `rig.connect` runs it, split before the head that ends the read.
  const frames = [s.wire.served(), ...s.wire.read(0)];
  const head = frames.pop();
  assert.ok(head && head.type === "head");
  r.settle(r.link.received(conn, encodeFrame({ type: "hello", relayNonce: fill(4) }, false), 0), 0);
  for (const f of frames) r.settle(r.link.received(conn, encodeFrame(f, true), 0), 0);
  r.failOutboxWrites(() => true);
  const sent = r.link.send(talk.id, draftTo(s), 1);
  assert.ok(typeof sent === "object", `queued before the rest: ${String(sent)}`);
  assert.equal(fxOf(r.settle(sent.effects, 1), "store-failed").length, 1, "the write failed");
  const rest = r.settle(r.link.received(conn, encodeFrame(head, true), 2), 2);
  assert.ok(
    rest.some((e) => e.do === "deliver" && e.out.do === "rest"),
    "the first rest",
  );
  assert.deepEqual(fxOf(rest, "channel-fault-dropped"), [], "no drop is told after a failed write");
});

// The names design, step N2 (sections 2.2, 4 and 4.4): the pending names of the app and when it writes them, as the model's rules say.
const storedNames = (r: Rig) => r.outWrites.at(-1)?.names ?? [];
const kindsOf = (fx: AppEffect[]) =>
  only(fx, "submit").map((f) => {
    const m = decodeMessage(f.signed);
    assert.ok(m.ok, "a message");
    return m.value.header.kind;
  });
const rename = (
  r: Rig,
  kind: 14 | 15 | 16,
  target: Bytes | undefined,
  text: string,
  now = 10,
  setup = false,
) => {
  const set = r.link.setName(kind, target, text, now, { setup });
  assert.ok(typeof set === "object", `a name is set, not ${set}`);
  return r.settle(set.effects, now);
};
const spaceRig = (over: Partial<AppLinkOptions> = {}) => {
  const s = scene({ space: true });
  s.epoch();
  return { s, r: rig(s, over, s.alice.first) };
};

test("names 4.2, 4.4: a person's name is pending in the store, written into the space under its message name, and cleared when it is read back", () => {
  const { s, r } = spaceRig();
  r.connect();
  const fx = rename(r, 15, undefined, "Alice", 10, true);
  assert.deepEqual(
    storedNames(r).map((n) => n.kind),
    [15],
    "kept in the store in one write",
  );
  const mine = storedNames(r)[0] as NonNullable<AppOutbox["names"]>[number];
  const sent = drive(s, r, fx, 11);
  const built = only(sent, "submit")
    .map((f) => decodeMessage(f.signed))
    .find((m) => m.ok && m.value.header.kind === 15);
  assert.ok(built?.ok, "submitted");
  assert.deepEqual(built.value.header.channel, s.channel, "into the space");
  assert.deepEqual(built.value.header.name, mine.name, "under the pending entry's message name");
  assert.deepEqual(storedNames(r), [], "read back: no longer pending");
  assert.deepEqual(namesOf(sent).at(-1), [15, idKey(s.alice.id), "Alice"]);
});

test("names 4.4: a restart before the send keeps the name and sends it under the same message name", () => {
  const { s, r } = spaceRig();
  r.connect();
  r.hold(true);
  const set = r.link.setName(15, undefined, "Alice", 10);
  assert.ok(typeof set === "object");
  const w = r.settle(set.effects, 10).at(-1);
  assert.ok(w?.do === "write");
  const stored = w.outbox;
  const t = rig(s, { outbox: stored }, s.alice.first);
  const sent = only(drive(s, t, t.connect(), 5), "submit").map((f) => decodeMessage(f.signed));
  const own = sent.find((m) => m.ok && m.value.header.kind === 15);
  assert.ok(own?.ok);
  assert.deepEqual(own.value.header.name, (stored.names ?? [])[0]?.name);
});

test("names 4.4, R3-1: a name renamed back to an earlier one is cleared by its message name alone: the earlier message of that name clears nothing", () => {
  const { s, r } = spaceRig();
  r.connect();
  drive(s, r, rename(r, 15, undefined, "Alpha"), 11);
  drive(s, r, rename(r, 15, undefined, "Beta", 30), 31);
  rename(r, 15, undefined, "Alpha", 50); // back to the first name, under a new message name
  const stored = storedNames(r);
  assert.equal(stored.length, 1);
  const t = rig(s, { outbox: r.outWrites.at(-1) as AppOutbox }, s.alice.first); // a restart: every start reads from position 0
  const fx = drive(s, t, t.connect(), 60);
  assert.deepEqual(
    namesOf(fx).at(-1),
    [15, idKey(s.alice.id), "Alpha"],
    "it shows after the restart",
  );
  assert.deepEqual(storedNames(t), []);
});

test("names 2.2, D-N3 A: a refused name stays pending, no other goes out on that connection and the queued ones are held in place; a new connection sends it again", () => {
  const { s, r } = spaceRig();
  r.connect();
  r.hold(true);
  const a = r.link.setName(15, undefined, "Alice", 10);
  const b = r.link.setName(16, undefined, "Mac one", 10);
  assert.ok(typeof a === "object" && typeof b === "object");
  r.hold(false);
  const fx = r.settle([...a.effects, ...b.effects], 10).concat(r.answer(true, 10));
  const first = only(fx, "submit");
  assert.deepEqual(kindsOf(fx), [15], "one name in flight");
  const after = r.give(results(fx, 1), 12);
  assert.deepEqual(fxOf(after, "channel-fault"), [], "no fault");
  assert.deepEqual(kindsOf(after), [], "the other name is not sent while the refusal holds");
  assert.equal(first.length, 1);
  assert.deepEqual(
    storedNames(r)
      .map((n) => n.kind)
      .sort(),
    [15, 16],
    "both still pending",
  );
  r.drop(13);
  const again = drive(s, r, r.connect(2000), 20);
  assert.deepEqual(
    [...new Set(kindsOf(again))].sort(),
    [15, 16],
    "the next connection sends both again",
  );
});

test("names 4.2: a setup name is dropped once the sequence holds a kind 15 of the person under another message name, and a rename is not", () => {
  const s = scene({ space: true });
  const home = s.epoch();
  s.wire.put(4, nameIn(s, s.channel, home, 15, encodeName(15, "Set since"), 2));
  const r = rig(s, {}, s.alice.first);
  rename(r, 15, undefined, "First setup", 0, true);
  const fx = r.connect();
  assert.deepEqual(
    kindsOf(fx).filter((k) => k === 15),
    [],
    "never sent",
  );
  assert.deepEqual(storedNames(r), [], "dropped from the store");
  assert.deepEqual(namesOf(fx).at(-1), [15, idKey(s.alice.id), "Set since"]);
  rename(r, 15, undefined, "A rename", 20);
  assert.equal(storedNames(r).length, 1, "a rename has no such condition");
});

test("names 4.2: the person's and the device's names wait for the space's first epoch, then go", () => {
  const s = scene({ space: true });
  const r = rig(s, {}, s.alice.first);
  r.connect();
  const fx = rename(r, 15, undefined, "Alice");
  assert.deepEqual(kindsOf(fx), []);
  assert.deepEqual(
    itemsOf(r.outWrites.at(-1), s.channel),
    [],
    "nothing queued while the space has no epoch",
  );
  s.epoch();
  r.drop(11);
  assert.deepEqual(kindsOf(r.connect(2000)), [15]);
});

test("names 4.1: a channel's rename is pending, kept in the store, and written in its own channel; a space or an unknown channel is refused", () => {
  const s = scene();
  s.epoch();
  const r = rig(s, {}, s.alice.first);
  r.connect();
  assert.equal(r.link.setName(14, fill(1, 32), "docs", 5), "not-member");
  assert.equal(r.link.setName(14, s.channel, "Not Allowed", 5), "bad-input");
  const fx = rename(r, 14, s.channel, "docs");
  assert.deepEqual(
    storedNames(r).map((n) => n.kind),
    [14],
  );
  const sent = drive(s, r, fx, 11);
  assert.deepEqual(namesOf(sent).at(-1), [14, idKey(s.channel), "docs"]);
  assert.deepEqual(storedNames(r), []);
});

test("names 4.3: an app with no kind 16 of its own takes the name it knows for itself, once", () => {
  const { s, r } = spaceRig({ ownName: "Mac one" });
  const fx = drive(s, r, r.connect(), 5);
  assert.deepEqual(namesOf(fx).at(-1), [16, idKey(s.alice.first.id), "Mac one"]);
  r.drop(50);
  const again = r.connect(3000);
  assert.deepEqual(kindsOf(again), [], "not written again");
  assert.deepEqual(storedNames(r), []);
});

test("names 4.3: an app that holds a kind 16 of its own in the sequence takes no name, and a name that does not read is none", () => {
  const s = scene({ space: true });
  const home = s.epoch();
  s.wire.put(4, nameIn(s, s.channel, home, 16, encodeName(16, "Mine"), 3));
  assert.deepEqual(kindsOf(rig(s, { ownName: "Mac one" }, s.alice.first).connect()), []);
  const t = spaceRig({ ownName: "bad\u0000name" });
  assert.deepEqual(kindsOf(t.r.connect()), []);
});

test("names 4.3, review T2: the name typed at a join is kept pending in the store at the first rest, so a restart before the space's epoch opens writes it, not the computer's name", () => {
  const s = scene({ space: true });
  const r = rig(s, { ownName: "Typed label" }, s.alice.first);
  r.connect();
  const stored = r.outWrites.at(-1);
  assert.deepEqual(
    (stored?.names ?? []).map((n) => [n.kind, n.content]),
    [[16, encodeName(16, "Typed label")]],
    "pending in the store before any epoch is open",
  );
  s.epoch();
  const t = rig(s, { outbox: stored as AppOutbox, ownName: "Computer" }, s.alice.first); // after the join the typed name is gone: the Mac's is the fallback
  const sent = drive(s, t, t.connect(), 5);
  assert.deepEqual(namesOf(sent).at(-1), [16, idKey(s.alice.first.id), "Typed label"]);
});

test("names 4.1, review T5: a second rename before the first went out replaces it, and only the second is sent", () => {
  const { s, r } = spaceRig();
  r.connect();
  r.hold(true);
  const a = r.link.setName(15, undefined, "First", 10);
  assert.ok(typeof a === "object");
  r.settle(a.effects, 10);
  r.answer(true, 11); // the first is queued, not built, its write held
  const b = r.link.setName(15, undefined, "Second", 12);
  assert.ok(typeof b === "object");
  r.hold(false);
  const fx = drive(s, r, [...r.settle(b.effects, 12), ...r.answer(true, 13)], 14);
  assert.deepEqual(kindsOf(fx), [15], "one name message goes out");
  assert.deepEqual(namesOf(fx).at(-1), [15, idKey(s.alice.id), "Second"]);
});

// Names, step N2 unit 3: the person's name typed at the first device's setup, and a channel's name given at its creation.
test("names 4.2: the first device writes the name typed at setup as the person's name, and its own device name is the Mac's", () => {
  const { s, r } = spaceRig({ typedName: "Ada Lovelace", ownName: "Mac one" });
  const fx = drive(s, r, r.connect(), 5);
  assert.deepEqual(
    namesOf(fx)
      .filter(([k]) => k === 15)
      .at(-1),
    [15, idKey(s.alice.id), "Ada Lovelace"],
  );
  assert.deepEqual(
    namesOf(fx)
      .filter(([k]) => k === 16)
      .at(-1),
    [16, idKey(s.alice.first.id), "Mac one"],
  );
});

test("names 4.2: the setup name yields to a kind 15 of the person already in the sequence", () => {
  const s = scene({ space: true });
  const home = s.epoch();
  s.wire.put(4, nameIn(s, s.channel, home, 15, encodeName(15, "Set elsewhere"), 2));
  const r = rig(s, { typedName: "Ada", ownName: "Mac one" }, s.alice.first);
  const fx = r.connect();
  assert.deepEqual(
    kindsOf(fx).filter((k) => k === 15),
    [],
    "never sent",
  );
  assert.deepEqual(
    namesOf(fx)
      .filter(([k]) => k === 15)
      .at(-1),
    [15, idKey(s.alice.id), "Set elsewhere"],
  );
});

test("names 4.3: a device that is not the first keeps the typed name as its device name and names no person", () => {
  const s = scene({ space: true });
  s.epoch();
  const r = rig(s, { typedName: "Studio label", ownName: "Computer" }); // the scene's bot stands in as a later device
  r.connect();
  assert.deepEqual(
    storedNames(r).map((n) => [n.kind, n.content]),
    [[16, encodeName(16, "Studio label")]],
  );
});

test("names 4.1: a channel's name given at its creation is pending in the same write as entry 0 and the bind, and shows once the channel is read", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  assert.equal(
    r.link.createChannel({ bot: s.bot.id, folder: "/work", name: "Not Allowed" }, 5),
    "bad-input",
  );
  r.hold(true);
  const made = r.link.createChannel({ bot: s.bot.id, folder: "/work", name: "docs" }, 10);
  assert.ok(typeof made === "object");
  const [w] = outboxes(r.settle(made.effects, 10));
  assert.ok(w?.pending, "entry 0 is in the write");
  assert.deepEqual(
    w.names?.map((n) => [n.kind, n.content]),
    [[14, encodeName(14, "docs")]],
    "and the name, in the one write",
  );
  assert.deepEqual(w.names?.[0]?.channel, made.channel);
  r.hold(false);
  const fx = drive(s, r, r.answer(true, 11), 12);
  assert.ok(namesOf(fx).some(([k, t, n]) => k === 14 && t === idKey(made.channel) && n === "docs"));
});

test("names 4.1, review V1: a refused creation leaves no pending name for the channel that never was", () => {
  const s = scene();
  s.epoch();
  const r = appRig(s);
  r.connect();
  const made = r.link.createChannel({ bot: s.bot.id, folder: "/work/docs", name: "docs" }, 10);
  assert.ok(typeof made === "object", `made: ${String(made)}`);
  const fx = r.settle(made.effects, 10);
  assert.equal(r.outWrites.at(-1)?.names?.length, 1, "the name is kept with entry 0");
  const refused = r.give(results(fx, 1), 12);
  assert.deepEqual(
    fxOf(refused, "channel-refused").map((e) => e.code),
    [1],
  );
  assert.deepEqual(
    (r.outWrites.at(-1)?.names ?? []).map((n) => n.kind),
    [],
    "gone with the channel",
  );
});

// Sidebar sections design 3 to 3.2 (PR P, unit 2a): `arrange`, its gate, the pending kind 17 entry and the order it goes out in.
type Act = Parameters<Rig["link"]["arrange"]>[0];
const SECTION = (n: number) => n.toString(16).padStart(2, "0").repeat(16);
/** A tree's content: `sections` are `[id, name, channels]`; `base` the identity it was built over. */
const treeOf = (
  base: { sender: Bytes; name: Bytes } | null,
  sections: [string, string, Bytes[]][],
) =>
  encodeArrangement({
    base: base && { sender: toHex(base.sender), name: toHex(base.name) },
    sections: sections.map(([id, name, channels]) => ({
      id,
      name,
      channels: channels.map(toHex),
      carried: Object.create(null),
    })),
    carried: Object.create(null),
  });
/** A kind 17 message of `by` in the space, sealed in `epoch`; its message name is `fill(120 + n)`. */
function treeIn(s: Scene, epoch: { id: Bytes; key: Bytes }, by: Keyed, content: string, n: number) {
  return signedBy(
    by,
    sealMessage(
      platform,
      epoch.key,
      {
        channel: s.channel,
        counter: n,
        epoch: epoch.id,
        sender: by.id,
        run: fill(4, 16),
        incarnation: s.wire.incarnation,
        time: 1_700_000_000_000,
        kind: 17,
        name: fill(120 + n, 16),
      },
      { files: [], content },
    ),
  );
}
const idOf = (by: Keyed, n: number) => ({ sender: by.id, name: fill(120 + n, 16) });
/** alice's first device as the app, a second app of hers, the space, two conversation channels; `late`: an earlier epoch whose key arrives by a history seal. */
function sectionsRig(options: { late?: boolean } = {}, over: Partial<AppLinkOptions> = {}) {
  const s = scene({ space: true });
  const other = keyed("app");
  s.entry(s.alice.add(s.log, other));
  const late = options.late ? lateEpoch(s) : undefined;
  const home = s.epoch();
  const talk = addChannel(s, fill(9, 16));
  const docs = addChannel(s, fill(10, 16));
  return { s, other, late, home, talk, docs, r: rig(s, over, s.alice.first) };
}
const queuedBy = (r: Rig, act: Act, now = 10) => {
  const a = r.link.arrange(act, now);
  assert.ok(typeof a === "object", `queued, not ${a}`);
  return { ...a, effects: r.settle(a.effects, now) };
};
const NEW = (name: string): Act => ({ type: "section-new", name });
const pendingTrees = (r: Rig) =>
  storedNames(r)
    .filter((n) => n.kind === 17)
    .map((n) => ({
      name: n.name,
      tree: readArrangement(n.content).ok
        ? (readArrangement(n.content) as { ok: true; value: Arrangement }).value
        : undefined,
    }));
const submitted = (fx: AppEffect[]) =>
  only(fx, "submit").flatMap((f) => {
    const m = decodeMessage(f.signed);
    return m.ok && m.value.header.kind === 17 ? [m.value.header.name] : [];
  });

test("sections 3: arrange stores one pending kind 17 entry, writes it into the space under its message name, and clears it when read back", () => {
  const { s, r } = sectionsRig();
  assert.equal(r.link.arrange(NEW("Work"), 5), "not-ready", "nothing is read");
  r.connect();
  const set = queuedBy(r, NEW("Work"));
  assert.equal(set.answer, "queued");
  const [mine] = storedNames(r);
  assert.ok(mine);
  assert.deepEqual([mine.kind, mine.setup, mine.channel], [17, false, undefined]);
  assert.deepEqual(mine.name, set.name);
  const read = readArrangement(mine.content);
  assert.ok(read.ok);
  assert.equal(read.value.base, null);
  assert.deepEqual(
    read.value.sections.map((x) => [x.name, x.channels]),
    [["Work", []]],
  );
  assert.match(read.value.sections[0]?.id ?? "", /^[0-9a-f]{32}$/);
  const sent = drive(s, r, set.effects, 11);
  assert.deepEqual(submitted(sent), [mine.name], "into the space, under the entry's name");
  assert.deepEqual(storedNames(r), [], "read back: no longer pending");
});

test("sections 3.1: arrange waits for the first rest of the connection; a push keeps it, a drop, a rewind and a refusal clear it", () => {
  const { s, r, home } = sectionsRig();
  const ok = () => typeof r.link.arrange(NEW("Work"), 12) === "object";
  assert.equal(ok(), false, "before any read");
  r.connect();
  assert.equal(ok(), true, "at rest");
  s.wire.put(4, nameIn(s, s.channel, home, 15, encodeName(15, "Alice"), 2));
  r.give(s.wire.push(s.wire.items.length - 1), 13);
  assert.equal(ok(), true, "a pushed message moves the reading to reading and back: kept");
  r.drop(20);
  assert.equal(ok(), false, "a dropped connection clears it");
  r.connect(30_000);
  assert.equal(ok(), true, "at rest again");
  s.wire.incarnation = fill(8, 16);
  r.give([s.wire.served()], 40);
  assert.equal(ok(), false, "a rewind clears it, until the pass reaches rest");
  r.give(s.wire.read(0), 41);
  assert.equal(ok(), true);
  r.give([{ type: "refused", reason: 3 }], 42);
  assert.equal(ok(), false, "refused");
  for (const [label, frame] of [
    ["put-back", { type: "refused", reason: 6 }],
    ["fault", s.wire.head(s.wire.items.length, fill(1))],
  ] as const) {
    const t = sectionsRig();
    t.r.connect();
    assert.equal(typeof t.r.link.arrange(NEW("Work"), 12), "object", label);
    t.r.give([frame], 13);
    assert.equal(t.r.link.arrange(NEW("Work"), 14), "not-ready", `after ${label}`);
  }
});

test("sections 3.1: no act while the first copy of a kind 17 of the space waits for its key, whenever it was placed; other kinds, spares and later copies do not wait", () => {
  const { s, r, late, home, other } = sectionsRig({ late: true });
  assert.ok(late);
  const act = () => r.link.arrange(NEW("Work"), 12);
  // Placed before the tree that can be read, and unopened: a second tree (built over none, here) is not enough.
  s.wire.put(4, treeIn(s, late.epoch, other, treeOf(null, [[SECTION(1), "Old", []]]), 1));
  s.wire.put(4, treeIn(s, home, other, treeOf(null, [[SECTION(2), "New", []]]), 2));
  s.wire.put(4, nameIn(s, s.channel, late.epoch, 15, encodeName(15, "Hidden"), 3)); // another kind, unopened: it does not count
  r.connect();
  assert.equal(act(), "not-ready", "behind");
  const held = s.epochs[0];
  assert.ok(held);
  s.wire.seals = [historySeal(held, other, s.alice.first, late.epoch.key)];
  r.drop(13);
  r.connect(60_000);
  assert.equal(typeof act(), "object", "the key came: current");
});

test("sections 3.1: a kind 17 that does not open under a key the device holds takes no part and is not waited for", () => {
  const { s, r, home, other } = sectionsRig();
  const wrong = { id: home.id, key: platform.random(32) };
  s.wire.put(4, treeIn(s, wrong, other, treeOf(null, [[SECTION(1), "Gone", []]]), 1));
  r.connect();
  assert.equal(typeof r.link.arrange(NEW("Work"), 12), "object");
});

test("sections 3: arrange answers bad-input for a form, a name, a move before itself, an id the arrangement or the sequence does not hold, too-many past a limit, and stores nothing", () => {
  const { r, talk } = sectionsRig();
  r.connect();
  const first = queuedBy(r, { type: "section-new", name: "Work", channel: toHex(talk.id) });
  const section = readArrangement(storedNames(r)[0]?.content ?? "");
  assert.ok(section.ok);
  const id = section.value.sections[0]?.id ?? "";
  const bad: [string, unknown][] = [
    ["no type", {}],
    ["null", null],
    ["unknown type", { type: "section-copy", name: "x" }],
    ["name not a string", { type: "section-new", name: 5 }],
    ["name of spaces at the ends", NEW(" Work")],
    ["empty name", NEW("")],
    ["name past 64 code points", NEW("x".repeat(65))],
    ["channel not a string", { type: "section-new", name: "A", channel: 3 }],
    [
      "a channel the sequence lacks",
      { type: "section-new", name: "A", channel: SECTION(1).repeat(2) },
    ],
    ["rename of a section not there", { type: "section-rename", section: SECTION(9), name: "A" }],
    ["move before itself", { type: "section-move", section: id, before: id }],
    ["move before a section not there", { type: "section-move", section: id, before: SECTION(9) }],
    ["remove of a section not there", { type: "section-remove", section: SECTION(9) }],
    [
      "channel move of a channel the sequence lacks",
      { type: "channel-move", channel: SECTION(1).repeat(2), section: null, before: null },
    ],
    [
      "a section move with a stray channel field, before itself",
      { type: "section-move", section: id, before: id, channel: toHex(talk.id) },
    ],
    ["an act typed constructor", { type: "constructor" }],
    ["an act typed __proto__", { type: "__proto__" }],
    ["an act typed hasOwnProperty", { type: "hasOwnProperty" }],
    ["an act typed toString", { type: "toString" }],
    [
      "channel move before itself",
      { type: "channel-move", channel: toHex(talk.id), section: id, before: toHex(talk.id) },
    ],
    [
      "channel move into a section not there",
      { type: "channel-move", channel: toHex(talk.id), section: SECTION(9), before: null },
    ],
    [
      "channel move before one not in that section",
      { type: "channel-move", channel: toHex(talk.id), section: id, before: SECTION(1).repeat(2) },
    ],
    [
      "channel move before with no section",
      { type: "channel-move", channel: toHex(talk.id), section: null, before: toHex(talk.id) },
    ],
  ];
  const before = JSON.stringify(storedNames(r));
  for (const [label, act] of bad) assert.equal(r.link.arrange(act as Act, 11), "bad-input", label);
  assert.equal(JSON.stringify(storedNames(r)), before, "nothing stored");
  assert.ok(first.name);
  for (let n = 1; n < 64; n++) queuedBy(r, NEW(`S${n}`));
  assert.equal(r.link.arrange(NEW("one too many"), 12), "too-many", "65 sections");
});

test("sections 3: section-new takes a null channel as none", () => {
  const { r } = sectionsRig();
  r.connect();
  queuedBy(r, { type: "section-new", name: "A", channel: null } as unknown as Act);
  assert.deepEqual(
    pendingTrees(r)[0]?.tree?.sections.map((x) => x.channels),
    [[]],
  );
});

test("sections 3.1: a connection the link ends itself (a deadline) clears the gate before the driver says closed, and a late closed of an earlier connection clears nothing", () => {
  const { r } = sectionsRig();
  const first = r.connect();
  const conn1 = (first.find((e) => e.do === "dial") as { conn: number }).conn;
  let now = 10;
  for (let i = 0; i < 40; i++) {
    now += 60_000;
    if (r.settle(r.link.tick(now), now).some((e) => e.do === "close")) break;
  }
  assert.equal(r.link.arrange(NEW("Offline"), now + 1), "not-ready", "the link's own close");
  now += 600_000;
  r.connect(now);
  assert.equal(typeof r.link.arrange(NEW("Back"), now + 1), "object");
  r.settle(r.link.closed(conn1, now + 2), now + 2);
  assert.equal(
    typeof r.link.arrange(NEW("Again"), now + 3),
    "object",
    "a stale closed changes nothing",
  );
});

test("sections 3: the five acts build the tree from the one shown, this device's pending entry first", () => {
  const { r, talk, docs } = sectionsRig();
  r.connect();
  const tree = () =>
    (pendingTrees(r).at(-1)?.tree?.sections ?? []).map((x) => [
      x.name,
      x.channels.map((c) => c.slice(0, 2)),
    ]);
  const c = (b: Bytes) => toHex(b);
  queuedBy(r, { type: "section-new", name: "A" });
  queuedBy(r, { type: "section-new", name: "B", channel: c(talk.id) });
  assert.deepEqual(tree(), [
    ["A", []],
    ["B", [c(talk.id).slice(0, 2)]],
  ]);
  const ids =
    pendingTrees(r)
      .at(-1)
      ?.tree?.sections.map((x) => x.id) ?? [];
  queuedBy(r, {
    type: "channel-move",
    channel: c(docs.id),
    section: ids[1] ?? null,
    before: c(talk.id),
  });
  assert.deepEqual(tree(), [
    ["A", []],
    ["B", [c(docs.id).slice(0, 2), c(talk.id).slice(0, 2)]],
  ]);
  queuedBy(r, { type: "channel-move", channel: c(talk.id), section: ids[0] ?? null, before: null });
  assert.deepEqual(tree(), [
    ["A", [c(talk.id).slice(0, 2)]],
    ["B", [c(docs.id).slice(0, 2)]],
  ]);
  queuedBy(r, { type: "section-move", section: ids[1] ?? "", before: ids[0] ?? null });
  assert.deepEqual(
    tree().map((x) => x[0]),
    ["B", "A"],
  );
  queuedBy(r, { type: "section-rename", section: ids[0] ?? "", name: "Renamed" });
  assert.deepEqual(
    tree().map((x) => x[0]),
    ["B", "Renamed"],
  );
  queuedBy(r, { type: "channel-move", channel: c(talk.id), section: null, before: null });
  assert.deepEqual(tree(), [
    ["B", [c(docs.id).slice(0, 2)]],
    ["Renamed", []],
  ]);
  queuedBy(r, { type: "section-remove", section: ids[0] ?? "" });
  assert.deepEqual(tree(), [["B", [c(docs.id).slice(0, 2)]]]);
});

test("sections 3: the channel ids the sequence does not hold are dropped from the tree an act builds, before the limits", () => {
  const { s, r, home, other, talk } = sectionsRig();
  const ghost = fill(77);
  s.wire.put(
    4,
    treeIn(s, home, other, treeOf(null, [[SECTION(1), "Theirs", [talk.id, ghost]]]), 1),
  );
  r.connect();
  queuedBy(r, { type: "section-rename", section: SECTION(1), name: "Mine" });
  const [entry] = pendingTrees(r);
  assert.deepEqual(
    entry?.tree?.sections[0]?.channels,
    [toHex(talk.id)],
    "the held channel stays, the ghost goes",
  );
  assert.deepEqual(entry?.tree?.base, { sender: toHex(other.id), name: toHex(fill(121, 16)) });
});

test("sections 3: the base is the standing tree's identity, the earliest unsigned entry's base when one is replaced, and a signed entry's identity when it stays", () => {
  const { s, r, home, other } = sectionsRig();
  s.wire.put(4, treeIn(s, home, other, treeOf(null, [[SECTION(1), "Theirs", []]]), 1));
  r.connect();
  r.hold(true);
  const a1 = r.link.arrange(NEW("A"), 10);
  const a2 = r.link.arrange(NEW("B"), 10);
  assert.ok(typeof a1 === "object" && typeof a2 === "object");
  r.settle(a1.effects, 10);
  r.settle(a2.effects, 10);
  r.hold(false);
  const sent = r.answer(true, 11);
  assert.deepEqual(submitted(sent), [a2.name], "one item: the replaced entry's is gone");
  const unsigned = pendingTrees(r);
  assert.equal(unsigned.length, 1, "the second replaced the first, which was not signed");
  assert.deepEqual(
    unsigned[0]?.tree?.base,
    { sender: toHex(other.id), name: toHex(fill(121, 16)) },
    "over the standing tree",
  );
  assert.deepEqual(unsigned[0]?.name, a2.name);
  assert.deepEqual(
    unsigned[0]?.tree?.sections.map((x) => x.name),
    ["Theirs", "A", "B"],
  );
  // Signed now: the next act leaves it and goes over it.
  const next = queuedBy(r, NEW("C"), 12);
  assert.deepEqual(next.name.length, 16);
  const both = pendingTrees(r);
  assert.equal(both.length, 2);
  assert.deepEqual(both[1]?.tree?.base, { sender: toHex(s.alice.first.id), name: toHex(a2.name) });
});

test("sections 3.2: entries go out in the order they were made, and an item the relay drops (result 8) passes nothing on: its entry is written again at the next connection, before the later one", () => {
  const { s, r } = sectionsRig();
  r.connect();
  const e1 = queuedBy(r, NEW("A"));
  const e2 = queuedBy(r, NEW("B"), 11);
  assert.deepEqual(submitted(e1.effects), [e1.name], "the first is in flight");
  const after = r.give(results(e1.effects, 8), 12);
  assert.deepEqual(submitted(after), [], "the second does not go out ahead of the first");
  assert.deepEqual(
    pendingTrees(r).map((p) => p.name),
    [e1.name, e2.name],
    "both still pending",
  );
  r.drop(13);
  const conn = r.connect(2000);
  const order = itemsOf(r.outWrites.at(-1), s.channel).map((i) => i.name);
  assert.deepEqual(
    order,
    [e1.name, e2.name],
    "its item is written again ahead of the later entry's",
  );
  const again = drive(s, r, conn, 20);
  assert.deepEqual(submitted(again).slice(0, 2), [e1.name, e2.name]);
  assert.deepEqual(storedNames(r), []);
});

test("sections 3: an act that replaces several unsigned entries takes the earliest one's base, over the last one's tree", () => {
  const { r } = sectionsRig();
  r.connect();
  const e1 = queuedBy(r, NEW("A"));
  const e2 = queuedBy(r, NEW("B"), 11);
  r.give(results(e1.effects, 8), 12); // E1's item is dropped: both entries lack a signed item
  const e3 = queuedBy(r, NEW("C"), 13);
  const [only3] = pendingTrees(r);
  assert.equal(pendingTrees(r).length, 1, "E1 and E2 are replaced");
  assert.deepEqual(only3?.name, e3.name);
  assert.equal(only3?.tree?.base, null, "E1's base, not E2's (which names E1)");
  assert.deepEqual(
    only3?.tree?.sections.map((x) => x.name),
    ["A", "B", "C"],
  );
});

test("sections 5: a refused kind 17 stays pending under its own mark: no fault, no more kind 17 on that connection, a name still goes, and a new connection sends it again", () => {
  const { s, r } = sectionsRig();
  r.connect();
  const e1 = queuedBy(r, NEW("A"));
  const refused = r.give(results(e1.effects, 1), 12);
  assert.deepEqual(fxOf(refused, "channel-fault"), [], "never a fault");
  const e2 = queuedBy(r, NEW("B"), 13);
  assert.deepEqual(submitted(e2.effects), [], "held on this connection");
  assert.deepEqual(itemsOf(r.outWrites.at(-1), s.channel), [], "and not even written");
  const named = rename(r, 15, undefined, "Alice", 14);
  assert.deepEqual(kindsOf(named), [15], "a name is not held back by it");
  assert.equal(pendingTrees(r).length, 1, "the entry is pending");
  r.drop(15);
  const fx = drive(s, r, r.connect(2000), 20);
  assert.equal(submitted(fx)[0]?.length, 16);
  assert.deepEqual(pendingTrees(r), [], "sent again on the next connection and read back");
});

test("sections 5: a refused name holds back no kind 17", () => {
  const { r } = sectionsRig();
  r.connect();
  const name = rename(r, 15, undefined, "Alice", 10);
  r.give(results(name, 1), 11);
  const e = queuedBy(r, NEW("A"), 12);
  assert.equal(submitted(e.effects).length, 1);
});

test("sections 3: a kind 17 entry kept in the store goes out after a restart, under the same message name", () => {
  const { s, r } = sectionsRig();
  r.connect();
  r.hold(true);
  const set = r.link.arrange(NEW("A"), 10);
  assert.ok(typeof set === "object");
  const w = r.settle(set.effects, 10).at(-1);
  assert.ok(w?.do === "write");
  const t = rig(s, { outbox: w.outbox }, s.alice.first);
  const sent = submitted(drive(s, t, t.connect(), 5));
  assert.deepEqual(sent, [set.name]);
});

test("sections 2: send refuses a draft of kind 17, since arrange is its one writer", () => {
  const { s, r } = sectionsRig();
  r.connect();
  assert.equal(r.link.send(s.channel, { kind: 17, content: treeOf(null, []) }, 10), "bad-input");
});

// Sidebar sections design 3.2 to 4.1 (PR P, unit 2b): after the walk, "not applied", the drop of entries that can no longer stand, the shown arrangement and the effect.
const arrangementsOf = (fx: AppEffect[]) => fxOf(fx, "arrangement");
const lastArrangement = (fx: AppEffect[]) => arrangementsOf(fx).at(-1);
const names17 = (fx: AppEffect[]) =>
  lastArrangement(fx)?.sections?.map((x) => [x.name, x.channels.length]);
/** A kind 17 message is put on the wire after what is there and pushed to the reading. */
const pushTree = (s: Scene, r: Rig, tree: ReturnType<typeof treeIn>, now: number) => {
  const from = s.wire.items.length;
  s.wire.put(4, tree);
  return r.give(s.wire.push(from), now);
};

test("sections 4.1: the effect tells the shown tree, current and behind when any differs, and nothing when none does", () => {
  const { s, r, home, other } = sectionsRig();
  const first = r.connect();
  assert.deepEqual(
    arrangementsOf(first).map(({ do: _, ...e }) => e),
    [{ sections: null, current: true, behind: false, notApplied: false }],
    "at the first rest: none shown, current",
  );
  const theirs = pushTree(
    s,
    r,
    treeIn(s, home, other, treeOf(null, [[SECTION(1), "Theirs", []]]), 1),
    12,
  );
  assert.deepEqual(names17(theirs), [["Theirs", 0]], "a standing tree from another device");
  const quiet = pushTree(s, r, nameIn(s, s.channel, home, 15, encodeName(15, "Alice"), 2), 13);
  assert.deepEqual(arrangementsOf(quiet), [], "a message that changes nothing tells nothing");
  const mine = queuedBy(r, NEW("Mine"), 14);
  assert.deepEqual(
    names17(mine.effects),
    [
      ["Theirs", 0],
      ["Mine", 0],
    ],
    "this device's pending tree first",
  );
});

test("sections 4.1: behind tells a first copy of a kind 17 that waits for its key, and current turns back on when it opens", () => {
  const { s, r, late, other } = sectionsRig({ late: true });
  assert.ok(late);
  s.wire.put(4, treeIn(s, late.epoch, other, treeOf(null, [[SECTION(1), "Old", []]]), 1));
  const fx = r.connect();
  assert.deepEqual(
    arrangementsOf(fx).map(({ do: _, ...e }) => e),
    [{ sections: null, current: false, behind: true, notApplied: false }],
  );
  const held = s.epochs[0];
  assert.ok(held);
  s.wire.seals = [historySeal(held, other, s.alice.first, late.epoch.key)];
  r.drop(13);
  const again = r.connect(60_000);
  const { do: _, ...last } = lastArrangement(again) as Extract<AppEffect, { do: "arrangement" }>;
  assert.deepEqual(last, {
    sections: [{ id: SECTION(1), name: "Old", channels: [] }],
    current: true,
    behind: false,
    notApplied: false,
  });
});

test("sections 3.2: an own tree that took no part, read back in this run, raises notApplied, and the next act clears it", () => {
  const { s, r, home, other } = sectionsRig();
  r.connect();
  const mine = queuedBy(r, NEW("Mine"), 11);
  pushTree(s, r, treeIn(s, home, other, treeOf(null, [[SECTION(1), "Theirs", []]]), 1), 12); // placed before ours
  const placed = drive(s, r, mine.effects, 13);
  const told = lastArrangement(placed);
  assert.deepEqual(
    [told?.notApplied, told?.current, names17(placed)],
    [true, true, [["Theirs", 0]]],
  );
  const next = queuedBy(r, NEW("Again"), 20);
  assert.equal(lastArrangement(next.effects)?.notApplied, false, "cleared at the next act");
});

test("sections 3.2: an own tree of an earlier run that took no part raises no line: only read-backs of this run are judged", () => {
  const { s, r, home, other } = sectionsRig();
  s.wire.put(4, treeIn(s, home, other, treeOf(null, [[SECTION(1), "Theirs", []]]), 1));
  s.wire.put(4, treeIn(s, home, s.alice.first, treeOf(null, [[SECTION(2), "Stale", []]]), 2));
  const fx = r.connect();
  assert.deepEqual(names17(fx), [["Theirs", 0]]);
  assert.ok(fx.every((e) => e.do !== "arrangement" || !e.notApplied));
});

test("sections 3.2: an own tree that stands, with another device's built over it, raises no notApplied", () => {
  const { s, r, home, other } = sectionsRig();
  r.connect();
  const mine = queuedBy(r, NEW("Mine"), 11);
  const fx = drive(s, r, mine.effects, 12);
  const over = treeOf({ sender: s.alice.first.id, name: mine.name }, [[SECTION(2), "Later", []]]);
  const later = pushTree(s, r, treeIn(s, home, other, over, 3), 30);
  assert.deepEqual(names17(later), [["Later", 0]], "the later tree stands");
  assert.ok([...fx, ...later].every((e) => e.do !== "arrangement" || !e.notApplied));
});

test("sections 3.2: an own tree that took no part is not counted, nor the entry over it dropped, while a first copy placed before it waits for its key (behind stays); both happen once the key arrives", () => {
  const { s, r, late, home, other } = sectionsRig({ late: true });
  assert.ok(late);
  r.connect();
  const mine = queuedBy(r, NEW("Mine"), 11);
  const over = queuedBy(r, NEW("Over"), 11); // built over it
  s.wire.put(4, treeIn(s, late.epoch, other, treeOf(null, [[SECTION(1), "Hidden", []]]), 1));
  s.wire.put(4, treeIn(s, home, other, treeOf(null, [[SECTION(2), "Theirs", []]]), 2));
  r.give(s.wire.push(s.wire.items.length - 2), 12);
  const placed = place(s, r, [...mine.effects, ...over.effects], 13); // E1 lands; E2's item is in flight, not placed
  assert.ok(
    placed.every((e) => e.do !== "arrangement" || !e.notApplied),
    "not judged",
  );
  assert.deepEqual(
    storedNames(r).map((n) => n.name),
    [over.name],
    "nothing is dropped while the verdict can still change",
  );
  const held = s.epochs[0];
  assert.ok(held);
  s.wire.seals = [historySeal(held, other, s.alice.first, late.epoch.key)];
  r.drop(20);
  const after = r.connect(60_000);
  assert.deepEqual(
    [lastArrangement(after)?.behind, lastArrangement(after)?.notApplied],
    [false, true],
    "the key arrived: the verdict is given",
  );
  assert.deepEqual(storedNames(r), [], "and the entry built over it goes");
});

test("sections 3.2: an entry built over an own tree that took no part is dropped with its item when the item is not built, the line is raised, and a redo stands", () => {
  const { s, r, home, other } = sectionsRig();
  r.connect();
  const e1 = queuedBy(r, NEW("A"), 11);
  const e2 = queuedBy(r, NEW("B"), 12); // built over E1; its item waits behind E1's
  pushTree(s, r, treeIn(s, home, other, treeOf(null, [[SECTION(1), "Theirs", []]]), 1), 13);
  const placed = drive(s, r, [...e1.effects, ...e2.effects], 14);
  assert.deepEqual(storedNames(r), [], "E1 read back, E2 dropped: nothing pending");
  assert.deepEqual(itemsOf(r.outWrites.at(-1), s.channel), [], "E2's item is gone");
  const told = lastArrangement(placed);
  assert.deepEqual(
    [told?.notApplied, names17(placed)],
    [true, [["Theirs", 0]]],
    "the standing tree shows, with the line",
  );
  const redo = queuedBy(r, NEW("Redo"), 30);
  drive(s, r, redo.effects, 31);
  const fresh = rig(s, {}, s.alice.first);
  assert.deepEqual(
    names17(fresh.connect()),
    [
      ["Theirs", 0],
      ["Redo", 0],
    ],
    "a device that reads it all shows the redo",
  );
});

test("sections 3.2: a built item of a dropped entry stays and goes out, and an entry built over it is dropped too; it takes no part where it lands", () => {
  const { s, r, home, other } = sectionsRig();
  r.connect();
  const e1 = queuedBy(r, NEW("A"), 11);
  r.give(results(e1.effects, 0), 12); // the relay holds E1; not read back
  const e2 = queuedBy(r, NEW("B"), 13); // built over E1 and sent at once
  assert.deepEqual(submitted(e2.effects), [e2.name]);
  queuedBy(r, NEW("C"), 13); // built over E2, through it over E1
  pushTree(s, r, treeIn(s, home, other, treeOf(null, [[SECTION(1), "Theirs", []]]), 1), 14);
  const [first] = only(e1.effects, "submit");
  assert.ok(first);
  const from = s.wire.items.length;
  s.wire.put(first.kind, { signed: first.signed, sig: first.sig });
  const fx = r.give(s.wire.push(from), 15);
  assert.deepEqual(
    storedNames(r),
    [],
    "E1 read back, E2's entry dropped and E3's with it, through E2",
  );
  assert.deepEqual(
    itemsOf(r.outWrites.at(-1), s.channel).map((i) => i.name),
    [e2.name],
    "E2's built item stays, E3's is gone",
  );
  assert.equal(lastArrangement(fx)?.notApplied, true);
});

test("sections 3.2: a restart whose stored entry was built over an own tree that took no part drops it and tells it, though that tree was not read back in this run", () => {
  const { s, r, home, other } = sectionsRig();
  r.connect();
  const e1 = queuedBy(r, NEW("A"), 11);
  const e2 = queuedBy(r, NEW("B"), 12);
  const stored = r.outWrites.at(-1) as AppOutbox;
  assert.equal(stored.names?.length, 2);
  // Another device's tree is placed first; E1 lands and takes no part, read back by the first run.
  pushTree(s, r, treeIn(s, home, other, treeOf(null, [[SECTION(1), "Theirs", []]]), 1), 13);
  const [first] = only(e1.effects, "submit");
  assert.ok(first);
  s.wire.put(first.kind, { signed: first.signed, sig: first.sig });
  const kept = {
    ...stored,
    names: (stored.names ?? []).filter((n) => bytesEqual(n.name, e2.name)),
  };
  const t = rig(s, { outbox: { ...kept, channels: [] } }, s.alice.first);
  const fx = t.connect();
  assert.deepEqual(storedNames(t), [], "dropped");
  assert.equal(lastArrangement(fx)?.notApplied, true);
});

test("sections 4.1: a relay recreated with the same tree tells nothing new about it: current goes off for the pass and on at its rest (the none half is the next test)", () => {
  const { s, r, home, other } = sectionsRig();
  const content = treeOf(null, [[SECTION(1), "Theirs", []]]);
  s.wire.put(4, treeIn(s, home, other, content, 1));
  r.connect();
  s.wire.incarnation = fill(8, 16);
  const same = r.give([s.wire.served(), ...s.wire.read(0)], 20);
  assert.deepEqual(
    arrangementsOf(same).map((e) => [e.current, e.sections?.map((x) => x.name)]),
    [
      [false, ["Theirs"]],
      [true, ["Theirs"]],
    ],
    "current goes off for the pass and on at its rest; the tree is never told as none",
  );
});

test("sections 4.1: after a rewind the tree is told as none at the rest when the new pass cannot open it, and not before", () => {
  const { s, r, late, other } = sectionsRig({ late: true });
  assert.ok(late);
  s.wire.put(4, treeIn(s, late.epoch, other, treeOf(null, [[SECTION(1), "Old", []]]), 1));
  const held = s.epochs[0];
  assert.ok(held);
  s.wire.seals = [historySeal(held, other, s.alice.first, late.epoch.key)];
  assert.deepEqual(names17(r.connect()), [["Old", 0]]);
  s.wire.seals = []; // the new incarnation lacks the seal: the key is gone
  s.wire.incarnation = fill(9, 16);
  const none = r.give([s.wire.served(), ...s.wire.read(0)], 30);
  assert.deepEqual(
    arrangementsOf(none).map((e) => [e.current, e.behind, e.sections?.map((x) => x.name) ?? null]),
    [
      [false, false, ["Old"]],
      [false, true, null],
    ],
    "the tree stands for the pass, and none is told at its rest",
  );
});

test("sections 3.2: the walk is judged at rest alone: a push fed frame by frame and in one chunk gives the same drop and the same line", () => {
  const { s, r, late, home, other } = sectionsRig({ late: true });
  assert.ok(late);
  r.connect();
  queuedBy(r, NEW("A"), 11);
  const stored = r.outWrites.at(-1) as AppOutbox;
  const template = stored.names?.[0];
  assert.ok(template);
  s.wire.put(4, treeIn(s, home, other, treeOf(null, [[SECTION(1), "Theirs", []]]), 1));
  // An entry built over an own tree that will take no part; a first copy that waits comes after that tree, in the same push.
  const over = {
    ...template,
    name: fill(50, 16),
    content: treeOf(idOf(s.alice.first, 2), [[SECTION(3), "B", []]]),
  };
  const box = { ...stored, names: [over], channels: [] };
  const [byFrame, inOne] = [
    rig(s, { outbox: box }, s.alice.first),
    rig(s, { outbox: box }, s.alice.first),
  ];
  byFrame.connect();
  inOne.connect();
  const from = s.wire.items.length;
  s.wire.put(4, treeIn(s, home, s.alice.first, treeOf(null, [[SECTION(2), "Mine", []]]), 2));
  s.wire.put(4, treeIn(s, late.epoch, other, treeOf(null, [[SECTION(4), "Hidden", []]]), 3));
  const frames = s.wire.push(from);
  const [a, b] = [byFrame.give(frames, 20), inOne.chunk(frames, 20)];
  for (const [t, fx] of [
    [byFrame, a],
    [inOne, b],
  ] as const) {
    assert.equal(storedNames(t).length, 1, "the entry is kept while a first copy waits");
    assert.ok(
      fx.every((e) => e.do !== "arrangement" || !e.notApplied),
      "and no line",
    );
  }
});

test("sections 3.2: an own tree whose first copy waits for its key is not judged; once it opens and took no part, the line rises", () => {
  const { s, r, late, home, other } = sectionsRig({ late: true });
  assert.ok(late);
  r.connect();
  queuedBy(r, NEW("A"), 11);
  const stored = r.outWrites.at(-1) as AppOutbox;
  const template = stored.names?.[0];
  assert.ok(template);
  s.wire.put(4, treeIn(s, home, other, treeOf(null, [[SECTION(1), "Theirs", []]]), 1));
  // The pending entry's message is placed in the epoch whose key has not come: read back, not opened.
  s.wire.put(4, treeIn(s, late.epoch, s.alice.first, treeOf(null, [[SECTION(2), "Mine", []]]), 2));
  const t = rig(
    s,
    { outbox: { ...stored, names: [{ ...template, name: fill(122, 16) }], channels: [] } },
    s.alice.first,
  );
  const first = t.connect();
  assert.ok(first.every((e) => e.do !== "arrangement" || !e.notApplied));
  const held = s.epochs[0];
  assert.ok(held);
  s.wire.seals = [historySeal(held, other, s.alice.first, late.epoch.key)];
  t.drop(30);
  const after = t.connect(60_000);
  assert.equal(lastArrangement(after)?.notApplied, true, "the verdict comes with the key");
});

/** A text of `sender` in `channel` naming `files` ({blob, key, size}), as `message` does but with the keys and sizes the test gives. */
const withFiles = (
  s: Scene,
  epoch: { id: Bytes; key: Bytes },
  counter: number,
  files: { blob: Bytes; key: Bytes; size: number }[],
) =>
  signedBy(
    s.alice.first,
    sealMessage(
      platform,
      epoch.key,
      {
        channel: s.channel,
        counter,
        epoch: epoch.id,
        sender: s.alice.first.id,
        run: fill(4, 16),
        incarnation: s.wire.incarnation,
        time: 1_700_000_000_000,
        kind: 1,
        name: fill(60 + counter, 16),
      },
      {
        files: files.map(({ blob, key, size }) => ({
          blob,
          fileKey: key,
          size,
          type: "x",
          name: "f",
        })),
        content: "{}",
      },
    ),
  );

test("G 3.6: the package keeps the key of each file of a body it opens, and opens a fetched blob with it; a bad hash, a bad key, a wrong length is a file that can no longer be read, and a blob no opened body names is unknown", () => {
  const s = scene();
  const epoch = s.epoch();
  const text = Uint8Array.of(7, 8, 9, 10);
  const good = sealBlobUnderKey(platform, fill(9), text);
  const wrongKey = sealBlobUnderKey(platform, fill(7), text);
  assert.equal(good.blob.length, text.length + SEAL_OVERHEAD);
  s.wire.put(
    4,
    withFiles(s, epoch, 1, [
      { blob: good.id, key: fill(9), size: text.length },
      { blob: wrongKey.id, key: fill(9), size: text.length },
    ]),
  );
  const r = rig(s);
  const [view] = messages(r.connect());
  assert.ok(view);
  assert.ok(
    view.files?.every((f) => !("fileKey" in f)),
    "no key crosses the bridge",
  );
  const other = fill(8, 32);
  assert.deepEqual(r.link.openFile(s.channel, good.id, good.blob), { ok: true, value: text });
  const refused = { ok: false, error: "open-failed" };
  const unknown = { ok: false, error: "unknown" }; // no key held: the app may try again once the history is read
  assert.deepEqual(r.link.openFile(s.channel, good.id, wrongKey.blob), refused, "a bad hash");
  assert.deepEqual(r.link.openFile(s.channel, wrongKey.id, wrongKey.blob), refused, "a bad key");
  assert.deepEqual(
    r.link.openFile(s.channel, good.id, good.blob.slice(0, 5)),
    refused,
    "cut short",
  );
  assert.deepEqual(r.link.openFile(s.channel, other, good.blob), unknown, "no body names it");
  assert.deepEqual(r.link.openFile(other, good.id, good.blob), unknown, "another channel's");
  const fresh = rig(s); // a launch starts with no key: the history is read again first
  assert.deepEqual(fresh.link.openFile(s.channel, good.id, good.blob), unknown);
  fresh.connect();
  assert.deepEqual(fresh.link.openFile(s.channel, good.id, good.blob), { ok: true, value: text });
});

test("G4: getBlob takes the sealed size from the key map, never from the caller; a blob no opened body names is unknown", () => {
  const s = scene();
  const epoch = s.epoch();
  const good = sealBlobUnderKey(platform, fill(9), Uint8Array.of(7, 8, 9, 10));
  s.wire.put(4, withFiles(s, epoch, 1, [{ blob: good.id, key: fill(9), size: 4 }]));
  const r = rig(s);
  assert.equal(r.link.getBlob(s.channel, good.id, 0), "unknown", "before the history is read");
  r.connect();
  assert.equal(r.link.getBlob(s.channel, fill(8, 32), 0), "unknown", "no body names it");
  assert.equal(r.link.getBlob(fill(8, 32), good.id, 0), "unknown", "another channel's");
  const got = r.link.getBlob(s.channel, good.id, 0);
  assert.ok(typeof got !== "string", "a get");
  const ask = got.effects.flatMap((e) => {
    if (e.do !== "send") return [];
    const f = decodeFrame(e.bytes, false, "relay");
    const g = f.ok ? f : decodeFrame(e.bytes, true, "relay");
    return g.ok && g.value.type === "get-blob" ? [g.value] : [];
  })[0];
  assert.ok(ask, "the get-blob frame goes out");
  const sealed = 4 + SEAL_OVERHEAD;
  const frame = (size: number, request = ask.request): Frame => ({
    type: "blob",
    request,
    size,
    offset: 0,
    chunk: new Uint8Array(sealed),
  });
  const taken = r.give([frame(sealed)], 10);
  assert.equal(
    taken.filter((e) => e.do === "blob").length,
    1,
    "a frame of the sealed size (plaintext + tag) is taken",
  );
  const refused = r.link.getBlob(s.channel, good.id, 20);
  assert.ok(typeof refused !== "string");
  const wire = refused.effects.flatMap((e) => {
    if (e.do !== "send") return [];
    const f = decodeFrame(e.bytes, false, "relay");
    const g = f.ok ? f : decodeFrame(e.bytes, true, "relay");
    return g.ok && g.value.type === "get-blob" ? [g.value.request] : [];
  })[0] as number;
  const bad = r.give([frame(4, wire)], 30);
  assert.deepEqual(
    bad.filter((e) => e.do === "answer").map((e) => e.do === "answer" && e.code),
    [1],
    "a frame that says the plaintext size is refused",
  );
});

test("CR-3: the first key a blob was named with in a channel stays; a later body naming it with another key cannot swap it", () => {
  const s = scene();
  const epoch = s.epoch();
  const text = Uint8Array.of(7, 8, 9, 10);
  const good = sealBlobUnderKey(platform, fill(9), text);
  s.wire.put(4, withFiles(s, epoch, 1, [{ blob: good.id, key: fill(9), size: 4 }]));
  s.wire.put(4, withFiles(s, epoch, 2, [{ blob: good.id, key: fill(5), size: 4 }]));
  const r = rig(s);
  r.connect();
  assert.deepEqual(r.link.openFile(s.channel, good.id, good.blob), { ok: true, value: text });
});

test("CR-7: the keys go when the relay is another: the history is read again and names them anew", () => {
  const s = scene();
  const epoch = s.epoch();
  const good = sealBlobUnderKey(platform, fill(9), Uint8Array.of(7, 8, 9, 10));
  s.wire.put(4, withFiles(s, epoch, 1, [{ blob: good.id, key: fill(9), size: 4 }]));
  const r = rig(s);
  r.connect();
  r.drop(1);
  s.wire.items.splice(0, s.wire.items.length);
  s.wire.incarnation = fill(8, 16);
  r.connect(60_000);
  assert.equal(r.link.openFile(s.channel, good.id, good.blob).ok, false);
});
