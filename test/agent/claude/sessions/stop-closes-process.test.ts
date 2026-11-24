/**
 * `/stop` with no turn running and background tasks alive: the agent's process is closed
 * instead of the tasks stopped one by one, since Claude Code opens a turn of its own to react to
 * a task stopped that way and the agent carries on. The next message resumes the same session;
 * the process that resumes it tells of the tasks it lost (`stop-close-resume`, recorded on
 * 2026-10-18 with `@anthropic-ai/claude-agent-sdk` 0.3.302, Claude Code 2.1.302 and the daemon's
 * options) and ends an empty turn: neither shows. The stop's own words (`Stopped.`) are the
 * flow's, read in `test/core/flows/stop-in-flight.test.ts`; here the session is stopped as the
 * flow does, and what the chat is shown is read from the memory chat.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskUpdate } from "../../../../src/chat/seam.ts";
import { STOPPED } from "../../../../src/core/reply/words.ts";
import { INJECTED_TURN_WAIT } from "../../../../src/core/sessions/constants.ts";
import * as texts from "../../../../src/core/texts.ts";
import { AsyncEvent } from "../../../support/fake-clock.ts";
import { type JsonObject, sdkRecords } from "../../../support/fixtures.ts";
import { CHANNEL, OTHER_THREAD, THREAD } from "../../../support/ids.ts";
import {
  type Harness,
  type Item,
  isResult,
  memoryHarnessFor,
  recordOf,
  requestWhileStreaming,
  sdkMessages,
} from "../../../support/sessions.ts";
import { replyCount, rootStatuses } from "./helpers.ts";

/** The recorded subagent that outlives its turn, and the recorded agent with a command. */
const AGENT = "a04b29a98c245a875";
const BOTH = ["a2212140c7c7bb15e", "btmuz8js3"];
const EARLIER = { model: "claude-haiku-5-5", percentage: 5 };

/** A turn whose reply ends with these tasks running. */
function launching(name: string): Item[] {
  const items = sdkMessages(name);
  return items.slice(0, items.findIndex(isResult) + 1);
}

/**
 * What the resumed process emits for the owner's first prompt, from the recording: the stopped
 * notification of each task (the recorded one, once per id), the empty result, then the turn of
 * the prompt. The recorded replay of the prompt is left to the harness, which knows its id.
 */
function resumed(taskIds: readonly string[], sessionId: string): Item[] {
  const records = sdkRecords("stop-close-resume").filter((record) => record.type !== "user");
  const out: JsonObject[] = [];
  for (const record of records) {
    if (record.subtype === "task_notification") {
      for (const task_id of taskIds) out.push({ ...record, task_id });
    } else {
      out.push(record);
    }
  }
  const recorded = String(out.find((record) => record.session_id)?.session_id);
  return JSON.parse(JSON.stringify(out).replaceAll(recorded, sessionId)).map(
    (record: JsonObject) => ({ record }),
  );
}

/** The session id a recording carries. */
function recordedSession(items: readonly Item[]): string {
  const found = items.map((item) => recordOf(item)?.session_id).find((id) => id !== undefined);
  return String(found);
}

/**
 * A harness whose first turn launched the tasks of `name`, its reply ended, ready to be stopped;
 * the process that resumes the session after the stop plays what `lost` names (the recording of
 * the resume, with the id of the first turn's session).
 */
async function running(
  t: Parameters<typeof memoryHarnessFor>[0],
  name: string,
  lost: readonly string[] = [AGENT],
) {
  const first = launching(name);
  const h = memoryHarnessFor(
    t,
    {},
    { rootStatus: true },
  )({ turns: [first] }, { turns: [resumed(lost, recordedSession(first))] });
  const session = h.session();
  await (await session.submit("launch it")).done.wait();
  await h.until(() => session.stillRunning !== "");
  const client = h.clients[0];
  assert.ok(client !== undefined);
  return { h, session, first: client };
}

function sessionId(h: Harness): string {
  const stored = h.state.thread(CHANNEL, THREAD)?.sessionId;
  assert.ok(stored, "the first turn recorded its session id");
  return stored;
}

