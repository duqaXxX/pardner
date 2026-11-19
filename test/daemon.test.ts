/**
 * The entry point, run whole on fakes: `run` over the memory chat, the scripted agent back end of
 * the sessions harness, a fake clock, an emitter for the signals and a connection the test can
 * make fail or hang. A test waits for the chat's start (the connection) and stops the daemon with
 * a signal. Nothing waits on the wall clock: the cleanup's schedule and the update check are
 * crossed by advancing `FakeClock`.
 *
 * The cleanup does not ask the agent which sessions are alive (#148: a thread stays while its
 * messages remain), which is the test `a start keeps a thread whose session the back end no
 * longer lists`.
 *
 * From the critical review of 2026-10-10: a listener still in flight when the stop ends is held
 * and let go after `run` returned; and what the process does with an exception or a rejection
 * nobody handled, and with an event loop that something still holds after the stop.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { claudeAgent } from "../src/agent/claude/module.ts";
import {
  type AgentBackend,
  AgentConfigError,
  NO_TOOL_WORDS,
  type RequestHandler,
  type StartOptions,
} from "../src/agent/seam.ts";
import {
  ChatError,
  type ChatInbound,
  type ChatProvider,
  type Presence,
  type ThreadChat,
  type ThreadRef,
} from "../src/chat/seam.ts";
import type { Clock } from "../src/clock.ts";
import { CLEAN_EVERY_SECONDS } from "../src/core/cleanup.ts";
import { AlreadyRunning, identityDirectory, singleInstance, updateLock } from "../src/core/lock.ts";
import type { ChatContext, ChatEntry } from "../src/core/port.ts";
import { StateError, StateStore } from "../src/core/state.ts";
import * as texts from "../src/core/texts.ts";
import { UPDATE_CHECK_SECONDS } from "../src/core/updates.ts";
import {
  cleanEvery,
  DRAIN_LIMIT_SECONDS,
  deferred,
  installProcessHandlers,
  logger,
  main,
  ROLLBACK_LIMIT_SECONDS,
  type RunOptions,
  run,
  SHUTDOWN_LIMIT_SECONDS,
  type SignalSource,
  type Stop,
  StopSignals,
} from "../src/daemon.ts";
import type { Registry } from "../src/registry.ts";
import { installedVersion } from "../src/version.ts";
import { AsyncEvent, FakeClock } from "./support/fake-clock.ts";
import { FakeSdk } from "./support/fake-query.ts";
import { MEMORY_IDENTITY, type MemoryChat, memoryChat, OWNER } from "./support/memory-chat.ts";
import { NAMES } from "./support/names.ts";
import { FakeAgentBackend, type Script, sdkMessages } from "./support/scripted-agent.ts";
import { heldByARunningDaemon, realWorkDone } from "./support/settle.ts";
import { FakeMachine, FakeService } from "./support/updates.ts";

const HELD = heldByARunningDaemon(1);

const ROOT = join(import.meta.dirname, "..");
// The name the memory chat has in the registry, and so in the `state.json` of a run.
const CHAT = "relay";
// The agent and the chat a run names in its file: a store the tests build to seed or read it takes them.
const MODULES = { agent: "claude", chat: CHAT };

/**
 * The registry a test runs over: the given chat entry, and an agent entry whose `build` answers
 * the given back end. The names are the daemon's defaults, so the owner's `.env` selects them
 * with no variable.
 */
function registryOf(backend: AgentBackend, chat: ChatEntry): Registry {
  return {
    agents: {
      claude: {
        required: [],
        optional: [],
        tools: NO_TOOL_WORDS,
        toolNames: [],
        limitsHeading: "Limits of a test agent",
        words: { names: [], literals: [], patterns: [] },
        build: () => backend,
      },
    },
    chat,
    defaults: { agent: "claude" },
  };
}

/** A configuration directory with a valid `.env`, as the owner's would be (mode 600). */
function configDirectory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "pardner-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = join(dir, ".env");
  writeFileSync(env, `ALLOWED_ROOT=${dir}\n`);
  chmodSync(env, 0o600);
  return dir;
}

/**
 * The daemon over fakes: the memory chat behind a registry entry that sees what the daemon asks
 * of it. `events` keeps the order of the connection (`connect`, `app.stop`) for the tests of an
 * order; `receiver` is the connection, which a test can make hang or fail.
 */
class Daemon {
  readonly chat: MemoryChat;
  /** The channel the daemon is bound to in the chat. */
  readonly channel: string;
  readonly clock = new FakeClock();
  readonly backend: FakeAgentBackend;
  readonly signals = new EventEmitter();
  readonly connected = new AsyncEvent();
  /** What the connection was asked, in order, for the tests of an order. */
  readonly events: string[] = [];
  /** What the daemon handed the chat when it built it; null before. */
  context: ChatContext | null = null;
  /** What the daemon handed the chat when it started it; null before. */
  inbound: ChatInbound | null = null;
  /** Called when the repair shows a status on a root: the moment of a repair. */
  onRepair: (() => void) | null = null;
  /** Called when the chat is closed, after the sessions. */
  onClose: (() => void) | null = null;
  /** The channels the cleanup asked the chat about, in order. */
  readonly asked: string[] = [];
  /** The channels the chat has open and answers `gone` about, as a deleted one is for a chat that lags. */
  readonly gone = new Set<string>();
  /** While set, the answer about a channel waits for it, once `gated` is set. */
  gate: AsyncEvent | null = null;
  readonly gated = new AsyncEvent();
  readonly dir: string;
  /** The home the daemon takes the lock of its chat identity under, never the real one. */
  home: string;
  running: Promise<number> | null = null;
  startFails: Error | null = null;
  /** The machine the update asks of: no registry to reach and no service, as with no network. */
  readonly machine: FakeMachine;

  constructor(
    t: TestContext,
    options: { scripts?: Script[]; identities?: readonly string[] } = {},
  ) {
    const identities = options.identities ?? [MEMORY_IDENTITY];
    this.dir = configDirectory(t);
    this.home = join(this.dir, "home");
    this.held = heldByARunningDaemon(identities.length);
    this.machine = new FakeMachine(this.dir, installedVersion());
    this.backend = new FakeAgentBackend(options.scripts ?? []);
    // `rootStatus` for the repair of a root a crash left working, `index` for the page.
    this.chat = memoryChat({
      identities,
      rootStatus: true,
      index: {
        page: () => ({
          line: this.context?.core().updates?.line() ?? null,
          channels: this.context?.core().state.channels() ?? [],
        }),
      },
    });
    this.channel = this.chat.openChannel("work");
    this.signals.setMaxListeners(0);
    t.after(async () => {
      // A test that failed must not leave the daemon (and its timer) running.
      if (this.running !== null) {
        this.signals.emit("SIGINT");
        await this.running.catch(() => undefined);
      }
    });
  }

  get path(): string {
    return join(this.dir, "state.json");
  }

  /** The thread `name` as a thread of the chat the owner opened at `openedAt` (now when absent). */
  adopt(name: string, openedAt: number = Date.now() / 1000): ThreadRef {
    const ref = { channel: this.channel, thread: name };
    this.chat.adopt(ref, openedAt);
    return ref;
  }

  readonly receiver = {
    start: async (): Promise<void> => {
      this.events.push("connect");
      if (this.startFails !== null) throw this.startFails;
    },
    stop: async (): Promise<void> => {
      this.events.push("app.stop");
    },
  };

  /** The chat as the daemon builds it, with the moments a test waits for or holds. */
  readonly entry: ChatEntry = {
    name: CHAT,
    required: [],
    optional: [],
    limitsHeading: "Limits of the memory chat",
    words: { names: [], literals: [], patterns: [] },
    build: async (context) => {
      this.context = context;
      return this.#watched(await this.chat.build(context));
    },
  };

