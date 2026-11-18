/**
 * The session setup over the memory chat: the model, the effort and bypass asked before a new
 * session's first prompt, what Start applies to the live session and in which order, what a stop,
 * a drain or a restart that comes meanwhile leaves behind, and how the owner's choice is read
 * against what the agent lists. The agent is the plain one with models and a mode that skips
 * permission requests (`ModeAgent`), which records what the core did to its processes.
 * `live: false` is an agent that changes an effort only by starting another process, and the
 * blocks that read that second process run twice: with the effort set live there is no reconnect,
 * so the blocks that hold Start between the effort and the prompt hold `setEffort` instead.
 */
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { SetupRequest, SetupSelection } from "../../../src/chat/seam.ts";
import { ThreadSession } from "../../../src/core/sessions/session.ts";
import * as texts from "../../../src/core/texts.ts";
import { AsyncEvent } from "../../support/fake-clock.ts";
import { OWNER } from "../../support/memory-chat.ts";
import { hold, PLAIN_MODELS, PlainAgent } from "../../support/plain-agent.ts";
import { HoldWorld, type HoldWorldOptions, standing } from "./hold-world.ts";
import { BYPASS_MODE, ModeAgent } from "./mode-agent.ts";

const LIMIT = { timeout: 8000 };

const CHOICE: Partial<SetupSelection> = { model: "big", effort: "full", bypass: true };
const SUMMARY_OF_CHOICE = "Model: Big 2 · Effort: full · Bypass: on";

/** The private member a test calls to lose a session's process, as a reader crash does. */
interface Internals {
  dropClient(): Promise<void>;
}

/** An error with the given name, which is how the daemon names a failure to the owner. */
function failure(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

async function worldOf(t: TestContext, live = true, options: HoldWorldOptions = {}) {
  const agent = new ModeAgent({ models: true, live });
  const world = await HoldWorld.make(t, { agent, ...options });
  return { world, agent };
}

/** The first message of a new thread, its setup open: the thread, and the message still waiting. */
async function waiting(world: HoldWorld, text = "hello") {
  const sending = world.says(text);
  const open = await world.asked("setup");
  return { ref: open.ref, open, sending };
}

/** The summary the setup became, as the thread shows it. */
function summaryOf(world: HoldWorld, ref: { channel: string; thread: string }): string {
  const found = world.shown(ref).findLast((line) => line.startsWith("Model:"));
  assert.ok(found !== undefined, "the setup became its summary");
  return found;
}

const setupOf = (request: unknown): SetupRequest => request as SetupRequest;

test("a plain prompt waits for start", LIMIT, async (t) => {
  const { world } = await worldOf(t);
  const { ref, open, sending } = await waiting(world);
  assert.deepEqual(await world.prompts(), []);
  assert.equal(world.open("setup").length, 1);
  assert.ok(world.session(ref).waitingForOwner); // the idle timer is paused
  assert.equal(standing(world.chat, ref), "waiting");
  assert.deepEqual(world.stored(ref)?.requests, [open.message]);
  await world.start(ref);
  await sending;
});

test("a message with files waits for start too", LIMIT, async (t) => {
  const { world } = await worldOf(t);
  const ref = world.chat.openThread(world.channel, "snippet");
  const sending = world.send({
    ref,
    id: "m-1",
    topLevel: true,
    text: "snippet",
    content: async () => "snippet\nhello\n",
  });
  await world.asked("setup", ref);
  assert.deepEqual(await world.prompts(), []);
  await world.start(ref);
  await sending;
  assert.deepEqual(await world.prompts(), ["snippet\nhello\n"]);
});

test("a top level passthrough waits for start too", LIMIT, async (t) => {
  const { world } = await worldOf(t);
  const { ref, sending } = await waiting(world, "/echo hello");
  assert.deepEqual(await world.prompts(), []);
  await world.start(ref);
  await sending;
  assert.deepEqual(await world.prompts(), [":echo hello"]);
});

test("daemon words and thread replies show no setup", LIMIT, async (t) => {
  const { world } = await worldOf(t);
  await world.says("/status");
  await world.says("/help");
  assert.deepEqual(world.open("setup"), []);
  const { ref, sending } = await waiting(world, "hi");
  await world.start(ref);
  await sending;
  await world.says("second", ref.thread);
  // The top-level prompt's, not the reply's.
  assert.equal(world.questions.filter((type) => type === "setup").length, 1);
});

test("start with defaults changes nothing", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t);
  agent.next(hold()); // the first turn does not end
  const { ref, sending } = await waiting(world);
  await world.start(ref);
  await sending;
  await world.settle();
  assert.deepEqual(await world.prompts(), ["hello"]);
  assert.equal(agent.sessions.length, 1);
  assert.deepEqual(agent.recorded[0]?.models, []);
  assert.deepEqual(agent.recorded[0]?.modes, []);
  assert.deepEqual(agent.recorded[0]?.efforts, []);
  assert.equal(agent.sessions[0]?.options.effort, null);
  assert.equal(
    summaryOf(world, ref),
    "Model: Standard (recommended) · Effort: Default · Bypass: off",
  );
  assert.deepEqual(world.stored(ref)?.requests, []); // kept, no longer a request
  assert.ok(world.shown(ref).includes(summaryOf(world, ref)), "the record is not deleted");
  assert.equal(standing(world.chat, ref), "working");
});

