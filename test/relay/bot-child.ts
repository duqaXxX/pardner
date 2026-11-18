/**
 * The daemon of the relay chat tests, as a child process: `run` with a registry that holds the relay
 * chat and the plain agent, and no Claude (design 1). Arguments: the config folder, the home, a base
 * folder for the fake machine, and a JSON list of what the agent does with each prompt in order
 * (`"hold"` waits for ever, any other string is the text it answers). It prints `prompts N` when the
 * agent has taken N prompts and `held N` when N turns wait at `hold()`, so that a test kills the process once
 * the agent holds the turn (design 1, row N3). SIGINT stops it without waiting for a held turn.
 */
import { join } from "node:path";
import { relayChat } from "../../src/chat/relay/module.ts";
import { run } from "../../src/daemon.ts";
import { installedVersion } from "../../src/version.ts";
import { hold, PlainStore, plainAgent, say } from "../support/plain-agent.ts";
import { FakeMachine } from "../support/updates.ts";

const [config, home, base, script] = process.argv.slice(2) as [string, string, string, string];
const steps = (JSON.parse(script) as string[]).map((what) =>
  what === "hold" ? [say("Working"), hold()] : [say(what)],
);
process.stdin.on("end", () => process.kill(process.pid, "SIGKILL")).resume();
const entry = plainAgent({ store: new PlainStore(), turns: steps });
let seen = [0, 0];
setInterval(() => {
  const agents = entry.built;
  const prompts = agents.reduce(
    (n, a) => n + a.sessions.reduce((m, s) => m + s.prompts.length, 0),
    0,
  );
  const held = agents.reduce((n, a) => n + a.sessions.filter((s) => s.holding).length, 0);
  if (prompts !== seen[0]) console.log(`prompts ${prompts}`);
  if (held !== seen[1]) console.log(`held ${held}`);
  seen = [prompts, held];
}, 20);
process.exitCode = await run({
  configDir: config,
  home,
  environment: {},
  machine: new FakeMachine(join(base, "machine"), installedVersion()),
  registry: {
    agents: { plain: entry },
    chat: relayChat(),
    defaults: { agent: "plain" },
  },
});
process.exit();
