/**
 * The reply's tool cards drawn from the vocabulary of an agent that is not Claude: the plain
 * agent names its tools `run` and `change` and declares what the terminal would say of them.
 * What the same code does with Claude's recorded streams is in `test/agent/claude/reply/`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "../../../src/agent/seam.ts";
import type { TaskUpdate } from "../../../src/chat/seam.ts";
import { Previews } from "../../../src/core/reply/previews.ts";
import { type Sink, type TurnEnded, TurnRenderer } from "../../../src/core/reply/renderer.ts";
import { MEMORY_NAMES } from "../../support/names.ts";
import { call, PLAIN_TOOLS, PlainAgent, say } from "../../support/plain-agent.ts";

const PREVIEWS = new Previews(PLAIN_TOOLS);

/** The cards the renderer drew for one scripted turn of the plain agent. */
async function cardsOf(...steps: Parameters<PlainAgent["next"]>): Promise<TaskUpdate[]> {
  const agent = new PlainAgent().next(...steps);
  const session = await agent.start(
    { folder: "/work", resume: null, model: null, effort: null },
    {
      permission: async () => ({ allow: true }),
      question: async () => ({ answered: false, message: "skipped" }),
    },
  );
  const cards: TaskUpdate[] = [];
  const sink: Sink = {
    text: async () => undefined,
    task: async (update) => {
      cards.push(update);
    },
    finish: async () => undefined,
    closeOut: async () => true,
    waitLanded: async () => true,
    settle: async () => true,
  };
  const renderer = new TurnRenderer(sink, MEMORY_NAMES, PREVIEWS);
  await session.send({ id: "00000000-0000-4000-8000-000000000001", content: "go" });
  for await (const event of session.events as AsyncIterable<SessionEvent>) {
    await renderer.feed(event);
    if (event.type === "turn_ended") break;
  }
  await renderer.close();
  await renderer.closeOut();
  await session.close();
  return cards;
}

test("a call is titled by the input its tool declares to describe it", async () => {
  const cards = await cardsOf(call("run", { command: "ls", summary: "List the folder" }));
  assert.deepEqual(
    cards.map((card) => [card.status, card.title]),
    [
      ["in_progress", "List the folder"],
      ["complete", "List the folder"],
    ],
  );
});

test("a call of a tool with no description input is titled by its name and command", async () => {
  const [first] = await cardsOf(call("run", { command: "pwd" }));
  assert.equal(first?.title, "run: pwd");
});

test("a finished edit of a file previews as the tool's declared title", async () => {
  const cards = await cardsOf(
    call(
      "change",
      { path: "a.txt" },
      {
        fileChange: {
          path: "a.txt",
          kind: "edited",
          hunks: [{ oldStart: 1, newStart: 1, lines: ["-a", "+b"] }],
          content: null,
        },
      },
    ),
  );
  assert.equal(cards.at(-1)?.preview?.title, "Modify(a.txt)");
  assert.equal(cards.at(-1)?.preview?.summary, "Added 1 line, removed 1 line");
  assert.equal(cards.at(-1)?.preview?.language, "diff");
});

test("a failed call ends its card in error", async () => {
  const cards = await cardsOf(say("Trying."), call("run", { command: "false" }, { isError: true }));
  assert.equal(cards.at(-1)?.status, "error");
});

/** What the renderer's sink took while `steps` ran on a call of the plain agent, then the turn closed. */
async function afterCall(
  steps: (renderer: TurnRenderer) => Promise<void>,
  ending: TurnEnded["ending"] = "done",
): Promise<TaskUpdate[]> {
  const updates: TaskUpdate[] = [];
  const sink: Sink = {
    text: async () => undefined,
    task: async (update) => {
      updates.push(update);
    },
    finish: async (closed) => {
      updates.push(...closed);
    },
    closeOut: async () => true,
    waitLanded: async () => true,
    settle: async () => true,
  };
  const renderer = new TurnRenderer(sink, MEMORY_NAMES, PREVIEWS);
  await renderer.feed({
    type: "call_started",
    callId: "c1",
    toolName: "run",
    input: { command: "sleep 30" },
    parentCallId: null,
  });
  await steps(renderer);
  renderer.result = {
    type: "turn_ended",
    sessionId: null,
    startedBy: "owner",
    finalText: null,
    ending,
    steps: 1,
    answers: [],
    tokens: {},
    cost: null,
  };
  await renderer.close();
  return updates;
}

const ENDED_IN_ERROR = (output: string, callId = "c1"): SessionEvent => ({
  type: "call_ended",
  callId,
  isError: true,
  output,
  fileChange: null,
  model: null,
  parentCallId: null,
});

const last = (updates: TaskUpdate[]) => [updates.at(-1)?.status, updates.at(-1)?.output];

test("a call still open when the owner's stop ends the turn reads as an error, `Stopped`", async () => {
  const updates = await afterCall(async (renderer) => renderer.stopAsked(), "interrupted");
  assert.deepEqual(last(updates), ["error", "Stopped"]);
});

