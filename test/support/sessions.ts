/**
 * The harness of the session tests: a real `SessionManager` over the scripted agent back end
 * (`scripted-agent.ts`, re-exported here) and a chat the test gives it. `harnessFor` runs it on
 * the memory chat with the relay's capability set (`RELAY_SET`, which `memoryChats` starts from) unless the test passes a chat of
 * its own: the memory chat with more capabilities on.
 *
 * Two clocks, both fake. `clock` is the sessions' own (`INJECTED_TURN_WAIT`, the idle close, the
 * drain's poll): what a test moves with `advance` to cross a wait of the sessions.
 * `chatClock` is the chat's (a reply's debounce and deadline, the status line's refresh).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { AgentAccount } from "../../src/agent/seam.ts";
import type { ChatCapabilities, ChatProvider, ThreadRef } from "../../src/chat/seam.ts";
import { UsageCache } from "../../src/core/footer.ts";
import { Holds } from "../../src/core/hold.ts";
import { Approvals } from "../../src/core/requests.ts";
import type { SessionDeps } from "../../src/core/sessions/deps.ts";
import { SessionManager } from "../../src/core/sessions/manager.ts";
import type { ThreadSession } from "../../src/core/sessions/session.ts";
import { StateStore } from "../../src/core/state.ts";
import { setWriter } from "../../src/log.ts";
import type { MemoryChat, MemoryChatOptions } from "./memory-chat.ts";
import { memoryChats } from "./memory-session-chat.ts";
import { NAMES } from "./names.ts";
import { NO_SYNC } from "./no-sync.ts";
import { FakeAgentBackend, type FakeAgentSession, type Script } from "./scripted-agent.ts";

export * from "./scripted-agent.ts";

export {
  heldByARunningDaemon,
  realWorkDone,
  SettledClock,
  settledTurn,
} from "./settle.ts";

import { realWorkDone, SettledClock } from "./settle.ts";
import { STATE_MODULES } from "./state-modules.ts";

/**
 * The chat of one harness, as the harness reads it.
 */
export interface SessionChat {
  /** What the sessions' deps are given as their chat. */
  readonly chat: ChatProvider;
  /** The memory chat's room, which a test reads and plays the owner through. */
  readonly room: MemoryChat | null;
  /** The channel the harness binds to its folder, and the thread `session()` opens by default. */
  readonly channel: string;
  readonly thread: string;
  /** What the daemon has written so far, one text per message, in the order it was written. */
  texts(): string[];
  /** The chat's own clock. */
  readonly clock: SettledClock;
  /**
   * The listener's word to the chat that the owner posted in `thread`, before the core sees the
   * message.
   */
  heard(channel: string, thread: string): void;
}

/** What `harnessFor` needs of a chat: the chat of each harness, and what a test starts clear. */
export interface ChatSetup {
  make(backend: FakeAgentBackend, options: HarnessOptions): SessionChat;
  /** Clears what the chat keeps for the process; called once per test, before its first harness. */
  reset(): void;
}

export interface HarnessOptions {
  /** The reply's debounce, in seconds on `chatClock`. */
  readonly debounceSeconds?: number;
  readonly finalRetrySeconds?: number;
  readonly tasksKept?: number;
  readonly taskRepliesKept?: number;
  /**
   * What the sessions' chat declares instead of the provider's own. The sessions then write
   * through a facade that records every call (`Harness.chatCalls`); without it they get the
   * provider itself.
   */
  readonly chatCapabilities?: Partial<ChatCapabilities>;
  /** `null`: no usage cache in the sessions' deps, as for an agent with no limits. */
  readonly usage?: null;
}

/**
 * `target` with every member called and every property read reported; `wrap` replaces what a
 * member returns (a thread's reply, recorded in turn).
 */
function recording<T extends object>(
  target: T,
  seen: {
    readonly call: (name: string, args: readonly unknown[]) => void;
    readonly read: (name: string) => void;
  },
  wrap: (name: string, value: unknown) => unknown = (_name, value) => value,
): T {
  return new Proxy(target, {
    get(object, name) {
      const value = Reflect.get(object, name);
      if (typeof name !== "string") return value;
      if (typeof value !== "function") {
        seen.read(name);
        return value;
      }
      return (...args: unknown[]) => {
        seen.call(name, args);
        return wrap(name, value.apply(object, args));
      };
    },
  });
}