/** What the chat has been shown so far, in order, with the status calls left out. */
function shown(h: Harness): string[] {
  return h.room.written(h.channel).map((message) => message.text);
}

test("a stop with a subagent in the background closes the process, stops no task, and shows nothing more", async (t) => {
  const { h, session, first } = await running(t, "session-state-agent");
  const before = h.room.written(h.channel).length;
  assert.ok(before > 0, "the running turn's reply is written");
  assert.equal(await session.stop(), true);
  assert.equal(first.connected, false, "the process is closed");
  assert.deepEqual(first.stoppedTasks, [], "no task is stopped one by one");
  assert.equal(first.interrupts, 0);
  assert.equal(
    h.room.written(h.channel).length,
    before,
    "the stop writes no message: the flow says Stopped.",
  );
  assert.equal(rootStatuses(h).at(-1), "done");
  assert.equal(h.clients.length, 1, "nothing starts a process meanwhile");
});

test("the next message resumes the session, and its reply is the only new one", async (t) => {
  const { h, session, first } = await running(t, "session-state-agent");
  await session.stop();
  const id = sessionId(h);
  const replies = replyCount(h);
  await (await session.submit("what now?")).done.wait();
  await h.idle();
  const second = h.clients[1];
  assert.ok(second !== undefined, "a new process");
  assert.equal(second.options.resume, id, "the same session id");
  assert.deepEqual(second.queries, ["what now?"], "the prompt reaches it, once");
  assert.equal(first.connected, false);
  assert.equal(replyCount(h), replies + 1, "one new reply");
  assert.ok(
    !shown(h).join("\n").includes("previous session"),
    "the lost-task notification shows nothing",
  );
  assert.equal(footerLines(h), replyCount(h), "every reply is drawn, a footer each");
  assert.equal(sessionId(h), id);
  assert.equal(rootStatuses(h).at(-1), "done");
});

test("a process resumed with no prompt waiting tells of the lost task, and nothing shows or waits", async (t) => {
  const { h, session } = await running(t, "session-state-agent");
  await session.stop();
  const id = sessionId(h);
  // A daemon word connects the session with no turn; the recording's first part is all there is
  // (its notification and its empty result, without the prompt's turn).
  await session.ensureConnected();
  const lost = resumed([AGENT], id);
  h.clients[1]?.inject(lost.slice(0, lost.findIndex(isResult) + 1));
  const before = [shown(h), replyCount(h)];
  assert.ok(footerLines(h) > 0, "the stopped turn's reply is drawn");
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT + 1);
  await h.idle();
  assert.deepEqual(
    [shown(h), replyCount(h)],
    before,
    "no reply for the empty turn, nothing written",
  );
  assert.equal(session.restartReady, true);
  assert.equal(session.reporting, false);
});

test("two tasks end with the process, and the resume tells of both without a line", async (t) => {
  const { h, session, first } = await running(t, "subagent-handback", BOTH);
  await session.stop();
  assert.deepEqual(first.stoppedTasks, []);
  assert.equal(first.connected, false);
  const replies = replyCount(h);
  await (await session.submit("status?")).done.wait();
  await h.idle();
  assert.equal(replyCount(h), replies + 1);
  assert.deepEqual(h.clients[1]?.queries, ["status?"]);
  assert.ok(!shown(h).join("\n").includes("previous session"));
  assert.equal(footerLines(h), replyCount(h), "every reply is drawn, a footer each");
});

test("a stop during a turn still interrupts it and stops its tasks one by one", async (t) => {
  const items = sdkMessages("session-state-agent");
  const h = memoryHarnessFor(
    t,
    {},
    { rootStatus: true },
  )({ turns: [items.slice(0, items.findIndex(isResult))] });
  const session = h.session();
  await session.submit("launch it");
  await h.until(() => h.clients[0] !== undefined && session.busy && replyCount(h) > 0);
  const client = h.clients[0];
  assert.ok(client !== undefined);
  void session.stop();
  await h.until(() => client.interrupts > 0);
  assert.equal(client.interrupts, 1);
  assert.equal(client.connected, true, "the process stays");
  assert.deepEqual(client.stoppedTasks, [AGENT], "its task is stopped by itself");
});

