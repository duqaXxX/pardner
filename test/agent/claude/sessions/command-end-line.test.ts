/**
 * The end of a command in the background is said by its line (#166): the line closes in place
 * with its status, and the bot sends no end text. A command with no line to close, and one that
 * was stopped (which the line does not say), keep the end text. Replayed from `background`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskUpdate } from "../../../../src/chat/seam.ts";
import { type JsonObject, sdkJson } from "../../../support/fixtures.ts";
import {
  type Harness,
  hookRun,
  type Item,
  memoryHarnessFor,
  recordOf,
  sdkMessages,
} from "../../../support/sessions.ts";
import {
  inside,
  isReport,
  notified,
  play,
  replyCount,
  send,
  splitBackground,
  systemRecord,
  withResult,
  withTaskStatus,
} from "./helpers.ts";

const ENDED = /Background command "[^"]*" /;

/** The updates of the command's line, in order. */
function lines(h: Harness): TaskUpdate[] {
  return h.room.calls("task").map((call) => call.args[0] as TaskUpdate);
}

test("a command's end closes its line as done, with no end text", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = memoryHarnessFor(t)({ turns: [first] });
  await (await h.session().submit("start it")).done.wait();
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => h.replies().some(isReport));
  const closed = lines(h).at(-1);
  assert.equal(closed?.status, "complete");
  assert.equal(closed?.task, true);
  assert.equal(closed?.details, null);
  assert.ok(closed?.startedAt !== null, "the line keeps its start, which the app times it by");
  assert.ok(!ENDED.test(h.replies().join("\n")), h.replies().join("\n"));
});

test("a command that failed closes its line in error with its summary, and sends no end text", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = memoryHarnessFor(t)({ turns: [first] });
  await (await h.session().submit("start it")).done.wait();
  const summary = String(systemRecord(notice, "task_notification").summary);
  h.clients[0]?.inject([...notice.map((item) => withTaskStatus(item, "failed")), ...injected]);
  await h.until(() => h.replies().some(isReport));
  const closed = lines(h).at(-1);
  assert.equal(closed?.status, "error");
  assert.equal(closed?.output, summary);
  assert.ok(!ENDED.test(h.replies().join("\n")), h.replies().join("\n"));
  assert.ok(!h.replies().join("\n").includes("✗"));
});

test("a command that was stopped keeps its end text: its line says no stop", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = memoryHarnessFor(t)({ turns: [first] });
  await (await h.session().submit("start it")).done.wait();
  h.clients[0]?.inject([...notice.map((item) => withTaskStatus(item, "stopped")), ...injected]);
  await h.until(() => h.replies().some((text) => ENDED.test(text)));
});

test("a command whose line the daemon cannot close keeps its end text", async (t) => {
  // A restart or an idle close dropped the reply that holds the command's line: nothing here
  // can close it, so its end is said in words, as before.
  const [first, notice, injected] = splitBackground();
  const h = memoryHarnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  inside(session).taskReplies.clear();
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => h.replies().some((text) => ENDED.test(text)));
});

// A line the restart sweep closed reads `Stopped: the bot restarted`, which the app does not
// word as a command's end: that is `LineViewsTests`, over the sweep's own output.

const WITH_JOB = sdkJson("stop-hook-session-crons") as JsonObject;
const JOB = { id: "a1b2c3d4", schedule: "*/1 * * * *", recurring: true, prompt: "check the build" };

function withStopHook(turn: readonly Item[], hookInput: JsonObject): Item[] {
  return [...turn.slice(0, -1), hookRun(hookInput), turn.at(-1) as Item];
}

test("a command a scheduled run started keeps its end text when the report lands outside the card", async (t) => {
  // The loop card draws no line (`LoopReply.task` writes nothing), so the line the renderer
  // closes shows the end nowhere: the text says it.
  const h = memoryHarnessFor(
    t,
    {},
    { loopCard: true },
  )({ turns: [withStopHook(sdkMessages("tools"), WITH_JOB)] });
  const session = h.session();
  await (await session.submit("/loop 1m check the build")).done.wait();
  const [first, notice, injected] = splitBackground();
  h.clients[0]?.inject(withStopHook(first, { ...WITH_JOB, session_crons: [JOB] }));
  await h.until(() => h.room.written(h.channel).some((m) => m.text.includes("Scheduled ")));
  await h.until(() => !session.busy);
  const asked = await send(h, session, "and now this");
  play(h, withStopHook(sdkMessages("tools"), { ...WITH_JOB, session_crons: [JOB] }));
  await asked.done.wait();
  const grown = (h.replies().at(-1) ?? "").length;
  h.clients[0]?.inject(notice);
  h.clients[0]?.inject(withResult(injected, "THE REPORT"));
  await h.until(() => (h.replies().at(-1) ?? "").length > grown);
  await h.until(() => !session.busy);
  await h.idle();
  const thread = h.room
    .written(h.channel)
    .map((message) => message.text)
    .join("\n---\n");
  assert.ok(ENDED.test(thread), thread);
});

test("a report turn with no words opens no reply and tells the owner nothing", async (t) => {
  // The command's end has no text (its line says it), so a report turn that says nothing has
  // nothing to show: a reply for it would read `_Done. ... returned no text._` and notify.
  const [first, notice, injected] = splitBackground();
  // The agent's turn for a notification it has already been told of: no step, no text
  // (`handback.test.ts` records one, `num_turns: 0`).
  const [result] = injected.slice(-1);
  const wordless = [
    ...injected.filter((item) => recordType(item) === "system"),
    { record: { ...recordOf(result), result: "", num_turns: 0 } },
  ];
  const h = memoryHarnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  // The owner's `/status` sits below the waiting reply, so it is not the last thing in the thread.
  await session.status();
  h.clients[0]?.inject([...notice, ...wordless]);
  await h.until(() => inside(session).ended.length === 0);
  await h.idle();
  assert.equal(replyCount(h), 1, h.replies().join("\n---\n"));
  assert.ok(!h.replies().some((text) => text.includes("returned no text")));
  assert.deepEqual(notified(h), []);
  assert.ok(lines(h).at(-1)?.status === "complete", "the line still says the end");
});

test("a subagent whose task record is gone keeps its end text", async (t) => {
  // `TASKS_KEPT` drops the oldest record; the task then reads as kind `other`, which no line
  // of a command's says (its line is an agent's card).
  const [first, notice, injected] = splitBackground(sdkMessages("subagent"));
  const h = memoryHarnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  inside(session).tasks.clear();
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => h.replies().some((text) => /^✓ \w+ "/m.test(text)));
});

function recordType(item: Item): unknown {
  return (item as { record?: { type?: unknown } }).record?.type;
}
