/**
 * A session's replies: what opens one, what ends it, what cuts a turn short, what a reply whose end
 * did not land leaves behind, and the thread's status line. The chat is the memory chat, with the
 * capabilities a block reads turned on.
 */
import assert from "node:assert/strict";
import { mock, type TestContext, test } from "node:test";
import type { TaskUpdate } from "../../../../src/chat/seam.ts";
import { APPROVE } from "../../../../src/core/requests.ts";
import { INJECTED_TURN_WAIT } from "../../../../src/core/sessions/constants.ts";
import { AsyncEvent } from "../../../support/fake-clock.ts";
import { CHANNEL, THREAD } from "../../../support/ids.ts";
import type { MemoryChatOptions } from "../../../support/memory-chat.ts";
import { memoryChats, RELAY_SET } from "../../../support/memory-session-chat.ts";
import {
  canUseToolCall,
  END_OF_STREAM,
  type Harness,
  type HarnessOptions,
  harnessFor,
  type Item,
  type Script,
  sdkMessages,
  splitTurns,
} from "../../../support/sessions.ts";
import {
  activityKinds,
  footers,
  inside,
  isReport,
  pending,
  replyCount,
  rootStatuses,
  splitBackground,
  systemRecord,
} from "./helpers.ts";

/** The harness on the relay's capability set, with the capabilities a block reads turned on. */
function harness(
  t: TestContext,
  scripts: Script[],
  options: HarnessOptions = {},
  chat: MemoryChatOptions = {},
): Harness {
  return harnessFor(t, options, memoryChats({ ...RELAY_SET, ...chat }))(...scripts);
}

/**
 * The recorded `tools` turn, asking for permission right after its Bash call starts: Claude has
 * already written by then.
 */
function withAsk(ask: Item): Item[] {
  const messages = sdkMessages("tools");
  return [...messages.slice(0, 21), ask, ...messages.slice(21)];
}

/** The replies of the thread as they are now, in the order they were opened. */
function replies(h: Harness) {
  return h.room.written(h.channel).filter((message) => message.kind === "reply");
}

/** Whether each reply has been ended, in the order they were opened. */
function ended(h: Harness): boolean[] {
  return replies(h).map((reply) => !reply.unfinished);
}

/** The text of every message the daemon wrote, in order. */
function written(h: Harness): string[] {
  return h.room.written(h.channel).map((message) => message.text);
}

function approve(h: Harness): void {
  const [approvalId] = pending(h.approvals);
  assert.ok(approvalId !== undefined);
  assert.notEqual(h.approvals.resolve(approvalId, CHANNEL, THREAD, APPROVE), null);
}

function thread(h: Harness) {
  const stored = h.state.thread(CHANNEL, THREAD);
  assert.ok(stored !== null);
  return stored;
}

/** The first reply of the thread, which the test holds a call of the chat for. */
function firstReply(h: Harness) {
  const [reply] = replies(h);
  assert.ok(reply !== undefined, "the reply was written to the chat");
  return reply;
}

test("a turn is one stream that stops, and the footer follows by an edit", async (t) => {
  const h = harness(t, [{ turns: [sdkMessages("tools")] }], {}, { nativeStreaming: true });
  const ending = h.room.hold("closeOut");
  const turn = await h.session().submit("list the files");
  await ending.reached.wait();
  // one message, no placeholder before it, still open and with no footer while its end is made
  const [only, ...others] = h.room.written(h.channel);
  assert.equal(others.length, 0);
  assert.equal(only?.kind, "reply");
  assert.deepEqual([ended(h), footers(h)], [[false], [false]]);
  ending.release();
  await turn.done.wait();
  await h.until(() => ended(h).every(Boolean));
  await h.idle();
  assert.deepEqual(footers(h), [true]); // the session has ended: its footer, by an edit
  assert.equal(h.room.written(h.channel).length, 1);
  // a chat that streams is handed the texts as they are written, in pieces
  assert.ok(h.room.calls("text").length > 1);
});

