/**
 * The same-folder hold over the memory chat: a message that would wake a session while another
 * thread works in the folder asks the owner first, and what each answer, a stop and a drain do to
 * the message and to the root's status. The plain agent's turn that holds is the neighbour at
 * work. A session a test sets where a race leaves it (`dropClient`, `closedFlag`) is reached by a
 * cast: there is no public way to that state without the teardown the test stands in for.
 */
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { HoldRequest } from "../../../src/chat/seam.ts";
import { logger } from "../../../src/core/flows/talk.ts";
import { IDLE_CLOSE_SECONDS } from "../../../src/core/sessions/constants.ts";
import type { ThreadSession } from "../../../src/core/sessions/session.ts";
import * as texts from "../../../src/core/texts.ts";
import { fill, named } from "../../../src/core/texts.ts";
import { AsyncEvent } from "../../support/fake-clock.ts";
import { OWNER } from "../../support/memory-chat.ts";
import { hold, PLAIN_CAPABILITIES, PlainAgent } from "../../support/plain-agent.ts";
import { HoldWorld, shownStatuses, standing } from "./hold-world.ts";
import { PLAIN_NAMES, WithFolderTrust } from "./messages-world.ts";
import { BYPASS_MODE, ModeAgent } from "./mode-agent.ts";

const LIMIT = { timeout: 8000 };

/** The private members a test sets to put a session where a race leaves it. */
interface Internals {
  dropClient(): Promise<void>;
  closedFlag: boolean;
}

function internals(session: ThreadSession): Internals {
  return session as unknown as Internals;
}

/** The lines the core's flows logged from here on. */
function logged(t: TestContext): string[] {
  const lines: string[] = [];
  for (const level of ["info", "warning", "error"] as const) {
    const write = logger[level].bind(logger);
    t.mock.method(logger, level, (line: string) => {
      lines.push(line);
      write(line);
    });
  }
  return lines;
}

/** What the neighbour was told: the agent got nothing of the held message. */
async function unsent(world: HoldWorld, text = "hello"): Promise<void> {
  assert.ok(!(await world.prompts()).includes(text), `${text} reached the agent`);
}

const holdOf = (request: unknown): HoldRequest => request as HoldRequest;

test("a busy session in the same folder holds the message", LIMIT, async (t) => {
  const agent = new PlainAgent();
  const world = await HoldWorld.make(t, { agent });
  const busy = await world.busy();
  const sessionId = world.stored(busy.ref)?.sessionId;
  assert.ok(sessionId, "the neighbour has a session");
  // The agent lists no title for it yet: the question names it by the word `Session`.
  agent.listSessions = async () => [];
  const { ref, question } = await world.held();
  await unsent(world); // held, not sent
  const link = `[${texts.STATUS_CHANNEL_SESSION}]`;
  assert.deepEqual(holdOf(question.request), {
    type: "hold",
    requestId: question.requestId,
    other: busy.ref,
    link,
  });
  assert.equal(question.title, fill(texts.HOLD_QUESTION, { link }));
  // Crash repair: a hold is a request like an approval or a question.
  assert.deepEqual(world.stored(ref)?.requests, [question.message]);
  assert.deepEqual(world.stored(ref)?.requestKinds, { [question.message]: "hold" });
  assert.equal(world.chat.strayCalls().length, 0);
});

test(
  "the hold question names the busy session by its title when the agent lists one",
  LIMIT,
  async (t) => {
    const agent = new PlainAgent();
    const world = await HoldWorld.make(t, { agent });
    const busy = await world.busy();
    const sessionId = world.stored(busy.ref)?.sessionId as string;
    agent.listSessions = async () => [
      {
        id: sessionId,
        title: "Fix the footer",
        customTitle: null,
        branch: null,
        size: null,
        lastModified: 1,
      },
    ];
    const { question } = await world.held();
    assert.equal(holdOf(question.request).link, "[Fix the footer]");
    assert.equal(question.title, fill(texts.HOLD_QUESTION, { link: "[Fix the footer]" }));
  },
);

