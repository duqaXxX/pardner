/**
 * Where the footer shows (decided 2026-10-14): once, under the reply the session's latest work
 * wrote into, when the session has ended everything it was doing, and at a forced end; never on
 * what a reply's end writes. A reply that rests waiting for background work shows
 * none. Replayed over the memory chat. The cases are numbered as in
 * `actions/plans/2026-10-14-footer-at-the-end-design.md`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { APPROVE } from "../../../../src/core/requests.ts";
import { INJECTED_TURN_WAIT } from "../../../../src/core/sessions/constants.ts";
import type { ThreadSession } from "../../../../src/core/sessions/session.ts";
import * as texts from "../../../../src/core/texts.ts";
import { AsyncEvent } from "../../../support/fake-clock.ts";
import { CHANNEL, THREAD } from "../../../support/ids.ts";
import {
  canUseToolCall,
  END_OF_STREAM,
  type Harness,
  type Item,
  isResult,
  isSystem,
  memoryHarnessFor,
  recordOf,
  sdkMessages,
  splitTurns,
} from "../../../support/sessions.ts";
import { footers, inside, isTaskRecord, pending, play, send, splitBackground } from "./helpers.ts";

/** The footer is on the thread's last message and on no other, written once the session ended. */
function assertOneAtTheEnd(h: Harness): void {
  const shown = footers(h);
  assert.ok(shown.length > 0, "the thread holds a message");
  assert.deepEqual(
    shown,
    shown.map((_, index) => index === shown.length - 1),
    `one footer, under the last message: ${JSON.stringify(shown)}`,
  );
}

/** Wait for the debounced edits that follow an end. */
async function settled(h: Harness): Promise<void> {
  await h.idle();
  await h.sleep(3);
}

test("case 1: Working stays until the footer is drawn, so the thread's bottom never goes blank", async (t) => {
  const h = memoryHarnessFor(t, {}, { activityLine: true })({ turns: [sdkMessages("tools")] });
  await (await h.session().submit("list the files")).done.wait();
  await settled(h);
  const calls = h.room.calls();
  const footer = calls.findIndex((call) => call.call === "showFooter");
  const cleared = calls.findIndex((call) => call.call === "showActivity" && call.args[0] === null);
  assert.ok(footer !== -1 && cleared > footer, `cleared at ${cleared}, footer at ${footer}`);
});

test("case 2: a reply that waits on a command shows no footer; the report's end shows one", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = memoryHarnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await settled(h);
  assert.ok(session.runningKinds !== "", "the command runs");
  assert.deepEqual(footers(h), [false], "the reply rests with the list and no footer");
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => session.idle);
  await settled(h);
  assertOneAtTheEnd(h);
});

test("case 3: a subagent in the background keeps the footer off until its report has ended", async (t) => {
  const items = sdkMessages("session-state-agent");
  const first = items.findIndex(isResult);
  const h = memoryHarnessFor(t)({ turns: [items.slice(0, first + 1)] });
  const session = h.session();
  await (await session.submit("launch it")).done.wait();
  await settled(h);
  assert.ok(session.runningKinds !== "", "the subagent runs");
  assert.ok(
    footers(h).every((shown) => !shown),
    "no footer while it runs",
  );
  h.clients[0]?.inject(items.slice(first + 1));
  await h.until(() => session.idle);
  await settled(h);
  assertOneAtTheEnd(h);
});

/** `prompt-replay-before-notification`: the prompt is sent just before a command ends. */
function crossing(): { owner: Item[]; notice: Item[]; own: Item[]; report: Item[] } {
  const m = sdkMessages("prompt-replay-before-notification");
  const ends = m.flatMap((item, index) => (isResult(item) ? [index] : []));
  const [first, second, third] = ends as [number, number, number];
  const middle = m.slice(first + 1, second + 1);
  return {
    owner: m.slice(0, first + 1),
    notice: middle.filter(isTaskRecord),
    own: middle.filter((item) => !isTaskRecord(item)),
    report: m.slice(second + 1, third + 1),
  };
}

