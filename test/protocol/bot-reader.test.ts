/**
 * What a bot acts on (security design 5.8, with 5.6 and 5.12) on real bytes: sealed and signed
 * messages in a sequence that devices write and a bot reads in order. A test named after one of the
 * model's ends with ` [model]`; the others hold a sentence of 5.8 or a decision the model does not
 * state.
 *
 * Carried in step 3 (the relay and the scripted device), since they need a relay: the fail-closed
 * tests of R7 and R4-D, the model's tests of a relay restored or lost (5.10, 5.11), the relay's
 * blob duties (5.12 points 3, 5, 8), and the random runs. Their reader halves are here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BotReader, type Place } from "../../src/protocol/bot-reader.ts";
import { bytesEqual } from "../../src/protocol/bytes.ts";
import type { LoggedEntry } from "../../src/protocol/device-log.ts";
import { promptState, refKey, Seen } from "../../src/protocol/device-reader.ts";
import { cutName, type Message, unreadName } from "../../src/protocol/messages.ts";
import type { OutboxItem } from "../../src/protocol/outbox.ts";
import { Run, rebuild } from "../../src/protocol/outbox.ts";
import { Bot, hex } from "./bot.ts";
import { epochOf, fill, Party, Sequence } from "./sequence.ts";

const inc = fill(9, 16);
const E1 = epochOf(1);
const kinds = (seq: Sequence) => seq.items.map((m) => m.header.kind);
const ref = (app: Party, prompt: OutboxItem) => ({ device: app.id, name: prompt.name });
function world() {
  const app = new Party();
  const bot = new Bot(inc).owns(app);
  return { app, bot, seq: new Sequence() };
}
/** The devices write and read until nothing is left to send, as the relay and a connection would. */
function settle(seq: Sequence, app: Party, ...bots: Bot[]) {
  for (let i = 0; i < 4; i++) {
    app.flush(seq, E1, inc);
    for (const b of bots) {
      b.read(seq);
      b.flush(seq, E1, b.incarnation);
    }
  }
  for (const b of bots) b.read(seq);
}
const states = (seq: Sequence, prompt: Message, active = true) =>
  promptState(seq.items, prompt, active);

test("a prompt is run once, and the bot's start and answer are in the sequence", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p1" });
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["p1"]);
  assert.deepEqual(kinds(seq), [2, 3, 5]);
  assert.equal(states(seq, seq.items[0] as Message), "answered");
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["p1"]);
});

test("5.8 condition 4: a prompt addressed to one bot is not run by another bot of the owner [model]", () => {
  const { app, bot, seq } = world();
  const other = new Bot(inc).owns(app);
  app.say({ kind: 2, to: bot.id, content: "p" });
  app.say({ kind: 2, to: other.id, content: "q" });
  settle(seq, app, bot, other);
  assert.deepEqual([bot.ran, other.ran], [["p"], ["q"]]);
  assert.equal(kinds(seq).filter((k) => k === 5).length, 2);
});

test("5.8 condition 2: a bot does not run a prompt of an ended epoch", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc);
  bot.place = { ...bot.place, epoch: epochOf(2) };
  bot.read(seq);
  bot.flush(seq, E1, inc);
  assert.deepEqual([bot.ran, kinds(seq), bot.outbox.length], [[], [2], 0]);
});

test("5.8 condition 3: a bot does not run a prompt from a device its owner's log does not show active, whoever's app it is", () => {
  const { app, bot, seq } = world();
  const second = new Party(); // another person's app, active in its own log
  second.say({ kind: 2, to: bot.id, content: "from the second person" });
  second.flush(seq, E1, inc);
  bot.read(seq);
  bot.flush(seq, E1, inc);
  assert.deepEqual([bot.ran, kinds(seq), bot.outbox.length], [[], [2], 0], "no notice either");
  app.say({ kind: 2, to: bot.id, content: "p" });
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["p"]);
});