test("a failed state write for a d8 hold still lets it proceed", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  const lines = logged(t);
  await world.busy();
  // `state.addRequest` sits outside `askOwner`'s own try/finally on purpose, so a write failure
  // here can never skip `holdStart`/`holdEnd` and leave the hold itself undiscarded.
  world.state.addRequest = () => {
    throw new Error("disk full");
  };
  const { ref, sending } = await world.held();
  assert.ok(
    lines.some((line) => line.includes("that state.json could not record: Error")),
    "the failed write is logged loudly",
  );
  assert.equal(standing(world.chat, ref), "waiting"); // holdStart still ran
  await world.answerHold(ref, true);
  await sending;
  assert.deepEqual(await world.prompts(), ["busy elsewhere", "hello"]);
});

test("continue sends the held message", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  await world.busy();
  const { ref, sending, question } = await world.held();
  await world.answerHold(ref, true);
  await sending;
  assert.deepEqual(await world.prompts(), ["busy elsewhere", "hello"]);
  assert.ok(!world.shown(ref).includes(question.title), "the question is removed");
  assert.deepEqual(world.stored(ref)?.requests, []);
  assert.ok(!world.shown(ref).includes(texts.NOT_SENT));
  // The view the negatives read does show the thread's replies: the held message's own.
  assert.ok(world.shown(ref).some((line) => line.startsWith("ok")));
});

test("bypass typed after start while held switches the session", LIMIT, async (t) => {
  const agent = new ModeAgent();
  const world = await HoldWorld.make(t, { agent });
  await world.busy();
  // Start was applied, then the hold asks: the setup's box is gone, so the word works as in a
  // session that ran, and holds after Continue.
  const { ref, sending } = await world.held();
  const word = await world.says("/bypass on", ref.thread);
  assert.ok(world.shown(ref).includes(texts.BYPASS_ON_THREAD));
  assert.deepEqual(
    world.chat.calls("acknowledge").map((call) => call.args[0]),
    [word.id],
  );
  await world.answerHold(ref, true);
  await sending;
  assert.deepEqual(await world.prompts(), ["busy elsewhere", "hello"]);
  assert.deepEqual(agent.recorded.at(-1)?.modes, [BYPASS_MODE]);
  assert.equal(world.stored(ref)?.bypass, true);
});

test("cancel drops the message and says so", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  await world.busy();
  const { ref, sending, question } = await world.held();
  await world.answerHold(ref, false);
  await sending;
  await unsent(world); // never sent
  assert.equal(world.shown(ref).at(-1), texts.NOT_SENT);
  assert.ok(!world.shown(ref).includes(question.title), "the question, not the notice, is removed");
  assert.deepEqual(world.stored(ref)?.requests, []);
});

test("no hold when the other session is idle", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  const busy = await world.busy();
  busy.process.release();
  await world.settle();
  assert.ok(busy.session.idle);
  await world.opened("hello");
  assert.deepEqual(await world.prompts(), ["busy elsewhere", "hello"]); // sent at once, no question
  assert.ok(!world.questions.includes("hold"));
});

test("no hold when the other session is in another folder", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  await world.busy("busy elsewhere", world.elsewhere);
  const sending = world.says("hello");
  const { ref } = await world.asked("setup");
  await world.start(ref);
  await world.settle();
  assert.ok(!world.questions.includes("hold")); // asked before the message is waited for
  await sending;
  assert.deepEqual(await world.prompts(), ["busy elsewhere", "hello"]);
});

test("no hold when the target itself is busy", LIMIT, async (t) => {
  const agent = new PlainAgent();
  const world = await HoldWorld.make(t, { agent });
  await world.busy();
  const { ref, sending } = await world.held(); // its own first message is held: it is not busy yet
  agent.next(hold()); // the held message's turn does not end
  await world.answerHold(ref, true);
  await sending;
  await world.settle();
  assert.ok(world.session(ref).busy, "the held message's turn works");
  const again = world.says("again", ref.thread); // this thread is busy now: sent at once, asks nothing
  await world.settle();
  world.process().release(); // the held message's turn ends and the next one plays
  await again;
  assert.deepEqual(await world.prompts(), ["busy elsewhere", "hello", "again"]);
  assert.equal(world.questions.filter((type) => type === "hold").length, 1);
});