test("cases 4 and 5: a prompt that crosses a report: none on the report, one at the end", async (t) => {
  const c = crossing();
  const h = memoryHarnessFor(t)({});
  const session = h.session();
  const opening = await send(h, session, "start a background command");
  play(h, c.owner);
  await opening.done.wait();
  await settled(h);
  assert.deepEqual(footers(h), [false], "the first reply rests with none");
  const prompt = await send(h, session, "Reply with the single word PINEAPPLE.");
  h.clients[0]?.inject(c.notice);
  await h.sleep(0.05);
  h.clients[0]?.inject(c.report);
  await h.until(
    () => inside(session).active === null && h.replies().join("\n").includes("REPORTED"),
  );
  await settled(h);
  assert.ok(!prompt.done.isSet, "the prompt still waits for its turn");
  assert.ok(
    footers(h).every((shown) => !shown),
    "none on the report: the prompt is owed",
  );
  play(h, c.own);
  await prompt.done.wait();
  await h.until(() => session.idle);
  await settled(h);
  assertOneAtTheEnd(h);
});

test("case 6: a stop of a subagent in the background puts the footer under the last message", async (t) => {
  const items = sdkMessages("session-state-agent");
  const first = items.findIndex(isResult);
  const h = memoryHarnessFor(t)({ turns: [items.slice(0, first + 1)] });
  const session = h.session();
  await (await session.submit("launch it")).done.wait();
  await settled(h);
  assert.ok(footers(h).every((shown) => !shown));
  // The stop closes the process: the tasks end with it, and the footer follows.
  assert.equal(await session.stop(), true);
  await h.until(() => session.idle);
  await settled(h);
  assertOneAtTheEnd(h);
});

test("case 6: a stop in the middle of a turn ends it with the footer on the stop", async (t) => {
  const h = memoryHarnessFor(t)({
    turns: [[canUseToolCall("Bash", { command: "rm -rf build" }), ...sdkMessages("interrupt")]],
  });
  const session = h.session();
  const turn = await session.submit("clean");
  await h.until(() => pending(h.approvals).length > 0);
  assert.equal(await session.stop(), true);
  await turn.done.wait();
  await settled(h);
  assertOneAtTheEnd(h);
});

test("case 7: an approval that waits leaves the footer off until the turn has ended", async (t) => {
  const messages = sdkMessages("tools");
  const ask = canUseToolCall("Bash", { command: "ls" });
  const h = memoryHarnessFor(t)({
    turns: [[...messages.slice(0, 21), ask, ...messages.slice(21)]],
  });
  const turn = await h.session().submit("list the files");
  await h.until(() => pending(h.approvals).length > 0);
  await h.sleep(0.05);
  assert.ok(
    footers(h).every((shown) => !shown),
    "the session waits for the owner",
  );
  const [approvalId] = pending(h.approvals);
  assert.ok(approvalId !== undefined);
  assert.notEqual(h.approvals.resolve(approvalId, CHANNEL, THREAD, APPROVE), null);
  await turn.done.wait();
  await settled(h);
  assertOneAtTheEnd(h);
});

test("case 8: a process lost in the middle of a turn ends it with the footer", async (t) => {
  const messages = sdkMessages("tools");
  const h = memoryHarnessFor(t)({ turns: [messages.slice(0, 21)] });
  const session = h.session();
  await session.submit("list the files");
  await h.sleep(0.05);
  h.clients[0]?.inject([END_OF_STREAM]);
  await h.until(() => inside(session).client === null);
  await settled(h);
  assertOneAtTheEnd(h);
});

test("case 8: a process lost under a command that runs puts the footer under the last message", async (t) => {
  const [first] = splitBackground();
  const h = memoryHarnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await settled(h);
  assert.deepEqual(footers(h), [false]);
  h.clients[0]?.inject([END_OF_STREAM]);
  await h.until(() => inside(session).client === null);
  await settled(h);
  assertOneAtTheEnd(h);
});

test("case 10: a report that never comes lets the footer show when the wait runs out", async (t) => {
  const [first, notice] = splitBackground();
  const h = memoryHarnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await settled(h);
  assert.deepEqual(footers(h), [false]);
  h.clients[0]?.inject(notice.filter((item) => !isSystem(item, "task_notification")));
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT);
  await h.until(() => session.idle);
  await settled(h);
  assertOneAtTheEnd(h);
});

test("a prompt that could not start has no footer, not even at a later close", async (t) => {
  const h = memoryHarnessFor(t)({ startError: new Error("the CLI would not start"), turns: [] });
  const session = h.session();
  await (await session.submit("hello")).done.wait();
  await settled(h);
  assert.ok(
    footers(h).every((shown) => !shown),
    "no footer for a prompt that never started",
  );
  await session.close(texts.ENDED_IDLE);
  await settled(h);
  assert.ok(
    footers(h).every((shown) => !shown),
    "and none at the idle close",
  );
});

