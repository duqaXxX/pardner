/**
 * What the renderer hands a reply's sink, in order, as the events of a turn arrive: the words and
 * the calls of a turn that outlives the stream of a chat, and the answers to a question kept for
 * the call that asked it. How a chat splits a long reply into messages, and what each draws, is
 * the chat's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "../../../src/agent/seam.ts";
import type { TaskUpdate } from "../../../src/chat/seam.ts";
import { Previews } from "../../../src/core/reply/previews.ts";
import { type Sink, TurnRenderer } from "../../../src/core/reply/renderer.ts";
import { MEMORY_NAMES } from "../../support/names.ts";
import { PLAIN_TOOLS } from "../../support/plain-agent.ts";

/** A sink that keeps what it is handed in order: a card as `id status`, words as they came. */
class Ordered implements Sink {
  readonly log: string[] = [];
  readonly cards: TaskUpdate[] = [];
  async text(value: string): Promise<void> {
    this.log.push(`text ${value}`);
  }
  async task(update: TaskUpdate): Promise<void> {
    this.cards.push(update);
    this.log.push(`task ${update.id} ${update.status}`);
  }
  async finish(): Promise<void> {}
  async closeOut(): Promise<boolean> {
    return true;
  }
  async waitLanded(): Promise<boolean> {
    return true;
  }
  async settle(): Promise<boolean> {
    return true;
  }
}

const PLAIN = new Previews(PLAIN_TOOLS);

function renderer(sink: Sink): TurnRenderer {
  return new TurnRenderer(sink, MEMORY_NAMES, PLAIN, null);
}

const start = (callId: string, command: string): SessionEvent => ({
  type: "call_started",
  callId,
  toolName: "run",
  input: { command, summary: command, line: command },
  parentCallId: null,
});

const end = (callId: string): SessionEvent => ({
  type: "call_ended",
  callId,
  isError: false,
  output: "(run completed with no output)",
  images: [],
  fileChange: null,
  model: null,
  parentCallId: null,
});

test("a command that runs across a long wait keeps the words before it and its own line, and the answer comes after", async () => {
  // The shape of a long turn in production (#97): a quick command, words, a foreground command
  // the agent starts a task for, its end, the answer.
  const sink = new Ordered();
  const turn = renderer(sink);
  const message = async (...events: SessionEvent[]): Promise<void> => {
    await turn.feed({ type: "message_started", parentCallId: null });
    for (const event of events) await turn.feed(event);
    await turn.feed({ type: "message_ended", parentCallId: null });
  };
  const words = (text: string): SessionEvent[] => [
    { type: "text_started" },
    { type: "text_delta", text },
  ];
  await message(start("c1", "cat notes"));
  await turn.feed(end("c1"));
  await message(...words("Reading works."), start("c2", "sleep 300"));
  await turn.feed({
    type: "task_started",
    taskId: "t2",
    kind: "command",
    taskType: "local_bash",
    description: "sleep 300",
    callId: "c2",
    agentType: null,
    background: false,
    parentTaskId: null,
  });
  const running = sink.cards.filter((card) => card.id === "c2");
  assert.ok(running.length > 0, "the command has a card while it runs");
  assert.ok(running.every((card) => card.status === "in_progress"));
  assert.equal(running.at(-1)?.details, "$ sleep 300");
  await turn.feed({
    type: "task_ended",
    taskId: "t2",
    status: "completed",
    summary: "sleep 300",
    durationMs: null,
    callId: "c2",
    report: null,
    reportSent: false,
    foldNamed: false,
  });
  await turn.feed(end("c2"));
  await message(...words("All done."));
  await turn.close();
  assert.equal(await turn.closeOut(), true);
  const at = (prefix: string): number => sink.log.findIndex((entry) => entry.startsWith(prefix));
  const places = ["task c1", "text Reading works.", "task c2", "text All done."].map(at);
  assert.ok(
    places.every((place) => place >= 0),
    sink.log.join("\n"),
  );
  assert.deepEqual(
    places,
    places.toSorted((a, b) => a - b),
    "in the order they came",
  );
  assert.equal(sink.log.at(-1)?.startsWith("text All done."), true, "the answer is last");
});

test("answers to a call the reply has no line for are not kept, and are for one it has", async () => {
  const turn = renderer(new Ordered());
  assert.ok(!turn.answered("toolu_unseen", [{ text: "Colour?" }], { "Colour?": "blue" }));
  await turn.feed(start("toolu_seen", "ls"));
  assert.ok(turn.answered("toolu_seen", [{ text: "Colour?" }], { "Colour?": "blue" }));
  assert.ok(!turn.answered("toolu_seen", [{ text: "Colour?" }], {}), "no answer, nothing to keep");
});
