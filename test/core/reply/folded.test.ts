/**
 * How finished calls read in a folded line (`Previews.folded`), over the vocabulary of an agent
 * that is not Claude: the plain agent names its tools `run` and `change` and declares the words
 * of a finished run. The card a chat draws from them is the chat's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Previews } from "../../../src/core/reply/previews.ts";
import { PLAIN_TOOLS } from "../../support/plain-agent.ts";

const PLAIN = new Previews(PLAIN_TOOLS);

test("finished calls of a tool fold into the words the agent declares, one and many", () => {
  assert.equal(PLAIN.folded("run", 1), "Executed 1 job");
  assert.equal(PLAIN.folded("run", 2), "Executed 2 jobs");
});

test("the words of a fold take a capital only when they open the line", () => {
  assert.equal(PLAIN.folded("run", 3, false), "executed 3 jobs");
});

test("a call of a tool the vocabulary does not name folds under its own name", () => {
  assert.equal(PLAIN.folded("Bash", 1), "Bash");
  assert.equal(PLAIN.folded("Bash", 3), "Bash ×3");
  assert.equal(PLAIN.folded("Bash", 3, false), "Bash ×3", "a name is its own: no case change");
});
