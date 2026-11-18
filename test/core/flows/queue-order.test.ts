/**
 * The order of what the owner sends into one thread or one channel, as the core takes it: a
 * prompt still reading its files, a stop, a `!next` offer's Send and a typed message each take
 * their place in line when the provider hands them over, whatever each takes to finish. The
 * plain agent and the memory chat; a prompt that reads its files slowly stands in for a check
 * that takes longer for one message than for the one sent after it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadRef } from "../../../src/chat/seam.ts";
import * as texts from "../../../src/core/texts.ts";
import { AsyncEvent } from "../../support/fake-clock.ts";
import { PlainAgent, say, suggest } from "../../support/plain-agent.ts";
import { MessagesWorld } from "./messages-world.ts";

const LIMIT = { timeout: 8000 };
const GUESS = "run the tests";

/** A prompt whose files are still being read: `done` lets `content()` return. */
function slowPrompt(text: string, done: AsyncEvent) {
  return {
    content: async () => {
      await done.wait();
      return text;
    },
  };
}

const notSent = (lines: readonly string[]) =>
  lines.filter((line) => line === texts.NOT_SENT).length;

test(
  "a stop typed right after a prompt drops the prompt and posts no Nothing is running",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t);
    const ref = await world.opened();
    const done = new AsyncEvent();
    const sending = world.send({ ref, id: "m-2", text: "second", ...slowPrompt("second", done) });
    await world.settle();
    await world.says("!stop", ref.thread); // handed over after the prompt, while it still reads
    done.set();
    await sending;
    await world.settle();
    // The prompt is not sent, by its ticket (`Not sent.`) or by the session's own stop.
    assert.deepEqual(await world.prompts(), ["first"]);
    assert.equal(notSent(world.shown(ref)), 1);
    assert.ok(!world.shown(ref).includes(texts.NOTHING_TO_STOP_THREAD));
    // Handed over the other way round, the prompt goes: the order is what the stop acts on.
    (world.agent as PlainAgent).next(say("fine"));
    await world.says("third", ref.thread);
    assert.deepEqual(await world.prompts(), ["first", "third"]);
  },
);

test(
  "a top-level stop is handed over after a thread's message sent before it",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t);
    const ref = await world.opened();
    const done = new AsyncEvent();
    const sending = world.send({ ref, id: "m-2", text: "second", ...slowPrompt("second", done) });
    await world.settle();
    await world.says("!stop"); // the channel's own stop, handed over after the thread's prompt
    done.set();
    await sending;
    await world.settle();
    assert.deepEqual(await world.prompts(), ["first"]);
    assert.equal(notSent(world.shown(ref)), 1);
    assert.ok(!world.inChannel().includes(texts.NOTHING_TO_STOP));
  },
);

test(
  "a top-level stop is still handed over after a prompt of a new thread that answers last",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t);
    // The first message of a new thread, whose files are read after the stop was handed over.
    const ref = world.chat.openThread(world.channel, "a new prompt");
    const done = new AsyncEvent();
    const sending = world.send({
      ref,
      id: "m-new",
      topLevel: true,
      text: "a new prompt",
      ...slowPrompt("a new prompt", done),
    });
    await world.settle();
    await world.says("!stop");
    done.set();
    await sending;
    await world.settle();
    assert.deepEqual(await world.prompts(), []);
    assert.equal(notSent(world.shown(ref)), 1);
    assert.equal(world.chat.requests().length, 0, "no setup is asked for the dropped prompt");
  },
);

/** A thread whose first turn ended with the agent's guess `GUESS`, and the offer of it. */
async function offered(t: Parameters<typeof MessagesWorld.make>[0]) {
  const agent = new PlainAgent({ suggestions: true });
  const world = await MessagesWorld.make(t, { agent, lists: true });
  agent.next(say("done"), suggest(GUESS));
  const ref = await world.opened("add the feature");
  await world.says("!next", ref.thread);
  await world.settle();
  const offer = world.chat.threadLists().findLast((list) => list.ref.thread === ref.thread);
  assert.ok(offer?.list.type === "suggestion", "an offer is open in the thread");
  const { list } = offer;
  /** The click of Send as the offer carries it, handed straight to the core. */
  const sends = (at: ThreadRef = ref) =>
    world.inbound.picked({
      type: "suggestion",
      ref: at,
      session: list.session,
      id: list.id,
      send: true,
      list: offer.message,
    });
  return { world, agent, ref, sends };
}

test(
  "a message typed before Send is handed over first, and Send then finds the suggestion gone",
  LIMIT,
  async (t) => {
    const { world, agent, ref, sends } = await offered(t);
    agent.next(say("on it"));
    const done = new AsyncEvent();
    const typing = world.send({
      ref,
      id: "m-typed",
      text: "typed first",
      ...slowPrompt("typed first", done),
    });
    await world.settle();
    const picking = sends(); // handed over while the typed message still reads
    await world.settle();
    done.set();
    await Promise.all([typing, picking]);
    await world.settle();
    assert.deepEqual(await world.prompts(), ["add the feature", "typed first"]);
    assert.ok(world.shown(ref).includes(texts.NEXT_NOT_SENT), world.shown(ref).join("|"));
  },
);

test("Send clicked before a message is typed is handed over first", LIMIT, async (t) => {
  const { world, agent, ref, sends } = await offered(t);
  agent.next(say("tests pass"), say("and more"));
  const picking = sends();
  const typing = world.says("typed after", ref.thread);
  await Promise.all([picking, typing]);
  await world.settle();
  assert.deepEqual(await world.prompts(), ["add the feature", GUESS, "typed after"]);
});
