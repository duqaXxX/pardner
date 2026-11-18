/**
 * The device's reading (relay continuity design 4, security design 5.10), on real bytes and a
 * relay reduced to its frames. A test named after one of the model's ends with ` [model]`; the
 * same rules are driven against the relay's own process in `reading-relay.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BotReader } from "../../src/protocol/bot-reader.ts";
import { recipientsOf } from "../../src/protocol/device-log.ts";
import { sealEpochKey } from "../../src/protocol/epochs.ts";
import { Run } from "../../src/protocol/outbox.ts";
import { openAt, Reading } from "../../src/protocol/reading.ts";
import { platform } from "../relay/support.ts";
import { fill, keyed, person } from "../relay/world.ts";
import { historySeal, kinds, play, prompt, scene, Wire } from "./reading-world.ts";

/** A reading that has been served by `wire` and has read it to the end. */
function read(s = scene()) {
  const r = new Reading(s.who);
  const outs = play(r, [s.wire.served(), ...s.wire.read()]);
  return { s, r, outs };
}

test("a read folds the logs, gives each message at its place with the epoch key, and rests at the head", () => {
  const s = scene();
  const epoch = s.epoch();
  const p = prompt(s, epoch);
  s.wire.put(4, p);
  const r = new Reading(s.who);
  const outs = play(r, [s.wire.served(), ...s.wire.read()]);
  assert.deepEqual(kinds(outs), ["incarnation", "read", "message", "rest"]);
  const message = outs.find((o) => o.do === "message");
  assert.ok(message?.do === "message");
  assert.deepEqual(message.place.key, epoch.key);
  assert.equal(message.place.member, true);
  assert.deepEqual(message.place.epoch, epoch.id);
  assert.equal(message.place.length, 2, "alice's log holds her genesis and the bot's add");
  assert.deepEqual(outs.at(-1), { do: "rest", first: true });
  assert.equal(r.state, "rest");
  assert.equal(r.sendable, true);
  assert.equal(r.kept.ids.length, s.wire.items.length);
  assert.equal(r.kept.head?.head.n, s.wire.items.length);
  const view = r.channel(s.channel);
  assert.equal(view?.open, true);
  assert.deepEqual(view?.key, epoch.key);
  assert.deepEqual(r.channels(), [s.channel]);
  // The place carries what BotReader needs: it asks for the start of a prompt of this incarnation.
  const bot = new BotReader(platform, s.bot.id, s.wire.incarnation, new Run(platform));
  const step = bot.read(message.message, message.place, () => "gone");
  assert.deepEqual(
    step.notices.map((n) => n.kind),
    [3],
  );
});

test("the model's open(): an epoch at the logs' lengths opens the channel, a device entry after it closes it, and a new epoch opens it again", () => {
  const s = scene();
  s.epoch();
  assert.equal(read(s).r.channel(s.channel)?.open, true);
  s.entry(s.alice.add(s.log, keyed()));
  const closed = read(s).r.channel(s.channel);
  assert.equal(closed?.open, false);
  assert.equal(closed?.key !== undefined, true, "it still holds the key of its current epoch");
  s.epoch();
  assert.equal(read(s).r.channel(s.channel)?.open, true);
});

test("a channel with a create and no epoch is closed and has no key", () => {
  const view = read().r.channel(scene().channel);
  assert.equal(view, undefined, "another scene's channel");
  const s = scene();
  const v = read(s).r.channel(s.channel);
  assert.equal(v?.open, false);
  assert.equal(v?.key, undefined);
});

test("a message not accepted by the checkers reaches nobody: one in an epoch the log does not hold, and one seen before", () => {
  const s = scene();
  const epoch = s.epoch();
  s.wire.put(4, prompt(s, { id: fill(99), key: epoch.key }));
  s.wire.put(4, prompt(s, epoch));
  s.wire.put(4, prompt(s, epoch)); // the same sender, run and counter again: condition 4
  const outs = read(s).outs;
  assert.equal(outs.filter((o) => o.do === "message").length, 1);
});

