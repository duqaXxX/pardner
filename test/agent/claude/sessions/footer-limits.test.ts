/**
 * The usage limits of the account in `/status`: the share used, and the time to its reset when
 * the account says one. A time is read from the wall clock the sessions are given, in
 * milliseconds as the limits' reset times are. The footer of a reply hands the chat the same
 * figures, which draws them in its own words (the memory chat writes `session 3%`): that drawing is the
 * chat's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FooterFields } from "../../../../src/chat/seam.ts";
import { type Usage, UsageCache } from "../../../../src/core/footer.ts";
import { USAGE_WAIT } from "../../../../src/core/sessions/constants.ts";
import { memoryHarnessFor, sdkMessages } from "../../../support/sessions.ts";

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** The wall clock of the sessions: 10:00 on a day of 2026, in milliseconds. */
const NOW = Date.UTC(2026, 8, 23, 10, 0);

/** A harness whose usage cache answers `usage`, with the wall clock at `NOW`. */
function limited(t: Parameters<typeof memoryHarnessFor>[0], usage: Usage) {
  const h = memoryHarnessFor(t)({ turns: [] });
  h.wall = NOW;
  (h.deps as { usage: UsageCache | null }).usage = new UsageCache(async () => usage);
  return h;
}

test("the status counts a limit down from the wall clock, and writes the share alone when no reset is known", async (t) => {
  const h = limited(t, {
    session: { percent: 3, resetsAt: NOW + 2 * HOUR + 10 * MINUTE },
    week: { percent: 25, resetsAt: null },
    account: null,
  });
  const session = h.session();
  await session.status(); // the first read starts the fetch
  await h.until(() => h.deps.usage !== null);
  await h.idle();
  const text = await session.status();
  assert.ok(text.includes("5h limit: `3% ↻ 2h`"), text);
  assert.ok(text.includes("7d limit: `25%`"), text);
  assert.ok(!text.includes("7d limit: `25% ↻"), "no reset, no time");
});

test("a weekly limit with a reset shows the days and hours to it in the status", async (t) => {
  const h = limited(t, {
    session: null,
    week: { percent: 45, resetsAt: NOW + 3 * 24 * HOUR + 4 * HOUR + 12 * MINUTE },
    account: null,
  });
  const session = h.session();
  await session.status();
  await h.idle();
  const text = await session.status();
  assert.ok(text.includes("7d limit: `45% ↻ 3d 4h`"), text);
});

test("the status waits for a usage read already running, and carries its time", async (t) => {
  const h = memoryHarnessFor(t)({ turns: [] });
  h.wall = NOW;
  const usage: Usage = { session: { percent: 7, resetsAt: null }, week: null, account: null };
  // A read that answers after real time, as `/usage` does: the status starts it and must wait for it.
  (h.deps as { usage: UsageCache | null }).usage = new UsageCache(
    () => new Promise((resolve) => setTimeout(() => resolve(usage), 50)),
    { now: () => NOW + 1 },
  );
  const text = await h.session().status();
  assert.ok(text.includes("5h limit: `7%`"), text);
  assert.equal(h.deps.usage?.readAt, NOW + 1);
});

test("the status stops waiting for a usage read after USAGE_WAIT, and shows no limit", async (t) => {
  const h = memoryHarnessFor(t)({ turns: [] });
  h.wall = NOW;
  (h.deps as { usage: UsageCache | null }).usage = new UsageCache(
    () => new Promise<Usage>(() => {}),
  );
  let text: string | null = null;
  const status = h
    .session()
    .status()
    .then((written) => {
      text = written;
    });
  // The wait starts once the status has read the rest; each advance crosses a wait begun before it.
  for (let round = 0; round < 50 && text === null; round += 1) await h.clock.advance(USAGE_WAIT);
  await status;
  assert.ok(text !== null && !String(text).includes("5h limit"), String(text));
});

/** A harness whose usage reads wait for `release`, each read answering the next of `answers`. */
function held(
  t: Parameters<typeof memoryHarnessFor>[0],
  turns: number,
  answers: Usage[],
  chat: { activityLine?: boolean } = {},
) {
  const h = memoryHarnessFor(
    t,
    {},
    chat,
  )({
    turns: Array.from({ length: turns }, () => sdkMessages("tools")),
  });
  h.wall = NOW;
  const gate = { release: () => {}, reads: 0 };
  (h.deps as { usage: UsageCache | null }).usage = new UsageCache(
    () =>
      new Promise<Usage>((resolve) => {
        const answer = answers[Math.min(gate.reads, answers.length - 1)] as Usage;
        gate.reads += 1;
        gate.release = () => resolve(answer);
      }),
    { now: () => NOW + 500 },
  );
  return { h, gate };
}

