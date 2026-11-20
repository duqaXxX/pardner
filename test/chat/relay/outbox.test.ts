/**
 * What the bot sends (design 3.6) against a real relay in a child process: a message built and sent in
 * an open epoch, the epochs the bot starts, the relay's results, and a restart that sends the stored
 * bytes again. The bot's connection and reading are the real ones; a test that needs an answer the
 * relay never gives replaces `submit` alone.
 */
import assert from "node:assert/strict";
import { createServer, connect as tcp } from "node:net";
import { test } from "node:test";
import { type Clock, Connection } from "../../../src/chat/relay/connection.ts";
import { Outbox } from "../../../src/chat/relay/outbox.ts";
import { botPlatform, loadPairing, pair } from "../../../src/chat/relay/pairing.ts";
import { identityOf, Store } from "../../../src/chat/relay/store.ts";
import { checkDeviceEntry, idKey, type LoggedEntry } from "../../../src/protocol/device-log.ts";
import type { LoggedEpoch } from "../../../src/protocol/epochs.ts";
import { deviceId, signedId } from "../../../src/protocol/ids.ts";
import { checkMemberEntry, type LoggedMember } from "../../../src/protocol/member-log.ts";
import { decodeMessage } from "../../../src/protocol/messages.ts";
import { Run } from "../../../src/protocol/outbox.ts";
import { decodePairingString } from "../../../src/protocol/pairing-string.ts";
import type { Bytes } from "../../../src/protocol/platform.ts";
import type { Out } from "../../../src/protocol/reading.ts";
import type { Sequence } from "../../../src/relay/sequence.ts";
import { DARWIN } from "../../relay/process-support.ts";
import { platform } from "../../relay/support.ts";
import { addBody, epochEntry, fill, keyed, memberEntry, person } from "../../relay/world.ts";
import { dial } from "../../support/scripted-device/link.ts";
import { RelayProcess } from "../../support/scripted-device/relay-process.ts";
import { tempDirSync } from "../../support/temp.ts";

const hex = (b: Bytes) => Buffer.from(b).toString("hex");
type Submit = (kind: 3 | 4, signed: Bytes, sig: Bytes) => Promise<number | undefined>;
const text = { kind: 1, content: "{}" };

let counter = 0;
/** A relay, alice with the bot added and a channel with its first epoch sealed to both. */
async function rig() {
  const tag = `send${++counter}`;
  const relay = new RelayProcess();
  const target = await relay.open();
  const alice = person(keyed("app", `${tag}-app`), keyed("app", `${tag}-sheet`));
  const dir = tempDirSync("pardner-chat-");
  const string = await pair(dir, alice.id, target.relay, "alice");
  const bot = decodePairingString(platform, string);
  assert.ok(bot.ok);
  const log: LoggedEntry[] = [];
  const members: LoggedMember[] = [];
  const epochs: LoggedEpoch[] = [];
  const as = async <T>(use: (link: Awaited<ReturnType<typeof dial>>) => Promise<T>) => {
    const link = await dial(platform, target.port, target.relay);
    link.enrol(target.secret as Bytes, alice.genesis);
    assert.equal(
      (await link.proveActive(alice.id, alice.first.id, alice.first.sign)).type,
      "served",
    );
    try {
      return await use(link);
    } finally {
      link.close();
    }
  };
  const put = async (kind: 1 | 2 | 3, e: { signed: Bytes; sig: Bytes }) => {
    const answer = await as((link) => link.submit(kind, e));
    assert.deepEqual(answer, { type: "result", request: 1, code: 0 });
  };
  const genesis = checkDeviceEntry(platform, [], alice.genesis.signed, alice.genesis.sig);
  assert.ok(genesis.ok);
  log.push(genesis.value);
  const device = async (body: Record<string, unknown>) => {
    const e = alice.entry(log, body);
    await put(1, e);
    const v = checkDeviceEntry(platform, log, e.signed, e.sig);
    assert.ok(v.ok);
    log.push(v.value);
  };
  await device({ kind: "add", device: bot.value.device, proof: bot.value.proof });
  const create = memberEntry(alice, [], { kind: "create", nonce: fill(3, 16) });
  await put(2, create);
  const channel = signedId(platform, create.signed);
  const m = checkMemberEntry(platform, [], create.signed, create.sig, log);
  assert.ok(m.ok);
  members.push(m.value);
  /** alice's next epoch at the heads she holds. */
  const epoch = async () => {
    const seq = {
      channels: new Map([[idKey(channel), { members, epochs }]]),
      devices: new Map([[idKey(alice.id), log]]),
    } as unknown as Sequence;
    const e = epochEntry(seq, channel, { person: alice, device: alice.first }, [alice]);
    await put(3, e);
    epochs.push({ entry: e.entry, id: signedId(platform, e.signed) });
  };
  await epoch();
  return {
    relay,
    dir,
    channel,
    alice,
    port: target.port,
    epoch,
    close: () => device({ ...addBody(alice, keyed("app", `${tag}-more`)) }),
    /** What the relay holds, decoded: the epoch entries and the bot's messages. */
    async held() {
      const pass = await as((link) => link.read(0));
      assert.equal(pass.type, "pass");
      const items = (pass as { items: { kind: number; signed: Bytes }[] }).items;
      return {
        epochs: items.filter((i) => i.kind === 3).map((i) => signedId(platform, i.signed)),
        messages: items
          .filter((i) => i.kind === 4)
          .map((i) => {
            const d = decodeMessage(i.signed);
            assert.ok(d.ok);
            return { ...d.value.header, signed: i.signed };
          }),
      };
    },
    stop: () => relay.act("stop", { op: "act", line: 0 }),
  };
}

