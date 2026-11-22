import assert from "node:assert/strict";
import { test } from "node:test";
import { FIRST_TIME, plausibleRange } from "../../src/protocol/time-range.ts";

const NOW = FIRST_TIME + 10 * 86_400_000;

test("the range of a million times is found without a spread argument per time (review D1)", () => {
  const times = Array.from({ length: 1_000_000 }, (_, i) => NOW - 1000 - i);
  assert.deepEqual(plausibleRange(times, NOW), { first: NOW - 1000 - 999_999, last: NOW - 1000 });
});

test("a time before the floor or more than a day ahead is left out; none left gives an empty range", () => {
  assert.deepEqual(plausibleRange([FIRST_TIME - 1, NOW + 86_400_001], NOW), {});
  assert.deepEqual(plausibleRange([FIRST_TIME - 1, NOW + 86_400_000, FIRST_TIME], NOW), {
    first: FIRST_TIME,
    last: NOW + 86_400_000,
  });
});