test("submitting writes nothing until claude has something to show", async (t) => {
  const h = harness(t, [{}]); // a turn that never answers
  const session = h.session();
  await session.submit("hello");
  await h.until(() => h.clients.length > 0 && h.clients.at(-1)?.queries.join() === "hello");
  await h.sleep(0.05);
  assert.deepEqual(written(h), []); // nothing says Claude is writing, or waiting for the previous reply
  h.clients.at(-1)?.answer(sdkMessages("tools").slice(0, 21)); // the same view shows it once Claude writes
  await h.until(() => written(h).length > 0);
  assert.equal(replyCount(h), 1);
});

test("a queued message has no reply until its turn starts", async (t) => {
  const ask = canUseToolCall("Bash", { command: "ls" });
  const h = harness(t, [{ turns: [[ask, ...sdkMessages("tools")], sdkMessages("tools")] }]);
  const session = h.session();
  const first = await session.submit("first");
  const second = await session.submit("second");
  await h.until(() => pending(h.approvals).length > 0);
  await h.sleep(0.05);
  assert.equal(h.room.requests().length, 1); // the approval is shown: the view records what is written
  assert.equal(replyCount(h), 0); // neither reply has started
  approve(h);
  await second.done.wait();
  assert.ok(first.done.isSet);
  assert.equal(replyCount(h), 2);
  await h.until(() => ended(h).every(Boolean));
});

test("a tool first turn and its cards read as the recorded turn", async (t) => {
  const h = harness(t, [{ turns: [sdkMessages("tools")] }]);
  const turn = await h.session().submit("list the files");
  await turn.done.wait();
  await h.idle();
  const cards = h.room.calls("task").map((call) => call.args[0] as TaskUpdate);
  assert.ok(cards.length > 0 && cards.every((card) => card.title));
  // Each call ends as a card that is complete, and the run is one reply: no edit adds another.
  const last = new Map(cards.map((card) => [card.id, card]));
  assert.ok([...last.values()].every((card) => card.status === "complete"));
  assert.ok([...last.values()].some((card) => card.name === "Bash" && card.details));
  assert.equal(replyCount(h), 1);
  assert.equal(h.room.written(h.channel).length, 1);
});

test("a reply whose turn left a task running rests with no footer, and its report grows it", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harness(t, [{ turns: [first] }], {}, { rootStatus: true });
  await (await h.session().submit("start it")).done.wait();
  await h.until(() => replyCount(h) === 1);
  await h.idle();
  // The reply ended with the turn, with no footer: the session has not ended.
  assert.deepEqual(footers(h), [false]);
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => written(h).some((text) => isReport(text) || text.includes("✓")));
  await h.until(() => rootStatuses(h).at(-1) === "done");
  await h.idle();
  const summary = String(systemRecord(notice, "task_notification").summary);
  // The report reached the thread, and the session's one footer is under its last message.
  assert.ok(written(h).join("\n").includes(`✓ ${summary}`));
  const shown = footers(h);
  assert.equal(shown.at(-1), true);
  assert.equal(shown.filter(Boolean).length, 1);
  assert.deepEqual(
    ended(h).filter((done) => !done),
    [],
  );
});

test("a process lost while a task runs says so in the reply that waits for it", async (t) => {
  // Seen live on 2026-10-10: the turn has ended, its background command still
  // runs, and the Claude Code process is lost. The reply closed with its footer as if all had
  // ended well; the cross on the root was the only sign.
  const [first] = splitBackground();
  const h = harness(t, [{ turns: [first] }], {}, { rootStatus: true });
  await (await h.session().submit("start it")).done.wait();
  await h.until(() => replyCount(h) === 1);
  await h.idle(); // the reply rests, waiting for its task
  h.clients[0]?.inject([END_OF_STREAM]);
  await h.until(() => rootStatuses(h).at(-1) === "error");
  const said = written(h).join("\n").split("Claude Code reported an error").length;
  assert.equal(said, 2);
  assert.ok(ended(h).every(Boolean));
});

