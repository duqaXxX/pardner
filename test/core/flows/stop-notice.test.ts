/**
 * `!stop` typed in a thread, through the word's flow: the footer is on the reply the stop ended,
 * and the line that says the stop is a notice below it with none (the footer goes on the
 * session's last reply, never on a notice of the daemon's own). A goal is still set after a stop:
 * the notice says so, with the owner's own words escaped.
 */
import assert from "node:assert/strict";
import { basename } from "node:path";
import { test } from "node:test";
import type { RequestHandler, StartOptions } from "../../../src/agent/seam.ts";
import * as texts from "../../../src/core/texts.ts";
import { fill } from "../../../src/core/texts.ts";
import {
  goalChanged,
  hold,
  PLAIN_CAPABILITIES,
  PLAIN_WORDS,
  PlainAgent,
  say,
} from "../../support/plain-agent.ts";
import { HoldWorld } from "./hold-world.ts";

const LIMIT = { timeout: 8000 };

/** Whether a message of the thread shows the session's footer: the folder it works in names it. */
function hasFooter(world: HoldWorld, text: string): boolean {
  return text.includes(basename(world.folder));
}

/** The messages of the thread, the owner's own left out. */
function replies(world: HoldWorld, ref: { channel: string; thread: string }) {
  return world.chat.messages(ref.channel, ref.thread).filter((m) => m.kind !== "message");
}

test(
  "a stop during a turn leaves the footer on the reply it ended, the notice below with none",
  LIMIT,
  async (t) => {
    const agent = new PlainAgent();
    const world = await HoldWorld.make(t, { agent });
    agent.next(say("working on it"), hold());
    const ref = await world.opened("hello");
    await world.says("!stop", ref.thread);
    await world.settle();
    const [, reply, notice] = replies(world, ref); // the setup's summary, the reply, the notice
    assert.ok(reply !== undefined && notice !== undefined);
    assert.equal(reply.kind, "reply");
    assert.ok(hasFooter(world, reply.text), "the footer is on the reply");
    assert.equal(notice.text, texts.STOPPED_THREAD);
    assert.ok(!hasFooter(world, notice.text), "and not on the notice");
    assert.equal(world.chat.calls("showFooter").length, 1);
  },
);

/** A plain agent that runs background tasks. */
class Background extends PlainAgent {
  override readonly capabilities = { ...PLAIN_CAPABILITIES, backgroundTasks: true };
}

test(
  "a stop of a background task puts the footer on its reply, the notice below with none",
  LIMIT,
  async (t) => {
    const agent = new Background();
    const world = await HoldWorld.make(t, { agent });
    agent.next(say("launching it"), hold());
    const ref = await world.opened("launch it");
    const process = world.process();
    process.emit({
      type: "task_started",
      taskId: "task-1",
      kind: "command",
      taskType: null,
      description: "watch",
      callId: null,
      agentType: null,
      background: true,
      parentTaskId: null,
    });
    process.release();
    await world.settle();
    const [, before] = replies(world, ref);
    assert.ok(before !== undefined && !hasFooter(world, before.text), "the task runs: no footer");
    await world.says("!stop", ref.thread);
    await world.settle();
    // The stop closes the process: no task is stopped one by one, and the tasks end with it.
    assert.ok(process.closed);
    const [, reply, notice] = replies(world, ref);
    assert.ok(reply !== undefined && notice !== undefined);
    assert.ok(hasFooter(world, reply.text), "the footer is on the reply");
    assert.equal(notice.text, texts.STOPPED_THREAD);
    assert.ok(!hasFooter(world, notice.text));
  },
);

test(
  "a stop of a reply whose end did not land draws the footer above the notice",
  LIMIT,
  async (t) => {
    // A chat that cannot rewrite a reply once it ended: the footer is a message of its own, and the
    // stop's notice comes after it. Nothing is posted below the notice.
    const agent = new PlainAgent();
    const world = await HoldWorld.make(t, { agent, edits: false });
    agent.next(say("working on it"), hold());
    const ref = await world.opened("hello");
    await world.says("!stop", ref.thread);
    await world.settle();
    const shown = replies(world, ref);
    const footer = shown.findIndex((m) => hasFooter(world, m.text));
    const notice = shown.findIndex((m) => m.text === texts.STOPPED_THREAD);
    assert.ok(footer >= 0, "the footer is drawn");
    assert.ok(notice > footer, "above the notice");
    assert.equal(notice, shown.length - 1, "nothing is posted below the notice");
  },
);

/** A plain agent with goals, whose words name a way to drop one, as Claude's do. */
class Goals extends PlainAgent {
  override readonly capabilities = { ...PLAIN_CAPABILITIES, goals: true };
  override readonly words = { ...PLAIN_WORDS, goalClear: "goal clear" };

  override async start(options: StartOptions, requests: RequestHandler) {
    const session = await super.start(options, requests);
    session.clearGoal = async () => {};
    return session;
  }
}

test("a stop on a goal says it is still set, the owner's words escaped", LIMIT, async (t) => {
  const agent = new Goals();
  const world = await HoldWorld.make(t, { agent });
  const ref = await world.opened("hi");
  const condition = "the build passes, then tell <!here>";
  agent.next(goalChanged({ state: "set", condition }), hold());
  await world.says(`!goal ${condition}`, ref.thread);
  await world.settle();
  await world.says("!stop", ref.thread);
  await world.settle();
  assert.equal(
    world.shown(ref).at(-1),
    `${texts.STOPPED_THREAD}\n${fill(texts.GOAL_STILL_ACTIVE_CLEAR, {
      condition: "the build passes, then tell &lt;!here&gt;",
      clear: "goal clear",
    })}`,
  );
});
