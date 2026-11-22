/**
 * #68: a top-level prompt refused before any session opened answers through a channel line that
 * names it; once `sessions.open` wrote the thread's entry the same refusal stays a line of the
 * session's thread. Which side of the open the refusal is on decides, where it is written.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, StartOptions } from "../../../src/agent/seam.ts";
import type { InboundMessage, ThreadRef } from "../../../src/chat/seam.ts";
import * as texts from "../../../src/core/texts.ts";
import { AsyncEvent } from "../../support/fake-clock.ts";
import { PlainAgent } from "../../support/plain-agent.ts";
import { MessagesWorld } from "./messages-world.ts";

const LIMIT = { timeout: 8000 };

class SlowStart extends PlainAgent {
  readonly gate = new AsyncEvent();
  override async start(
    options: StartOptions,
    requests: Parameters<PlainAgent["start"]>[1],
  ): Promise<AgentSession> {
    await this.gate.wait();
    return super.start(options, requests);
  }
}

/** A top-level prompt handed over with a `handled` that records the verdict. */
function topLevel(
  world: MessagesWorld,
  ref: ThreadRef,
  seen: { verdict?: boolean },
  content: () => Promise<string> = async () => "hello",
) {
  const message: InboundMessage = {
    ref,
    id: ref.thread,
    topLevel: true,
    text: "hello",
    plain: "hello",
    bare: "hello",
    literal: false,
    content: async () => content(),
    handled: (session) => {
      seen.verdict = session;
    },
  };
  return world.inbound.message(message);
}

const answered = (world: MessagesWorld) => world.chat.calls("answers").map((c) => c.args);

test(
  "a stop while the start check waits: the refusal is a channel line naming the prompt, and no session",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t);
    const ref = world.chat.openThread(world.channel);
    const release = new AsyncEvent();
    world.sessions.refusesStarts = async () => {
      await release.wait();
      return false;
    };
    const seen: { verdict?: boolean } = {};
    const sending = topLevel(world, ref, seen);
    await world.settle();
    await world.send({ ref, id: "m-stop", text: "/stop" });
    release.set();
    await sending;
    await world.settle();
    assert.equal(seen.verdict, false);
    assert.ok(answered(world).some((args) => args[1] === texts.NOT_SENT && args[2] === ref.thread));
    assert.ok(
      !world.shown(ref).includes(texts.NOT_SENT),
      "nothing was told into the prompt's own thread",
    );
  },
);

test(
  "a stop during the setup's connect: the entry exists, so a session, and the line stays in its thread",
  LIMIT,
  async (t) => {
    const agent = new SlowStart();
    const world = await MessagesWorld.make(t, { agent });
    const ref = world.chat.openThread(world.channel);
    const seen: { verdict?: boolean } = {};
    const sending = topLevel(world, ref, seen);
    await world.settle();
    await world.send({ ref, id: "m-stop", text: "/stop" });
    agent.gate.set();
    await sending;
    await world.settle();
    assert.equal(seen.verdict, true);
    assert.deepEqual(answered(world), []);
    assert.ok(world.shown(ref).includes(texts.NOT_SENT));
  },
);

test(
  "a drain that starts after the open: the refusal stays a line of the session's thread",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t);
    const ref = world.chat.openThread(world.channel);
    const read = new AsyncEvent();
    const seen: { verdict?: boolean } = {};
    const sending = topLevel(world, ref, seen, async () => {
      await read.wait();
      return "hello";
    });
    await world.settle();
    world.sessions.draining = true;
    read.set();
    await sending;
    await world.settle();
    assert.equal(seen.verdict, true);
    assert.deepEqual(answered(world), []);
    assert.ok(world.shown(ref).some((line) => line.startsWith(texts.RESTARTING)));
  },
);

test("a restart refusal before the open is a channel line naming the prompt", LIMIT, async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = world.chat.openThread(world.channel);
  world.sessions.refusesStarts = async () => true;
  const seen: { verdict?: boolean } = {};
  await topLevel(world, ref, seen);
  await world.settle();
  assert.equal(seen.verdict, false);
  assert.ok(
    answered(world).some(
      (args) => String(args[1]).startsWith(texts.RESTARTING) && args[2] === ref.thread,
    ),
  );
});

test(
  "asking whether a thread holds a session touches no closed session (#68)",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t);
    const { channel } = world;
    const thread = "t-closed";
    const opened = world.sessions.open(channel, thread);
    assert.ok(opened);
    await opened.close();
    const registry = (world.sessions as unknown as { sessions: Map<string, unknown> }).sessions;
    const before = [...registry.values()];
    assert.equal(world.sessions.holds(channel, thread), true);
    assert.deepEqual([...registry.values()], before, "the closed session was not rebuilt");
    assert.equal(world.sessions.holds(channel, "no-such-thread"), false);
  },
);

test(
  "a top-level /resume that fails after it wrote the entry tells into the thread, with no line naming the prompt (#68)",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t);
    const ref = world.chat.openThread(world.channel);
    const directory = world.state.channel(world.channel)?.directory as string;
    (world.agent as PlainAgent).store.remember(
      directory,
      "plain-old",
      "An older talk",
      1_000_000_000,
    );
    const resume = world.sessions.resume.bind(world.sessions);
    world.sessions.resume = async (channel, thread, id) => {
      await resume(channel, thread, id);
      throw new Error("a fault after the entry was written");
    };
    const seen: { verdict?: boolean } = {};
    const message: InboundMessage = {
      ref,
      id: ref.thread,
      topLevel: true,
      text: "/resume plain-old",
      plain: "/resume plain-old",
      bare: "/resume plain-old",
      literal: false,
      content: async () => "/resume plain-old",
      handled: (session) => {
        seen.verdict = session;
      },
    };
    await world.inbound.message(message);
    await world.settle();
    assert.notEqual(world.state.thread(ref.channel, ref.thread), null, "the entry was written");
    assert.equal(seen.verdict, true);
    assert.deepEqual(answered(world), [], "no line names the prompt that a session holds");
    assert.ok(world.shown(ref).length > 1, "the failure is a line of the thread");
  },
);

test(
  "a word typed in a thread that holds no session fails as a channel line (#68)",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t);
    const ref = world.chat.openThread(world.channel);
    world.sessions.sessionsOf = () => {
      throw new Error("a fault in the flow");
    };
    await world.send({ ref, id: "m-status", text: "/status" });
    await world.settle();
    const failure = (line: string) => line.includes("reported an error") || line.includes("Error");
    assert.ok(world.inChannel().some(failure), "the failure is a channel line");
    assert.deepEqual(answered(world), [], "it names no prompt");
    assert.ok(!world.shown(ref).some(failure), "nothing of it in the thread that holds no session");
  },
);
