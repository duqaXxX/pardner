import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Clock } from "../../../src/chat/relay/connection.ts";
import { RelayProvider, splitParts } from "../../../src/chat/relay/provider.ts";
import type {
  ChannelBind,
  InboundMessage,
  TaskUpdate,
  ThreadChat,
} from "../../../src/chat/seam.ts";
import { decodeMessage } from "../../../src/protocol/messages.ts";
import { DARWIN } from "../../relay/process-support.ts";
import { platform } from "../../relay/support.ts";
import { botOn, hex, incarnation, rig } from "./relay-rig.ts";

type Rig = Awaited<ReturnType<typeof rig>>;
type Bot = ReturnType<typeof botOn>;

const provider = (r: Rig, b: Bot) =>
  new RelayProvider(r.botId, b.outbox, b.inbound, platform, undefined, undefined, b.clock);
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
      await reply.finish([]); // the core ends the reply before it settles the prompt
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

/** A clock that moves only when a test says so: `pending` counts the waits not yet over or aborted since `mark`. */
class FakeClock implements Clock {
  #now = 0;
  #waits = new Set<{ at: number; end: (passed: boolean) => void }>();
  now = () => this.#now;
  idle = (ms: number, signal: AbortSignal) => this.wait(ms, signal);
  /** The connection shares this clock: its own waits, at the mark, are not counted. */
  #base = 0;
  mark() {
    this.#base = this.#waits.size;
  }
  get pending() {
    return this.#waits.size - this.#base;
  }
  wait(ms: number, signal: AbortSignal) {
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) return resolve(false);
      const wait = { at: this.#now + ms, end: resolve };
      this.#waits.add(wait);
      signal.addEventListener(
        "abort",
        () => {
          this.#waits.delete(wait);
          resolve(false);
        },
        { once: true },
      );
    });
  }
  /** Moves time on, ending each wait at its own moment, and lets what each one started run. */
  async advance(ms: number) {
    const to = this.#now + ms;
    for (;;) {
      const due = [...this.#waits].filter((w) => w.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.#now = Math.max(this.#now, due.at);
      this.#waits.delete(due);
      due.end(true);
      await new Promise((s) => setImmediate(s));
    }
    this.#now = to;
  }
}

const call = (id: string): TaskUpdate => ({
  id,
  title: `Read ${id}`,
  status: "in_progress",
  details: null,
  output: null,
  name: "Read",
  task: false,
  message: false,
  agent: null,
  calls: 0,
  preview: null,
  folded: null,
  startedAt: null,
});

/** What the relay holds of a reply, in order: `part`, `text`, `line` and `edit`, each with its words. */
async function trail(r: Rig): Promise<string[]> {
  const messages = (await r.held()).messages.filter((m) => [1, 4, 9, 11].includes(m.kind));
  return messages.map((m) => {
    const body = r.body(m as never);
    if (m.kind === 4) return `part:${body.markdown}`;
    if (m.kind === 11) return "edit";
    if (m.kind === 9) return "card";
    return body.say === "task" ? "line" : `text:${body.markdown}`;
  });
}

/** A relay, a bot and a provider on a fake clock; `run` gets what a reply of the core is handed. */
async function pacing(
  run: (c: {
    r: Rig;
    b: Bot;
    clock: FakeClock;
    chat: ThreadChat;
    message: InboundMessage;
    seen: (count: number) => Promise<string[]>;
  }) => Promise<void>,
) {
  const r = await rig();
  const clock = new FakeClock();
  const b = botOn(r, { clock });
  try {
    b.connection.start();
    await b.rested();
    clock.mark();
    const count = b.messages.length;
    await r.send({ to: r.botId, incarnation: incarnation(b) }, { text: "go" });
    await b.until(() => b.messages.length === count + 1);
    const message = b.messages[count] as InboundMessage;
    const chat = new RelayProvider(
      r.botId,
      b.outbox,
      b.inbound,
      platform,
      undefined,
      undefined,
      clock,
    ).thread(message.ref);
    // The messages the relay holds once `count` of them are the reply's.
    const seen = async (n: number) => {
      await b.until(async () => (await trail(r)).length >= n);
      return trail(r);
    };
    await run({ r, b, clock, chat, message, seen });
  } finally {
    await b.stop();
    await r.stop();
  }
}

