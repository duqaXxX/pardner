/** The requests in flight (step 6.3 design, D5): ids, deadlines, answers and the end of the connection. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Requests } from "../../src/protocol/requests.ts";

test("the first id is 2 (1 is the upload's) and they count up", () => {
  const r = new Requests(30_000);
  assert.deepEqual([r.add(0), r.add(0), r.add(5)], [2, 3, 4]);
});

test("next is the id the next add gives, and does not add", () => {
  const r = new Requests(30_000);
  assert.equal(r.next, 2);
  assert.equal(r.next, 2);
  assert.equal(r.add(0), 2);
  assert.equal(r.next, 3);
});

test("each request is due patience after its own add; the deadline is the earliest", () => {
  const r = new Requests(30_000);
  assert.equal(r.deadline, undefined);
  r.add(100);
  r.add(500);
  assert.equal(r.deadline, 30_100);
});

test("an answer takes a request out once; an unknown id is ignored", () => {
  const r = new Requests(30_000);
  const id = r.add(0);
  assert.equal(r.answer(99), false);
  assert.equal(r.answer(id), true);
  assert.equal(r.answer(id), false, "answered once");
  assert.equal(r.deadline, undefined);
});

test("the deadline moves to the next request when the earliest is answered", () => {
  const r = new Requests(30_000);
  const first = r.add(100);
  r.add(500);
  r.answer(first);
  assert.equal(r.deadline, 30_500);
});

test("late names the ids due at now, not before", () => {
  const r = new Requests(30_000);
  const a = r.add(0);
  const b = r.add(1000);
  assert.deepEqual(r.late(29_999), []);
  assert.deepEqual(r.late(30_000), [a]);
  assert.deepEqual(r.late(31_000), [a, b]);
});

test("clear returns every id in flight and leaves none; ids go on counting", () => {
  const r = new Requests(30_000);
  r.add(0);
  r.add(0);
  assert.deepEqual(r.clear(), [2, 3]);
  assert.equal(r.deadline, undefined);
  assert.deepEqual(r.clear(), []);
  assert.equal(r.add(0), 4, "an id is never reused");
});
