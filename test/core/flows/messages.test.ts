/**
 * The message flow of the core, over the memory chat: what a message of the owner's means by
 * where it was written and what it is, and how a prompt reaches its session. The chat only
 * draws; a second chat that draws gets the same behaviour.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { ListedSession } from "../../../src/agent/seam.ts";
import { ChatError } from "../../../src/chat/seam.ts";
import { logger } from "../../../src/core/flows/talk.ts";
import * as texts from "../../../src/core/texts.ts";
import { fill, named } from "../../../src/core/texts.ts";
import { AsyncEvent } from "../../support/fake-clock.ts";
import { OWNER } from "../../support/memory-chat.ts";
import { hold, PlainAgent } from "../../support/plain-agent.ts";
import { MessagesWorld, NoCommands, PLAIN_NAMES, tells } from "./messages-world.ts";

/** The lines the core's flows logged from here on. */
function logged(t: TestContext): string[] {
  const lines: string[] = [];
  for (const level of ["info", "warning", "error"] as const) {
    const write = logger[level].bind(logger);
    t.mock.method(logger, level, (line: string) => {
      lines.push(line);
      write(line);
    });
  }
  return lines;
}

// --- Where a message was written

test("a message in the channel opens a thread, asks the setup and sends the prompt once started", async (t) => {
  const world = await MessagesWorld.make(t);
  const sending = world.says("build the module");
  const open = await world.asked("setup");
  assert.deepEqual(await world.prompts(), [], "nothing is sent before Start");
  await world.start(open.ref);
  const sent = await sending;
  assert.equal(sent.topLevel, true);
  assert.deepEqual(await world.prompts(), ["build the module"]);
  assert.equal(world.state.thread(sent.ref.channel, sent.ref.thread)?.directory, world.folder);
  assert.deepEqual(world.chat.strayCalls(), []);
});

test("a message in a channel bound to no folder says where sessions start", async (t) => {
  const world = await MessagesWorld.make(t);
  const free = world.chat.openChannel("free");
  await world.chat.as(OWNER).says(free, "hello");
  assert.deepEqual(world.chat.texts(free).slice(1), [
    fill(texts.UNBOUND_ANY, { root: world.folder }),
  ]);
  assert.deepEqual(await world.prompts(), []);
  assert.deepEqual(world.chat.requests(), []);
});

test("the chat says the owner wrote in an unbound channel and the core tells how to bind, with no word of trust for an agent with none", async (t) => {
  const world = await MessagesWorld.make(t);
  const free = world.chat.openChannel("free");
  await world.inbound.unbound(free);
  assert.deepEqual(world.chat.texts(free), [fill(texts.UNBOUND_ANY, { root: world.folder })]);
  assert.deepEqual(await world.prompts(), []);
});

test("a reply in a session's thread is sent at once, with no second setup", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("first");
  await world.says("and a test", ref.thread);
  assert.deepEqual(await world.prompts(), ["first", "and a test"]);
  assert.deepEqual(world.chat.requests(), []);
});

test("a reply in a thread that holds no session is told so, and sent nowhere", async (t) => {
  const world = await MessagesWorld.make(t);
  const old = world.chat.openThread(world.channel);
  await world.says("hello again", old.thread);
  assert.deepEqual(world.shown(old).slice(1), ["hello again", texts.NOT_A_SESSION]);
  assert.deepEqual(await world.prompts(), []);
  assert.equal(world.state.thread(old.channel, old.thread), null);
});

test("a message the chat marks literal is a prompt, whatever its first characters", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = world.chat.openThread(world.channel); // the root exists: a form can be asked under it
  const sending = world.send({ ref, id: ref.thread, topLevel: true, text: "/stop", literal: true });
  const open = await world.asked("setup");
  await world.start(open.ref);
  await sending;
  assert.deepEqual(await world.prompts(), ["/stop"]);
});

test("a word is read in the plain text when the typed text carries marks", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = { channel: world.channel, thread: "root-2" };
  await world.send({ ref, id: "root-2", topLevel: true, text: "`/status`", plain: "/status" });
  const header = fill(texts.STATUS_CHANNEL_HEADER, { directory: world.folder });
  assert.ok(
    world.inChannel().some((line) => line.startsWith(header)),
    "the word was answered in the channel",
  );
  assert.deepEqual(await world.prompts(), []);
});

// --- The agent's commands

