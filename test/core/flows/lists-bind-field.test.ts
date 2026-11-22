/**
 * The `bind` of a `/bind` answer (#69): the channel's folder as stored when the reply is written,
 * and whether a session can start in it. The memory chat records it as `calls("bind")`.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { ListsWorld } from "./lists-world.ts";
import { WithFolderTrust } from "./messages-world.ts";

const sent = (world: ListsWorld) => world.chat.calls("bind").map((call) => call.args[1]);

test("a bind answers with the folder it stored and says it is usable", async (t) => {
  const world = await ListsWorld.build(t);
  await world.flows.bind.to(world.channel, world.app);
  assert.deepEqual(sent(world), [{ folder: world.app, state: "usable" }]);
});

test("a bind in a folder the agent does not trust says untrusted", async (t) => {
  const agent = new WithFolderTrust();
  agent.folderTrusted = async () => false;
  const world = await ListsWorld.build(t, agent);
  await world.flows.bind.to(world.channel, world.app);
  assert.deepEqual(sent(world), [{ folder: world.app, state: "untrusted" }]);
});

test("a refusal over a stored folder names that folder with a state checked again", async (t) => {
  const world = await ListsWorld.build(t);
  await world.bound(world.app);
  await world.flows.bind.to(world.channel, "/");
  rmSync(world.app, { recursive: true });
  await world.flows.bind.to(world.channel, "../..");
  assert.deepEqual(sent(world), [
    { folder: world.app, state: "usable" },
    { folder: world.app, state: "missing" },
  ]);
});

test("a pick of the folder already bound answers with it", async (t) => {
  const world = await ListsWorld.build(t);
  await world.bound(world.app);
  await world.flows.picks.picked({
    type: "folder",
    channel: world.channel,
    path: world.app,
    list: "list",
  });
  assert.deepEqual(sent(world), [{ folder: world.app, state: "usable" }]);
});

test("a refusal in a channel with no stored folder carries no bind", async (t) => {
  const world = await ListsWorld.build(t);
  await world.flows.bind.to(world.channel, "/");
  assert.equal(world.said().length, 1);
  assert.deepEqual(sent(world), []);
});

test("a bare /bind carries no bind", async (t) => {
  const world = await ListsWorld.build(t, undefined);
  await world.bound(world.app);
  await world.flows.bind.list(world.channel);
  assert.deepEqual(sent(world), []);
});

test("two binds in flight end with the stored folder in the last reply", async (t) => {
  const world = await ListsWorld.build(t);
  // The check of the first folder is slow; the second bind runs through meanwhile.
  let release!: () => void;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const check = world.sessions.unavailable.bind(world.sessions);
  world.sessions.unavailable = async (directory) => {
    if (directory === world.app) await slow;
    return check(directory);
  };
  const first = world.flows.bind.to(world.channel, world.app);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await world.flows.bind.to(world.channel, world.docs);
  // The second folder goes away before the first reply: its state is read again, not carried over.
  rmSync(world.docs, { recursive: true });
  release();
  await first;
  assert.equal(world.state.channel(world.channel)?.directory, world.docs);
  assert.deepEqual(sent(world).at(-1), { folder: world.docs, state: "missing" });
});

test("a check of the stored folder that fails still sends the refusal, with no bind", async (t) => {
  const world = await ListsWorld.build(t);
  await world.bound(world.app);
  world.sessions.unavailable = async () => {
    throw new Error("disk gone");
  };
  await world.flows.bind.to(world.channel, "/");
  assert.equal(world.said().length, 1);
  assert.deepEqual(sent(world), []);
});
