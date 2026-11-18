import assert from "node:assert/strict";
import { test } from "node:test";
import { DARWIN } from "../../relay/process-support.ts";
import { fill } from "../../relay/world.ts";
import { botOn, hex, incarnation, rig, waiting } from "./relay-rig.ts";

test(
  "the owner's prompt reaches the core once, with a start written and read back first",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r);
    try {
      b.connection.start();
      await b.rested();
      await r.send({ to: r.botId, incarnation: incarnation(b) }, { text: "!bind /tmp/x" });
      await b.until(() => b.messages.length === 1);
      await waiting();
      assert.deepEqual(
        [b.messages.length, b.messages[0]?.text, b.messages[0]?.topLevel],
        [1, "!bind /tmp/x", true],
      );
      const held = await r.held();
      assert.deepEqual(
        held.messages.map((m) => m.kind),
        [2, 3], // the prompt, and one start: no second
      );
      assert.equal(b.store.saved.decided.size, 1);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "the owner's answer to the setup request reaches the core, and the bot answers the reply",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r);
    try {
      b.connection.start();
      await b.rested();
      const name = fill(8, 16);
      b.inbound.expect(name, {
        requestId: "setup-1",
        ref: { channel: hex(r.channel), thread: "t" },
        type: "setup",
      });
      await b.outbox.queue(r.channel, {
        kind: 9,
        re: { device: r.alice.first.id, name: fill(7, 16) },
        name,
        content: "{}",
      });
      await b.until(async () => (await r.held()).messages.length === 1);
      await r.send(
        { kind: 10, to: r.botId, re: { device: r.botId, name } },
        {
          answer: {
            type: "setup",
            selection: { model: "default", effort: "default", bypass: false },
          },
        },
      );
      await b.until(() => b.answers.length === 1);
      await b.until(async () => (await r.held()).messages.some((m) => m.kind === 5));
      assert.deepEqual(b.answers[0]?.[0], "setup-1");
      assert.deepEqual(b.messages, []);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);
