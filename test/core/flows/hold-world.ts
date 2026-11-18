/**
 * What the tests of the hold and of the setup share: the message flows over the memory chat and a
 * real `SessionManager` driving a scripted agent, in a folder of its own, with the `Holds` and the
 * clock within reach. The memory chat records the root status calls (`rootStatus`) and the
 * acknowledgements, a link to a thread is drawn as `[label]` so that a test reads the label the
 * core gave it, and a notice escapes `<` and `>` as a chat with markup does. The folder has a
 * second channel bound to it and a third bound to a folder of its own.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { AgentBackend, PromptContent } from "../../../src/agent/seam.ts";
import type {
  ChatInbound,
  ChatProvider,
  InboundMessage,
  Markup,
  OwnerAnswer,
  SetupSelection,
  ThreadChat,
  ThreadRef,
} from "../../../src/chat/seam.ts";
import { buildFlows } from "../../../src/core/flows/flows.ts";
import type { FlowDeps } from "../../../src/core/flows/talk.ts";
import { Holds } from "../../../src/core/hold.ts";
import { Approvals } from "../../../src/core/requests.ts";
import { SessionManager } from "../../../src/core/sessions/manager.ts";
import type { ThreadSession } from "../../../src/core/sessions/session.ts";
import { StateStore } from "../../../src/core/state.ts";
import { namesOf } from "../../../src/core/texts.ts";
import { type AsyncEvent, FakeClock } from "../../support/fake-clock.ts";
import { type MemoryChat, memoryChat, OWNER } from "../../support/memory-chat.ts";
import { NO_SYNC } from "../../support/no-sync.ts";
import { hold, PlainAgent, type PlainSession } from "../../support/plain-agent.ts";
import { settledTurn } from "../../support/settle.ts";
import { STATE_MODULES } from "../../support/state-modules.ts";

/** What a test can change in the thread chat's calls before they reach the memory chat. */
export interface Hooks {
  /** Runs after the question was posted and before `ask` returns it to the core. */
  afterAsk?: (ref: ThreadRef) => void | Promise<void>;
  /** `ask` rejects for a request of this type, as a chat that could not post. */
  askFails?: (type: string) => boolean;
  /** `ask` of a hold returns only once set: the question is posted, and the core does not know it yet. */
  holdGate?: AsyncEvent;
  /** `rewrite` of a message runs only once set: a setup's summary, say. */
  rewriteGate?: AsyncEvent;
  /** `tell` posts nothing, as the seam lets a chat that could not post: nobody is left to tell. */
  tellFails?: boolean;
  /** The texts `tell` was called with while `tellFails` was set. */
  readonly attempts: string[];
  /** The type of every request asked, in order. */
  readonly questions: string[];
}

export interface HoldWorldOptions {
  /** The agent: the plain one by default. */
  readonly agent?: AgentBackend;
  /** False for a chat that cannot rewrite a message once its reply ended (`MemoryChatOptions.edits`). */
  readonly edits?: boolean;
}

/** The status the chat shows on the root of `ref` after the calls it recorded; null when none. */
export function standing(chat: MemoryChat, ref: ThreadRef): string | null {
  let shown: string | null = null;
  for (const call of chat.calls()) {
    if (call.ref?.channel !== ref.channel || call.ref.thread !== ref.thread) continue;
    if (call.call === "showStatus") shown = String(call.args[0]);
    if (call.call === "clearStatus") shown = null;
  }
  return shown;
}

/** The statuses `showStatus` was called with on `ref`, in order. */
export function shownStatuses(chat: MemoryChat, ref: ThreadRef): string[] {
  return chat
    .calls("showStatus")
    .filter((call) => call.ref?.channel === ref.channel && call.ref.thread === ref.thread)
    .map((call) => String(call.args[0]));
}

function hooked(inner: ChatProvider, hooks: Hooks): ChatProvider {
  return new Proxy(inner, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      // A chat whose notices have markup: a mention or a mark in the owner's words must not act.
      if (property === "escape") {
        return (text: string, markup: Markup) =>
          markup === "notice" ? text.replaceAll("<", "&lt;").replaceAll(">", "&gt;") : text;
      }
      if (property !== "thread") return typeof member === "function" ? member.bind(target) : member;
      return (ref: ThreadRef): ThreadChat =>
        new Proxy(target.thread(ref), {
          get(thread, name) {
            const value = Reflect.get(thread, name, thread);
            if (name === "link") return async (label: string) => `[${label}]`;
            if (name === "ask") {
              return async (...args: Parameters<ThreadChat["ask"]>) => {
                const { type } = args[1];
                hooks.questions.push(type);
                if (hooks.askFails?.(type) === true) throw new Error("the chat is down");
                const shown = await thread.ask(...args);
                await hooks.afterAsk?.(ref);
                if (type === "hold") await hooks.holdGate?.wait();
                return shown;
              };
            }
            if (name === "rewrite" && hooks.rewriteGate !== undefined) {
              const gate = hooks.rewriteGate;
              return async (...args: Parameters<ThreadChat["rewrite"]>) => {
                await gate.wait();
                return thread.rewrite(...args);
              };
            }
            if (name === "tell" && hooks.tellFails === true) {
              return async (text: string) => {
                hooks.attempts.push(text);
              };
            }
            return typeof value === "function" ? value.bind(thread) : value;
          },
        });
    },
  });
}

