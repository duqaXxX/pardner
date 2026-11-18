/**
 * A message the chat marks literal (what a chat hands over for words it did not type as text:
 * the transcript of an audio clip, with the owner's own words ahead of it) is a prompt with the
 * content it carries, whatever its first characters. The chat decides what a clip says and
 * waits for its transcript; the core only reads the flag.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestHandler, StartOptions } from "../../../src/agent/seam.ts";
import * as texts from "../../../src/core/texts.ts";
import { MessagesWorld, WithBypass } from "./messages-world.ts";

/** A bypass-capable agent that records every permission mode a session is given. */
class RecordingBypass extends WithBypass {
  readonly modes: string[] = [];

  override async start(options: StartOptions, requests: RequestHandler) {
    const session = await super.start(options, requests);
    session.setPermissionMode = async (mode) => {
      this.modes.push(mode);
    };
    return session;
  }
}

test("what a clip heard is a prompt, never a word of the daemon: speech does not turn bypass on", async (t) => {
  const agent = new RecordingBypass();
  const world = await MessagesWorld.make(t, { agent });
  const ref = world.chat.openThread(world.channel);
  const sending = world.send({
    ref,
    id: ref.thread,
    topLevel: true,
    text: "/bypass on",
    literal: true,
  });
  const open = await world.asked("setup");
  await world.start(open.ref);
  await sending;
  assert.deepEqual(await world.prompts(), ["/bypass on"]);
  assert.deepEqual(agent.modes, [], "no mode was changed");
  // The control: the same words typed as text in a session's thread are the daemon's.
  const thread = await world.opened("second");
  await world.says("/bypass on", thread.thread);
  await world.settle();
  assert.deepEqual(agent.modes, ["unrestricted"], "typed, the word changes the mode");
  assert.deepEqual(
    (await world.prompts()).filter((prompt) => prompt === "/bypass on"),
    ["/bypass on"],
  );
});

test("text typed with a clip comes before its transcript in one prompt, in a session's thread", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.send({
    ref,
    id: "msg-clip",
    text: "/status",
    literal: true,
    content: async () => "/status\n\nWhat day is it today?",
  });
  assert.deepEqual(await world.prompts(), ["first", "/status\n\nWhat day is it today?"]);
  await world.settle();
  const answers = () => world.shown(ref).filter((line) => line.startsWith("Directory:"));
  assert.deepEqual(answers(), [], "the word of the daemon did not run");
  // The control: typed as text, the same word is answered.
  await world.says("/status", ref.thread);
  await world.settle();
  assert.equal(answers().length, 1);
});

test("a literal message where a message would be refused is refused, and waits for nothing", async (t) => {
  const world = await MessagesWorld.make(t);
  const old = world.chat.openThread(world.channel); // a thread that holds no session
  await world.send({ ref: old, id: "msg-clip", text: "heard", literal: true });
  assert.equal(world.shown(old).at(-1), texts.NOT_A_SESSION);
  assert.deepEqual(await world.prompts(), []);
});
