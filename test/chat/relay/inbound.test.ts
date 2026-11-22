/**
 * What reaches the core (design 3.7, SD 5.8) with the reader's own bytes: real sealed and signed
 * messages of `test/protocol/sequence.ts` fed to `Inbound` as the connection would, the outbox and
 * the store replaced by records. The owner-only checks (C3), a prompt with a file (Q5), the owner's
 * answer, and two channels (C7). The relay child is in `inbound-relay.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { InboundMessage } from "../../../src/chat/seam.ts";
import { setLevel, setWriter } from "../../../src/log.ts";
import type { LoggedEntry } from "../../../src/protocol/device-log.ts";
import { epochOf, fill, Party } from "../../protocol/sequence.ts";
import { E1, inc, rig, SEL } from "./inbound-rig.ts";

test("a prompt of the owner reaches the core once, after its start is read back", async () => {
  const r = rig();
  r.prompt({ text: "hello" });
  await r.feed();
  assert.deepEqual([r.queued.map((q) => q.draft.kind), r.messages.length], [[3], 0]);
  await r.echo();
  assert.equal(r.messages.length, 1);
  const m = r.messages[0] as InboundMessage;
  assert.deepEqual(
    [m.text, m.topLevel, m.literal, await m.content()],
    ["hello", true, false, "hello"],
  );
  assert.equal(m.ref.thread, m.id);
  r.prompt({ text: "again", thread: m.ref.thread });
  await r.feed();
  await r.echo();
  assert.deepEqual(
    [r.messages.length, r.messages[1]?.topLevel, r.messages[1]?.ref.thread],
    [2, false, m.ref.thread],
  );
  await r.echo();
  assert.equal(r.messages.length, 2, "once each");
  assert.equal(r.store.saved.decided.size, 2);
});

test("C3: a prompt to another device, from a removed device, or of an ended epoch reaches no session and gets no start", async () => {
  const r = rig();
  r.prompt({ text: "x" }, fill(5)); // to another device
  await r.feed();
  r.prompt({ text: "y" });
  const [genesis, added] = r.bot.place.log as [LoggedEntry, LoggedEntry];
  const removal = {
    id: fill(77),
    entry: { kind: "remove", device: r.app.id },
  } as unknown as LoggedEntry;
  await r.feed({ ...r.bot.place, log: [genesis, added, removal], length: 3 }); // its sender removed at its place
  r.prompt({ text: "z" });
  await r.feed({ ...r.bot.place, epoch: epochOf(2) }); // an epoch that has ended
  const queued = r.queued.map((q) => q.draft.kind); // before the echo empties it
  await r.echo();
  assert.deepEqual([queued, r.messages, r.store.saved.decided.size], [[], [], 0]);
});

test("a prompt from a device that is not the owner's reaches no session, gets no start and is in no log line", async (t) => {
  const MARKER = "mk-stranger-5e27ad";
  const written: string[] = [];
  const earlier = setWriter((line) => written.push(line));
  setLevel("DEBUG");
  t.after(() => {
    setWriter(earlier);
    setLevel("INFO");
  });
  const r = rig();
  const stranger = new Party();
  stranger.say({ kind: 2, to: r.bot.id, content: JSON.stringify({ text: `let me in ${MARKER}` }) });
  stranger.flush(r.seq, E1, inc);
  r.prompt({ text: "mine" });
  await r.feed();
  assert.deepEqual(
    r.queued.map((q) => q.draft.kind),
    [3],
    "one start, the owner's: none for the stranger's",
  );
  await r.echo();
  assert.deepEqual(
    r.messages.map((m) => m.text),
    ["mine"],
    "only the owner's prompt reaches the core",
  );
  for (const line of [...written, ...r.logs]) assert.ok(!line.includes(MARKER), line);
});

test("a prompt with a file is said not read, and never reaches the core", async () => {
  const r = rig();
  r.app.say({
    kind: 2,
    to: r.bot.id,
    content: JSON.stringify({ text: "see" }),
    files: [{ bytes: Uint8Array.of(1), type: "t", name: "a" }],
  });
  r.app.flush(r.seq, E1, inc);
  await r.feed();
  assert.deepEqual(
    r.queued.map((q) => q.draft.kind),
    [7],
  );
  await r.echo();
  assert.equal(r.messages.length, 0);
});

test("the owner's answer to a request reaches the core once, when it has the request's type; a reply of another type is answered and not handed on", async () => {
  const r = rig();
  const ref = { channel: "c", thread: "t" };
  const ask = (name: number, type: "setup" | "hold") => {
    const asked = r.bot.say({
      kind: 9,
      re: { device: r.app.id, name: fill(60, 16) },
      name: fill(name, 16),
      content: "{}",
    });
    r.bot.flush(r.seq, E1, inc);
    r.inbound.expect(asked.name, { requestId: `id${name}`, ref, type });
    return asked;
  };
  const one = ask(1, "setup");
  const two = ask(2, "hold");
  const say = (to: typeof one, answer: object) => {
    r.app.say({
      kind: 10,
      to: r.bot.id,
      re: { device: r.bot.id, name: to.name },
      content: JSON.stringify({ answer }),
    });
    r.app.flush(r.seq, E1, inc);
  };
  say(one, { type: "setup", selection: SEL });
  say(two, { type: "permission", allow: true });
  await r.feed();
  await r.echo();
  await r.echo();
  assert.deepEqual(
    r.answers.map(([id, a]) => [id, a.type]),
    [["id1", "setup"]],
  );
  assert.equal(r.messages.length, 0, "no prompt");
  const kinds = r.seq.items.map((m) => m.header.kind);
  assert.equal(kinds.filter((k) => k === 5).length, 2, "each reply is answered once");
  await r.echo();
  assert.equal(r.answers.length, 1);
});

test("C7: a message of another channel is not held by a turn that never ends", async () => {
  const r = rig();
  r.hold(new Promise(() => {}));
  r.prompt({ text: "a" });
  const other = fill(2);
  r.app.outbox = []; // what is built stays built in its channel
  r.app.say({ kind: 2, to: r.bot.id, content: JSON.stringify({ text: "c" }) });
  r.app.flush(r.seq, E1, inc, other);
  await r.feed();
  await r.echo();
  assert.equal(r.messages.length, 2, "the second channel did not wait for the first");
  assert.notEqual(r.messages[0]?.ref.channel, r.messages[1]?.ref.channel);
});

test("a reconnection under the same incarnation keeps a start in flight and a waiting request", async () => {
  const r = rig();
  r.prompt({ text: "hello" });
  await r.feed();
  r.reconnect(); // dropped and dialed again; the outbox keeps the start
  await r.echo();
  assert.equal(r.messages.length, 1, "the prompt still runs");
  const asked = r.bot.say({
    kind: 9,
    re: { device: r.app.id, name: fill(60, 16) },
    name: fill(1, 16),
    content: "{}",
  });
  r.bot.flush(r.seq, E1, inc);
  r.inbound.expect(asked.name, {
    requestId: "id1",
    ref: { channel: "c", thread: "t" },
    type: "setup",
  });
  await r.feed();
  r.reconnect();
  r.app.say({
    kind: 10,
    to: r.bot.id,
    re: { device: r.bot.id, name: asked.name },
    content: JSON.stringify({ answer: { type: "setup", selection: SEL } }),
  });
  r.app.flush(r.seq, E1, inc);
  await r.feed();
  await r.echo();
  assert.deepEqual(
    r.answers.map(([id]) => id),
    ["id1"],
  );
});

test("a new incarnation forgets a start in flight", async () => {
  const r = rig();
  r.prompt({ text: "hello" });
  await r.feed();
  r.inbound.take({ do: "incarnation", incarnation: fill(3, 16), first: false, changed: true });
  await r.echo();
  assert.equal(r.messages.length, 0, "a start of the earlier incarnation is no start of this one");
});

async function waits(r: ReturnType<typeof rig>, type: "setup" | "permission") {
  const asked = r.bot.say({
    kind: 9,
    re: { device: r.app.id, name: fill(60, 16) },
    name: fill(1, 16),
    content: "{}",
  });
  r.bot.flush(r.seq, E1, inc);
  r.inbound.expect(asked.name, { requestId: "id1", ref: { channel: "c", thread: "t" }, type });
  await r.feed();
  return (answer: object) => {
    r.app.say({
      kind: 10,
      to: r.bot.id,
      re: { device: r.bot.id, name: asked.name },
      content: JSON.stringify({ answer }),
    });
    r.app.flush(r.seq, E1, inc);
  };
}

test("a malformed answer is not handed on, the request stays waiting, and the correct retry reaches the core", async () => {
  const r = rig();
  const reply = await waits(r, "setup");
  reply({ type: "setup" });
  await r.feed();
  await r.echo();
  assert.deepEqual([r.answers.length, r.inbound.waiting.size], [0, 1]);
  reply({ type: "setup", selection: SEL });
  await r.feed();
  await r.echo();
  assert.deepEqual([r.answers.length, r.inbound.waiting.size], [1, 0]);
});

test("every field of an answer is checked by type: a string for allow is no approval", async () => {
  const r = rig();
  const reply = await waits(r, "permission");
  reply({ type: "permission", allow: "yes" });
  await r.feed();
  assert.equal(r.answers.length, 0);
  reply({ type: "permission", allow: true });
  await r.feed();
  await r.echo();
  assert.deepEqual(
    r.answers.map(([, a]) => a),
    [{ type: "permission", allow: true }],
  );
});

test("an answer the core throws on keeps the request waiting", async () => {
  const r = rig();
  const reply = await waits(r, "setup");
  r.throwing.on = true;
  reply({ type: "setup", selection: SEL });
  await r.feed();
  await r.echo();
  assert.deepEqual([r.answers.length, r.inbound.waiting.size], [1, 1]);
  r.throwing.on = false;
  reply({ type: "setup", selection: SEL });
  await r.feed();
  await r.echo();
  assert.deepEqual([r.answers.length, r.inbound.waiting.size], [2, 0]);
});

test("a prompt started and not handed on is answered, so a restart does not say it cut", async () => {
  const r = rig();
  r.app.say({ kind: 2, to: r.bot.id, content: JSON.stringify({ txt: "typo" }) });
  r.app.flush(r.seq, E1, inc);
  await r.feed();
  await r.echo();
  const answer = r.queued.find((q) => q.draft.kind === 5);
  assert.equal(
    JSON.parse(answer?.draft.content ?? "{}").markdown,
    "The bot did not run this prompt.",
  );
  assert.deepEqual([...r.store.saved.decided.values()], ["done"]);
});

test("a prompt whose thread is no sender and name opens a thread of its own", async () => {
  const r = rig();
  r.prompt({ text: "x", thread: "../other" });
  await r.feed();
  await r.echo();
  assert.equal(r.messages[0]?.topLevel, true);
});

test("a hand-on with the provider stopped is answered not run; a reply with it stopped is left alone", async () => {
  const r = rig();
  r.inbound.start(undefined);
  r.prompt({ text: "x" });
  await r.feed();
  await r.echo();
  assert.equal(r.messages.length, 0);
  assert.equal(r.queued.filter((q) => q.draft.kind === 5).length, 1);
});

const said = (r: ReturnType<typeof rig>) =>
  r.queued.filter((q) => q.draft.kind === 5).map((q) => JSON.parse(q.draft.content).markdown);

test("a reply is answered with the reason when it was not handed on", async () => {
  const stopped = rig();
  const stop = await waits(stopped, "setup");
  stopped.inbound.start(undefined);
  stop({ type: "setup", selection: SEL });
  await stopped.feed();
  await stopped.echo();
  assert.deepEqual(said(stopped), ["The bot could not take this answer."]);
  const threw = rig();
  const reply = await waits(threw, "setup");
  threw.throwing.on = true;
  reply({ type: "setup", selection: SEL });
  await threw.feed();
  await threw.echo();
  assert.deepEqual(said(threw), ["The bot could not take this answer."]);
  const bad = rig();
  const malformed = await waits(bad, "setup");
  malformed({ type: "setup" });
  await bad.feed();
  await bad.echo();
  assert.deepEqual(said(bad), ["The bot could not read this answer."]);
  const gone = rig();
  const late = await waits(gone, "setup");
  gone.inbound.waiting.clear(); // a restart: no request waits
  late({ type: "setup", selection: SEL });
  await gone.feed();
  await gone.echo();
  assert.deepEqual(said(gone), ["The bot is no longer waiting for this answer."]);
});

/** A question request of the bot, with its texts held by `expect` (`restart` false) or rebuilt from its own kind 9 (`restart` true). */
async function asksQuestions(r: ReturnType<typeof rig>, restart: boolean) {
  const asked = r.bot.say({
    kind: 9,
    re: { device: r.app.id, name: fill(60, 16) },
    name: fill(1, 16),
    content: JSON.stringify({
      thread: "t",
      request: {
        type: "question",
        toolName: "AskUserQuestion",
        title: null,
        questions: [
          { header: "", text: "Which?", multiSelect: false, options: [] },
          { header: "", text: "Why?", multiSelect: false, options: [] },
        ],
      },
      title: "x",
    }),
  });
  r.bot.flush(r.seq, E1, inc);
  if (!restart)
    r.inbound.expect(asked.name, {
      requestId: "id1",
      ref: { channel: "c", thread: "t" },
      type: "question",
      questions: ["Which?", "Why?"],
    });
  await r.feed();
  // The rig's target accepts any request id; in the daemon the core answers false for a rebuilt request.
  // What this asserts is what the bot hands the target, not that the owner's answer is delivered.
  if (restart) assert.equal(r.inbound.waiting.size, 1, "the request is rebuilt from the kind 9");
  return (answer: object) => {
    r.app.say({
      kind: 10,
      to: r.bot.id,
      re: { device: r.bot.id, name: asked.name },
      content: JSON.stringify({ answer }),
    });
    r.app.flush(r.seq, E1, inc);
  };
}

