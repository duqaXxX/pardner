/**
 * The agent is selected by name and the chat is the registry's one, never constructed:
 * `src/daemon.ts` reads the agent's name from the configuration and takes each module from a
 * registry.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { type AgentEntry, NO_TOOL_WORDS } from "../src/agent/seam.ts";
import { ConfigError } from "../src/core/config.ts";
import type { ChatEntry } from "../src/core/port.ts";
import { run } from "../src/daemon.ts";
import type { Registry } from "../src/registry.ts";
import { World } from "./scenario/world.ts";
import { say } from "./support/plain-agent.ts";
import { FakeAgentBackend } from "./support/scripted-agent.ts";

test("the plain agent, named in the configuration, and the memory chat run a session", async (t) => {
  // Two agents, and the registry's default points at the one that must not be built: only the
  // `.env` of the config folder (`PARDNER_AGENT=plain`) can choose.
  const built: string[] = [];
  const world = World.make(t, {
    defaults: { agent: "other-agent" },
    more: {
      agents: {
        "other-agent": {
          required: [],
          optional: [],
          tools: NO_TOOL_WORDS,
          toolNames: [],
          limitsHeading: "Limits of a test agent",
          words: { names: [], literals: [], patterns: [] },
          build: () => {
            built.push("other-agent");
            throw new Error("an agent the configuration did not name was built");
          },
        },
      },
    },
  });
  assert.deepEqual(Object.keys(world.registry.agents), ["plain", "other-agent"]);
  const env = readFileSync(join(world.config, ".env"), "utf8");
  assert.match(env, /^PARDNER_AGENT=plain$/m);
  assert.doesNotMatch(env, /PARDNER_CHAT/);

  await world.start();
  world.script(say("Hello from the plain agent."));
  const thread = await world.open("one message");
  await world.ended(thread);

  assert.deepEqual(built, []);
  assert.equal(world.entry.built.length, 1);
  assert.deepEqual(world.prompts(), ["one message"]);
  assert.equal(
    world.shown(thread).at(-1),
    `Hello from the plain agent.\nworked · full · ${world.folder}`,
  );
  await world.finish();
  // The names the run wrote are the agent it was given and the chat the registry holds.
  const written = JSON.parse(readFileSync(world.state, "utf8")) as Record<string, unknown>;
  assert.deepEqual([written.agent, written.chat], ["plain", "memory"]);
});

/** A configuration directory whose `.env` holds `lines` and `ALLOWED_ROOT` (mode 600). */
function configDirectory(t: TestContext, ...lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pardner-selection-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = join(dir, ".env");
  writeFileSync(env, [`ALLOWED_ROOT=${dir}`, ...lines].join("\n"));
  chmodSync(env, 0o600);
  return dir;
}

/** What a registry of fakes saw: each entry built, as its name and the value of its required variable. */
interface Built {
  readonly agents: Array<readonly [name: string, value: string | undefined]>;
  readonly chats: Array<readonly [name: string, value: string | undefined]>;
}

const STOPPED = new Error("the fake chat ends the start");

/**
 * Two agents and one chat. The agents build the scripted fake back end; the chat refuses to be
 * built, so `run` ends once both were chosen. `first` is the default; `second` and the chat each
 * require one variable.
 */
function registryOf(built: Built): Registry {
  const agent = (name: string, key?: string): AgentEntry => ({
    required: key === undefined ? [] : [key],
    optional: [],
    tools: NO_TOOL_WORDS,
    toolNames: [],
    limitsHeading: "Limits of a test agent",
    words: { names: [], literals: [], patterns: [] },
    build: ({ variables }) => {
      built.agents.push([name, key === undefined ? undefined : variables[key]]);
      return new FakeAgentBackend([]);
    },
  });
  const chat: ChatEntry = {
    name: "one",
    required: ["ONE_KEY"],
    optional: [],
    limitsHeading: "Limits of a test chat",
    words: { names: [], literals: [], patterns: [] },
    build: async ({ variables }) => {
      built.chats.push(["one", variables.ONE_KEY]);
      throw STOPPED;
    },
  };
  return {
    agents: { first: agent("first"), second: agent("second", "SECOND_KEY") },
    chat,
    defaults: { agent: "first" },
  };
}

test("an absent selection variable selects the registry's default agent", async (t) => {
  const built: Built = { agents: [], chats: [] };
  const dir = configDirectory(t, "ONE_KEY=chat-value");
  await assert.rejects(
    run({ configDir: dir, environment: {}, registry: registryOf(built) }),
    STOPPED,
  );
  assert.deepEqual(built, { agents: [["first", undefined]], chats: [["one", "chat-value"]] });
});

test("the variable selects the agent and each module gets its own variables", async (t) => {
  const built: Built = { agents: [], chats: [] };
  const dir = configDirectory(
    t,
    "PARDNER_AGENT=second",
    "SECOND_KEY=agent-value",
    "ONE_KEY=chat-value",
  );
  await assert.rejects(
    run({ configDir: dir, environment: {}, registry: registryOf(built) }),
    STOPPED,
  );
  assert.deepEqual(built, {
    agents: [["second", "agent-value"]],
    chats: [["one", "chat-value"]],
  });
});

test("a variable a module requires and the file lacks stops the start before it is built", async (t) => {
  const built: Built = { agents: [], chats: [] };
  const dir = configDirectory(t, "PARDNER_AGENT=second");
  await assert.rejects(
    run({ configDir: dir, environment: {}, registry: registryOf(built) }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message === `missing in ${join(dir, ".env")}: ONE_KEY, SECOND_KEY`,
  );
  assert.deepEqual(built, { agents: [], chats: [] });
});

test("an agent name the registry does not hold stops the start with the valid ones", async (t) => {
  const built: Built = { agents: [], chats: [] };
  const dir = configDirectory(t, "PARDNER_AGENT=third", "ONE_KEY=chat-value");
  await assert.rejects(
    run({ configDir: dir, environment: {}, registry: registryOf(built) }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message ===
        'PARDNER_AGENT is "third", which this daemon does not hold; the valid names are: first, second',
  );
  assert.deepEqual(built, { agents: [], chats: [] });
});

test("a state.json written for another agent stops the start naming both pairs", async (t) => {
  const built: Built = { agents: [], chats: [] };
  const dir = configDirectory(t, "PARDNER_AGENT=second", "SECOND_KEY=x", "ONE_KEY=chat-value");
  const state = join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ version: 3, agent: "first", chat: "one", channels: {} }));
  await assert.rejects(
    run({ configDir: dir, environment: {}, registry: registryOf(built) }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "StateError" &&
      error.message.includes("written for another chat or agent") &&
      error.message.includes('agent "first"') &&
      error.message.includes('agent "second"') &&
      error.message.includes('chat "one"'),
  );
  assert.deepEqual(built, { agents: [], chats: [] });
});
