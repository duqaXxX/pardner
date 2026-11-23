/**
 * The session harness over the relay (plan 3.1): a real relay process, alice's scripted device and
 * the bot's `RelayProvider` as the chat of `harnessFor`, with the core's own `buildFlows` as what
 * the provider hands alice's prompts and answers to. alice's device reads back what the relay holds.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { TestContext } from "node:test";
import type { QuestionRequest } from "../../../../src/agent/seam.ts";
import { RelayProvider } from "../../../../src/chat/relay/provider.ts";
import { buildFlows } from "../../../../src/core/flows/flows.ts";
import { botOn, hex, incarnation, rig } from "../../../chat/relay/relay-rig.ts";
import { platform } from "../../../relay/support.ts";
import { fill } from "../../../relay/world.ts";
import { type JsonObject, sdkJson } from "../../../support/fixtures.ts";
import { NAMES } from "../../../support/names.ts";
import { type ChatSetup, type Harness, type Item, sdkMessages } from "../../../support/sessions.ts";
import { SettledClock } from "../../../support/settle.ts";

/** The thread of alice's first prompt: her device's id and the name she gave it, as the core names it. */
const NAME = fill(200, 16);
/** The name of alice's first prompt, in hex: the `re` of its answer. */
export const FIRST = hex(NAME);
const threadOfFirst = (r: Awaited<ReturnType<typeof rig>>) => hex(r.alice.first.id) + FIRST;

/** What alice's device reads from the relay, decoded. */
export interface Read {
  /** The setup request's edits (kind 11). */
  setup: { edits: { re: string; body: JsonObject }[] };
  /** The bot's texts (kind 1). */
  texts: { name: string; body: JsonObject }[];
  /** The parts of replies (kind 4), in the relay's order, with the answer each names. */
  parts: { re: string; body: JsonObject }[];
  /** The bot's answers (kind 5): the name each has and the prompt or reply it answers. */
  answers: { name: string; re: string; body: JsonObject }[];
  /** The requests to alice (kind 9), by name. */
  requests: { name: string; body: JsonObject }[];
  /** The edits of requests (kind 11): the request each names. */
  edits: { re: string; body: JsonObject }[];
}

/**
 * The session chat of the relay: made before the harness, since `harnessFor` takes a `ChatSetup`.
 * `connect` starts the bot's connection, `attach` wires the core's flows once the harness exists.
 */
