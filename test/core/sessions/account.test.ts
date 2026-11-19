/**
 * The agent's account reaches the chat when a session connects (`ChatProvider.agentAccount`), as
 * the agent reports it: a chat that shows its bot's account takes it from there.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PlainAgent } from "../../support/plain-agent.ts";
import { MessagesWorld } from "../flows/messages-world.ts";

const ACCOUNT = { name: "alice@example.com", plan: "Pro" };

test("a session that connects hands the chat the account its agent reports", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new PlainAgent({ account: ACCOUNT }) });
  const ref = await world.opened();
  await world.says("hello", ref.thread);
  await world.settle();
  assert.ok(world.chat.accounts.length >= 1);
  assert.ok(world.chat.accounts.every((a) => a?.name === ACCOUNT.name && a.plan === ACCOUNT.plan));
});

test("an agent that does not say hands the chat null", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new PlainAgent() });
  const ref = await world.opened();
  await world.says("hello", ref.thread);
  await world.settle();
  assert.ok(world.chat.accounts.length >= 1);
  assert.ok(world.chat.accounts.every((a) => a === null));
});