test("5.8 conditions 2 and 3: a bot does not run a prompt of an ended epoch, nor one from a device its log shows as removed [model]", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc);
  const prompt = seq.items[0] as Message;
  const [genesis, added] = bot.place.log as [LoggedEntry, LoggedEntry];
  // An entry that removes the app, after the bot was added; the reader only reads whom it shows active.
  const removal = {
    id: fill(77),
    entry: { kind: "remove", device: app.id },
  } as unknown as LoggedEntry;
  const kinds = (place: Place) =>
    new BotReader(bot.platform, bot.id, inc, new Run(bot.platform))
      .read(prompt, place, bot.fetch)
      .notices.map((n) => n.kind);
  const at = (length: number, epoch = E1): Place => ({
    ...bot.place,
    epoch,
    log: [genesis, added, removal],
    length,
  });
  assert.deepEqual(kinds(at(2)), [3], "active before the removal");
  assert.deepEqual(kinds(at(3)), [], "removed at this position");
  assert.deepEqual(kinds(at(0)), [], "nothing read yet: no one is active");
  assert.deepEqual(kinds(at(2, epochOf(2))), [], "an epoch that is not the current one");
});

test("5.8, invariant 1: a bot reads no prompt against a device log that does not name it", () => {
  const { bot, seq } = world();
  const other = new Party(); // another person: an app and a bot of its own
  const theirs = new Bot(inc).owns(other);
  other.say({ kind: 2, to: bot.id, content: "from another person" });
  other.flush(seq, E1, inc);
  bot.place = { ...bot.place, log: theirs.place.log, length: 2 }; // their log: the app is active in it
  bot.read(seq);
  bot.flush(seq, E1, inc);
  assert.deepEqual([bot.ran, kinds(seq), bot.outbox.length], [[], [2], 0]);
});

test("5.8: a prompt in an epoch whose key the bot was not given is said by the bot as not read, and is never run later [model]", () => {
  const { app, bot, seq } = world();
  const p = app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc);
  const place = bot.place;
  bot.place = { ...place, key: undefined };
  bot.read(seq);
  assert.deepEqual(bot.ran, []);
  const said = bot.outbox[0];
  assert.equal(said?.kind, 7);
  assert.ok(said && hex(said.name) === hex(unreadName(bot.platform, ref(app, p))));
  bot.place = place; // the key arrives
  bot.restart();
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, []);
  assert.equal(states(seq, seq.items[0] as Message), "unread");
  assert.equal(kinds(seq).filter((k) => k === 7).length, 1, "said once");
});

test("5.8 condition 2: a prompt of an epoch its bot is not a recipient of, which a device sends again after a re-base, is said not read [model]", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc);
  app.outbox = app.outbox.map(rebuild); // a re-base: a new epoch the bot is not yet a recipient of
  app.flush(seq, epochOf(2), inc);
  bot.place = { ...bot.place, epoch: epochOf(2), member: false };
  bot.read(seq);
  assert.deepEqual([bot.ran, bot.outbox.map((i) => i.kind)], [[], [7]]);
});

test("5.8 condition 5: a bot acts only once it has read its own start back [model]", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc);
  bot.read(seq);
  assert.deepEqual([bot.ran, bot.outbox.map((i) => i.kind)], [[], [3]]);
  bot.flush(seq, E1, inc);
  bot.read(seq);
  assert.deepEqual(bot.ran, ["p"]);
});

test("5.8: a start of another bot's does not start the bot's run", () => {
  const { app, bot, seq } = world();
  const stranger = new Party(fill(5));
  const p = app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc);
  stranger.say({ kind: 3, re: ref(app, p), content: "{}" });
  stranger.flush(seq, E1, inc);
  bot.read(seq);
  assert.deepEqual(bot.ran, []);
});

test("5.8 condition 5: a start of an earlier run in the sequence means that run was cut, and the prompt is not run [model]", () => {
  const { app, bot, seq } = world();
  const p = app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc);
  bot.read(seq);
  bot.flush(seq, E1, inc); // its start is in the sequence
  bot.restart(); // before it read the start back
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, []);
  assert.deepEqual(kinds(seq).sort(), [2, 3, 3, 6]);
  assert.equal(states(seq, seq.items[0] as Message), "cut");
  assert.ok(seq.items.some((m) => hex(m.header.name) === hex(cutName(bot.platform, ref(app, p)))));
});

test("5.8 condition 5: a bot that restarts before its start reached the relay still runs the prompt [model]", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc);
  bot.read(seq); // the start is in the outbox only
  bot.restart();
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["p"]);
  assert.deepEqual(kinds(seq), [2, 3, 5]);
});

