/**
 * The bypass of a session's setup over the memory chat: the box ticked or unticked at Start, what
 * `/bypass` does before and after it, and the folder whose own settings start the agent in bypass
 * (`native`), where an unticked box is an explicit off that outlives a rebuilt session, a lost
 * process and a restart. The agent is the plain one with models and the modes of `ModeAgent`.
 */
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { SetupRequest, ThreadRef } from "../../../src/chat/seam.ts";
import * as texts from "../../../src/core/texts.ts";
import { named } from "../../../src/core/texts.ts";
import { AsyncEvent } from "../../support/fake-clock.ts";
import { HoldWorld } from "./hold-world.ts";
import { PLAIN_NAMES } from "./messages-world.ts";
import { AUTO_MODE, BYPASS_MODE, DEFAULT_MODE, ModeAgent } from "./mode-agent.ts";

const LIMIT = { timeout: 8000 };

/** The private member a test calls to lose a session's process, as a reader crash does. */
interface Internals {
  dropClient(): Promise<void>;
}

/** A world over an agent that starts in `native`, a folder whose own settings choose its mode. */
async function worldOf(t: TestContext, native = DEFAULT_MODE, auto = false) {
  const agent = new ModeAgent({ models: true, live: true, auto });
  agent.native = native;
  const world = await HoldWorld.make(t, { agent });
  return { world, agent };
}

/** The first message of a new thread, its setup open. */
async function waiting(world: HoldWorld, text = "hello") {
  const sending = world.says(text);
  const open = await world.asked("setup");
  return { ref: open.ref, open, sending };
}

const selectionOf = (request: unknown) => (request as SetupRequest).selection;

const summaryEnds = (world: HoldWorld, ref: ThreadRef, ending: string) =>
  world.shown(ref).some((line) => line.startsWith("Model:") && line.endsWith(ending));

for (const word of ["/bypass on", "/bypass off"]) {
  test(`bypass typed while the setup waits points at the setup [${word}]`, LIMIT, async (t) => {
    const { world, agent } = await worldOf(t);
    const { ref, sending } = await waiting(world);
    await world.says(word, ref.thread);
    // Start alone sets bypass before the first prompt: the word changes nothing and says so.
    assert.deepEqual(agent.recorded.at(-1)?.modes, []);
    assert.equal(world.stored(ref)?.bypass, null);
    assert.ok(world.shown(ref).includes(texts.BYPASS_BEFORE_START));
    assert.ok(world.chat.calls("showStatus").length > 0); // the chat records what it is asked
    assert.deepEqual(world.chat.calls("acknowledge"), []); // nothing took effect: no mark
    await world.start(ref); // bypass unticked
    await sending;
    await world.settle();
    assert.deepEqual(agent.recorded.at(-1)?.modes, []); // never left the folder's own mode
    assert.equal(world.stored(ref)?.bypass, false);
    assert.deepEqual(await world.prompts(), ["hello"]);
    assert.ok(summaryEnds(world, ref, "Bypass: off"));
  });
}

// The folder's own bypass makes the session run in bypass before any Start: the word is refused
// all the same, since the box is what sets it.
for (const word of ["/bypass on", "/bypass off"]) {
  test(
    `bypass typed while the setup waits in a native bypass folder is refused [${word}]`,
    LIMIT,
    async (t) => {
      const { world } = await worldOf(t, BYPASS_MODE);
      const { ref, sending } = await waiting(world);
      await world.says(word, ref.thread);
      assert.ok(world.shown(ref).includes(texts.BYPASS_BEFORE_START));
      assert.equal(world.stored(ref)?.bypass, null);
      await world.start(ref, { bypass: true });
      await sending;
    },
  );
}

test("/bypass off in an auto mode thread returns to auto mode", LIMIT, async (t) => {
  // An owner whose own settings start the agent in its automatic mode.
  const { world, agent } = await worldOf(t, AUTO_MODE, true);
  const ref = await world.opened("hi");
  await world.says("/bypass on", ref.thread);
  await world.says("/bypass off", ref.thread);
  assert.deepEqual(agent.recorded[0]?.modes, [BYPASS_MODE, AUTO_MODE]);
  assert.ok(world.shown(ref).includes(texts.BYPASS_ON_THREAD));
  assert.ok(world.shown(ref).includes(named(texts.BYPASS_OFF_THREAD, PLAIN_NAMES)));
});

test("a native bypass folder starts the box ticked", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t, BYPASS_MODE);
  const { ref, open, sending } = await waiting(world);
  assert.equal(selectionOf(open.request).bypass, true);
  await world.start(ref, { bypass: true }); // the ticked default
  await sending;
  await world.settle();
  assert.equal(world.session(ref).nativeMode, BYPASS_MODE);
  assert.deepEqual(await world.prompts(), ["hello"]);
  assert.deepEqual(agent.recorded.at(-1)?.modes, []); // the process already runs in bypass
  assert.ok(summaryEnds(world, ref, "Bypass: on"));
});

test("unticking in a native bypass folder turns bypass off", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t, BYPASS_MODE);
  const { ref, sending } = await waiting(world);
  await world.start(ref); // unticked: an explicit off, as `/bypass off`
  await sending;
  await world.settle();
  assert.equal(world.session(ref).bypass, false);
  assert.equal(agent.recorded.at(-1)?.modes.at(-1), DEFAULT_MODE);
  assert.deepEqual(await world.prompts(), ["hello"]);
  assert.ok(summaryEnds(world, ref, "Bypass: off"));
});

