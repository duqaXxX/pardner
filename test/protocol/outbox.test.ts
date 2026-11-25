/**
 * The outbox and the counters of a sender (security design 5.6, 5.7 and 5.12; crypto.md 1) on real
 * bytes. A test named after one of the model's ends with ` [model]`; where the model's test also
 * asserts that a prompt is shown or run once, that half is the reader's (the next pull request).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesEqual } from "../../src/protocol/bytes.ts";
import * as messages from "../../src/protocol/messages.ts";
import {
  decodeMessage,
  MAX_COUNTER,
  type Message,
  senderKey,
} from "../../src/protocol/messages.ts";
import * as outbox from "../../src/protocol/outbox.ts";
import {
  build as buildResult,
  dropStarts,
  type OutboxItem,
  queue,
  Run,
  readBack,
  rebuild,
} from "../../src/protocol/outbox.ts";
import { channel, epochOf, fill, keyOf, opened, Party, Sequence, SIGN } from "./sequence.ts";

/** `build` of a device whose key is in place: the item built, or "rollover". */
function build(...args: [Party["platform"], Run, OutboxItem, ReturnType<typeof at>]) {
  const built = buildResult(...args, SIGN);
  assert.ok(built.ok);
  return built.value;
}

const at = (epoch = epochOf(1), incarnation = fill(9, 16), sender = fill(3)) => ({
  channel,
  epoch,
  epochKey: keyOf(epoch),
  sender,
  incarnation,
});
/** The built message of an item, decoded. */
function built(item: OutboxItem | "rollover") {
  assert.notEqual(item, "rollover");
  const b = (item as OutboxItem).built;
  assert.ok(b);
  const m = decodeMessage(b.signed);
  assert.ok(m.ok);
  return { item: item as OutboxItem, message: m.value, bytes: b };
}

test("a queued message has a name of its own, and a file is sealed under a key of its own", () => {
  const p = new Party(fill(3));
  const first = p.say({ kind: 1, content: "a" });
  const second = p.say({
    kind: 2,
    to: fill(4),
    content: "b",
    files: [
      { bytes: Uint8Array.of(1, 2, 3), type: "image/png", name: "x.png" },
      { bytes: Uint8Array.of(1, 2, 3), type: "image/png", name: "y.png" },
    ],
  });
  assert.equal(first.name.length, 16);
  assert.ok(!bytesEqual(first.name, second.name));
  assert.equal(second.files.length, 2);
  assert.equal(second.files[0]?.size, 3);
  const [one, two] = second.files;
  assert.ok(one && two && !bytesEqual(one.key, two.key), "two files share a key");
  assert.ok(bytesEqual(one.id, p.platform.sha256(one.blob)));
  assert.equal(p.say({ kind: 1, content: "c", name: fill(8, 16) }).name[0], 8);
});

test("a built message opens under the epoch key, with the name, the incarnation and the files it was written with", () => {
  const p = new Party(fill(3));
  p.say({
    kind: 2,
    to: fill(4),
    content: "hello",
    files: [{ bytes: Uint8Array.of(9), type: "text/plain", name: "n.txt" }],
  });
  const { item, message } = built(
    build(p.platform, p.run, p.outbox[0] as OutboxItem, at(epochOf(1), fill(9, 16), p.id)),
  );
  const h = message.header;
  assert.ok(bytesEqual(h.name, item.name) && bytesEqual(h.incarnation, fill(9, 16)));
  assert.ok(bytesEqual(h.run, p.run.id) && h.counter === 1 && h.kind === 2);
  assert.deepEqual(h.blobs, [item.files[0]?.id]);
  const body = opened(p.platform, message);
  assert.equal(body.content, "hello");
  assert.equal(body.files[0]?.name, "n.txt");
  assert.ok(bytesEqual(body.files[0]?.fileKey as Uint8Array, item.files[0]?.key as Uint8Array));
});

test("a counter starts at 1 in each run and epoch, and a run id is new each time", () => {
  const p = new Party(fill(3));
  const counters = [epochOf(1), epochOf(1), epochOf(2), epochOf(1)].map(
    (e) =>
      built(build(p.platform, p.run, p.say({ kind: 1, content: "x" }), at(e))).message.header
        .counter,
  );
  assert.deepEqual(counters, [1, 2, 1, 3]);
  assert.ok(!bytesEqual(new Run(p.platform).id, new Run(p.platform).id));
});

