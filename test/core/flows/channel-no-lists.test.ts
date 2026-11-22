/**
 * A chat whose channel has no `offer` (the relay chat, until the app can draw a pick list): the
 * words that would post a list answer the prompt with a line that says what they need.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ID_PREFIX_MIN } from "../../../src/core/flows/resume.ts";
import * as texts from "../../../src/core/texts.ts";
import { FakeUpdatesHost } from "../../support/updates.ts";
import { MessagesWorld, PLAIN_NAMES, WithFolderTrust } from "./messages-world.ts";

const { fill } = texts;
const LIMIT = { timeout: 8000 };

/** The lines that answered a prompt: the call, the text and the prompt it names. */
const answered = (world: MessagesWorld) => world.chat.calls("answers").map((call) => call.args);

test("`/bind` alone says what it needs, under its prompt, and posts no list", LIMIT, async (t) => {
  const world = await MessagesWorld.make(t, { noChannelLists: true });
  const prompt = await world.says("/bind");
  const line = fill(texts.BIND_NO_LIST, { root: world.folder });
  assert.equal(world.inChannel().at(-1), line);
  assert.deepEqual(answered(world), [["notice", line, prompt.id]]);
  assert.equal(world.chat.lists().length, 0);
});

test("`/resume` alone says what it needs, under its prompt", LIMIT, async (t) => {
  const world = await MessagesWorld.make(t, { noChannelLists: true });
  await world.sessions.bind(world.channel, world.folder);
  const prompt = await world.says("/resume");
  const line = fill(texts.RESUME_NO_LIST, { min: String(ID_PREFIX_MIN) });
  assert.equal(world.inChannel().at(-1), line);
  assert.deepEqual(answered(world), [["notice", line, prompt.id]]);
  assert.equal(world.chat.lists().length, 0);
});

test("`/pardner update` with a newer version says the command to run", LIMIT, async (t) => {
  const world = await MessagesWorld.make(t, { host: new FakeUpdatesHost(), noChannelLists: true });
  const prompt = await world.says("/pardner update");
  const updates = world.updates;
  assert.ok(updates?.newer, "a newer version is known");
  const line = fill(texts.UPDATE_NO_LIST, {
    installed: updates.installed,
    latest: updates.newer,
  });
  assert.equal(world.inChannel().at(-1), line);
  assert.deepEqual(answered(world), [["notice", line, prompt.id]]);
  assert.equal(world.chat.lists().length, 0);
});

test(
  "`/bind` alone adds the trust sentence for an agent that keeps a record of trust",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t, {
      agent: new WithFolderTrust(),
      noChannelLists: true,
    });
    await world.says("/bind");
    const line = fill(texts.BIND_NO_LIST, { root: world.folder });
    assert.equal(
      world.inChannel().at(-1),
      `${line} ${texts.named(texts.BIND_NO_LIST_TRUST, PLAIN_NAMES)}`,
    );
  },
);

test("`/resume` alone reads no session file when it cannot offer them", LIMIT, async (t) => {
  const world = await MessagesWorld.make(t, { noChannelLists: true });
  await world.sessions.bind(world.channel, world.folder);
  let reads = 0;
  const read = world.sessions.sessionsIn.bind(world.sessions);
  world.sessions.sessionsIn = async (directory) => {
    reads += 1;
    return read(directory);
  };
  await world.says("/resume");
  assert.equal(reads, 0);
});

test(
  "`/resume <name>` that matches nothing does not send the owner to a list",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t, { noChannelLists: true });
    await world.sessions.bind(world.channel, world.folder);
    await world.says("/resume nothing-by-this-name");
    const line = fill(texts.RESUME_NONE_NO_LIST, {
      directory: world.folder,
      target: "nothing-by-this-name",
    });
    assert.equal(world.inChannel().at(-1), line);
    assert.ok(!line.includes("`/resume`"));
  },
);

test(
  "an unsupervised copy still gets the line, and the version lines name no chat command",
  LIMIT,
  async (t) => {
    const host = new FakeUpdatesHost();
    host.service = false;
    const world = await MessagesWorld.make(t, { host, noChannelLists: true });
    await world.says("/pardner update");
    const updates = world.updates;
    assert.ok(updates?.newer);
    const args = { installed: updates.installed, latest: updates.newer };
    assert.equal(world.inChannel().at(-1), fill(texts.UPDATE_NO_LIST, args));
    await world.says("/pardner");
    assert.ok(world.inChannel().at(-1)?.includes("`pardner update` in a terminal"));
    assert.ok(!(world.inChannel().at(-1) ?? "").includes("update and restart from"));
  },
);

test("a chat with channel lists still gets the list", LIMIT, async (t) => {
  const world = await MessagesWorld.make(t);
  await world.says("/bind");
  assert.equal(world.chat.lists().length, 1);
});