/** A bot on `dir`; `submit` wraps the connection's, and `now` is the time the outbox counts epochs by. */
function botOn(
  r: Awaited<ReturnType<typeof rig>>,
  over: {
    submit?: (real: Submit) => Submit;
    now?: () => number;
    port?: number;
    clock?: Clock;
  } = {},
) {
  const pairing = loadPairing(r.dir);
  const held = botPlatform(r.dir);
  const store = Store.open(r.dir, identityOf(held, pairing.device, pairing.relay));
  const lines: string[] = [];
  const outs: Out[] = [];
  const connection: Connection = new Connection({
    address: () => ({ host: "127.0.0.1", port: over.port ?? r.port }),
    ...(over.clock ? { clock: over.clock } : {}),
    pairing,
    platform: held,
    store,
    log: (l) => lines.push(l),
    on: (out) => {
      outs.push(out);
      outbox.take(out);
    },
  });
  const real: Submit = (k, s, g) => connection.submit(k, s, g);
  const outbox: Outbox = new Outbox({
    platform: over.now ? { ...held, now: over.now } : held,
    pairing,
    store,
    reading: connection.reading,
    run: new Run(held),
    submit: over.submit?.(real) ?? real,
    log: (l) => lines.push(l),
  });
  const until = async (done: () => boolean | Promise<boolean>) => {
    for (
      const end = Date.now() + 20_000;
      !(await done());
      await new Promise((s) => setTimeout(s, 25))
    )
      assert.ok(Date.now() < end, `waited for what never came: ${lines.join(" | ")}`);
  };
  const queued = () => store.saved.outboxes.get(hex(r.channel)) ?? [];
  return {
    connection,
    outbox,
    store,
    lines,
    outs,
    until,
    queued,
    rested: () => until(() => outs.some((o) => o.do === "rest")),
    async stop() {
      await connection.stop();
      held.erase();
    },
  };
}