  #watched(provider: ChatProvider): ChatProvider {
    const daemon = this;
    return new Proxy(provider, {
      get(target, property) {
        if (property === "start") {
          return async (inbound: ChatInbound) => {
            daemon.inbound = inbound;
            await daemon.receiver.start();
            await target.start(inbound);
            daemon.connected.set();
          };
        }
        if (property === "stop") {
          return async () => {
            // A chat that never started has no connection to stop.
            if (daemon.inbound !== null) await daemon.receiver.stop();
            await target.stop();
          };
        }
        if (property === "close") {
          return async () => {
            daemon.onClose?.();
            await target.close();
          };
        }
        if (property === "channelState") {
          return async (channel: string): Promise<Presence> => {
            daemon.asked.push(channel);
            if (daemon.gate !== null) {
              daemon.gated.set();
              await daemon.gate.wait();
            }
            return daemon.gone.has(channel) ? "gone" : target.channelState(channel);
          };
        }
        if (property === "thread") {
          return (ref: ThreadRef): ThreadChat => daemon.#threadWatched(target.thread(ref));
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  }

  #threadWatched(thread: ThreadChat): ThreadChat {
    const daemon = this;
    return new Proxy(thread, {
      get(target, property) {
        if (property === "showStatus" && target.showStatus !== undefined) {
          const show = target.showStatus.bind(target);
          return async (...args: Parameters<NonNullable<ThreadChat["showStatus"]>>) => {
            daemon.onRepair?.();
            return show(...args);
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  }

  /** The owner writes `text` in `thread`: resolves once the daemon has taken it. */
  says(text: string, thread: string): Promise<unknown> {
    return this.chat.as(OWNER).says(this.channel, text, { thread });
  }

  /** The owner's control that runs the cleanup at once, as a chat reads it from the port. */
  refresh(): Promise<unknown> {
    const context = this.context;
    assert.ok(context !== null, "the daemon did not build the chat");
    const cleanup = context.core().cleanup;
    assert.ok(cleanup !== undefined, "the core has no cleanup");
    return cleanup.request();
  }

  options(extra: RunOptions = {}): RunOptions {
    return {
      configDir: this.dir,
      home: this.home,
      registry: registryOf(this.backend, this.entry),
      clock: this.clock,
      signals: this.signals as SignalSource,
      machine: this.machine,
      // Detached: `run` writes the instance's name to it, and a test must not change the runner's.
      environment: {},
      ...extra,
    };
  }

  start(extra: RunOptions = {}): Promise<number> {
    this.running = run(this.options(extra));
    return this.running;
  }

  /** Resolves once the chat connected; fails the test if `run` ended before. */
  async booted(): Promise<void> {
    const running = this.running;
    assert.ok(running !== null, "the daemon was not started");
    await Promise.race([
      this.connected.wait(),
      running.then(() => assert.fail("run ended before it connected")),
    ]);
  }

  /**
   * What the daemon keeps open on purpose (`heldByARunningDaemon`): `until` does not wait for it.
   * A test that makes the daemon take the machine's update lock says so while it holds it.
   */
  held: number;

  /** A service of the machine runs this very process, so the daemon may update and restart. */
  supervise(): FakeService {
    const service = new FakeService();
    service.pid = process.pid;
    this.machine.services.set("", service);
    return service;
  }

  async stop(signal: Stop = "SIGTERM"): Promise<number> {
    assert.ok(this.running !== null, "the daemon was not started");
    this.signals.emit(signal);
    return this.running;
  }

  /**
   * Advances the clock a second at a time until `done` holds, at most a hundred times. Each step
   * waits for the file calls it set going, so a loaded machine does not use the steps up.
   */
  async until(done: () => boolean): Promise<void> {
    for (let round = 0; round < 100; round += 1) {
      if (done()) return;
      await this.clock.advance(1);
      await realWorkDone(this.held);
    }
    assert.ok(done(), "the daemon never reached the state the test waited for");
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** What a logger was asked to write while the test ran. */
function written(
  t: TestContext,
  target: { [K in "info" | "warning" | "error"]: unknown },
  level: "info" | "warning" | "error",
) {
  const spy = t.mock.method(target as Record<string, (message: string) => void>, level, () => {});
  return () => spy.mock.calls.map((call) => String(call.arguments[0]));
}

test("a bad config exits 1 with the reason", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pardner-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const errors = written(t, logger, "error");
  const exits: number[] = [];
  await main({
    configDir: dir,
    environment: {},
    exit: (code) => exits.push(code),
    process: new EventEmitter(),
  });
  assert.deepEqual(exits, [1]);
  assert.ok(errors().some((line) => line.includes("docs/setup.md")));
});

test("a second instance stops before the chat", async (t) => {
  const dir = configDirectory(t);
  const unreached: RunOptions = {
    configDir: dir,
    environment: {},
    registry: registryOf(new FakeAgentBackend([]), {
      name: CHAT,
      required: [],
      optional: [],
      limitsHeading: "Limits of the memory chat",
      words: { names: [], literals: [], patterns: [] },
      build: () => assert.fail("the chat was reached"),
    }),
  };
  const held = await singleInstance(dir);
  try {
    await assert.rejects(run(unreached), AlreadyRunning);
  } finally {
    await held.release();
  }
});

test("a second daemon on the same chat identity refuses before it connects", async (t) => {
  const first = new Daemon(t);
  first.start();
  await first.booted();
  // Its own configuration folder, with the identity of the same chat: a copied `.env`.
  const second = new Daemon(t);
  second.home = first.home;
  const errors = written(t, logger, "error");
  const exits: number[] = [];
  await main({
    ...second.options(),
    exit: (code) => exits.push(code),
    process: new EventEmitter(),
  });
  assert.deepEqual(exits, [1]);
  assert.deepEqual(errors(), [
    `another pardner instance is connected to this chat identity (lock on ${identityDirectory(first.home, MEMORY_IDENTITY)}): give each instance its own chat identity`,
  ]);
  // Built and never connected; what it built is let go of.
  assert.ok(second.context !== null);
  assert.deepEqual(second.events, []);
  assert.deepEqual(first.events, ["connect"]);
  await first.stop();
});

test("a copied .env with a new bot token and the old app token refuses before it connects", async (t) => {
  const first = new Daemon(t, { identities: ["memory:bot-1", "memory:app"] });
  first.start();
  await first.booted();
  // Another bot on the same app: the second key of its identity is the first's.
  const second = new Daemon(t, { identities: ["memory:bot-2", "memory:app"] });
  second.home = first.home;
  const errors = written(t, logger, "error");
  const exits: number[] = [];
  await main({
    ...second.options(),
    exit: (code) => exits.push(code),
    process: new EventEmitter(),
  });
  assert.deepEqual(exits, [1]);
  assert.deepEqual(errors(), [
    `another pardner instance is connected to this chat identity (lock on ${identityDirectory(first.home, "memory:app")}): give each instance its own chat identity`,
  ]);
  assert.deepEqual(second.events, []);
  assert.deepEqual(first.events, ["connect"]);
  await first.stop();
});

test("the chat saves files in the scratch folder of the instance the daemon was given", async (t) => {
  const d = new Daemon(t);
  const scratchDir = join(d.dir, "scratch-dev");
  d.start({ scratchDir });
  await d.booted();
  assert.equal(d.context?.scratchDir, scratchDir);
  assert.equal(d.context?.instance, undefined, "the default instance has no name");
  await d.stop();
});

test("the chat is given a named instance's name and the agent's brand words", async (t) => {
  const d = new Daemon(t);
  d.start({ instance: { name: "work" }, environment: {} });
  await d.booted();
  assert.equal(d.context?.instance, "work");
  assert.ok(d.backend.words.brand?.length, "the agent declares its brand");
  assert.deepEqual(d.context?.brand, d.backend.words.brand);
  await d.stop();
});

test("a named instance's name is written to the environment it was given", async (t) => {
  const d = new Daemon(t);
  const environment: NodeJS.ProcessEnv = {};
  d.start({ instance: { name: "work" }, environment });
  await d.booted();
  assert.equal(environment.PARDNER_INSTANCE, "work");
  await d.stop();
});

// The sessions build their `env` from `process.env`, the environment `run` writes to by default:
// the one place a session can tell which instance it belongs to.
test("a session the daemon starts receives the name of its instance", async (t) => {
  const before = process.env.PARDNER_INSTANCE;
  t.after(() => {
    if (before === undefined) delete process.env.PARDNER_INSTANCE;
    else process.env.PARDNER_INSTANCE = before;
  });
  const d = new Daemon(t);
  const claudeHome = join(d.dir, "claude-home");
  mkdirSync(claudeHome);
  writeFileSync(join(claudeHome, ".claude.json"), JSON.stringify({}));
  const sdk = new FakeSdk();
  let backend: AgentBackend | null = null;
  const base = d.options().registry as Registry;
  const registry: Registry = {
    ...base,
    agents: {
      claude: {
        required: [],
        optional: [],
        tools: NO_TOOL_WORDS,
        toolNames: [],
        limitsHeading: "Limits of a test agent",
        words: { names: [], literals: [], patterns: [] },
        build: (context) => {
          backend = claudeAgent({ query: sdk.query, home: claudeHome }).build(context);
          return backend;
        },
      },
    },
  };
  // The real environment, which the sessions inherit; restored above.
  d.start({ registry, instance: { name: "work" }, environment: process.env });
  await d.booted();
  assert.ok(backend !== null, "the daemon did not build the agent");
  const start: StartOptions = {
    folder: d.dir,
    resume: null,
    model: null,
    effort: null,
  };
  const requests: RequestHandler = {
    permission: async () => ({ allow: true }),
    question: async () => ({ answered: false, message: "" }),
  };
  const session = await (backend as AgentBackend).start(start, requests);
  assert.equal(sdk.only.options.env?.PARDNER_INSTANCE, "work");
  await session.close();
  await d.stop();
});

test("the default instance leaves no instance name in the environment", async (t) => {
  const d = new Daemon(t);
  // A caller that hands `run` an environment holding another instance's name.
  const environment: NodeJS.ProcessEnv = { PARDNER_INSTANCE: "work", PATH: "/usr/bin" };
  d.start({ environment });
  await d.booted();
  assert.deepEqual(environment, { PATH: "/usr/bin" });
  await d.stop();
});

test("run refuses a state.json written for other modules, naming both pairs", async (t) => {
  const d = new Daemon(t);
  const state = new StateStore(d.path, { modules: { ...MODULES, agent: "other-agent" } });
  state.bind(d.channel, d.dir);
  const before = readFileSync(d.path, "utf8");

  await assert.rejects(
    d.start(),
    (error: unknown) =>
      error instanceof StateError &&
      error.message.includes("written for another chat or agent") &&
      error.message.includes('agent "other-agent"') &&
      error.message.includes('agent "claude"') &&
      error.message.includes(`chat "${CHAT}"`),
  );
  assert.equal(readFileSync(d.path, "utf8"), before);
  assert.equal(d.context, null); // the chat was not reached
});

test("run repairs a crashed thread before pruning it", async (t) => {
  // A thread with no session id, its root message older than a day (`state.ONE_DAY`): prune
  // drops it. Repair must still act on it first (ruling 5), since it is exactly what
  // a crash mid-first-turn leaves.
  const d = new Daemon(t);
  const state = new StateStore(d.path, { modules: MODULES });
  state.bind(d.channel, d.dir);
  state.openThread(d.channel, "thread-old");
  state.setStatusPending(d.channel, "thread-old", "waiting");
  const ref = d.adopt("thread-old", 1_000_000_000);

  d.start();
  await d.booted();
  // The crash ended the work the root still shows: the chat is told, and the owner with it.
  assert.deepEqual(
    d.chat.calls("showStatus").map((call) => [call.ref, call.args[0]]),
    [[ref, "error"]],
  );
  // Repaired, then pruned: nothing left of the thread at all.
  assert.equal(new StateStore(d.path, { modules: MODULES }).thread(d.channel, "thread-old"), null);
  await d.stop();
});

test("run publishes the session index once started and after a change", async (t) => {
  const d = new Daemon(t);
  const threadTs = "thread-1";
  const state = new StateStore(d.path, { modules: MODULES });
  state.bind(d.channel, d.dir);
  state.openThread(d.channel, threadTs, "some-id");
  state.setStatusPending(d.channel, threadTs, "working"); // a crash left it
  const ref = d.adopt(threadTs);
  d.backend.listed = [
    {
      id: "some-id",
      title: "Fix the footer",
      customTitle: null,
      branch: null,
      size: null,
      lastModified: Date.now(),
    },
  ];
  const stores: StateStore[] = [];
  const refreshes = () => d.chat.calls("index.refresh");
  // The first page is written once the repair and the prune are done, before the connection opens.
  const connect = d.receiver.start.bind(d.receiver);
  let drawn = -1;
  t.mock.method(d.receiver, "start", async () => {
    drawn = refreshes().length;
    await connect();
  });

  d.start({
    openState: (path) => {
      stores.push(new StateStore(path, { modules: MODULES }));
      return stores[0] as StateStore;
    },
  });
  await d.booted();
  // Published after the repair, which ended what the crash left working; none names a session.
  const order = d.chat.calls().map((call) => call.call);
  assert.ok(order.includes("showStatus"), "the repair showed no status");
  assert.ok(order.indexOf("showStatus") < order.indexOf("index.refresh"));
  assert.equal(refreshes()[0]?.args[0], null);
  assert.ok(drawn > 0, "the first page was not written before the connection");
  (stores[0] as StateStore).setStatusPending(d.channel, threadTs, "waiting");
  // The change names the session whose line is no longer as drawn.
  await d.until(() => refreshes().some((call) => isDeepStrictEqual(call.args[0], [ref])));
  await d.stop();
});

test("run checks for an update at start and shows it on the chat's session index, and again every 6 hours", async (t) => {
  const d = new Daemon(t);
  d.machine.newest = "99.0.0";
  d.supervise();
  // What the chat's page reads at each refresh: the update line of the core.
  const pages = (): string[] =>
    d.chat.calls("index.refresh").map((call) => JSON.stringify(call.args[1]));
  d.start();
  await d.booted();
  await d.until(() => pages().some((page) => page.includes('"latest":"99.0.0"')));
  const asked = () => d.machine.npm.filter((args) => args[0] === "view" && args[1] === "pardner");
  assert.equal(asked().length, 1);
  d.machine.newest = "99.1.0";
  await d.clock.advance(UPDATE_CHECK_SECONDS);
  await d.until(() => pages().some((page) => page.includes('"latest":"99.1.0"')));
  assert.equal(asked().length, 2);
  await d.stop();
  // Nothing asks once the daemon stopped.
  await d.clock.advance(UPDATE_CHECK_SECONDS * 2);
  assert.equal(asked().length, 2);
});

test("a stop closes the chat while npm has not answered the update check, and ends with it", async (t) => {
  const d = new Daemon(t);
  const release = new AsyncEvent();
  const run = d.machine.run;
  d.machine.run = async (command, args) => {
    if (args[0] === "view") await release.wait();
    return run(command, args);
  };
  d.start();
  await d.booted();
  const stopping = d.stop();
  // The sessions and the chat close while npm has not answered; the stop ends with the check.
  await d.until(() => d.events.includes("app.stop"));
  release.set();
  assert.equal(await stopping, 0);
});

test("a stop ends the update check that npm has not answered, it does not wait for it", async (t) => {
  // Registered before the daemon's own hook: a check that never ends must not hold the test.
  const never = new AsyncEvent();
  t.after(() => never.set());
  const d = new Daemon(t);
  const run = d.machine.run;
  let asked: AbortSignal | undefined;
  d.machine.run = async (command, args, signal) => {
    if (args[0] !== "view") return run(command, args, signal);
    asked = signal;
    // A hung npm: only the signal ends it, as `runAsync` does with SIGTERM.
    await Promise.race([
      never.wait(),
      new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true })),
    ]);
    return { status: null, stdout: "", stderr: "" };
  };
  d.start();
  await d.booted();
  await d.until(() => asked !== undefined);
  assert.equal(asked?.aborted, false, "the check runs while the daemon does");
  let code: number | null = null;
  void d.stop().then((value) => {
    code = value;
  });
  await d.until(() => code !== null);
  assert.equal(code, 0);
  assert.equal(asked?.aborted, true);
});

/**
 * A daemon whose copy is behind 99.0.0, supervised by a service that runs this process, with the
 * click of the chat's update control sent and npm's install held under way until the test lets it end. npm
 * answers a SIGTERM as measured on 2026-10-17 (npm 11.17.0): it finishes its step, puts the old
 * folder back and ends with 1 (`rolledBack`), once released.
 */
async function installUnderWay(
  t: TestContext,
  failure?: AbortSignal,
  launch: (d: Daemon, extra: RunOptions) => Promise<number> = (d, extra) => d.start(extra),
) {
  // Registered before the daemon's own hook, which waits for the daemon to stop: a test that
  // failed while npm was held would otherwise wait for npm for ever.
  const release = new AsyncEvent();
  t.after(() => release.set());
  const d = new Daemon(t);
  d.machine.newest = "99.0.0";
  d.supervise();
  const npm = {
    started: false,
    ended: false,
    signalled: false,
    release,
  };
  const run = d.machine.run;
  d.machine.run = async (command, args, signal) => {
    if (args[0] !== "install") return run(command, args, signal);
    npm.started = true;
    signal?.addEventListener(
      "abort",
      () => {
        npm.signalled = true;
      },
      { once: true },
    );
    await npm.release.wait();
    npm.ended = true;
    // The click lets the update lock go once npm has ended: from here `until` waits for that.
    d.held = HELD;
    return npm.signalled ? { status: 1, stdout: "", stderr: "" } : run(command, args, signal);
  };
  const progress: number[] = [];
  d.running = launch(d, {
    shutdownProgress: () => progress.push(d.clock.now),
    ...(failure !== undefined && { failure }),
  });
  await d.booted();
  await d.until(() => d.machine.npm.some((args) => args[0] === "view" && args[1] === "pardner"));
  // Outside macOS the update lock the click takes is a listening socket, open for the whole
  // install: counted as held, or every `until` would wait for it to its limit.
  d.held = heldByARunningDaemon(2, true);
  void d.chat.as(OWNER).picksOnPage("99.0.0");
  await d.until(() => npm.started);
  const returned: { code: number | null } = { code: null };
  const watch = (stopping: Promise<number>): void => {
    void stopping.then((code) => {
      returned.code = code;
    });
  };
  return { d, npm, returned, watch, progress };
}

test("a SIGTERM during the install waits for it: the drain does not end while npm runs", async (t) => {
  const { d, npm, returned, watch } = await installUnderWay(t);
  watch(d.stop("SIGTERM"));
  for (let round = 0; round < 5; round += 1) await d.clock.advance(1);
  assert.equal(returned.code, null, "run returned while npm was still installing");
  assert.equal(npm.signalled, false, "a drain lets the install finish, it does not cut it");
  npm.release.set();
  await d.until(() => returned.code !== null);
  assert.equal(returned.code, 0);
  assert.equal(npm.ended, true);
  assert.equal(d.machine.held, "99.0.0", "the install completed");
});

test("a drain that is cut short ends the install with SIGTERM and waits for npm to roll back", async (t) => {
  const { d, npm, returned, watch } = await installUnderWay(t);
  watch(d.stop("SIGTERM"));
  await d.clock.advance(1);
  assert.equal(npm.signalled, false);
  await d.clock.advance(DRAIN_LIMIT_SECONDS);
  assert.equal(npm.signalled, true, "the limit of the drain cut the install");
  assert.equal(returned.code, null, "run waits for npm to end");
  npm.release.set();
  await d.until(() => returned.code !== null);
  assert.equal(npm.ended, true);
  assert.equal(d.machine.held, installedVersion(), "rolled back: the copy is as it was");
});

test("a stop with no drain sends npm SIGTERM and waits for it to end before it goes on", async (t) => {
  for (const how of ["SIGINT", "failure"] as const) {
    const crash = new AbortController();
    const { d, npm, returned, watch } = await installUnderWay(t, crash.signal);
    if (how === "SIGINT") watch(d.stop("SIGINT"));
    else {
      crash.abort();
      watch(d.running as Promise<number>);
    }
    await d.clock.advance(1);
    assert.equal(npm.signalled, true, `${how}: npm was sent SIGTERM`);
    assert.equal(returned.code, null, `${how}: run returned while npm was still rolling back`);
    assert.equal(d.events.includes("app.stop"), false, `${how}: the shutdown went on past npm`);
    npm.release.set();
    await d.until(() => returned.code !== null);
    assert.equal(npm.ended, true);
  }
});

test("the wait for npm reports progress, and a npm that never ends does not hold the stop for ever", async (t) => {
  const { d, npm, returned, watch, progress } = await installUnderWay(t);
  watch(d.stop("SIGINT"));
  const before = progress.length;
  for (let round = 0; round < SHUTDOWN_LIMIT_SECONDS * 2; round += 1) await d.clock.advance(1);
  // Every second of the wait is a step of the shutdown, so `main`'s limit is not running down.
  assert.ok(
    progress.length - before >= SHUTDOWN_LIMIT_SECONDS * 2 - 2,
    `${progress.length - before}`,
  );
  assert.equal(returned.code, null);
  await d.clock.advance(ROLLBACK_LIMIT_SECONDS);
  await d.until(() => returned.code !== null);
  assert.equal(npm.ended, false, "npm never answered; the stop went on after the limit");
});

test("a failure during an install waits for npm's rollback, not for the failure's 30 seconds", async (t) => {
  const events = new EventEmitter();
  let ran: ReturnType<typeof mainOf> | null = null;
  const { d, npm } = await installUnderWay(t, undefined, (daemon, extra) => {
    ran = mainOf(daemon, events, true, extra);
    return ran.running.then(() => 0);
  });
  const { exits, timers } = ran as unknown as ReturnType<typeof mainOf>;
  events.emit("uncaughtException", new Error("boom"));
  await d.clock.advance(1);
  assert.equal(npm.signalled, true, "the failure sent npm SIGTERM");
  // Past the failure's own deadline, with npm still rolling back: the stop is waiting, not stuck.
  await d.clock.advance(SHUTDOWN_LIMIT_SECONDS + 5);
  assert.deepEqual(exits, [], "the process ended while npm was putting the old folder back");
  assert.equal(d.events.includes("app.stop"), false, "the shutdown went on past npm");
  assert.ok(standing(timers).every((seconds) => seconds > SHUTDOWN_LIMIT_SECONDS));
  npm.release.set();
  await d.until(() => exits.length > 0);
  assert.deepEqual(exits, [1]);
  assert.equal(d.machine.held, installedVersion(), "rolled back: the copy is as it was");
});

test("a failure during an install that never rolls back still ends the process", async (t) => {
  const events = new EventEmitter();
  let ran: ReturnType<typeof mainOf> | null = null;
  const { d } = await installUnderWay(t, undefined, (daemon, extra) => {
    ran = mainOf(daemon, events, true, extra);
    return ran.running.then(() => 0);
  });
  const { exits } = ran as unknown as ReturnType<typeof mainOf>;
  events.emit("uncaughtException", new Error("boom"));
  await d.clock.advance(ROLLBACK_LIMIT_SECONDS + SHUTDOWN_LIMIT_SECONDS + 5);
  await d.until(() => exits.length > 0);
  assert.equal(exits[0], 1);
});

test("a failure's deadline is moved only by the wait for npm, and a step after it is held to the limit", async (t) => {
  // Registered before the daemon's own hook, which waits for the stop: a hung chat would hold it.
  const hang = new AsyncEvent();
  t.after(() => hang.set());
  const events = new EventEmitter();
  let ran: ReturnType<typeof mainOf> | null = null;
  const { d, npm } = await installUnderWay(t, undefined, (daemon, extra) => {
    ran = mainOf(daemon, events, true, extra);
    return ran.running.then(() => 0);
  });
  const { exits, timers } = ran as unknown as ReturnType<typeof mainOf>;
  // The step after the wait for npm never answers.
  (d.receiver as { stop: () => Promise<void> }).stop = async () => {
    d.events.push("app.stop");
    await hang.wait();
  };
  events.emit("uncaughtException", new Error("boom"));
  await d.clock.advance(1);
  assert.equal(npm.signalled, true);
  assert.deepEqual(
    standing(timers),
    [ROLLBACK_LIMIT_SECONDS + SHUTDOWN_LIMIT_SECONDS],
    "while the stop waits for npm the deadline carries the rollback's limit",
  );
  npm.release.set();
  await d.until(() => d.events.includes("app.stop"));
  assert.deepEqual(standing(timers), [SHUTDOWN_LIMIT_SECONDS], "the wait is over: the limit alone");
  // No step of the stop moves the deadline of a failure: it ends the process on its own.
  await d.clock.advance(SHUTDOWN_LIMIT_SECONDS - 1);
  assert.deepEqual(exits, []);
  await d.clock.advance(1);
  assert.deepEqual(exits, [1]);
});

test("run forgets a gone channel at start and again on its schedule", async (t) => {
  const d = new Daemon(t);
  // A channel the chat still has open but answers `gone` about.
  const forgotten = d.chat.openChannel("forgotten");
  d.gone.add(forgotten);
  const late = d.chat.openChannel("late");
  writeFileSync(
    d.path,
    JSON.stringify({
      version: 3,
      agent: MODULES.agent,
      chat: MODULES.chat,
      channels: Object.fromEntries(
        [forgotten, d.channel, late].map((channel) => [channel, { directory: d.dir }]),
      ),
    }),
  );
  const bound = (): string[] =>
    Object.keys((JSON.parse(readFileSync(d.path, "utf8")) as { channels: object }).channels);

  d.start();
  await d.booted();
  await tick();
  assert.deepEqual(bound(), [d.channel, late]);
  d.chat.removeChannel(late); // deleted while the daemon runs
  await d.clock.advance(CLEAN_EVERY_SECONDS);
  await d.until(() => bound().join() === d.channel);
  // SIGINT: no drain, so only the end of the schedule itself keeps a later pass from running.
  await d.stop("SIGINT");
  // The schedule ends with the daemon: no pass asks the chat about a channel after the stop.
  const asked = d.asked.length;
  await d.clock.advance(CLEAN_EVERY_SECONDS * 2);
  assert.equal(d.asked.length, asked);
});

test("the chat's refresh control runs the cleanup at once, and the page is written without the channel", async (t) => {
  const d = new Daemon(t);
  const state = new StateStore(d.path, { modules: MODULES });
  const late = d.chat.openChannel("late");
  state.bind(d.channel, d.dir);
  state.bind(late, d.dir);
  const bound = (): string[] =>
    Object.keys((JSON.parse(readFileSync(d.path, "utf8")) as { channels: object }).channels);
  d.start({ openState: () => state });
  await d.booted();
  await tick();
  assert.deepEqual(bound(), [d.channel, late]);
  const refreshes = () => d.chat.calls("index.refresh").length;
  d.chat.removeChannel(late); // deleted while the daemon runs, a long way from the next scheduled pass
  const before = refreshes();
  await d.refresh();
  await d.until(() => bound().join() === d.channel);
  // The page is drawn again once the channel is forgotten: the last one no longer lists it.
  await d.until(() => refreshes() > before);
  const page = d.chat.calls("index.refresh").at(-1)?.args[1] as { channels: string[] };
  assert.deepEqual(page.channels, [d.channel]);
  await d.stop("SIGINT");
});

test("the chat's refresh control runs no cleanup while the daemon drains for a stop", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "pardner-refresh-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const state = new StateStore(join(folder, "state.json"), { modules: MODULES });
  const { d, npm, returned, watch } = await installUnderWay(t, undefined, (daemon, extra) =>
    daemon.start({ ...extra, openState: () => state }),
  );
  const late = d.chat.openChannel("late");
  state.bind(d.channel, d.dir);
  state.bind(late, d.dir);
  d.chat.removeChannel(late);
  watch(d.stop("SIGTERM")); // npm holds the drain open
  await d.clock.advance(1);
  await d.refresh();
  await tick();
  assert.deepEqual(state.channels(), [d.channel, late], "no channel is forgotten mid-drain");
  assert.equal(returned.code, null);
  npm.release.set();
  await d.until(() => returned.code !== null);
});

test("a stop waits for a cleanup pass the chat's refresh control started", async (t) => {
  const d = new Daemon(t);
  const state = new StateStore(d.path, { modules: MODULES });
  const late = d.chat.openChannel("late");
  state.bind(d.channel, d.dir);
  state.bind(late, d.dir);
  d.start({ openState: () => state });
  await d.booted();
  // The pass is held inside its first question to the chat.
  const open = new AsyncEvent();
  d.gate = open;
  void d.refresh();
  await d.gated.wait();
  const returned: { code: number | null } = { code: null };
  void d.stop("SIGINT").then((code) => {
    returned.code = code;
  });
  for (let round = 0; round < 5; round += 1) await d.clock.advance(1);
  assert.equal(returned.code, null, "run returned while the pass was still asking the chat");
  open.set();
  await d.until(() => returned.code !== null);
  assert.equal(returned.code, 0);
  assert.deepEqual(state.channels(), [d.channel, late]);
});

test("the scheduled cleanup stops once a stop has begun", async () => {
  const passes: string[] = [];
  const clock = new FakeClock();
  const done = cleanEvery({
    seconds: 0.01,
    clean: async () => {
      passes.push("clean");
    },
    sessions: { draining: true },
    clock,
    signal: new AbortController().signal,
  });
  await clock.advance(1);
  await done;
  assert.deepEqual(passes, []);
});

test("repair and prune run before the socket mode connection opens", async (t) => {
  // The exact order: repair, then prune, then the connection. The repair is seen at the status it
  // shows on the root a crash left, the prune at the state's own method.
  const d = new Daemon(t);
  const state = new StateStore(d.path, { modules: MODULES });
  state.bind(d.channel, d.dir);
  state.openThread(d.channel, "thread-old");
  state.setStatusPending(d.channel, "thread-old", "waiting");
  d.adopt("thread-old", 1_000_000_000);
  const order: string[] = [];
  d.onRepair = () => order.push("repair");
  const receiverStart = d.receiver.start.bind(d.receiver);
  t.mock.method(d.receiver, "start", async () => {
    order.push("connect");
    await receiverStart();
  });

  d.start({
    openState: (path) => {
      const store = new StateStore(path, { modules: MODULES });
      const prune = store.prune.bind(store);
      t.mock.method(store, "prune", (...args: Parameters<StateStore["prune"]>) => {
        order.push("prune");
        return prune(...args);
      });
      return store;
    },
  });
  await d.booted();
  assert.deepEqual(order, ["repair", "prune", "connect"]);
  await d.stop();
});

test("signal handlers are installed before a long repair runs", async (t) => {
  // Installed before repair, not after, so a SIGTERM arriving during a long repair is caught
  // instead of ending the process under the default disposition, which would skip every step of
  // the shutdown (the single-instance lock, Socket Mode, every session).
  const d = new Daemon(t);
  const state = new StateStore(d.path, { modules: MODULES });
  state.bind(d.channel, d.dir);
  state.openThread(d.channel, "thread-old");
  state.setStatusPending(d.channel, "thread-old", "waiting");
  d.adopt("thread-old", 1_000_000_000);
  const order: string[] = [];
  d.onRepair = () => order.push("repair");
  const recording: SignalSource = {
    on: (signal, listener) => {
      order.push("signal");
      d.signals.on(signal, listener);
    },
    off: (signal, listener) => d.signals.off(signal, listener),
  };

  d.start({ signals: recording });
  await d.booted();
  assert.deepEqual(order, ["signal", "signal", "repair"]); // SIGTERM and SIGINT, both before repair
  await d.stop();
});

test("a start keeps a thread whose session the back end no longer lists", async (t) => {
  // #148: the thread's messages remain in the channel, so the cleanup at start leaves it, and
  // drops only a thread that never started a session.
  const d = new Daemon(t);
  const state = new StateStore(d.path, { modules: MODULES });
  state.bind(d.channel, d.dir);
  state.openThread(d.channel, "thread-1", "gone");
  state.openThread(d.channel, "thread-old-2");
  // Both are over a day old: only the one with no session is dropped.
  d.adopt("thread-1", 1_000_000_000);
  d.adopt("thread-old-2", 1_000_000_000);
  d.backend.listed = [];

  d.start();
  await d.booted();
  const after = new StateStore(d.path, { modules: MODULES });
  assert.equal(after.thread(d.channel, "thread-1")?.sessionId, "gone");
  assert.equal(after.thread(d.channel, "thread-old-2"), null);
  await d.stop();
});

// The stop, the process and the entry point.

test("a stop by SIGTERM lets running turns finish and SIGINT does not", async (t) => {
  const infos = written(t, logger, "info");
  const d = new Daemon(t);
  d.start();
  await d.booted();
  await d.stop("SIGTERM");
  assert.deepEqual(
    infos().filter((line) => line.startsWith("stopping") || line === "shutting down"),
    ["stopping: letting running turns finish", "shutting down"],
  );

  const second = new Daemon(t);
  const again = written(t, logger, "info");
  second.start();
  await second.booted();
  await second.stop("SIGINT");
  assert.deepEqual(
    again().filter((line) => line.startsWith("stopping") || line === "shutting down"),
    ["shutting down"],
  );
});

test("a stop closes the connection before the last page of the session index", async (t) => {
  const d = new Daemon(t);
  d.onClose = () => d.events.push("close");
  d.start();
  await d.booted();
  // The chat is closed after the connection and the sessions: its last page shows them as they ended.
  await d.stop();
  assert.deepEqual(d.events, ["connect", "app.stop", "close"]);
});

test("a signal during the repair stops the daemon once it is up", async (t) => {
  const d = new Daemon(t);
  const state = new StateStore(d.path, { modules: MODULES });
  state.bind(d.channel, d.dir);
  state.openThread(d.channel, "thread-old");
  state.setStatusPending(d.channel, "thread-old", "waiting");
  d.adopt("thread-old", 1_000_000_000);
  d.onRepair = () => d.signals.emit("SIGTERM"); // while the repair runs
  await d.start();
  assert.deepEqual(d.events, ["connect", "app.stop"]);
});

test("a start that fails still shuts down", async (t) => {
  const d = new Daemon(t);
  d.startFails = new Error("invalid_auth");
  const before = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  await assert.rejects(d.start(), /invalid_auth/);
  // The connection is closed, the cleanup's schedule ended, the lock released.
  assert.deepEqual(d.events, ["connect", "app.stop"]);
  assert.equal(
    process.getActiveResourcesInfo().filter((name) => name === "Timeout").length,
    before,
  );
  await (await singleInstance(d.dir)).release();
});

test("nothing is left to keep the process alive after a stop", async (t) => {
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const d = new Daemon(t);
  const before = timers();
  d.start();
  await d.booted();
  assert.ok(timers() > before, "the daemon holds a timer of its own while it runs");
  await d.stop();
  assert.equal(timers(), before);
  assert.equal(d.signals.listenerCount("SIGTERM"), 0);
  assert.equal(d.signals.listenerCount("SIGINT"), 0);
});

test("a stop by a signal ends the process with 0", async (t) => {
  const d = new Daemon(t);
  const exits: number[] = [];
  const running = main({
    ...d.options(),
    exit: (code) => exits.push(code),
    process: new EventEmitter(),
    later: () => () => {},
  });
  await d.connected.wait();
  d.signals.emit("SIGTERM");
  await running;
  assert.deepEqual(exits, [0]);
});

// The end of the process (F1 part c): `run` returned, yet something still holds the event loop,
// and launchd would see a live job and start nothing.

/** A deadline `main` asked `later` for. */
interface Deadline {
  readonly seconds: number;
  readonly action: () => void;
  /** The daemon's clock when it was asked for. */
  readonly at: number;
  cancelled: boolean;
}

/** The seconds of the deadlines that were not cancelled. */
function standing(timers: readonly Deadline[]): number[] {
  return timers.filter((timer) => !timer.cancelled).map((timer) => timer.seconds);
}

/**
 * `main` over the daemon, with a `later` that keeps what it was asked instead of arming a timer.
 * With `onClock`, a deadline that is not cancelled also fires when the daemon's fake clock reaches
 * it, as the real timer would.
 */
function mainOf(
  d: Daemon,
  events: EventEmitter = new EventEmitter(),
  onClock = false,
  extra: RunOptions = {},
) {
  const exits: number[] = [];
  const timers: Deadline[] = [];
  const running = main({
    ...d.options(extra),
    exit: (code) => exits.push(code),
    process: events,
    later: (seconds, action) => {
      const deadline: Deadline = { seconds, action, at: d.clock.now, cancelled: false };
      timers.push(deadline);
      const cancel = new AbortController();
      if (onClock) {
        d.clock.sleep(seconds, cancel.signal).then(action, () => undefined);
      }
      return () => {
        deadline.cancelled = true;
        cancel.abort();
      };
    },
  });
  return { exits, timers, running, events };
}

test("a stop ends the process with 0 as soon as the daemon has stopped", async (t) => {
  const d = new Daemon(t);
  const { exits, timers, running } = mainOf(d);
  const warnings = written(t, logger, "warning");
  await d.connected.wait();
  d.signals.emit("SIGTERM");
  assert.deepEqual(exits, []); // not before the stop is over
  await running;
  assert.deepEqual(exits, [0]);
  // The shutdown armed its deadline and ended before it: one stands, `exit` was not left to it.
  assert.deepEqual(standing(timers), [SHUTDOWN_LIMIT_SECONDS]);
  assert.deepEqual(warnings(), []);
  // Everything the daemon made was closed first: the lock is free for the next one.
  await (await singleInstance(d.dir)).release();
});

test("the timer that ends the process does not keep it alive", () => {
  const timer = deferred(60, () => {});
  try {
    assert.equal(timer.hasRef(), false);
  } finally {
    clearTimeout(timer);
  }
});

test("an unexpected error ends with 1 and logs only its name", async (t) => {
  const d = new Daemon(t);
  d.startFails = new ChatError("invalid_auth", { cause: new Error("xox" + "b-secret") });
  const errors = written(t, logger, "error");
  const exits: number[] = [];
  await main({ ...d.options(), exit: (code) => exits.push(code), process: new EventEmitter() });
  assert.deepEqual(exits, [1]);
  assert.deepEqual(errors(), ["stopped by an unexpected error: invalid_auth"]);
});

test("an agent setting that cannot be used ends with 1 and logs its sentence", async (t) => {
  const d = new Daemon(t);
  const errors = written(t, logger, "error");
  const exits: number[] = [];
  const options = d.options();
  const registry: Registry = {
    ...(options.registry as Registry),
    agents: {
      claude: {
        required: [],
        optional: [],
        tools: NO_TOOL_WORDS,
        toolNames: [],
        limitsHeading: "Limits of a test agent",
        words: { names: [], literals: [], patterns: [] },
        build: () => {
          throw new AgentConfigError("SETTING must be an absolute path");
        },
      },
    },
  };
  await main({
    ...options,
    registry,
    exit: (code) => exits.push(code),
    process: new EventEmitter(),
  });
  assert.deepEqual(exits, [1]);
  assert.deepEqual(errors(), ["SETTING must be an absolute path"]);
  // The lock is free again for the next start.
  await (await singleInstance(d.dir)).release();
});

test("a rejection and an exception nobody handled are logged by name, and the exception alone stops the daemon", (t) => {
  const errors = written(t, logger, "error");
  const events = new EventEmitter();
  let stops = 0;
  installProcessHandlers(events, () => {
    stops += 1;
  });
  const secret = new TypeError(`could not read ${"xox" + "b-secret"}`);
  events.emit("unhandledRejection", secret);
  events.emit("unhandledRejection", "a thrown string");
  events.emit("uncaughtException", secret);
  assert.deepEqual(errors(), [
    "unhandled rejection: TypeError",
    "unhandled rejection: string",
    "uncaught exception: TypeError",
  ]);
  assert.equal(stops, 1);
});

// S1: what the daemon does with an error nobody handled. A rejected promise is a piece of work
// that failed with nobody waiting for it, and the daemon logs it and goes on: Node only ends
// the process for it when no listener is set. An uncaught exception leaves the process in
// a state Node documents as unsafe to resume from, so it takes the path of a SIGINT and exits
// 1: launchd starts a clean daemon and the crash repair runs.

test("an uncaught exception stops the daemon as a SIGINT does and exits with 1", async (t) => {
  const infos = written(t, logger, "info");
  const d = new Daemon(t);
  const { exits, timers, running, events } = mainOf(d);
  await d.connected.wait();
  events.emit("uncaughtException", new TypeError("boom"));
  await running;
  // No drain, the connection closed, and the lock released.
  assert.deepEqual(
    infos().filter((line) => line.startsWith("stopping") || line === "shutting down"),
    ["shutting down"],
  );
  assert.deepEqual(d.events, ["connect", "app.stop"]);
  await (await singleInstance(d.dir)).release();
  assert.equal(d.signals.listenerCount("SIGTERM"), 0);
  // Exit 1 at once: a timer that does not keep the process alive could not give the code.
  assert.deepEqual(exits, [1]);
  // The only timer is the deadline of the stop, which the stop beat.
  assert.deepEqual(
    timers.map((timer) => timer.seconds),
    [SHUTDOWN_LIMIT_SECONDS],
  );
});

test("an unhandled rejection is logged and the daemon goes on", async (t) => {
  const errors = written(t, logger, "error");
  const d = new Daemon(t);
  const { exits, timers, running, events } = mainOf(d);
  await d.connected.wait();
  events.emit("unhandledRejection", new TypeError("boom"));
  await tick();
  assert.deepEqual(errors(), ["unhandled rejection: TypeError"]);
  // Still up: nothing stopped, no deadline armed, the lock still held.
  assert.deepEqual(d.events, ["connect"]);
  assert.deepEqual(exits, []);
  assert.deepEqual(timers, []);
  await assert.rejects(singleInstance(d.dir), AlreadyRunning);
  // And it still stops the ordinary way, with 0.
  d.signals.emit("SIGTERM");
  await running;
  assert.deepEqual(exits, [0]);
});

test("a stop after a failure that does not finish ends the process with 1", async (t) => {
  const errors = written(t, logger, "error");
  const d = new Daemon(t);
  const hung = new AsyncEvent();
  t.mock.method(d.receiver, "stop", async () => {
    await hung.wait(); // a connection that does not close
  });
  const { exits, timers, running, events } = mainOf(d);
  await d.connected.wait();
  events.emit("uncaughtException", new TypeError("boom"));
  await tick();
  // The stop is stuck: the process is not ended yet, and the deadline is armed.
  assert.deepEqual(exits, []);
  assert.deepEqual(
    timers.map((timer) => timer.seconds),
    [SHUTDOWN_LIMIT_SECONDS],
  );
  timers[0]?.action();
  assert.deepEqual(exits, [1]);
  assert.ok(errors().some((line) => line.includes("did not finish")));
  hung.set(); // let the test's own run end
  await running;
});

// C7: a signal's stop has a limit on a shutdown that makes no progress. A word of the daemon
// (`/status`, the setup of a thread) starts the agent outside the worker, and
// `ThreadSession.close` waits for that start without a signal. The limit is
// `SHUTDOWN_LIMIT_SECONDS` since the last step of the shutdown that completed, so a long shutdown
// that goes on (many replies to end) is not cut. A stop that a failure asked for has one deadline,
// at the failure, which a step does not move.

/** A daemon with a thread whose `/status` started the agent and has not been answered. */
async function holdingAStart(t: TestContext) {
  const starting = new AsyncEvent();
  const d = new Daemon(t, { scripts: [{ startGate: starting }] });
  const thread = "thread-1";
  const state = new StateStore(d.path, { modules: MODULES });
  state.bind(d.channel, d.dir);
  state.openThread(d.channel, thread, "some-id");
  d.adopt(thread);
  d.backend.listed = [{ id: "some-id" } as never];
  const made = mainOf(d, new EventEmitter(), true);
  await d.connected.wait();
  void d.says("/status", thread).catch(() => undefined);
  await d.until(() => d.backend.sessions.length === 1);
  t.after(async () => {
    starting.set(); // a failed assertion must not leave the stop waiting on the start
    await made.running;
  });
  return { d, starting, ...made };
}

test("a stop by a signal that waits on a start of the agent ends the process after the limit", async (t) => {
  const errors = written(t, logger, "error");
  const { d, exits, timers } = await holdingAStart(t);
  const hung = new AsyncEvent();
  t.mock.method(d.receiver, "stop", async () => {
    await hung.wait(); // a connection that takes 20 seconds to close
  });
  d.signals.emit("SIGTERM");
  await d.until(() => timers.length > 0); // the shutdown has begun, stuck on the connection
  await d.clock.advance(20);
  hung.set(); // the last step that completes: the shutdown then waits on the start
  await d.clock.advance(0);
  await realWorkDone(HELD);
  assert.deepEqual(exits, []);
  assert.equal(standing(timers).length, 1);
  // Thirty seconds after the step, not after the shutdown began.
  await d.clock.advance(SHUTDOWN_LIMIT_SECONDS - 1);
  assert.deepEqual(exits, []);
  await d.clock.advance(2);
  assert.deepEqual(exits, [1]);
  assert.ok(errors().some((line) => line.includes("did not finish")));
});

test("the limit of a stop by a signal starts once the drain is over", async (t) => {
  const messages = sdkMessages("tools");
  const thread = "thread-1";
  const d = new Daemon(t, { scripts: [{ turns: [messages.slice(0, -1)] }] });
  const state = new StateStore(d.path, { modules: MODULES });
  state.bind(d.channel, d.dir);
  state.openThread(d.channel, thread, "some-id");
  d.adopt(thread);
  d.backend.listed = [{ id: "some-id" } as never];
  const { exits, timers, running } = mainOf(d);
  t.after(async () => {
    d.signals.emit("SIGINT"); // a failed assertion must not leave the drain waiting
    await running;
  });
  await d.connected.wait();
  void d.says("go", thread).catch(() => undefined);
  await d.until(() => d.backend.sessions[0]?.queries.join() === "go");
  d.signals.emit("SIGTERM"); // the turn never ends: the drain waits
  await d.clock.advance(0); // the drain has started its limit
  await d.clock.advance(DRAIN_LIMIT_SECONDS - 1);
  // Past the limit a failure's stop has, and no deadline: the drain is not cut by it.
  assert.equal(timers.length, 0);
  assert.equal(exits.length, 0);
  await d.clock.advance(2); // the drain's limit
  await d.until(() => exits.length > 0); // the replies' last writes wait on the clock
  await running;
  assert.deepEqual(exits, [0]);
  assert.deepEqual(standing(timers), [SHUTDOWN_LIMIT_SECONDS]);
});

test("a shutdown that makes progress is not cut by the limit however long it takes", async (t) => {
  // Each reply to end costs the chat 2 s of the fake clock, as the rationed writes of a rate
  // limiter do: 20 sessions take 40 s.
  const sessions = 20;
  const messages = sdkMessages("tools");
  const d = new Daemon(t, {
    scripts: Array.from({ length: sessions }, () => ({ turns: [messages.slice(0, -1)] })),
  });
  const state = new StateStore(d.path, { modules: MODULES });
  const threads: string[] = [];
  for (let i = 0; i < sessions; i += 1) {
    const folder = join(d.dir, `project-${i}`);
    mkdirSync(folder);
    const thread = `thread-${i + 1}`;
    state.bind(d.channel, folder); // a folder of its own for each: no same-folder hold
    state.openThread(d.channel, thread, `id-${i}`);
    d.adopt(thread);
    threads.push(thread);
  }
  d.backend.listed = threads.map((_, i) => ({ id: `id-${i}` }) as never);
  const { exits, timers, running } = mainOf(d, new EventEmitter(), true);
  t.after(async () => {
    // A failed assertion leaves the daemon up: its shutdown needs the clock to go on, so the
    // clock is driven here until `main` has returned.
    d.signals.emit("SIGINT");
    let returned = false;
    void running.finally(() => {
      returned = true;
    });
    for (let i = 0; i < 4000 && !returned; i += 1) {
      await d.clock.advance(0.5);
      await realWorkDone(HELD);
    }
  });
  await d.connected.wait();
  for (const thread of threads) void d.says("go", thread).catch(() => undefined);
  await d.until(() => d.backend.sessions.every((session) => session.queries.join() === "go"));
  // The chat rations the end of each reply: two seconds apiece, one after the other.
  d.chat.pace = 2;
  const replies = () => d.chat.written(d.channel).filter((message) => message.kind === "reply");
  await d.until(() => replies().length >= sessions);
  const ended = () => replies().filter((message) => !message.unfinished).length;
  const before = ended();
  const began = d.clock.now;
  d.signals.emit("SIGINT");
  for (let i = 0; i < 4000 && exits.length === 0; i += 1) {
    await d.clock.advance(0.5);
    await realWorkDone(HELD);
  }
  assert.deepEqual(exits, [0]);
  assert.ok(d.clock.now - began > SHUTDOWN_LIMIT_SECONDS, "the shutdown must outlast the limit");
  assert.equal(ended() - before, sessions);
  assert.deepEqual(new StateStore(d.path, { modules: MODULES }).repairsPending(), []);
  // Every step moved the deadline, and the last one stands unfired.
  assert.ok(timers.length > sessions);
  assert.deepEqual(standing(timers), [SHUTDOWN_LIMIT_SECONDS]);
});

test("a failure during a signal's shutdown makes its deadline the one a failure has", async (t) => {
  const d = new Daemon(t);
  const hung = new AsyncEvent();
  t.mock.method(d.receiver, "stop", async () => {
    await hung.wait();
  });
  const { exits, timers, running, events } = mainOf(d, new EventEmitter(), true);
  t.after(async () => {
    hung.set();
    await running;
  });
  await d.connected.wait();
  d.signals.emit("SIGINT");
  await d.clock.advance(10); // stuck on the connection since the first step
  assert.equal(standing(timers).length, 1);
  events.emit("uncaughtException", new TypeError("boom"));
  const armed = timers.length;
  assert.deepEqual(standing(timers), [SHUTDOWN_LIMIT_SECONDS]);
  assert.equal(timers.at(-1)?.at, 10); // from the failure
  hung.set(); // the steps that follow do not move it
  await d.clock.advance(0);
  await realWorkDone(HELD);
  assert.equal(timers.length, armed);
  await running;
  assert.deepEqual(exits, [1]);
});

test("a failure during the drain ends it as a second signal does", async () => {
  const source = new EventEmitter();
  const stop = new StopSignals(source as SignalSource);
  source.emit("SIGTERM");
  await stop.requested;
  let cut: AbortSignal | null = null;
  const draining = stop.drain(
    (signal) =>
      new Promise<void>((resolve) => {
        cut = signal;
        signal.addEventListener("abort", () => resolve());
      }),
    new FakeClock(),
    DRAIN_LIMIT_SECONDS,
  );
  await tick();
  assert.equal((cut as AbortSignal | null)?.aborted, false);
  stop.fail();
  await draining;
  assert.equal((cut as AbortSignal | null)?.aborted, true);
  assert.equal(stop.failed, true);
  stop.dispose();
});

test("a request is a SIGTERM's stop: counted as one, the drain of a stop that lets turns finish", async () => {
  const source = new EventEmitter();
  const stop = new StopSignals(source as SignalSource);
  stop.request();
  await stop.requested;
  assert.deepEqual(stop.received, ["SIGTERM"]);
  assert.equal(stop.failed, false);
  let drained = false;
  await stop.drain(
    async () => {
      drained = true;
    },
    new FakeClock(),
    DRAIN_LIMIT_SECONDS,
  );
  assert.equal(drained, true);
  stop.dispose();
});

test("a request once a stop was asked changes nothing", async () => {
  for (const first of ["SIGTERM", "SIGINT", "request", "fail"] as const) {
    const source = new EventEmitter();
    const stop = new StopSignals(source as SignalSource);
    if (first === "request") stop.request();
    else if (first === "fail") stop.fail();
    else source.emit(first);
    const before = [...stop.received];
    const failed = stop.failed;
    stop.request();
    assert.deepEqual(stop.received, before, first);
    assert.equal(stop.failed, failed, first);
    stop.dispose();
  }
});

test("a request during the drain does not cut it short", async () => {
  const source = new EventEmitter();
  const stop = new StopSignals(source as SignalSource);
  source.emit("SIGTERM");
  await stop.requested;
  let cut: AbortSignal | null = null;
  const draining = stop.drain(
    (signal) =>
      new Promise<void>((resolve) => {
        cut = signal;
        signal.addEventListener("abort", () => resolve());
      }),
    new FakeClock(),
    DRAIN_LIMIT_SECONDS,
  );
  await tick();
  stop.request();
  await tick();
  assert.equal((cut as AbortSignal | null)?.aborted, false);
  source.emit("SIGINT");
  await draining;
  stop.dispose();
});

test("a failure with no stop under way asks for one", async () => {
  const source = new EventEmitter();
  const stop = new StopSignals(source as SignalSource);
  stop.fail();
  await stop.requested;
  assert.equal(stop.failed, true);
  // It is a SIGINT's stop: no drain.
  assert.deepEqual(stop.received, ["SIGINT"]);
  stop.dispose();
});

test("a failure that came before the signals were installed stops the daemon once it is up", async (t) => {
  const d = new Daemon(t);
  const crash = new AbortController();
  crash.abort();
  const code = await d.start({ failure: crash.signal });
  assert.equal(code, 1);
  assert.deepEqual(d.events, ["connect", "app.stop"]);
});

test("run answers 0 for a stop by a signal", async (t) => {
  const d = new Daemon(t);
  d.start();
  await d.booted();
  assert.equal(await d.stop("SIGTERM"), 0);
});

test("a second signal ends the drain", async () => {
  const source = new EventEmitter();
  const stop = new StopSignals(source as SignalSource);
  const clock = new FakeClock();
  source.emit("SIGTERM");
  await stop.requested;
  let cut: AbortSignal | null = null;
  const draining = stop.drain(
    (signal) =>
      new Promise<void>((resolve) => {
        cut = signal;
        signal.addEventListener("abort", () => resolve());
      }),
    clock,
    DRAIN_LIMIT_SECONDS,
  );
  await tick();
  assert.equal((cut as AbortSignal | null)?.aborted, false);
  source.emit("SIGINT");
  await draining;
  assert.equal((cut as AbortSignal | null)?.aborted, true);
  assert.deepEqual(stop.received, ["SIGTERM", "SIGINT"]);
  stop.dispose();
  assert.equal(source.listenerCount("SIGTERM"), 0);
});

test("the drain ends at its limit", async () => {
  const source = new EventEmitter();
  const stop = new StopSignals(source as SignalSource);
  const clock = new FakeClock();
  let ended = false;
  const draining = stop.drain(
    (signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => {
          ended = true;
          resolve();
        }),
      ),
    clock,
    DRAIN_LIMIT_SECONDS,
  );
  await clock.advance(DRAIN_LIMIT_SECONDS - 1);
  assert.equal(ended, false);
  await clock.advance(1);
  await draining;
  assert.equal(ended, true);
  stop.dispose();
});

test("a drain that ends first leaves no wait behind", async () => {
  const source = new EventEmitter();
  const stop = new StopSignals(source as SignalSource);
  const waits: AbortSignal[] = [];
  const clock: Clock = {
    // A wait that only its signal ends, as a timer that has not run out.
    sleep: (_seconds, signal) =>
      new Promise((_, reject) => {
        waits.push(signal as AbortSignal);
        signal?.addEventListener("abort", () => reject(signal.reason));
      }),
    time: () => 0,
  };
  await stop.drain(async () => {}, clock, DRAIN_LIMIT_SECONDS);
  assert.equal(waits.length, 1);
  assert.equal(waits[0]?.aborted, true);
  stop.dispose();
});

test("a signal before the drain starts is counted and does not cut it", async () => {
  // A second signal during a long repair must not be lost.
  const source = new EventEmitter();
  const stop = new StopSignals(source as SignalSource);
  source.emit("SIGTERM");
  source.emit("SIGTERM");
  let cut = false;
  await stop.drain(
    async (signal) => {
      cut = signal.aborted;
    },
    new FakeClock(),
    DRAIN_LIMIT_SECONDS,
  );
  assert.equal(cut, false);
  assert.deepEqual(stop.received, ["SIGTERM", "SIGTERM"]);
  stop.dispose();
});

// F1: a listener still in flight when the stop ends. The owner's message is held on the channel
// check (`conversations.members`), the stop arrives, `run` returns, and the check is let go: the
// listener must not start a session, write `state.json` or call the chat. With the real back end a
// session started then keeps the Node process alive, and launchd, which sees a live job, starts
// nothing.

const IN_THREAD = "thread-1";

/** The channel bound, and a thread in it on a session the agent still lists (the prune keeps it). */
function storedThread(d: Daemon): void {
  const state = new StateStore(d.path, { modules: MODULES });
  state.bind(d.channel, d.dir);
  state.openThread(d.channel, IN_THREAD, "some-id");
  d.adopt(IN_THREAD);
  d.backend.listed = [
    { id: "some-id", title: "t", customTitle: null, branch: null, size: null, lastModified: 1 },
  ];
}

for (const [text, signal] of [
  ["/help", "SIGTERM"],
  ["/bypass on", "SIGTERM"],
  ["/status", "SIGTERM"],
  ["hello", "SIGINT"],
] as const) {
  test(`a listener still on the channel check does nothing once the daemon stopped [${text}]`, async (t) => {
    const d = new Daemon(t);
    storedThread(d);
    d.start();
    await d.booted();
    assert.equal(await d.stop(signal), 0);
    const file = readFileSync(d.path, "utf8");
    const shown = d.chat.written(d.channel).length;
    // The view records what the daemon asks of the chat (the start's pages are there), so a call
    // made for the late message would show in it.
    const made = d.chat.calls().length;
    assert.ok(made > 0, "the chat records no call");
    // The owner's message reaches the daemon only now: the listener was held until the stop ended.
    await (d.inbound as ChatInbound).message({
      ref: { channel: d.channel, thread: IN_THREAD },
      id: "msg-held",
      topLevel: false,
      text,
      plain: text,
      bare: text,
      literal: false,
      content: async () => text,
    });
    await tick();
    assert.deepEqual(d.backend.sessions, [], "an agent session was started after the stop");
    assert.equal(readFileSync(d.path, "utf8"), file, "state.json was written after the stop");
    assert.equal(d.chat.written(d.channel).length, shown, "the chat was written to after the stop");
    // `statusMark` only words a line: the held `/status` asks for it, and writes nothing.
    assert.deepEqual(
      d.chat
        .calls()
        .slice(made)
        .map((call) => call.call)
        .filter((call) => call !== "statusMark"),
      [],
      "the chat was called after the stop",
    );
  });
}

test("no agent process starts while the machine's update lock is held, and one starts when it is let go", async (t) => {
  const d = new Daemon(t, { scripts: [{ turns: [sdkMessages("tools")] }] });
  storedThread(d);
  d.start();
  await d.booted();
  // Another instance's click, or `pardner update` in a terminal, holds it.
  const update = await updateLock(d.home);
  try {
    await d.says("hello", IN_THREAD);
    await realWorkDone(HELD);
    assert.deepEqual(d.backend.sessions, [], "an agent process started during an update");
  } finally {
    await update.release();
  }
  await d.says("hello again", IN_THREAD);
  await d.until(() => d.backend.sessions.length > 0);
  await d.stop();
});

test("run as the entry point reports a missing configuration and exits 1", (t) => {
  const home = mkdtempSync(join(tmpdir(), "pardner-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".config"), { recursive: true });
  const result = spawnSync(process.execPath, [join(ROOT, "src", "main.ts")], {
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /ERROR pardner\.main: .*\.env does not exist; see https:\/\/github\.com\/duqaXxX\/pardner\/blob\/v[\d.]+\/docs\/setup\.md#part-2-configuration/,
  );
  assert.equal(result.stderr.trim().split("\n").length, 1);
});
