/**
 * A message in a channel bound to no folder is answered in the words of an agent that keeps a
 * record of trust (`UNBOUND`, which names the trust of folders) or of one that does not
 * (`UNBOUND_ANY`). A clip (a literal message) is answered the same way.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as texts from "../../../src/core/texts.ts";
import { fill, named } from "../../../src/core/texts.ts";
import { OWNER } from "../../support/memory-chat.ts";
import { MessagesWorld, PLAIN_NAMES, WithFolderTrust } from "./messages-world.ts";

test("an agent that keeps a record of trust says so in an unbound channel, for a word and for a clip", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithFolderTrust() });
  const free = world.chat.openChannel("free");
  const expected = fill(named(texts.UNBOUND, PLAIN_NAMES), { root: world.folder });
  assert.notEqual(
    expected,
    fill(texts.UNBOUND_ANY, { root: world.folder }),
    "the two wordings differ",
  );
  await world.chat.as(OWNER).says(free, "hello");
  assert.deepEqual(world.chat.texts(free).slice(1), [expected]);
  // A clip is a literal message: the same answer.
  const ref = world.chat.openThread(free);
  await world.send({ ref, id: ref.thread, topLevel: true, text: "heard", literal: true });
  assert.equal(world.chat.texts(free).filter((line) => line === expected).length, 2);
  assert.deepEqual(await world.prompts(), []);
});

test("an agent with no record of trust says it without the word of trust, as the control", async (t) => {
  const world = await MessagesWorld.make(t);
  const free = world.chat.openChannel("free");
  await world.inbound.unbound(free);
  assert.deepEqual(world.chat.texts(free), [fill(texts.UNBOUND_ANY, { root: world.folder })]);
});