test("a restart's drain right after such a stop is not held", async (t) => {
  const { h, session } = await running(t, "subagent-handback");
  await session.stop();
  assert.equal(session.restartReady, true);
  assert.equal(session.restartHold, "");
  await h.manager.drain(new AbortController().signal);
});

test("a stop of the whole channel follows the same rule for each session", async (t) => {
  const { h, first } = await running(t, "session-state-agent");
  assert.equal(await h.manager.stopChannel(CHANNEL), true);
  assert.equal(first.connected, false, "the process is closed");
  assert.deepEqual(first.stoppedTasks, []);
  assert.equal(first.interrupts, 0);
  assert.equal(rootStatuses(h).at(-1), "done");
});

test("bypass and effort survive the stop and the resume", async (t) => {
  const { h, session } = await running(t, "session-state-agent");
  h.state.setBypass(CHANNEL, THREAD, true);
  h.state.setEffort(CHANNEL, THREAD, "high");
  await session.stop();
  await (await session.submit("go on")).done.wait();
  const second = h.clients[1];
  assert.ok(second !== undefined);
  assert.equal(second.options.effort, "high");
  assert.deepEqual(second.modes, ["bypassPermissions"]);
  assert.equal(h.state.thread(CHANNEL, THREAD)?.bypass, true);
});

test("a session object made after an idle close tells of the lost task and nothing shows", async (t) => {
  // Nothing is stored of the stop: a daemon that restarted, or an idle close, resumes with a
  // session object that never saw the task. The process's word on it is dropped all the same.
  const { h, session: old } = await running(t, "session-state-agent");
  await old.stop();
  await old.close(texts.ENDED_IDLE);
  await h.idle();
  const replies = replyCount(h);
  const session = h.session();
  assert.notEqual(session, old, "a session object of its own");
  await (await session.submit("what now?")).done.wait();
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT + 1);
  await h.idle();
  assert.deepEqual(h.clients[1]?.queries, ["what now?"]);
  assert.equal(replyCount(h), replies + 1, "one new reply: the prompt's");
  assert.ok(!shown(h).join("\n").includes("previous session"));
  assert.equal(footerLines(h), replyCount(h), "every reply is drawn, a footer each");
});

for (const aborted of [false, true]) {
  test(`an approval a background agent waits on goes with the stop (aborted by the close: ${aborted})`, async (t) => {
    const { h, session, first } = await running(t, "session-state-agent");
    const abort = new AbortController();
    first.inject([requestWhileStreaming("Bash", { command: "rm -rf build" }, "toolu_bg_1", abort)]);
    await h.until(() => session.waitingForOwner);
    assert.equal(h.room.requests().length, 1, "the request is on screen");
    await session.stop();
    if (aborted) abort.abort(); // the SDK gives the request up when the process closes
    await h.idle();
    assert.equal(session.waitingForOwner, false);
    assert.deepEqual(h.room.requests(), [], "no live control is left");
    assert.equal(rootStatuses(h).at(-1), "done", "and the root stays done");
    assert.equal(session.restartReady, true);
  });
}

test("the footer a stop draws names the model and the context share", async (t) => {
  const { h, session } = await running(t, "session-state-agent");
  await session.stop();
  await h.idle();
  const footer = shown(h).filter((text) => text.includes(h.tmpPath));
  assert.equal(footer.length, 1, shown(h).join("\n"));
  assert.match(footer[0] ?? "", /Haiku/);
  assert.match(footer[0] ?? "", /\d+% context/);
});

test("no process resumes while the stop is still drawing the ends", async (t) => {
  const { h, session } = await running(t, "subagent-handback", BOTH);
  const drawing = h.room.hold("closeOut");
  const stopping = session.stop();
  await drawing.reached.wait(); // a task's end is being written
  const connecting = session.ensureConnected();
  await h.idle();
  assert.equal(h.clients.length, 1, "the resume waits for the stop to finish drawing");
  drawing.release();
  await stopping;
  await connecting;
  assert.equal(h.clients.length, 2);
  const lost = resumed(BOTH, sessionId(h));
  h.clients[1]?.inject(lost.slice(0, lost.findIndex(isResult) + 1));
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT + 1);
  await h.idle();
  assert.equal(session.restartReady, true);
  assert.equal(session.runningKinds, "");
  assert.equal(replyCount(h), 1);
});

