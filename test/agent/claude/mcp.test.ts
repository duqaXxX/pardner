/**
 * The terminal's words for a call to an MCP tool, from the tool's name and the session's servers.
 * The recorded servers are in `translate.test.ts`; the cases here are the names it has none for.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpVerb } from "../../../src/agent/claude/mcp.ts";

test("of two servers that start a tool's name, the longer normalized prefix names the server", () => {
  // `claude.ai A!!!!!!!!!!!!!` is the longer name as written but normalizes to `claude_ai_A`,
  // the shorter prefix: the tool's name belongs to the other server.
  assert.equal(
    mcpVerb("mcp__claude_ai_A__x__go", ["claude.ai A!!!!!!!!!!!!!", "claude_ai_A__x"]),
    "claude_ai_A__x - go (MCP)",
  );
  assert.equal(
    mcpVerb("mcp__claude_ai_A__x__go", ["claude_ai_A__x", "claude.ai A!!!!!!!!!!!!!"]),
    "claude_ai_A__x - go (MCP)",
  );
});

test("a server named `a` and one named `a__b` both start a tool of `a__b__c`", () => {
  assert.equal(mcpVerb("mcp__a__b__c", ["a", "a__b"]), "a__b - c (MCP)");
  assert.equal(mcpVerb("mcp__a__b__c", ["a__b", "a"]), "a__b - c (MCP)");
});