test("another channel bound to the same folder also holds", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  await world.busy();
  const { ref, sending } = await world.held("hello", world.sameFolder);
  await unsent(world);
  await world.answerHold(ref, true);
  await sending;
  assert.deepEqual(await world.prompts(), ["busy elsewhere", "hello"]);
});

/** A plain agent that runs background tasks. */
class Background extends PlainAgent {
  override readonly capabilities = {
    ...PLAIN_CAPABILITIES,
    promptDuringTurn: true,
    backgroundTasks: true,
  };
}

/** A background command that started in the turn `process` plays. */
const taskStarted = (taskId: string) =>
  ({
    type: "task_started",
    taskId,
    kind: "command",
    taskType: null,
    description: "watch",
    callId: null,
    agentType: null,
    background: true,
    parentTaskId: null,
  }) as const;

test("a background only session counts as working", LIMIT, async (t) => {
  const world = await HoldWorld.make(t, { agent: new Background({ promptDuringTurn: true }) });
  const first = await world.busy("start it");
  first.process.emit(taskStarted("task-1"));
  first.process.release();
  await world.settle();
  assert.ok(!first.session.busy && first.session.runningKinds !== "");
  const { ref, question } = await world.held();
  assert.equal(holdOf(question.request).other.thread, first.ref.thread); // held: the task still counts
  await unsent(world);
  assert.deepEqual(world.stored(ref)?.requests, [question.message]);
});

test("a double click finds no hold", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  await world.busy();
  const { ref, sending, question } = await world.held();
  await world.inbound.answer(
    ref,
    question.requestId,
    { type: "hold", send: true },
    question.message,
  );
  await sending;
  const again = await world.inbound.answer(
    ref,
    question.requestId,
    { type: "hold", send: true },
    question.message,
  );
  assert.equal(again, false);
  assert.equal(world.shown(ref).at(-1), texts.HOLD_GONE);
  assert.deepEqual(await world.prompts(), ["busy elsewhere", "hello"]); // sent once
});

test("a click for another thread is refused", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  const busy = await world.busy();
  const { ref, question } = await world.held();
  const refused = await world.inbound.answer(
    busy.ref,
    question.requestId,
    { type: "hold", send: true },
    question.message,
  );
  assert.equal(refused, false);
  await unsent(world); // never sent: the click did not match the hold
  assert.equal(world.shown(busy.ref).at(-1), texts.HOLD_GONE);
  assert.equal(world.open("hold", ref).length, 1, "the hold still waits");
});

test("a click for another channel is refused", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  await world.busy();
  const { ref, question } = await world.held();
  const elsewhere = { channel: world.elsewhere, thread: ref.thread };
  const refused = await world.inbound.answer(
    elsewhere,
    question.requestId,
    { type: "hold", send: true },
    question.message,
  );
  assert.equal(refused, false);
  await unsent(world);
  assert.equal(world.open("hold", ref).length, 1, "the hold still waits");
});

// No status stands on the root.
test(
  "a drain starting right after continue does not leave a stale raised hand",
  LIMIT,
  async (t) => {
    const world = await HoldWorld.make(t);
    await world.busy();
    const { ref, sending } = await world.held();
    world.sessions.draining = true; // as if a drain's own cancellation pass had just run
    await world.answerHold(ref, true);
    await sending;
    await unsent(world);
    // Restored, not left on waiting: this thread never ran, and the raised hand did show first.
    assert.ok(shownStatuses(world.chat, ref).includes("waiting"));
    assert.equal(standing(world.chat, ref), null);
    assert.equal(world.stored(ref)?.status, null);
    assert.ok(world.shown(ref).some((line) => line.startsWith(texts.RESTARTING)));
  },
);