test("a command the agent offers is sent as its slash command", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("/echo hello there", ref.thread);
  assert.equal((await world.prompts()).at(-1), ":echo hello there");
});

test("a command typed in code formatting runs as the command, its arguments as sent", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.send({ ref, id: "m-1", text: "`/echo` hello", plain: "/echo hello" });
  await world.send({
    ref,
    id: "m-2",
    text: "`/echo` keep `the plan`",
    plain: "/echo keep `the plan`",
  });
  assert.deepEqual((await world.prompts()).slice(-2), [":echo hello", ":echo keep `the plan`"]);
});

test("anything before the prefix keeps a formatted message a prompt", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  // The escape of the setup doc: the text opens with a mark, the plain text with the backslash.
  await world.send({ ref, id: "m-1", text: "`\\/stop`", plain: "\\/stop" });
  assert.deepEqual((await world.prompts()).at(-1), "`\\/stop`");
  assert.equal(world.shown(ref).includes(texts.STOPPED_THREAD), false);
});

test("a command the agent does not offer is sent as typed", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("/nothing here", ref.thread);
  assert.equal((await world.prompts()).at(-1), "/nothing here");
});

test("a command that is only run on the host is answered, not sent", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("/signin", ref.thread);
  assert.equal(world.shown(ref).at(-1), named(texts.LOGIN_ON_HOST, PLAIN_NAMES));
  assert.deepEqual(await world.prompts(), ["first"]);
  await world.says("/signout");
  assert.equal(world.inChannel().at(-1), named(texts.LOGOUT_ON_HOST, PLAIN_NAMES));
  assert.deepEqual(await world.prompts(), ["first"], "no session started either");
});

test("a command the agent's terminal has and a session does not offer is answered, not sent", async (t) => {
  // no turn is spent on a command the session would refuse.
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("/undo the last edit", ref.thread);
  const answer = world.shown(ref).at(-1) ?? "";
  assert.ok(
    answer.startsWith(fill(named(texts.NOT_OFFERED, PLAIN_NAMES), { command: "undo" })),
    answer,
  );
  assert.ok(
    answer.includes("Ask the plain agent to put it back.") && answer.includes("docs/limits.md"),
    answer,
  );
  await world.says("/Panel", ref.thread);
  assert.ok(world.shown(ref).at(-1)?.includes("`/panel`"));
  assert.deepEqual(await world.prompts(), ["first"]);
  await world.says("/undo");
  assert.ok(world.inChannel().at(-1)?.includes("`/undo`"));
  assert.deepEqual(await world.prompts(), ["first"], "no session started either");
});

test("a command the session's own list offers is sent, though the agent's words say otherwise", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("/count one two", ref.thread);
  assert.equal((await world.prompts()).at(-1), ":count one two");
});

test("an agent with no commands of its own gets every /text as text", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new NoCommands() });
  const ref = await world.opened();
  await world.says("/login", ref.thread);
  await world.says("/clear", ref.thread);
  await world.says("/undo", ref.thread);
  assert.deepEqual(await world.prompts(), ["first", "/login", "/clear", "/undo"]);
  assert.ok(!world.shown(ref).includes(texts.CLEAR_IN_THREAD));
});

test("a /text the agent does not offer is sent with its whole content, not its text alone", async (t) => {
  // A chat's content can hold more than its text: what a pasted block adds (#273).
  const world = await MessagesWorld.make(t, { agent: new NoCommands() });
  const ref = await world.opened();
  await world.send({
    ref,
    id: "msg-pasted",
    text: "/important: why does row 2 differ?",
    content: async () =>
      "/important: why does row 2 differ?\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
  });
  assert.deepEqual(await world.prompts(), [
    "first",
    "/important: why does row 2 differ?\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
  ]);
});

test("a command that starts a new session is refused inside a thread", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  for (const word of ["/restart", "/RESTART now"]) await world.says(word, ref.thread);
  assert.deepEqual(world.shown(ref).filter((line) => line === texts.CLEAR_IN_THREAD).length, 2);
  assert.deepEqual(
    tells(world, ref).filter(([text]) => text === texts.CLEAR_IN_THREAD),
    [
      [texts.CLEAR_IN_THREAD, {}],
      [texts.CLEAR_IN_THREAD, {}],
    ],
  );
  assert.deepEqual(await world.prompts(), ["first"]);
});