test("the relay chat declares native streaming", () => {
  const p = new RelayProvider(new Uint8Array(32), {} as never, {} as never, platform);
  assert.equal(p.capabilities.nativeStreaming, true);
});

const delta = { notice: false, ending: false };

test("a text held then 5 seconds is a part before finish", DARWIN, () =>
  pacing(async ({ r, clock, chat, message, seen }) => {
    const reply = chat.openReply(() => {}, message.id);
    await reply.text("hello", delta);
    assert.deepEqual(await trail(r), [], "nothing is written while the text is held");
    await clock.advance(5_000);
    assert.deepEqual(await seen(1), ["part:hello"]);
    assert.equal(clock.pending, 0, "no wait is left once the buffer is flushed");
  }),
);

test("deltas every 0.1 s for 12 s are three parts that join to the answer", DARWIN, () =>
  pacing(async ({ clock, chat, message, seen }) => {
    const reply = chat.openReply(() => {}, message.id);
    let text = "";
    for (let i = 0; i < 120; i++) {
      await reply.text(`d${i} `, delta);
      text += `d${i} `;
      await clock.advance(100);
    }
    await reply.finish([]);
    const written = await seen(3);
    assert.equal(written.length, 3);
    assert.ok(written.every((w) => w.startsWith("part:")));
    assert.equal(written.map((w) => w.slice(5)).join(""), text);
    await reply.closeOut();
    assert.equal(clock.pending, 0);
  }),
);

test("a pause of 1 second flushes what is held", DARWIN, () =>
  pacing(async ({ r, clock, chat, message, seen }) => {
    const reply = chat.openReply(() => {}, message.id);
    await reply.text("one", delta);
    await clock.advance(900);
    await reply.text(" two", delta); // moves the pause's deadline
    await clock.advance(900);
    assert.deepEqual(await trail(r), []);
    await clock.advance(100);
    assert.deepEqual(await seen(1), ["part:one two"]);
  }),
);

test("a task after 2 seconds of text writes the part first, then the line", DARWIN, () =>
  pacing(async ({ clock, chat, message, seen }) => {
    const reply = chat.openReply(() => {}, message.id);
    for (let i = 0; i < 20; i++) {
      await reply.text("x", delta);
      await clock.advance(100);
    }
    await reply.task(call("a"));
    assert.deepEqual(await seen(2), ["part:xxxxxxxxxxxxxxxxxxxx", "line"]);
  }),
);

test("finish and closeOut flush what is held", DARWIN, () =>
  pacing(async ({ chat, message, seen, clock }) => {
    const finishing = chat.openReply(() => {}, message.id);
    await finishing.text("before finish", delta);
    await finishing.finish([]);
    assert.deepEqual(await seen(1), ["part:before finish"]);
    const closing = chat.openReply(() => {}, message.id);
    await closing.text(" before closeOut", delta);
    await closing.closeOut();
    assert.deepEqual(await seen(2), ["part:before finish", "part: before closeOut"]);
    assert.equal(clock.pending, 0, "no timer after closeOut");
    await closing.text(" late", delta);
    assert.equal(clock.pending, 0, "nothing is held after closeOut");
  }),
);

test("a report turn gets texts at pauses, never every 5 seconds while text flows", DARWIN, () =>
  pacing(async ({ r, clock, chat, seen }) => {
    const report = chat.openReply(() => {}); // no prompt
    for (let i = 0; i < 120; i++) {
      await report.text(`d${i} `, delta);
      await clock.advance(100);
    }
    assert.deepEqual(await trail(r), [], "12 seconds of flowing text, nothing written");
    await clock.advance(1_000);
    const [only, ...rest] = await seen(1);
    assert.ok(only?.startsWith("text:d0 d1 "));
    assert.deepEqual(rest, []);
    await report.text("tail", delta);
    await report.finish([]);
    assert.deepEqual((await seen(2)).slice(1), ["text:tail"]);
  }),
);

test("a text held after finish starts the 1 second timer only", DARWIN, () =>
  pacing(async ({ r, clock, chat, message, seen }) => {
    const reply = chat.openReply(() => {}, message.id);
    await reply.finish([]);
    for (let i = 0; i < 20; i++) {
      await reply.text("r", delta);
      await clock.advance(500);
    }
    assert.deepEqual(await trail(r), [], "no 5 second deadline after finish");
    await clock.advance(1_000);
    assert.deepEqual(await seen(1), [`part:${"r".repeat(20)}`]);
  }),
);