test("a process lost under a command of the owner's says so once, and the root shows the cross", async (t) => {
  const [first] = splitBackground();
  const h = harness(t, [{ turns: [first] }], {}, { rootStatus: true });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await h.until(() => replyCount(h) === 1);
  await h.idle();
  await session.status(); // a message of the owner's below the waiting reply
  assert.ok(!written(h).join("\n").includes("Claude Code reported an error"));
  h.clients[0]?.inject([END_OF_STREAM]);
  await h.until(() => rootStatuses(h).at(-1) === "error");
  // The memory chat's reply is one message that never moves: the line is in it, where the owner's
  // message below it does not matter.
  assert.equal(written(h).join("\n").split("Claude Code reported an error").length, 2);
});

test("a process lost after its task was reported changes nothing in the thread", async (t) => {
  // The reply of a task that ended and was reported is still tracked while the process lives:
  // it has closed with its footer, so it waits for nothing and is left as it is.
  const [first, notice, injected] = splitBackground();
  const h = harness(t, [{ turns: [first] }], {}, { rootStatus: true });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => rootStatuses(h).at(-1) === "done");
  await h.idle();
  await h.sleep(0.1);
  const before = h.room.calls().length;
  const shown = written(h);
  assert.ok(before > 0 && shown.length > 0);
  h.clients[0]?.inject([END_OF_STREAM]);
  await h.until(() => inside(session).client === null);
  await h.sleep(0.1);
  assert.equal(rootStatuses(h).at(-1), "done");
  assert.deepEqual(h.room.calls().slice(before), []);
  assert.deepEqual(written(h), shown);
  assert.ok(!written(h).join("\n").includes("reported an error"));
});

test("a process lost while the session is idle changes nothing in the thread", async (t) => {
  // Seen live on 2026-10-10: nothing runs and nothing waits, so the reply that
  // ended well keeps its check. The next message connects a new process.
  const h = harness(
    t,
    [{ turns: [sdkMessages("usage")] }, { turns: [sdkMessages("usage")] }],
    {},
    {
      rootStatus: true,
    },
  );
  const session = h.session();
  await (await session.submit("hello")).done.wait();
  await h.until(() => rootStatuses(h).at(-1) === "done");
  const before = h.room.calls().length;
  const shown = written(h);
  assert.ok(before > 0 && shown.length > 0);
  h.clients[0]?.inject([END_OF_STREAM]);
  await h.until(() => inside(session).client === null);
  await h.sleep(0.1);
  assert.equal(rootStatuses(h).at(-1), "done");
  // Clearing a thread status that was already empty shows nothing: no message, no status.
  assert.deepEqual(h.room.calls().slice(before), []);
  assert.deepEqual(written(h), shown);
  await (await session.submit("again")).done.wait();
  assert.equal(h.clients.length, 2);
});

// `/stop` ends like any other end, and a restart with queued messages says so once.

test("stop ends the stream, shows the checkmark, and the footer follows", async (t) => {
  const h = harness(
    t,
    [
      {
        turns: [[canUseToolCall("Bash", { command: "rm -rf build" }), ...sdkMessages("interrupt")]],
      },
    ],
    {},
    { rootStatus: true },
  );
  const session = h.session();
  const turn = await session.submit("clean");
  await h.until(() => pending(h.approvals).length > 0);
  assert.equal(await session.stop(), true);
  await turn.done.wait();
  assert.equal(replyCount(h), 1);
  assert.ok(ended(h).every(Boolean));
  assert.deepEqual(footers(h), [false]); // a normal end carries no footer
  await h.until(() => rootStatuses(h).at(-1) === "done");
  await h.idle();
  // The stop's end is the session's: its footer, by an edit, on the reply (the approval request
  // was withdrawn).
  assert.deepEqual(footers(h), [true]);
  assert.deepEqual(h.room.requests(), []);
});