test(
  "a directory gone unavailable after continue reacts error not a raised hand",
  LIMIT,
  async (t) => {
    const agent = new WithFolderTrust();
    const world = await HoldWorld.make(t, { agent });
    await world.busy();
    const { ref, sending } = await world.held("/echo hello"); // a command: held, then `ensureConnected`
    // The setup connected it already; a client the agent lost since makes Continue connect again.
    await internals(world.session(ref)).dropClient();
    agent.folderTrusted = async () => false;
    await world.answerHold(ref, true);
    await sending;
    await world.settle();
    assert.deepEqual(await world.prompts(), ["busy elsewhere"]); // never sent: its own connect failed
    assert.equal(standing(world.chat, ref), "error");
  },
);

test("a generic connect error after continue reacts error not a raised hand", LIMIT, async (t) => {
  const agent = new PlainAgent();
  const world = await HoldWorld.make(t, { agent });
  // `submitted`, not a fixed set of exception types: any failure before `submit()` (a logged-out
  // agent raising something `ensureConnected` does not special-case, most likely) must not leave
  // the hold's raised hand standing for ever either.
  await world.busy();
  const { ref, sending } = await world.held("/echo hello");
  await internals(world.session(ref)).dropClient(); // a lost client makes Continue reconnect
  agent.failNextStart(new Error("logged out"));
  await world.answerHold(ref, true);
  await sending;
  await world.settle();
  assert.deepEqual(await world.prompts(), ["busy elsewhere"]); // its own connect failed: nothing sent
  assert.equal(standing(world.chat, ref), "error");
});

test("a session gone at continue time reacts error not a raised hand", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  await world.busy();
  // The held session itself closed (its thread's own entry gone too, as a SessionGone close
  // leaves it) in the gap between Continue and `submit()`: the retry's own fresh lookup finds
  // nothing, so `SessionGone` propagates instead of a plain `SessionClosed`.
  const { ref, sending } = await world.held();
  const session = world.session(ref);
  internals(session).closedFlag = true; // as if something else had closed it while the hold was open
  world.state.removeThread(ref.channel, ref.thread);
  try {
    await world.answerHold(ref, true);
    await sending;
    await world.settle();
    await unsent(world);
    assert.equal(standing(world.chat, ref), "error");
    // The thread's entry is gone: no session holds it, so the failure is a channel line naming the prompt.
    assert.ok(world.chat.texts(ref.channel).includes(named(texts.SESSION_GONE, PLAIN_NAMES)));
  } finally {
    // `closedFlag` was set directly above, bypassing the real teardown: finished properly here
    // even when an assertion fails, or the world's own `closeAll` waits for ever on this object.
    await session.close();
  }
});

test(
  "a session closed at continue time retries and sends without reacting error",
  LIMIT,
  async (t) => {
    const world = await HoldWorld.make(t);
    await world.busy();
    // The held session closed (its thread's own entry intact, unlike a `SessionGone` close) in the
    // gap between Continue and `submit()`: the retry's own fresh lookup rebuilds a live session and
    // sends normally, so the original object's raised hand must not be turned into an error.
    const { ref, sending } = await world.held();
    const session = world.session(ref);
    internals(session).closedFlag = true; // an idle close, most likely; the thread's own entry survives
    session.doneClosing.set(); // what the real teardown this stands in for always fires
    try {
      await world.answerHold(ref, true);
      await sending;
      const fresh = world.sessions.get(ref.channel, ref.thread);
      assert.ok(fresh !== null && fresh !== session);
      assert.deepEqual(await world.prompts(), ["busy elsewhere", "hello"]); // on a rebuilt process
      assert.ok(!shownStatuses(world.chat, ref).includes("error"));
    } finally {
      // `closedFlag` was set directly above, bypassing the real teardown.
      await session.close();
    }
  },
);

