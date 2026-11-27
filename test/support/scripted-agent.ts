/**
 * The scripted Claude back end of the tests: a `FakeAgentBackend` whose sessions play the turns of
 * a `Script`. It imports nothing of a chat, so a test of the engine, the daemon or the probe can
 * take it without loading a chat; `sessions.ts` puts a chat in front of it.
 *
 * The fake stands at the agent seam, and a script is made of recordings: each wire record goes
 * through the session's own `Translator` (the real one, as the live session does it), so a text
 * streamed and then repeated reaches the core once and a replayed prompt is `prompt_taken`. A
 * script can also hold a session event as it is, a request put to the handler the core passed to
 * `start`, a hook's run, and the end of the stream.
 *
 * `sdkMessages` gives a recording as one item per message the Python SDK parsed: it parsed no
 * `command_lifecycle` and no `tool_progress` record (checked on every recording,
 * claude-agent-sdk 0.2.165), so an index into the list is the message's index in that SDK's.
 */
import { NAME, WORDS } from "../../src/agent/claude/backend.ts";
import { CAPABILITIES } from "../../src/agent/claude/capabilities.ts";
import {
  postModelSwitchHookEvents,
  postToolUseHookEvents,
  stopHookEvents,
} from "../../src/agent/claude/hooks.ts";
import { agentInfo, contextUsage } from "../../src/agent/claude/info.ts";
import { toRequest } from "../../src/agent/claude/requests.ts";
import { TOOLS } from "../../src/agent/claude/tools.ts";
import { Translator } from "../../src/agent/claude/translate.ts";
import { locate, Unkeyed } from "../../src/agent/claude/trust.ts";
import type {
  AgentBackend,
  AgentInfo,
  AgentSession,
  Capabilities,
  ClosedReport,
  ContextUsage,
  ListedSession,
  PermissionAnswer,
  PermissionRequest,
  Prompt,
  PromptContent,
  QuestionAnswer,
  QuestionRequest,
  Repository,
  RequestHandler,
  SessionEvent,
  StartOptions,
} from "../../src/agent/seam.ts";
import { PROCESS_EXITED } from "../../src/core/sessions/constants.ts";
import { named } from "../../src/core/texts.ts";
import type { AsyncEvent } from "./fake-clock.ts";
import { type JsonObject, sdkJson, sdkRecords } from "./fixtures.ts";
import { NAMES } from "./names.ts";

/** A point in a scripted turn where the CLI would ask the host for a permission decision. */
export interface CanUseToolCall {
  readonly toolName: string;
  readonly input: JsonObject;
  readonly callId: string;
  /** The request's own signal, which a test aborts as the SDK does when it gives a request up. */
  readonly abort?: AbortController;
}

/** One step of a script. */
export type Item =
  /** A wire record of a recording, read by the session's translator. */
  | { readonly record: JsonObject }
  /** A session event as it is. */
  | { readonly event: SessionEvent }
  /** The CLI asks for a permission decision, and waits for it before it goes on. */
  | { readonly ask: CanUseToolCall }
  /**
   * The same request, made while the stream goes on. `ClaudeSession` reads its stream and serves
   * `canUseTool` independently (the SDK calls the callback from its own task), so a process can
   * end with a request still waiting: `ask` cannot play that, since it holds the stream.
   */
  | { readonly request: CanUseToolCall }
  /**
   * The CLI runs the host's hooks: Stop before the result, PostToolUse after a tool,
   * PostModelSwitch before the result of a `/model` command.
   */
  | { readonly hook: HookName; readonly input: JsonObject }
  /** The CLI process exits and its stream ends. */
  | { readonly end: true };

export type Batch = readonly Item[];

type HookName = "Stop" | "PostToolUse" | "PostModelSwitch";

const HOOK_EVENTS = {
  Stop: stopHookEvents,
  PostToolUse: postToolUseHookEvents,
  PostModelSwitch: postModelSwitchHookEvents,
};

// The records the Python SDK's parser gave no message for.
const UNPARSED = new Set(["command_lifecycle", "tool_progress"]);

/** A recording as one item per message the Python SDK parsed. */
export function sdkMessages(name: string): Item[] {
  return sdkRecords(name)
    .filter((record) => !UNPARSED.has(String(record.type)))
    .map((record) => ({ record }));
}