/** A message the test writes itself, as a provider would hand it over. */
export interface Own {
  readonly ref: ThreadRef;
  readonly id: string;
  readonly topLevel?: boolean;
  readonly text: string;
  readonly literal?: boolean;
  readonly content?: () => Promise<PromptContent | null>;
}

export class HoldWorld {
  readonly folder: string;
  readonly chat: MemoryChat;
  readonly agent: AgentBackend;
  readonly state: StateStore;
  readonly holds = new Holds();
  readonly sessions: SessionManager;
  /** The channel bound to `folder`. */
  readonly channel: string;
  /** A second channel bound to the same folder. */
  readonly sameFolder: string;
  /** A channel bound to a folder of its own. */
  readonly elsewhere: string;
  readonly inbound: ChatInbound;
  readonly stopping = new AbortController();
  readonly clock = new FakeClock();
  readonly provider: ChatProvider;
  readonly hooks: Hooks;

  private constructor(
    folder: string,
    chat: MemoryChat,
    provider: ChatProvider,
    agent: AgentBackend,
    hooks: Hooks,
  ) {
    this.folder = folder;
    this.chat = chat;
    this.agent = agent;
    this.hooks = hooks;
    this.state = new StateStore(join(folder, "state.json"), {
      modules: STATE_MODULES,
      sync: NO_SYNC,
    });
    this.channel = chat.openChannel("work");
    this.sameFolder = chat.openChannel("same");
    this.elsewhere = chat.openChannel("other");
    mkdirSync(join(folder, "other"));
    this.state.bind(this.channel, folder);
    this.state.bind(this.sameFolder, folder);
    this.state.bind(this.elsewhere, join(folder, "other"));
    const names = namesOf(agent, provider);
    const approvals = new Approvals(names);
    this.provider = hooked(provider, hooks);
    this.sessions = new SessionManager({
      chat: this.provider,
      agent,
      state: this.state,
      approvals,
      holds: this.holds,
      usage: null,
      clock: this.clock,
    });
    const deps: FlowDeps = {
      chat: this.provider,
      agent,
      sessions: this.sessions,
      state: this.state,
      approvals,
      holds: this.holds,
      names,
      allowedRoot: folder,
      shellCommands: true,
      stopped: this.stopping.signal,
      now: () => 1_780_000_000,
      clock: this.clock,
    };
    this.inbound = buildFlows(deps).inbound;
  }