test("start applies model effort and bypass", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t, false);
  const { ref, sending } = await waiting(world);
  await world.start(ref, CHOICE);
  await sending;
  await world.settle();
  assert.equal(agent.sessions.length, 2); // reconnected once, for the effort
  const [first, second] = agent.sessions;
  assert.equal(second?.options.effort, "full");
  assert.deepEqual(agent.recorded[1]?.models, ["big"]);
  assert.deepEqual(agent.recorded[1]?.modes, [BYPASS_MODE]);
  assert.deepEqual(
    second?.prompts.map((p) => p.content),
    ["hello"],
  );
  assert.deepEqual(first?.prompts, []);
  assert.ok(first?.closed, "the effort reconnect closed the first process");
  const stored = world.stored(ref);
  assert.equal(stored?.bypass, true);
  assert.equal(stored?.effort, "full");
  assert.equal(summaryOf(world, ref), SUMMARY_OF_CHOICE);
});

test("the first prompt is sent once the model change has settled", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t);
  // The agent changes the model with a turn of its own: a prompt sent before that turn ends would
  // run on the old model.
  const gate = new AsyncEvent();
  agent.gates.setModel = gate;
  const { ref, sending } = await waiting(world);
  await world.start(ref, { model: "big" });
  await world.settle();
  assert.deepEqual(agent.recorded.at(-1)?.models, ["big"]);
  assert.deepEqual(await world.prompts(), []);
  gate.set();
  await sending;
  assert.deepEqual(await world.prompts(), ["hello"]);
});

test("start applies model effort and bypass with a live effort change", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t, true);
  const { ref, sending } = await waiting(world);
  await world.start(ref, CHOICE);
  await sending;
  await world.settle();
  assert.equal(agent.sessions.length, 1); // the effort went to the live session
  assert.deepEqual(agent.recorded[0]?.efforts, ["full"]);
  assert.equal(agent.sessions[0]?.options.effort, null); // started before the choice
  assert.deepEqual(agent.recorded[0]?.models, ["big"]);
  assert.deepEqual(agent.recorded[0]?.modes, [BYPASS_MODE]);
  assert.deepEqual(await world.prompts(), ["hello"]);
  assert.equal(agent.sessions[0]?.closed, false);
  const stored = world.stored(ref);
  assert.equal(stored?.bypass, true);
  assert.equal(stored?.effort, "full");
  assert.equal(summaryOf(world, ref), SUMMARY_OF_CHOICE);
});

test("a model that takes no effort reads the chosen effort as default", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t);
  const { ref, open, sending } = await waiting(world);
  // The setup offers the models the agent lists, each with its levels, and no levels of its own.
  const request = setupOf(open.request);
  assert.deepEqual(
    request.models.map((model) => model.value),
    PLAIN_MODELS.map((model) => model.value),
  );
  assert.deepEqual(request.efforts, []);
  await world.start(ref, { model: "small", effort: "full" });
  await sending;
  assert.equal(summaryOf(world, ref), "Model: Small 1 · Effort: Default · Bypass: off");
  assert.equal(world.stored(ref)?.effort, null);
  assert.deepEqual(agent.recorded[0]?.efforts, []);
  assert.deepEqual(agent.recorded[0]?.models, ["small"]);
});

test(
  "the setup offers the levels each model takes, and a level of the chosen model is kept",
  LIMIT,
  async (t) => {
    const { world, agent } = await worldOf(t);
    const { ref, open, sending } = await waiting(world);
    const levels = setupOf(open.request).models.find((model) => model.value === "big");
    assert.deepEqual(levels?.supportedEffortLevels, ["brief", "full"]);
    await world.start(ref, { model: "big", effort: "brief" });
    await sending;
    assert.deepEqual(agent.recorded[0]?.efforts, ["brief"]);
    assert.equal(world.stored(ref)?.effort, "brief");
  },
);