test("another agent's login and new-session names reach the plain agent as any other text", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("/clear", ref.thread);
  await world.says("/login", ref.thread);
  await world.says("/logout", ref.thread);
  assert.deepEqual(await world.prompts(), ["first", "/clear", "/login", "/logout"]);
  assert.ok(!world.shown(ref).includes(texts.CLEAR_IN_THREAD));
  assert.ok(!world.shown(ref).includes(named(texts.LOGIN_ON_HOST, PLAIN_NAMES)));
});

// --- A thread whose folder is no longer the channel's

test("a reply in a thread whose folder is not the channel's any more says so on every prompt", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const docs = join(world.folder, "docs");
  mkdirSync(docs);
  world.state.bind(world.channel, docs);
  const expected = fill(named(texts.OLD_THREAD_FOLDER, PLAIN_NAMES), {
    old: world.folder,
    new: docs,
  });
  await world.says("go on", ref.thread);
  await world.says("again", ref.thread);
  assert.equal(world.shown(ref).filter((line) => line === expected).length, 2);
  assert.deepEqual(await world.prompts(), ["first", "go on", "again"]);
});

// --- The order of a thread's messages

test("the messages of a thread are sent in the order they were written, whatever their files take", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const slow = new AsyncEvent();
  const first = world.send({
    ref,
    id: "slow",
    text: "with a file",
    content: async () => {
      await slow.wait();
      return "with a file, read";
    },
  });
  const second = world.send({ ref, id: "quick", text: "no file" });
  await world.settle();
  assert.deepEqual(await world.prompts(), ["first"], "the second waits for the first's turn");
  slow.set();
  await Promise.all([first, second]);
  assert.deepEqual(await world.prompts(), ["first", "with a file, read", "no file"]);
});

test("the turns of two threads do not wait for each other", async (t) => {
  const world = await MessagesWorld.make(t);
  const one = await world.opened("one");
  const other = await world.opened("other");
  const slow = new AsyncEvent();
  const stuck = world.send({
    ref: one,
    id: "slow",
    text: "slow",
    content: async () => {
      await slow.wait();
      return "slow";
    },
  });
  await world.says("quick", other.thread);
  assert.deepEqual((await world.prompts()).toSorted(), ["one", "other", "quick"]);
  slow.set();
  await stuck;
  assert.deepEqual((await world.prompts()).toSorted(), ["one", "other", "quick", "slow"]);
});

test("a message whose files could not be taken sends nothing and says nothing", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const shown = world.shown(ref).length;
  await world.send({ ref, id: "refused", text: "with a file", content: async () => null });
  assert.deepEqual(await world.prompts(), ["first"]);
  assert.equal(world.shown(ref).length, shown);
});

// --- A stop, a drain, a session that closed

test("a message that arrives while the daemon drains is refused and names what the stop waits for", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", ref.thread);
  await world.settle();
  const cut = new AbortController();
  const drain = world.sessions.drain(cut.signal);
  await world.settle();
  const other = world.chat.openThread(world.channel);
  await world.says("one more", ref.thread);
  const link = fill(texts.STATUS_CHANNEL_LINK_FALLBACK, { thread_ts: ref.thread });
  assert.equal(
    world.shown(ref).at(-1),
    [
      texts.RESTARTING,
      texts.RESTART_WAITS_FOR,
      fill(texts.RESTART_WAIT_ROW, {
        channel: `#${world.channel}`, // the memory chat's form
        link,
        hold: texts.RESTART_HOLD_TURN,
      }),
      texts.RESTART_WAIT_STOP,
    ].join("\n"),
  );
  assert.deepEqual(await world.prompts(), ["first", "a long job"]);
  assert.equal(other.thread === ref.thread, false);
  cut.abort();
  await drain;
});

test("a drain that began while a message waited for its files refuses the prompt", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const slow = new AsyncEvent();
  const sending = world.send({
    ref,
    id: "slow",
    text: "late",
    content: async () => {
      await slow.wait();
      return "late";
    },
  });
  await world.settle();
  world.sessions.draining = true;
  slow.set();
  await sending;
  assert.deepEqual(await world.prompts(), ["first"]);
  assert.equal(world.shown(ref).at(-1), texts.RESTARTING);
});

test("a message does nothing once the daemon has stopped", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const slow = new AsyncEvent();
  const shown = world.shown(ref).length;
  const sending = world.send({
    ref,
    id: "slow",
    text: "late",
    content: async () => {
      await slow.wait();
      return "late";
    },
  });
  await world.settle();
  world.stopping.abort();
  slow.set();
  await sending;
  assert.deepEqual(await world.prompts(), ["first"]);
  assert.equal(world.shown(ref).length, shown);
});

