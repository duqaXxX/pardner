/**
 * How the terminal names a call to an MCP tool: `<server's name> - <tool> (MCP)` (measured on
 * Claude Code 2.1.332, 2026-11-27: `claude.ai Claude Docs - guide (MCP)`,
 * `plugin:context7-plugin:context7 - resolve-library-id (MCP)`). The call's own name carries the
 * server normalized, so the server's name comes from the `init` record's `mcp_servers`.
 */
import { DAEMON_SERVER } from "./daemon-tools.ts";

const PREFIX = "mcp__";
const SEPARATOR = "__";

/**
 * The SDK's own normalization of a server's name in a tool's name (`sdk.d.ts` 0.3.330, on
 * `SDKControlMcpCallRequest.tool`: "non-[a-zA-Z0-9_-] becomes _"; the bundled `sdk.mjs` also
 * collapses the runs of `_` and trims them for a `claude.ai ` server).
 */
function normalized(server: string): string {
  const name = server.replace(/[^a-zA-Z0-9_-]/g, "_");
  return server.startsWith("claude.ai ") ? name.replace(/_+/g, "_").replace(/^_|_$/g, "") : name;
}

/**
 * The terminal's words for a call to the tool `toolName`, given the names of the session's MCP
 * servers; null for a tool that is no MCP tool's, one with no server or no tool in its name, and
 * the daemon's own. A server `servers` does not list is named as its normalized name is written,
 * the tool by its name: the title a tool declares for itself (the terminal shows it in place of
 * the name) reaches the daemon in no documented field.
 */
export function mcpVerb(toolName: string, servers: readonly string[]): string | null {
  if (!toolName.startsWith(PREFIX)) return null;
  const rest = toolName.slice(PREFIX.length);
  let server: string | null = null;
  let tool = "";
  let matched = 0;
  for (const known of servers) {
    const head = `${normalized(known)}${SEPARATOR}`;
    // The longest match, by the prefix as the tool's name writes it: a server named `a` and one
    // named `a__b` both start a tool of `a__b__c`, and a long name may normalize to a short one.
    if (rest.length > head.length && rest.startsWith(head) && head.length > matched) {
      server = known;
      tool = rest.slice(head.length);
      matched = head.length;
    }
  }
  if (server === null) {
    const at = rest.indexOf(SEPARATOR);
    if (at <= 0 || at + SEPARATOR.length >= rest.length) return null;
    server = rest.slice(0, at);
    tool = rest.slice(at + SEPARATOR.length);
  }
  return server === DAEMON_SERVER ? null : `${server} - ${tool} (MCP)`;
}