export class Harness {
  readonly #world: SessionChat;
  /** The channel bound to `tmpPath`, and the thread `session()` opens by default. */
  readonly channel: string;
  readonly thread: string;
  /** A scratch folder, bound to `CHANNEL`, with its symlinks resolved. */
  readonly tmpPath: string;
  readonly state: StateStore;
  readonly approvals = new Approvals(NAMES);
  readonly holds = new Holds();
  readonly backend: FakeAgentBackend;
  /** The sessions' own clock. */
  readonly clock = new SettledClock();
  /** The wall time the sessions read (`deps.now`): the real one until a test sets it. */
  wall: number | null = null;
  /** The chat's clock. */
  readonly chatClock: SettledClock;
  readonly chat: ChatProvider;
  readonly deps: SessionDeps;
  manager: SessionManager;
  usageFetches = 0;
  /** The account the next usage fetch names; a test sets it. */
  usageAccount: AgentAccount | null = null;
  /** The usage cache of the sessions' deps; throws when the harness was made with none. */
  get usage(): UsageCache {
    if (this.deps.usage === null) throw new Error("the harness has no usage cache");
    return this.deps.usage;
  }

  /** The members of the sessions' threads and replies called, when `chatCapabilities` is set. */
  readonly chatCalls: string[] = [];
  /** The properties of those threads read. */
  readonly chatReads: string[] = [];
  /** Every text handed to a reply, as the core handed it. */
  readonly replyTexts: string[] = [];

  constructor(
    setup: ChatSetup,
    tmpPath: string,
    scripts: readonly Script[],
    options: HarnessOptions,
  ) {
    this.tmpPath = tmpPath;
    this.backend = new FakeAgentBackend(scripts);
    this.#world = setup.make(this.backend, options);
    this.channel = this.#world.channel;
    this.thread = this.#world.thread;
    this.state = new StateStore(join(tmpPath, "state.json"), {
      modules: STATE_MODULES,
      sync: NO_SYNC,
    });
    this.state.bind(this.channel, tmpPath);
    this.chatClock = this.#world.clock;
    this.chat = this.#world.chat;
    this.deps = {
      chat:
        options.chatCapabilities === undefined
          ? this.chat
          : this.declaring(options.chatCapabilities),
      agent: this.backend,
      state: this.state,
      approvals: this.approvals,
      usage:
        options.usage === null
          ? null
          : new UsageCache(async () => {
              this.usageFetches += 1;
              return {
                session: { percent: 5, resetsAt: null },
                week: null,
                account: this.usageAccount,
              };
            }),
      holds: this.holds,
      clock: this.clock,
      now: () => this.wall ?? Date.now(),
      updating: async () => this.updatingElsewhere,
      ...(options.tasksKept !== undefined && { tasksKept: options.tasksKept }),
      ...(options.taskRepliesKept !== undefined && { taskRepliesKept: options.taskRepliesKept }),
    };
    this.manager = new SessionManager(this.deps);
  }

  /** The provider as the sessions see it when the test chooses what the chat declares. */
  private declaring(declared: Partial<ChatCapabilities>): ChatProvider {
    const capabilities = { ...this.chat.capabilities, ...declared };
    const seen = {
      call: (name: string, args: readonly unknown[]) => {
        this.chatCalls.push(name);
        if (name === "text" && typeof args[0] === "string") this.replyTexts.push(args[0]);
      },
      read: (name: string) => {
        this.chatReads.push(name);
      },
    };
    const reply = (name: string, value: unknown): unknown =>
      name === "openReply" ? recording(value as object, seen) : value;
    return new Proxy(this.chat, {
      get: (object, name) => {
        if (name === "capabilities") return capabilities;
        if (name !== "thread") {
          const value = Reflect.get(object, name);
          return typeof value === "function" ? value.bind(object) : value;
        }
        return (ref: ThreadRef) => recording(object.thread(ref), seen, reply);
      },
    });
  }

  /** What the sessions are told when they ask whether another process updates pardner. */
  updatingElsewhere = false;

  /** The memory chat behind the harness (its room and the calls it recorded). */
  get room(): MemoryChat {
    if (this.#world.room === null) throw new Error("the harness's chat is not the memory chat");
    return this.#world.room;
  }

  /** A restart of the daemon: every session closed, then a new manager on the same state. */
  async restart(): Promise<void> {
    await this.manager.closeAll();
    this.manager = new SessionManager(this.deps);
  }

  /** Every agent session started, in order: the back end's `sessions`. */
  get clients(): FakeAgentSession[] {
    return this.backend.sessions;
  }

  /** The live session of `thread`, opened as a top-level owner message would. */
  session(thread: string = this.thread): ThreadSession {
    const session = this.manager.open(this.channel, thread);
    if (session === null) throw new Error("the channel is not bound");
    this.#hear(session, thread);
    return session;
  }

  #heard = new WeakSet<ThreadSession>();

  /**
   * In production the listener tells the provider of every owner message before the core sees
   * it (`SessionChat.heard`). The tests call the session's methods behind the listener, so
   * a prompt or a command given through them tells the provider the same way, at a ts after
   * everything the thread holds.
   */
  #hear(session: ThreadSession, thread: string): void {
    if (this.#heard.has(session)) return;
    this.#heard.add(session);
    const owner = session as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of ["submit", "status", "stop", "setBypass", "switchBypass"] as const) {
      const original = owner[name]?.bind(session);
      if (original === undefined) throw new Error(`a session has no ${name}`);
      owner[name] = (...args: unknown[]) => {
        this.#world.heard(this.channel, thread);
        return original(...args);
      };
    }
  }

