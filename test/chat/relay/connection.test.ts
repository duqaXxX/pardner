/**
 * The bot's connection (design 3.5) against a real relay in a child process: a proof, a reading to
 * rest, a cut stream, a refused bot, a restart and a relay put back by hand. The clock is a double
 * that records each back-off and never waits; a fake relay stands in for what a real one never says.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createServer, connect as tcp } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { TLSSocket, createServer as tlsServer } from "node:tls";
import { queryObjects, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Connection } from "../../../src/chat/relay/connection.ts";
import { botPlatform, loadPairing, pair } from "../../../src/chat/relay/pairing.ts";
import { identityOf, Store, storePath } from "../../../src/chat/relay/store.ts";
import { decode } from "../../../src/protocol/bytes.ts";
import { readDevice } from "../../../src/protocol/device-log.ts";
import { decodeFrame, encodeFrame, type Frame, FrameCutter } from "../../../src/protocol/frames.ts";
import { deviceId, relayKeyId } from "../../../src/protocol/ids.ts";
import type { Bytes } from "../../../src/protocol/platform.ts";
import type { Out } from "../../../src/protocol/reading.ts";
import { DARWIN } from "../../relay/process-support.ts";
import { platform } from "../../relay/support.ts";
import { addBody, keyed, person } from "../../relay/world.ts";
import { fakeRelay } from "../../support/scripted-device/fake-relay.ts";
import { dial } from "../../support/scripted-device/link.ts";
import { RelayProcess } from "../../support/scripted-device/relay-process.ts";
import { tempDirSync } from "../../support/temp.ts";

const hex = (b: Bytes) => Buffer.from(b).toString("hex");
const ACT = { op: "act", line: 0 };

/** A TCP hop between the bot and the relay, so that a test can cut a connection after the bytes it chooses. */
async function hop(port: () => number) {
  const state = { connections: 0, last: 0, cutAt: undefined as number | undefined, cut: 0 };
  const server = createServer((client) => {
    state.connections += 1;
    state.last = 0;
    const up = tcp(port(), "127.0.0.1");
    for (const s of [client, up]) s.on("error", () => {});
    client.on("data", (d) => up.write(d));
    client.on("close", () => up.destroy());
    up.on("close", () => client.destroy());
    up.on("data", (received) => {
      const d = received as Buffer;
      const before = state.last;
      state.last += d.length;
      if (state.cutAt !== undefined && state.last > state.cutAt) {
        // The bytes up to the cut go through, so that whole records of the stream arrive before it ends.
        client.write(d.subarray(0, state.cutAt - before));
        state.cutAt = undefined;
        state.cut += 1;
        setImmediate(() => {
          client.destroy();
          up.destroy();
        });
      } else client.write(d);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { state, port: (server.address() as { port: number }).port, close: () => server.close() };
}

let counter = 0;
/** A relay, a person on it, and a paired bot folder. `add` names whether the person added the bot's device. */
async function rig(options: { add?: boolean; copyBeforeAdd?: boolean } = {}) {
  const tag = `conn${++counter}`;
  const relay = new RelayProcess();
  let target = await relay.open();
  const alice = person(keyed("app", `${tag}-app`), keyed("app", `${tag}-sheet`));
  const dir = tempDirSync("pardner-chat-");
  const string = await pair(dir, alice.id, target.relay);
  const bot = decode(Uint8Array.from(Buffer.from(string, "hex")), (r) => ({
    device: readDevice(r),
    proof: r.sig(),
  }));
  assert.ok(bot.ok);
  const log: { id: Bytes }[] = [{ id: alice.id }];
  const ids = () => log.map((e) => hex(e.id));
  const submit = async (body: Record<string, unknown>) => {
    const link = await dial(platform, target.port, target.relay);
    link.enrol(target.secret as Bytes, alice.genesis);
    const served = await link.proveActive(alice.id, alice.first.id, alice.first.sign);
    assert.equal(served.type, "served");
    const e = alice.entry(log as never, body);
    const answer = await link.submit(1, e);
    link.close();
    assert.deepEqual(answer, { type: "result", request: 1, code: 0 });
    log.push({ id: platform.sha256(e.signed) });
  };
  const addBot = () => submit({ kind: "add", device: bot.value.device, proof: bot.value.proof });
  const hopped = await hop(() => target.port);
  if (options.copyBeforeAdd) {
    await submit(addBody(alice, keyed("app", `${tag}-copy`))).catch(() => {}); // the relay must hold alice first
    log.length = 1;
  }
  if (options.add !== false) await addBot();
  return {
    relay,
    alice,
    dir,
    log,
    ids,
    hop: hopped,
    addBot,
    remove: (id: Bytes) => submit({ kind: "remove", device: id }),
    join: (n: number) =>
      (async () => {
        for (let i = 0; i < n; i++) await submit(addBody(alice, keyed("app", `${tag}-j${i}`)));
      })(),
    act: async (name: string, step: Record<string, unknown> = {}) => {
      target = (await relay.act(name, { ...ACT, ...step })).target;
    },
    async stop() {
      hopped.close();
      await relay.act("stop", { ...ACT });
    },
  };
}

/** A clock whose time moves when a test says so: `idle` timers fire in `advance`, a back-off is recorded by `onWait` and passes at once. */
function fakeClock(onWait: (ms: number) => Promise<void>) {
  let now = 0;
  const timers = new Set<{ due: number; resolve: (late: boolean) => void }>();
  return {
    advance(ms: number) {
      now += ms;
      for (const t of [...timers]) {
        if (t.due > now) continue;
        timers.delete(t);
        t.resolve(true);
      }
    },
    clock: {
      now: () => now,
      wait: async (_ms: number, signal: AbortSignal) => {
        await onWait(_ms);
        return !signal.aborted;
      },
      idle: (ms: number, signal: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          if (signal.aborted) return resolve(false);
          const t = { due: now + ms, resolve };
          timers.add(t);
          signal.addEventListener(
            "abort",
            () => {
              timers.delete(t);
              resolve(false);
            },
            { once: true },
          );
        }),
    },
  };
}

/** A bot on `dir`: its connection, what it said, and a clock that records back-offs. */
function botOn(
  dir: string,
  address: () => { host: string; port: number },
  hook: (n: number) => Promise<void> | void = () => {},
) {
  const pairing = loadPairing(dir);
  const held = botPlatform(dir);
  const store = Store.open(dir, identityOf(held, pairing.device, pairing.relay));
  const outs: Out[] = [];
  const lines: string[] = [];
  const delays: number[] = [];
  const states: string[] = []; // the reading's state at each back-off
  const cursors: number[] = [];
  const watchers = new Set<() => void>();
  const poke = () => {
    for (const w of watchers) w();
  };
  const time = fakeClock(async (ms) => {
    delays.push(ms);
    states.push(connection.reading.state);
    cursors.push(connection.reading.cursor);
    poke();
    await hook(delays.length);
  });
  const connection = new Connection({
    address,
    pairing,
    platform: held,
    store,
    log: (line) => {
      lines.push(line);
      poke();
    },
    on: (out) => {
      outs.push(out);
      poke();
    },
    clock: time.clock,
  });
  const count = (what: Out["do"]) => outs.filter((o) => o.do === what).length;
  const until = (done: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (done()) {
          watchers.delete(check);
          resolve();
        }
      };
      watchers.add(check);
      AbortSignal.timeout(30_000).addEventListener("abort", () =>
        reject(new Error(`waited for what never came: ${lines.join(" | ")}`)),
      );
      check();
    });
  return {
    connection,
    store,
    outs,
    lines,
    delays,
    states,
    cursors,
    time,
    poke,
    held,
    count,
    until,
    async stop() {
      await connection.stop();
      held.erase();
    },
  };
}

const at = (port: number) => () => ({ host: "127.0.0.1", port });

test("the bot connects, proves, reads to rest and keeps what it read", DARWIN, async () => {
  const r = await rig();
  const b = botOn(r.dir, at(r.hop.port));
  try {
    b.connection.start();
    await b.until(() => b.count("rest") === 1);
    assert.equal(r.hop.state.connections, 1);
    assert.equal(b.connection.reading.sendable, true);
    assert.deepEqual(b.connection.reading.kept.ids.map(hex), r.ids());
    assert.equal(b.connection.reading.kept.head?.head.n, 2);
    assert.deepEqual(b.delays, []);
    // The store on disk holds the head and the ids, and the incarnation the relay served.
    const again = Store.open(
      r.dir,
      identityOf(platform, loadPairing(r.dir).device, loadPairing(r.dir).relay),
    );
    assert.deepEqual(again.saved.kept.ids.map(hex), r.ids());
    assert.equal(again.saved.kept.head?.head.n, 2);
    assert.equal(again.saved.incarnation?.length, 16);
    assert.ok(b.lines.every((l) => l.startsWith("relay: ")));
    // A start from the store knows the incarnation it last read under.
    await b.connection.stop();
    const next = botOn(r.dir, at(r.hop.port));
    next.connection.start();
    await next.until(() => next.count("incarnation") === 1);
    assert.equal((next.outs[0] as { first: boolean }).first, false);
    await next.stop();
  } finally {
    await b.stop();
    await r.stop();
  }
});

// C6: a connection cut while the reading is under way: what it took is neither lost nor doubled.
test(
  "C6: a connection cut mid-stream is dialed again after 1 s and reads on from its cursor",
  DARWIN,
  async () => {
    const r = await rig();
    await r.join(60);
    const whole = botOn(r.dir, at(r.hop.port));
    whole.connection.start();
    await whole.until(() => whole.count("rest") === 1);
    const total = r.hop.state.last;
    await whole.stop();
    // A bot with no store reads from 0 again; the first connection is cut at 85% of the bytes of a whole one.
    rmSync(storePath(r.dir));
    r.hop.state.cutAt = Math.floor(total * 0.85);
    const b = botOn(r.dir, at(r.hop.port));
    try {
      b.connection.start();
      await b.until(() => b.count("rest") >= 1);
      assert.equal(r.hop.state.cut, 1, "the first connection was cut");
      assert.deepEqual(b.delays, [1000]);
      assert.equal(b.states[0], "reading", "the drop left rest");
      assert.ok(
        (b.cursors[0] as number) > 0 && (b.cursors[0] as number) < 62,
        "it took part of it",
      );
      assert.equal(b.connection.reading.devices.length, 62, "every entry once");
      assert.deepEqual(b.connection.reading.kept.ids.map(hex), r.ids());
      assert.equal(b.connection.reading.cursor, 62);
      // The second connection read on from the cursor: it was sent the rest, not the whole sequence.
      assert.ok(r.hop.state.last < total * 0.8, `${r.hop.state.last} of ${total} bytes`);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "refused 2 with no head dials again, 1 s then 2 s, and is served once the person adds the bot",
  DARWIN,
  async () => {
    const r = await rig({ add: false });
    const b = botOn(r.dir, at(r.hop.port), async (n) => {
      if (n === 2) await r.addBot();
    });
    try {
      b.connection.start();
      await b.until(() => b.count("rest") === 1);
      assert.deepEqual(b.delays.slice(0, 2), [1000, 2000]);
      assert.equal(b.lines.filter((l) => l === "relay: refused, reason 2").length, 2);
      assert.ok(!b.lines.some((l) => /giving back/.test(l)), "it has no head to give");
      assert.equal(b.connection.reading.kept.head?.head.n, 2);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "a relay restart is a new incarnation: the reading starts again and rests",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r.dir, at(r.hop.port));
    try {
      b.connection.start();
      await b.until(() => b.count("rest") === 1);
      const first = b.store.saved.incarnation;
      await r.act("restart");
      await b.until(() => b.count("rest") === 2);
      const incarnations = b.outs.filter((o) => o.do === "incarnation");
      assert.equal(incarnations.length, 2);
      assert.notDeepEqual(b.store.saved.incarnation, first);
      assert.deepEqual(b.connection.reading.kept.ids.map(hex), r.ids());
      assert.ok(b.delays.length >= 1, "the cut connection was dialed again after a back-off");
      assert.equal(
        b.states[0],
        "reading",
        "the drop left rest: nothing is sent between connections",
      );
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

// C12: the relay's directory put back to before the bot's add; the bot holds a head.
test(
  "C12: refused 2 while holding a head gives back once, the relay fails closed, put back is final",
  DARWIN,
  async () => {
    const r = await rig({ add: false });
    await r.act("copy", { as: "before" });
    await r.addBot();
    const b = botOn(r.dir, at(r.hop.port));
    try {
      b.connection.start();
      await b.until(() => b.count("rest") === 1);
      await r.act("put-back", { copy: "before" });
      await b.until(() => b.count("put-back") === 1);
      assert.equal(b.lines.filter((l) => /giving back/.test(l)).length, 1);
      assert.equal(b.connection.reading.state, "put-back");
      assert.equal(b.store.saved.kept.putBack, true);
      // The answer to the give-back put the relay back at once: no wait of the slow cadence.
      assert.ok(!b.delays.includes(600_000));
      await b.connection.stop();
      // A bot started again from the store dials nothing.
      const dials = r.hop.state.connections;
      const again = botOn(r.dir, at(r.hop.port));
      again.connection.start();
      await again.connection.stop();
      assert.equal(again.connection.reading.state, "put-back");
      assert.equal(r.hop.state.connections, dials);
      assert.equal(again.count("put-back"), 1, "a start from a stored put-back says so");
      assert.ok(again.lines.some((l) => /must be recreated/.test(l)));
      await again.stop();
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test("a fault stops the bot: it dials no more", async () => {
  const dir = tempDirSync("pardner-chat-");
  const zero = new Uint8Array(32);
  let relayKey: Bytes = new Uint8Array();
  let connections = 0;
  const fake = await fakeRelay(platform, (reply, count) => {
    if (count !== 1) return;
    connections += 1;
    reply({ type: "served", incarnation: new Uint8Array(16) }, {
      ...fake.head(0, zero),
      sig: new Uint8Array(64),
    } as never);
  });
  relayKey = fake.key;
  await pair(dir, platform.random(32), relayKey);
  const b = botOn(dir, at(fake.port));
  try {
    b.connection.start();
    await b.until(() => b.count("fault") === 1);
    await b.connection.stop();
    assert.equal(b.connection.reading.state, "fault");
    assert.deepEqual(b.delays, []);
    assert.ok(b.lines.some((l) => /^relay: fault, .*the bot dials no more$/.test(l)));
    assert.equal(b.store.saved.fault, true);
    // A start from the store dials nothing; a new pairing clears the fault.
    const again = botOn(dir, at(fake.port));
    again.connection.start();
    await again.stop();
    assert.equal(again.count("fault"), 1);
    assert.equal(again.connection.reading.state, "fault");
    assert.equal(connections, 1);
    await pair(dir, platform.random(32), relayKey);
    const paired = loadPairing(dir);
    const held = botPlatform(dir);
    assert.equal(Store.open(dir, identityOf(held, paired.device, paired.relay)).saved.fault, false);
    held.erase();
  } finally {
    await b.stop();
    fake.close();
  }
});

test("a relay with another key is sent no frame and is dialed again", async () => {
  const dir = tempDirSync("pardner-chat-");
  let received = 0;
  const fake = await fakeRelay(platform, () => {
    received += 1;
  });
  await pair(dir, platform.random(32), new Uint8Array(65).fill(4)); // not the fake's key
  const b = botOn(dir, at(fake.port), (n) => {
    if (n === 2) void b.connection.stop();
  });
  try {
    b.connection.start();
    await b.until(() => b.delays.length >= 2);
    assert.equal(received, 0);
    assert.deepEqual(b.delays.slice(0, 2), [1000, 2000]);
    assert.ok(b.lines.some((l) => /not the one the bot was paired with/.test(l)));
  } finally {
    await b.stop();
    fake.close();
  }
});

/** A paired folder for a bot talking to a fake relay with `key`. */
async function paired(key: Bytes) {
  const dir = tempDirSync("pardner-chat-");
  await pair(dir, platform.random(32), key);
  return dir;
}

const SERVED = { type: "served", incarnation: new Uint8Array(16) } as const;
const ZERO = new Uint8Array(32);
const POSITION = { type: "position", from: 0, incarnation: new Uint8Array(16) } as never;

// CV1: RD 4.6's 15 minutes count what the bot sends. Pushes received do not move its idle read.
test("the idle read is due 10 minutes after the bot's last frame, whatever the relay pushes", async () => {
  let sent = 0;
  let push: ((head: Frame) => void) | undefined;
  let same: Frame = SERVED; // the head the relay signed, sent again as a push: unchanged
  const fake = await fakeRelay(platform, (reply, count) => {
    sent += 1;
    b.poke();
    if (count === 1) reply(SERVED);
    if (count === 2) reply(POSITION, same);
    push = (head) => reply(head);
  });
  same = fake.head(0, ZERO);
  const b = botOn(await paired(fake.key), at(fake.port));
  const change = b.store.change.bind(b.store);
  let writes = 0;
  b.store.change = (edit) => {
    writes += 1;
    return change(edit);
  };
  try {
    b.connection.start();
    await b.until(() => b.count("rest") === 1);
    b.time.advance(300_000);
    push?.(same);
    await b.until(() => b.count("rest") === 2);
    assert.equal(sent, 2, "nothing is due yet");
    assert.equal(writes, 2, "a rest that changed nothing writes nothing");
    b.time.advance(300_000);
    await b.until(() => sent === 3);
    // CR4: a read nobody answers is a dead connection, found within 30 s.
    b.time.advance(30_000);
    await b.until(() => b.delays.length === 1);
    assert.ok(b.lines.some((l) => /no frame for 30 s/.test(l)));
    assert.equal(b.states[0], "reading");
  } finally {
    await b.stop();
    fake.close();
  }
});

test("a relay silent before rest is dropped after 30 s", async () => {
  const fake = await fakeRelay(platform, (reply, count) => {
    if (count === 1) reply(SERVED);
  });
  const b = botOn(await paired(fake.key), at(fake.port));
  try {
    b.connection.start();
    await b.until(() => b.count("incarnation") === 1);
    b.time.advance(29_999);
    b.time.advance(1);
    await b.until(() => b.delays.length === 1);
    assert.ok(b.lines.some((l) => l === "relay: no frame for 30 s, connection dropped"));
  } finally {
    await b.stop();
    fake.close();
  }
});

test("refused 5 and refused 1 ask again every 10 minutes, not at the back-off", async () => {
  const fake = await fakeRelay(platform, (reply, count) => {
    if (count === 1) reply({ type: "refused", reason: 5 });
  });
  const b = botOn(await paired(fake.key), at(fake.port), (n) => {
    if (n === 2) void b.connection.stop();
  });
  try {
    b.connection.start();
    await b.until(() => b.delays.length === 2);
    assert.deepEqual(b.delays, [600_000, 600_000]);
  } finally {
    await b.stop();
    fake.close();
  }
});

test("a removed bot gives its head back, then asks again every 10 minutes", DARWIN, async () => {
  const r = await rig();
  const b = botOn(r.dir, at(r.hop.port), (n) => {
    if (n === 2) void b.connection.stop();
  });
  try {
    b.connection.start();
    await b.until(() => b.count("rest") === 1);
    const pairing = loadPairing(r.dir);
    await r.remove(deviceId(platform, pairing.device.signing, pairing.device.receiving));
    await b.until(() => b.delays.length === 2);
    assert.deepEqual(b.delays, [600_000, 600_000]);
    assert.equal(b.lines.filter((l) => /giving back/.test(l)).length, 1, "once per series");
  } finally {
    await b.stop();
    await r.stop();
  }
});

// Refused 6 on the first connection: final, with nothing to give back.
test("refused 6 puts the bot back for good: a start from the store dials nothing and says so", async () => {
  let connections = 0;
  const fake = await fakeRelay(platform, (reply, count) => {
    if (count !== 1) return;
    connections += 1;
    reply({ type: "refused", reason: 6 });
  });
  const dir = await paired(fake.key);
  const b = botOn(dir, at(fake.port));
  try {
    b.connection.start();
    await b.until(() => b.count("put-back") === 1);
    assert.deepEqual(b.delays, []);
    assert.equal(b.store.saved.kept.putBack, true);
    await b.connection.stop();
    const again = botOn(dir, at(fake.port));
    again.connection.start();
    await again.stop();
    assert.equal(again.count("put-back"), 1, "a start from a stored put-back says so");
    assert.ok(again.lines.some((l) => /must be recreated/.test(l)));
    assert.equal(connections, 1);
  } finally {
    await b.stop();
    fake.close();
  }
});

/** A paired folder whose store holds a head of the fake relay, so that a refusal makes the bot give it back. */
async function holding(fake: {
  key: Bytes;
  port: number;
  head: (n: number, chain: Bytes) => Frame;
}) {
  const dir = await paired(fake.key);
  const seed = botOn(dir, at(fake.port));
  const head = fake.head(0, ZERO) as Frame & { sig: Bytes };
  await seed.store.change((s) => {
    s.kept = {
      ids: [],
      head: { head: { relay: relayKeyId(platform, fake.key), n: 0, chain: ZERO }, sig: head.sig },
      putBack: false,
    };
  });
  await seed.stop();
  return dir;
}

/** A fake relay that refuses 2 on its first connection and `second` on its next ones, and says nothing more. */
const refusing = (second: 2 | 3 | 6 | "silent", onUpload: () => void = () => {}) => {
  let connections = 0;
  return fakeRelay(platform, (reply, count) => {
    if (count !== 1) return;
    connections += 1;
    if (connections === 1) reply({ type: "refused", reason: 2 });
    else {
      onUpload();
      if (second !== "silent") reply({ type: "refused", reason: second });
    }
  });
};

// CV3: refused 6 on the give-back's own connection is the relay failing closed.
test("refused 6 on the give-back connection puts the bot back at once", async () => {
  const fake = await refusing(6);
  const b = botOn(await holding(fake), at(fake.port));
  try {
    b.connection.start();
    await b.until(() => b.count("put-back") === 1);
    assert.deepEqual(b.delays, []);
  } finally {
    await b.stop();
    fake.close();
  }
});

// G1: an error in the give-back is a drop that still tells the reading it got no answer: the bot asks again at the slow cadence.
test("a give-back that throws leaves the refusal acted on: the bot asks again every 10 minutes", async () => {
  const fake = await refusing("silent");
  const b = botOn(await holding(fake), at(fake.port), (n) => {
    if (n === 1) void b.connection.stop();
  });
  let signs = 0;
  const sign = b.held.sign.bind(b.held);
  b.held.sign = (name, message) => {
    if (++signs === 2) throw new Error("the key is gone");
    return sign(name, message);
  };
  try {
    b.connection.start();
    await b.until(() => b.delays.length === 1);
    assert.deepEqual(b.delays, [600_000]);
    assert.ok(b.lines.includes("relay: connection error: the key is gone"));
  } finally {
    await b.stop();
    fake.close();
  }
});

// G4: a refusal of the give-back other than 6 is logged with its reason and slows the bot down.
test("a refusal of the give-back other than 6 is logged and the bot asks again every 10 minutes", async () => {
  const fake = await refusing(3);
  const b = botOn(await holding(fake), at(fake.port), (n) => {
    if (n === 1) void b.connection.stop();
  });
  try {
    b.connection.start();
    await b.until(() => b.delays.length === 1);
    assert.deepEqual(b.delays, [600_000]);
    assert.ok(b.lines.includes("relay: give-back refused, reason 3"));
  } finally {
    await b.stop();
    fake.close();
  }
});

// G6: stopping the bot while it waits for the give-back's answer records no refusal that never came.
test("a stop during the give-back acts on no answer", async () => {
  let uploading = false;
  const fake = await refusing("silent", () => {
    uploading = true;
    b.poke();
  });
  const b = botOn(await holding(fake), at(fake.port));
  try {
    b.connection.start();
    await b.until(() => uploading);
    await b.connection.stop();
    assert.ok(!b.lines.some((l) => /^relay: refused/.test(l)), "no answer came, none is acted on");
    assert.deepEqual(b.delays, []);
  } finally {
    await b.stop();
    fake.close();
  }
});

// CV4: a store that does not write is a drop; the bot dials again and tells the caller once it is at rest.
test("a failed store write is a drop: the reading is not sendable, the bot dials again", async () => {
  const fake = await fakeRelay(platform, (reply, count) => {
    if (count === 1) reply(SERVED);
    if (count === 2) reply(POSITION, fake.head(0, ZERO));
  });
  const b = botOn(await paired(fake.key), at(fake.port));
  const change = b.store.change.bind(b.store);
  let writes = 0;
  b.store.change = (edit) =>
    ++writes === 2 ? Promise.reject(new Error("no space left on device")) : change(edit);
  try {
    b.connection.start();
    await b.until(() => b.count("rest") === 1);
    assert.deepEqual(b.delays, [1000]);
    assert.equal(b.states[0], "reading", "not sendable while no connection holds it");
    assert.ok(b.lines.includes("relay: connection error: no space left on device"));
    assert.equal(b.connection.reading.sendable, true);
  } finally {
    await b.stop();
    fake.close();
  }
});

// CV2: the pin is the key's DER, so a certificate with any kind of key is another key, and the dial goes on.
test("a certificate of a kind of key the pin cannot name is another key, not the end of dialing", async () => {
  const folder = tempDirSync("pardner-chat-");
  const [key, cert] = [join(folder, "k.pem"), join(folder, "c.pem")];
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa-pss", "-pkeyopt", "rsa_keygen_bits:2048"]
      .concat(["-pkeyopt", "rsa_pss_keygen_md:sha256", "-keyout", key, "-out", cert])
      .concat(["-nodes", "-subj", "/CN=x", "-days", "1"]),
    { stdio: "ignore" },
  );
  let connections = 0;
  const server = tlsServer(
    { key: readFileSync(key), cert: readFileSync(cert), minVersion: "TLSv1.3" },
    (socket) => {
      connections += 1;
      socket.on("error", () => {});
      socket.write(encodeFrame({ type: "hello", relayNonce: platform.random(32) }, false));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const b = botOn(
    await paired(new Uint8Array(65).fill(4)),
    at((server.address() as { port: number }).port),
    (n) => {
      if (n === 2) void b.connection.stop();
    },
  );
  try {
    b.connection.start();
    await b.until(() => b.delays.length === 2);
    assert.equal(b.lines.filter((l) => /not the one the bot was paired with/.test(l)).length, 2);
    assert.equal(connections, 0, "no frame was read from it");
  } finally {
    await b.stop();
    server.close();
  }
});

// The Link delivers the reading's `refused`; the daemon logs it and tells the caller nothing, as before the driver.
test("refused is logged and never passed to `on`", DARWIN, async () => {
  const r = await rig({ add: false });
  const b = botOn(r.dir, at(r.hop.port), (n) => {
    if (n === 1) void b.connection.stop();
  });
  try {
    b.connection.start();
    await b.until(() => b.delays.length === 1);
    assert.ok(b.lines.includes("relay: refused, reason 2"));
    assert.ok(!b.outs.some((o) => o.do === "refused"));
  } finally {
    await b.stop();
    await r.stop();
  }
});

const ITEM = [1, new Uint8Array(1), new Uint8Array(64)] as const;
const within = <T>(p: Promise<T>, what: string) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} never settled`)), 2000).unref(),
    ),
  ]);

// A submit that comes after the loop ended, or queued behind the stop, settles with `undefined`.
test("a submit after a stop, or queued behind it, resolves undefined", DARWIN, async () => {
  const r = await rig();
  const b = botOn(r.dir, at(r.hop.port));
  try {
    b.connection.start();
    await b.until(() => b.count("rest") === 1);
    const stopping = b.connection.stop();
    const queued = b.connection.submit(...ITEM);
    await stopping;
    assert.equal(await within(queued, "a submit queued behind the stop"), undefined);
    assert.equal(await within(b.connection.submit(...ITEM), "a submit after the stop"), undefined);
  } finally {
    await b.stop();
    await r.stop();
  }
});

// A connection stopped before it started never dials.
test("a start after a stop dials nothing", DARWIN, async () => {
  const r = await rig();
  const b = botOn(r.dir, at(r.hop.port));
  try {
    await b.connection.stop();
    b.connection.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(r.hop.state.connections, 0);
  } finally {
    await b.stop();
    await r.stop();
  }
});

/** A connection on `dir` whose `on` is `tell`, with a clock whose back-offs pass at once, and what it logged. */
function driven(dir: string, port: number, tell: (out: Out) => void) {
  const pairing = loadPairing(dir);
  const held = botPlatform(dir);
  const store = Store.open(dir, identityOf(held, pairing.device, pairing.relay));
  const lines: string[] = [];
  const delays: number[] = [];
  const connection = new Connection({
    address: at(port),
    pairing,
    platform: held,
    store,
    log: (line) => lines.push(line),
    on: tell,
    clock: {
      now: () => 0,
      wait: async (ms, signal) => {
        delays.push(ms);
        return !signal.aborted;
      },
      idle: (_ms, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve(false))),
    },
  });
  return { connection, store, lines, delays, held };
}

/** Frames as one write, so that the bot cuts them all in one call. */
const oneChunk = (...frames: Frame[]) => Buffer.concat(frames.map((f) => encodeFrame(f, true)));

/** Polls `done` every 10 ms for 2 s; both timers end with the wait, whichever way it goes. */
const eventually = (done: () => boolean, what: string) =>
  new Promise<void>((resolve, reject) => {
    const end = () => (clearInterval(poll), clearTimeout(give));
    const poll = setInterval(() => done() && (end(), resolve()), 10);
    const give = setTimeout(() => (end(), reject(new Error(`${what} never came`))), 2000);
  });

// 2.1 #11: a throw while the effects are performed is a drop, and the rest of the list is still done.
test("a throwing `on` before a store write: the write is done, and the bot dials again", async () => {
  const fake = await fakeRelay(platform, (reply, count) => {
    if (count === 1) reply(oneChunk(SERVED, POSITION, fake.head(0, ZERO)));
  });
  let thrown = false;
  const b = driven(await paired(fake.key), fake.port, (out) => {
    if (out.do === "incarnation" && !thrown) {
      thrown = true;
      throw new Error("boom");
    }
  });
  try {
    await b.store.change((s) => {
      s.incarnation = new Uint8Array(16); // the relay's: nothing to write for it, only to tell
    });
    b.connection.start();
    await eventually(() => b.store.saved.kept.head !== undefined, "the write of kept");
    assert.ok(b.lines.includes("relay: connection error: boom"));
    assert.ok(b.delays.length >= 1, "the throw was a drop: a back-off followed");
  } finally {
    await b.connection.stop();
    b.held.erase();
    fake.close();
  }
});

// N1: a throw before a `dial upload` in one list drops the connection it was about, not the upload.
test("a throw while the head is given back does not destroy the upload connection", async () => {
  let connections = 0;
  const fake = await fakeRelay(platform, (reply, count) => {
    if (count !== 1) return;
    connections += 1;
    if (connections === 1) reply(oneChunk(SERVED, POSITION, fake.head(0, ZERO)));
    else reply({ type: "refused", reason: 3 });
  });
  const dir = await paired(fake.key);
  const head = fake.head(0, ZERO) as Frame & { sig: Bytes };
  const seed = driven(dir, fake.port, () => {});
  await seed.store.change((s) => {
    s.incarnation = new Uint8Array(16);
    s.kept = {
      ids: [new Uint8Array(32).fill(7)],
      head: { head: { relay: relayKeyId(platform, fake.key), n: 0, chain: ZERO }, sig: head.sig },
      putBack: false,
    };
  });
  seed.held.erase();
  let thrown = false;
  const b = driven(dir, fake.port, (out) => {
    if (out.do === "incarnation" && !thrown) {
      thrown = true;
      throw new Error("boom");
    }
  });
  try {
    b.connection.start();
    await eventually(
      () => b.lines.includes("relay: give-back refused, reason 3"),
      "the upload's refusal",
    );
    assert.ok(connections >= 2, "the relay saw the upload connection");
  } finally {
    await b.connection.stop();
    b.held.erase();
    fake.close();
  }
});

// I1: a connection the peer closed leaves nothing behind: no socket outlives the redials.
test("sockets the peer closed are released", async () => {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const dir = tempDirSync("pardner-chat-");
  await pair(dir, platform.random(32), new Uint8Array(65).fill(4));
  const live = () => {
    setFlagsFromString("--expose-gc");
    runInNewContext("gc")();
    return queryObjects(TLSSocket, { format: "count" });
  };
  live(); // a first collection frees what earlier tests left, so the baseline is what stays alive
  const before = live();
  const b = driven(dir, (server.address() as { port: number }).port, () => {});
  try {
    b.connection.start();
    await eventually(() => b.delays.length >= 20, "twenty redials");
  } finally {
    await b.connection.stop();
    b.held.erase();
    server.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(live() <= before, `${live() - before} sockets left`);
});

// D5: the outbox drains every channel at once, so two submits are in flight together and each gets its own result.
test("two submits at once both reach the relay and each is answered", DARWIN, async () => {
  const cutter = new FrameCutter();
  const seen: number[] = [];
  const fake = await fakeRelay(platform, (reply, count, data) => {
    if (count === 1) return reply(oneChunk(SERVED, POSITION, fake.head(0, ZERO)));
    cutter.push(data);
    for (let cut = cutter.next(true); cut.ok && cut.value; cut = cutter.next(true)) {
      const frame = decodeFrame(cut.value, true, "relay");
      if (frame.ok && frame.value.type === "submit") {
        seen.push(frame.value.request);
        reply({
          type: "result",
          request: frame.value.request,
          code: frame.value.request - 2 ? 1 : 0,
        });
      }
    }
  });
  const b = botOn(await paired(fake.key), at(fake.port));
  try {
    b.connection.start();
    await b.until(() => b.count("rest") === 1);
    const both = await within(
      Promise.all([b.connection.submit(...ITEM), b.connection.submit(...ITEM)]),
      "two submits",
    );
    assert.deepEqual(both, [0, 1], "each submit gets the code of its own request");
    assert.deepEqual(seen.sort(), [2, 3]);
  } finally {
    await b.stop();
    fake.close();
  }
});
