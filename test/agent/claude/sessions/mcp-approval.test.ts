/**
 * The card that asks the owner about a call to an MCP tool is titled as the terminal titles the
 * call: `<server's name> - <tool> (MCP)`. The server's name is in the `init` record of
 * `read-image` (Claude Code 2.1.330, TypeScript SDK 0.3.330); the tool's own name carries it
 * normalized.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryHarnessFor, requestWhileStreaming, sdkMessages } from "../../../support/sessions.ts";
import { pending } from "./helpers.ts";

/** The index of the init record of `read-image` that lists the servers. */
const INIT = 5;

/** The title of the one approval a request for `tool` opens, after the recorded init. */
async function titleOf(t: Parameters<typeof memoryHarnessFor>[0], tool: string): Promise<string> {
  const init = sdkMessages("read-image")[INIT];
  assert.ok(init !== undefined);
  const h = memoryHarnessFor(t)({
    turns: [[init, requestWhileStreaming(tool, { query: "guide" }, "toolu_mcp")]],
  });
  const session = h.session();
  await session.submit("look it up");
  await h.until(() => pending(h.approvals).length === 1);
  const title = h.approvals.get(pending(h.approvals)[0] ?? "")?.title;
  assert.ok(title !== undefined);
  return title;
}

test("the approval for an MCP tool's call is titled by the server's name and the tool", async (t) => {
  assert.equal(
    await titleOf(t, "mcp__claude_ai_Example_Docs__batch"),
    "claude.ai Example Docs - batch (MCP): guide",
  );
});

test("the approval for a tool that is no MCP tool's keeps the tool's name", async (t) => {
  assert.equal(await titleOf(t, "Bash"), "Bash: guide");
});