for (const restart of [false, true]) {
  test(`an answer whose keys name no question is refused and the request keeps waiting${restart ? " (rebuilt after a restart)" : ""}`, async () => {
    const r = rig();
    const reply = await asksQuestions(r, restart);
    reply({ type: "question", answers: { "Which?": "a", Other: "b" }, notes: {} });
    await r.feed();
    await r.echo();
    const first = said(r);
    reply({ type: "question", answers: { "Which?": "a" }, notes: { Other: "n" } });
    await r.feed();
    await r.echo();
    const second = said(r);
    assert.deepEqual(
      [...first, ...second],
      ["The bot could not read this answer.", "The bot could not read this answer."],
    );
    assert.deepEqual([r.answers.length, r.inbound.waiting.size], [0, 1]);
    reply({ type: "question", answers: { "Which?": ["a"], "Why?": "b" }, notes: { "Why?": "n" } });
    await r.feed();
    await r.echo();
    assert.deepEqual([r.answers.length, r.inbound.waiting.size], [1, 0]);
  });
}

test("a skipped question set (answers null) is still accepted", async () => {
  const r = rig();
  const reply = await asksQuestions(r, false);
  reply({ type: "question", answers: null, notes: {} });
  await r.feed();
  await r.echo();
  assert.deepEqual([r.answers.length, r.inbound.waiting.size], [1, 0]);
});

