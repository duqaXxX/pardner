// How a call cut by a stop reads in the chat: an error saying `Stopped`, whatever the agent
// says of its own end of the call. `/terminal` cuts no call that way: the terminal goes on.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { TaskUpdate } from "../../../src/chat/seam.ts";
import { TurnRenderer } from "../../../src/core/reply/renderer.ts";
import type { ThreadSession } from "../../../src/core/sessions/session.ts";
import { call, hold, PLAIN_CAPABILITIES, PlainAgent, say } from "../../support/plain-agent.ts";
import { settledTurn } from "../../support/settle.ts";
import { AskingWorld } from "../flows/asking-world.ts";

async function until(what: string, test: () => boolean): Promise<void> {
  for (let round = 0; round < 200 && !test(); round += 1) await settledTurn();
  assert.ok(test(), what);
}

/** The last line the chat was given for a call, as [status, output]. */
function lastLine(world: AskingWorld): [string, string | null] {
  const last = world.chat.calls("task").at(-1)?.args[0] as TaskUpdate;
  return [last.status, last.output];
}

test("/stop while a call waits for approval: its line is an error saying Stopped", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  (world.agent as PlainAgent).next(call("Shell", { command: "ls" }, { permission: true }));
  const turn = await session.submit("list the files");
  await world.asked(ref, "permission");
  assert.equal(await session.stop(), true);
  await turn.done.wait();
  // The denial the stop makes ends the call in error, with the words of the denial.
  assert.deepEqual(lastLine(world), ["error", "Stopped"]);
});