test("a device log of another person, a bad entry, and an epoch entry no log supports each stop the reading with a fault", () => {
  const stranger = person();
  const s = scene();
  s.wire.items = [{ kind: 1, ...stranger.genesis }];
  const outs = read(s).outs;
  assert.deepEqual(outs.at(-1), { do: "fault", why: "not the person I was given" });
  const second = scene();
  second.wire.put(1, stranger.genesis); // a log of another person after the owner's
  assert.equal(read(second).r.state, "fault");
  const t = scene();
  const forged = t.alice.add(t.log, keyed());
  t.wire.put(1, { signed: forged.signed, sig: new Uint8Array(64) });
  assert.equal(read(t).r.state, "fault");
  const u = scene();
  const e = u.epoch();
  u.wire.items = u.wire.items.filter((i) => i.kind !== 2); // the member log is gone
  assert.equal(read(u).r.state, "fault");
  assert.ok(e);
  const r = read(t).r;
  assert.deepEqual(r.take(t.wire.served()), [], "a fault ends the reading");
});

test("an item at a position where the device holds another, or a relay that ends before what it read, is given back by the head it holds, and result 11 puts the relay back [model]", () => {
  // 5.10, 5.11: a device that read more than a relay put back by hand from a copy gives it back.
  const s = scene();
  s.epoch();
  const first = read(s);
  const kept = first.r.kept;
  const head = kept.head;
  assert.ok(head);
  const stored = structuredClone(kept);
  // The relay put back to before its last item, and another item takes that position.
  s.wire.items.pop();
  s.wire.put(4, prompt(s, { id: s.epochs.at(-1)?.id as Uint8Array, key: fill(1) }, fill(8, 16)));
  const r = new Reading(s.who, stored);
  const outs = play(r, [s.wire.served(), ...s.wire.read()]);
  assert.deepEqual(outs.at(-1), { do: "give-back", head: head.head, sig: head.sig });
  assert.equal(r.state, "giving-back");
  assert.equal(r.sendable, false);
  assert.deepEqual(r.gaveBack(11), [{ do: "put-back" }]);
  assert.equal(r.kept.putBack, true);
  assert.equal(r.state, "put-back");
  assert.deepEqual(play(r, [s.wire.served()]), [], "that relay is used no more");
});

test("a device that finds the relay behind what it read gives back before it writes, and shows what it had not sent as not delivered [model]", () => {
  const s = scene();
  s.epoch();
  s.wire.put(4, prompt(s, { id: s.epochs.at(-1)?.id as Uint8Array, key: fill(1) }));
  const r = read(s).r;
  assert.equal(r.sendable, true);
  s.wire.items.pop(); // the relay is put back to before the last item
  r.dropped();
  const outs = play(r, [s.wire.served(), ...s.wire.read(r.cursor)]);
  assert.deepEqual(kinds(outs), ["incarnation", "read", "give-back"]);
  assert.equal(r.sendable, false, "it sends nothing while giving back");
  assert.deepEqual(r.gaveBack(11), [{ do: "put-back" }]);
});

test("a relay behind, where an item sent again lands at the position it had and another at the one after, is given back [model]", () => {
  // R1-B: the item at the position differs by one of the two positions it read.
  const s = scene();
  const epoch = s.epoch();
  const p = prompt(s, epoch, fill(8, 16));
  const q = prompt(s, epoch, fill(9, 16), 2);
  s.wire.put(4, p);
  s.wire.put(4, q);
  const stored = structuredClone(read(s).r.kept);
  s.wire.items.splice(-2); // back to the copy
  s.wire.put(4, prompt(s, epoch, fill(10, 16), 3)); // another takes P's position
  s.wire.put(4, p); // P's bytes take the next one
  const r = new Reading(s.who, stored);
  const outs = play(r, [s.wire.served(), ...s.wire.read()]);
  assert.equal(outs.at(-1)?.do, "give-back");
  assert.equal(r.state, "giving-back");
  assert.equal(r.kept.ids.length, stored.ids.length, "what it read is kept");
});