test("5.8: a crash between the start and the act cuts the run, and no run again of the prompt [model]", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  bot.crashAfterStart = true;
  settle(seq, app, bot);
  bot.crashAfterStart = false;
  assert.deepEqual(bot.ran, []);
  assert.ok([...bot.reader.decided.values()].includes("cut"));
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, []);
  assert.equal(states(seq, seq.items[0] as Message), "cut");
});

test("5.8 condition 5: every device shows a cut prompt as cut, and an answer in the sequence wins over it [model]", () => {
  const { app, bot, seq } = world();
  const p = app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc);
  const prompt = seq.items[0] as Message;
  bot.say({ kind: 6, re: ref(app, p), content: "{}", name: cutName(bot.platform, ref(app, p)) });
  bot.flush(seq, E1, inc);
  assert.equal(states(seq, prompt), "cut");
  bot.say({ kind: 5, re: ref(app, p), content: "late answer" });
  bot.flush(seq, E1, inc);
  assert.equal(states(seq, prompt), "answered");
});

test("5.8: a prompt its bot ran before being removed, the answer unsent, is shown as not answered, which does not say it was not run [model]", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc);
  bot.read(seq);
  bot.flush(seq, E1, inc);
  bot.read(seq); // it runs the prompt; the answer waits in its outbox
  assert.deepEqual([bot.ran, kinds(seq)], [["p"], [2, 3]]);
  assert.equal(states(seq, seq.items[0] as Message, false), "removed");
});

test("5.8: a removed bot with no answer shows the prompt as not answered, whatever notice it said", () => {
  const { app, bot, seq } = world();
  const p = app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc);
  bot.say({ kind: 6, re: ref(app, p), content: "{}", name: cutName(bot.platform, ref(app, p)) });
  bot.say({ kind: 7, re: ref(app, p), content: "{}", name: unreadName(bot.platform, ref(app, p)) });
  bot.flush(seq, E1, inc);
  assert.equal(states(seq, seq.items[0] as Message, false), "removed");
  assert.equal(states(seq, seq.items[0] as Message, true), "cut");
});

test("5.8: a prompt whose bot is removed before answering is shown by every device as not answered [model]", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc);
  assert.equal(states(seq, seq.items[0] as Message, true), "open");
  assert.equal(states(seq, seq.items[0] as Message, false), "removed");
});

test("5.8: a prompt its bot ran before being removed, the answer sent, is shown as answered", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  settle(seq, app, bot);
  assert.equal(states(seq, seq.items[0] as Message, false), "answered");
});

test("5.8: an answer counts only from the bot its prompt is addressed to [model]", () => {
  const { app, bot, seq } = world();
  const stranger = new Party(fill(5));
  const p = app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc);
  stranger.say({ kind: 5, re: ref(app, p), content: "fake" });
  stranger.flush(seq, E1, inc);
  assert.equal(states(seq, seq.items[0] as Message), "open");
});

test("5.8: a notice that a prompt was not read counts only from the bot the prompt names [model]", () => {
  const { app, bot, seq } = world();
  const stranger = new Party(fill(5));
  const p = app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc);
  stranger.say({ kind: 7, re: ref(app, p), content: "{}" });
  stranger.say({ kind: 6, re: ref(app, p), content: "{}" });
  stranger.flush(seq, E1, inc);
  settle(seq, app, bot);
  assert.equal(states(seq, seq.items[0] as Message), "answered", "the bot ran it");
  assert.deepEqual(bot.ran, ["p"]);
});

test("section 3, 5.8: a bot's folder put back from a copy made before it ran a prompt does not run it again [model]", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["p"]);
  const back = new Bot(inc, new Map(), bot); // the folder before the run: nothing decided, nothing in its outbox
  back.place = bot.place;
  settle(seq, app, back);
  assert.deepEqual(back.ran, [], "the prompt ran twice");
  assert.equal(states(seq, seq.items[0] as Message), "answered");
});

test("5.8: a bot whose store went back says once that it does not run a prompt from before a restart of the relay [model]", () => {
  const { app, seq } = world();
  const later = fill(2, 16); // the relay's incarnation the bot reads under now
  const bot = new Bot(later).owns(app);
  const p = app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc); // built under the earlier incarnation
  bot.read(seq);
  assert.equal(bot.outbox.length, 0, "nothing is said before it has read to the end");
  const notice = bot.reader.caughtUp();
  assert.deepEqual(
    notice.map((n) => n.kind),
    [7],
  );
  assert.ok(hex(notice[0]?.name as Uint8Array) === hex(unreadName(bot.platform, ref(app, p))));
  assert.deepEqual(bot.reader.caughtUp(), []);
  bot.restart();
  bot.read(seq);
  assert.deepEqual(bot.reader.caughtUp(), [], "said again after a restart");
  assert.deepEqual(bot.ran, []);
});