  /** A world over the memory chat, with the plain agent unless `options.agent` names another. */
  static async make(t: TestContext, options: HoldWorldOptions = {}): Promise<HoldWorld> {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "pardner-hold-")));
    const chat = memoryChat({
      rootStatus: true,
      acknowledgement: true,
      ...(options.edits === undefined ? {} : { edits: options.edits }),
    });
    const provider = await chat.build({
      variables: {},
      allowedRoot: folder,
      scratchDir: join(folder, "scratch"),
      clock: { sleep: async () => {}, time: () => 1_780_000_000 },
      steady: { sleep: async () => {}, time: () => 1_780_000_000 },
      core: () => {
        throw new Error("the memory chat never reads the core");
      },
    });
    const world = new HoldWorld(folder, chat, provider, options.agent ?? new PlainAgent(), {
      attempts: [],
      questions: [],
    });
    await world.provider.start(world.inbound);
    t.after(async () => {
      // A block that failed on an assertion leaves its gates shut: open them, or `closeAll`
      // waits for ever on what they hold and the rest of the file never reports.
      world.hooks.holdGate?.set();
      world.hooks.rewriteGate?.set();
      (world.agent as { openGates?: () => void }).openGates?.();
      await world.sessions.closeAll();
      await world.provider.stop();
      rmSync(folder, { recursive: true, force: true });
    });
    return world;
  }

  /** The type of every request asked of the owner, in order. */
  get questions(): readonly string[] {
    return this.hooks.questions;
  }

  /** The owner writes `text` in `channel` (the main one when absent), or inside `thread`. */
  says(text: string, thread?: string, channel = this.channel) {
    return this.chat.as(OWNER).says(channel, text, thread === undefined ? undefined : { thread });
  }

  /** Lets what is ready run, and what it starts. */
  async settle(rounds = 30): Promise<void> {
    for (let round = 0; round < rounds; round += 1) await settledTurn();
  }

  /** Waits until a thread (`ref`, or any) has an open request of `type` and returns it. */
  async asked(type: string, ref?: ThreadRef) {
    for (let round = 0; round < 200; round += 1) {
      const found = this.chat
        .requests()
        .find((r) => (ref === undefined || r.ref.thread === ref.thread) && r.request.type === type);
      if (found !== undefined) return found;
      await settledTurn();
    }
    throw new Error(`no ${type} request was asked`);
  }

  /** The requests of `type` open now. */
  open(type: string, ref?: ThreadRef) {
    return this.chat
      .requests()
      .filter((r) => (ref === undefined || r.ref.thread === ref.thread) && r.request.type === type);
  }

  /** The owner's message handed to the flow as the test wrote it, to slow its files down. */
  send(own: Own): Promise<void> {
    return this.inbound.message({
      ref: own.ref,
      id: own.id,
      topLevel: own.topLevel ?? false,
      text: own.text,
      plain: own.text,
      bare: own.text,
      literal: own.literal ?? false,
      content: own.content ?? (async () => own.text),
    } satisfies InboundMessage);
  }

  /** The owner presses Start on the setup asked in `ref`, with the controls as given. */
  async start(ref: ThreadRef, selection: Partial<SetupSelection> = {}): Promise<void> {
    const open = await this.asked("setup", ref);
    await this.chat.as(OWNER).answers(open.requestId, {
      type: "setup",
      selection: { model: "default", effort: "default", bypass: false, ...selection },
    });
  }

  /** The owner answers the open hold of `ref`. */
  answerHold(ref: ThreadRef, send: boolean): Promise<boolean | null> {
    return this.answer(ref, "hold", { type: "hold", send });
  }

  private async answer(ref: ThreadRef, type: string, answer: OwnerAnswer) {
    const open = await this.asked(type, ref);
    return this.chat.as(OWNER).answers(open.requestId, answer);
  }

  /**
   * The first message of a new thread of `channel`, its setup answered with the defaults: the
   * thread, once the message went on (the prompt reached the agent, or the hold asks).
   */
  async opened(prompt: string, channel = this.channel): Promise<ThreadRef> {
    const sending = this.says(prompt, undefined, channel);
    const { ref } = await this.asked("setup");
    await this.start(ref);
    await sending;
    await this.settle();
    return ref;
  }

  /**
   * A thread of the folder whose first turn does not end: the agent's next turn holds. Returns
   * its thread and the plain session that runs it, once it works.
   */
  async busy(prompt = "busy elsewhere", channel = this.channel) {
    (this.agent as PlainAgent).next(hold());
    const ref = await this.opened(prompt, channel);
    const session = this.sessions.get(ref.channel, ref.thread);
    if (session === null || !session.busy) throw new Error("the neighbour does not work");
    const process = (this.agent as PlainAgent).sessions.at(-1);
    if (process === undefined) throw new Error("the neighbour has no process");
    return { ref, session, process };
  }

  /**
   * The first message of a new thread of `channel` while another session works in the folder:
   * its setup answered, the hold open. `sending` ends when the message did.
   */
  async held(prompt = "hello", channel = this.channel) {
    const sending = this.says(prompt, undefined, channel);
    const { ref } = await this.asked("setup");
    await this.start(ref);
    const question = await this.asked("hold", ref);
    return { ref, sending, question };
  }

  /** The live session of an existing thread. */
  session(ref: ThreadRef): ThreadSession {
    const session = this.sessions.get(ref.channel, ref.thread);
    if (session === null) throw new Error("the thread has no live session");
    return session;
  }

  /** The plain agent's process n (the last when absent). */
  process(index?: number): PlainSession {
    const found = (this.agent as PlainAgent).sessions.at(index ?? -1);
    if (found === undefined) throw new Error("no agent process");
    return found;
  }

  /** The prompts the agent got, as text, over every process, once what is queued was sent. */
  async prompts(): Promise<string[]> {
    await this.settle(10);
    return (this.agent as PlainAgent).sessions.flatMap((s) =>
      s.prompts.map((prompt) =>
        typeof prompt.content === "string"
          ? prompt.content
          : prompt.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
      ),
    );
  }

  /** What `ref` shows, as text. */
  shown(ref: ThreadRef): readonly string[] {
    return this.chat.texts(ref.channel, ref.thread);
  }

  /** What the thread's stored record says it waits for and shows. */
  stored(ref: ThreadRef) {
    return this.state.thread(ref.channel, ref.thread);
  }
}