test("a stop answer that cannot be posted is not the word's failure", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  const ref = await world.opened("hi");
  world.hooks.tellFails = true;
  await world.says("/stop", ref.thread);
  // One attempt at the answer, and no error line for a stop that did what it was asked.
  assert.deepEqual(world.hooks.attempts, [texts.NOTHING_TO_STOP_THREAD]);
});

test("stop in the held thread cancels it", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  await world.busy();
  const { ref, sending } = await world.held();
  await world.says("/stop", ref.thread);
  await world.settle();
  assert.ok(world.shown(ref).includes(texts.NOT_SENT)); // told before the message is waited for
  await sending;
  await unsent(world);
  // `/stop` cancelled the hold: `Not sent.` alone, from the waiter, since nothing the agent
  // itself was doing stopped (no separate "Nothing is running..." on top of it).
  assert.equal(world.shown(ref).filter((line) => line === texts.NOT_SENT).length, 1);
  assert.ok(!world.shown(ref).includes(texts.NOTHING_TO_STOP_THREAD));
  assert.equal(world.open("hold").length, 0);
});

test("a top level stop of the channel cancels the hold", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  await world.busy();
  const { ref, sending } = await world.held();
  await world.says("/stop");
  await world.settle();
  assert.ok(world.shown(ref).includes(texts.NOT_SENT)); // told before the message is waited for
  await sending;
  await unsent(world);
  assert.ok(world.shown(ref).includes(texts.NOT_SENT));
});

test("a top level stop with only a cancelled hold says nothing else", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  // The busy session lives in ANOTHER channel here, so this channel's own `/stop` cancels the
  // hold and stops nothing else: `stopChannel`'s own `null` must not read as "nothing stopped"
  // and add a second, contradicting notice on top of `Not sent.`.
  const busy = await world.busy("busy elsewhere", world.sameFolder);
  const { ref, sending } = await world.held();
  await world.says("/stop");
  await world.settle();
  assert.ok(world.shown(ref).includes(texts.NOT_SENT)); // told before the message is waited for
  await sending;
  const said = [...world.shown(ref), ...world.chat.texts(world.channel)];
  assert.ok(!said.includes(texts.NOTHING_TO_STOP));
  assert.ok(!said.some((line) => line.startsWith(texts.STOPPED_CHANNEL)));
  assert.ok(busy.session.busy, "the other channel's work goes on");
});

test("a drain cancels the hold", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  await world.busy();
  const { ref, sending } = await world.held();
  const cutShort = new AbortController();
  cutShort.abort(); // returns as soon as the per-session cancellation pass is done
  await world.sessions.drain(cutShort.signal);
  await world.settle();
  assert.ok(world.shown(ref).includes(texts.NOT_SENT)); // told before the message is waited for
  await sending;
  await unsent(world);
});

// The idle-close timer sleeps on the sessions' clock, so a clock that passes the whole wait shows
// whether it is armed.
test("the idle close timer does not fire while held", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  await world.busy();
  const { ref } = await world.held();
  const session = world.session(ref);
  assert.ok(session.waitingForOwner);
  await world.settle(); // a timer armed meanwhile has started its sleep
  await world.clock.advance(IDLE_CLOSE_SECONDS + 1); // never armed while held
  await world.settle();
  assert.equal(session.closed, false);
  assert.equal(world.sessions.get(ref.channel, ref.thread), session);
});

test("the raised hand shows while held and clears on cancel", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  await world.busy();
  const { ref, sending } = await world.held();
  assert.equal(standing(world.chat, ref), "waiting");
  assert.equal(world.stored(ref)?.status, "waiting");
  await world.answerHold(ref, false);
  await sending;
  assert.equal(standing(world.chat, ref), null); // nothing to go back to: a session that never ran
  assert.equal(world.stored(ref)?.status, null);
});

test("the other session finishing does not skip the question", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  const busy = await world.busy();
  const { ref, sending } = await world.held();
  busy.process.release();
  await world.settle();
  assert.ok(busy.session.idle);
  await unsent(world); // the hold still waits: nobody re-checked on its own
  assert.equal(world.open("hold", ref).length, 1);
  await world.answerHold(ref, true);
  await sending;
  assert.deepEqual(await world.prompts(), ["busy elsewhere", "hello"]);
});