test("a level of the chosen model is kept with the bypass tick", LIMIT, async (t) => {
  const { world } = await worldOf(t);
  const { ref, sending } = await waiting(world);
  await world.start(ref, { model: "big", effort: "brief", bypass: true });
  await sending;
  assert.equal(summaryOf(world, ref), "Model: Big 2 · Effort: brief · Bypass: on");
});

test("the setup summary names the model by its display name", LIMIT, async (t) => {
  const { world } = await worldOf(t);
  const first = await waiting(world);
  await world.start(first.ref, CHOICE);
  await first.sending;
  assert.equal(
    summaryOf(world, first.ref),
    texts.fill(texts.SETUP_SUMMARY, { model: "Big 2", effort: "full", bypass: "on" }),
  );
  const second = await waiting(world, "again");
  await world.start(second.ref);
  await second.sending;
  assert.ok(summaryOf(world, second.ref).endsWith("Effort: Default · Bypass: off"));
});

test(
  "an agent with no bypass mode offers no bypass, and a ticked one reads as off",
  LIMIT,
  async (t) => {
    const agent = new PlainAgent({ models: PLAIN_MODELS });
    const world = await HoldWorld.make(t, { agent });
    const { ref, open, sending } = await waiting(world);
    assert.equal(setupOf(open.request).bypassOffered, false);
    await world.start(ref, { model: "big", bypass: true });
    await sending;
    assert.equal(summaryOf(world, ref), "Model: Big 2 · Effort: Default · Bypass: off");
    assert.equal(world.stored(ref)?.bypass, false);
  },
);

test("a setup answered from another thread or channel is refused", LIMIT, async (t) => {
  const { world } = await worldOf(t);
  // Sessions exist at both places, so the refusal is the hold's own channel and thread check, not
  // merely a lookup that finds no session.
  const elsewhere = await world.opened("elsewhere");
  const { ref, open, sending } = await waiting(world);
  const answer = {
    type: "setup",
    selection: { model: "default", effort: "default", bypass: false },
  } as const;
  const before = (await world.prompts()).length;
  assert.equal(await world.inbound.answer(elsewhere, open.requestId, answer, open.message), false);
  const otherChannel = { channel: world.sameFolder, thread: ref.thread };
  assert.equal(
    await world.inbound.answer(otherChannel, open.requestId, answer, open.message),
    false,
  );
  assert.equal((await world.prompts()).length, before);
  assert.equal(world.open("setup").length, 1); // still waiting
  assert.equal(world.shown(elsewhere).at(-1), texts.HOLD_GONE);
  await world.start(ref);
  await sending;
});

test("a second start is stale", LIMIT, async (t) => {
  const { world } = await worldOf(t);
  const { ref, open, sending } = await waiting(world);
  const answer = {
    type: "setup",
    selection: { model: "default", effort: "default", bypass: false },
  } as const;
  await world.chat.as(OWNER).answers(open.requestId, answer);
  await sending;
  assert.equal(await world.inbound.answer(ref, open.requestId, answer, open.message), false);
  assert.deepEqual(await world.prompts(), ["hello"]);
  assert.ok(world.shown(ref).includes(texts.HOLD_GONE));
});

/** What a waiting setup leaves behind once it was cancelled: nothing sent, the question gone. */
async function assertCancelled(world: HoldWorld, ref: { channel: string; thread: string }) {
  assert.deepEqual(await world.prompts(), []);
  assert.ok(world.shown(ref).includes(texts.NOT_SENT));
  assert.ok(!world.shown(ref).includes(texts.SETUP_FALLBACK), "the question is removed");
  // Removed, not rewritten into its summary: no `Model:` line stands in its place.
  assert.ok(!world.shown(ref).some((line) => line.startsWith("Model:")));
  assert.deepEqual(world.stored(ref)?.requests, []);
  assert.equal(world.open("setup").length, 0);
}

test("stop in the thread cancels a waiting setup", LIMIT, async (t) => {
  const { world } = await worldOf(t);
  const { ref, sending } = await waiting(world);
  await world.says("/stop", ref.thread);
  await world.settle();
  assert.ok(world.shown(ref).includes(texts.NOT_SENT)); // told before the message is waited for
  await sending;
  await assertCancelled(world, ref);
  assert.equal(world.shown(ref).filter((line) => line === texts.NOT_SENT).length, 1);
});