/** The record of an item, or null for an item that is none. */
export function recordOf(item: Item | undefined): JsonObject | null {
  return item !== undefined && "record" in item ? item.record : null;
}

/** Whether the item is a record of that type, and of that subtype when one is given. */
export function isRecord(item: Item | undefined, type: string, subtype?: string): boolean {
  const record = recordOf(item);
  return (
    record !== null && record.type === type && (subtype === undefined || record.subtype === subtype)
  );
}

/** Whether the item is a result record. */
export function isResult(item: Item | undefined): boolean {
  return isRecord(item, "result");
}

/** Whether the item is a `system` record of that subtype. */
export function isSystem(item: Item | undefined, subtype: string): boolean {
  return isRecord(item, "system", subtype);
}

/** The turns of a script: cut after each result. */
export function splitTurns(items: readonly Item[]): Item[][] {
  const turns: Item[][] = [[]];
  for (const item of items) {
    turns.at(-1)?.push(item);
    if (isResult(item)) turns.push([]);
  }
  return turns.filter((turn) => turn.length > 0);
}

export function canUseToolCall(toolName: string, input: JsonObject, callId = "toolu_fake_1"): Item {
  return { ask: { toolName, input, callId } };
}

export function requestWhileStreaming(
  toolName: string,
  input: JsonObject,
  callId = "toolu_fake_1",
  abort?: AbortController,
): Item {
  return { request: { toolName, input, callId, ...(abort !== undefined && { abort }) } };
}

export function hookRun(input: JsonObject, hook: HookName = "Stop"): Item {
  return { hook, input };
}

export const END_OF_STREAM: Item = { end: true };

export function event(sessionEvent: SessionEvent): Item {
  return { event: sessionEvent };
}

// The items a prompt's replay goes before: the first stream event, assistant, user or result
// message of the turn.
const WORDED_RECORDS = new Set(["stream_event", "assistant", "user", "result"]);
const WORDED_EVENTS = new Set<SessionEvent["type"]>([
  "message_started",
  "message_ended",
  "text_started",
  "text_delta",
  "text",
  "call_started",
  "call_ended",
  "agent_error",
  "turn_ended",
]);

function worded(item: Item): boolean {
  if ("record" in item) return WORDED_RECORDS.has(String(item.record.type));
  return "event" in item && WORDED_EVENTS.has(item.event.type);
}

/** What a scripted session is given. */
export interface Script {
  readonly turns?: readonly Batch[];
  /** The answer to `info()`; the recorded `server-info.json`, started in `default`, when absent. */
  readonly info?: AgentInfo;
  readonly contextUsage?: ContextUsage;
  /** `start` rejects with it. */
  readonly startError?: Error;
  /** A start that waits for the test, as a CLI does while it starts. */
  readonly startGate?: AsyncEvent;
  readonly infoError?: Error;
  readonly contextUsageError?: Error;
  /** The answer to each `advisor()`, asked at every read; none set when absent. */
  readonly advisor?: () => string | null;
  readonly advisorError?: Error;
  /** `close` rejects with it. */
  readonly closeError?: Error;
  /** A close that waits for the test, as a CLI takes real time to flush and exit after EOF. */
  readonly closeGate?: AsyncEvent;
}

const CLOSED = Symbol("closed");

/**
 * A feed of batches for one reader. A batch put while the reader waits reaches it on the next
 * turn of the event loop (`setImmediate`): what the test, or the session that just sent a prompt,
 * does next in the same step comes first.
 */
class Feed {
  readonly #items: Array<Batch | typeof CLOSED> = [];
  #wake: (() => void) | null = null;

  put(item: Batch | typeof CLOSED): void {
    this.#items.push(item);
    const wake = this.#wake;
    this.#wake = null;
    if (wake !== null) setImmediate(wake);
  }

