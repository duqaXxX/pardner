/**
 * The footer opens with the work's duration and end time: from the owner's prompt
 * to the moment the session has ended everything, background reports included. The sessions
 * read the wall time from `deps.now`, which these tests move by hand.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FooterFields } from "../../../../src/chat/seam.ts";
import { AsyncEvent } from "../../../support/fake-clock.ts";
import {
  type Harness,
  isResult,
  memoryHarnessFor,
  sdkMessages,
} from "../../../support/sessions.ts";
import { splitBackground } from "./helpers.ts";

const START = Date.UTC(2026, 9, 21, 1, 0);
const MINUTE = 60_000;

/** The work of every footer the thread drew, once each, in order: its length and when it ended. */
function drawn(h: Harness): Array<{ durationMs: number; doneAt: number }> {
  const seen = new Map<string, { durationMs: number; doneAt: number }>();
  for (const call of h.room.calls("showFooter")) {
    const work = (call.args[0] as FooterFields).work;
    if (work !== null) seen.set(JSON.stringify(work), { ...work });
  }
  return [...seen.values()];
}

/** The work a footer closes, as `drawn` lists it. */
const work = (minutes: number, doneAt: number): { durationMs: number; doneAt: number } => ({
  durationMs: minutes * MINUTE,
  doneAt,
});

test("a prompt answered at once draws a footer whose work spans prompt to end", async (t) => {
  const h = memoryHarnessFor(t)({ turns: [sdkMessages("tools")] });
  h.wall = START;
  await (await h.session().submit("list the files")).done.wait();
  await h.idle();
  await h.sleep(3);
  assert.deepEqual(drawn(h), [work(0, START)]);
});

test("a turn that leaves a background task draws its footer after the report, counted from the prompt", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = memoryHarnessFor(t)({ turns: [first] });
  const session = h.session();
  h.wall = START;
  await (await session.submit("start it")).done.wait();
  await h.idle();
  await h.sleep(3);
  assert.ok(h.room.calls("text").length > 0, "the reply was written");
  assert.deepEqual(drawn(h), [], "no footer while the command runs");
  h.wall = START + 10 * MINUTE;
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => session.idle);
  await h.idle();
  await h.sleep(3);
  assert.deepEqual(drawn(h), [work(10, START + 10 * MINUTE)]);
});

test("a subagent's report ends the work the first prompt began", async (t) => {
  const items = sdkMessages("session-state-agent");
  const first = items.findIndex(isResult);
  const h = memoryHarnessFor(t)({ turns: [items.slice(0, first + 1)] });
  const session = h.session();
  h.wall = START;
  await (await session.submit("launch it")).done.wait();
  await h.idle();
  h.wall = START + 3 * MINUTE;
  h.clients[0]?.inject(items.slice(first + 1));
  await h.until(() => session.idle);
  await h.idle();
  await h.sleep(3);
  assert.deepEqual(drawn(h), [work(3, START + 3 * MINUTE)]);
});

test("a second work after a footer starts its own count", async (t) => {
  const h = memoryHarnessFor(t)({ turns: [sdkMessages("tools"), sdkMessages("tools")] });
  const session = h.session();
  h.wall = START;
  await (await session.submit("one")).done.wait();
  await h.idle();
  await h.sleep(3);
  h.wall = START + 60 * MINUTE;
  await (await session.submit("two")).done.wait();
  await h.idle();
  await h.sleep(3);
  assert.deepEqual(drawn(h), [work(0, START), work(0, START + 60 * MINUTE)]);
});

test("`/status` shows no duration", async (t) => {
  const h = memoryHarnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  h.wall = START;
  await (await session.submit("list the files")).done.wait();
  await h.idle();
  h.wall = START + 5 * MINUTE;
  const status = await session.status();
  assert.doesNotMatch(status, /\bdone\b|<!date|\d+m \d+s/);
});

test("the count starts at the owner's prompt, not at the first event of the turn", async (t) => {
  const gate = new AsyncEvent();
  const h = memoryHarnessFor(t)({ startGate: gate, turns: [sdkMessages("tools")] });
  h.wall = START;
  const turn = await h.session().submit("list the files");
  await h.until(() => h.clients.length > 0);
  h.wall = START + 2 * MINUTE;
  gate.set();
  await turn.done.wait();
  await h.idle();
  await h.sleep(3);
  assert.deepEqual(drawn(h), [work(2, START + 2 * MINUTE)]);
});

test("a prompt that could not start leaves no start behind for the next work", async (t) => {
  const h = memoryHarnessFor(t)(
    { startError: new Error("the CLI would not start"), turns: [] },
    { turns: [sdkMessages("tools")] },
  );
  const session = h.session();
  h.wall = START;
  await (await session.submit("hello")).done.wait();
  await h.idle();
  await h.sleep(3);
  assert.deepEqual(drawn(h), [], "no footer for a prompt that never started");
  h.wall = START + 30 * MINUTE;
  await (await session.submit("again")).done.wait();
  await h.idle();
  await h.sleep(3);
  assert.deepEqual(drawn(h), [work(0, START + 30 * MINUTE)]);
});
