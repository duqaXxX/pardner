/**
 * What every device does with the messages it accepts (security design 5.6, condition 4, and 5.8)
 * on headers. A test named after one of the model's ends with ` [model]`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { editHonoured, Seen } from "../../src/protocol/device-reader.ts";
import type { MessageHeader } from "../../src/protocol/messages.ts";
import { epochOf, fill } from "./sequence.ts";

const inc = fill(9, 16);
const E1 = epochOf(1);
const header = (over: Partial<MessageHeader>): MessageHeader => ({
  channel: fill(1),
  counter: 1,
  epoch: E1,
  sender: fill(3),
  run: fill(4, 16),
  incarnation: inc,
  time: 1,
  kind: 11,
  blobs: [],
  name: fill(6, 16),
  ...over,
});

test("an edit is honoured only from the writer of the message it replaces, with the address it had", () => {
  const original = header({ kind: 2, to: fill(5) });
  assert.equal(editHonoured(original, header({ to: fill(5) })), true);
  assert.equal(editHonoured(original, header({ sender: fill(8), to: fill(5) })), false);
  assert.equal(editHonoured(original, header({ to: fill(6) })), false);
  assert.equal(editHonoured(original, header({})), false);
  assert.equal(editHonoured(header({ kind: 1 }), header({})), true);
});

test("5.6 conditions 2 and 4: no second message with a counter it accepted, and one name of one sender once [model]", () => {
  const seen = new Seen();
  const accept = (h: MessageHeader) => {
    const verdict = seen.check(h);
    seen.add(h);
    return verdict;
  };
  const one = header({ kind: 1 });
  assert.equal(seen.check(one), "first", "check records nothing");
  assert.equal(accept(one), "first");
  assert.equal(accept(one), "again", "the same sender, run, counter and epoch twice");
  assert.equal(
    accept({ ...one, epoch: epochOf(2), name: fill(7, 16) }),
    "first",
    "the counter is counted in each epoch",
  );
  assert.equal(accept({ ...one, counter: 2 }), "copy", "the same name, a copy built again");
  assert.equal(accept({ ...one, run: fill(7, 16), name: fill(8, 16) }), "first");
});