  async get(): Promise<Batch | typeof CLOSED> {
    while (this.#items.length === 0) {
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
    return this.#items.shift() as Batch | typeof CLOSED;
  }
}

function defaultInfo(): AgentInfo {
  const recorded = sdkJson("server-info") as JsonObject;
  return agentInfo({
    commands: recorded.commands,
    models: recorded.models,
    current_permission_mode: "default",
  });
}

/** Stands in for a live agent session at the seam and plays scripted turns. */
export class FakeAgentSession implements AgentSession {
  readonly options: StartOptions;
  readonly events: AsyncIterable<SessionEvent>;
  readonly #requests: RequestHandler;
  readonly #script: Script;
  readonly #turns: Batch[];
  readonly #feed = new Feed();
  readonly #translator = new Translator();
  connected = false;
  /** Each prompt as sent: its text, or the parts of a prompt with an image. */
  queries: PromptContent[] = [];
  /** Every prompt as sent, id included. */
  sent: Prompt[] = [];
  modes: string[] = [];
  modelsSet: Array<string | null> = [];
  effortsSet: Array<string | null> = [];
  interrupts = 0;
  stoppedTasks: string[] = [];
  advisorReads = 0;
  /** What the core answered each request with, in order. */
  permissionResults: Array<PermissionAnswer | QuestionAnswer> = [];

  constructor(options: StartOptions, requests: RequestHandler, script: Script = {}) {
    this.options = options;
    this.#requests = requests;
    this.#script = script;
    this.#turns = [...(script.turns ?? [])];
    this.events = this.#stream();
  }

  async send(prompt: Prompt): Promise<void> {
    this.sent.push(prompt);
    this.queries.push(prompt.content);
    this.#translator.promptSent(prompt.id);
    const batch = this.#turns.shift();
    if (batch !== undefined) this.#feed.put(this.#replayed(batch, prompt));
  }

  /**
   * `batch` with the replay of the prompt it answers, as Claude Code sends it with
   * `--replay-user-messages`: a `user` record of the prompt's text under the id it was sent
   * with, after the turn's `init` and before its first words (recorded 2026-10-06, CLI 2.1.286,
   * and 2026-10-09, 2.1.292). A command is not replayed so (`compact.jsonl`), and a prompt with
   * an image was never recorded: those turns are played as scripted.
   */
  #replayed(batch: Batch, prompt: Prompt | undefined): Batch {
    if (prompt === undefined) return batch;
    const { content } = prompt;
    if (typeof content !== "string" || content.trimStart().startsWith("/")) return batch;
    const found = batch.findIndex(worded);
    const at = found === -1 ? batch.length : found;
    const replay: Item = {
      record: {
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        uuid: prompt.id,
      },
    };
    return [...batch.slice(0, at), replay, ...batch.slice(at)];
  }

  /**
   * Deliver the turn of the last prompt sent, with its replay, when the test rather than
   * `turns` holds that turn.
   */
  answer(batch: Batch): void {
    this.#feed.put(this.#replayed(batch, this.sent.at(-1)));
  }

  /** Deliver a turn nobody asked for, as the CLI does for a background-task notification. */
  inject(batch: Batch): void {
    this.#feed.put(batch);
  }