test("a result 0 means the relay holds the head: the difference lies past it and the device fails closed for itself; no answer reads again; no head puts back at once", () => {
  const behind = () => {
    const s = scene();
    s.epoch();
    s.wire.put(4, prompt(s, { id: s.epochs.at(-1)?.id as Uint8Array, key: fill(1) }));
    const stored = structuredClone(read(s).r.kept);
    s.wire.items.pop();
    return { s, stored };
  };
  const { s, stored } = behind();
  const r = new Reading(s.who, stored);
  play(r, [s.wire.served(), ...s.wire.read()]);
  assert.deepEqual(r.gaveBack(0), [{ do: "put-back" }], "L9");
  assert.equal(r.kept.putBack, true);

  const t = behind();
  const again = new Reading(t.s.who, t.stored);
  play(again, [t.s.wire.served(), ...t.s.wire.read()]);
  assert.deepEqual(again.gaveBack(undefined), [], "no answer");
  assert.equal(again.state, "reading");
  assert.equal(again.kept.putBack, false);
  again.dropped();
  const outs = play(again, [t.s.wire.served(), ...t.s.wire.read()]);
  assert.equal(
    outs.at(-1)?.do,
    "give-back",
    "the next read finds it again, so the give-back is owed",
  );

  const none = behind();
  const bare = new Reading(none.s.who, { ...none.stored, head: undefined });
  const gone = play(bare, [none.s.wire.served(), ...none.s.wire.read()]);
  assert.deepEqual(gone.at(-1), { do: "put-back" }, "L9: no head, no proof");
});

test("a device gives back only the head the relay signed: a head with a signature the relay did not make, or under another key, is never kept [model]", () => {
  const s = scene();
  const forged = s.wire.head();
  const r = new Reading(s.who);
  const outs = play(r, [
    s.wire.served(),
    ...s.wire.read().slice(0, -1),
    { ...forged, sig: new Uint8Array(64).fill(9) },
  ]);
  assert.deepEqual(outs.at(-1), { do: "fault", why: "a head the relay did not sign" });
  assert.equal(r.kept.head, undefined);
  // Under a key of a stranger's own.
  const stranger = new Wire();
  stranger.items = s.wire.items;
  const t = new Reading(s.who);
  play(t, [s.wire.served(), ...stranger.read()]);
  assert.equal(t.kept.head, undefined);
  assert.equal(t.state, "fault");
  // A head the relay signed whose running hash is not the one of the items it gave.
  const u = new Reading(s.who);
  const frames = s.wire.read();
  const lie = s.wire.head(s.wire.items.length, new Uint8Array(32).fill(5));
  const bad = play(u, [s.wire.served(), ...frames.slice(0, -1), lie]);
  assert.deepEqual(bad.at(-1), {
    do: "fault",
    why: "a head that is not the running hash of the items given",
  });
  assert.equal(u.kept.head, undefined);
});

test("a device sends nothing it built before it has read under the relay's incarnation [model]", () => {
  const s = scene();
  s.epoch();
  const r = read(s).r;
  assert.equal(r.sendable, true);
  r.dropped();
  s.wire.incarnation = fill(8, 16); // the relay started again
  const served = r.take(s.wire.served());
  assert.deepEqual(
    served.map((o) => o.do),
    ["incarnation", "read"],
  );
  assert.equal(served[0]?.do === "incarnation" && served[0].first, false);
  assert.equal(served[1]?.do === "read" && served[1].from, 0, "read again from the start");
  assert.equal(r.sendable, false, "not before a pass reaches the head");
  const items = s.wire.read();
  play(r, items.slice(0, -2));
  assert.equal(r.sendable, false);
  const rest = play(r, items.slice(-2));
  assert.deepEqual(rest.at(-1), { do: "rest", first: true });
  assert.equal(r.sendable, true);
});

test("under a new incarnation a prompt is given again to the caller, and under the same one after a drop it is not", () => {
  const s = scene();
  const epoch = s.epoch();
  s.wire.put(4, prompt(s, epoch));
  const r = read(s).r;
  r.dropped();
  const same = play(r, [s.wire.served(), ...s.wire.read(r.cursor)]);
  assert.equal(same.filter((o) => o.do === "message").length, 0);
  s.wire.incarnation = fill(9, 16);
  r.dropped();
  const again = play(r, [s.wire.served(), ...s.wire.read(0)]);
  assert.equal(again.filter((o) => o.do === "message").length, 1, "a new seen-set");
});