test("a timer that fires while a task write is in progress writes after it", DARWIN, () =>
  pacing(async ({ b, clock, chat, message, seen }) => {
    const reply = chat.openReply(() => {}, message.id);
    await reply.text("held", delta);
    // The line's write is slow: the timer fires in the middle of it.
    const queue = b.outbox.queue.bind(b.outbox);
    b.outbox.queue = async (...args: Parameters<typeof queue>) => {
      await new Promise((s) => setTimeout(s, 150));
      return queue(...args);
    };
    const task = reply.task(call("a")); // flushes "held" first, on the chain
    await new Promise((s) => setTimeout(s, 50)); // the part's write is under way
    await reply.text("more", delta);
    await clock.advance(1_000); // fires while the chain is busy
    await task;
    await reply.finish([]);
    assert.deepEqual(await seen(3), ["part:held", "line", "part:more"]);
  }),
);

test("a timer that fired while finish was queued writes nothing of its own", DARWIN, () =>
  pacing(async ({ r, b, clock, chat, message, seen }) => {
    const reply = chat.openReply(() => {}, message.id);
    const queue = b.outbox.queue.bind(b.outbox);
    b.outbox.queue = async (...args: Parameters<typeof queue>) => {
      await new Promise((s) => setTimeout(s, 150));
      return queue(...args);
    };
    await reply.task(call("a"));
    await reply.text("held", delta);
    const finishing = reply.finish([]); // flushes "held" when its turn comes
    await clock.advance(1_000); // the timer fires meanwhile and queues a flush behind finish
    await finishing;
    await reply.waitLanded();
    assert.deepEqual(await seen(2), ["line", "part:held"]);
    await new Promise((s) => setTimeout(s, 300));
    assert.deepEqual(await trail(r), ["line", "part:held"], "the late flush wrote nothing");
  }),
);

const real = (ms: number) => new Promise((s) => setTimeout(s, ms));

/** The outbox takes `ms` of real time to queue anything, and notes each kind queued. */
function slowed(b: Bot, ms: number) {
  const kinds: number[] = [];
  const queue = b.outbox.queue.bind(b.outbox);
  b.outbox.queue = async (...args: Parameters<typeof queue>) => {
    await real(ms);
    kinds.push(args[1].kind);
    return queue(...args);
  };
  return kinds;
}

test("a request's card is written after the text held before it, the clock not moved", DARWIN, () =>
  pacing(async ({ clock, chat, message, seen }) => {
    const reply = chat.openReply(() => {}, message.id);
    await reply.text("Which option?", delta);
    await chat.ask(
      "r-1",
      { type: "hold", requestId: "r-1", other: { channel: "c", thread: "t" }, link: "l" },
      "A request",
    );
    assert.equal(clock.now(), 0);
    assert.deepEqual(await seen(2), ["part:Which option?", "card"]);
  }),
);

test(
  "a text that arrives while closeOut flushes is written before it resolves, and no timer remains",
  DARWIN,
  () =>
    pacing(async ({ b, clock, chat, message, seen }) => {
      const reply = chat.openReply(() => {}, message.id);
      const kinds = slowed(b, 150);
      await reply.text("a", delta);
      const closing = reply.closeOut();
      await real(50); // the part of "a" is being written
      await reply.text("b", delta);
      await closing;
      assert.deepEqual(kinds, [4, 4], "both parts were queued when closeOut resolved");
      assert.equal(clock.pending, 0);
      assert.deepEqual(await seen(2), ["part:a", "part:b"]);
    }),
);

test(
  "a timer queued behind a slow write is not followed by an early flush of the next text",
  DARWIN,
  () =>
    pacing(async ({ r, b, clock, chat, message }) => {
      const reply = chat.openReply(() => {}, message.id);
      slowed(b, 300);
      await reply.text("a", delta);
      await clock.advance(1_000); // the first flush starts, 300 ms real
      await reply.text("b", delta);
      await clock.advance(5_000); // past the deadline: a flush queues behind the first
      await reply.text("c", delta);
      await clock.advance(1);
      await reply.text("d", delta);
      await clock.advance(1);
      await real(350);
      await reply.text("e", delta); // a fresh buffer: its pause of 1 second is not over
      await real(1_200);
      const written = await trail(r);
      assert.ok(!written.includes("part:e"), `e went out early: ${written}`);
      assert.equal(written.join(""), "part:apart:bcd");
    }),
);
