import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayProvider, splitParts } from "../../../src/chat/relay/provider.ts";
import type { InboundMessage, ThreadChat } from "../../../src/chat/seam.ts";
import { decodeMessage } from "../../../src/protocol/messages.ts";
import { DARWIN } from "../../relay/process-support.ts";
import { platform } from "../../relay/support.ts";
import { botOn, hex, incarnation, rig } from "./relay-rig.ts";

type Rig = Awaited<ReturnType<typeof rig>>;
type Bot = ReturnType<typeof botOn>;

const provider = (r: Rig, b: Bot) => new RelayProvider(r.botId, b.outbox, b.inbound, platform);
const kind = async (r: Rig, k: number) => (await r.held()).messages.filter((m) => m.kind === k);

/** alice's prompt reaches the core; the message the core was handed and its thread. */
async function prompted(
  r: Rig,
  b: Bot,
  text = "go",
): Promise<{ message: InboundMessage; chat: ThreadChat }> {
  const count = b.messages.length;
  await r.send({ to: r.botId, incarnation: incarnation(b) }, { text });
  await b.until(() => b.messages.length === count + 1);
  const message = b.messages[count] as InboundMessage;
  return { message, chat: provider(r, b).thread(message.ref) };
}

test("splitParts cuts at 64 KiB of UTF-8 and never inside a character", () => {
  assert.deepEqual(splitParts(""), []);
  assert.deepEqual(splitParts("abc"), ["abc"]);
  const exact = "a".repeat(65_536);
  assert.deepEqual(splitParts(exact), [exact]);
  assert.deepEqual(splitParts(`${exact}b`), [exact, "b"]);
  // Two-byte characters: 32,768 fit, the next starts a new part whole.
  const wide = "é".repeat(32_769);
  const parts = splitParts(wide);
  assert.deepEqual(
    parts.map((p) => Buffer.byteLength(p)),
    [65_536, 2],
  );
  assert.equal(parts.join(""), wide);
  // An astral character (four bytes, two UTF-16 units) is never cut between its units.
  const astral = `${"a".repeat(65_535)}😀`;
  assert.deepEqual(splitParts(astral), ["a".repeat(65_535), "😀"]);
});

test(
  "a long reply is written as parts under 64 KiB that name the answer, and the done signal writes one answer",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r);
    try {
      b.connection.start();
      await b.rested();
      const { message, chat } = await prompted(r, b);
      const reply = chat.openReply(() => {}, message.id);
      const long = "x".repeat(70_000);
      await reply.text(long);
      await reply.text(" end", { ending: true });
      assert.equal(await reply.waitLanded(), true, "every part is read back");
      const parts = await kind(r, 4);
      assert.equal(parts.length, 3);
      const answerName = parts[0]?.re?.name as Uint8Array;
      for (const part of parts) {
        assert.equal(hex(part.re?.device as Uint8Array), hex(r.botId));
        assert.equal(hex(part.re?.name as Uint8Array), hex(answerName));
        assert.ok(Buffer.byteLength(String(r.body(part).markdown)) <= 65_536);
      }
      assert.deepEqual(
        parts.map((p) => r.body(p).ending),
        [undefined, undefined, true],
      );
      assert.equal(parts.map((p) => r.body(p).markdown).join(""), `${long} end`);
      assert.deepEqual(await kind(r, 5), [], "no answer before the core is done");
      message.handled?.();
      message.handled?.(); // once: a second call writes nothing
      await b.until(async () => (await kind(r, 5)).length === 1);
      const [answer] = await kind(r, 5);
      assert.equal(hex(answer?.name as Uint8Array), hex(answerName));
      assert.equal(hex(answer?.re?.name as Uint8Array), message.id.slice(64));
      assert.deepEqual(r.body(answer as never), {
        thread: message.ref.thread,
        markdown: `${long} end`,
      });
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "a prompt the core finished with no reply gets an empty answer; none is written once the bot stopped",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r);
    try {
      b.connection.start();
      await b.rested();
      const first = await prompted(r, b, "!status");
      first.message.handled?.();
      await b.until(async () => (await kind(r, 5)).length === 1);
      assert.equal(r.body((await kind(r, 5))[0] as never).markdown, "");
      const second = await prompted(r, b, "again");
      b.inbound.start(undefined); // what `RelayProvider.stop` does
      second.message.handled?.();
      await new Promise((s) => setTimeout(s, 400));
      assert.equal(
        (await kind(r, 5)).length,
        1,
        "a prompt the core never finished stays unanswered",
      );
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test("a reply stops waiting for its read-back when the bot stops", DARWIN, async () => {
  const r = await rig();
  const b = botOn(r);
  try {
    b.connection.start();
    await b.rested();
    const { chat, message } = await prompted(r, b);
    await b.connection.stop(); // nothing can be sent or read back from here on
    const reply = chat.openReply(() => {}, message.id);
    await reply.text("hello");
    const waiting = reply.waitLanded();
    b.outbox.release();
    assert.equal(await waiting, false);
    assert.equal(await reply.waitLanded(), false, "a wait that starts after the stop ends too");
    assert.equal(await reply.waitLanded(AbortSignal.abort()), false);
  } finally {
    await r.stop();
  }
});

test("closeOut answers at once, and false while a part is unread", DARWIN, async () => {
  const r = await rig();
  const b = botOn(r);
  try {
    b.connection.start();
    await b.rested();
    const { chat, message } = await prompted(r, b);
    await b.connection.stop(); // nothing is read back
    const reply = chat.openReply(() => {}, message.id);
    await reply.text("hello");
    assert.equal(await reply.closeOut(), false, "it does not wait for the read-back");
    assert.equal(await reply.settle(), false, "settle is a last look: it answers at once too");
  } finally {
    await r.stop();
  }
});

test("a part the relay refuses does not count as landed", DARWIN, async () => {
  const r = await rig();
  const b = botOn(r, {
    // A part (message kind 4) is answered "too large"; the start and the rest go through.
    submit: (real) => async (kind, signed, sig) => {
      const header = decodeMessage(signed);
      return kind === 4 && header.ok && header.value.header.kind === 4
        ? 8
        : real(kind, signed, sig);
    },
  });
  try {
    b.connection.start();
    await b.rested();
    const { chat, message } = await prompted(r, b);
    const reply = chat.openReply(() => {}, message.id);
    await reply.text("hello");
    assert.equal(await reply.waitLanded(), false);
  } finally {
    await b.stop();
    await r.stop();
  }
});

test(
  "text after the prompt's answer, and of a reply with no prompt of its own, goes out as texts of the thread",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r);
    try {
      b.connection.start();
      await b.rested();
      const { chat, message } = await prompted(r, b);
      const reply = chat.openReply(() => {}, message.id);
      await reply.text("BEFORE");
      message.handled?.();
      await b.until(async () => (await kind(r, 5)).length === 1);
      await reply.text("AFTER");
      const report = chat.openReply(() => {}); // a report turn: no prompt
      await report.text("REPORT");
      await report.waitLanded();
      await reply.waitLanded();
      const answers = (await kind(r, 5)).map((m) => ({
        name: hex(m.name),
        md: r.body(m).markdown,
      }));
      assert.deepEqual(
        answers.map((a) => a.md),
        ["BEFORE"],
      );
      for (const part of await kind(r, 4))
        assert.equal(hex(part.re?.name as Uint8Array), answers[0]?.name);
      const texts = (await kind(r, 1)).map((m) => r.body(m).markdown);
      assert.deepEqual(texts.filter((t) => t === "AFTER" || t === "REPORT").sort(), [
        "AFTER",
        "REPORT",
      ]);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);
