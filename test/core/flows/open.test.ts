/**
 * `/open` as the core hands it over: the word goes to a chat that can share a file with the
 * folder of the thread's own session, never the channel's, and a thread that holds no session is
 * answered as a top-level `/open` is. What the chat then lists and shares is read in
 * `test/core/files/open-search.test.ts`; the last block is the order of two prompts sent while
 * a repository is being looked up.
 */
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as texts from "../../../src/core/texts.ts";
import { AsyncEvent } from "../../support/fake-clock.ts";
import { MessagesWorld, WithFolderTrust } from "./messages-world.ts";

test("/open resolves in the folder of the thread's own session, not the channel's", async (t) => {
  // The channel was bound to another folder after the thread began.
  const world = await MessagesWorld.make(t, { files: true });
  const ref = await world.opened();
  const elsewhere = join(world.folder, "elsewhere");
  mkdirSync(elsewhere);
  world.state.bind(world.channel, realpathSync(elsewhere));
  await world.says("/open only_here.py", ref.thread);
  await world.says("/open", ref.thread);
  assert.deepEqual(world.fileCalls, [
    [ref, world.folder, "only_here.py"],
    [ref, world.folder, ""],
  ]);
  // The control: a thread begun after the bind is in the channel's new folder.
  const later = await world.opened("later");
  await world.says("/open only_there.py", later.thread);
  assert.deepEqual(world.fileCalls.at(-1), [later, realpathSync(elsewhere), "only_there.py"]);
});

test("/open outside a session's thread is answered as the top level is, whatever its words", async (t) => {
  const world = await MessagesWorld.make(t, { files: true });
  await world.says("/open");
  const outside = world.chat.openThread(world.channel);
  await world.says("/open notes.md", outside.thread);
  // Both answers stand in the channel: a thread that holds no session has no place for one.
  assert.deepEqual(
    world.inChannel().filter((text) => text === texts.OPEN_TOP_LEVEL),
    [texts.OPEN_TOP_LEVEL, texts.OPEN_TOP_LEVEL],
  );
  assert.deepEqual(world.fileCalls, []);
  // The control: the same words in a session's thread reach the chat.
  const ref = await world.opened();
  await world.says("/open notes.md", ref.thread);
  assert.deepEqual(world.fileCalls, [[ref, world.folder, "notes.md"]]);
});

test("two replies sent while a repository lookup is slow reach the agent in the order they were sent", async (t) => {
  // Nothing waits on a repository when a prompt arrives: a slow lookup (a cold cache, a slow git)
  // must not hold a prompt, or let a later one overtake it.
  const slow = new AsyncEvent();
  const agent = new WithFolderTrust();
  const real = agent.trustedRepository;
  let armed = false;
  let held = 0;
  agent.trustedRepository = async (folder) => {
    if (armed && held === 0) {
      held += 1;
      await slow.wait();
    }
    return real(folder);
  };
  const world = await MessagesWorld.make(t, { agent });
  // Armed after the opening turn, whose own footer would otherwise use the slow lookup up.
  const ref = await world.opened("start");
  armed = true;
  const one = world.says("first", ref.thread);
  const two = world.says("second", ref.thread);
  await world.settle();
  slow.set();
  await Promise.all([one, two]);
  assert.deepEqual((await world.prompts()).slice(-2), ["first", "second"]);
  assert.equal(held, 1, "the control: a lookup was held while the replies arrived");
});
