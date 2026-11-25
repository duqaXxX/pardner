/**
 * The images of a call's result (step E2 design 3.1), through the message flow with the plain agent
 * and the memory chat: the reply is handed them only by a chat that declares `lineImages`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { call, PlainAgent, say } from "../../support/plain-agent.ts";
import { MessagesWorld } from "./messages-world.ts";

const IMAGES = [{ mediaType: "image/png", data: Uint8Array.of(137, 80, 78, 71) }];

test("a call's image reaches the chat's reply once, after the call's end", async (t) => {
  const agent = new PlainAgent();
  const world = await MessagesWorld.make(t, { agent, images: true });
  agent.next(call("run", { command: "shot" }, { images: IMAGES }), say("done"));
  await world.opened("take a screenshot");
  await world.settle();
  const calls = world.chat.calls("image");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args[1], IMAGES);
});

test("a chat that declares no lineImages is handed none", async (t) => {
  const agent = new PlainAgent();
  const world = await MessagesWorld.make(t, { agent });
  agent.next(call("run", { command: "shot" }, { images: IMAGES }), say("done"));
  await world.opened("take a screenshot");
  await world.settle();
  assert.deepEqual(world.chat.calls("image"), []);
});