test("a restart with a queued message ends the running reply with its note", async (t) => {
  const ask = canUseToolCall("Bash", { command: "ls" });
  const h = harness(t, [{ turns: [withAsk(ask)] }], {}, { rootStatus: true });
  const session = h.session();
  const first = await session.submit("first question");
  await h.until(() => pending(h.approvals).length > 0 && session.busy);
  // The worker is held at the process (a start, a command's run), so the two stay in the daemon.
  const free = await inside(session).connectLock.acquire();
  await session.submit("second question");
  await session.submit("third question");
  await h.until(() => inside(session).taken !== null);
  await session.dropQueued({ error: true });
  session.draining = true; // as a restart's drain: the worker drops the one it holds, too
  free();
  approve(h);
  await first.done.wait();
  // The request stopped the stream (#25): the note lands in the message by update or in the ending.
  const note = "1 message was not sent because pardner restarted: send it again.";
  const reply = written(h).join("\n");
  assert.ok(reply.includes(note));
  assert.ok(/third question/.test(reply));
  assert.equal(replyCount(h), 1); // the dropped messages get no reply of their own
  // the reply that says it is the thread's latest: the footer is under it
  await h.idle();
  assert.equal(footers(h).at(-1), true);
  assert.ok(rootStatuses(h).includes("error")); // a dropped message shows the cross
});

test("dropped messages with nothing running get one message", async (t) => {
  const gate = new AsyncEvent();
  const h = harness(t, [{ startGate: gate }]);
  const session = h.session();
  await session.submit("first"); // taken by the worker, waiting for the client to connect
  await session.submit("second");
  await session.submit("third");
  await h.sleep(0.05);
  await session.dropQueued({ error: true });
  const [post, ...more] = h.room.written(h.channel);
  assert.equal(more.length, 0);
  assert.ok(String(post?.text).includes("2 messages were not sent because pardner restarted"));
  assert.equal(replyCount(h), 0);
  gate.set();
});

test("one dropped message is named in the singular", async (t) => {
  const gate = new AsyncEvent();
  const h = harness(t, [{ startGate: gate }]);
  const session = h.session();
  await session.submit("first");
  await session.submit("only the second");
  await h.sleep(0.05);
  await session.dropQueued({ error: true });
  const [post, ...more] = h.room.written(h.channel);
  assert.equal(more.length, 0);
  assert.ok(
    String(post?.text).includes("1 message was not sent because pardner restarted: send it again."),
  );
  gate.set();
});

test("an error that cuts a turn ends the stream with the cross", async (t) => {
  const h = harness(
    t,
    [{ turns: [[...sdkMessages("tools").slice(0, 21), END_OF_STREAM]] }],
    {},
    {
      rootStatus: true,
    },
  );
  const turn = await h.session().submit("hello");
  await turn.done.wait();
  await h.until(() => rootStatuses(h).at(-1) === "error");
  assert.ok(ended(h).every(Boolean));
  assert.ok(written(h)[0]?.includes("Claude Code reported an error"));
  // the call that was running is closed, and counted like any call that ended
  const [reply, ...more] = replies(h);
  assert.equal(more.length, 0);
  const cards = h.room.calls("task").map((call) => call.args[0] as TaskUpdate);
  assert.ok(cards.length > 0 && cards.every((card) => card.status !== "pending"));
  assert.ok(reply?.text.includes("[complete]"));
});

// A final write that fails: no checkmark, the cross, and the persisted status kept for repair.

/**
 * The reply is written, and the chat refuses its end: the end is held while the reply is written
 * and refused before it goes through. The test then waits as long as it needs the session to.
 */
async function refuseEnd(h: Harness, session: ReturnType<Harness["session"]>, prompt: string) {
  const ending = h.room.hold("closeOut");
  const turn = await session.submit(prompt);
  await ending.reached.wait();
  h.room.refuse("closeOut", firstReply(h).id);
  ending.release();
  return turn;
}

test("a reply whose end failed shows no checkmark then the cross", async (t) => {
  const h = harness(t, [{ turns: [sdkMessages("tools")] }], {}, { rootStatus: true });
  const session = h.session();
  const turn = await refuseEnd(h, session, "list the files");
  await turn.done.wait();
  await h.idle();
  assert.ok(rootStatuses(h).length > 0); // the root was told its states: the checkmark is not among them
  assert.ok(!rootStatuses(h).includes("done"));
  await h.until(() => rootStatuses(h).at(-1) === "error");
  assert.ok(!rootStatuses(h).includes("done"));
  // kept, so a crash right now is still repaired
  assert.equal(thread(h).status, "working");
  // and the cross the root shows is what the session index reads
  assert.equal(thread(h).ended, "error");
  assert.deepEqual(thread(h).openReplies, [firstReply(h).id]);
});