export async function relayWorld(t: TestContext) {
  const r = await rig();
  const b = botOn(r);
  const provider = new RelayProvider(r.botId, b.outbox, b.inbound, platform);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await provider.stop();
    await b.stop();
    await r.stop();
    rmSync(r.dir, { recursive: true, force: true });
  };
  const channel = hex(r.channel);
  const thread = threadOfFirst(r);
  const setup: ChatSetup = {
    make: () => ({
      chat: provider,
      room: null,
      channel,
      thread,
      texts: () => [],
      clock: new SettledClock(),
      heard: () => {},
    }),
    reset: () => {},
  };
  const stopping = new AbortController();
  // A test that throws before `attach` registers the ordered stop still stops the relay process.
  let attached = false;
  t.after(() => (attached ? undefined : stop()));
  const setups = new Set<string>(); // the names of the setup requests
  const mine = new Set<string>(); // the names of alice's own replies: the answers to them are the bot's about them
  let counter = 0;
  const world = {
    r,
    b,
    provider,
    setup,
    channel,
    thread,
    /** The bot connects and reads to the relay's end. */
    async connect() {
      b.connection.start();
      await b.rested();
    },
    /**
     * Opens the way to the core: the flows of the harness's own sessions, state and approvals.
     * Registered after the harness's own cleanup, so the sessions close before the relay stops.
     */
    async attach(h: Harness) {
      const flows = buildFlows({
        chat: provider,
        agent: h.backend,
        sessions: h.manager,
        state: h.state,
        approvals: h.approvals,
        holds: h.holds,
        names: { ...NAMES, chat: "the relay chat" },
        allowedRoot: h.tmpPath,
        shellCommands: false,
        stopped: stopping.signal,
        now: () => Date.now() / 1000,
      });
      await provider.start(flows.inbound);
      t.after(async () => {
        stopping.abort();
        await stop();
      });
      attached = true;
    },
    /**
     * alice writes a prompt: the first one at the top of the channel under the name `FIRST`; a later
     * one, by default, in the first one's thread; or in the thread `where`, or at the top of the
     * channel (`null`). The name it is sent under.
     */
    async prompt(text: string, where?: string | null) {
      counter += 1;
      const first = counter === 1 && where === undefined;
      const name = first ? NAME : fill(200 + counter, 16);
      const inThread = where === undefined ? (first ? null : thread) : where;
      await r.send(
        { to: r.botId, incarnation: incarnation(b), name },
        inThread === null ? { text } : { text, thread: inThread },
      );
      return hex(name);
    },
    /**
     * alice's first prompt, and her answer to the session's setup, which every first prompt of a
     * thread is met with: the setup request and its answer are the seam's too, and `read` leaves
     * them out so that the blocks read the request they play.
     */
    async begin(text: string) {
      await world.prompt(text);
      await b.until(async () =>
        (await r.held()).messages.some((m) => m.kind === 9 && !setups.has(hex(m.name))),
      );
      const held = await r.held();
      const asked = held.messages.find(
        (m) => m.kind === 9 && !setups.has(hex(m.name)),
      ) as (typeof held.messages)[number];
      const request = r.body(asked).request as { type: string; selection: unknown };
      assert.equal(request.type, "setup");
      setups.add(hex(asked.name));
      await world.answer(hex(asked.name), { type: "setup", selection: request.selection });
      await world.until((read) => read.setup.edits.length === 1);
    },
    /** alice answers the request `name` of the bot's. */
    async answer(name: string, answer: object) {
      const sent = await r.send(
        { kind: 10, to: r.botId, re: { device: r.botId, name: Buffer.from(name, "hex") } },
        { answer },
      );
      mine.add(sent.name);
      return sent;
    },
    /** Waits until the bot has queued its answer to alice's reply `name`: the relay holds a kind 5 for it. */
    async replyAnswered(name: string) {
      await b.until(async () =>
        (await r.held()).messages.some(
          (m) => m.kind === 5 && hex(m.re?.name ?? new Uint8Array()) === name,
        ),
      );
    },
    /** Waits (in real time, polling the relay) until what alice reads satisfies `done`. */
    async until(done: (read: Read) => boolean) {
      await b.until(async () => done(await world.read()));
    },
    /** What alice's device reads back now, less the setup's request, its edit and the answers to alice's replies. */
    async read(): Promise<Read> {
      const held = await r.held();
      const of = (kind: number) => held.messages.filter((m) => m.kind === kind);
      const name = (m: { name: Uint8Array }) => hex(m.name);
      const re = (m: { re?: { name: Uint8Array } }) => hex(m.re?.name ?? new Uint8Array());
      const requests = of(9).filter((m) => !setups.has(name(m)));
      return {
        setup: {
          edits: of(11)
            .filter((m) => setups.has(re(m)))
            .map((m) => ({ re: re(m), body: r.body(m) as JsonObject })),
        },
        texts: of(1).map((m) => ({ name: name(m), body: r.body(m) as JsonObject })),
        parts: of(4).map((m) => ({ re: re(m), body: r.body(m) as JsonObject })),
        answers: of(5)
          .filter((m) => !mine.has(re(m)))
          .map((m) => ({ name: name(m), re: re(m), body: r.body(m) as JsonObject })),
        requests: requests.map((m) => ({ name: name(m), body: r.body(m) as JsonObject })),
        // A line's edit (a body with a task) names a line's text: the turn's lines are not requests.
        edits: of(11)
          .filter((m) => !setups.has(re(m)) && (r.body(m) as JsonObject).task === undefined)
          .map((m) => ({ re: re(m), body: r.body(m) as JsonObject })),
      };
    },
    /** The log lines of the bot's own writer, which the connection and the outbox write to. */
    lines: b.lines,
    cleanUp: stop,
  };
  return world;
}

