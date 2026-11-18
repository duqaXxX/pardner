/**
 * A request waiting for the owner when the agent's process ends: the reader settles it as
 * `close` does (denied, withdrawn, gone from `state.json`), so the session is no longer waiting
 * on an owner nobody can answer for. Played with `requestWhileStreaming`: the fake's `ask`
 * holds its stream, which no real session does.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { APPROVE } from "../../../../src/core/requests.ts";
import { IDLE_CLOSE_SECONDS } from "../../../../src/core/sessions/constants.ts";
import { type JsonObject, sdkJson } from "../../../support/fixtures.ts";
import { CHANNEL, THREAD } from "../../../support/ids.ts";
import {
  END_OF_STREAM,
  type Harness,
  isRecord,
  memoryHarnessFor,
  recordOf,
  requestWhileStreaming,
  sdkMessages,
} from "../../../support/sessions.ts";
import { inside, pending, rootStatuses } from "./helpers.ts";

/** The recorded turn cut right after the reply's first message. */
function openedTurn() {
  const tools = sdkMessages("tools");
  const started = tools.findIndex((item) => {
    const event = recordOf(item)?.event;
    return isRecord(item, "stream_event") && (event as JsonObject).type === "message_start";
  });
  assert.notEqual(started, -1);
  return tools.slice(0, started + 1);
}

/** The recorded turn up to the reply's first message, then the agent's request, then silence. */
function askingTurn(toolName: string, input: JsonObject) {
  return [...openedTurn(), requestWhileStreaming(toolName, input)];
}

/** A session with `turn` running and its one request posted, then the process ends. */
async function lostWhileAsking(h: Harness, session: ReturnType<Harness["session"]>) {
  const turn = await session.submit("clean");
  await h.until(() => pending(h.approvals).length > 0);
  await h.until(() => (h.state.thread(CHANNEL, THREAD)?.requests.length ?? 0) === 1);
  const requestTs = h.state.thread(CHANNEL, THREAD)?.requests[0];
  const approvalId = pending(h.approvals)[0];
  assert.ok(requestTs !== undefined && approvalId !== undefined);
  h.clients[0]?.inject([END_OF_STREAM]);
  await turn.done.wait();
  await h.until(() => inside(session).client === null);
  await h.idle();
  return { requestTs, approvalId };
}

test("a process lost while a permission waits settles the request", async (t) => {
  const h = memoryHarnessFor(
    t,
    {},
    { rootStatus: true },
  )({ turns: [askingTurn("Bash", { command: "rm -rf build" })] });
  const session = h.session();
  const { requestTs } = await lostWhileAsking(h, session);

  assert.deepEqual(pending(h.approvals), []);
  assert.equal(h.room.message(requestTs), null, "the request message is withdrawn");
  assert.deepEqual(h.state.thread(CHANNEL, THREAD)?.requests, []);
  assert.equal(session.waitingForOwner, false);
  const denied = h.clients[0]?.permissionResults[0];
  assert.ok(denied !== undefined && "allow" in denied && !denied.allow);
  // The root goes from waiting to the error status: the denial did not flash working between.
  const shown = rootStatuses(h);
  assert.equal(shown.at(-1), "error");
  assert.ok(shown.includes("waiting"));
  assert.ok(!shown.slice(shown.lastIndexOf("waiting")).includes("working"));
});

test("a session whose process was lost with a request closes when idle", async (t) => {
  const h = memoryHarnessFor(
    t,
    {},
    { rootStatus: true },
  )({ turns: [askingTurn("Bash", { command: "rm -rf build" })] });
  const session = h.session();
  await lostWhileAsking(h, session);

  await h.clock.advance(IDLE_CLOSE_SECONDS);
  await h.until(() => session.closed, 1);
});

test("a process lost while a question waits settles the question", async (t) => {
  const recorded = sdkJson("ask-can-use-tool") as JsonObject;
  const h = memoryHarnessFor(
    t,
    {},
    { rootStatus: true },
  )({
    turns: [askingTurn(String(recorded.tool_name), recorded.input as JsonObject)],
  });
  const session = h.session();
  const { requestTs } = await lostWhileAsking(h, session);

  assert.deepEqual(pending(h.approvals), []);
  assert.equal(h.room.message(requestTs), null, "the request message is withdrawn");
  assert.deepEqual(h.state.thread(CHANNEL, THREAD)?.requests, []);
  assert.equal(session.waitingForOwner, false);
  assert.equal(rootStatuses(h).at(-1), "error");
});