test("a session closed during a slow download is retried on a fresh one", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  const slow = new AsyncEvent();
  const sending = world.send({
    ref,
    id: "slow",
    text: "more",
    content: async () => {
      await slow.wait();
      return "more";
    },
  });
  await world.settle();
  await session.close();
  slow.set();
  await sending;
  assert.deepEqual(await world.prompts(), ["first", "more"], "once, never twice");
  const rebuilt = world.sessions.get(ref.channel, ref.thread);
  assert.ok(rebuilt !== null && rebuilt !== session);
});

test("a retry that finds the thread gone answers session gone", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  const slow = new AsyncEvent();
  const sending = world.send({
    ref,
    id: "slow",
    text: "more",
    content: async () => {
      await slow.wait();
      return "more";
    },
  });
  await world.settle();
  await session.close();
  world.state.removeThread(ref.channel, ref.thread);
  slow.set();
  await sending;
  assert.deepEqual(await world.prompts(), ["first"]);
  assert.equal(world.shown(ref).at(-1), named(texts.SESSION_GONE, PLAIN_NAMES));
});

// --- The same-folder hold

test("a reply that would wake an idle session beside a busy one asks the hold first", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("one");
  const neighbour = await world.opened("two");
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", neighbour.thread);
  await world.settle();
  const sending = world.says("and this", ref.thread);
  const open = await world.asked("hold", ref);
  assert.equal((await world.prompts()).includes("and this"), false);
  await world.chat.as(OWNER).answers(open.requestId, { type: "hold", send: true });
  await sending;
  assert.equal((await world.prompts()).includes("and this"), true);
});

// --- A failure after the checks

test("a refusal of the chat is named as the chat's, not the agent's", async (t) => {
  const world = await MessagesWorld.make(t);
  logged(t);
  const ref = await world.opened();
  await world.send({
    ref,
    id: "refused",
    text: "x",
    content: async () => {
      throw new ChatError("refused_code", { failure: "refused" });
    },
  });
  assert.equal(
    world.shown(ref).at(-1),
    fill(named(texts.CHAT_REFUSED_REPLY, PLAIN_NAMES), { error: "refused_code" }),
  );
});

test("a failed call to the chat is named as such, not as a refusal", async (t) => {
  const world = await MessagesWorld.make(t);
  logged(t);
  const ref = await world.opened();
  await world.send({
    ref,
    id: "failed",
    text: "x",
    content: async () => {
      throw new ChatError("no_answer", { failure: "failed" });
    },
  });
  assert.equal(
    world.shown(ref).at(-1),
    fill(named(texts.CHAT_FAILED_REPLY, PLAIN_NAMES), { error: "no_answer" }),
  );
});

test("a failure of a prompt reaches the owner in its thread", async (t) => {
  const world = await MessagesWorld.make(t);
  const lines = logged(t);
  const ref = await world.opened();
  await world.send({
    ref,
    id: "broken",
    text: "x",
    content: async () => {
      throw new TypeError("a bug");
    },
  });
  assert.equal(
    world.shown(ref).at(-1),
    fill(named(texts.ERROR_REPLY, PLAIN_NAMES), { error: "TypeError" }),
  );
  assert.ok(
    lines.some((line) => line.includes(`a request failed in ${ref.channel}/${ref.thread}`)),
  );
  assert.deepEqual(await world.prompts(), ["first"]);
});

test("a reply in a thread whose session is being deleted starts nothing, and a freed thread takes a prompt again", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("first");
  // The thread keeps its entry while its messages are deleted: a reply sent then must not
  // rebuild a session from it.
  assert.equal(await world.sessions.release(ref.channel, ref.thread), true);
  await world.says("one more thing", ref.thread);
  await world.settle();
  assert.equal(world.shown(ref).at(-1), texts.NOT_A_SESSION);
  assert.deepEqual(await world.prompts(), ["first"]);
  assert.equal(world.sessions.get(ref.channel, ref.thread), null);
  // The delete failed and let the thread go.
  world.sessions.free(ref.channel, ref.thread);
  await world.says("one more thing", ref.thread);
  await world.settle();
  assert.deepEqual(await world.prompts(), ["first", "one more thing"]);
});