test("a note needs an answered question and an answer names at least one question", async () => {
  const r = rig();
  const reply = await asksQuestions(r, false);
  reply({ type: "question", answers: { "Which?": "a" }, notes: { "Why?": "n" } }); // a note, no answer
  await r.feed();
  await r.echo();
  reply({ type: "question", answers: null, notes: { "Why?": "n" } });
  await r.feed();
  await r.echo();
  reply({ type: "question", answers: {}, notes: {} });
  await r.feed();
  await r.echo();
  assert.deepEqual([r.answers.length, r.inbound.waiting.size], [0, 1]);
  reply({ type: "question", answers: { "Which?": "a" }, notes: { "Which?": "n" } });
  await r.feed();
  await r.echo();
  assert.deepEqual([r.answers.length, r.inbound.waiting.size], [1, 0]);
});

test("a top-level prompt not handed on is answered as no session (#68)", async () => {
  const r = rig();
  r.inbound.start(undefined);
  r.prompt({ text: "x" });
  await r.feed();
  await r.echo();
  const [answer] = r.queued.filter((q) => q.draft.kind === 5);
  assert.equal(JSON.parse(answer?.draft.content ?? "{}").session, false);
});

test("a prompt of a thread not handed on is answered with no flag (#68)", async () => {
  const r = rig();
  r.prompt({ text: "first" });
  await r.feed();
  await r.echo();
  const first = r.messages[0] as InboundMessage;
  first.handled?.(true);
  await r.echo();
  r.inbound.start(undefined);
  r.prompt({ text: "y", thread: first.ref.thread });
  await r.feed();
  await r.echo();
  const answer = JSON.parse(r.queued.findLast((q) => q.draft.kind === 5)?.draft.content ?? "{}");
  assert.equal(answer.markdown, "The bot did not run this prompt.");
  assert.equal("session" in answer, false);
});