test("5.8, 5.10: a relay put back while a bot holds a start it decided under the earlier incarnation does not run the prompt twice (review round 4, R4-A) [model]", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  const q = app.say({
    kind: 2,
    to: bot.id,
    content: "q",
    files: [{ bytes: Uint8Array.of(1), type: "t", name: "f" }],
  });
  const file = q.files[0];
  assert.ok(file);
  bot.blobs.set(hex(file.id), file.blob);
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["p", "q"]);
  const later = fill(2, 16);
  const copy = new Sequence(); // the relay's directory copy: P and Q only
  copy.items.push(...seq.items.slice(0, 2));
  // The bot's folder before P: nothing decided. It reads P under the first incarnation and queues
  // its start, then stops at Q, whose file does not come.
  const again = new Bot(inc, new Map(), bot).owns(app);
  again.blobs.set(hex(file.id), file.blob);
  again.fetch = () => "wait";
  again.read(seq);
  assert.deepEqual(
    again.outbox.map((i) => i.kind),
    [3],
  );
  // The relay is put back (P and Q kept, the start lost): a new incarnation, read from the start.
  again.reader.newIncarnation(later);
  again.incarnation = later;
  again.fetch = (id) => again.blobs.get(hex(id)) ?? "gone";
  again.seen = new Seen();
  again.cursor = 0;
  again.read(copy);
  for (const n of again.reader.caughtUp()) again.say({ ...n, content: "{}" });
  for (let i = 0; i < 3; i++) {
    again.flush(copy, E1, later);
    again.read(copy);
  }
  assert.deepEqual(again.ran, [], "the bot ran a prompt twice");
  assert.equal(kinds(copy).filter((k) => k === 7).length, 2, "P and Q are said not run");
});

test("5.10: a bot whose store holds the decision does not run the prompt of an earlier incarnation again", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["p"]);
  const later = fill(2, 16);
  const back = new Sequence(); // put back: the prompt kept, the bot's start lost; a new incarnation
  back.submit((app.outbox[0] as OutboxItem).built?.signed as Uint8Array);
  const again = new Bot(later, bot.reader.decided, bot).owns(app); // its store holds what it decided
  again.read(back);
  assert.deepEqual([again.ran, again.reader.caughtUp()], [[], []], "the bot ran P twice");
  assert.equal(states(seq, seq.items[0] as Message), "answered");
});

test("5.10: a start the bot decided under the earlier incarnation, read back under a new one, is a cut and the prompt is not run twice", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc);
  bot.read(seq); // pending, its start in the outbox
  const later = fill(2, 16);
  bot.reader.newIncarnation(later); // served under a new incarnation: every start decided and not read back is forgotten
  bot.incarnation = later;
  bot.flush(seq, E1, later); // the start still goes out
  bot.read(seq);
  bot.flush(seq, E1, later);
  assert.deepEqual(bot.ran, []);
  assert.deepEqual(kinds(seq).sort(), [2, 3, 6]);
});

test('5.8: a start of an earlier run, read back after the bot said "not run", is said "cut" [model]', () => {
  const { app, seq } = world();
  const later = fill(2, 16);
  const earlier = new Bot(inc).owns(app);
  const bot = new Bot(later, new Map(), earlier).owns(app);
  app.say({ kind: 2, to: earlier.id, content: "p" });
  app.flush(seq, E1, inc);
  bot.read(seq);
  assert.deepEqual(
    bot.reader.caughtUp().map((n) => n.kind),
    [7],
  );
  earlier.read(seq);
  earlier.flush(seq, E1, inc); // its start lands after the notice
  bot.read(seq);
  assert.deepEqual(bot.ran, []);
  assert.deepEqual(
    bot.outbox.map((i) => i.kind),
    [6],
  );
});