test("the word that starts a new session is no word of a thread at the top level: it opens a session like any text", async (t) => {
  const world = await MessagesWorld.make(t);
  const sending = world.says("/restart");
  const { ref } = await world.asked("setup");
  await world.start(ref);
  await sending;
  await world.settle();
  assert.deepEqual(await world.prompts(), ["/restart"]);
  assert.ok(!world.shown(ref).includes(texts.CLEAR_IN_THREAD));
});

/** An agent whose listing of the sessions fails, as an unreadable transcript folder does. */
class Unreadable extends PlainAgent {
  override async listSessions(): Promise<readonly ListedSession[]> {
    const error = new Error("transcripts unreadable");
    error.name = "PermissionError";
    throw error;
  }
}

test("a word typed in the channel whose failure is told in the channel and cannot be, pushes nothing into its thread", async (t) => {
  const warnings: string[] = [];
  t.mock.method(logger, "warning", (line: string) => warnings.push(line));
  t.mock.method(logger, "error", () => {});
  const world = await MessagesWorld.make(t, { agent: new Unreadable() });
  world.faults.channelNotice = true;
  const sent = await world.says("/resume");
  await world.settle();
  // The word is shown, and nothing else: no failure line under it, none in the channel.
  assert.deepEqual(world.shown(sent.ref), ["/resume"]);
  assert.deepEqual(world.inChannel(), ["/resume"]);
  assert.ok(warnings.some((line) => line.includes("could not report a failure")));
});

test("the word's failure is told in the channel when the chat takes it", async (t) => {
  t.mock.method(logger, "error", () => {});
  const world = await MessagesWorld.make(t, { agent: new Unreadable() });
  const sent = await world.says("/resume");
  assert.deepEqual(world.inChannel().slice(-1), [
    fill(named(texts.ERROR_REPLY, PLAIN_NAMES), { error: "PermissionError" }),
  ]);
  assert.deepEqual(world.shown(sent.ref).slice(1), []);
});

test("a thread in the channel's current folder never gets the old-folder notice", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("go on", ref.thread);
  await world.says("again", ref.thread);
  // The prompts were shown and sent: the thread's view is the one the notice would be drawn in.
  assert.ok(world.shown(ref).includes("again"));
  assert.ok(!world.shown(ref).some((line) => line.includes("resumes a session only there")));
  assert.deepEqual(await world.prompts(), ["first", "go on", "again"]);
});

test("the refusal of a thread that holds no session is a line for the owner alone, and a failure is a post that stays", async (t) => {
  t.mock.method(logger, "error", () => {});
  const world = await MessagesWorld.make(t);
  const old = world.chat.openThread(world.channel);
  await world.says("hello again", old.thread);
  assert.deepEqual(tells(world, old), [[texts.NOT_A_SESSION, {}]]);
  const ref = await world.opened();
  await world.send({
    ref,
    id: "broken",
    text: "x",
    content: async () => {
      throw new TypeError("a bug");
    },
  });
  assert.deepEqual(tells(world, ref), [
    [fill(named(texts.ERROR_REPLY, PLAIN_NAMES), { error: "TypeError" }), { stays: true }],
  ]);
});

test("a prompt refused during a stop is a line for the owner alone", async (t) => {
  const world = await MessagesWorld.make(t);
  await world.sessions.drain(new AbortController().signal);
  const sent = await world.says("list the files");
  assert.deepEqual(tells(world, sent.ref), [[texts.RESTARTING, {}]]);
});

// --- Files and the old folder, the stop's waits

test("a message with files in a channel bound to no folder explains how to bind, and reads no file", async (t) => {
  const world = await MessagesWorld.make(t);
  const free = world.chat.openChannel("free");
  const read: string[] = [];
  const ref = world.chat.openThread(free);
  await world.send({
    ref,
    id: ref.thread,
    topLevel: true,
    text: "look at this",
    content: async () => {
      read.push("content");
      return "look at this";
    },
  });
  assert.deepEqual(world.chat.texts(free).slice(1), [
    fill(texts.UNBOUND_ANY, { root: world.folder }),
  ]);
  assert.deepEqual(read, []);
  assert.deepEqual(await world.prompts(), []);
});