export type RelayWorld = Awaited<ReturnType<typeof relayWorld>>;

/** The properties of what alice reads that hold for any run: no part names an answer that does not exist. */
export function assertConsistent(read: Read, thread: string): void {
  const answered = new Map(read.answers.map((a) => [a.name, a]));
  // Everything the bot writes for a prompt names the thread of that prompt.
  for (const written of [...read.parts, ...read.answers])
    assert.equal(written.body.thread, thread, "a part or an answer names another thread");
  for (const part of read.parts) {
    const answer = answered.get(part.re);
    assert.ok(answer, "a part names an answer that does not exist");
    assert.equal(typeof part.body.markdown, "string");
  }
  // The text of an answer is its parts', in the order they were read.
  for (const answer of read.answers) {
    const mine = read.parts.filter((p) => p.re === answer.name);
    if (mine.length === 0) continue;
    assert.equal(
      mine.map((p) => String(p.body.markdown)).join(""),
      String(answer.body.markdown),
      "the parts of an answer add up to its text",
    );
    assert.equal(mine.filter((p) => p.body.ending === true).length <= 1, true);
  }
  // A request is withdrawn or rewritten at most once.
  const edited = read.edits.map((e) => e.re);
  assert.equal(new Set(edited).size, edited.length, "a request was edited twice");
  for (const edit of read.edits)
    assert.ok(
      read.requests.some((q) => q.name === edit.re),
      "an edit names a request that does not exist",
    );
}

/** The recorded question the agent asked permission for (`ask-can-use-tool.json`). */
export function recordedQuestion(): {
  toolName: string;
  input: JsonObject;
  questions: JsonObject[];
} {
  const recorded = sdkJson("ask-can-use-tool") as JsonObject;
  const input = recorded.input as JsonObject;
  return {
    toolName: String(recorded.tool_name),
    input,
    questions: input.questions as JsonObject[],
  };
}

/** The recorded `tools` turn with the agent's closing text replaced by `text`, in every record that carries it. */
export function turnSaying(text: string): Item[] {
  let streamed = false;
  return sdkMessages("tools").map((item): Item => {
    if (!("record" in item)) return item;
    const record = structuredClone(item.record) as {
      type?: string;
      result?: string;
      event?: { delta?: { type?: string; text?: string } };
      message?: { content: { type: string; text?: string }[] };
    };
    const delta = record.event?.delta;
    if (record.type === "stream_event" && delta?.type === "text_delta") {
      delta.text = streamed ? "" : text;
      streamed = true;
    }
    if (record.type === "assistant") {
      for (const block of record.message?.content ?? [])
        if (block.type === "text") block.text = text;
    }
    if (record.type === "result") record.result = text;
    return { record: record as JsonObject };
  });
}

/** The first option of each question of `request`, keyed as the seam keys an answer (`Question.text`), plus `extra` words. */
export type Shown = Omit<QuestionRequest, "callId">;

/** The question request as alice reads it: the seam's, less the agent's call id, which stays on the bot. */
export const shownAs = (body: JsonObject): Shown => body.request as unknown as Shown;

export function firstOptions(request: Shown, extra: string[] = []) {
  return Object.fromEntries(
    request.questions.map((q) => [q.text, [String(q.options[0]?.label), ...extra]] as const),
  );
}

/**
 * Every write to standard output and error, and every `console` call, goes to `lines` as well as
 * where it went (the runner keeps its output). Undone when the test ends.
 */
export function teeOutput(t: TestContext, lines: string[]): void {
  const restore: (() => void)[] = [];
  for (const stream of [process.stderr, process.stdout]) {
    const real = stream.write;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
      return (real as (...args: unknown[]) => boolean).call(stream, chunk, ...rest);
    }) as typeof stream.write;
    restore.push(() => {
      stream.write = real;
    });
  }
  for (const name of ["log", "info", "warn", "error", "debug"] as const) {
    const real = console[name];
    console[name] = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
      return real.apply(console, args);
    };
    restore.push(() => {
      console[name] = real;
    });
  }
  t.after(() => {
    for (const undo of restore) undo();
  });
}
