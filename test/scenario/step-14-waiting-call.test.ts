/**
 * Step 14 of the scenario the memory chat carries (issue #73, step A2): a call that waits for the
 * owner's approval shows in the thread as waiting (`pending`, no timer), and runs on the timer
 * only once the owner has allowed it. The plain agent's `run` tool is the one the terminal times,
 * so its line carries a `startedAt`; its `delegate` tool starts an agent, which the renderer holds.
 *
 * What a line went through is read from the task writes the memory chat records, in order.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskUpdate } from "../../src/chat/seam.ts";
import { STOPPED } from "../../src/core/reply/words.ts";
import { call, say } from "../support/plain-agent.ts";
import { World } from "./world.ts";

/** Every write of a line of `tool`, in the order the chat took them. */
function writes(world: World, tool: string): TaskUpdate[] {
  return world.chat
    .calls("task")
    .map((recorded) => recorded.args[0] as TaskUpdate)
    .filter((update) => update.name === tool);
}

/** What each write of a line says of it: its status and its `startedAt`. */
function trace(world: World, tool = "run"): ReadonlyArray<readonly [string, number | null]> {
  return writes(world, tool).map((update) => [update.status, update.startedAt] as const);
}

/** Whether the message of the reply stands above the message of the request in the thread. */
function lineAboveCard(world: World, thread: string): boolean {
  const kinds = world.chat.messages(world.channel, thread).map((m) => m.kind);
  const reply = kinds.indexOf("reply");
  const card = kinds.indexOf("request");
  return reply !== -1 && card !== -1 && reply < card;
}

const DEPLOY = call("run", { line: "make deploy" }, { permission: true, output: "deployed" });

test("O1: the line waits as pending above the request, then runs on its timer from the approval", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(say("Deploying."), DEPLOY, say("Done."));
  const thread = await world.open("deploy");
  const asked = await world.request("permission", thread);

  // The request is on screen: the line is already there, waiting, and the card comes after it.
  assert.deepEqual(trace(world), [["pending", null]]);
  assert.ok(lineAboveCard(world, thread), "the line's message stands above the request");

  await world.clock.advance(30);
  const approved = world.clock.time();
  await world.owner.answers(asked.requestId, { type: "permission", allow: true });
  await world.ended(thread);

  assert.deepEqual(trace(world), [
    ["pending", null],
    ["in_progress", approved],
    ["complete", approved],
  ]);
  await world.finish();
});

test("O1 after the line: a request that comes once the line is written turns it pending, then in progress from the approval", async (t) => {
  const world = World.make(t);
  await world.start();
  let written: () => void = () => undefined;
  const afterLine = new Promise<void>((resolve) => {
    written = resolve;
  });
  world.script(
    say("Deploying."),
    call("run", { line: "make deploy" }, { permission: true, asksAfter: afterLine }),
    say("Done."),
  );
  const thread = await world.open("deploy");
  // The agent holds its request until the core has written the line, as the Claude back end does.
  await world.until(() => writes(world, "run").length > 0, "the line written");
  const began = world.clock.time();
  assert.deepEqual(trace(world), [["in_progress", began]]);
  written();
  const asked = await world.request("permission", thread);

  // The request is on screen: the running line turned waiting first, and the card follows it.
  assert.deepEqual(trace(world), [
    ["in_progress", began],
    ["pending", null],
  ]);
  assert.ok(lineAboveCard(world, thread), "the line's message stands above the request");

  await world.clock.advance(30);
  const approved = world.clock.time();
  await world.owner.answers(asked.requestId, { type: "permission", allow: true });
  await world.ended(thread);

  assert.deepEqual(trace(world).slice(1), [
    ["pending", null],
    ["in_progress", approved],
    ["complete", approved],
  ]);
  await world.finish();
});