test("a reply that rests ends whole with the checkmark when its report arrives", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harness(t, [{ turns: [first] }], {}, { rootStatus: true });
  await (await h.session().submit("start it")).done.wait();
  await h.until(() => replyCount(h) === 1);
  await h.idle(); // ended at the end of its turn: the report grows it
  h.clients[0]?.inject([...notice, ...injected]);
  // The report turn ends on a footer, which runs git in real time: on a slow machine the fake
  // clock's 0.2 seconds pass before it does, so the end is waited for and the 0.2 come after.
  await h.until(() => rootStatuses(h).at(-1) === "done");
  await h.sleep(0.2); // past where a failed end's retry would have shown the cross
  assert.equal(rootStatuses(h).at(-1), "done");
  assert.ok(!rootStatuses(h).includes("error"));
  const summary = String(systemRecord(notice, "task_notification").summary);
  assert.ok(written(h).join("\n").includes(`✓ ${summary}`)); // the report reached the thread
  assert.ok(ended(h).every(Boolean));
  assert.equal(thread(h).status, null);
  assert.deepEqual(thread(h).openReplies, []);
  // the footer is under the thread's last message, added by an edit
  await h.idle();
  assert.equal(footers(h).at(-1), true);
});

test("a reply the chat refuses to grow by append and by update shows the cross", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harness(t, [{ turns: [first] }], {}, { rootStatus: true });
  await (await h.session().submit("start it")).done.wait();
  await h.until(() => replyCount(h) === 1);
  await h.sleep(0.05);
  h.room.refuse("rewrite", firstReply(h).id); // the chat takes no more of what the reply writes
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => rootStatuses(h).at(-1) === "error");
  await h.sleep(0.1);
  assert.notEqual(rootStatuses(h).at(-1), "done");
  const summary = String(systemRecord(notice, "task_notification").summary);
  // the report never reached the reply
  assert.ok(!written(h).join("\n").includes(`✓ ${summary}`));
  assert.ok(written(h).length > 0);
});

test("a retry that lands shows the checkmark and clears the status", async (t) => {
  const h = harness(t, [{ turns: [sdkMessages("tools")] }], {}, { rootStatus: true });
  const session = h.session();
  const retry = h.room.hold("waitLanded");
  const ending = h.room.hold("closeOut");
  const turn = await session.submit("list the files");
  await ending.reached.wait();
  h.room.refuse("closeOut", firstReply(h).id, { once: true }); // the first end fails, its retry lands
  ending.release();
  await turn.done.wait();
  await retry.reached.wait();
  assert.ok(rootStatuses(h).length > 0 && !rootStatuses(h).includes("done"));
  retry.release();
  await h.until(() => rootStatuses(h).at(-1) === "done");
  assert.ok(!rootStatuses(h).includes("error"));
  assert.equal(thread(h).status, null);
  assert.deepEqual(thread(h).openReplies, []);
});

test("a close that cannot end a reply shows the cross and keeps what repair needs", async (t) => {
  // The close falls in the window before the chat's one retry.
  const h = harness(t, [{ turns: [sdkMessages("tools")] }], {}, { rootStatus: true });
  const session = h.session();
  const retry = h.room.hold("waitLanded");
  await (await refuseEnd(h, session, "list")).done.wait();
  await retry.reached.wait();
  assert.ok(rootStatuses(h).length > 0 && !rootStatuses(h).includes("done"));
  await session.close();
  retry.release();
  assert.equal(rootStatuses(h).at(-1), "error");
  const stored = thread(h);
  assert.equal(stored.status, "working"); // repair covers it
  assert.equal(stored.ended, "error"); // what the root shows, for the session index
  assert.deepEqual(stored.openReplies, [firstReply(h).id]); // the reply the chat still holds open
});