test("an unpostable question fails closed", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  world.hooks.askFails = (type) => type === "hold";
  await world.busy();
  const sending = world.says("hello");
  const { ref } = await world.asked("setup");
  await world.start(ref);
  await sending;
  await unsent(world);
  assert.equal(world.shown(ref).at(-1), named(texts.HOLD_UNPOSTED, PLAIN_NAMES));
  assert.equal(world.open("hold").length, 0);
});

/** A stop under way: the drain runs until the test cuts it short. */
async function draining(world: HoldWorld): Promise<() => Promise<void>> {
  const cutShort = new AbortController();
  const drain = world.sessions.drain(cutShort.signal);
  await world.settle();
  return async () => {
    cutShort.abort();
    await drain;
  };
}

test("a message during a drain is refused not held", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  await world.busy();
  const cut = await draining(world); // the drain has set its flags before this message arrives
  const { ref } = await world.says("hello");
  await world.settle();
  // The busy session of the other thread holds the stop: the refusal names it.
  assert.ok(
    (world.shown(ref).at(-1) as string).startsWith(
      `${texts.RESTARTING}\n${texts.RESTART_WAITS_FOR}`,
    ),
  );
  assert.ok(!world.questions.includes("hold")); // never held: a hold opened now would wait for ever
  await cut();
});

test("a message queued behind a drain cancelled hold is also refused", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  await world.busy();
  const { ref, sending } = await world.held(); // this thread's own "hello" is held
  // "again" now waits behind "hello" for the thread's arrival lock: its handler waits.
  const again = world.says("again", ref.thread);
  await world.settle();
  const cutShort = new AbortController();
  cutShort.abort();
  await world.sessions.drain(cutShort.signal); // cancels "hello"'s hold
  await world.settle();
  assert.ok(world.shown(ref).includes(texts.NOT_SENT)); // told before the messages are waited for
  await Promise.all([sending, again]);
  await unsent(world); // neither "hello" nor "again" was ever sent
  await unsent(world, "again");
  assert.ok(world.shown(ref).includes(texts.NOT_SENT)); // "hello", cancelled by the drain
  // "again", refused once draining had begun; the session busy elsewhere still holds the stop.
  assert.ok((world.shown(ref).at(-1) as string).startsWith(texts.RESTARTING));
});

// No handler is cancelled in this daemon: the wait ends only through `Holds` (a click, `/stop`, a
// drain). So the two outcomes are read after a wait that ends with no answer: the marker leaves
// `waitingForOwner`, and the question's id is gone from `holds`.
test("a cancelled wait does not leak the hold", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  await world.busy();
  const { ref, sending, question } = await world.held();
  const session = world.session(ref);
  assert.ok(session.waitingForOwner);
  assert.notEqual(world.holds.get(question.requestId), null);
  world.holds.cancel(ref.channel, ref.thread);
  await sending;
  await world.settle();
  assert.ok(!session.waitingForOwner); // the hold's marker did not stay among what waits
  assert.equal(world.holds.get(question.requestId), null); // no leaked entry
});

test("a hold decided before its message id is known does not flicker", LIMIT, async (t) => {
  const world = await HoldWorld.make(t);
  await world.busy();
  // The question is posted, but not yet recorded in `holds`: the stop (`holds.cancel`, exactly
  // what `/stop` does) lands inside the post, once the chat has the message and before the
  // daemon has its id.
  world.hooks.afterAsk = (ref) => {
    if (world.questions.at(-1) === "hold") world.holds.cancel(ref.channel, ref.thread);
  };
  const sending = world.says("hello");
  const { ref } = await world.asked("setup");
  await world.start(ref);
  await sending;
  await world.settle();
  assert.ok(world.shown(ref).includes(texts.NOT_SENT));
  // Only the setup's own raised hand: `holdStart`/`holdEnd` never ran for the question.
  assert.equal(shownStatuses(world.chat, ref).filter((status) => status === "waiting").length, 1);
});

