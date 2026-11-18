/**
 * The scripted device's link (design 4.1), its connection: the pinned dial, the ways in, and what
 * the relay says or fails to say as outcomes. A real relay in a child process, and a fake one only
 * for what a real relay never does.
 */
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { Frame } from "../../src/protocol/frames.ts";
import { relayKeyId } from "../../src/protocol/ids.ts";
import { chainLink } from "../../src/protocol/proofs.ts";
import { fakeRelay } from "../support/scripted-device/fake-relay.ts";
import { dial, type Link, NoConnection } from "../support/scripted-device/link.ts";
import { tempDirSync } from "../support/temp.ts";
import { DARWIN, init, portOf, run, watch } from "./process-support.ts";
import { platform } from "./support.ts";
import { addBody, fill, keyed, person } from "./world.ts";

let relays = 0;
/** A started relay with alice, her recovery key and her first device named, and a stop that checks the exit. */
async function relay() {
  const tag = `r${++relays}`;
  const dir = join(tempDirSync("pardner-relay-"), "relay");
  const { key, secret } = await init(dir);
  const child = watch(run(["serve", "--dir", dir, "--listen", "127.0.0.1:0"]));
  const port = await portOf(child);
  const alice = person(keyed("app", `${tag}-alice-app`), keyed("app", `${tag}-alice-sheet`));
  const links: Link[] = [];
  return {
    alice,
    tag,
    port,
    key,
    child,
    async open() {
      const link = await dial(platform, port, key, 2000);
      links.push(link);
      return link;
    },
    /** A link that has enrolled alice and proven her first device. */
    async enrolled() {
      const link = await this.open();
      link.enrol(secret, alice.genesis);
      const served = await link.proveActive(alice.id, alice.first.id, alice.first.sign);
      assert.equal(served.type, "served");
      return link;
    },
    async stop() {
      for (const link of links) link.close();
      child.child.kill("SIGTERM");
      assert.equal(await child.exit, 0, child.err());
    },
  };
}

const refusedDial = (p: Promise<unknown>) =>
  p.then(
    () => assert.fail("a link was made"),
    (e: unknown) => (e instanceof NoConnection ? e.reason : assert.fail(String(e))),
  );

test(
  "enrol and prove; a refusal is an outcome and closes the link; an out-of-state frame closes it",
  DARWIN,
  async () => {
    const r = await relay();
    try {
      await r.enrolled();
      const stranger = await r.open();
      assert.deepEqual(await stranger.proveActive(fill(8), fill(9), r.alice.first.sign), {
        type: "refused",
        reason: 2,
      });
      assert.deepEqual(
        await stranger.next(),
        { type: "closed" },
        "a refusal closes the connection",
      );
      assert.deepEqual(await stranger.next(), { type: "closed" });

      const early = await r.open();
      early.send({ type: "read", from: 0 }, true);
      assert.deepEqual(await early.next(), { type: "closed" }, "a request before a proof");

      r.child.child.kill("SIGKILL");
      await r.child.exit;
      assert.equal(await refusedDial(r.open()), "refused", "nothing listens");
    } finally {
      await r.stop().catch(() => {});
    }
  },
);

test("what a relay never says: a frame after `refused`", async () => {
  const after = await fakeRelay(platform, (reply) =>
    reply({ type: "refused", reason: 1 }, { type: "served", incarnation: fill(0, 16) }),
  );
  try {
    const b = await dial(platform, after.port, after.key, 1000);
    const by = keyed("app", "fake-by");
    assert.equal((await b.proveActive(fill(1), fill(2), by.sign)).type, "refused");
    assert.equal((await b.next()).type, "served");
    assert.deepEqual(b.problems, ["served after refused"]);
    b.close();
  } finally {
    after.close();
  }
});