test("/stop in the gap before a turn: the turn it cut draws its calls as stopped", async (t) => {
  const agent = new PlainAgent({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { session } = world.thread();
  agent.next(say("a"));
  agent.next(hold(), call("Shell", { command: "ls" }, { isError: true, output: "boom" }));
  await session.submit("first");
  await until("idle", () => !session.busy);
  await settledTurn();
  const [plain] = agent.sessions;
  assert.ok(plain);
  let open!: () => void;
  plain.playGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  await session.submit("second");
  await until("sent", () => plain.prompts.length === 2);
  // The turn begins while the stop awaits its interrupt, which does not cut it.
  plain.interrupt = async () => {
    open();
    await until("the turn runs", () => session.busy && plain.holding);
  };
  assert.equal(await session.stop(), true);
  plain.release();
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.deepEqual(lastLine(world), ["error", "Stopped"]);
});

test("/terminal during a call does not mark it as failed", async (t) => {
  const world = await AskingWorld.make(t);
  const { ref, session } = world.thread();
  (world.agent as PlainAgent).next(call("Shell", { command: "ls" }, { permission: true }));
  await session.submit("list the files");
  await world.asked(ref, "permission");
  assert.equal(await session.moveToTerminal(), "cut");
  await settledTurn();
  assert.deepEqual(lastLine(world), ["complete", "Stopped"]);
});

/** The two slow tails of a turn's end a stop can land in: the session's `finish`, or the write after it. */
interface Slow {
  finish: (...args: unknown[]) => Promise<unknown>;
  reactDoneIfIdle: (...args: unknown[]) => Promise<unknown>;
}

for (const where of ["finish", "reactDoneIfIdle"] as const) {
  test(`/stop at a turn boundary (a slow ${where}): the next turn's call reads as stopped`, async (t) => {
    const agent = new PlainAgent({ promptDuringTurn: true });
    const world = await AskingWorld.make(t, { agent });
    const { ref, session } = world.thread();
    agent.next(say("a"));
    agent.next(call("Shell", { command: "ls" }, { permission: true }));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let inGate = false;
    const slow = session as unknown as Slow;
    const original = slow[where].bind(slow);
    let first = true;
    slow[where] = async (...args) => {
      // The first end waits after its work (`finish`) or before it (`reactDoneIfIdle`).
      if (where === "reactDoneIfIdle" && first) {
        first = false;
        inGate = true;
        await gate;
      }
      const result = await original(...args);
      if (where === "finish" && first) {
        first = false;
        inGate = true;
        await gate;
      }
      return result;
    };
    await session.submit("first");
    await until("the first turn is in its slow end", () => inGate);
    await session.submit("second");
    await world.asked(ref, "permission");
    assert.equal(await session.stop(), true);
    open();
    await until("idle", () => !session.busy);
    await settledTurn();
    assert.deepEqual(lastLine(world), ["error", "Stopped"]);
  });
}

/** A plain agent that runs background tasks. */
class Background extends PlainAgent {
  override readonly capabilities = {
    ...PLAIN_CAPABILITIES,
    promptDuringTurn: true,
    backgroundTasks: true,
  };
}

/** A turn that leaves a task running, then `end` ends the session's work; the task's last line. */
async function taskEndedBy(
  t: TestContext,
  end: (session: ThreadSession) => Promise<unknown>,
): Promise<[string, string | null]> {
  const agent = new Background();
  const world = await AskingWorld.make(t, { agent });
  const { session } = world.thread();
  agent.next(say("Started."), hold());
  await session.submit("watch it");
  await until("the turn runs", () => agent.sessions[0]?.holding === true);
  agent.sessions[0]?.emit({
    type: "task_started",
    taskId: "task-1",
    kind: "other",
    taskType: null,
    description: "watch",
    callId: null,
    agentType: null,
    background: false,
    parentTaskId: null,
  });
  await settledTurn();
  agent.sessions[0]?.release();
  await until("the turn ended", () => !session.busy);
  await settledTurn();
  await end(session);
  await settledTurn();
  const line = world.chat
    .calls("task")
    .map((recorded) => recorded.args[0] as TaskUpdate)
    .findLast((update) => update.title.includes("watch"));

  assert.ok(line, "the task has a line");
  return [line.status, line.output];
}

test("/stop ending the process draws a running task as an error saying Stopped", async (t) => {
  assert.deepEqual(await taskEndedBy(t, (session) => session.stop()), ["error", "Stopped"]);
});

test("/terminal ending the process draws a running task as it did, complete and Stopped", async (t) => {
  assert.deepEqual(await taskEndedBy(t, (session) => session.stopForTerminal()), [
    "complete",
    "Stopped",
  ]);
});

test("/stop while a report turn is in its slow end: the next prompt's call reads as stopped", async (t) => {
  const agent = new Background();
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("Started."), hold());
  await session.submit("watch it");
  await until("the turn runs", () => agent.sessions[0]?.holding === true);
  const plain = agent.sessions[0];
  assert.ok(plain);
  plain.emit({
    type: "task_started",
    taskId: "task-1",
    kind: "other",
    taskType: null,
    description: "watch",
    callId: null,
    agentType: null,
    background: false,
    parentTaskId: null,
  });
  await settledTurn();
  plain.release();
  await until("the turn ended", () => !session.busy);
  await settledTurn();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let inGate = false;
  const slow = session as unknown as Slow;
  const original = slow.finish.bind(slow);
  let first = true;
  slow.finish = async (...args) => {
    const result = await original(...args);
    if (first) {
      first = false;
      inGate = true;
      await gate;
    }
    return result;
  };
  // The agent's own report turn of the task's end, whose reply is the first turn's.
  plain.emit({
    type: "task_ended",
    taskId: "task-1",
    status: "completed",
    summary: "done",
    durationMs: null,
    callId: null,
    report: null,
    reportSent: false,
    foldNamed: false,
  });
  plain.emit({ type: "text", text: "The task finished." });
  plain.emit({
    type: "turn_ended",
    sessionId: null,
    startedBy: "agent",
    finalText: "The task finished.",
    ending: "done",
    steps: 1,
    answers: [],
    tokens: {},
  });
  await until("the report turn is in its slow end", () => inGate);
  agent.next(call("Shell", { command: "ls" }, { permission: true }));
  await session.submit("second");
  await world.asked(ref, "permission");
  assert.equal(await session.stop(), true);
  open();
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.deepEqual(lastLine(world), ["error", "Stopped"]);
});

test("/stop while a turn's own end is being written: the next prompt's call reads as stopped", async (t) => {
  const agent = new PlainAgent({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("a"));
  agent.next(call("Shell", { command: "ls" }, { permission: true }));
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let inGate = false;
  let first = true;
  // The write of the turn's final text is where the stop lands.
  const original = TurnRenderer.prototype.feed;
  TurnRenderer.prototype.feed = async function (this: TurnRenderer, event) {
    const result = await original.call(this, event);
    if (event.type === "turn_ended" && first) {
      first = false;
      inGate = true;
      await gate;
    }
    return result;
  };
  t.after(() => {
    TurnRenderer.prototype.feed = original;
  });
  await session.submit("first");
  await until("the turn's end is being written", () => inGate);
  await session.submit("second");
  await world.asked(ref, "permission");
  assert.equal(await session.stop(), true);
  open();
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.deepEqual(lastLine(world), ["error", "Stopped"]);
});