test("a refusal: removed or not known gives the head back once, then says so; with no head it says so at once; 6 puts the relay back", () => {
  const s = scene();
  const r = read(s).r;
  r.dropped();
  const gave = r.take({ type: "refused", reason: 1 });
  assert.deepEqual(kinds(gave), ["give-back"]);
  assert.equal(r.state, "giving-back");
  assert.deepEqual(r.gaveBack(0), [{ do: "refused", reason: 1 }]);
  assert.equal(r.state, "refused");
  assert.deepEqual(r.take({ type: "refused", reason: 1 }), [{ do: "refused", reason: 1 }], "once");
  assert.deepEqual(kinds(r.take(s.wire.served())), ["incarnation", "read"]);
  assert.equal(r.state, "reading", "served again");
  // Not known, no answer to the give-back: still not known.
  const t = read(s).r;
  t.dropped();
  t.take({ type: "refused", reason: 2 });
  assert.deepEqual(t.gaveBack(undefined), [{ do: "refused", reason: 2 }]);
  // No answer: the give-back is owed, so the next refusal gives it again [model sync, gaveBack per sync].
  assert.deepEqual(kinds(t.take({ type: "refused", reason: 2 })), ["give-back"]);
  // A give-back that was answered is not given twice on the next refusal of the same series.
  assert.deepEqual(t.gaveBack(0), [{ do: "refused", reason: 2 }]);
  assert.deepEqual(t.take({ type: "refused", reason: 2 }), [{ do: "refused", reason: 2 }]);
  // Not known and no head held: nothing to give.
  const fresh = new Reading(s.who);
  assert.deepEqual(fresh.take({ type: "refused", reason: 2 }), [{ do: "refused", reason: 2 }]);
  assert.deepEqual(fresh.take({ type: "refused", reason: 3 }), [{ do: "refused", reason: 3 }]);
  assert.deepEqual(fresh.take({ type: "refused", reason: 6 }), [{ do: "put-back" }]);
  assert.equal(fresh.kept.putBack, true);
  // A put-back that was stored stays: a new reading on the same store uses that relay no more.
  assert.equal(new Reading(s.who, fresh.kept).state, "put-back");
});

test("a result 11 answers a give-back made on a refusal too: the relay is put back", () => {
  const s = scene();
  const r = read(s).r;
  r.dropped();
  r.take({ type: "refused", reason: 1 });
  assert.deepEqual(r.gaveBack(11), [{ do: "put-back" }]);
});

test("RD 6.3, M3: a push is taken as a read's answer is: its items go in order, and it moves the head [model]", () => {
  const s = scene();
  const epoch = s.epoch();
  const r = read(s).r;
  const before = s.wire.items.length;
  s.wire.put(4, prompt(s, epoch));
  const outs = play(r, s.wire.push(before));
  assert.deepEqual(kinds(outs), ["message", "rest"]);
  assert.deepEqual(outs.at(-1), { do: "rest", first: false });
  assert.equal(r.cursor, s.wire.items.length);
  assert.equal(r.kept.head?.head.n, s.wire.items.length);
});

test("RD 6.3, M3: while a push is read the device is not at rest, and seals come before the items of a push [model]", () => {
  const s = scene();
  const epoch = s.epoch();
  const r = read(s).r;
  const at = s.wire.items.length;
  s.wire.put(4, prompt(s, epoch));
  const [item] = s.wire.push(at);
  assert.ok(item);
  r.take(item);
  assert.equal(r.state, "reading");
  assert.equal(r.sendable, false);
});

test("RD 6.3, M3: a push that arrives after the device read further is compared, not taken again: its cursor and its head stay [model]", () => {
  const s = scene();
  const epoch = s.epoch();
  const r = read(s).r;
  const at = s.wire.items.length;
  s.wire.put(4, prompt(s, epoch, fill(8, 16)));
  s.wire.put(4, prompt(s, epoch, fill(9, 16), 2));
  const old = s.wire.push(at, at + 1); // the push that owed the first
  play(r, s.wire.push(at)); // a later read reaches both
  const cursor = r.cursor;
  const head = r.kept.head;
  const record = [...r.kept.ids];
  const outs = play(r, old);
  assert.equal(r.cursor, cursor, "no item taken twice");
  assert.deepEqual(r.kept.head, head, "the head of an older push does not lower it");
  assert.deepEqual(r.kept.ids, record);
  assert.deepEqual(outs, []);
  assert.equal(r.state, "rest", "it does not leave rest for what it already read");
});

test("RD 6.3, M3: a push that differs from what the device read at a position is given back, and what the device read is kept [model]", () => {
  const s = scene();
  const epoch = s.epoch();
  s.wire.put(4, prompt(s, epoch));
  const r = read(s).r;
  const record = [...r.kept.ids];
  const last = s.wire.items.length - 1;
  const lie = {
    type: "item" as const,
    position: last,
    kind: 4 as const,
    ...prompt(s, epoch, fill(77, 16)),
  };
  const outs = r.take(lie);
  assert.deepEqual(kinds(outs), ["give-back"]);
  assert.deepEqual(r.kept.ids, record);
  assert.equal(r.kept.putBack, false);
});

