/**
 * `InboundMessage.handled`: the core says once that it is done with a message. `ChatInbound.message`
 * resolves earlier (measured on 2026-11-17: when the prompt reached the agent, with its turn still
 * held), so the chat that must say a prompt is done reads this instead.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Turn } from "../../src/core/sessions/turn.ts";
import { hold, say } from "../support/plain-agent.ts";
import { World } from "./world.ts";

test("a prompt is handled when its turn ends, a queued one when its own turn ends, a word at once", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(say("Working"), hold(), say("two"));
  const events: string[] = [];
  const mark = (name: string) => () => events.push(name);
  const opening = world.owner.says(world.channel, "first", { handled: mark("first") });
  const setup = await world.request("setup", undefined, new Set());
  await world.owner.answers(setup.requestId, {
    type: "setup",
    selection: { model: "default", effort: "full", bypass: false },
  });
  await opening;
  const thread = setup.ref.thread;
  await world.settle();
  assert.deepEqual(events, [], "message() has resolved and the turn is held: not handled");
  await world.owner.says(world.channel, "!status", { thread, handled: mark("word") });
  await world.settle();
  assert.deepEqual(events, ["word"], "a word is handled once it is answered");
  await world.owner.says(world.channel, "second", { thread, handled: mark("second") });
  await world.settle();
  assert.deepEqual(events, ["word"], "a prompt queued behind a held turn waits for its own");
  world.plain.running[0]?.release();
  await world.until(() => events.length === 3, "both turns ended");
  assert.deepEqual(events, ["word", "first", "second"]);
  await world.finish();
});

test("a reply is opened for the owner's message its turn answers, a `!!command` included", async (t) => {
  const world = World.make(t, { shell: true });
  await world.start();
  const opened: (string | undefined)[] = [];
  const provider = world.chat.provider;
  const real = provider.thread.bind(provider);
  provider.thread = (ref) => {
    const thread = real(ref);
    const open = thread.openReply.bind(thread);
    thread.openReply = (change, prompt) => {
      opened.push(prompt);
      return open(change, prompt);
    };
    return thread;
  };
  world.script(say("one"));
  const thread = await world.open("first");
  await world.ended(thread);
  const sending = world.owner.says(world.channel, "!!echo hi", { thread });
  const asked = await world.request("shell", thread);
  world.script(say("two"));
  await world.owner.answers(asked.requestId, { type: "shell", run: true });
  const second = await sending;
  await world.ended(thread, 2);
  assert.equal(opened.length, 2);
  assert.ok(opened[0] !== undefined && opened[0].length > 0);
  assert.equal(opened[1], second.id);
  await world.finish();
});

test("a turn keeps the message its reply is for, so a reply opened again has it; a `!!command` turn has its own", () => {
  const sink = {} as never;
  assert.equal(new Turn("p", sink, null, null, "m-1").replyFor, "m-1");
  assert.equal(new Turn("!!ls", sink, "ls", null, null, "m-2").replyFor, "m-2");
  assert.equal(new Turn("p", sink).replyFor, null);
});