/** Every footer the thread drew, in order. */
const footers = (h: { room: { calls(call: string): readonly { args: readonly unknown[] }[] } }) =>
  h.room.calls("showFooter").map((call) => call.args[0] as FooterFields);

const share = (percent: number): Usage => ({
  session: { percent, resetsAt: null },
  week: null,
  account: null,
});

test("a short turn's footer waits for the read the turn started, off the reader, and carries its date", async (t) => {
  const { h, gate } = held(t, 1, [share(41)]);
  await (await h.session().submit("list the files")).done.wait();
  await h.idle();
  assert.equal(footers(h).length, 0, "no footer while the read runs");
  gate.release();
  await h.until(() => footers(h).length === 1);
  assert.equal(footers(h)[0]?.sessionLimit?.percent, 41);
  assert.equal(footers(h)[0]?.limitsReadAt, NOW + 500);
});

test("a footer stops waiting for a read after USAGE_WAIT and goes with what is in memory", async (t) => {
  const { h } = held(t, 1, [share(41)]);
  await (await h.session().submit("list the files")).done.wait();
  await h.idle();
  assert.equal(footers(h).length, 0);
  await h.clock.advance(USAGE_WAIT);
  await h.until(() => footers(h).length === 1);
  assert.equal(footers(h)[0]?.sessionLimit, null, "nothing was read yet");
  assert.equal(footers(h)[0]?.limitsReadAt, null);
});

test("a prompt that starts and ends while the footer waits gets its footer, with its own work", async (t) => {
  const { h, gate } = held(t, 2, [share(41)]);
  const session = h.session();
  await (await session.submit("first")).done.wait();
  await h.idle();
  h.wall = NOW + 60_000;
  await (await session.submit("second")).done.wait();
  await h.idle();
  assert.equal(footers(h).length, 0, "both ended while the read runs");
  gate.release();
  await h.until(() => footers(h).length >= 1);
  await h.idle();
  const drawn = footers(h);
  assert.equal(drawn.length, 1, "one footer, the newest work's");
  assert.equal(drawn[0]?.work?.doneAt, NOW + 60_000);
  assert.equal(drawn[0]?.sessionLimit?.percent, 41);
});

test("a close while the footer waits cancels the wait: a read that answers after draws nothing", async (t) => {
  const { h, gate } = held(t, 1, [share(41)]);
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  await h.idle();
  await session.close();
  const after = h.room.calls().length;
  gate.release();
  await h.idle();
  await h.sleep(1);
  assert.ok(
    footers(h).every((footer) => footer.sessionLimit === null),
    "no footer of the wait's",
  );
  assert.equal(h.room.calls().length, after, "nothing is written after the close");
});

test("a prompt still running when the waiter wakes draws its own footer at its end, and Working goes", async (t) => {
  const { h, gate } = held(t, 1, [share(41)], { activityLine: true });
  const session = h.session();
  await (await session.submit("first")).done.wait();
  await h.idle();
  h.wall = NOW + 60_000;
  const second = await session.submit("second");
  await h.until(() => session.busy);
  gate.release();
  await h.idle();
  assert.equal(footers(h).length, 0, "no footer while the second prompt runs");
  h.wall = NOW + 70_000;
  h.clients[0]?.answer(sdkMessages("tools"));
  await second.done.wait();
  await h.until(() => footers(h).length === 1);
  await h.idle();
  assert.equal(footers(h)[0]?.work?.doneAt, NOW + 70_000);
  assert.equal(h.room.calls("showActivity").at(-1)?.args[0], null);
});

test("an account whose read carries no window dates no limits, so a cost alone keeps the work's end", async (t) => {
  const { h, gate } = held(t, 1, [{ session: null, week: null, account: null }]);
  await (await h.session().submit("list the files")).done.wait();
  await h.idle();
  gate.release();
  await h.until(() => footers(h).length === 1);
  assert.equal(footers(h)[0]?.limitsReadAt, null);
});