test("RD 6.3, M3: a push that would leave a gap is left to a read, once, and an item is never skipped [model]", () => {
  const s = scene();
  const epoch = s.epoch();
  const r = read(s).r;
  const at = s.wire.items.length;
  s.wire.put(4, prompt(s, epoch, fill(8, 16)));
  s.wire.put(4, prompt(s, epoch, fill(9, 16), 2));
  const [, second, head] = s.wire.push(at);
  assert.ok(second && head);
  const cursor = r.cursor;
  assert.deepEqual(r.take(second), [{ do: "read", from: cursor }]);
  assert.deepEqual(r.take(head), [], "asked once");
  assert.equal(r.cursor, cursor);
  assert.equal(r.kept.ids[cursor], undefined);
  // The read the caller sent answers: nothing was lost.
  const outs = play(r, s.wire.read(cursor));
  assert.equal(outs.filter((o) => o.do === "message").length, 2);
  assert.equal(r.cursor, s.wire.items.length);
});

test("RD 6.3, 6.5, M3: a relay that fails closed mid-follow pushes nothing more, and the device says the relay was put back [model]", () => {
  const s = scene();
  const epoch = s.epoch();
  const r = read(s).r;
  assert.deepEqual(r.take({ type: "refused", reason: 6 }), [{ do: "put-back" }]);
  s.wire.put(4, prompt(s, epoch));
  assert.deepEqual(play(r, s.wire.push(s.wire.items.length - 1)), []);
  assert.equal(r.kept.putBack, true);
});

test("RD 6.3, M3: a device removed in a round is pushed removed, not the message: it gives back, and shows removed [model]", () => {
  const s = scene();
  const epoch = s.epoch();
  const r = read(s).r;
  s.wire.put(4, prompt(s, epoch));
  const outs = r.take({ type: "refused", reason: 1 });
  assert.deepEqual(kinds(outs), ["give-back"]);
  assert.equal(r.cursor, s.wire.items.length - 1, "the message was not taken");
  assert.deepEqual(r.gaveBack(0), [{ do: "refused", reason: 1 }]);
});

test("a key reaches the device by a history seal that comes before the epoch's entry; none when it fails the commitment and no seal is given", () => {
  const s = scene();
  // Every seal in the entry is of another key: it fails the commitment, whoever opens it.
  const wrong = platform.random(32);
  const seals = recipientsOf(platform, s.log).map((r) => {
    const sealed = sealEpochKey(platform, s.channel, undefined, r.id, r.receiving, wrong);
    assert.ok(sealed.ok);
    return sealed.value;
  });
  const epoch = s.epoch({ seals });
  const held = s.epochs.at(-1);
  assert.ok(held);
  const without = new Reading(s.who);
  play(without, [s.wire.served(), ...s.wire.read()]);
  assert.equal(without.channel(s.channel)?.key, undefined, "its own seal fails the commitment");
  s.wire.seals = [historySeal(held, s.alice.first, s.bot, epoch.key)];
  const r = new Reading(s.who);
  play(r, [s.wire.served(), ...s.wire.read()]);
  assert.deepEqual(
    r.channel(s.channel)?.key,
    epoch.key,
    "the seals come before the items, and wait for the log",
  );
  // A seal made for another device opens nothing for this one.
  s.wire.seals = [historySeal(held, s.alice.first, keyed("bot"), epoch.key)];
  const t = new Reading(s.who);
  play(t, [s.wire.served(), ...s.wire.read()]);
  assert.equal(t.channel(s.channel)?.key, undefined);
});

test("an epoch at heads older than the log, placed after a removal, is not open, whatever order the relay placed it in [model open()]", () => {
  const s = scene();
  const x = keyed("app");
  s.entry(s.alice.add(s.log, x));
  const e = s.epoch(); // heads at the log's length then, sealed to x too
  s.entry(s.alice.remove(s.log, x));
  const items = s.wire.items;
  const n = items.length;
  [items[n - 2], items[n - 1]] = [items[n - 1] as never, items[n - 2] as never]; // the epoch lands after the removal
  const r = new Reading(s.who);
  play(r, [s.wire.served(), ...s.wire.read()]);
  const view = r.channel(s.channel);
  assert.deepEqual(view?.epochs.at(-1)?.id, e.id);
  assert.equal(view?.open, false, "no key of this epoch is used: x holds it");
});

