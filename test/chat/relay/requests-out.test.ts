import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayProvider } from "../../../src/chat/relay/provider.ts";
import type { OwnerRequest, ThreadChat } from "../../../src/chat/seam.ts";
import { decodeMessage, sealMessage } from "../../../src/protocol/messages.ts";
import type { Out } from "../../../src/protocol/reading.ts";
import { DARWIN } from "../../relay/process-support.ts";
import { platform } from "../../relay/support.ts";
import { fill } from "../../relay/world.ts";
import { botOn, hex, incarnation, rig } from "./relay-rig.ts";

type Rig = Awaited<ReturnType<typeof rig>>;
type Bot = ReturnType<typeof botOn>;

const HOLD: OwnerRequest = {
  type: "hold",
  requestId: "r-1",
  other: { channel: "c", thread: "t" },
  link: "l",
};

/** The thread of alice's first prompt (sender and name in hex), as the core names it. */
const threadOf = (r: Rig, prompt = fill(100, 16)) => hex(r.alice.first.id) + hex(prompt);

const provider = (r: Rig, b: Bot) => new RelayProvider(r.botId, b.outbox, b.inbound, platform);
const bodyOf = async (r: Rig, kind: number) => {
  const held = await r.held();
  return held.messages.filter((m) => m.kind === kind);
};
const asked = (chat: ThreadChat, request: OwnerRequest = HOLD, requestId = "r-1") =>
  chat.ask(requestId, request, "A request");

/** A kind 10 reply of alice's to the request `id` (the message id `ask` returned). */
const reply = (r: Rig, _b: Bot, id: string, answer: unknown) =>
  r.send(
    { kind: 10, to: r.botId, re: { device: r.botId, name: Buffer.from(id, "hex") } },
    { answer },
  );
const answer = { type: "hold", send: true };