test("shutdown ends every reply with a retry pending", async (t) => {
  const h = harness(
    t,
    [{ turns: [sdkMessages("tools"), sdkMessages("tools")] }],
    {},
    {
      rootStatus: true,
    },
  );
  const session = h.session();
  const retry = h.room.hold("waitLanded");
  for (const [index, prompt] of ["a", "b"].entries()) {
    const ending = h.room.hold("closeOut");
    const turn = await session.submit(prompt);
    await ending.reached.wait();
    const reply = replies(h)[index];
    assert.ok(reply !== undefined);
    h.room.refuse("closeOut", reply.id, { once: true }); // each end fails once, and lands on a retry
    ending.release();
    await turn.done.wait();
  }
  assert.deepEqual(ended(h), [false, false]); // both ends failed, their retries pending
  await session.close();
  retry.release();
  // The memory chat lands a pending retry when the close settles it; the engine fact is that the
  // close settles every unlanded reply (killed by M3 when it does not).
  assert.deepEqual(ended(h), [true, true]);
  assert.equal(thread(h).status, null);
});

test("the status is persisted until the end lands", async (t) => {
  // A crash before the end lands must still be repaired: the persisted status is cleared only
  // after the end has landed.
  const h = harness(t, [{ turns: [sdkMessages("tools")] }]);
  const ending = h.room.hold("closeOut");
  const turn = await h.session().submit("list the files");
  await ending.reached.wait();
  const seen = thread(h).status; // the chat is in the middle of the end
  ending.release();
  await turn.done.wait();
  await h.idle();
  assert.equal(seen, "working");
  assert.equal(thread(h).status, null);
});

test("the open reply is the stream until it ends", async (t) => {
  const ask = canUseToolCall("Bash", { command: "ls" });
  const h = harness(t, [{ turns: [withAsk(ask)] }]);
  const turn = await h.session().submit("list the files");
  await h.until(() => pending(h.approvals).length > 0 && replyCount(h) > 0);
  assert.deepEqual(thread(h).openReplies, [firstReply(h).id]);
  approve(h);
  await turn.done.wait();
  assert.deepEqual(thread(h).openReplies, []);
});

test("a close leaves no task waiting on a reply it could not end", async (t) => {
  const h = harness(t, [{ turns: [withAsk(canUseToolCall("Bash", { command: "ls" }))] }]);
  const session = h.session();
  // Each wait for a landing is counted in and out, and none ends while the test holds the chat's retry.
  const retry = h.room.hold("waitLanded");
  let waiting = 0;
  const original = inside(session).awaitLanding.bind(session);
  mock.method(inside(session), "awaitLanding", async (reply: Parameters<typeof original>[0]) => {
    waiting += 1;
    try {
      await original(reply);
    } finally {
      waiting -= 1;
    }
  });
  await session.submit("hello");
  await h.until(() => pending(h.approvals).length > 0 && replyCount(h) > 0);
  h.room.refuse("closeOut", firstReply(h).id); // the reply's end, made by the close, does not land
  await session.close();
  assert.equal(waiting, 0); // `close` settles the reply itself: nobody would await these
  retry.release();
});

test("a crossed owner query is answered in the reply it landed in", async (t) => {
  // `settle`: the start guessed a background report, the result says the owner asked. The
  // answer is in the misrouted reply; the owner turn's own reply is never written.
  const h = harness(t, [{ turns: [] }]);
  const session = h.session();
  const owner = await session.submit("what happened");
  await h.until(() => h.clients.length > 0 && h.clients.at(-1)?.queries.join() === "what happened");
  inside(session).expectInjectedTurn();
  h.clients[0]?.inject(splitTurns(sdkMessages("tools"))[0] ?? []);
  await owner.done.wait();
  assert.equal(replyCount(h), 1);
  assert.equal(h.room.written(h.channel).length, 1);
  await h.until(() => ended(h).every(Boolean));
  // The report the guess expected may still come: the end carries no footer, and the wait for
  // it running out lets the session end, with the footer under the reply that carried the answer.
  assert.deepEqual(footers(h), [false]);
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT);
  await h.until(() => session.idle);
  await h.sleep(3);
  assert.deepEqual(footers(h), [true]);
});