test("a top level stop cancels a waiting setup", LIMIT, async (t) => {
  const { world } = await worldOf(t);
  const { ref, sending } = await waiting(world);
  await world.says("/stop");
  await world.settle();
  assert.ok(world.shown(ref).includes(texts.NOT_SENT)); // told before the message is waited for
  await sending;
  await assertCancelled(world, ref);
});

test("a drain cancels a waiting setup", LIMIT, async (t) => {
  const { world } = await worldOf(t);
  const { ref, sending } = await waiting(world);
  const cutShort = new AbortController();
  cutShort.abort();
  await world.sessions.drain(cutShort.signal);
  await sending;
  await assertCancelled(world, ref);
});

/**
 * Start with an effort and the bypass box ticked, held in the window in which the answer is
 * applied but nothing is sent yet: at the reconnect's process start, or with the effort set live
 * at `setEffort`. Returns what opens the window.
 */
async function startedAndHeld(world: HoldWorld, agent: ModeAgent, live: boolean) {
  const gate = new AsyncEvent();
  const { ref, sending } = await waiting(world);
  if (live) agent.gates.setEffort = gate;
  else agent.gates.start = gate;
  void world.start(ref, { effort: "full", bypass: true });
  await world.settle();
  return { ref, sending, gate };
}

async function assertCancelledWhileSettling(
  world: HoldWorld,
  ref: { channel: string; thread: string },
  gate: AsyncEvent,
) {
  gate.set();
  await world.settle();
  await assertCancelled(world, ref);
}

for (const live of [false, true]) {
  const how = live ? " with a live effort change" : "";

  test(`stop while start settles cancels${how}`, LIMIT, async (t) => {
    const { world, agent } = await worldOf(t, live);
    const { ref, gate } = await startedAndHeld(world, agent, live);
    await world.says("/stop", ref.thread);
    await world.settle();
    assert.ok(world.shown(ref).includes("/stop")); // the thread's view shows what was typed
    assert.ok(!world.shown(ref).includes(texts.NOTHING_TO_STOP_THREAD));
    await assertCancelledWhileSettling(world, ref, gate);
  });

  test(`a channel stop while start settles cancels${how}`, LIMIT, async (t) => {
    const { world, agent } = await worldOf(t, live);
    const { ref, gate } = await startedAndHeld(world, agent, live);
    await world.says("/stop");
    await world.settle();
    assert.ok(world.chat.texts(world.channel).includes("hello")); // the channel's view shows its threads
    assert.ok(!world.chat.texts(world.channel).includes(texts.NOTHING_TO_STOP));
    await assertCancelledWhileSettling(world, ref, gate);
  });

  test(`a drain while start settles cancels${how}`, LIMIT, async (t) => {
    const { world, agent } = await worldOf(t, live);
    const { ref, gate } = await startedAndHeld(world, agent, live);
    const cutShort = new AbortController();
    cutShort.abort();
    await world.sessions.drain(cutShort.signal);
    await assertCancelledWhileSettling(world, ref, gate);
  });
}

/**
 * The setup shown again: bypass unticked, effort Default, nothing left from the aborted Start in
 * `state.json` or on the process that will be used.
 */
function assertAFreshSetup(
  world: HoldWorld,
  agent: ModeAgent,
  ref: { channel: string; thread: string },
) {
  const [asked, ...others] = world.open("setup");
  assert.ok(asked !== undefined && others.length === 0);
  assert.deepEqual(setupOf(asked.request).selection, {
    model: "default",
    effort: "default",
    bypass: false,
  });
  const stored = world.stored(ref);
  assert.equal(stored?.bypass, null);
  assert.equal(stored?.effort, null);
  assert.equal(agent.sessions.at(-1)?.options.effort, null);
  assert.deepEqual(agent.recorded.at(-1)?.models, []);
  assert.deepEqual(agent.recorded.at(-1)?.modes, []);
}

for (const live of [false, true]) {
  test(
    `a reply after a stopped setup asks the setup again${live ? " with a live effort change" : ""}`,
    LIMIT,
    async (t) => {
      const { world, agent } = await worldOf(t, live);
      const { ref, gate } = await startedAndHeld(world, agent, live);
      await world.says("/stop", ref.thread);
      await assertCancelledWhileSettling(world, ref, gate);
      delete agent.gates.start;
      delete agent.gates.setEffort;
      const again = world.says("again", ref.thread);
      await world.asked("setup", ref);
      assert.deepEqual(await world.prompts(), []); // held, not sent with what the aborted Start left
      assertAFreshSetup(world, agent, ref);
      await world.start(ref);
      await again;
      assert.deepEqual(await world.prompts(), ["again"]);
    },
  );
}