test("an approval pressed after the process was lost finds no request", async (t) => {
  const h = memoryHarnessFor(
    t,
    {},
    { rootStatus: true },
  )({ turns: [askingTurn("Bash", { command: "rm -rf build" })] });
  const session = h.session();
  const { approvalId } = await lostWhileAsking(h, session);

  assert.equal(h.approvals.resolve(approvalId, CHANNEL, THREAD, APPROVE), null);
  await h.idle();
  assert.equal(rootStatuses(h).at(-1), "error");
});

/** The recorded turn whole, then a request made with no turn running: a background task's. */
async function askedBetweenTurns(h: Harness, session: ReturnType<Harness["session"]>) {
  await (await session.submit("first")).done.wait();
  h.clients[0]?.inject([requestWhileStreaming("Bash", { command: "rm -rf build" })]);
  await h.until(() => pending(h.approvals).length > 0);
  await h.until(() => (h.state.thread(CHANNEL, THREAD)?.requests.length ?? 0) === 1);
}

test("a request with no turn running leaves the root on the error status, not waiting", async (t) => {
  const h = memoryHarnessFor(t, {}, { rootStatus: true })({ turns: [sdkMessages("tools")] });
  const session = h.session();
  await askedBetweenTurns(h, session);
  assert.equal(rootStatuses(h).at(-1), "waiting");

  h.clients[0]?.inject([END_OF_STREAM]);
  await h.until(() => inside(session).client === null);
  await h.idle();

  assert.deepEqual(pending(h.approvals), []);
  assert.equal(rootStatuses(h).at(-1), "error");
  assert.equal(h.state.thread(CHANNEL, THREAD)?.status, null);
});

test("a withdrawal that fails does not keep the lost process's turn", async (t) => {
  const h = memoryHarnessFor(
    t,
    {},
    { rootStatus: true },
  )({ turns: [askingTurn("Bash", { command: "rm -rf build" })] });
  const session = h.session();
  const turn = await session.submit("clean");
  await h.until(() => pending(h.approvals).length > 0);
  await h.until(() => (h.state.thread(CHANNEL, THREAD)?.requests.length ?? 0) === 1);
  // The chat seam does not promise that `withdraw` never rejects.
  const chat = (session as unknown as { thread: { withdraw(message: string): Promise<void> } })
    .thread;
  chat.withdraw = () => Promise.reject(new Error("the chat is gone"));

  h.clients[0]?.inject([END_OF_STREAM]);
  await h.until(() => turn.done.isSet);
  await h.until(() => inside(session).client === null);
  await h.idle();

  assert.equal(inside(session).interrupting, false);
  assert.equal(inside(session).active, null);
  assert.equal(rootStatuses(h).at(-1), "error");
});

test("a new process does not start while the old reader still withdraws its requests", async (t) => {
  // A request open with no turn running (a background task's), a withdrawal slower than the
  // next message: the old reader must not end the turn the new process is about to run.
  const h = memoryHarnessFor(
    t,
    {},
    { rootStatus: true },
  )({ turns: [sdkMessages("tools")] }, { turns: [openedTurn()] });
  const session = h.session();
  await askedBetweenTurns(h, session);
  const held = h.room.hold("withdraw");

  h.clients[0]?.inject([END_OF_STREAM]);
  await held.reached.wait();
  const second = await session.submit("second");
  await h.idle();
  assert.equal(h.clients.length, 1); // no process until the old reader has finished
  held.release();
  await h.until(() => h.clients.length === 2);
  await h.until(() => inside(session).active !== null);
  await h.idle();

  assert.equal(inside(session).interrupting, false);
  assert.equal(second.done.isSet, false); // the new turn runs; nothing ended it as lost
  assert.ok(h.bodies().length > 0, "the first turn's reply is shown");
  assert.ok(!h.bodies().some((body) => body.includes("reported an error")));
});