test("5.8, 5.11: a bot that holds a cut in its folder says so when it reads the prompt, though the relay lost its start [model]", () => {
  const { app, seq } = world();
  const decided = new Map<string, "cut">();
  const bot = new Bot(inc, decided).owns(app);
  const p = app.say({ kind: 2, to: bot.id, content: "p" });
  decided.set(refKey(ref(app, p)), "cut");
  app.flush(seq, E1, inc);
  bot.read(seq);
  assert.deepEqual(
    bot.outbox.map((i) => i.kind),
    [6],
  );
  assert.deepEqual(bot.ran, []);
  assert.ok(hex(bot.outbox[0]?.name as Uint8Array) === hex(cutName(bot.platform, ref(app, p))));
  const prompt = seq.items[0] as Message;
  assert.deepEqual(
    bot.reader.read(prompt, bot.place, bot.fetch).notices,
    [],
    "said twice in a run",
  );
  bot.restart();
  bot.read(seq);
  assert.equal(bot.reader.decided.get(refKey(ref(app, p))), "cut");
});

test("5.12: a bot reads past a prompt only once it holds its file, and does not call it unread meanwhile [model]", () => {
  const { app, bot, seq } = world();
  const p = app.say({
    kind: 2,
    to: bot.id,
    content: "see",
    files: [{ bytes: Uint8Array.of(1, 2), type: "image/png", name: "f.png" }],
  });
  app.flush(seq, E1, inc);
  bot.fetch = () => "wait"; // the relay does not answer
  bot.read(seq);
  assert.deepEqual([bot.cursor, bot.outbox.length, bot.reader.decided.size], [0, 0, 0]);
  const file = (p as OutboxItem).files[0];
  assert.ok(file);
  bot.blobs.set(hex(file.id), file.blob);
  bot.fetch = (id) => bot.blobs.get(hex(id)) ?? "gone";
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["see"]);
});

test("5.12: a prompt whose file does not open with the key its message gives is not run, and the bot says so [model]", () => {
  const { app, bot, seq } = world();
  const p = app.say({
    kind: 2,
    to: bot.id,
    content: "see",
    files: [{ bytes: Uint8Array.of(1, 2), type: "image/png", name: "f.png" }],
  });
  const file = p.files[0];
  assert.ok(file);
  bot.blobs.set(hex(file.id), file.blob);
  app.outbox = [{ ...p, files: [{ ...file, key: fill(1) }] }]; // the message names a key that does not open it
  settle(seq, app, bot);
  assert.deepEqual([bot.ran, kinds(seq)], [[], [2, 7]]);
});

test("5.12: a prompt whose file the relay no longer holds is said not read, never run [model]", () => {
  const { app, bot, seq } = world();
  app.say({
    kind: 2,
    to: bot.id,
    content: "see",
    files: [{ bytes: Uint8Array.of(1), type: "image/png", name: "f.png" }],
  });
  settle(seq, app, bot);
  assert.deepEqual([bot.ran, kinds(seq)], [[], [2, 7]]);
});

test("a restart after the answer cuts nothing and starts nothing", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  settle(seq, app, bot);
  bot.restart();
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["p"]);
  assert.deepEqual(kinds(seq), [2, 3, 5]);
});

test("5.8, R7: the one case outside the promise: a bot and a relay put back by hand run a prompt again when no device read past it (decided 2026-11-15)", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["p"], "a first run");
  const back = new Sequence(); // the relay's directory put back: the prompt, no start of the bot's, no answer
  back.submit((app.outbox[0] as OutboxItem).built?.signed as Uint8Array);
  const again = new Bot(inc, new Map(), bot).owns(app); // the bot's folder put back to before it ran
  settle(back, app, again);
  assert.deepEqual(again.ran, ["p"], "a second run");
});

test("a BotReader of a run starts with nothing decided", () => {
  const { bot } = world();
  assert.equal(bot.reader instanceof BotReader, true);
  assert.equal(bot.reader.decided.size, 0);
});

test("5.6, 5.8, R7: a prompt the relay took and its sender never read back is not run again after the bot and the relay are put back together by hand, with no device that read further (review of the package design, R1-A) [model]", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc); // taken; the app reads nothing back, P stays in its outbox as built
  bot.read(seq);
  bot.flush(seq, E1, inc);
  bot.read(seq);
  assert.deepEqual(bot.ran, ["p"]);
  const later = fill(2, 16);
  const back = new Sequence(); // the relay put back: nothing of P
  const again = new Bot(later, new Map(), bot).owns(app); // the bot's folder put back, reading under the new incarnation
  app.flush(back, E1, later); // the identical bytes, under the incarnation they were built in
  again.read(back);
  assert.deepEqual([again.ran, again.reader.caughtUp().map((n) => n.kind)], [[], [7]]);
});