test(
  "a box left ticked in a native bypass folder stays on through a model and an effort",
  LIMIT,
  async (t) => {
    const { world } = await worldOf(t, BYPASS_MODE);
    const { ref, sending } = await waiting(world);
    await world.start(ref, { model: "big", effort: "brief", bypass: true });
    await sending;
    assert.ok(summaryEnds(world, ref, "Effort: brief · Bypass: on"));
    assert.equal(world.stored(ref)?.bypass, true);
  },
);

test("a connect racing start does not record bypass as off", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t);
  const { ref, sending } = await waiting(world);
  const session = world.session(ref);
  await (session as unknown as Internals).dropClient(); // the process is gone while the setup waits
  world.state.setBypass(ref.channel, ref.thread, true); // what a restart left
  const gate = new AsyncEvent();
  agent.gates.setPermissionMode = gate;
  const status = world.says("/status", ref.thread);
  await world.settle();
  assert.deepEqual(agent.recorded.at(-1)?.modes, [BYPASS_MODE]); // connect blocked mid-switch
  const click = world.start(ref); // bypass off
  await world.settle();
  gate.set();
  await Promise.all([status, click, sending]);
  await world.settle();
  assert.deepEqual(await world.prompts(), ["hello"]);
  assert.equal(agent.recorded.at(-1)?.modes.at(-1), DEFAULT_MODE); // what Start said, not the process's first mode
});

test("a native bypass folder asks again with the box ticked after a stop", LIMIT, async (t) => {
  const { world } = await worldOf(t, BYPASS_MODE);
  const gate = new AsyncEvent();
  world.hooks.rewriteGate = gate;
  const { ref } = await waiting(world);
  void world.start(ref); // unticked: native mode moves to default
  await world.settle();
  await world.says("/stop", ref.thread);
  gate.set();
  await world.settle();
  delete world.hooks.rewriteGate;
  const again = world.says("again", ref.thread);
  await world.asked("setup", ref);
  assert.equal(selectionOf(world.open("setup", ref)[0]?.request).bypass, true);
  await world.start(ref, { bypass: true });
  await again;
});

/** A native-bypass folder's thread that started with a box and ran a turn. */
async function ranInANativeBypassFolder(world: HoldWorld, agent: ModeAgent, unticked = true) {
  agent.native = BYPASS_MODE;
  const { ref, sending } = await waiting(world);
  await world.start(ref, { bypass: !unticked });
  await sending;
  await world.settle();
  assert.ok(world.stored(ref)?.sessionId, "the thread ran");
  return ref;
}

test("an unticked off survives an idle close", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t);
  const ref = await ranInANativeBypassFolder(world, agent);
  const session = world.session(ref);
  await session.close();
  await world.says("second", ref.thread);
  await world.settle();
  const fresh = world.sessions.get(ref.channel, ref.thread);
  assert.ok(fresh !== null && fresh !== session);
  assert.deepEqual(await world.prompts(), ["hello", "second"]);
  assert.equal(agent.recorded.at(-1)?.modes.at(-1), DEFAULT_MODE); // not back in the folder's own bypass
  assert.equal(fresh.bypass, false);
});

test("an unticked off survives a lost client", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t);
  const ref = await ranInANativeBypassFolder(world, agent);
  const session = world.session(ref);
  await (session as unknown as Internals).dropClient(); // the reader-crash path
  await world.says("second", ref.thread);
  await world.settle();
  assert.equal(agent.recorded.at(-1)?.modes.at(-1), DEFAULT_MODE);
  assert.equal(session.bypass, false);
});

test("/bypass off in a native folder survives a restart", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t);
  const ref = await ranInANativeBypassFolder(world, agent, false);
  const session = world.session(ref);
  assert.equal(session.bypass, true);
  await world.says("/bypass off", ref.thread);
  assert.equal(agent.recorded.at(-1)?.modes.at(-1), DEFAULT_MODE);
  await session.close(); // the restart: a new object from state.json
  await world.says("second", ref.thread);
  await world.settle();
  assert.equal(agent.recorded.at(-1)?.modes.at(-1), DEFAULT_MODE);
  assert.equal(world.session(ref).bypass, false);
});

test("a thread that never chose keeps the folders own bypass", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t);
  const ref = await ranInANativeBypassFolder(world, agent, false); // Start pressed with the box ticked
  await world.says("/bypass off", ref.thread);
  world.state.setBypass(ref.channel, ref.thread, null); // never chosen
  const session = world.session(ref);
  await (session as unknown as Internals).dropClient();
  await session.ensureConnected();
  assert.deepEqual(agent.recorded.at(-1)?.modes, []); // left as the agent started it
  assert.equal(session.bypass, true);
});

test("the channel status row reads the effective bypass", LIMIT, async (t) => {
  const { world, agent } = await worldOf(t);
  const ref = await ranInANativeBypassFolder(world, agent);
  await world.says("/status");
  assert.ok(
    !(world.chat.texts(world.channel).at(-1) as string).includes(texts.STATUS_CHANNEL_BYPASS),
  );
  world.state.setBypass(ref.channel, ref.thread, null); // never chosen: the folder's bypass runs
  await world.says("/status");
  assert.ok(
    (world.chat.texts(world.channel).at(-1) as string).includes(texts.STATUS_CHANNEL_BYPASS),
  );
});