test("a start decided before the post returns is still applied", LIMIT, async (t) => {
  await startDecidedBeforeThePost(t, false);
});

test(
  "a start decided before the post returns is still applied with a live effort change",
  LIMIT,
  async (t) => {
    await startDecidedBeforeThePost(t, true);
  },
);

/** A start decided before its post returns is applied; for either way of changing the effort. */
async function startDecidedBeforeThePost(t: TestContext, live: boolean) {
  const { world, agent } = await worldOf(t, live);
  world.hooks.afterAsk = (ref) => {
    if (world.questions.at(-1) !== "setup") return;
    const open = world.open("setup", ref)[0];
    assert.ok(open !== undefined);
    // Not awaited: the answer is applied once `ask` returned.
    void world.chat.as(OWNER).answers(open.requestId, {
      type: "setup",
      selection: { model: "big", effort: "full", bypass: true },
    });
  };
  const { ref } = await world.says("hello"); // the setup was answered while its post was going on
  await world.settle();
  assert.deepEqual(await world.prompts(), ["hello"]);
  const process = agent.recorded.at(-1);
  assert.deepEqual(process?.models, ["big"]);
  assert.deepEqual(process?.modes, [BYPASS_MODE]);
  assert.ok(world.shown(ref).includes(SUMMARY_OF_CHOICE), "the record stays");
  assert.deepEqual(world.stored(ref)?.requests, []);
  if (live) {
    assert.equal(agent.sessions.length, 1);
    assert.deepEqual(process?.efforts, ["full"]);
  } else {
    assert.equal(agent.sessions.at(-1)?.options.effort, "full");
  }
}

test("a continue decided before the post returns still sends", LIMIT, async (t) => {
  const { world } = await worldOf(t);
  await world.busy();
  world.hooks.afterAsk = (ref) => {
    if (world.questions.at(-1) !== "hold") return;
    const open = world.open("hold", ref)[0];
    assert.ok(open !== undefined);
    void world.chat.as(OWNER).answers(open.requestId, { type: "hold", send: true });
  };
  const sending = world.says("hello");
  const { ref } = await world.asked("setup");
  await world.start(ref);
  await sending;
  assert.deepEqual(await world.prompts(), ["busy elsewhere", "hello"]);
});

test("bypass typed while start is applied wins over the box", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t);
  // The word came after the click: it waits for Start to finish, then switches the session, so
  // what its answer says is what runs. Start is held inside `setModel`, after the point where it
  // is marked as applied and before it compares the box with the live process.
  const gate = new AsyncEvent();
  agent.gates.setModel = gate;
  const { ref, sending } = await waiting(world);
  await world.start(ref, { model: "big" }); // bypass unticked
  await world.settle();
  const typing = world.says("/bypass on", ref.thread);
  await world.settle();
  assert.ok(!world.shown(ref).includes(texts.BYPASS_ON_THREAD)); // nothing is said before it holds
  gate.set();
  const word = await typing;
  await sending;
  await world.settle();
  assert.deepEqual(agent.recorded.at(-1)?.modes, [BYPASS_MODE]);
  assert.equal(world.stored(ref)?.bypass, true);
  assert.ok(world.shown(ref).includes(texts.BYPASS_ON_THREAD));
  assert.deepEqual(
    world.chat.calls("acknowledge").map((call) => call.args[0]),
    [word.id],
  );
  assert.deepEqual(await world.prompts(), ["hello"]);
});

test("stop while the model command runs interrupts it and cancels", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t);
  // The agent's own model command is a turn no reply shows, so no busy turn tells `/stop` that
  // anything runs: the stop of a Start being applied reaches the session on its own.
  const gate = new AsyncEvent();
  agent.gates.setModel = gate;
  agent.modelFails = new Error("the model command was interrupted");
  const { ref, sending } = await waiting(world);
  await world.start(ref, { model: "big" });
  await world.settle();
  await world.says("/stop", ref.thread);
  await world.settle();
  assert.equal(agent.recorded.at(-1)?.interrupts, 1);
  gate.set();
  await sending;
  await world.settle();
  assert.deepEqual(await world.prompts(), []);
  assert.ok(world.shown(ref).includes(texts.NOT_SENT));
  assert.equal(world.stored(ref)?.bypass, null);
});