test("round 4, finding 1: a lost acknowledgement and a closed epoch do not run a prompt twice [model]", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc); // the relay takes it, the answer never comes back
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["p"]);
  app.outbox = app.outbox.map(rebuild); // another device closed the epoch
  app.flush(seq, epochOf(2), inc);
  bot.place = { ...bot.place, epoch: epochOf(2) };
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["p"], "the second copy ran again");
  const copies = seq.items.filter((m) => m.header.kind === 2);
  assert.equal(copies.length, 2, "the relay holds both copies");
  assert.ok(bytesEqual(copies[0]?.header.name as Uint8Array, copies[1]?.header.name as Uint8Array));
});

test("section 3, 5.6: an app's folder put back from a copy sends a prompt again under its name: shown once, run once [model]", () => {
  const { app, bot, seq } = world();
  app.say({ kind: 2, to: bot.id, content: "a prompt written before the copy" });
  const copy = structuredClone(app.outbox);
  settle(seq, app, bot);
  app.outbox = copy;
  app.run = new Run(app.platform);
  app.flush(seq, E1, inc); // before it has read anything
  settle(seq, app, bot);
  const prompts = seq.items.filter((m) => m.header.kind === 2);
  assert.equal(prompts.length, 2, "the relay holds two copies");
  const seen = new Seen();
  const verdicts = prompts.map((m) => {
    const v = seen.check(m.header);
    seen.add(m.header);
    return v;
  });
  assert.deepEqual(verdicts, ["first", "copy"], "shown once");
  assert.deepEqual(bot.ran, ["a prompt written before the copy"]);
});

test("section 3, 5.12: an app whose folder is put back from a copy sends its file again with its prompt: shown once, run once [model]", () => {
  const { app, bot, seq } = world();
  const p = app.say({
    kind: 2,
    to: bot.id,
    content: "see",
    files: [{ bytes: Uint8Array.of(5, 5), type: "image/png", name: "s.png" }],
  });
  const copy = structuredClone(app.outbox);
  const file = p.files[0];
  assert.ok(file);
  bot.blobs.set(hex(file.id), file.blob);
  settle(seq, app, bot);
  app.outbox = copy;
  app.run = new Run(app.platform);
  app.flush(seq, E1, inc);
  settle(seq, app, bot);
  assert.equal(seq.items.filter((m) => m.header.kind === 2).length, 2);
  assert.deepEqual(bot.ran, ["see"]);
  const [a, b] = seq.items.filter((m) => m.header.kind === 2);
  assert.deepEqual(a?.header.blobs, b?.header.blobs, "one blob under both copies");
});

test("a bot built from a store that holds a start it never finished says the cut, with no call to restart (crash)", () => {
  const { app, bot, seq } = world();
  const p = app.say({ kind: 2, to: bot.id, content: "p" });
  app.flush(seq, E1, inc);
  bot.read(seq);
  bot.flush(seq, E1, inc);
  for (const m of seq.items) bot.reader.read(m, bot.place, bot.fetch); // its start read back: "started", the process dies
  assert.deepEqual([...bot.reader.decided.values()], ["started"]);
  const reader = new BotReader(
    bot.platform,
    bot.id,
    inc,
    new Run(bot.platform),
    new Map(bot.reader.decided),
  );
  const notices = seq.items.flatMap((m) => reader.read(m, bot.place, bot.fetch).notices);
  assert.deepEqual(
    notices.map((n) => n.kind),
    [6],
  );
  assert.equal(reader.decided.get(refKey(ref(app, p))), "cut");
});

test("5.12: the files a prompt was started with come with the run, opened, and are not fetched again", () => {
  const { app, bot, seq } = world();
  const p = app.say({
    kind: 2,
    to: bot.id,
    content: "see",
    files: [{ bytes: Uint8Array.of(7, 8, 9), type: "image/png", name: "s.png" }],
  });
  const file = p.files[0];
  assert.ok(file);
  bot.blobs.set(hex(file.id), file.blob);
  app.flush(seq, E1, inc);
  bot.read(seq);
  bot.flush(seq, E1, inc);
  bot.fetch = () => "wait"; // the relay no longer answers
  const step = bot.reader.read(seq.items.at(-1) as Message, bot.place, bot.fetch);
  assert.equal(step.wait, undefined);
  assert.deepEqual(Array.from(step.run?.files[0] ?? []), [7, 8, 9]);
});

