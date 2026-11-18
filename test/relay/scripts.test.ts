/**
 * The hand-written scripts of the scripted device (design 4.2, 5.1): each runs against a relay in a
 * child process, with its own directory. A forgery in a script carries its positive twin.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import { decodeDeviceEntry } from "../../src/protocol/device-log.ts";
import { encodeFrame } from "../../src/protocol/frames.ts";
import { recoveryKeyId } from "../../src/protocol/ids.ts";
import { fakeRelay } from "../support/scripted-device/fake-relay.ts";
import { Defect, Failure, parse, run } from "../support/scripted-device/script.ts";
import { tempDirSync } from "../support/temp.ts";
import { run as child, DARWIN, init, portOf, watch } from "./process-support.ts";
import { keyed, person } from "./world.ts";

const SCRIPTS = new URL("../support/scripted-device/scripts/", import.meta.url);

/** A relay of its own for one script: its target, and a stop that checks the exit. */
async function relay() {
  const dir = join(tempDirSync("pardner-relay-"), "relay");
  const { key, secret } = await init(dir);
  const serving = watch(child(["serve", "--dir", dir, "--listen", "127.0.0.1:0"]));
  const target = { port: await portOf(serving), relay: key, secret };
  return {
    target,
    async stop() {
      serving.child.kill("SIGTERM");
      assert.equal(await serving.exit, 0, serving.err());
    },
  };
}

for (const name of readdirSync(SCRIPTS).filter((n) => n.endsWith(".jsonl"))) {
  test(`script ${name}`, DARWIN, async () => {
    const r = await relay();
    try {
      await run(parse(readFileSync(new URL(name, SCRIPTS), "utf8")), r.target);
    } finally {
      await r.stop();
    }
  });
}

test("a step that does not get its outcome fails with its line", DARWIN, async () => {
  const r = await relay();
  try {
    const wrong = '{"op":"prove","device":"app1","enrol":"sheet1","expect":"refused 2"}';
    await assert.rejects(
      run(parse(wrong), r.target),
      (e) => e instanceof Failure && /^line 1: expected "refused 2", got served$/.test(e.message),
    );
  } finally {
    await r.stop();
  }
});

test("an item that does not decode is a defect of the script", DARWIN, async () => {
  const r = await relay();
  try {
    const cut = [
      '{"op":"prove","device":"app1","enrol":"sheet1","expect":"served"}',
      '{"op":"submit","entry":"create","truncate":5,"expect":"result 1"}',
    ];
    await assert.rejects(
      run(parse(cut.join("\n")), r.target),
      (e) => e instanceof Defect && /line 2: the create does not decode/.test(e.message),
    );
  } finally {
    await r.stop();
  }
});

test(
  "a relay nothing listens on is an outcome a prove step can expect, and a surprise carries its line",
  DARWIN,
  async () => {
    const r = await relay();
    await r.stop();
    const prove = (expect: string) =>
      `{"op":"prove","device":"app1","enrol":"sheet1","expect":${JSON.stringify(expect)}}`;
    await run(parse(prove("nothing listens")), r.target);
    await assert.rejects(
      run(parse(prove("served")), r.target),
      (e) =>
        e instanceof Failure && /^line 1: expected "served", got nothing listens$/.test(e.message),
    );
  },
);

test("a step's wait is its own: the next request on the connection keeps the link's patience", async () => {
  const slow = await fakeRelay(createNodePlatform(), (reply, count) => {
    if (count === 1) reply({ type: "served", incarnation: new Uint8Array(16) });
    else if (count === 3) reply({ type: "refused", reason: 1 });
    else if (count === 2) setTimeout(() => reply({ type: "result", request: 1, code: 0 }), 600);
  });
  try {
    const script = [
      '{"op":"prove","device":"app1","wait":300,"expect":"served"}',
      '{"op":"put-blob","as":"b1","expect":"result 0"}',
    ];
    await run(parse(script.join("\n")), { port: slow.port, relay: slow.key });
  } finally {
    slow.close();
  }
});

test("a reset's new recovery key signs as a recovery key", DARWIN, async () => {
  const r = await relay();
  const base = createNodePlatform();
  const signed: { name: string; bytes: Uint8Array }[] = [];
  const platform = {
    ...base,
    sign: (name: string, bytes: Uint8Array) => (
      signed.push({ name, bytes }), base.sign(name, bytes)
    ),
  };
  const script = [
    '{"op":"prove","device":"app1","enrol":"sheet1","expect":"served"}',
    '{"op":"prove","conn":"r1","device":"app9","recovery":"sheet1","wait":300,"expect":"silent"}',
    '{"op":"submit","conn":"r1","entry":"reset","by":"sheet1","set":["app9"],"newDevice":"app9","recovery":"sheet2","expect":"result 0"}',
    '{"op":"prove","conn":"c2","device":"app9","expect":"served"}',
    '{"op":"submit","conn":"c2","entry":"add","device":"app3","by":"sheet2","expect":"result 1"}',
    '{"op":"read","conn":"c1","from":0,"expect":"refused 1"}',
  ];
  try {
    await run(parse(script.join("\n")), r.target, platform);
    const sheet2 = signed
      .filter((x) => x.name === "sheet2.s")
      .map((x) => decodeDeviceEntry(x.bytes));
    const keys = { signing: base.publicKey("sheet2.s"), receiving: base.publicKey("sheet2.r") };
    assert.ok(keys.signing.ok && keys.receiving.ok);
    const id = recoveryKeyId(base, keys.signing.value, keys.receiving.value);
    assert.equal(sheet2.length, 1);
    assert.equal(sheet2[0]?.ok && Buffer.from(sheet2[0].value.signer).equals(id), true);
  } finally {
    await r.stop();
  }
});