test("a bind while the files of a message download never moves the thread already opened", async (t) => {
  const world = await MessagesWorld.make(t);
  const docs = join(world.folder, "docs");
  mkdirSync(docs);
  const ref = world.chat.openThread(world.channel);
  const slow = new AsyncEvent();
  const sending = world.send({
    ref,
    id: ref.thread,
    topLevel: true,
    text: "with a file",
    content: async () => {
      await slow.wait();
      return "with a file";
    },
  });
  await world.settle();
  const opened = world.state.thread(ref.channel, ref.thread)?.directory;
  assert.equal(opened, world.folder);
  await world.says("/bind docs");
  assert.equal(world.state.channel(world.channel)?.directory, docs);
  slow.set();
  const setup = await world.asked("setup");
  await world.start(setup.ref);
  await sending;
  await world.settle();
  assert.deepEqual(await world.prompts(), ["with a file"]);
  assert.equal(world.state.thread(ref.channel, ref.thread)?.directory, opened);
  assert.equal(world.sessions.get(ref.channel, ref.thread)?.directory, world.folder);
});

test("a prompt while the daemon stops is refused with the restart line alone, and a word is still answered", async (t) => {
  const world = await MessagesWorld.make(t);
  await world.sessions.drain(new AbortController().signal); // nothing runs: returns at once
  const sent = await world.says("list the files");
  assert.equal(world.shown(sent.ref).at(-1), texts.RESTARTING);
  assert.deepEqual(tells(world, sent.ref), [[texts.RESTARTING, {}]]);
  assert.deepEqual(await world.prompts(), []);
  await world.says("/stop");
  assert.equal(world.inChannel().at(-1), texts.NOTHING_TO_STOP);
});

/** A thread of a session that works, and the line its work gives a stop (`RESTART_HOLD_TURN`). */
async function workingThread(world: MessagesWorld, prompt: string) {
  const ref = await world.opened("one");
  (world.agent as PlainAgent).next(hold());
  await world.says(prompt, ref.thread);
  await world.settle();
  return ref;
}

test("a channel status during a stop counts the other channels' waits without naming them", async (t) => {
  const world = await MessagesWorld.make(t);
  const here = await workingThread(world, "hello");
  // Another folder: no hold between the two sessions.
  const other = world.chat.openChannel("other");
  const elsewhere = join(world.folder, "other");
  mkdirSync(elsewhere);
  world.state.bind(other, elsewhere);
  (world.agent as PlainAgent).next(hold());
  const sending = world.chat.as(OWNER).says(other, "busy elsewhere");
  const setup = await world.asked("setup");
  await world.start(setup.ref);
  await sending;
  await world.settle();
  assert.deepEqual((await world.prompts()).slice(-2), ["hello", "busy elsewhere"]);
  const cut = new AbortController();
  const drain = world.sessions.drain(cut.signal);
  await world.settle();
  await world.says("/status");
  cut.abort();
  await drain;
  const link = fill(texts.STATUS_CHANNEL_LINK_FALLBACK, { thread_ts: here.thread });
  assert.deepEqual(world.inChannel().at(-1)?.split("\n"), [
    texts.RESTART_WAITS_HEADER,
    fill(texts.RESTART_WAIT_ROW, {
      channel: `#${world.channel}`,
      link,
      hold: texts.RESTART_HOLD_TURN,
    }),
    fill(texts.RESTART_WAITS_ELSEWHERE, { count: 1 }),
    texts.RESTART_WAIT_STOP,
  ]);
  assert.ok(!world.inChannel().some((line) => line.includes(other)));
});

test("a thread that only waits for a report gets no stop advice", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("one");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  t.mock.method(world.sessions, "restartHolds", () => [[session, texts.RESTART_HOLD_REPORT]]);
  world.sessions.draining = true;
  await world.says("list the files", ref.thread);
  const refusal = world.shown(ref).at(-1) ?? "";
  assert.ok(refusal.includes(texts.RESTART_HOLD_REPORT), refusal);
  assert.ok(!refusal.includes(texts.RESTART_WAIT_STOP), refusal);
  world.sessions.draining = false;
});

test("a long list of waits is cut between rows, and says how many were left out", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("one");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  t.mock.method(world.sessions, "restartHolds", () =>
    Array.from({ length: 11 }, () => [session, texts.RESTART_HOLD_TURN] as const),
  );
  world.sessions.draining = true;
  await world.says("list the files", ref.thread);
  const lines = (world.shown(ref).at(-1) ?? "").split("\n");
  assert.equal(lines.filter((line) => line.startsWith("• ")).length, 8);
  assert.deepEqual(lines.slice(-2), [
    fill(texts.RESTART_WAITS_MORE, { count: 3 }),
    texts.RESTART_WAIT_STOP,
  ]);
  world.sessions.draining = false;
});
