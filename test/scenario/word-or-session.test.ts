/**
 * #68: whether the prompt's thread holds a session is told to the chat (`InboundMessage.handled`),
 * and a line that answers a top-level prompt names it (`ChannelChat.notice` and `say`, the
 * memory chat's `calls("answers")`), so that the app draws a word under its prompt and never as a session.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as texts from "../../src/core/texts.ts";
import { fill } from "../../src/core/texts.ts";
import { say } from "../support/plain-agent.ts";
import { World } from "./world.ts";

/** What a test records of `handled`, and the lines of the channel that answered a prompt. */
function watch(world: World) {
  const verdicts: boolean[] = [];
  return {
    handled: (session: boolean) => verdicts.push(session),
    verdicts,
    answers: () => world.chat.calls("answers").map((call) => call.args),
  };
}

test("a word with a channel line: the line names the prompt, and the answer says no session", async (t) => {
  const world = World.make(t);
  await world.start();
  const seen = watch(world);
  const sent = await world.owner.says(world.channel, "/bypass on", { handled: seen.handled });
  await world.settle();
  assert.deepEqual(seen.verdicts, [false]);
  assert.deepEqual(seen.answers(), [["notice", texts.BYPASS_TOP_LEVEL, sent.id]]);
  await world.finish();
});

test("a word with a reference: `/help` at the top names its prompt", async (t) => {
  const world = World.make(t);
  await world.start();
  const seen = watch(world);
  const sent = await world.owner.says(world.channel, "/help", { handled: seen.handled });
  await world.settle();
  assert.deepEqual(seen.verdicts, [false]);
  const [only] = seen.answers();
  assert.equal(only?.[0], "say");
  assert.equal(only?.[2], sent.id);
  await world.finish();
});

test("a word with one line: `/stop` with nothing to stop answers under its prompt", async (t) => {
  const world = World.make(t);
  await world.start();
  const seen = watch(world);
  const sent = await world.owner.says(world.channel, "/stop", { handled: seen.handled });
  await world.settle();
  assert.deepEqual(seen.verdicts, [false]);
  assert.deepEqual(seen.answers(), [["notice", texts.NOTHING_TO_STOP, sent.id]]);
  await world.finish();
});

test("a word with no line: `/bind` alone offers folders through the chat and writes none", async (t) => {
  const world = World.make(t);
  await world.start();
  const seen = watch(world);
  await world.owner.says(world.channel, "/bind", { handled: seen.handled });
  await world.settle();
  assert.deepEqual(seen.verdicts, [false]);
  assert.deepEqual(seen.answers(), []);
  await world.finish();
});

test("a refusal of a word names the prompt it answers", async (t) => {
  const world = World.make(t);
  await world.start();
  const seen = watch(world);
  const sent = await world.owner.says(world.channel, "/resume nothing-like-it", {
    handled: seen.handled,
  });
  await world.settle();
  assert.deepEqual(seen.verdicts, [false]);
  assert.equal(seen.answers().length, 1);
  assert.equal(seen.answers()[0]?.[2], sent.id);
  await world.finish();
});

test("a word typed in a session's thread is no top-level answer: nothing names a prompt", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(say("Hello."));
  const thread = await world.open("first");
  await world.ended(thread);
  const seen = watch(world);
  await world.owner.says(world.channel, "/status", { thread, handled: seen.handled });
  await world.settle();
  assert.deepEqual(seen.verdicts, [true]);
  assert.deepEqual(seen.answers(), []);
  // A reference in a session's thread (`say` with a thread) names no prompt either.
  await world.owner.says(world.channel, "/help", { thread, handled: seen.handled });
  await world.settle();
  assert.deepEqual(seen.answers(), []);
  await world.finish();
});

test("a prompt that runs a turn is handled as a session, and its lines name nothing", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(say("Working"));
  const seen = watch(world);
  const opening = world.owner.says(world.channel, "first", { handled: seen.handled });
  const setup = await world.request("setup", undefined, new Set());
  await world.owner.answers(setup.requestId, {
    type: "setup",
    selection: { model: "default", effort: "full", bypass: false },
  });
  await opening;
  await world.until(() => seen.verdicts.length === 1, "the turn ended");
  assert.deepEqual(seen.verdicts, [true]);
  assert.deepEqual(seen.answers(), []);
  await world.finish();
});

test("`/resume <id>` at the top resumes a session in the prompt's thread: handled as a session", async (t) => {
  const world = World.make(t);
  await world.start();
  world.store.remember(world.folder, "plain-old", "An older talk", 1_000_000_000);
  const seen = watch(world);
  const sent = await world.owner.says(world.channel, "/resume plain-old", {
    handled: seen.handled,
  });
  await world.settle();
  assert.deepEqual(seen.verdicts, [true]);
  assert.deepEqual(world.shown(sent.ref.thread), [
    "/resume plain-old",
    fill(texts.RESUME_OK, { title: "An older talk" }),
  ]);
  assert.deepEqual(seen.answers(), []);
  await world.finish();
});
