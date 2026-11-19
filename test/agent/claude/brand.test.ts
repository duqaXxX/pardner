/** The Claude module's brand words (invariant 6): a bot built on Claude Code may not carry its name. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WORDS } from "../../../src/agent/claude/backend.ts";

test("the module declares Claude Code as a name a bot may not carry", () => {
  assert.deepEqual(WORDS.brand, ["Claude Code"]);
});
