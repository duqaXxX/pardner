/**
 * A scheduled run's line and the suggested next prompt (step E1 design 3.1 and 3.2), through the
 * message flow with the plain agent and the memory chat: the line is handed to the chat before the
 * run's reply, only by a chat that declares it and no loop card; the guess is handed to the chat
 * under the condition `/next` holds it under, and held for `/next` as before.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncEvent } from "../../support/fake-clock.ts";
import { hold, PlainAgent, say, scheduledRun, suggest } from "../../support/plain-agent.ts";
import { MessagesWorld } from "./messages-world.ts";

const LINE = /^Running scheduled task \(\d{4}-\d\d-\d\dT\d\d:\d\d UTC\)$/;
const GUESS = "run the tests";

test("a scheduled run's line is drawn before the run's reply", async (t) => {
  const agent = new PlainAgent({ scheduledJobs: true });
  const world = await MessagesWorld.make(t, { agent, runLines: true });
  agent.next(scheduledRun(), say("checked the build"));
  const ref = await world.opened("watch the build");
  const shown = world.shown(ref);
  const at = shown.findIndex((line) => LINE.test(line));
  assert.ok(at >= 0, shown.join("|"));
  assert.ok(shown.findIndex((line) => line.includes("checked the build")) > at);
});

test("a run said to start while a turn runs draws no line: the run is an ordinary reply", async (t) => {
  const agent = new PlainAgent({ scheduledJobs: true });
  const world = await MessagesWorld.make(t, { agent, runLines: true });
  agent.next(say("first words"), scheduledRun(), say("more words"));
  const ref = await world.opened("watch the build");
  assert.ok(!world.shown(ref).some((line) => LINE.test(line)), world.shown(ref).join("|"));
  assert.ok(world.shown(ref).join("\n").includes("more words"));
});

test("the line is dated by the core's clock, in epoch milliseconds", async (t) => {
  const agent = new PlainAgent({ scheduledJobs: true });
  const world = await MessagesWorld.make(t, { agent, runLines: true });
  const before = Date.now();
  agent.next(scheduledRun(), say("ok"));
  const ref = await world.opened("watch the build");
  const line = world.shown(ref).find((text) => LINE.test(text)) ?? "";
  const time = Date.parse(`${line.slice(line.indexOf("(") + 1, line.indexOf(" UTC"))}:00Z`);
  assert.ok(time >= Math.floor(before / 60_000) * 60_000 && time <= Date.now(), line);
});

test("a chat with the loop card draws no line: the card shows the run", async (t) => {
  const agent = new PlainAgent({ scheduledJobs: true });
  const world = await MessagesWorld.make(t, { agent, runLines: "with the card" });
  agent.next(scheduledRun(), say("checked"));
  const ref = await world.opened("watch the build");
  assert.ok(!world.shown(ref).some((line) => LINE.test(line)), world.shown(ref).join("|"));
});

test("a chat that declares no run line is told of none", async (t) => {
  const agent = new PlainAgent({ scheduledJobs: true });
  const world = await MessagesWorld.make(t, { agent });
  agent.next(scheduledRun(), say("checked"));
  const ref = await world.opened("watch the build");
  assert.ok(!world.shown(ref).some((line) => LINE.test(line)));
});

test("an agent with no scheduled jobs cannot say a run started", async (t) => {
  const agent = new PlainAgent();
  const world = await MessagesWorld.make(t, { agent, runLines: true });
  agent.next(scheduledRun(), say("checked"));
  const ref = await world.opened("watch the build");
  assert.ok(!world.shown(ref).some((line) => LINE.test(line)));
});

test("the guess is handed to the chat once the turn ended, and held for /next as before", async (t) => {
  const agent = new PlainAgent({ suggestions: true });
  const world = await MessagesWorld.make(t, { agent, hints: true, lists: true });
  agent.next(say("done"), suggest(GUESS));
  const ref = await world.opened("add the feature");
  await world.settle();
  assert.deepEqual(
    world.chat.calls("suggestNext").map((call) => call.args),
    [[GUESS]],
  );
  assert.equal(world.sessions.suggestions.held(ref)?.text, GUESS);
  assert.ok(!world.shown(ref).join("\n").includes(GUESS), "the chat shows nothing of its own");
});

test("a turn with no guess hands the chat none", async (t) => {
  const agent = new PlainAgent({ suggestions: true });
  const world = await MessagesWorld.make(t, { agent, hints: true });
  agent.next(say("done"));
  await world.opened("add the feature");
  await world.settle();
  assert.deepEqual(world.chat.calls("suggestNext"), []);
});

test("a chat that declares no hint is never offered the guess", async (t) => {
  const agent = new PlainAgent({ suggestions: true });
  const world = await MessagesWorld.make(t, { agent, lists: true });
  agent.next(say("done"), suggest(GUESS));
  const ref = await world.opened("add the feature");
  await world.settle();
  assert.deepEqual(world.chat.calls("suggestNext"), []);
  assert.equal(world.sessions.suggestions.held(ref)?.text, GUESS);
});

test("a guess that arrives while a prompt is owed is handed to nobody", async (t) => {
  const agent = new PlainAgent({ suggestions: true });
  const world = await MessagesWorld.make(t, { agent, hints: true, lists: true });
  agent.next(say("first answer"), hold(), suggest("too early"));
  const ref = await world.opened("first prompt");
  // Queued behind the turn that runs: owed its answer when the first turn ends.
  agent.next(say("second answer"));
  await world.says("second prompt", ref.thread);
  await world.settle();
  world.agentSession().release();
  await world.settle();
  assert.deepEqual(world.chat.calls("suggestNext"), []);
  assert.equal(world.sessions.suggestions.held(ref), null);
});

test("a guess is handed to the chat only when the core held it: none while a prompt is on its way", async (t) => {
  const agent = new PlainAgent({ suggestions: true });
  const world = await MessagesWorld.make(t, { agent, hints: true, lists: true });
  agent.next(say("first answer"), hold(), suggest("too early"));
  const ref = await world.opened("first prompt");
  // Handed over, its content still being read: no prompt is owed yet, but one is on its way.
  const read = new AsyncEvent();
  const typed = world.send({
    ref,
    id: "msg-typed",
    text: "with a file",
    content: async () => {
      await read.wait();
      return "with a file";
    },
  });
  await world.settle();
  world.agentSession().release();
  await world.settle();
  assert.deepEqual(world.chat.calls("suggestNext"), []);
  assert.equal(world.sessions.suggestions.held(ref), null);
  read.set();
  await typed;
  await world.settle();
});