test("never allowed 5: a device whose folder went back in time uses no sender key and counter twice [model]", () => {
  const p = new Party(fill(3));
  const copy = p.say({ kind: 1, content: "x" });
  const first = built(build(p.platform, p.run, copy, at())).message;
  const later = new Run(p.platform); // the folder went back: the same outbox, a run that starts again at 1
  const second = built(build(p.platform, later, copy, at())).message;
  assert.equal(first.header.counter, second.header.counter);
  const key = (m: typeof first) => senderKey(p.platform, keyOf(m.header.epoch), m.header);
  assert.ok(!bytesEqual(key(first), key(second)), "one sender key and one counter twice");
  assert.ok(bytesEqual(first.header.name, second.header.name));
});

test("5.7: a sender stops at 100,000 messages in an epoch and never wraps; the next epoch starts at 1", () => {
  const p = new Party(fill(3));
  for (let i = 1; i < MAX_COUNTER; i++) assert.equal(p.run.next(epochOf(1)), i);
  const item = p.say({ kind: 1, content: "x" });
  assert.equal(built(build(p.platform, p.run, item, at())).message.header.counter, MAX_COUNTER);
  assert.equal(
    build(p.platform, p.run, item, at()),
    "rollover" as unknown,
    "it sealed a second time",
  ); // item has no `built`
  assert.equal(p.run.next(epochOf(1)), undefined);
  assert.equal(p.run.next(epochOf(2)), 1);
});

test("a message sent again is the identical bytes, until its epoch ends", () => {
  const p = new Party(fill(3));
  const once = built(build(p.platform, p.run, p.say({ kind: 1, content: "x" }), at()));
  const twice = built(build(p.platform, p.run, once.item, at()));
  assert.ok(bytesEqual(once.bytes.signed, twice.bytes.signed));
  assert.ok(bytesEqual(once.bytes.signature, twice.bytes.signature));
  assert.equal(twice.message.header.counter, 1, "a copy is no new message: it took no counter");
  const later = built(build(p.platform, p.run, once.item, at(epochOf(2))));
  assert.ok(bytesEqual(once.bytes.signed, later.bytes.signed), "an epoch that ended is rebuild's");
});

test("5.12: a prompt sent again under its name after its epoch closed carries the same file [model]", () => {
  const p = new Party(fill(3));
  const item = p.say({
    kind: 2,
    to: fill(4),
    content: "see",
    files: [{ bytes: Uint8Array.of(5, 5), type: "image/png", name: "s.png" }],
  });
  const a = built(build(p.platform, p.run, item, at(epochOf(1))));
  const b = built(build(p.platform, p.run, rebuild(a.item), at(epochOf(2))));
  assert.ok(!bytesEqual(a.message.header.epoch, b.message.header.epoch));
  assert.ok(bytesEqual(a.message.header.name, b.message.header.name));
  assert.deepEqual(a.message.header.blobs, b.message.header.blobs);
  const [fa, fb] = [opened(p.platform, a.message).files[0], opened(p.platform, b.message).files[0]];
  assert.ok(fa && fb && bytesEqual(fa.fileKey, fb.fileKey) && fa.size === fb.size);
  assert.equal(b.message.header.counter, 1, "a new epoch counts from 1");
});

test("5.6, 5.8, R7: a prompt built before the relay was put back by hand keeps its incarnation when it is built again in a new epoch, and is not run again [model]", () => {
  const p = new Party(fill(3));
  const old = fill(1, 16);
  const a = built(
    build(p.platform, p.run, p.say({ kind: 2, to: fill(4), content: "p" }), at(epochOf(1), old)),
  );
  const b = built(build(p.platform, p.run, rebuild(a.item), at(epochOf(2), fill(2, 16))));
  assert.ok(bytesEqual(b.message.header.incarnation, old));
  const fresh = built(
    build(p.platform, p.run, p.say({ kind: 1, content: "q" }), at(epochOf(2), fill(2, 16))),
  );
  assert.ok(bytesEqual(fresh.message.header.incarnation, fill(2, 16)));
});