test("5.12: a prompt whose first file fails is said not read without asking for the next, and a decided prompt never waits", () => {
  const { app, bot, seq } = world();
  app.say({
    kind: 2,
    to: bot.id,
    content: "see",
    files: [
      { bytes: Uint8Array.of(1), type: "t", name: "a" },
      { bytes: Uint8Array.of(2), type: "t", name: "b" },
    ],
  });
  app.flush(seq, E1, inc);
  const asked: string[] = [];
  bot.fetch = (id) => {
    asked.push(hex(id));
    return asked.length === 1 ? "gone" : "wait";
  };
  bot.read(seq);
  assert.equal(asked.length, 1);
  assert.deepEqual(
    bot.outbox.map((i) => i.kind),
    [7],
  );
});

// The rule for a reply (SD 5.8, "an answer or an approval"; design 3.7; the model's "reply rule"
// tests): a reply is kind 10, `to` the bot, `re` a request (kind 9) the bot wrote and read earlier.
// It meets the conditions of a prompt but the incarnation rule, runs once on the bot's own start
// read back, and is done by an answer, kind 5, `re` the reply.
const request = (bot: Bot, app: Party) =>
  bot.say({ kind: 9, re: { device: app.id, name: fill(60, 16) }, content: "{}" });
const reply = (app: Party, bot: Bot, asked: OutboxItem, content: string, over = {}) =>
  app.say({ kind: 10, to: bot.id, re: { device: bot.id, name: asked.name }, content, ...over });

test("reply rule: a reply to a request of the bot is handed on once, on the bot's own start read back, and answered [model]", () => {
  const { app, bot, seq } = world();
  const asked = request(bot, app);
  settle(seq, app, bot);
  reply(app, bot, asked, "yes");
  app.flush(seq, E1, inc);
  bot.read(seq);
  assert.deepEqual([bot.ran, bot.outbox.map((i) => i.kind)], [[], [3]], "not before its start");
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["yes"]);
  assert.deepEqual(kinds(seq), [9, 10, 3, 5]);
  assert.equal(
    bot.reader.decided.get(
      refKey({ device: app.id, name: seq.items[1]?.header.name as Uint8Array }),
    ),
    "done",
  );
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["yes"], "once");
});

test("reply rule: a handed-on reply is done: a restart hands it on no more and says no cut [model]", () => {
  const { app, bot, seq } = world();
  const asked = request(bot, app);
  settle(seq, app, bot);
  reply(app, bot, asked, "yes");
  settle(seq, app, bot);
  bot.restart();
  settle(seq, app, bot);
  assert.deepEqual([bot.ran, kinds(seq).filter((k) => k === 6)], [["yes"], []]);
});

test("reply rule, 5.8 condition 5: a bot lost between its start and the hand-on says the reply cut, once, and never hands it on [model]", () => {
  const { app, bot, seq } = world();
  const asked = request(bot, app);
  settle(seq, app, bot);
  reply(app, bot, asked, "yes");
  bot.crashAfterStart = true;
  settle(seq, app, bot);
  bot.crashAfterStart = false;
  settle(seq, app, bot);
  bot.restart();
  settle(seq, app, bot);
  assert.deepEqual([bot.ran, kinds(seq).filter((k) => k === 6)], [[], [6]]);
});

test("reply rule: a reply read twice makes one start and one hand-on [model]", () => {
  const { app, bot, seq } = world();
  const asked = request(bot, app);
  settle(seq, app, bot);
  reply(app, bot, asked, "yes");
  app.flush(seq, E1, inc);
  const m = seq.items.at(-1) as Message;
  const first = bot.reader.read(m, bot.place, bot.fetch);
  assert.deepEqual(
    first.notices.map((n) => n.kind),
    [3],
  );
  assert.deepEqual(bot.reader.read(m, bot.place, bot.fetch), { notices: [] });
});