test("an end that did not land has no footer, not even at a later close", async (t) => {
  const h = memoryHarnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  // The reply is written, and the chat refuses its end.
  const ending = h.room.hold("closeOut");
  const turn = await session.submit("list");
  await ending.reached.wait();
  const [reply] = h.room.written(h.channel);
  assert.ok(reply !== undefined, "the reply was written to the chat");
  h.room.refuse("closeOut", reply.id);
  ending.release();
  await turn.done.wait();
  await h.until(() => inside(session).errorStanding);
  assert.equal(footers(h).length, 1);
  assert.ok(footers(h).every((shown) => !shown));
  await session.close(texts.ENDED_IDLE);
  await settled(h);
  assert.equal(footers(h).length, 1, "the reply is still the thread's one message");
  assert.ok(
    footers(h).every((shown) => !shown),
    "the close adds no footer by edit",
  );
});

test("a reply closed by the wait for a report running out gets the footer by an edit", async (t) => {
  const [first, notice] = splitBackground();
  const h = memoryHarnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await settled(h);
  h.clients[0]?.inject(notice.filter((item) => !isSystem(item, "task_notification")));
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT);
  await h.until(() => session.idle);
  await settled(h);
  assertOneAtTheEnd(h);
});

test("a stopped task's end closes its reply, then an edit adds the footer", async (t) => {
  const items = sdkMessages("session-state-agent");
  const first = items.findIndex(isResult);
  const h = memoryHarnessFor(t)({ turns: [items.slice(0, first + 1)] });
  const session = h.session();
  await (await session.submit("launch it")).done.wait();
  await settled(h);
  assert.equal(await session.stop(), true);
  const agent = items.findIndex(
    (item, index) =>
      index > first &&
      isSystem(item, "task_notification") &&
      recordOf(item)?.task_id === "a04b29a98c245a875",
  );
  h.clients[0]?.inject([
    { record: { ...(recordOf(items[agent]) ?? {}), status: "stopped" } } as Item,
  ]);
  await h.until(() => session.idle);
  await settled(h);
  assertOneAtTheEnd(h);
});

test("a stopped task's end closes its reply of a turn the stop cut, then an edit adds the footer", async (t) => {
  const items = sdkMessages("session-state-agent");
  const first = items.findIndex(isResult);
  const h = memoryHarnessFor(t)({ turns: [items.slice(0, first)] });
  const session = h.session();
  const turn = await session.submit("launch it");
  await h.until(() => inside(session).runningTaskIds().length > 0);
  assert.equal(await session.stop(), true);
  assert.deepEqual(h.clients[0]?.stoppedTasks, ["a04b29a98c245a875"]);
  const agent = items.findIndex(
    (item, index) =>
      index > first &&
      isSystem(item, "task_notification") &&
      recordOf(item)?.task_id === "a04b29a98c245a875",
  );
  h.clients[0]?.inject([
    { record: { ...(recordOf(items[agent]) ?? {}), status: "stopped" } } as Item,
    items[first] as Item,
  ]);
  await turn.done.wait();
  await h.until(() => session.idle);
  await settled(h);
  assertOneAtTheEnd(h);
});

test("a close while the footer of a task's natural end is being read keeps the footer", async (t) => {
  const items = sdkMessages("session-state-agent");
  const first = items.findIndex(isResult);
  const h = memoryHarnessFor(t)({ turns: [items.slice(0, first + 1)] });
  const session = h.session();
  await (await session.submit("launch it")).done.wait();
  await settled(h);
  const client = h.clients[0];
  assert.ok(client !== undefined);
  const release = new AsyncEvent();
  let reading = false;
  const original = client.contextUsage.bind(client);
  client.contextUsage = async () => {
    reading = true;
    await release.wait();
    return original();
  };
  const agent = items.findIndex(
    (item, index) =>
      index > first &&
      isSystem(item, "task_notification") &&
      recordOf(item)?.task_id === "a04b29a98c245a875",
  );
  // The task ends by itself and no report turn follows: the wait for it runs out, the reply is
  // closed out and its footer read.
  client.inject([{ record: recordOf(items[agent]) ?? {} } as Item]);
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT);
  await h.until(() => reading);
  await session.close();
  release.set();
  await settled(h);
  assertOneAtTheEnd(h);
});