/** The agent's own turn that reports a finished background task, as it plays after the task ends. */
function reportTurn(world: HoldWorld, sessionId: string | null) {
  const process = world.process(0);
  process.emit({
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
  process.emit({ type: "text", text: "The task finished." });
  process.emit({
    type: "turn_ended",
    sessionId,
    startedBy: "agent",
    finalText: "The task finished.",
    ending: "done",
    steps: 1,
    answers: [],
    tokens: {},
  });
}

/**
 * A thread with a background task running, another thread whose first message was held and
 * continued (it works now), and a message of the first thread held in turn: `held` is its hold.
 */
async function reportDuringAHold(t: TestContext) {
  const agent = new Background({ promptDuringTurn: true });
  const world = await HoldWorld.make(t, { agent });
  const first = await world.busy("start it");
  first.process.emit(taskStarted("task-1"));
  first.process.release();
  await world.settle();
  assert.ok(!first.session.busy && first.session.runningKinds !== "");
  // The first thread already has a running task, so the second thread's own first message is
  // held too: Continue lets it become genuinely busy (its turn never completes).
  const second = await world.held("busy elsewhere");
  agent.next(hold());
  await world.answerHold(second.ref, true);
  await second.sending;
  await world.settle();
  const sending = world.says("more", first.ref.thread); // held: the second thread is busy, this one is not
  const question = await world.asked("hold", first.ref);
  assert.ok(first.session.waitingForOwner);
  return { world, first, question, sending, sessionId: world.stored(first.ref)?.sessionId ?? null };
}

test("a report turn during a hold keeps the raised hand", LIMIT, async (t) => {
  const { world, first, sessionId } = await reportDuringAHold(t);
  reportTurn(world, sessionId);
  await world.settle(); // the background task's own report turn runs during the hold
  assert.equal(shownStatuses(world.chat, first.ref).at(-1), "waiting"); // the report turn did not show working over it
  assert.equal(standing(world.chat, first.ref), "waiting");
});

test("cancel after a finished report turn shows done not a stale status", LIMIT, async (t) => {
  const { world, first, question, sending, sessionId } = await reportDuringAHold(t);
  reportTurn(world, sessionId);
  await world.settle(); // the background task finishes reporting
  assert.equal(first.session.runningKinds, "");
  await world.chat.as(OWNER).answers(question.requestId, { type: "hold", send: false });
  await sending;
  await world.settle();
  // Not the snapshot from `holdStart` (waiting, its own raised hand): the session actually
  // finished its report turn during the hold, so cancelling now shows done.
  assert.equal(standing(world.chat, first.ref), "done");
});

// A line that names the thread as waiting is drawn when its question is posted, before the core
// records the request: a request resolved before the post returns leaves no write behind it.
test(
  "a hold stopped while its question is being posted leaves no waiting status",
  LIMIT,
  async (t) => {
    const world = await HoldWorld.make(t);
    await world.busy();
    const gate = new AsyncEvent();
    world.hooks.holdGate = gate;
    const sending = world.says("hello");
    const { ref } = await world.asked("setup");
    await world.start(ref);
    await world.asked("hold", ref); // the question is in the chat, and the core does not know it yet
    // The owner stops the thread while the post has not yet answered.
    await world.says("/stop", ref.thread);
    gate.set();
    await world.settle();
    assert.equal(world.open("hold").length, 0); // gone before the message is waited for
    await sending;
    await world.settle();
    // Nothing waits: the request is gone and the root's status was cleared.
    const entry = world.stored(ref);
    assert.deepEqual([entry?.status, entry?.requests], [null, []]);
    assert.equal(world.open("hold").length, 0);
    assert.ok(shownStatuses(world.chat, ref).includes("waiting")); // the setup's own raised hand showed
    assert.equal(standing(world.chat, ref), null);
    await unsent(world);
  },
);
