/**
 * The usage limits of the account in `!status`: the share used, and the time to its reset when
 * the account says one. A time is read from the wall clock the sessions are given, in
 * milliseconds as the limits' reset times are. The footer of a reply hands the chat the same
 * figures, which draws them in its own words (the memory chat writes `session 3%`): that drawing is the
 * chat's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Usage, UsageCache } from "../../../../src/core/footer.ts";
import { memoryHarnessFor } from "../../../support/sessions.ts";

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