test("a stop of the channel closes the processes of its sessions together", async (t) => {
  const first = launching("session-state-agent");
  const h = memoryHarnessFor(t, {}, { rootStatus: true })({ turns: [first] }, { turns: [first] });
  const one = h.session();
  const other = h.session(OTHER_THREAD);
  await (await one.submit("launch it")).done.wait();
  await (await other.submit("and this")).done.wait();
  const [firstClient, secondClient] = h.clients;
  assert.ok(firstClient !== undefined && secondClient !== undefined);
  const gate = new AsyncEvent();
  const entered: number[] = [];
  for (const [index, client] of [firstClient, secondClient].entries()) {
    const close = client.close.bind(client);
    client.close = async () => {
      entered.push(index);
      await gate.wait();
      return close();
    };
  }
  const stopping = h.manager.stopChannel(CHANNEL);
  await h.until(() => entered.length === 2);
  assert.deepEqual(entered.toSorted(), [0, 1], "the second close starts while the first waits");
  gate.set();
  assert.equal(await stopping, true);
  assert.equal(firstClient.connected, false);
  assert.equal(secondClient.connected, false);
});

/**
 * A harness whose first turn left a background task running, the context read of its process set
 * before the turn ends (the process answers `read` from its start).
 */
async function endedWithTask(
  t: Parameters<typeof memoryHarnessFor>[0],
  read: () => Promise<{ model: string; percentage: number }>,
) {
  const h = memoryHarnessFor(
    t,
    {},
    { rootStatus: true },
  )({ turns: [launching("subagent-handback")] });
  const start = h.backend.start.bind(h.backend);
  h.backend.start = async (options, requests) => {
    const client = (await start(options, requests)) as (typeof h.clients)[number];
    client.contextUsage = read;
    return client;
  };
  const session = h.session();
  await (await session.submit("launch it")).done.wait();
  await h.idle();
  const client = h.clients[0];
  assert.ok(client !== undefined);
  return { h, session, client };
}

/** How many replies show a footer (a line naming the folder): the positive read beside a negative. */
function footerLines(h: Harness): number {
  return shown(h).filter((text) => text.includes(h.tmpPath)).length;
}

/** The footer line a stop drew: the reply text that names the folder. */
function stopFooter(h: Harness): string {
  const lines = shown(h).filter((text) => text.includes(h.tmpPath));
  assert.equal(lines.length, 1, shown(h).join("\n"));
  return lines[0] ?? "";
}

test("a context read the CLI never answers does not hold the stop, the close or the lock", async (t) => {
  // No timeout on a control request in the SDK: neither the turn-end read nor the stop's answers.
  const { h, session, client } = await endedWithTask(t, () => new Promise(() => {}));
  assert.equal(await session.stop(), true, "the stop returns");
  assert.equal(client.connected, false, "the process is closed");
  assert.equal(rootStatuses(h).at(-1), "done");
  // No read ever answered: the footer has no context share, and nothing crashed.
  assert.ok(footerLines(h) > 0, "the footer is drawn, without a share");
  assert.doesNotMatch(shown(h).join("\n"), /\d+% context/);
  await session.close();
  assert.equal(session.closed, true);
});

test("a stop whose read never answers draws the context an earlier footer read", async (t) => {
  const { h, session, first } = await running(t, "subagent-handback");
  first.contextUsage = async () => EARLIER;
  await session.status(); // a live read: model and context are kept
  first.contextUsage = () => new Promise(() => {});
  await session.stop();
  await h.idle();
  assert.match(stopFooter(h), /5% context/);
  assert.match(stopFooter(h), /Haiku 5\.5/);
});

test("a stop whose read answers draws that read, not the earlier one", async (t) => {
  const { h, session, first } = await running(t, "subagent-handback");
  const fresh = first.contextUsage.bind(first);
  first.contextUsage = async () => EARLIER;
  await session.status();
  first.contextUsage = fresh;
  await session.stop();
  await h.idle();
  assert.doesNotMatch(stopFooter(h), /\b5% context/);
  assert.match(stopFooter(h), /\d+% context/);
});