  async *#stream(): AsyncGenerator<SessionEvent> {
    for (;;) {
      const batch = await this.#feed.get();
      if (batch === CLOSED) return;
      for (const item of batch) {
        if ("end" in item) {
          yield { type: "process_lost", reason: named(PROCESS_EXITED, NAMES) };
          return;
        }
        if ("ask" in item) {
          this.permissionResults.push(await this.#ask(item.ask));
        } else if ("request" in item) {
          this.#ask(item.request).then(
            (answer) => this.permissionResults.push(answer),
            (error: unknown) => {
              // Nobody awaits this call, so a rejection would vanish: make it an uncaught error.
              setImmediate(() => {
                throw error;
              });
            },
          );
        } else if ("hook" in item) {
          yield* HOOK_EVENTS[item.hook](item.input);
        } else if ("record" in item) {
          yield* this.#translator.translate(item.record);
        } else {
          yield item.event;
        }
      }
    }
  }

  /** The request the back end makes of a permission callback, put to the core's handler. */
  #ask(call: CanUseToolCall): Promise<PermissionAnswer | QuestionAnswer> {
    // As the back end does: a call no record named (its start is not on `events`) is no call.
    const mapped = toRequest(
      call.toolName,
      call.input,
      { toolUseID: call.callId },
      (id) => this.#translator.started(id),
      (name) => this.#translator.verbOf(name),
    );
    const signal = (call.abort ?? new AbortController()).signal;
    if (mapped.type === "question") {
      const request: QuestionRequest = { ...mapped, toolName: call.toolName, title: null };
      return this.#requests.question(request, signal);
    }
    const request: PermissionRequest = mapped;
    return this.#requests.permission(request, signal);
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.modes.push(mode);
  }

  async setModel(model: string | null): Promise<void> {
    this.modelsSet.push(model);
  }

  async setEffort(level: string | null): Promise<void> {
    this.effortsSet.push(level);
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  async stopTask(taskId: string): Promise<void> {
    this.stoppedTasks.push(taskId);
  }

  async info(): Promise<AgentInfo> {
    if (this.#script.infoError !== undefined) throw this.#script.infoError;
    return this.#script.info ?? defaultInfo();
  }

  async contextUsage(): Promise<ContextUsage> {
    if (this.#script.contextUsageError !== undefined) throw this.#script.contextUsageError;
    return this.#script.contextUsage ?? contextUsage(sdkJson("context-usage"));
  }

  async advisor(): Promise<string | null> {
    this.advisorReads += 1;
    if (this.#script.advisorError !== undefined) throw this.#script.advisorError;
    return this.#script.advisor?.() ?? null;
  }

  async close(): Promise<ClosedReport> {
    if (this.#script.closeGate !== undefined) await this.#script.closeGate.wait();
    this.connected = false;
    this.#feed.put(CLOSED);
    if (this.#script.closeError !== undefined) throw this.#script.closeError;
    return { unsaved: null };
  }
}

/** `trust.trusted_repository` for a test about something else: every repository counts as trusted. */
export async function anyRepository(directory: string): Promise<Repository | null> {
  try {
    return await locate(directory);
  } catch (error) {
    if (error instanceof Unkeyed) return null;
    throw error;
  }
}

/** The back end of a harness: each `start` plays the next script. */
export class FakeAgentBackend implements AgentBackend {
  readonly name = NAME;
  readonly words = WORDS;
  readonly tools = TOOLS;
  capabilities: Capabilities = CAPABILITIES_FOR_TESTS;
  /** Every session started, in order; one whose start failed is there too. */
  readonly sessions: FakeAgentSession[] = [];
  /** What `listSessions` answers for a folder. */
  listed: ListedSession[] = [];
  /** The members of the listing, the trust and the usage limits called, in order. */
  readonly called: string[] = [];
  trusted: (folder: string) => Promise<boolean> = async () => true;
  repository: (folder: string) => Promise<Repository | null> = (folder) => anyRepository(folder);
  readonly #scripts: Script[];

  constructor(scripts: readonly Script[]) {
    this.#scripts = [...scripts];
  }

  async start(options: StartOptions, requests: RequestHandler): Promise<AgentSession> {
    const script = this.#scripts.shift() ?? {};
    const session = new FakeAgentSession(options, requests, script);
    this.sessions.push(session);
    if (script.startGate !== undefined) await script.startGate.wait();
    if (script.startError !== undefined) throw script.startError;
    session.connected = true;
    return session;
  }

  async listSessions(_folder: string): Promise<readonly ListedSession[]> {
    this.called.push("listSessions");
    return this.listed;
  }

  async datedSessions(
    _folder: string,
    sessions: readonly ListedSession[],
  ): Promise<ListedSession[]> {
    this.called.push("datedSessions");
    return [...sessions].sort((a, b) => b.lastModified - a.lastModified);
  }

  folderTrusted(folder: string): Promise<boolean> {
    this.called.push("folderTrusted");
    return this.trusted(folder);
  }

  trustedRepository(folder: string): Promise<Repository | null> {
    this.called.push("trustedRepository");
    return this.repository(folder);
  }

  untrustedRepository(_folder: string): Promise<Repository | null> {
    this.called.push("untrustedRepository");
    return Promise.resolve(null);
  }

  async close(): Promise<void> {}
}

// The Claude back end's capabilities, with the effort levels the seam asks a back end to name
// (`EffortLevel` of the SDK, as `src/agent/claude/session.ts` lists them).
const CAPABILITIES_FOR_TESTS: Capabilities = {
  ...CAPABILITIES,
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
};
