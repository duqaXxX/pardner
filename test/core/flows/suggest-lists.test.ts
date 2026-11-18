/**
 * What a chat that suggests commands is handed for `!` alone: every command, the daemon's words
 * first and the session's after, each once. The field, its menu and its groups of a hundred are
 * the chat's drawing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WORD } from "../../../src/core/commands.ts";
import { PLAIN_COMMANDS } from "../../support/plain-agent.ts";
import { MessagesWorld } from "./messages-world.ts";

test("! alone lists the words of the daemon, then the session's commands, each once", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const ref = await world.opened();
  await world.says("!", ref.thread);
  await world.settle();
  const [shown] = world.chat.suggestions();
  assert.ok(shown);
  const { candidates } = shown.suggestion;
  const names = candidates.map((candidate) => candidate.name);
  for (const word of [WORD.guide, WORD.help, WORD.status, WORD.stop]) {
    assert.ok(names.includes(word), word);
  }
  assert.equal(new Set(names).size, names.length, "each word once");
  const groups = candidates.map((candidate) => candidate.group);
  assert.equal(groups.indexOf("agent"), groups.lastIndexOf("daemon") + 1, "the daemon's first");
  assert.equal(
    candidates.filter((candidate) => candidate.group === "agent").length,
    PLAIN_COMMANDS.length,
  );
});
