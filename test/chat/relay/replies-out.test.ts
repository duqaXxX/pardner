import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RelayProvider, splitParts } from "../../../src/chat/relay/provider.ts";
import type { ChannelBind, InboundMessage, ThreadChat } from "../../../src/chat/seam.ts";
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
      message.handled?.(true);
      message.handled?.(true); // once: a second call writes nothing
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
      const first = await prompted(r, b, "/status");
      first.message.handled?.(true);
      await b.until(async () => (await kind(r, 5)).length === 1);
      assert.equal(r.body((await kind(r, 5))[0] as never).markdown, "");
      const second = await prompted(r, b, "again");
      b.inbound.start(undefined); // what `RelayProvider.stop` does
      second.message.handled?.(true);
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
      message.handled?.(true);
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

test(
  "a top-level prompt answered as no session says so in its answer, and its channel lines name it (#68)",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r);
    try {
      b.connection.start();
      await b.rested();
      const { message } = await prompted(r, b, "/bypass on");
      const channel = provider(r, b).channel(message.ref.channel);
      await channel.notice("Bypass applies inside a session.", message.id);
      await channel.say("A reference.", message.id);
      await channel.notice("A line of no prompt.");
      message.handled?.(false);
      await b.until(async () => (await kind(r, 5)).length === 1);
      const [answer] = await kind(r, 5);
      assert.deepEqual(r.body(answer as never), {
        thread: message.ref.thread,
        markdown: "",
        session: false,
      });
      const lines = await kind(r, 1);
      assert.equal(lines.length, 3);
      const [first, second, third] = lines;
      for (const line of [first, second]) {
        assert.equal(hex(line?.re?.device as Uint8Array), message.id.slice(0, 64));
      }
      assert.equal(third?.re, undefined, "a line that answers no prompt names none");
      assert.deepEqual(r.body(first as never), {
        say: "notice",
        markdown: "Bypass applies inside a session.",
      });
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "an answer of a prompt whose thread holds a session carries no flag (#68)",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r);
    try {
      b.connection.start();
      await b.rested();
      const { message } = await prompted(r, b, "hello");
      message.handled?.(true);
      await b.until(async () => (await kind(r, 5)).length === 1);
      assert.equal("session" in r.body((await kind(r, 5))[0] as never), false);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "a throw of the core after it took a prompt leaves the flag to the core's own done signal (#68)",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r, { rejects: true });
    try {
      b.connection.start();
      await b.rested();
      const { message } = await prompted(r, b, "hello");
      await new Promise((s) => setTimeout(s, 200)); // the rejection has been handled
      message.handled?.(true); // the core opened a session, then the turn ended
      await b.until(async () => (await kind(r, 5)).length === 1);
      assert.equal("session" in r.body((await kind(r, 5))[0] as never), false);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

const bindVectors = JSON.parse(
  readFileSync(
    new URL("../../protocol/content-vectors/bind-content.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: Array<{
    name: string;
    content: { markdown: string; bind?: ChannelBind };
    bind: ChannelBind | null;
  }>;
};

test(
  "a channel line writes the bind of a /bind answer in its first piece only, as the shared vectors read (#69)",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r);
    try {
      b.connection.start();
      await b.rested();
      const { message } = await prompted(r, b, "/bind demo");
      const channel = provider(r, b).channel(message.ref.channel);
      const written = bindVectors.cases.filter((c) => c.bind !== null);
      for (const { content } of written)
        await channel.notice(content.markdown, undefined, content.bind);
      // Two pieces: the folder rides the first.
      const long = "a".repeat(65_537);
      await channel.notice(long, undefined, { folder: "/srv/code/demo", state: "usable" });
      await channel.notice("A line of no bind.");
      await b.until(async () => (await kind(r, 1)).length === written.length + 3);
      const lines = (await kind(r, 1)).map((m) => r.body(m as never));
      assert.deepEqual(
        lines.slice(0, written.length),
        written.map((c) => c.content),
      );
      assert.deepEqual(lines[written.length], {
        say: "notice",
        markdown: "a".repeat(65_536),
        bind: { folder: "/srv/code/demo", state: "usable" },
      });
      assert.deepEqual(lines[written.length + 1], { say: "notice", markdown: "a" });
      assert.deepEqual(lines[written.length + 2], {
        say: "notice",
        markdown: "A line of no bind.",
      });
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test("a channel notice is placed in the outbox at the call, first piece with its bind (#69)", async () => {
  const placed: Array<{ content: string }> = [];
  const outbox = {
    queue: async (_channel: unknown, draft: { content: string }) => {
      placed.push(draft);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    },
  };
  const relay = new RelayProvider(new Uint8Array(32), outbox as never, {} as never, platform);
  const bind = { folder: "/srv/code/demo", state: "usable" } as const;
  const done = relay.channel("ab".repeat(32)).notice("a".repeat(65_537), undefined, bind);
  // Nothing awaited yet: the core orders its replies by this.
  assert.equal(placed.length, 1);
  assert.deepEqual(JSON.parse(placed[0]?.content as string).bind, bind);
  await done;
  assert.equal(placed.length, 2);
  assert.equal(JSON.parse(placed[1]?.content as string).bind, undefined);
});