test("reply rule, 5.8 condition 4: a reply addressed to one bot is not handed on by another bot of the owner [model]", () => {
  const { app, bot, seq } = world();
  const other = new Bot(inc).owns(app);
  const asked = request(bot, app);
  other.say({
    kind: 9,
    re: { device: app.id, name: fill(60, 16) },
    name: asked.name,
    content: "{}",
  });
  settle(seq, app, bot, other);
  reply(app, bot, asked, "for the first");
  settle(seq, app, bot, other);
  assert.deepEqual([bot.ran, other.ran], [["for the first"], []]);
});

test("reply rule, 5.8 conditions 2 and 3: a reply of an ended epoch, or from a device the log shows removed, is not handed on [model]", () => {
  const { app, bot, seq } = world();
  const asked = request(bot, app);
  settle(seq, app, bot);
  reply(app, bot, asked, "yes");
  app.flush(seq, E1, inc);
  const m = seq.items.at(-1) as Message;
  const [genesis, added] = bot.place.log as [LoggedEntry, LoggedEntry];
  const removal = {
    id: fill(77),
    entry: { kind: "remove", device: app.id },
  } as unknown as LoggedEntry;
  const notices = (place: Place) =>
    new BotReader(bot.platform, bot.id, inc, bot.run)
      .read(m, place, bot.fetch)
      .notices.map((n) => n.kind);
  const at = (length: number, epoch = E1): Place => ({
    ...bot.place,
    epoch,
    log: [genesis, added, removal],
    length,
  });
  assert.deepEqual([notices(at(3)), notices(at(2, epochOf(2)))], [[], []]);
});

test("reply rule, SD 5.8: a reply is handed on only when its `re` is a request of the bot's own, read earlier [model]", () => {
  const { app, bot, seq } = world();
  const note = bot.say({ kind: 1, content: "{}" });
  const theirs = new Bot(inc).owns(app);
  const other = request(theirs, app);
  settle(seq, app, bot, theirs);
  const nothing = { ...note, name: fill(61, 16) }; // a name the bot never wrote
  for (const re of [note, other, nothing]) reply(app, bot, re, "no");
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, [], "a text, another bot's request, no message");
  // Named before it was asked: the request comes later in the sequence, and the reply is never run for it.
  const later = { ...note, name: fill(62, 16) };
  reply(app, bot, later, "before");
  settle(seq, app, bot);
  bot.say({ kind: 9, re: { device: app.id, name: fill(60, 16) }, name: later.name, content: "{}" });
  settle(seq, app, bot);
  bot.restart();
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, []);
  const asked = request(bot, app);
  settle(seq, app, bot);
  reply(app, bot, asked, "yes");
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["yes"]);
});

test("reply rule, 5.8 condition 2: a reply in an epoch whose key the bot was not given is said not read, and never handed on [model]", () => {
  const { app, bot, seq } = world();
  const asked = request(bot, app);
  settle(seq, app, bot);
  const r = reply(app, bot, asked, "yes");
  app.flush(seq, E1, inc);
  const place = bot.place;
  bot.place = { ...place, key: undefined };
  bot.read(seq);
  assert.deepEqual([bot.ran, bot.outbox.at(-1)?.kind], [[], 7]);
  assert.ok(bot.outbox.some((i) => hex(i.name) === hex(unreadName(bot.platform, ref(app, r)))));
  bot.place = place;
  bot.restart();
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, []);
});

test("reply rule: the incarnation rule does not apply to a reply, as it does to a prompt [model]", () => {
  const { app, seq } = world();
  const later = fill(2, 16);
  const bot = new Bot(later).owns(app);
  const asked = request(bot, app);
  bot.flush(seq, E1, later);
  bot.read(seq);
  app.say({ kind: 2, to: bot.id, content: "p" });
  reply(app, bot, asked, "yes");
  app.flush(seq, E1, inc); // both built under the earlier incarnation of the relay
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["yes"], "the reply is handed on; the prompt is not run");
  assert.deepEqual(
    bot.reader.caughtUp().map((n) => n.kind),
    [7],
  );
});

test("reply rule: a second reply to an answered request is handed on too, and answered", () => {
  const { app, bot, seq } = world();
  const asked = request(bot, app);
  settle(seq, app, bot);
  reply(app, bot, asked, "first");
  settle(seq, app, bot);
  reply(app, bot, asked, "second");
  settle(seq, app, bot);
  assert.deepEqual(bot.ran, ["first", "second"], "the core says false and tells the owner");
  assert.deepEqual(kinds(seq).filter((k) => k === 5).length, 2);
});