test("a crossed owner query leaves the footer off while the task it crossed still runs", async (t) => {
  // The report turn that answers the owner's prompt crossed it. The reply that started a task
  // has the owner's message below it, so the answer opens a reply of its own at the bottom (it is
  // not the last thing in the thread, so it takes no report). The owner turn's own reply is
  // never written, so the answer sits in the reply that carried it. The command still runs: the
  // session has not ended, and no reply shows a footer.
  const [first] = splitBackground();
  const taskId = String(systemRecord(first, "task_started").task_id);
  const h = harness(t, [{ turns: [first] }]);
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  const holder = inside(session).taskReplies.get(taskId);
  assert.ok(holder !== undefined);
  const carrier = holder.sink;
  const owner = await session.submit("next");
  await h.until(() => h.clients[0]?.queries.join() === "start it,next");
  assert.ok(carrier !== owner.sink);
  inside(session).injectedExpected = true; // a report was expected too: the guess that goes wrong
  inside(session).ended = [[taskId, { text: "✓ the task ended", card: null }]];
  h.clients[0]?.inject(splitTurns(sdkMessages("tools"))[0] ?? []);
  await owner.done.wait();
  assert.ok(written(h).at(-1)?.startsWith("✓ the task ended"));
  await h.idle();
  await h.sleep(3);
  assert.deepEqual(footers(h), [false, false]);
});

// The thread's status line: `Working…`, then what still runs.

test("a prompt shows the thread status before claude writes anything", async (t) => {
  const h = harness(t, [{}], {}, { activityLine: true }); // a turn that never answers
  await h.session().submit("hello");
  await h.until(() => activityKinds(h).length > 0);
  assert.deepEqual(activityKinds(h), ["working"]);
  assert.deepEqual(written(h), []); // the status is not a message
  h.clients.at(-1)?.answer(sdkMessages("tools").slice(0, 21)); // the view shows a message once Claude writes
  await h.until(() => written(h).length > 0);
});

test("the thread status is cleared when the turn ends", async (t) => {
  const h = harness(t, [{ turns: [sdkMessages("tools")] }], {}, { activityLine: true });
  const turn = await h.session().submit("list the files");
  await turn.done.wait();
  await h.until(() => activityKinds(h).at(-1) === "");
  assert.equal(activityKinds(h)[0], "working");
});

test("the thread status goes while an approval waits and comes back after it", async (t) => {
  const ask = canUseToolCall("Bash", { command: "ls" });
  const h = harness(t, [{ turns: [withAsk(ask)] }], {}, { activityLine: true });
  const turn = await h.session().submit("list the files");
  await h.until(() => pending(h.approvals).length > 0);
  await h.until(() => activityKinds(h).at(-1) === ""); // ✋: the session waits on the owner
  const waiting = activityKinds(h).length;
  approve(h);
  await turn.done.wait();
  await h.until(() => activityKinds(h).at(-1) === "");
  // shown again after the answer
  assert.ok(activityKinds(h).slice(waiting).includes("working"));
});

test("a task that outlives its turn is not counted by the thread status", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harness(t, [{ turns: [first] }], {}, { activityLine: true });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await h.until(() => activityKinds(h).at(-1) === ""); // the turn ended: nobody is owed an answer
  assert.ok(activityKinds(h)[0] === "working" && session.runningKinds !== "");
  assert.ok(!JSON.stringify(h.room.calls("showActivity")).includes("still running"));
  // The count is a state of the thread, never a line of the reply's text.
  const told = h.room.calls("text");
  assert.ok(told.length > 0);
  assert.ok(!JSON.stringify(told).includes("still running"));
  // the reply rests: it ended with the turn
  await h.until(() => replyCount(h) === 1);
  await h.idle();
  const before = h.room.calls("showActivity").length;
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => written(h).some((text) => text.includes("✓")));
  // The report turn is the agent's own: the line stays as it was.
  assert.ok(
    h.room
      .calls("showActivity")
      .slice(before)
      .every((call) => call.args[0] === null),
  );
});