test("5.6: a device whose folder went back takes its message out of its outbox when it reads back the copy the relay holds, and sends no second one [model]", () => {
  const p = new Party(fill(3));
  p.say({ kind: 1, content: "a prompt written before the copy" });
  const copy = structuredClone(p.outbox); // the message is in the outbox, not built yet
  const seq = new Sequence();
  p.flush(seq, epochOf(1), fill(9, 16));
  p.outbox = copy; // the folder went back
  p.run = new Run(p.platform); // built again it would be another copy, under a new run
  p.outbox = readBack(p.outbox, p.id, (seq.items[0] as Message).header);
  assert.equal(p.outbox.length, 0);
  p.flush(seq, epochOf(1), fill(9, 16));
  assert.equal(seq.items.length, 1, "a second copy under the same name");
});

test("a message another device wrote takes nothing out of the outbox, and the outbox is not copied", () => {
  const p = new Party(fill(3));
  const other = new Party(fill(5));
  p.say({ kind: 1, content: "mine" });
  const seq = new Sequence();
  p.flush(seq, epochOf(1), fill(9, 16));
  const h = (seq.items[0] as Message).header;
  assert.equal(readBack(p.outbox, other.id, h), p.outbox);
  assert.equal(
    readBack(p.outbox, p.id, { ...h, name: fill(1, 16) }).length,
    1,
    "another name stays",
  );
  assert.equal(readBack(p.outbox, p.id, h).length, 0);
});

test("round 4, finding 1: a lost acknowledgement and a closed epoch do not run a prompt twice [model]", () => {
  const p = new Party(fill(3));
  p.say({ kind: 2, to: fill(4), content: "p" });
  const seq = new Sequence();
  p.flush(seq, epochOf(1), fill(9, 16)); // the relay takes it, the answer never comes back
  p.flush(seq, epochOf(1), fill(9, 16)); // sent again: the identical bytes
  assert.equal(seq.items.length, 1);
  p.outbox = p.outbox.map(rebuild); // another device closed the epoch
  p.flush(seq, epochOf(2), fill(2, 16));
  const [first, second] = seq.items as [Message, Message];
  assert.equal(seq.items.length, 2);
  assert.ok(bytesEqual(first.header.name, second.header.name));
  assert.ok(bytesEqual(first.header.incarnation, second.header.incarnation));
  assert.ok(!bytesEqual(first.header.epoch, second.header.epoch));
  assert.equal(readBack(p.outbox, p.id, first.header).length, 0, "either copy read back clears it");
});

test("section 3, 5.6: an app's folder put back from a copy sends a prompt again under its name: shown once, run once [model]", () => {
  const p = new Party(fill(3));
  p.say({ kind: 2, to: fill(4), content: "a prompt written before the copy" });
  const copy = structuredClone(p.outbox);
  const seq = new Sequence();
  p.flush(seq, epochOf(1), fill(9, 16));
  p.outbox = copy;
  p.run = new Run(p.platform);
  p.flush(seq, epochOf(1), fill(9, 16)); // before it has read anything
  const [first, second] = seq.items as [Message, Message];
  assert.equal(seq.items.length, 2, "the relay holds two copies");
  assert.ok(bytesEqual(first.header.name, second.header.name));
  assert.ok(!bytesEqual(first.header.run, second.header.run));
  assert.equal(readBack(p.outbox, p.id, first.header).length, 0);
});

test("section 3, 5.12: an app whose folder is put back from a copy sends its file again with its prompt: shown once, run once [model]", () => {
  const p = new Party(fill(3));
  p.say({
    kind: 2,
    to: fill(4),
    content: "see",
    files: [{ bytes: Uint8Array.of(5, 5), type: "image/png", name: "s.png" }],
  });
  const copy = structuredClone(p.outbox);
  const seq = new Sequence();
  p.flush(seq, epochOf(1), fill(9, 16));
  p.outbox = copy;
  p.run = new Run(p.platform);
  p.flush(seq, epochOf(1), fill(9, 16));
  const [a, b] = seq.items as [Message, Message];
  assert.deepEqual(a.header.blobs, b.header.blobs, "one blob, the same id");
  const [fa, fb] = [opened(p.platform, a).files[0], opened(p.platform, b).files[0]];
  assert.ok(fa && fb && bytesEqual(fa.fileKey, fb.fileKey));
  const file = (p.outbox[0] as OutboxItem).files[0];
  assert.ok(file && bytesEqual(p.platform.sha256(file.blob), file.id), "the outbox kept the blob");
});

