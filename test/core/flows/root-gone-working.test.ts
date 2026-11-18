/**
 * The first message of a thread is deleted while its session works: the thread is left to the
 * cleanup, no hold stays behind, and the daemon's log says so. What the chat draws when it
 * learns of the deletion (an index row, a tombstone) is the chat's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { logger } from "../../../src/core/flows/talk.ts";
import { hold, type PlainAgent } from "../../support/plain-agent.ts";
import { MessagesWorld } from "./messages-world.ts";

test("a root deleted while its session works stays for the cleanup, with no hold left behind", async (t) => {
  const lines: string[] = [];
  t.mock.method(logger, "info", (line: string) => lines.push(line));
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", ref.thread);
  await world.settle();
  await world.inbound.rootGone(ref);
  assert.notEqual(world.state.thread(ref.channel, ref.thread), null, "not forgotten live");
  assert.equal(world.sessions.held(ref.channel, ref.thread), false, "no hold left behind");
  assert.equal(world.sessions.get(ref.channel, ref.thread)?.busy, true, "the turn goes on");
  assert.ok(
    lines.some((line) => line.includes(`left ${ref.channel}/${ref.thread} to the cleanup`)),
    lines.join("\n"),
  );
  // The control: the same deletion of an idle thread forgets it, and the log says so.
  world.agentSession().release();
  await world.settle();
  await world.inbound.rootGone(ref);
  assert.equal(world.state.thread(ref.channel, ref.thread), null);
  assert.ok(lines.some((line) => line.includes(`forgot ${ref.channel}/${ref.thread}`)));
});