for (const [label, immediate] of [
  ["a duplicate result in the same write", false],
  ["a duplicate result in the next turn of the relay's loop", true],
] as const) {
  test(`the end of a run fails on a frame nobody read: ${label}`, async () => {
    const fake = await fakeRelay(createNodePlatform(), (reply, count) => {
      if (count === 1) return reply({ type: "served", incarnation: new Uint8Array(16) });
      // The end-of-run read of the link: refused, which ends its wait.
      if (count === 3) return reply({ type: "refused", reason: 1 });
      const result = encodeFrame({ type: "result", request: 1, code: 0 }, true);
      if (!immediate) return reply(Buffer.concat([result, result]));
      reply(result);
      setImmediate(() => reply(result));
    });
    const script = [
      '{"op":"prove","device":"app1","expect":"served"}',
      '{"op":"put-blob","as":"b1","expect":"result 0"}',
    ];
    try {
      await assert.rejects(
        run(parse(script.join("\n")), { port: fake.port, relay: fake.key }),
        (e) => e instanceof Failure && /^connection c1: a late result$/.test(e.message),
      );
    } finally {
      fake.close();
    }
  });
}

test("the end of a run fails on a frame the relay pushed unasked after the last answer", async () => {
  const fake = await fakeRelay(createNodePlatform(), (reply, count) => {
    if (count === 1) return reply({ type: "served", incarnation: new Uint8Array(16) });
    if (count === 3) return reply({ type: "refused", reason: 1 });
    const result = encodeFrame({ type: "result", request: 1, code: 0 }, true);
    reply(Buffer.concat([result, encodeFrame({ type: "refused", reason: 1 }, true)]));
  });
  const script = [
    '{"op":"prove","device":"app1","expect":"served"}',
    '{"op":"put-blob","as":"b1","expect":"result 0"}',
  ];
  try {
    await assert.rejects(
      run(parse(script.join("\n")), { port: fake.port, relay: fake.key }),
      (e) => e instanceof Failure && /^connection c1: .*an unread refused$/.test(e.message),
    );
  } finally {
    fake.close();
  }
});

test("a push nobody takes, whose chain does not hold, fails the run at its end", async () => {
  const fake = await fakeRelay(createNodePlatform(), (reply, count) => {
    const empty = { type: "position" as const, from: 0, incarnation: new Uint8Array(16) };
    if (count === 1) return reply({ type: "served", incarnation: new Uint8Array(16) });
    // The read is answered whole, and a push follows it whose head carries a chain of 7s.
    if (count === 2)
      return reply(
        empty,
        fake.head(0, new Uint8Array(32)),
        fake.head(0, new Uint8Array(32).fill(7)),
      );
    reply(empty, fake.head(0, new Uint8Array(32)));
  });
  const script = [
    '{"op":"prove","device":"app1","expect":"served"}',
    '{"op":"read","from":0,"expect":{"items":[],"n":0}}',
  ];
  try {
    await assert.rejects(
      run(parse(script.join("\n")), { port: fake.port, relay: fake.key }),
      (e) => e instanceof Failure && /the chain does not hold/.test(e.message),
    );
  } finally {
    fake.close();
  }
});

test("a push cut by the end-of-run read is the relay's normal way, and no problem", async () => {
  const alice = person(keyed("app", "cut-app"), keyed("app", "cut-sheet"));
  const zero = new Uint8Array(32);
  const inc = new Uint8Array(16);
  const fake = await fakeRelay(createNodePlatform(), (reply, count) => {
    if (count === 1) return reply({ type: "served", incarnation: inc });
    // A push is in flight when the read comes: it ends without its head, and the read is answered.
    if (count === 2) {
      return reply({ type: "position", from: 0, incarnation: inc }, fake.head(0, zero), {
        type: "item",
        position: 0,
        kind: 1,
        ...alice.genesis,
      });
    }
    reply({ type: "position", from: 0, incarnation: inc }, fake.head(0, zero));
  });
  const script = [
    '{"op":"prove","device":"app1","expect":"served"}',
    '{"op":"read","from":0,"expect":{"items":[],"n":0}}',
  ];
  try {
    await run(parse(script.join("\n")), { port: fake.port, relay: fake.key });
  } finally {
    fake.close();
  }
});