test("a frame is decoded in the link's state: one that crosses only after a proof, and past 4096 bytes, is no frame before it", async () => {
  const big = {
    type: "log" as const,
    request: 1,
    entries: [{ signed: fill(1, 5000), sig: fill(2, 64) }],
  };
  const served = { type: "served" as const, incarnation: fill(0, 16) };
  const early = await fakeRelay(platform, (reply) => reply(big));
  const late = await fakeRelay(platform, (reply, count) =>
    reply(...(count === 1 ? [served] : [big, served])),
  );
  try {
    const a = await dial(platform, early.port, early.key, 1000);
    a.send({ type: "enrol", secret: fill(1), signed: fill(2), sig: fill(3, 64) });
    assert.deepEqual(await a.next(), { type: "undecodable" }, "before the proof");
    const b = await dial(platform, late.port, late.key, 1000);
    assert.equal(
      (await b.proveActive(fill(1), fill(2), keyed("app", "fake-state-by").sign)).type,
      "served",
    );
    b.send({ type: "recovery-log", request: 1 });
    const seen: string[] = [];
    for (let o = await b.next(); o.type !== "served"; o = await b.next()) seen.push(o.type);
    assert.ok(!seen.includes("undecodable"), "the same frame after it is taken");
  } finally {
    early.close();
    late.close();
  }
});

test("no connection: a wrong key, an opener that is no hello, a handshake that fails or never answers", async () => {
  const fake = await fakeRelay(platform, () => {});
  const opener = await fakeRelay(platform, () => {}, { hello: false });
  const held: Socket[] = [];
  const shut = createServer((s) => s.destroy()).listen(0, "127.0.0.1");
  const mute = createServer((s) => held.push(s)).listen(0, "127.0.0.1");
  try {
    const port = (s: typeof shut) => (s.address() as { port: number }).port;
    assert.equal(await refusedDial(dial(platform, fake.port, fill(7, 65), 1000)), "pin");
    assert.equal(await refusedDial(dial(platform, opener.port, opener.key, 1000)), "hello");
    assert.equal(await refusedDial(dial(platform, port(shut), fill(7, 65), 1000)), "handshake");
    const t0 = Date.now();
    assert.equal(await refusedDial(dial(platform, port(mute), fill(7, 65), 300)), "handshake");
    assert.ok(Date.now() - t0 < 2000, "the patience ends the wait");
  } finally {
    fake.close();
    opener.close();
    for (const s of held) s.destroy();
    shut.close();
    mute.close();
  }
});

const codeOf = (o: { type: string; code?: number }) => (o.type === "result" ? o.code : o.type);

test(
  "requests: a submit, a seal, a blob, a head given back, the recovery log",
  DARWIN,
  async () => {
    const r = await relay();
    try {
      const link = await r.enrolled();
      const other = keyed("app", `${r.tag}-alice-phone`);
      const entry = r.alice.entry([{ id: r.alice.id }] as never, addBody(r.alice, other));
      assert.equal(codeOf(await link.submit(1, entry)), 0);

      const seal = {
        channel: fill(1),
        epoch: fill(2),
        recipient: r.alice.first.id,
        enc: r.alice.first.keys.receiving,
        sealed: new Uint8Array(48),
        maker: r.alice.first.id,
      };
      assert.equal(codeOf(await link.giveSeal(seal, fill(3, 64))), 1);
      const bytes = Buffer.from("x".repeat(2500));
      assert.equal(codeOf(await link.putBlob(platform.sha256(bytes), bytes, 1000)), 0);
      // A blob no message names is not served (RD 6.2): its chunks need a channel, which a later script builds.
      assert.equal(codeOf(await link.getBlob(platform.sha256(bytes))), 9);

      const read = await link.read();
      assert.ok(read.type === "pass");
      const given = await link.uploadDone(
        { relay: relayKeyId(platform, r.key), n: read.head.n, chain: read.head.chain },
        read.head.sig,
      );
      assert.equal(codeOf(given), 0);

      const recovering = await r.open();
      const served = await recovering.proveRecovery(
        r.alice.id,
        { id: r.alice.recovery.recoveryId, sign: r.alice.recovery.sign },
        keyed("app", `${r.tag}-alice-new`),
      );
      assert.equal(served.type, "silent", "a recovery proof is answered by its first request");
      const log = await recovering.recoveryLog();
      assert.ok(log.type === "recovered" && log.code === 0 && log.entries.length === 2);
    } finally {
      await r.stop();
    }
  },
);