test("a result 1 to a give-back is put back, as the model's sync does for any answer but accepted", () => {
  const s = scene();
  s.epoch();
  const r = new Reading(s.who, structuredClone(read(s).r.kept));
  s.wire.items.pop();
  play(r, [s.wire.served(), ...s.wire.read()]);
  assert.deepEqual(r.gaveBack(1), [{ do: "put-back" }]);
});

test("a reconnection under the same incarnation is not a first pass; a new incarnation is", () => {
  const s = scene();
  s.epoch();
  const r = read(s).r;
  r.dropped();
  const same = play(r, [s.wire.served(), ...s.wire.read(r.cursor)]);
  assert.deepEqual(same.at(-1), { do: "rest", first: false });
  s.wire.incarnation = fill(9, 16);
  r.dropped();
  const next = play(r, [s.wire.served(), ...s.wire.read(0)]);
  assert.deepEqual(next.at(-1), { do: "rest", first: true });
});

test("nothing is taken before served or after the connection dropped", () => {
  const s = scene();
  const epoch = s.epoch();
  const r = new Reading(s.who);
  assert.deepEqual(play(r, s.wire.read()), [], "no served yet");
  assert.equal(r.cursor, 0);
  play(r, [s.wire.served(), ...s.wire.read()]);
  r.dropped();
  s.wire.put(4, prompt(s, epoch));
  assert.deepEqual(play(r, s.wire.push(s.wire.items.length - 1)), []);
});

test("a history seal of an earlier read is not kept for a later one: a new read has the relay's list as it stands", () => {
  const s = scene();
  const wrong = platform.random(32);
  const seals = recipientsOf(platform, s.log).map((x) => {
    const sealed = sealEpochKey(platform, s.channel, undefined, x.id, x.receiving, wrong);
    assert.ok(sealed.ok);
    return sealed.value;
  });
  const epoch = s.epoch({ seals });
  s.wire.seals = [historySeal(s.epochs.at(-1) as never, s.alice.first, s.bot, epoch.key)];
  const r = new Reading(s.who);
  play(r, [s.wire.served(), ...s.wire.read()]);
  assert.deepEqual(r.channel(s.channel)?.key, epoch.key);
  r.dropped();
  s.wire.incarnation = fill(9, 16);
  s.wire.seals = [];
  play(r, [s.wire.served(), ...s.wire.read(0)]);
  assert.equal(r.channel(s.channel)?.key, undefined, "the stale seal is gone");
});

test("a refusal's give-back that ends with no answer through dropped() is owed at the next refusal", () => {
  const s = scene();
  s.epoch();
  const r = read(s).r;
  r.dropped();
  assert.deepEqual(kinds(r.take({ type: "refused", reason: 2 })), ["give-back"]);
  r.dropped();
  assert.deepEqual(kinds(r.take({ type: "refused", reason: 2 })), ["give-back"]);
});

test("openAt: the epoch's device heads are the log's length and no member-set change follows its member head (design 3.4) [model]", () => {
  const epoch = (memberHead: number, ...devices: number[]) =>
    ({
      id: fill(1),
      entry: {
        memberHead: { length: memberHead },
        deviceHeads: devices.map((length) => ({ length })),
      },
    }) as never;
  const members = (...changes: boolean[]) =>
    changes.map((changesMembers) => ({ changesMembers })) as never;
  assert.equal(openAt(undefined, members(false), 3), false, "no epoch");
  assert.equal(openAt(epoch(1, 3), members(false), 3), true);
  assert.equal(openAt(epoch(1, 2), members(false), 3), false, "a device entry after the heads");
  assert.equal(openAt(epoch(1, 3, 2), members(false), 3), false, "one member's head behind");
  assert.equal(openAt(epoch(1, 3), members(false, false), 3), true, "a change that adds no member");
  assert.equal(
    openAt(epoch(1, 3), members(false, true), 3),
    false,
    "a change of the member set after the head",
  );
  assert.equal(
    openAt(epoch(2, 3), members(false, true), 3),
    true,
    "a change the epoch already counted",
  );
});