test("a report expected from a crossed owner query: the footer once the wait for it runs out", async (t) => {
  // The guess went wrong: the owner's turn answers while a report is still expected, and the
  // wait for it runs out. The answer's reply ends before that, so the footer follows.
  const h = memoryHarnessFor(t)({ turns: [] });
  const session = h.session();
  const owner = await session.submit("what happened");
  await h.until(() => h.clients.length > 0 && h.clients.at(-1)?.queries.join() === "what happened");
  inside(session).expectInjectedTurn();
  h.clients[0]?.inject(splitTurns(sdkMessages("tools"))[0] ?? []);
  await owner.done.wait();
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT);
  await h.until(() => session.idle);
  await settled(h);
  assertOneAtTheEnd(h);
});

/** A tools turn left open before its result, and a footer read that waits to be released. */
async function heldRead(h: Harness) {
  const session = h.session();
  const first = await session.submit("first");
  await h.until(() => h.clients.length > 0 && h.clients[0]?.queries.join() === "first");
  const client = h.clients[0];
  assert.ok(client !== undefined);
  const release = new AsyncEvent();
  let reading = false;
  const original = client.contextUsage.bind(client);
  client.contextUsage = async () => {
    reading = true;
    await release.wait();
    return original();
  };
  const result = sdkMessages("tools").at(-1);
  assert.ok(result !== undefined);
  client.inject([result]);
  await h.until(() => reading);
  return { session, first, release };
}

test("a footer read that work outlives is not drawn, and the next end draws its own", async (t) => {
  const tools = sdkMessages("tools");
  const h = memoryHarnessFor(t)({ turns: [tools.slice(0, -1), tools] });
  const { session, release } = await heldRead(h);
  const second = await session.submit("second"); // new work while the first end reads its footer
  release.set();
  await second.done.wait();
  await settled(h);
  assertOneAtTheEnd(h);
});

test("a close right after the stop of a subagent keeps the footer the stop owed", async (t) => {
  // The stop closes the process and the session is at rest; the close that follows
  // must not lose or double the footer.
  const items = sdkMessages("session-state-agent");
  const first = items.findIndex(isResult);
  const h = memoryHarnessFor(t)({ turns: [items.slice(0, first + 1)] });
  const session = h.session();
  await (await session.submit("launch it")).done.wait();
  await settled(h);
  assert.equal(await session.stop(), true);
  await session.close();
  await settled(h);
  assertOneAtTheEnd(h);
});

test("case 9: a restart drain waits for the session to end and the footer shows once", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = memoryHarnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await settled(h);
  assert.ok(
    footers(h).every((shown) => !shown),
    "the command runs: no footer yet",
  );
  const cut = new AbortController();
  let finished = false;
  const drain = h.manager.drain(cut.signal).then(() => {
    finished = true;
  });
  await h.idle();
  assert.equal(finished, false, "the drain waits for the command and its report");
  h.clients[0]?.inject([...notice, ...injected]);
  const deadline = Date.now() + 20_000;
  while (!finished && Date.now() < deadline) {
    await h.idle();
    await h.clock.advance(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  await drain;
  await settled(h);
  assertOneAtTheEnd(h);
});

/** The recorded background command as a second one: its task and its call renamed. */
function anotherCommand(): Item[] {
  const json = JSON.stringify(sdkMessages("background"))
    .replaceAll("bny2rux7d", "bny2rux7e")
    .replaceAll("toolu_01LiZwhcy5g12fYSVLgAq5TS", "toolu_01LiZwhcy5g12fYSVLgAq5TT");
  return JSON.parse(json) as Item[];
}

test("a reply its report closed while a command runs: the footer when that command's report never comes", async (t) => {
  // Seen by the second review of 6f63b91: the closed reply was handed the footer, and dropped it.
  const [first, notice] = splitBackground();
  const [second, secondNotice, secondReport] = splitBackground(anotherCommand());
  const h = memoryHarnessFor(t)({ turns: [first, second] });
  const session = h.session();
  await (await session.submit("start one")).done.wait();
  await settled(h);
  await (await session.submit("start another")).done.wait();
  await settled(h);
  h.clients[0]?.inject([...secondNotice, ...secondReport]);
  await h.until(() => inside(session).active === null && !inside(session).injectedExpected);
  await settled(h);
  assert.ok(session.runningKinds !== "", "the first command still runs");
  assert.ok(
    footers(h).every((shown) => !shown),
    "no footer while it runs",
  );
  // Its notification arrives, its report turn never does.
  h.clients[0]?.inject(notice);
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT);
  await h.until(() => session.idle);
  await settled(h);
  assertOneAtTheEnd(h);
});