  /** The text every posted message ends up showing, in the order they were posted. */
  replies(): string[] {
    return this.#world.texts();
  }

  /**
   * Each reply's own text: `replies()` with the empty entries a silent closing message leaves
   * (it carries no markdown or tool line) filtered out.
   */
  bodies(): string[] {
    return this.replies().filter((reply) => reply !== "");
  }

  /**
   * Let what is ready run to its next wait: every promise callback, and every task that starts
   * on a later turn of the event loop. What a test awaits for the daemon to have acted.
   * Real work the daemon started (a file read, the footer's `git`) is waited for too: its
   * answer comes from the operating system, not from a turn of the loop, so no number of turns
   * stands for it on a loaded machine.
   */
  async idle(): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await realWorkDone();
  }

  /**
   * A pause of `seconds` as the daemon sees it: what is ready runs, and the chat's clock moves on by
   * `seconds`, a hundredth at a time. The sessions' clock stays put. A step ends with the real
   * work it set going done (`SettledClock`), so a pause is never over before an end of turn
   * that was under way has landed: what a pause asserts afterwards is what it asserted when
   * the footer's `git` answered at once.
   */
  async sleep(seconds: number): Promise<void> {
    await this.idle();
    for (let waited = 0; waited < seconds - 1e-9; waited += 0.01) {
      await this.chatClock.advance(0.01);
    }
  }

  /**
   * Wait for a condition on the fakes by polling it: what is ready runs, and the chat's clock
   * moves on a hundredth of a second at a time, for two seconds at most, so a reply's debounce
   * passes while it polls. The sessions' clock stays put.
   * Each step also yields a moment of real time on top of the real work it waits for
   * (`SettledClock`): some of what a test waits for ends in real file reads and a `git`
   * subprocess, and a loaded machine must not use up the steps first.
   */
  async until(condition: () => boolean, limit = 2.0): Promise<void> {
    await this.idle();
    for (let waited = 0; !condition(); waited += 0.01) {
      if (waited >= limit) throw new Error("the condition never held");
      await this.chatClock.advance(0.01);
      if (!condition()) await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
  }
}

/**
 * A harness maker for one test: each harness it made has its manager closed and its folder
 * removed when the test ends.
 */
export function harnessFor(
  t: TestContext,
  options: HarnessOptions = {},
  setup: ChatSetup = memoryChats(),
): ((...scripts: Script[]) => Harness) & { readonly tmpPath: string } {
  const made: Harness[] = [];
  const tmpPath = realpathSync(mkdtempSync(join(tmpdir(), "awd-sessions-")));
  setup.reset();
  // The daemon's log stays out of the test report: a test that reads a line
  // replaces the logger's method (`mock.method`), which this does not touch.
  const writer = setWriter(() => {});
  // A timer that keeps the loop alive for the test's duration: on Node 22 a test that awaits
  // something which never comes, with only unref'd timers pending, lets the process finish and
  // cancels the rest of the file. With this it waits for the runner's own timeout instead.
  const guard = setInterval(() => {}, 1_000);
  t.after(async () => {
    clearInterval(guard);
    for (const harness of made) await harness.manager.closeAll();
    rmSync(tmpPath, { recursive: true, force: true });
    setWriter(writer);
  });
  // `tmpPath` is there before any harness, for a test that arranges the folder first.
  return Object.assign(
    (...scripts: Script[]) => {
      const harness = new Harness(setup, tmpPath, scripts, options);
      made.push(harness);
      return harness;
    },
    { tmpPath },
  );
}

/** `harnessFor` on the memory chat, with the capabilities a test reads turned on. */
export function memoryHarnessFor(
  t: TestContext,
  options: HarnessOptions = {},
  chat: MemoryChatOptions = {},
): ReturnType<typeof harnessFor> {
  return harnessFor(t, options, memoryChats(chat));
}