test(
  "a message is built and sent in the open epoch and leaves the outbox when read back",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r);
    try {
      // Nothing is sent before the reading is at rest: `submit` has no connection to use.
      assert.equal(await b.connection.submit(4, new Uint8Array(1), new Uint8Array(64)), undefined);
      assert.equal(await b.outbox.queue(r.channel, text), true);
      assert.equal(b.queued().length, 1);
      b.connection.start();
      await b.until(() => b.queued().length === 0);
      const held = await r.held();
      assert.equal(held.messages.length, 1);
      assert.deepEqual(held.messages[0]?.epoch, held.epochs[0]);
      assert.equal(held.messages[0]?.counter, 1);
      assert.deepEqual(
        b.lines.filter((l) => !l.startsWith("relay: read") && !l.includes("incarnation")),
        [],
      );
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "C13: a closed channel gets no build; the bot starts the next epoch and sends in it",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r);
    try {
      b.connection.start();
      await b.rested();
      await r.close(); // alice adds a device of her own, and starts no epoch
      await b.until(
        () => b.connection.reading.sendable && b.connection.reading.devices.length === 3,
      );
      await b.outbox.queue(r.channel, text);
      await b.until(() => b.queued().length === 0);
      const held = await r.held();
      assert.equal(held.epochs.length, 2);
      assert.deepEqual(
        held.messages[0]?.epoch,
        held.epochs[1],
        "built in the epoch the bot started",
      );
      assert.ok(b.lines.includes("relay: an epoch was started (closed)"));
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test("a closed channel with nothing queued gets a new epoch at rest", DARWIN, async () => {
  const r = await rig();
  const b = botOn(r);
  try {
    b.connection.start();
    await b.rested();
    await r.close();
    await b.until(async () => (await r.held()).epochs.length === 2);
    assert.ok(b.lines.includes("relay: an epoch was started (closed)"));
  } finally {
    await b.stop();
    await r.stop();
  }
});

test("an epoch 30 days old starts the next, by the clock the store keeps", DARWIN, async () => {
  const r = await rig();
  let now = 1_700_000_000_000;
  const b = botOn(r, { now: () => now });
  try {
    b.connection.start();
    await b.rested();
    await b.outbox.queue(r.channel, text);
    await b.until(() => b.queued().length === 0);
    assert.equal((await r.held()).epochs.length, 1);
    now += 30 * 24 * 60 * 60 * 1000;
    await b.outbox.queue(r.channel, text);
    await b.until(() => b.queued().length === 0);
    const held = await r.held();
    assert.equal(held.epochs.length, 2);
    assert.deepEqual(held.messages[1]?.epoch, held.epochs[1]);
    assert.ok(b.lines.includes("relay: an epoch was started (aged)"));
  } finally {
    await b.stop();
    await r.stop();
  }
});

for (const [name, change] of [
  ["ended (4)", (r: Awaited<ReturnType<typeof rig>>) => r.epoch()],
  ["closed (3)", (r: Awaited<ReturnType<typeof rig>>) => r.close()],
] as const) {
  test(
    `result ${name}: the message is built again in the next epoch with a counter of its own`,
    DARWIN,
    async () => {
      const r = await rig();
      const built: Bytes[] = [];
      let once = true;
      const b = botOn(r, {
        submit: (real) => async (k, s, g) => {
          if (k === 4) built.push(s);
          if (once && k === 4) {
            once = false;
            await change(r); // the relay moves before the bot's message reaches it
          }
          return real(k, s, g);
        },
      });
      try {
        b.connection.start();
        await b.rested();
        await b.outbox.queue(r.channel, text);
        await b.until(() => b.queued().length === 0);
        const held = await r.held();
        assert.equal(held.messages.length, 1, "the first build was never accepted");
        assert.ok(built.length >= 2, "built again");
        assert.notDeepEqual(built[0], built.at(-1));
        const seen = built.map((s) => {
          const d = decodeMessage(s);
          assert.ok(d.ok);
          return `${hex(d.value.header.epoch)}|${d.value.header.counter}`;
        });
        assert.equal(new Set(seen).size, seen.length, "no epoch and counter twice");
      } finally {
        await b.stop();
        await r.stop();
      }
    },
  );
}

test(
  "result 1 on a kind the sender may not write: not delivered, the channel goes on",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r);
    try {
      b.connection.start();
      await b.rested();
      const self = deviceId(
        platform,
        loadPairing(r.dir).device.signing,
        loadPairing(r.dir).device.receiving,
      );
      await b.outbox.queue(r.channel, { kind: 2, to: self, content: "{}" }); // a prompt is an app's kind
      await b.outbox.queue(r.channel, text);
      await b.until(() => b.queued().length === 0);
      assert.equal((await r.held()).messages.length, 1);
      assert.ok(
        b.lines.includes(
          "relay: a message was refused for its kind or its recipient, not delivered",
        ),
      );
      assert.equal(b.store.saved.faults.size, 0);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "result 1 the package's checks do not explain is a relay fault: stored, the channel sends no more",
  DARWIN,
  async () => {
    const r = await rig();
    let calls = 0;
    const b = botOn(r, {
      submit: () => async () => {
        calls++;
        return 1;
      },
    });
    try {
      b.connection.start();
      await b.rested();
      await b.outbox.queue(r.channel, text);
      await b.until(() => b.store.saved.faults.size === 1);
      await b.outbox.queue(r.channel, text);
      await new Promise((s) => setTimeout(s, 200));
      assert.equal(calls, 1);
      assert.equal(b.queued().length, 2, "kept, not dropped");
      await b.stop();
      const again = botOn(r);
      assert.equal(
        again.store.saved.faults.has(hex(r.channel)),
        true,
        "a restart does not lift it",
      );
      await again.stop();
    } finally {
      await r.stop();
    }
  },
);

test("result 8: not delivered, and the next message goes", DARWIN, async () => {
  const r = await rig();
  let first = true;
  const b = botOn(r, {
    submit: (real) => async (k, s, g) => {
      if (k === 4 && first) {
        first = false;
        return 8;
      }
      return real(k, s, g);
    },
  });
  try {
    b.connection.start();
    await b.rested();
    await b.outbox.queue(r.channel, text);
    await b.outbox.queue(r.channel, text);
    await b.until(() => b.queued().length === 0);
    assert.equal((await r.held()).messages.length, 1);
    assert.ok(b.lines.includes("relay: a message was too large, not delivered"));
  } finally {
    await b.stop();
    await r.stop();
  }
});

test(
  "C6: a restart sends the stored bytes again, identical, and builds nothing new",
  DARWIN,
  async () => {
    const r = await rig();
    const sent: Bytes[] = [];
    const first = botOn(r, {
      submit: () => async (_k, s) => {
        sent.push(s);
        return undefined;
      },
    });
    first.connection.start();
    await first.rested();
    await first.outbox.queue(r.channel, text);
    await first.until(() => sent.length === 1);
    await first.stop();
    assert.equal((await r.held()).messages.length, 0);
    const second = botOn(r);
    try {
      assert.equal(second.queued()[0]?.built?.signed.length, sent[0]?.length);
      second.connection.start();
      await second.until(() => second.queued().length === 0);
      const held = await r.held();
      assert.equal(held.messages.length, 1);
      assert.deepEqual(held.messages[0]?.signed, sent[0], "the bytes built once");
    } finally {
      await second.stop();
      await r.stop();
    }
  },
);

test("a start in the outbox is dropped when the bot starts again", DARWIN, async () => {
  const r = await rig();
  const first = botOn(r);
  try {
    await first.outbox.queue(r.channel, {
      kind: 3,
      re: { device: fill(1), name: fill(2, 16) },
      content: "{}",
    });
    await first.outbox.queue(r.channel, text);
    assert.equal(first.queued().length, 2);
    const again = botOn(r);
    assert.deepEqual(
      again.queued().map((i) => i.kind),
      [1],
    );
    await again.stop();
  } finally {
    await first.stop();
    await r.stop();
  }
});

const outEpoch = (b: { built?: { signed: Bytes } | undefined }) => {
  const d = decodeMessage(b.built?.signed as Bytes);
  assert.ok(d.ok);
  return d.value.header.epoch;
};

test(
  "a build never uses a view read before the clock write: a closed epoch gets none",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r);
    const { store } = b;
    const real = store.change.bind(store);
    let hold = true;
    const builds: { epoch: string; open: boolean | undefined }[] = [];
    (store as unknown as { change: typeof store.change }).change = async (edit) => {
      const clocks = store.saved.clocks.size;
      const before = b.queued().filter((i) => i.built).length;
      await real(edit);
      const built = b.queued().filter((i) => i.built);
      if (built.length > before)
        builds.push({
          epoch: hex(outEpoch(built.at(-1) as { built: { signed: Bytes } })),
          open: b.connection.reading.channel(r.channel)?.open,
        });
      if (hold && store.saved.clocks.size !== clocks) {
        hold = false;
        await r.close(); // while the clock is written, alice closes the channel and the bot reads it
        await b.until(
          () => b.connection.reading.sendable && b.connection.reading.devices.length === 3,
        );
      }
    };
    try {
      await b.outbox.queue(r.channel, text);
      b.connection.start();
      await b.until(() => b.queued().length === 0);
      const held = await r.held();
      assert.ok(builds.length > 0 && builds.every((x) => x.open), JSON.stringify(builds));
      assert.deepEqual(held.messages[0]?.epoch, held.epochs[1]);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "a message is sent only after a write of the store holds its built bytes",
  DARWIN,
  async () => {
    const r = await rig();
    let sent = 0;
    const b = botOn(r, {
      submit: () => async () => {
        sent++;
        return undefined;
      },
    });
    const { store } = b;
    const real = store.change.bind(store);
    let failed = 0;
    (store as unknown as { change: typeof store.change }).change = async (edit) => {
      const draft = structuredClone(store.saved);
      edit(draft);
      if ((draft.outboxes.get(hex(r.channel)) ?? []).some((i) => i.built) && failed === 0) {
        failed++;
        await real(edit); // the memory holds the change, the disk does not
        throw new Error("simulated: the write failed");
      }
      return real(edit);
    };
    try {
      b.connection.start();
      await b.rested();
      await b.outbox.queue(r.channel, text);
      await b.until(() => b.lines.some((l) => l.startsWith("relay: sending stopped")));
      assert.equal(sent, 0, "nothing was sent after the failed write");
      b.outbox.pump(); // the next rest: the bytes are in memory, the write is made again first
      await b.until(() => sent === 1);
      assert.equal(failed, 1);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "a draft over the frame limit is not delivered, and a draft with a file is refused",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r);
    try {
      b.connection.start();
      await b.rested();
      assert.equal(
        await b.outbox.queue(r.channel, {
          ...text,
          files: [{ bytes: new Uint8Array(1), type: "x", name: "f" }],
        }),
        false,
      );
      await b.outbox.queue(r.channel, { kind: 1, content: "x".repeat(2_000_000) });
      await b.outbox.queue(r.channel, text);
      await b.until(() => b.queued().length === 0);
      assert.equal((await r.held()).messages.length, 1);
      assert.ok(b.lines.includes("relay: a message was too large, not delivered"));
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "result 1 on a rule of the draft alone (`re`) is not delivered and no fault",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r);
    try {
      b.connection.start();
      await b.rested();
      // An answer names its own sender in `re`; this one names another device.
      await b.outbox.queue(r.channel, {
        kind: 4,
        re: { device: fill(7), name: fill(8, 16) },
        content: "{}",
      });
      await b.outbox.queue(r.channel, text);
      await b.until(() => b.queued().length === 0);
      assert.equal(b.store.saved.faults.size, 0);
      assert.equal((await r.held()).messages.length, 1);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "a submit with no answer within 30 s is a drop: sent again, read back after the next rest",
  DARWIN,
  async () => {
    const r = await rig();
    const hop = createServer((client) => {
      const up = tcp(r.port, "127.0.0.1");
      for (const x of [client, up]) x.on("error", () => {});
      client.on("data", (d) => up.write(d));
      client.on("close", () => up.destroy());
      up.on("close", () => client.destroy());
      up.on("data", (d) => {
        if (!mute) client.write(d);
      });
    });
    let mute = false;
    await new Promise<void>((resolve) => hop.listen(0, "127.0.0.1", () => resolve()));
    const timers = new Set<{ ms: number; resolve: (late: boolean) => void }>();
    const clock: Clock = {
      now: () => 0,
      wait: async (_ms, signal) => !signal.aborted,
      idle: (ms, signal) =>
        new Promise((resolve) => {
          if (signal.aborted) return resolve(false);
          const t = { ms, resolve };
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
    };
    const b = botOn(r, { port: (hop.address() as { port: number }).port, clock });
    try {
      b.connection.start();
      await b.rested();
      mute = true; // the relay's answers and pushes no longer reach the bot
      await b.outbox.queue(r.channel, text);
      await b.until(async () => (await r.held()).messages.length === 1);
      mute = false;
      for (const t of [...timers]) if (t.ms === 30_000) t.resolve(true);
      await b.until(() => b.queued().length === 0);
      assert.equal((await r.held()).messages.length, 1);
      assert.equal(b.outs.filter((o) => o.do === "incarnation").length, 2, "a second connection");
    } finally {
      await b.stop();
      hop.close();
      await r.stop();
    }
  },
);

test(
  "a failed write of a rebuild does not let the next build go out unstored",
  DARWIN,
  async () => {
    const r = await rig();
    const kinds4: Bytes[] = [];
    let once = true;
    const b = botOn(r, {
      submit: (real) => async (k, s, g) => {
        if (k === 4) kinds4.push(s);
        if (k === 4 && once) {
          once = false;
          await r.epoch(); // the relay moves on: this submit is answered 4
        }
        return real(k, s, g);
      },
    });
    const { store } = b;
    const real = store.change.bind(store);
    const onDisk = new Set<string>(); // built bytes some successful write held
    let failed = 0;
    (store as unknown as { change: typeof store.change }).change = async (edit) => {
      const key = hex(r.channel);
      const draft = structuredClone(store.saved);
      edit(draft);
      const wasBuilt = (store.saved.outboxes.get(key) ?? []).some((i) => i.built);
      const nowUnbuilt = (draft.outboxes.get(key) ?? []).some((i) => !i.built);
      if (wasBuilt && nowUnbuilt && failed === 0) {
        failed++;
        await real(edit); // memory takes the rebuild, the disk does not
        throw new Error("simulated: the write failed");
      }
      await real(edit);
      for (const i of store.saved.outboxes.get(key) ?? [])
        if (i.built) onDisk.add(hex(i.built.signed));
    };
    try {
      b.connection.start();
      await b.rested();
      await b.outbox.queue(r.channel, text);
      await b.until(
        () => failed === 1 && b.lines.some((l) => l.startsWith("relay: sending stopped")),
      );
      b.outbox.pump(); // the next rest
      await b.until(() => kinds4.length >= 2);
      const second = hex(kinds4[1] as Bytes);
      assert.equal(onDisk.has(second), true, "the second build was sent before any write held it");
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);
