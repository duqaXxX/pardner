/**
 * A request the agent gives up (it aborts the signal it passed the handler): the core takes it
 * back from the owner as a close does, settling that one request as refused and withdrawing its
 * message. Played with `requestWhileStreaming`, whose `abort` is the request's own signal.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { APPROVE } from "../../../../src/core/requests.ts";
import { type JsonObject, sdkJson } from "../../../support/fixtures.ts";
import { CHANNEL, THREAD } from "../../../support/ids.ts";
import {
  type Harness,
  isRecord,
  memoryHarnessFor,
  recordOf,
  requestWhileStreaming,
  sdkMessages,
} from "../../../support/sessions.ts";
import { pending, rootStatuses } from "./helpers.ts";

const BASH: JsonObject = { command: "rm -rf build" };

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

interface Ask {
  readonly tool: string;
  readonly input: JsonObject;
  readonly callId: string;
  readonly abort: AbortController;
}

/** The recorded turn from the reply's first message on: what follows `openedTurn`. */
function restOfTurn() {
  return sdkMessages("tools").slice(openedTurn().length);
}

/** The recorded turn up to the reply's first message, then the requests, each with its signal. */
function askingTurn(asks: readonly Ask[]) {
  return [
    ...openedTurn(),
    ...asks.map((ask) => requestWhileStreaming(ask.tool, ask.input, ask.callId, ask.abort)),
  ];
}

/** A session with its turn running and `count` requests posted. */
async function posted(h: Harness, count: number) {
  const session = h.session();
  await session.submit("clean");
  await h.until(() => (h.state.thread(CHANNEL, THREAD)?.requests.length ?? 0) === count);
  return session;
}

const bash = (callId: string, abort = new AbortController()): Ask => ({
  tool: "Bash",
  input: BASH,
  callId,
  abort,
});

test("a permission given up while the owner is asked is refused and withdrawn", async (t) => {
  const abort = new AbortController();
  const h = memoryHarnessFor(
    t,
    {},
    { rootStatus: true },
  )({ turns: [askingTurn([bash("toolu_a", abort)])] });
  const session = await posted(h, 1);
  const requestTs = h.state.thread(CHANNEL, THREAD)?.requests[0];
  const approvalId = pending(h.approvals)[0];
  assert.ok(requestTs !== undefined && approvalId !== undefined);
  assert.notEqual(h.room.message(requestTs), null, "the request message is shown");
  assert.equal(rootStatuses(h).at(-1), "waiting");

  abort.abort();
  await h.until(() => pending(h.approvals).length === 0);
  await h.idle();

  assert.equal(h.room.message(requestTs), null, "the request message is withdrawn");
  assert.deepEqual(h.state.thread(CHANNEL, THREAD)?.requests, []);
  const refused = h.clients[0]?.permissionResults[0];
  assert.ok(refused !== undefined && "allow" in refused && !refused.allow);
  // A click on the message that was there finds no request.
  assert.equal(h.approvals.resolve(approvalId, CHANNEL, THREAD, APPROVE), null);
  assert.equal(h.approvals.get(approvalId), null);
  // The root leaves waiting the way an answer leaves it: the turn still runs.
  assert.equal(rootStatuses(h).at(-1), "working");
  assert.equal(session.waitingForOwner, false);
});

test("a question given up while the owner is asked is skipped and withdrawn", async (t) => {
  const recorded = sdkJson("ask-can-use-tool") as JsonObject;
  const abort = new AbortController();
  const question: Ask = {
    tool: String(recorded.tool_name),
    input: recorded.input as JsonObject,
    callId: "q",
    abort,
  };
  const h = memoryHarnessFor(t, {}, { rootStatus: true })({ turns: [askingTurn([question])] });
  await posted(h, 1);
  const requestTs = h.state.thread(CHANNEL, THREAD)?.requests[0];
  assert.ok(requestTs !== undefined && h.room.message(requestTs) !== null);

  abort.abort();
  await h.until(() => pending(h.approvals).length === 0);
  await h.idle();

  assert.equal(h.room.message(requestTs), null, "the request message is withdrawn");
  assert.deepEqual(h.state.thread(CHANNEL, THREAD)?.requests, []);
  const skipped = h.clients[0]?.permissionResults[0];
  assert.ok(skipped !== undefined && "answered" in skipped && !skipped.answered);
});