test(
  "ask writes a request naming the opening prompt, and the reply reaches the core",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r);
    try {
      b.connection.start();
      await b.rested();
      const ref = { channel: hex(r.channel), thread: threadOf(r) };
      const id = await asked(provider(r, b).thread(ref));
      await b.until(async () => (await bodyOf(r, 9)).length === 1);
      const [request] = await bodyOf(r, 9);
      assert.equal(hex(request?.re?.device ?? new Uint8Array()), hex(r.alice.first.id));
      assert.equal(hex(request?.re?.name ?? new Uint8Array()), hex(fill(100, 16)));
      assert.equal(hex(request?.name ?? new Uint8Array()), id);
      await reply(r, b, id, answer);
      await b.until(() => b.answers.length === 1);
      assert.deepEqual(b.answers[0], ["r-1", answer]);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test("ask names the latest prompt of the thread when the owner's came since", DARWIN, async () => {
  const r = await rig();
  const b = botOn(r);
  try {
    b.connection.start();
    await b.rested();
    const thread = threadOf(r);
    await r.send({ to: r.botId, incarnation: incarnation(b) }, { text: "next", thread });
    await b.until(() => b.messages.length === 1);
    await asked(provider(r, b).thread({ channel: hex(r.channel), thread }));
    await b.until(async () => (await bodyOf(r, 9)).length === 1);
    const [request] = await bodyOf(r, 9);
    assert.equal(hex(request?.re?.name ?? new Uint8Array()), b.messages[0]?.id.slice(64));
  } finally {
    await b.stop();
    await r.stop();
  }
});

test("withdraw and rewrite write an edit naming the request", DARWIN, async () => {
  const r = await rig();
  const b = botOn(r);
  try {
    b.connection.start();
    await b.rested();
    const chat = provider(r, b).thread({ channel: hex(r.channel), thread: threadOf(r) });
    const first = await asked(chat);
    const second = await asked(chat, HOLD, "r-2");
    assert.equal(await chat.withdraw(first), true);
    await chat.rewrite(second, "Done");
    await b.until(async () => (await bodyOf(r, 11)).length === 2);
    const edits = await bodyOf(r, 11);
    assert.deepEqual(
      edits.map((e) => hex(e.re?.name ?? new Uint8Array())),
      [first, second],
    );
    // A withdrawn request waits no more: its reply is answered, and never reaches the core.
    await reply(r, b, first, answer);
    await b.until(async () => (await bodyOf(r, 5)).length === 1);
    assert.deepEqual(b.answers, []);
  } finally {
    await b.stop();
    await r.stop();
  }
});

test("the setup's ask, answer and rewrite come in that order", DARWIN, async () => {
  const r = await rig();
  const b = botOn(r);
  try {
    b.connection.start();
    await b.rested();
    const chat = provider(r, b).thread({ channel: hex(r.channel), thread: threadOf(r) });
    const setup: OwnerRequest = {
      type: "setup",
      requestId: "s-1",
      models: [],
      efforts: [],
      bypassOffered: false,
      selection: { model: "default", effort: "default", bypass: false },
    };
    const id = await asked(chat, setup, "s-1");
    const selection = { model: "default", effort: "default", bypass: false };
    await reply(r, b, id, { type: "setup", selection });
    await b.until(() => b.answers.length === 1);
    await chat.rewrite(id, "Set: default");
    await b.until(async () => (await bodyOf(r, 11)).length === 1);
    const kinds = (await r.held()).messages.map((m) => m.kind).filter((k) => k !== 3);
    assert.deepEqual(kinds, [9, 10, 5, 11]);
  } finally {
    await b.stop();
    await r.stop();
  }
});

test(
  "after a restart a reply to a request still in the sequence reaches the core",
  DARWIN,
  async () => {
    const r = await rig();
    const first = botOn(r);
    let next: Bot | undefined;
    try {
      first.connection.start();
      await first.rested();
      const id = await asked(
        provider(r, first).thread({ channel: hex(r.channel), thread: threadOf(r) }),
      );
      await first.until(async () => (await bodyOf(r, 9)).length === 1);
      await first.until(() => first.queued().length === 0);
      await first.stop();
      next = botOn(r, { taken: false });
      next.connection.start();
      await next.rested();
      await reply(r, next, id, answer);
      await next.until(() => (next as Bot).answers.length === 1);
      // The core knows no such request: it answers false, and the bot tells the owner (kind 5).
      assert.deepEqual(next.answers[0]?.[1], answer);
      assert.equal(next.answers[0]?.[0], id);
      await next.until(async () => (await bodyOf(r, 5)).length === 1); // the core's false: the bot answers the reply
    } finally {
      await next?.stop();
      await r.stop();
    }
  },
);

test("a kind 9 or 11 from another sender leaves what waits unchanged", DARWIN, async () => {
  const r = await rig();
  const b = botOn(r);
  try {
    b.connection.start();
    await b.rested();
    const chat = provider(r, b).thread({ channel: hex(r.channel), thread: threadOf(r) });
    const id = await asked(chat);
    await b.until(async () => (await bodyOf(r, 9)).length === 1);
    // The relay refuses a kind 9 from an app device, so both messages are handed to the bot's reading
    // as if read in the sequence, sealed under a key it holds.
    const key = fill(1, 32);
    const prompt = { device: r.alice.first.id, name: fill(100, 16) };
    const read = (kind: number, re: typeof prompt, content: object, name: number) => {
      const signed = sealMessage(
        platform,
        key,
        {
          channel: r.channel,
          counter: 900 + name,
          epoch: fill(2, 32),
          sender: r.alice.first.id,
          run: fill(4, 16),
          incarnation: fill(5, 16),
          time: 1_700_000_000_000,
          kind,
          re,
          name: fill(name, 16),
        },
        { files: [], content: JSON.stringify(content) },
      );
      const decoded = decodeMessage(signed);
      assert.ok(decoded.ok);
      const place = { epoch: fill(2, 32), member: true, key, log: [], length: 0 };
      b.inbound.take({
        do: "message",
        message: decoded.value,
        place,
        position: name,
      } as unknown as Out);
    };
    read(9, prompt, { thread: threadOf(r), request: { type: "hold" }, title: "x" }, 60);
    read(
      11,
      { device: r.botId, name: Buffer.from(id, "hex") },
      { thread: threadOf(r), withdrawn: true },
      61,
    );
    assert.deepEqual(
      [...b.inbound.waiting.values()].map((w) => w.requestId),
      ["r-1"],
    );
  } finally {
    await b.stop();
    await r.stop();
  }
});

test(
  "a withdrawal before a restart is read back: a late reply is not handed on",
  DARWIN,
  async () => {
    const r = await rig();
    const first = botOn(r);
    let next: Bot | undefined;
    try {
      first.connection.start();
      await first.rested();
      const chat = provider(r, first).thread({ channel: hex(r.channel), thread: threadOf(r) });
      const id = await asked(chat);
      assert.equal(await chat.withdraw(id), true);
      await first.until(async () => (await bodyOf(r, 11)).length === 1);
      await first.until(() => first.queued().length === 0);
      await first.stop();
      next = botOn(r);
      next.connection.start();
      await next.rested();
      await reply(r, next, id, answer);
      await next.until(async () => (await bodyOf(r, 5)).length === 1);
      assert.deepEqual(next.answers, []);
    } finally {
      await next?.stop();
      await r.stop();
    }
  },
);
