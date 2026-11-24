/**
 * The footer's values as `/status` lists them (`formatStatusFields`): the order they follow, and
 * a limit's reset as the time to it from the clock given. The footer's own line, its markup and
 * its separators, are the chat's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FooterFields } from "../../src/chat/seam.ts";
import { footerFields, formatStatusFields } from "../../src/core/footer.ts";

const NOW = Date.UTC(2026, 8, 23, 19, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A footer that knows nothing; a test sets what it is about. */
function fields(known: Partial<FooterFields> = {}): FooterFields {
  return {
    bypass: false,
    planning: false,
    model: null,
    effort: null,
    advisor: null,
    effortObserved: null,
    folder: null,
    branch: null,
    gitUntrusted: false,
    changes: null,
    sessionTokens: null,
    contextPercent: null,
    sessionLimit: null,
    weekLimit: null,
    account: null,
    accountPlan: null,
    sessionCost: null,
    work: null,
    ...known,
  };
}

test("a limit with a reset shows the time to it, and one with none the share alone", () => {
  assert.deepEqual(
    formatStatusFields(
      fields({ weekLimit: { percent: 45, resetsAt: NOW + 3 * DAY + 4 * HOUR + 12 * MINUTE } }),
      NOW,
    ),
    ["7d limit: `45% ↻ 3d 4h`"],
  );
  assert.deepEqual(
    formatStatusFields(fields({ weekLimit: { percent: 45, resetsAt: null } }), NOW),
    ["7d limit: `45%`"],
  );
  assert.deepEqual(
    formatStatusFields(
      fields({ sessionLimit: { percent: 3, resetsAt: NOW + 2 * HOUR + 10 * MINUTE } }),
      NOW,
    ),
    ["5h limit: `3% ↻ 2h`"],
  );
  assert.deepEqual(
    formatStatusFields(fields({ sessionLimit: { percent: 3, resetsAt: null } }), NOW),
    ["5h limit: `3%`"],
  );
});

test("the changes follow the branch in the status", () => {
  const data = fields({ branch: "main", model: "model-a", changes: [42, 10] });
  assert.deepEqual(formatStatusFields(data, NOW), [
    "Model: `model-a`",
    "Branch: `main`",
    "Uncommitted: `(+42,-10)`",
  ]);
});

test("every value of the footer is a line of the status, in the footer's order", () => {
  const data = fields({
    branch: "main",
    model: "model-a",
    contextPercent: 6.4,
    sessionTokens: 12_345,
    sessionLimit: { percent: 3, resetsAt: NOW + 2 * HOUR + 10 * MINUTE },
    weekLimit: { percent: 25, resetsAt: null },
    effort: "high",
    changes: [1, 2],
  });
  assert.deepEqual(
    formatStatusFields(data, NOW).map((line) => line.split(":")[0]),
    [
      "Model",
      "Effort",
      "Branch",
      "Uncommitted",
      "Session tokens",
      "Context",
      "5h limit",
      "7d limit",
    ],
  );
});

test("the session's estimated cost is in no field of the footer and no line of the status", () => {
  const data = fields({ sessionCost: 1.84, model: "Opus 5.5" });
  assert.equal(JSON.stringify(footerFields(data, NOW)).includes("1.84"), false);
  assert.equal(formatStatusFields(data, NOW).join("\n").includes("1.84"), false);
});