test("Working stays while the footer waits for the read, and goes once the footer is drawn", async (t) => {
  const h = memoryHarnessFor(t, {}, { activityLine: true })({ turns: [sdkMessages("tools")] });
  h.wall = NOW;
  let release: () => void = () => {};
  (h.deps as { usage: UsageCache | null }).usage = new UsageCache(
    () => new Promise<Usage>((resolve) => (release = () => resolve(share(41)))),
  );
  await (await h.session().submit("list the files")).done.wait();
  await h.idle();
  const cleared = () => h.room.calls("showActivity").some((call) => call.args[0] === null);
  assert.equal(cleared(), false, "Working stays while the footer waits");
  release();
  await h.until(() => footers(h).length === 1);
  await h.idle();
  const calls = h.room.calls();
  const footer = calls.findIndex((call) => call.call === "showFooter");
  const gone = calls.findIndex((call) => call.call === "showActivity" && call.args[0] === null);
  assert.ok(footer !== -1 && gone > footer, `cleared at ${gone}, footer at ${footer}`);
});

/** A harness whose reads answer 41% then 55%, each when released, and whose cache the test can invalidate. */
function twoReads(t: Parameters<typeof memoryHarnessFor>[0]) {
  const h = memoryHarnessFor(t, {}, { activityLine: true })({ turns: [sdkMessages("tools")] });
  h.wall = NOW;
  const releases: Array<() => void> = [];
  const cache = new UsageCache(
    () =>
      new Promise<Usage>((resolve) => {
        const answer = share(releases.length === 0 ? 41 : 55);
        releases.push(() => resolve(answer));
      }),
    { now: () => NOW + 500 },
  );
  (h.deps as { usage: UsageCache | null }).usage = cache;
  return { h, releases, cache };
}

type ContextClient = { contextUsage(): Promise<unknown>; answer(items: unknown[]): void };

/** Holds every context read of the agent's client until released: a waiter that draws stays in its footer's read. */
function holdContext(h: { clients: unknown[] }) {
  const client = h.clients[0] as ContextClient;
  const original = client.contextUsage.bind(client);
  const held: Array<() => void> = [];
  client.contextUsage = () =>
    new Promise((resolve) => held.push(() => void original().then(resolve)));
  return { client, held, restore: () => (client.contextUsage = original) };
}

const ticks = async () => {
  for (let round = 0; round < 50; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** Turn 1's waiter drawing (held in its context read) while turn 2 runs, starts a read of its own and ends. */
async function secondEndsWhileFirstDraws(t: Parameters<typeof memoryHarnessFor>[0]) {
  const rig = twoReads(t);
  const { h, releases, cache } = rig;
  const session = h.session();
  await (await session.submit("first")).done.wait();
  await h.idle();
  const context = holdContext(h);
  releases[0]?.();
  await ticks();
  assert.ok(context.held.length >= 1, "the first waiter is drawing");
  cache.invalidate();
  h.wall = NOW + 60_000;
  const second = await session.submit("second");
  await h.until(() => session.busy);
  context.client.answer(sdkMessages("tools"));
  await second.done.wait();
  await ticks();
  assert.equal(releases.length, 2, "the second turn started a read");
  return { ...rig, context };
}

test("a turn that ends while the first footer is being drawn still gets its own footer", async (t) => {
  const { h, releases, context } = await secondEndsWhileFirstDraws(t);
  for (const release of context.held.splice(0)) release();
  context.restore();
  await ticks();
  releases[1]?.();
  await h.until(() => footers(h).length >= 1);
  await h.idle();
  const drawn = footers(h);
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0]?.work?.doneAt, NOW + 60_000);
  assert.equal(drawn[0]?.sessionLimit?.percent, 55);
  assert.equal(h.room.calls("showActivity").at(-1)?.args[0], null, "Working goes");
});

test("Working stays while a later footer still draws after an earlier waiter ends", async (t) => {
  const { h, releases, context } = await secondEndsWhileFirstDraws(t);
  const firstReads = context.held.length;
  releases[1]?.();
  await ticks();
  assert.ok(context.held.length > firstReads, "the second waiter is drawing");
  for (const release of context.held.splice(0, firstReads)) release();
  await ticks();
  await h.idle();
  assert.equal(footers(h).length, 0);
  assert.notEqual(h.room.calls("showActivity").at(-1)?.args[0], null, "Working stays");
  for (const release of context.held.splice(0)) release();
  context.restore();
  await h.until(() => footers(h).length === 1);
  await h.idle();
  assert.equal(h.room.calls("showActivity").at(-1)?.args[0], null);
});