test("O2: with a chat whose writes lag, the line's first write is still pending and the card follows it", async (t) => {
  const world = World.make(t, { writeDelay: 50 });
  await world.start();
  world.script(say("Deploying now."), DEPLOY, say("Done."));
  const thread = await world.open("deploy");
  const asked = await world.request("permission", thread);

  assert.deepEqual(trace(world), [["pending", null]]);
  assert.ok(lineAboveCard(world, thread), "the line's message stands above the request");

  await world.clock.advance(30);
  const approved = world.clock.time();
  await world.owner.answers(asked.requestId, { type: "permission", allow: true });
  await world.ended(thread);

  assert.deepEqual(trace(world), [
    ["pending", null],
    ["in_progress", approved],
    ["complete", approved],
  ]);
  await world.finish();
});

test("O3: the line is in progress, from the approval, before the agent has the decision", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(say("Deploying."), DEPLOY, say("Done."));
  const thread = await world.open("deploy");

  // What the chat had taken of the line at the moment the agent got the owner's answer.
  const session = world.plain.sessions.at(-1);
  assert.ok(session !== undefined, "the agent has a session");
  let atDecision: ReadonlyArray<readonly [string, number | null]> | null = null;
  const push = session.answers.push.bind(session.answers);
  session.answers.push = (...items) => {
    atDecision ??= trace(world);
    return push(...items);
  };

  const asked = await world.request("permission", thread);
  await world.clock.advance(30);
  const approved = world.clock.time();
  await world.owner.answers(asked.requestId, { type: "permission", allow: true });
  await world.ended(thread);

  assert.deepEqual(atDecision, [
    ["pending", null],
    ["in_progress", approved],
  ]);
  await world.finish();
});

test("O4: a request that names no call is shown at once and changes no line", async (t) => {
  const world = World.make(t, { writeDelay: 50 });
  await world.start();
  world.script(
    say("Deploying now."),
    call("run", { line: "make deploy" }, { permission: true, unnamed: true, output: "deployed" }),
  );
  const thread = await world.open("deploy");
  const asked = await world.request("permission", thread);
  await world.owner.answers(asked.requestId, { type: "permission", allow: true });
  await world.ended(thread);

  assert.ok(
    trace(world).every(([status]) => status !== "pending"),
    `a line was marked: ${JSON.stringify(trace(world))}`,
  );
  await world.finish();
});

test("O4: a call that starts an agent and asks is not drawn by the request", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(
    say("Delegating."),
    call("delegate", { prompt: "look around" }, { permission: true, output: "done" }),
  );
  const thread = await world.open("delegate");
  const asked = await world.request("permission", thread);
  assert.deepEqual(trace(world, "delegate"), []);
  await world.owner.answers(asked.requestId, { type: "permission", allow: true });
  await world.ended(thread);

  assert.ok(
    trace(world, "delegate").every(([status]) => status !== "pending"),
    `a held line was drawn pending: ${JSON.stringify(trace(world, "delegate"))}`,
  );
  await world.finish();
});

test("O5: a denied call goes from pending to error and never has a timer", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(say("Deploying."), DEPLOY, say("Kept."));
  const thread = await world.open("deploy");
  const asked = await world.request("permission", thread);
  await world.owner.answers(asked.requestId, { type: "permission", allow: false });
  await world.ended(thread);

  assert.deepEqual(trace(world), [
    ["pending", null],
    ["error", null],
  ]);
  await world.finish();
});

test("O6: the owner's /stop while the call waits ends the line as an error reading Stopped", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(say("Deploying."), DEPLOY, say("Done."));
  const thread = await world.open("deploy");
  await world.request("permission", thread);

  await world.owner.says(world.channel, "/stop", { thread });
  await world.ended(thread);

  assert.deepEqual(trace(world), [
    ["pending", null],
    ["error", null],
  ]);
  assert.equal(writes(world, "run").at(-1)?.output, STOPPED);
  assert.deepEqual(world.chat.requests(), []);
  await world.finish();
});