test("a call open when a turn ends cut by anything else than the owner's stop closes as it did", async () => {
  // `/terminal` ends the turn here and the terminal goes on with it.
  const updates = await afterCall(async () => undefined, "interrupted");
  assert.deepEqual(last(updates), ["complete", "Stopped"]);
});

test("a call the agent ends in error after the owner's stop reads `Stopped`, not the agent's words", async () => {
  const updates = await afterCall(async (renderer) => {
    renderer.stopAsked();
    await renderer.feed(ENDED_IN_ERROR("The user doesn't want to proceed with this tool use."));
  }, "interrupted");
  assert.deepEqual(last(updates), ["error", "Stopped"]);
});

test("a call that outlives its turn as a task and fails after a stop reads `Stopped` too", async () => {
  const updates = await afterCall(async (renderer) => {
    await renderer.feed({
      type: "task_started",
      taskId: "t1",
      kind: "other",
      taskType: null,
      description: "sleep",
      callId: "c1",
      agentType: null,
      background: false,
      parentTaskId: null,
    });
    renderer.stopAsked();
    await renderer.feed(ENDED_IN_ERROR("rejected"));
  }, "interrupted");
  assert.ok(updates.some((update) => update.output === "Stopped"));
  assert.ok(updates.every((update) => update.output !== "rejected"));
});

test("a call that ends in error with no stop asked keeps the agent's words", async () => {
  const updates = await afterCall(async (renderer) => renderer.feed(ENDED_IN_ERROR("boom")));
  assert.deepEqual(last(updates), ["error", "boom"]);
});

test("a stop asked in one turn marks no failure of a later one of the same reply", async () => {
  const updates = await afterCall(async (renderer) => {
    renderer.stopAsked();
    await renderer.close();
    await renderer.feed(ENDED_IN_ERROR("later", "c2"));
    await renderer.feed({
      type: "call_started",
      callId: "c3",
      toolName: "run",
      input: { command: "false" },
      parentCallId: null,
    });
    await renderer.feed(ENDED_IN_ERROR("real failure", "c3"));
  });
  assert.equal(
    updates.find((update) => update.id === "c3" && update.status === "error")?.output,
    "real failure",
  );
});

test("a task the agent stopped itself ends as it said, and one the core cut reads as an error", async () => {
  for (const [cut, expected] of [
    [false, ["complete", "Stopped"]],
    [true, ["error", "Stopped"]],
  ] as const) {
    const updates = await afterCall(async (renderer) => {
      await renderer.feed({
        type: "task_started",
        taskId: "t1",
        kind: "other",
        taskType: null,
        description: "watch",
        callId: "c1",
        agentType: null,
        background: false,
        parentTaskId: null,
      });
      if (cut) renderer.cutTask("t1");
      await renderer.feed({
        type: "task_ended",
        taskId: "t1",
        status: "stopped",
        summary: "watch",
        durationMs: null,
        callId: null,
        report: null,
        reportSent: false,
        foldNamed: false,
      });
    });
    assert.deepEqual(last(updates), expected);
  }
});

test("a task the process's end closes (`stopRunning`) reads as complete, not as cut by the owner", async () => {
  const updates = await afterCall(async (renderer) => {
    await renderer.feed({
      type: "task_started",
      taskId: "t1",
      kind: "other",
      taskType: null,
      description: "watch",
      callId: null,
      agentType: null,
      background: false,
      parentTaskId: null,
    });
    await renderer.stopRunning();
  });
  assert.deepEqual(last(updates.filter((update) => update.id === "task-t1")), [
    "complete",
    "Stopped",
  ]);
});

test("the core sets `agent` from the task's kind, for an agent that is not Claude", async () => {
  const lines: TaskUpdate[] = [];
  const sink: Sink = {
    text: async () => undefined,
    task: async (update) => {
      lines.push(update);
    },
    finish: async () => undefined,
    closeOut: async () => true,
    waitLanded: async () => true,
    settle: async () => true,
  };
  const renderer = new TurnRenderer(sink, MEMORY_NAMES, PREVIEWS);
  const started = (kind: "subagent" | "command", callId: string, taskId: string) =>
    ({
      type: "task_started",
      taskId,
      kind,
      taskType: null,
      description: `${kind} work`,
      callId,
      agentType: null,
      background: true,
      parentTaskId: null,
    }) as const;
  for (const [tool, kind, id] of [
    ["delegate", "subagent", "c1"],
    ["run", "command", "c2"],
  ] as const) {
    await renderer.feed({
      type: "call_started",
      callId: id,
      toolName: tool,
      input: { command: "x", task: "y" },
      parentCallId: null,
    });
    await renderer.feed(started(kind, id, `t-${id}`));
  }
  const last = (id: string) => lines.filter((line) => line.id === id).at(-1);
  assert.deepEqual([last("c1")?.agent, last("c1")?.task], ["subagent work", true]);
  assert.equal(last("c2")?.agent, null);
});