// A share read before a model switch or a compaction no longer holds: the stop's footer must not
// show it beside the new model or the compacted context.
for (const [what, event] of [
  ["a model switch", { type: "model_changed", model: "claude-opus-5-5" }],
  ["a compaction", { type: "compaction_started" }],
] as const) {
  test(`${what} after the last read leaves the stop's footer without its share`, async (t) => {
    const { h, session, first } = await running(t, "subagent-handback");
    first.contextUsage = async () => EARLIER;
    await session.status(); // share 5%
    first.inject([{ event }]);
    await h.idle();
    first.contextUsage = () => new Promise(() => {});
    await session.stop();
    await h.idle();
    assert.doesNotMatch(stopFooter(h), /5% context/);
  });
}

test("the read made when a turn ends under background work feeds the footer of a later stop", async (t) => {
  let reads = 0;
  const { h, session, client } = await endedWithTask(t, async () => {
    reads += 1;
    return EARLIER;
  });
  assert.equal(reads, 1, "one control request for the turn");
  client.contextUsage = () => new Promise(() => {}); // the stop's own read loses the race
  await session.stop();
  await h.idle();
  assert.match(stopFooter(h), /5% context/);
  assert.match(stopFooter(h), /Haiku 5\.5/);
});

test("a model switch while the turn-end read is on its way voids it", async (t) => {
  let answer: (usage: typeof EARLIER) => void = () => {};
  const first = launching("subagent-handback");
  const h = memoryHarnessFor(t, {}, { rootStatus: true })({ turns: [first] });
  const start = h.backend.start.bind(h.backend);
  h.backend.start = async (options, requests) => {
    const client = (await start(options, requests)) as (typeof h.clients)[number];
    client.contextUsage = () => new Promise((resolve) => (answer = resolve));
    return client;
  };
  const session = h.session();
  await (await session.submit("launch it")).done.wait();
  await h.idle();
  const client = h.clients[0];
  assert.ok(client !== undefined);
  client.inject([{ event: { type: "model_changed", model: "claude-opus-5-5" } }]);
  await h.idle();
  answer(EARLIER); // started before the switch: its share is the old model's
  await h.idle();
  client.contextUsage = () => new Promise(() => {});
  await session.stop();
  await h.idle();
  assert.doesNotMatch(stopFooter(h), /5% context/);
});

/** The cards of the chat, each as `[status] title`, in the order written. */
function cardLines(h: Harness): string[] {
  return shown(h).flatMap((text) => text.split("\n").filter((line) => /^\[[a-z_]+\] /.test(line)));
}

test("a move to the terminal during a turn ends the background work of the replies before it", async (t) => {
  const first = launching("session-state-agent");
  const second = sdkMessages("tools").slice(0, -1);
  const h = memoryHarnessFor(t, {}, { rootStatus: true })({ turns: [first, second] });
  const session = h.session();
  await (await session.submit("launch it")).done.wait();
  await h.until(() => session.stillRunning !== "");
  const agent = cardLines(h).find((line) => line.includes("Agent"));
  assert.ok(agent?.startsWith("[in_progress]"), `the agent runs: ${agent}`);
  await session.submit("go on");
  await h.until(() => session.busy && h.clients[0] !== undefined);
  assert.equal(await session.moveToTerminal(), "cut");
  await h.idle();
  assert.equal(session.stillRunning, "", "no task is left running");
  assert.equal(session.runningKinds, "");
  // Closed `Stopped`, not ended on its own: `complete` alone holds for both.
  const closed = h.room
    .calls("task")
    .map((call) => call.args[0] as TaskUpdate)
    .filter((update) => update.title.includes("Agent"))
    .at(-1);
  assert.equal(closed?.status, "complete");
  assert.equal(closed?.output, STOPPED);
  assert.ok(shown(h).join("\n").includes(texts.MOVED_TO_TERMINAL));
  assert.equal(rootStatuses(h).at(-1), "done");
});
