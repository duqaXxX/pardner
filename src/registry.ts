/**
 * The agents the daemon can run, by the name `PARDNER_AGENT` selects them with, and its one chat.
 * The one file outside the modules that names them: `main` takes each module from here, and a test
 * passes its own registry through `run`'s options.
 */
import { claudeAgent } from "./agent/claude/module.ts";
import type { AgentEntry } from "./agent/seam.ts";
import { relayChat } from "./chat/relay/module.ts";
import type { ChatEntry } from "./core/port.ts";

export interface Registry {
  readonly agents: Readonly<Record<string, AgentEntry>>;
  readonly chat: ChatEntry;
  /** The agent taken when the owner's file does not set the variable that selects one. */
  readonly defaults: { readonly agent: string };
}

export const REGISTRY: Registry = {
  agents: { claude: claudeAgent() },
  chat: relayChat(),
  defaults: { agent: "claude" },
};