test("a draft 6.4's table refuses, or a name that is not 16 bytes, is refused when queued", () => {
  const p = new Party(fill(3));
  const refused = (d: Parameters<typeof queue>[2]) => {
    const r = queue(p.platform, [], d);
    assert.equal(r.ok, false);
  };
  refused({ kind: 99, content: "x" });
  refused({ kind: 2, content: "a prompt has a bot to go to" });
  refused({ kind: 1, to: fill(4), content: "a text has none" });
  refused({ kind: 1, content: "x", name: fill(1, 15) });
  // Lengths the encoder refuses too, so that no counter is taken for an item that never builds.
  refused({ kind: 2, to: fill(4, 31), content: "a bot id is 32 bytes" });
  refused({ kind: 5, re: { device: fill(4, 31), name: fill(5, 16) }, content: "x" });
  refused({ kind: 5, re: { device: fill(4), name: fill(5, 15) }, content: "x" });
  assert.equal(queue(p.platform, [], { kind: 1, content: "x" }).ok, true);
  assert.equal(
    queue(p.platform, [], { kind: 5, re: { device: fill(4), name: fill(5, 16) }, content: "x" }).ok,
    true,
  );
});

test("a missing signing key is a result, and takes no counter", () => {
  const p = new Party(fill(3));
  const item = p.say({ kind: 1, content: "x" });
  const r = buildResult(p.platform, p.run, item, at(), "no.such.key");
  assert.equal(r.ok, false);
  assert.equal(p.run.next(epochOf(1)), 1);
});

test("a named kind for a start sits beside the table", () => {
  assert.equal((messages as Record<string, unknown>).KIND_START, 3);
  assert.equal(typeof (outbox as Record<string, unknown>).queue, "function");
});

test("a named kind for a build sits beside the start's", () => {
  assert.equal((messages as Record<string, unknown>).KIND_BUILD, 12);
});

test("R9: an answer the bot had not sent yet survives its restart [model]", () => {
  const p = new Party(fill(3));
  p.say({ kind: 5, re: { device: fill(4), name: fill(1, 16) }, content: "answer" });
  p.say({ kind: 3, re: { device: fill(4), name: fill(1, 16) }, content: "{}" });
  const kept = dropStarts(p.outbox);
  assert.deepEqual(
    kept.map((i) => i.kind),
    [5],
  );
});

test("G 3.5: an item queued once is appended later as it is, and a blob accepted in this process is not put again", () => {
  const p = new Party(fill(3));
  const queued = p.say({
    kind: 2,
    to: fill(4),
    content: "b",
    files: [
      { bytes: Uint8Array.of(1, 2, 3), type: "image/png", name: "x.png" },
      { bytes: Uint8Array.of(4, 5, 6), type: "image/png", name: "y.png" },
    ],
  });
  const other = p.say({ kind: 1, content: "a" });
  const kept = outbox.append([other], queued);
  assert.equal(kept[1], queued, "the same item, sealed once");
  assert.equal(outbox.toPut(queued).length, 2);
  const [one, two] = queued.files;
  assert.ok(one && two);
  const first = outbox.putAccepted(queued, one.id);
  assert.deepEqual(
    outbox.toPut(first).map((f) => f.name),
    ["y.png"],
  );
  assert.ok(
    bytesEqual((first.files[0] as { blob: Uint8Array }).blob, one.blob),
    "the blob is not sealed again",
  );
  assert.equal(outbox.toPut(outbox.putAccepted(first, two.id)).length, 0);
  assert.equal(
    outbox.toPut(outbox.putAgain(outbox.putAccepted(first, two.id))).length,
    2,
    "a `missing` puts both again",
  );
  assert.equal(outbox.toPut(rebuild(first)).length, 1, "a rebuilt item keeps what the relay holds");
  assert.equal(outbox.toPut(queued).length, 2, "the item itself is not changed");
});
