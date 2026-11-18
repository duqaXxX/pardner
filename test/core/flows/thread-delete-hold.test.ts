/**
 * What the core does for a chat that deletes a thread (`SessionsPort.release` and `free`): an
 * idle thread is held, so that its session is closed and a message written meanwhile is told the
 * thread holds no session; a thread in use, or one already held, is refused with no hold taken,
 * so that the delete that was refused never ends another's. The deleter's own work, message by
 * message, is the chat's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as texts from "../../../src/core/texts.ts";
import { hold, type PlainAgent } from "../../support/plain-agent.ts";
import { MessagesWorld } from "./messages-world.ts";

test("a thread in use is not held for a delete, and its turn goes on", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", ref.thread);
  await world.settle();
  assert.equal(world.sessions.get(ref.channel, ref.thread)?.busy, true);
  assert.equal(await world.sessions.release(ref.channel, ref.thread), false);
  assert.equal(
    world.sessions.held(ref.channel, ref.thread),
    false,
    "a refused release took no hold",
  );
  assert.equal(world.sessions.get(ref.channel, ref.thread)?.busy, true, "the turn is not cut");
  assert.notEqual(world.state.thread(ref.channel, ref.thread), null);
});

test("an idle thread is held, its session closed, and a message written meanwhile is told it holds none", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  assert.notEqual(
    world.sessions.get(ref.channel, ref.thread),
    null,
    "the control: it has a session",
  );
  assert.equal(await world.sessions.release(ref.channel, ref.thread), true);
  assert.equal(world.sessions.held(ref.channel, ref.thread), true);
  assert.equal(world.sessions.get(ref.channel, ref.thread), null);
  assert.equal((world.agent as PlainAgent).sessions[0]?.closed, true, "the process is closed");
  assert.notEqual(
    world.state.thread(ref.channel, ref.thread),
    null,
    "the entry stays for the delete",
  );
  await world.says("hello again", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.NOT_A_SESSION);
  assert.deepEqual(await world.prompts(), ["first"], "nothing was sent");
});

test("a second release of a thread already held takes nothing, and free ends the hold", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  assert.equal(await world.sessions.release(ref.channel, ref.thread), true);
  assert.equal(await world.sessions.release(ref.channel, ref.thread), false);
  assert.equal(world.sessions.held(ref.channel, ref.thread), true, "the refused one ended nothing");
  world.sessions.free(ref.channel, ref.thread);
  assert.equal(world.sessions.held(ref.channel, ref.thread), false);
  // The delete failed and left the thread: the owner's next message resumes its session.
  await world.says("go on", ref.thread);
  assert.deepEqual((await world.prompts()).slice(-1), ["go on"]);
});

test("a thread the daemon keeps no session for is held and freed as any other", async (t) => {
  // An orphan: a root a purge finds in the channel, which no entry of state.json names.
  const world = await MessagesWorld.make(t);
  const orphan = world.chat.openThread(world.channel);
  assert.equal(await world.sessions.release(orphan.channel, orphan.thread), true);
  assert.equal(world.sessions.held(orphan.channel, orphan.thread), true);
  world.sessions.free(orphan.channel, orphan.thread);
  assert.equal(world.sessions.held(orphan.channel, orphan.thread), false);
});

test("no thread is held once a stop closed the sessions", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.sessions.closeAll();
  assert.equal(await world.sessions.release(ref.channel, ref.thread), false);
  assert.equal(world.sessions.held(ref.channel, ref.thread), false);
});