test(
  "a put the relay settles at its first chunk: a held blob answers 0 once, a refusal is the first answer and the rest are late",
  DARWIN,
  async () => {
    const r = await relay();
    try {
      const link = await r.enrolled();
      const bytes = Buffer.from("y".repeat(2500));
      const blob = platform.sha256(bytes);
      assert.equal(codeOf(await link.putBlob(blob, bytes, 1000)), 0);
      assert.equal(codeOf(await link.putBlob(blob, bytes, 1000)), 0, "held: answered at chunk 0");
      const lie = Buffer.from("z".repeat(2500));
      assert.equal(codeOf(await link.putBlob(platform.sha256(lie), lie, 1000, 2 ** 40)), 8);
      const read = await link.read();
      assert.ok(
        read.type === "pass" && read.problems.length === 0,
        "no stray result stands before a read",
      );
      assert.deepEqual(
        link.late.map((f) => f.type),
        ["result", "result"],
        "the refusals of the two chunks after the first",
      );
    } finally {
      await r.stop();
    }
  },
);

test("a refusal with no request id ends what is pending; a result nobody waits for is late", async () => {
  let say: (f: { type: "result"; request: number; code: 0 }) => void = () => {};
  const refuses = await fakeRelay(platform, (reply, count) => {
    reply(
      count === 1 ? { type: "served", incarnation: fill(0, 16) } : { type: "refused", reason: 3 },
    );
  });
  const mute = await fakeRelay(platform, (reply, count) => {
    say = reply;
    if (count === 1) reply({ type: "served", incarnation: fill(0, 16) });
  });
  try {
    const by = keyed("app", "fake-requests-by");
    const link = await dial(platform, refuses.port, refuses.key, 300);
    assert.equal((await link.proveActive(fill(1), fill(2), by.sign)).type, "served");
    assert.deepEqual(await link.recoveryLog(), { type: "refused", reason: 3 });
    const silent = await dial(platform, mute.port, mute.key, 300);
    await silent.proveActive(fill(1), fill(2), by.sign);
    assert.equal((await silent.submit(1, { signed: fill(1), sig: fill(2, 64) })).type, "silent");
    say({ type: "result", request: 1, code: 0 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      silent.late.length,
      1,
      "an answer after `silent` is kept, never taken for the next one",
    );
  } finally {
    refuses.close();
    mute.close();
  }
});

test(
  "a read taken whole, a follow's push taken whole, a pending push held across a read",
  DARWIN,
  async () => {
    const r = await relay();
    try {
      const follower = await r.enrolled();
      const first = await follower.read();
      assert.ok(first.type === "pass" && first.read);
      assert.deepEqual(first.problems, []);
      assert.ok(first.items.length === 1 && first.head.n === 1 && first.chainChecked);
      assert.equal(first.incarnation?.length, 16);

      const writer = await r.open();
      await writer.proveActive(r.alice.id, r.alice.first.id, r.alice.first.sign);
      const other = keyed("app", `${r.tag}-alice-tablet`);
      const entry = r.alice.entry([{ id: r.alice.id }] as never, addBody(r.alice, other));
      assert.equal(codeOf(await writer.submit(1, entry)), 0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      // The push is already on the connection when the read is made: the read is not taken for it.
      const again = await follower.read(0);
      assert.ok(again.type === "pass" && again.read && again.items.length === 2);
      assert.deepEqual(again.problems, []);
      const pushed = await follower.follow();
      assert.ok(pushed.type === "pass" && !pushed.read && pushed.items[0]?.position === 1);
      assert.deepEqual(pushed.problems, []);
      assert.ok(pushed.chainChecked);
    } finally {
      await r.stop();
    }
  },
);

// A fake relay's reads: genesis entries of two people stand for items, whose ids the link takes.
const a = person(keyed("app", "fake-read-a"), keyed("app", "fake-read-ar"));
const b = person(keyed("app", "fake-read-b"), keyed("app", "fake-read-br"));
const item = (p: typeof a, position: number) => ({
  type: "item" as const,
  position,
  kind: 1 as const,
  ...p.genesis,
});
const zero = new Uint8Array(32);
const chain1 = chainLink(platform, zero, a.id);
const chain2 = chainLink(platform, chain1, b.id);
const seal = {
  seal: {
    channel: fill(1),
    epoch: fill(2),
    recipient: fill(3),
    enc: a.first.keys.receiving,
    sealed: new Uint8Array(48),
    maker: fill(4),
  },
  sig: fill(5, 64),
};
const served = { type: "served" as const, incarnation: fill(0, 16) };
const position = (from = 0) => ({ type: "position" as const, from, incarnation: fill(6, 16) });
/** A fake relay that answers the proof, then each later chunk with `frames[count]`; the link is proven. */
async function scripted(frames: (fake: Awaited<ReturnType<typeof fakeRelay>>) => Frame[][]) {
  let fake = undefined as unknown as Awaited<ReturnType<typeof fakeRelay>>;
  fake = await fakeRelay(platform, (reply, count) =>
    reply(...(count === 1 ? [served] : (frames(fake)[count - 2] ?? []))),
  );
  const link = await dial(platform, fake.port, fake.key, 500);
  await link.proveActive(fill(1), fill(2), keyed("app", `fake-by-${++relays}`).sign);
  return {
    link,
    fake,
    done: () => {
      link.close();
      fake.close();
    },
  };
}

test("each rule of a read: a relay that breaks it is caught, and its correct twin is not", async () => {
  const other = await fakeRelay(platform, () => {});
  type Case = {
    items?: Frame[];
    n?: number;
    chain?: Uint8Array;
    from?: number;
    ask?: number;
    signer?: "other";
    after?: boolean;
  };
  const bad = {
    type: "item" as const,
    position: 0,
    kind: 1 as const,
    signed: fill(7, 40),
    sig: fill(8, 64),
  };
  const rules: [RegExp, Case, Case][] = [
    [/not the relay's/, { signer: "other" }, {}],
    [
      /expected 1/,
      { items: [item(a, 0), item(b, 2)], n: 3 },
      { items: [item(a, 0), item(b, 1)], n: 2, chain: chain2 },
    ],
    [/head names 2/, { n: 2 }, {}],
    [/does not decode/, { items: [bad] }, {}],
    [/position names 5/, { from: 5 }, {}],
    [
      /head names 1, not 4/,
      { from: 3, ask: 3, items: [item(a, 3)], n: 1 },
      { from: 3, ask: 3, items: [], n: 1 },
    ],
    [/seals after an item/, { after: true }, {}],
  ];
  try {
    for (const [rule, wrong, twin] of rules) {
      for (const [c, caught] of [
        [wrong, true],
        [twin, false],
      ] as const) {
        const items = c.items ?? [item(a, 0)];
        const { link, done } = await scripted((fake) => [
          [
            position(c.from),
            ...(c.after ? [] : [{ type: "seals" as const, items: [] }]),
            ...items,
            ...(c.after ? [{ type: "seals" as const, items: [] }] : []),
            (c.signer ? other : fake).head(c.n ?? items.length, c.chain ?? chain1),
          ],
        ]);
        try {
          const got = await link.read(c.ask ?? 0);
          assert.ok(got.type === "pass", String(rule));
          if (caught)
            assert.ok(
              got.problems.some((p) => rule.test(p)),
              `${rule} was not caught: ${got.problems}`,
            );
          else assert.deepEqual(got.problems, [], `${rule}: the correct twin`);
        } finally {
          done();
        }
      }
    }
  } finally {
    other.close();
  }
});

test("a read keeps seals of every frame; a push goes on from the head before it; a changed item and a wrong chain are caught", async () => {
  const { link, done } = await scripted((fake) => [
    [
      position(),
      { type: "seals", items: [seal] },
      { type: "seals", items: [] },
      item(a, 0),
      fake.head(1, chain1),
    ],
    [item(b, 1), fake.head(2, chain2)],
    [item(a, 2), fake.head(3, fill(9))],
    [position(), { type: "seals", items: [] }, item(b, 0), fake.head(1, chain1)],
  ]);
  try {
    const one = await link.read();
    assert.ok(one.type === "pass" && one.problems.length === 0 && one.seals.length === 1);
    assert.equal(one.incarnation?.length, 16);
    link.send({ type: "recovery-log", request: 1 });
    const good = await link.follow();
    assert.ok(
      good.type === "pass" && good.problems.length === 0 && good.chainChecked,
      "the chain goes on from the last one checked",
    );
    link.send({ type: "recovery-log", request: 2 });
    const wrong = await link.follow();
    assert.ok(wrong.type === "pass" && wrong.problems.includes("the chain does not hold"));
    const two = await link.read();
    assert.ok(two.type === "pass" && two.problems.some((p) => /differs/.test(p)));
  } finally {
    done();
  }
});

test("a pass cut by a read that was outstanding while it arrived is the relay's normal way, and no problem", async () => {
  // The read's `stop()` ends a follow at its next yield: its items come after the read was sent, with no head.
  const { link, done } = await scripted((fake) => [
    [item(b, 1), position(), { type: "seals", items: [] }, item(a, 0), fake.head(1, chain1)],
  ]);
  try {
    const got = await link.read();
    assert.ok(got.type === "pass" && got.read);
    assert.deepEqual(got.problems, []);
  } finally {
    done();
  }
});

test("a push without its head, with no read outstanding while it arrived, is a problem of the pass that follows", async () => {
  for (const viaRead of [false, true]) {
    const { link, done } = await scripted((fake) => [
      [item(b, 1)],
      [position(), { type: "seals", items: [] }, item(a, 0), fake.head(1, chain1)],
    ]);
    try {
      link.send({ type: "recovery-log", request: 1 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      let got: Awaited<ReturnType<typeof link.next>>;
      if (viaRead) got = await link.read();
      else {
        link.send({ type: "recovery-log", request: 2 });
        got = await link.next();
      }
      assert.ok(got.type === "pass" && got.read);
      assert.equal(
        got.problems.some((p) => /without its head/.test(p)),
        !viaRead,
      );
    } finally {
      done();
    }
  }
});

test("a close ends a read and a follow that wait together, and stays in the stream", async () => {
  const { link, fake } = await scripted(() => []);
  setTimeout(() => fake.close(), 50);
  const [read, follow] = await Promise.all([link.read(0, 2000), link.follow(2000)]);
  assert.equal(read.type, "closed");
  assert.equal(follow.type, "closed");
  assert.equal((await link.next()).type, "closed");
});

test("a read and a follow waiting together each get their own pass", DARWIN, async () => {
  const r = await relay();
  try {
    const follower = await r.enrolled();
    assert.ok((await follower.read()).type === "pass");
    const waiting = follower.follow();
    const again = await follower.read(0);
    assert.ok(
      again.type === "pass" && again.read && again.items.length === 1,
      "the read is not stranded",
    );
    const writer = await r.open();
    await writer.proveActive(r.alice.id, r.alice.first.id, r.alice.first.sign);
    const entry = r.alice.entry(
      [{ id: r.alice.id }] as never,
      addBody(r.alice, keyed("app", `${r.tag}-late`)),
    );
    assert.equal(codeOf(await writer.submit(1, entry)), 0);
    const pushed = await waiting;
    assert.ok(pushed.type === "pass" && !pushed.read && pushed.items[0]?.position === 1);
  } finally {
    await r.stop();
  }
});

test("a read from beyond the length: the follow goes on from there", DARWIN, async () => {
  const r = await relay();
  try {
    const follower = await r.enrolled();
    const far = await follower.read(3);
    assert.ok(far.type === "pass" && far.items.length === 0 && far.head.n === 1);
    assert.deepEqual(far.problems, []);
    const writer = await r.open();
    await writer.proveActive(r.alice.id, r.alice.first.id, r.alice.first.sign);
    const log = [{ id: r.alice.id }];
    for (const n of [0, 1, 2]) {
      const e = r.alice.entry(log as never, addBody(r.alice, keyed("app", `${r.tag}-far${n}`)));
      assert.equal(codeOf(await writer.submit(1, e)), 0);
      log.push({ id: platform.sha256(e.signed) });
    }
    const pushed = await follower.follow();
    assert.ok(pushed.type === "pass" && pushed.items[0]?.position === 3 && pushed.head.n === 4);
    assert.deepEqual(pushed.problems, []);
  } finally {
    await r.stop();
  }
});