test("a signal aborted after the owner answered changes nothing", async (t) => {
  const abort = new AbortController();
  const h = memoryHarnessFor(
    t,
    {},
    { rootStatus: true },
  )({ turns: [askingTurn([bash("toolu_a", abort)])] });
  await posted(h, 1);
  const approvalId = pending(h.approvals)[0];
  assert.ok(approvalId !== undefined);

  assert.notEqual(h.approvals.resolve(approvalId, CHANNEL, THREAD, APPROVE), null);
  await h.until(() => h.clients[0]?.permissionResults.length === 1);
  await h.idle();
  const shownMessages = h.room.written(h.channel).length;
  const shown = rootStatuses(h).length;

  abort.abort();
  await h.idle();

  assert.equal(h.room.written(h.channel).length, shownMessages);
  assert.equal(rootStatuses(h).length, shown);
  const answered = h.clients[0]?.permissionResults[0];
  assert.ok(answered !== undefined && "allow" in answered && answered.allow);
});

test("of two requests waiting, the one given up goes and the other stays", async (t) => {
  const abort = new AbortController();
  const h = memoryHarnessFor(
    t,
    {},
    { rootStatus: true },
  )({ turns: [askingTurn([bash("toolu_a", abort), bash("toolu_b")])] });
  const session = await posted(h, 2);
  const [first, second] = h.state.thread(CHANNEL, THREAD)?.requests ?? [];
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(pending(h.approvals).length, 2);

  abort.abort();
  await h.until(() => pending(h.approvals).length === 1);
  await h.idle();

  assert.equal(h.room.message(first), null, "the one given up is withdrawn");
  assert.notEqual(h.room.message(second), null, "the other stays");
  assert.deepEqual(h.state.thread(CHANNEL, THREAD)?.requests, [second]);
  assert.equal(session.waitingForOwner, true);
  assert.equal(rootStatuses(h).at(-1), "waiting");
  assert.equal(h.clients[0]?.permissionResults.length, 1);
});

test("a signal already aborted when the request arrives posts nothing", async (t) => {
  const abort = new AbortController();
  abort.abort();
  const h = memoryHarnessFor(
    t,
    {},
    { rootStatus: true },
  )({ turns: [askingTurn([bash("toolu_a", abort)])] });
  await h.session().submit("clean");
  await h.until(() => h.clients[0]?.permissionResults.length === 1);
  await h.idle();

  const refused = h.clients[0]?.permissionResults[0];
  assert.ok(refused !== undefined && "allow" in refused && !refused.allow);
  assert.deepEqual(pending(h.approvals), []);
  assert.deepEqual(h.state.thread(CHANNEL, THREAD)?.requests, []);
  assert.deepEqual(h.room.requests(), []);
  assert.ok(rootStatuses(h).length > 0, "the root showed the turn's status");
  assert.ok(!rootStatuses(h).includes("waiting"));
});

test("a turn that ends while a given-up request is being withdrawn leaves the root done", async (t) => {
  const abort = new AbortController();
  const h = memoryHarnessFor(
    t,
    {},
    { rootStatus: true },
  )({ turns: [askingTurn([bash("toolu_a", abort)])] });
  const session = await posted(h, 1);
  const held = h.room.hold("withdraw");

  abort.abort();
  await held.reached.wait(); // the withdraw is in flight
  h.clients[0]?.inject(restOfTurn());
  await h.until(() => session.idle);
  held.release();
  await h.idle();

  assert.equal(session.idle, true);
  assert.equal(rootStatuses(h).at(-1), "done");
  const stored = h.state.thread(CHANNEL, THREAD);
  assert.equal(stored?.status, null);
  assert.deepEqual(stored?.requests, []);
});