test("a reply after a cancelled hold asks the setup again", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t);
  await world.busy();
  const sending = world.says("hello");
  const { ref } = await world.asked("setup");
  await world.start(ref, CHOICE);
  await world.asked("hold", ref);
  await world.answerHold(ref, false); // the hold's Cancel drops the message
  await sending;
  assert.ok(world.shown(ref).includes(texts.NOT_SENT));
  const again = world.says("again", ref.thread);
  await world.asked("setup", ref);
  assertAFreshSetup(world, agent, ref);
  await world.says("/stop", ref.thread); // the neighbour still works: Start would ask the hold again
  await again;
});

test("a failing start leaves no controls and no leftovers", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t);
  agent.modelFails = failure("RuntimeError", "bad model");
  const { ref, sending } = await waiting(world);
  await world.start(ref, CHOICE);
  await sending;
  await world.settle();
  assert.deepEqual(await world.prompts(), []);
  assert.ok(!world.shown(ref).includes(texts.SETUP_FALLBACK), "the controls are gone");
  const stored = world.stored(ref);
  assert.deepEqual(stored?.requests, []);
  assert.equal(stored?.effort, null);
  assert.equal(stored?.bypass, null);
  assert.ok(world.shown(ref).some((line) => line.includes("RuntimeError")));
});

test("a failing forget setup does not hide the original error", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t);
  agent.modelFails = failure("RuntimeError", "bad model");
  t.mock.method(ThreadSession.prototype as unknown as Internals, "dropClient", async () => {
    throw failure("OSError", "cannot drop");
  });
  const { ref, sending } = await waiting(world);
  await world.start(ref, { model: "big" });
  await sending;
  await world.settle();
  assert.deepEqual(await world.prompts(), []);
  assert.ok(world.shown(ref).some((line) => line.includes("RuntimeError")));
});

test("stop while the summary waits to be written cancels", LIMIT, async (t) => {
  const { world } = await worldOf(t);
  const gate = new AsyncEvent();
  world.hooks.rewriteGate = gate;
  const { ref, sending } = await waiting(world);
  void world.start(ref);
  await world.settle();
  assert.deepEqual(await world.prompts(), []); // Start is still being settled: the summary waits
  await world.says("/stop", ref.thread);
  await world.settle();
  assert.ok(!world.shown(ref).includes(texts.NOTHING_TO_STOP_THREAD));
  gate.set();
  await world.settle();
  assert.ok(world.shown(ref).includes(texts.NOT_SENT)); // told before the message is waited for
  await sending;
  await world.settle();
  assert.deepEqual(await world.prompts(), []);
  assert.ok(!world.shown(ref).some((line) => line.startsWith("Model:"))); // the summary was never written
  assert.ok(!world.shown(ref).includes(texts.SETUP_FALLBACK));
  assert.deepEqual(world.stored(ref)?.requests, []);
});

test("a restart during start leaves nothing for the next start", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t);
  const gate = new AsyncEvent();
  world.hooks.rewriteGate = gate;
  const { ref, sending } = await waiting(world);
  void world.start(ref, { effort: "full", bypass: true });
  await world.settle();
  world.sessions.draining = true; // a restart begins before the prompt is sent
  gate.set();
  await sending;
  await world.settle();
  assert.deepEqual(await world.prompts(), []);
  assert.ok(world.shown(ref).some((line) => line.startsWith(texts.RESTARTING)));
  let stored = world.stored(ref);
  assert.equal(stored?.bypass, true); // what the new process finds
  assert.equal(stored?.effort, "full");
  // The restart: a new session rebuilt from state.json.
  world.sessions.draining = false;
  delete world.hooks.rewriteGate;
  await world.session(ref).close();
  const again = world.says("again", ref.thread);
  await world.asked("setup", ref); // asked the setup again
  await world.start(ref); // defaults: effort Default, bypass off
  await again;
  await world.settle();
  assert.deepEqual(await world.prompts(), ["again"]);
  assert.equal(agent.sessions.at(-1)?.options.effort, null);
  assert.deepEqual(agent.recorded.at(-1)?.modes, []); // never left the agent's own mode
  stored = world.stored(ref);
  assert.equal(stored?.bypass, false); // Start's unticked box is an explicit off
  assert.equal(stored?.effort, null);
  assert.ok(summaryOf(world, ref).endsWith("Effort: Default · Bypass: off"));
});