test("a prompt that fails while the footer is read leaves that footer to be drawn", async (t) => {
  const tools = sdkMessages("tools");
  const h = memoryHarnessFor(t)({ turns: [tools.slice(0, -1)] });
  const { session, release } = await heldRead(h);
  const client = h.clients[0];
  assert.ok(client !== undefined);
  const refusing = new AsyncEvent();
  let sending = false;
  client.send = async () => {
    sending = true;
    await refusing.wait();
    throw new Error("the CLI refused the prompt");
  };
  const second = await session.submit("second");
  await h.until(() => sending);
  release.set(); // the read ends while the prompt is on its way: the session has not ended
  await h.idle();
  refusing.set();
  await second.done.wait();
  await h.until(() => session.idle);
  await settled(h);
  const [first] = footers(h);
  assert.equal(first, true, "the footer of the first end is drawn");
  assert.equal(footers(h).filter(Boolean).length, 1, "and the failed prompt's notice has none");
});

/**
 * Submits the first prompt. Its reply's end does not land, and the chat's retry of it (`waitLanded`)
 * is held until `release`, when it fails too.
 */
async function firstEndFails(h: Harness, session: ThreadSession): Promise<{ release(): void }> {
  const ending = h.room.hold("closeOut");
  const retry = h.room.hold("waitLanded");
  await session.submit("first");
  await ending.reached.wait();
  const [first] = h.room.written(h.channel);
  assert.ok(first !== undefined);
  h.room.refuse("closeOut", first.id);
  ending.release();
  await retry.reached.wait();
  return { release: () => retry.release() };
}

test("a turn that starts while an earlier end retries keeps its footer when that retry fails", async (t) => {
  // Seen by the second review of 6f63b91: the failed retry forwent the footer of the later turn.
  // The first reply's end is under way (held in the chat) while the second turn starts, and it
  // does not land.
  const tools = sdkMessages("tools");
  const result = tools.at(-1);
  assert.ok(result !== undefined);
  const h = memoryHarnessFor(t, {}, { rootStatus: true })({ turns: [tools, tools.slice(0, -1)] });
  const session = h.session();
  const retry = await firstEndFails(h, session);
  const second = await session.submit("second");
  await h.until(() => h.clients[0]?.queries.length === 2);
  await h.idle();
  retry.release();
  await h.until(() => inside(session).errorStanding);
  h.clients[0]?.inject([result]);
  await second.done.wait();
  await h.until(() => session.idle);
  await settled(h);
  assertOneAtTheEnd(h);
});

test("a turn that ends while an earlier end retries keeps its footer when that retry fails", async (t) => {
  // Seen by the review of the rework: the later turn ended while the earlier reply was still
  // unlanded, so the session had not ended; the retry's failure must not leave it so.
  const tools = sdkMessages("tools");
  const h = memoryHarnessFor(t, {}, { rootStatus: true })({ turns: [tools, tools] });
  const session = h.session();
  const retry = await firstEndFails(h, session);
  await (await session.submit("second")).done.wait();
  await h.idle();
  await h.idle();
  assert.ok(
    footers(h).every((shown) => !shown),
    "the first end is still owed: no footer yet",
  );
  retry.release();
  await h.until(() => inside(session).errorStanding);
  await settled(h);
  assertOneAtTheEnd(h);
});

test("a close that cuts a turn's end still ends it with the footer", async (t) => {
  // Seen by the second review of 6f63b91: the footer was claimed before the end that was cut.
  const tools = sdkMessages("tools");
  const h = memoryHarnessFor(t)({ turns: [tools.slice(0, 68)] });
  const session = h.session();
  await session.submit("list the files");
  await h.until(() => h.clients[0]?.queries.length === 1);
  await settled(h);
  // The turn's end is under way (its `finish` held in the chat) when the close comes.
  const held = h.room.hold("finish");
  h.clients[0]?.inject(tools.slice(68));
  await held.reached.wait();
  await h.until(() => inside(session).active?.renderer.result != null);
  const closing = session.close(texts.ENDED_IDLE);
  await h.sleep(0.05);
  held.release();
  await closing;
  await settled(h);
  assertOneAtTheEnd(h);
});