test("stop clears the thread status", async (t) => {
  const h = harness(t, [{}], {}, { activityLine: true }); // a turn that never ends: nothing waits on the owner
  const session = h.session();
  await session.submit("hello");
  await h.until(() => h.clients.length > 0 && h.clients.at(-1)?.queries.join() === "hello");
  h.clients.at(-1)?.answer(sdkMessages("tools").slice(0, 13)); // the turn has started
  await h.until(() => inside(session).active !== null);
  await h.until(() => activityKinds(h).join() === "working");
  assert.equal(await session.stop(), true);
  await h.until(() => activityKinds(h).at(-1) === ""); // while the interrupt still winds down
});

test("a later reply that ended shows the list under it, the status says nothing", async (t) => {
  const [first] = splitBackground();
  const h = harness(t, [{ turns: [first, sdkMessages("tools")] }], {}, { activityLine: true });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await h.until(() => activityKinds(h).at(-1) === ""); // the only reply has ended: no footer yet
  await (await session.submit("list the files")).done.wait();
  // The second reply rests for the first command, which still runs: both replies have ended.
  await h.until(() => replyCount(h) === 2);
  // The thread's last reply is at rest: the list says what still runs, the status line never.
  await h.until(() => activityKinds(h).at(-1) === "");
  await h.until(() => (replies(h)[1]?.text ?? "").includes("still running"));
  assert.equal(session.runningKinds, "1 shell");
  assert.ok(replies(h)[1]?.text.includes(`${session.runningKinds} still running`));
  assert.ok(!(replies(h)[0]?.text ?? "").includes("still running"));
  await h.sleep(0.05);
  assert.equal(activityKinds(h).at(-1), "");
  assert.ok(!JSON.stringify(h.room.calls("showActivity")).includes("still running"));
});

test("closing a session clears the thread status", async (t) => {
  const h = harness(t, [{}], {}, { activityLine: true }); // a turn that never answers
  const session = h.session();
  await session.submit("hello");
  await h.until(() => activityKinds(h).length > 0);
  await session.close();
  assert.equal(activityKinds(h).at(-1), "");
});

test("a thread with an owner prompt between its replies shows one footer, under the last message", async (t) => {
  // The recorded background run, with a prompt answered while the command runs: the prompt's
  // reply rests for the command, so the report renders into it, in the stretch of the prompt.
  const [first, notice, injected] = splitBackground();
  const h = harness(t, [{ turns: [first, sdkMessages("foreground")] }]);
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await (await session.submit("and now?")).done.wait();
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => written(h).some(isReport));
  await h.idle();
  await h.sleep(5);
  const texts = written(h);
  assert.equal(texts.findIndex(isReport), 1, texts.join("\n---\n"));
  // [the first reply] | owner | [the answer, the report] | the report's ending: the session ends
  // with the report
  assert.deepEqual(footers(h), [false, true]);
});

test("a report that starts while the owner's prompt has no message yet leaves one footer, under the prompt's reply", async (t) => {
  // Task 3's carried sequence: the reply H waits on a task, the notification arrives, the owner's
  // message is told to the places and submitted (its reply has no message yet), then the report
  // turn starts: H is no longer last, so the report opens a reply below the owner's message, and
  // the prompt's reply writes below it. The thread reads H, owner, report, prompt's reply.
  const [first, notice, injected] = splitBackground();
  const h = harness(t, [{ turns: [first, sdkMessages("foreground")] }]);
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  h.clients[0]?.inject(notice);
  await h.idle();
  const prompt = session.submit("and now?");
  h.clients[0]?.inject(injected);
  await h.idle();
  await (await prompt).done.wait();
  await h.idle();
  await h.sleep(5);
  const texts = written(h);
  assert.equal(texts.findIndex(isReport), 1, texts.join("\n---\n"));
  assert.deepEqual(footers(h), [false, false, true], "one footer, under the prompt's reply");
});
