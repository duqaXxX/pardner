/**
 * A turn's tool calls as lines (turn work design 2.1, 2.2, 2.5): the reply writes a line's text when it
 * first sees it and an edit when its status, output or preview changes. The outbox is a record.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Inbound } from "../../../src/chat/relay/inbound.ts";
import { fitLine, type Line } from "../../../src/chat/relay/line.ts";
import type { Outbox } from "../../../src/chat/relay/outbox.ts";
import { RelayProvider } from "../../../src/chat/relay/provider.ts";
import type { Reply, TaskUpdate } from "../../../src/chat/seam.ts";
import type { Draft } from "../../../src/protocol/outbox.ts";
import { platform } from "../../relay/support.ts";

const self = new Uint8Array(32).fill(7);
const prompt = "ab".repeat(32) + "cd".repeat(16);
const ref = { channel: "01".repeat(32), thread: prompt };
const ROOM = 1_048_576 - 4096;

const update = (over: Partial<TaskUpdate> = {}): TaskUpdate => ({
  id: "toolu_1",
  title: "Bash(ls)",
  status: "in_progress",
  details: null,
  output: null,
  name: "Bash",
  task: false,
  message: false,
  agent: null,
  calls: 0,
  preview: null,
  folded: null,
  startedAt: null,
  ...over,
});

const preview = (body: string, over = {}) => ({
  title: "Update(a.txt)",
  summary: "Added 1 line, removed 1 line",
  body,
  language: "diff" as const,
  plain: false,
  record: false,
  ...over,
});

/** A reply for `prompt` over an outbox that records its drafts; `refuse` makes it say false. */
function setup(options: { prompt?: boolean; refuse?: (d: Draft) => boolean } = {}) {
  const queued: Draft[] = [];
  const state = { closed: false };
  const mine = new Set<string>();
  const outbox = {
    queue: async (_: unknown, draft: Draft) => {
      if (options.refuse?.(draft)) return false;
      // The name must be in the set already: the text can be read back as soon as it is queued.
      if (draft.kind === 1) assert.ok(mine.has(Buffer.from(draft.name ?? []).toString("hex")));
      queued.push(draft);
      return true;
    },
    holds: () => true,
  } as unknown as Outbox;
  const inbound = {
    closed: () => state.closed,
    mine,
    replyOf: () => ({ name: new Uint8Array(16), text: "" }),
  } as unknown as Inbound;
  let now = 1_000_000;
  const clock = { time: () => 50 };
  const provider = new RelayProvider(
    self,
    outbox,
    inbound,
    { random: platform.random.bind(platform), now: () => now },
    undefined,
    clock,
  );
  const reply: Reply = provider
    .thread(ref)
    .openReply(() => {}, options.prompt === false ? undefined : prompt);
  const body = (d: Draft | undefined) => JSON.parse(d?.content ?? "null");
  return { reply, queued, state, mine, body, tick: (ms: number) => (now += ms) };
}

test("a line is a text at first sight and an edit only when status, output or preview changes", async () => {
  const { reply, queued, body } = setup();
  await reply.task(update({ startedAt: 48 }));
  await reply.task(update({ startedAt: 48, details: "more" })); // details alone: nothing
  await reply.task(update({ status: "complete", startedAt: 48 }));
  await reply.task(update({ status: "complete", startedAt: 48, output: "first line" }));
  await reply.task(update({ status: "complete", startedAt: 48, output: "first line", calls: 3 })); // nothing
  assert.deepEqual(
    queued.map((d) => d.kind),
    [1, 11, 11],
  );
  const [text, ended, output] = queued as [Draft, Draft, Draft];
  assert.equal(
    Buffer.from(text.re?.name ?? []).toString("hex"),
    "cd".repeat(16),
    "the text names the prompt",
  );
  assert.equal(Buffer.from(text.re?.device ?? []).toString("hex"), "ab".repeat(32));
  assert.deepEqual(body(text), {
    thread: prompt,
    say: "task",
    task: {
      title: "Bash(ls)",
      status: "in_progress",
      details: null,
      output: null,
      task: false,
      message: false,
      agent: null,
      calls: 0,
      preview: null,
      startedAt: 1_000_000 - 2000,
    },
  });
  for (const edit of [ended, output]) {
    assert.deepEqual(edit.re, { device: self, name: text.name });
    assert.deepEqual(Object.keys(body(edit)), ["thread", "task"]);
  }
  assert.equal(body(ended).task.status, "complete");
  assert.equal(body(output).task.output, "first line");
  assert.equal(body(output).task.id, undefined);
});

test("a call's line that becomes a task's line is an edit, and its agent goes out with it", async () => {
  // A background command's call: the call's end only makes the line a task's (`task`, `details`).
  const { reply, queued, body } = setup();
  await reply.task(update({ startedAt: 48 }));
  await reply.task(update({ startedAt: 48, task: true, details: "Running in background" }));
  await reply.task(update({ startedAt: 48, task: true, details: "Running in background" })); // nothing
  assert.deepEqual(
    queued.map((d) => d.kind),
    [1, 11],
  );
  assert.equal(body(queued[1]).task.task, true);
  await reply.task(update({ id: "toolu_2", task: true, agent: "Run ls", startedAt: 48 }));
  assert.equal(body(queued[2]).task.agent, "Run ls");
});

test("a changed preview is an edit; an unchanged one is not", async () => {
  const { reply, queued } = setup();
  await reply.task(update({ status: "complete", preview: preview("1 +a") }));
  await reply.task(update({ status: "complete", preview: preview("1 +a") }));
  await reply.task(update({ status: "complete", preview: preview("1 +b") }));
  assert.deepEqual(
    queued.map((d) => d.kind),
    [1, 11],
  );
});

test("finish writes an edit for each closed line that differs, a text for one first seen there", async () => {
  const { reply, queued, body } = setup();
  await reply.task(update({ id: "a" }));
  await reply.task(update({ id: "b", title: "Bash(sleep)" }));
  await reply.task(update({ id: "c", title: "Task", task: true }));
  await reply.finish([
    update({ id: "a", status: "error", output: "Stopped" }),
    update({ id: "b", details: "Running in background" }), // status unchanged, details differ
    update({ id: "c", title: "Task", task: true }), // identical: nothing
    update({ id: "d", title: "Late" }), // first seen here
  ]);
  assert.deepEqual(
    queued.map((d) => d.kind),
    [1, 1, 1, 11, 11, 1],
  );
  assert.equal(body(queued[3]).task.output, "Stopped");
  assert.equal(body(queued[4]).task.details, "Running in background");
  assert.equal(body(queued[5]).task.title, "Late");
  assert.equal(body(queued[5]).say, "task");
});

test("a line is written for as long as the reply lives: after the answer, after finish, with no prompt", async () => {
  const answered = setup();
  answered.state.closed = true;
  await answered.reply.task(update({ task: true }));
  await answered.reply.task(update({ task: true, status: "complete" }));
  await answered.reply.finish([update({ id: "y" })]);
  assert.deepEqual(
    answered.queued.map((d) => d.kind),
    [1, 11, 1],
    "a text, its edit, and a text first seen at finish",
  );
  assert.equal(Buffer.from(answered.queued[0]?.re?.name ?? []).toString("hex"), "cd".repeat(16));

  // A reply with no prompt (a scheduled run, a report turn that opened its own reply): the line has no `re`.
  const none = setup({ prompt: false });
  await none.reply.task(update());
  await none.reply.finish([update({ status: "complete" })]);
  assert.deepEqual(
    none.queued.map((d) => d.kind),
    [1, 11],
  );
  assert.equal(none.queued[0]?.re, undefined);
  assert.deepEqual(none.queued[1]?.re, { device: self, name: none.queued[0]?.name });

  // Once finish has run the reply still writes a line's later edit (a task that ends after the turn).
  const done = setup();
  await done.reply.task(update({ task: true }));
  await done.reply.finish([]);
  await done.reply.task(update({ task: true, status: "complete" }));
  await done.reply.task(update({ id: "z", task: true }));
  assert.deepEqual(
    done.queued.map((d) => d.kind),
    [1, 11, 1],
  );
});

test("a line's name is in the bot's own set before its text is queued, and stays", async () => {
  const { reply, queued, mine } = setup();
  const seen: boolean[] = [];
  await reply.task(update());
  await reply.task(update({ status: "complete" }));
  seen.push(mine.has(Buffer.from(queued[0]?.name ?? []).toString("hex")));
  assert.deepEqual(seen, [true]);
  assert.equal(mine.size, 1, "the edit adds no name of its own");
});

test("a refused line never makes the reply unlanded, and is written once whatever the queue said", async () => {
  const { reply, queued } = setup({ refuse: (d) => d.kind === 1 });
  await reply.task(update());
  assert.equal(await reply.settle(), true, "the line is no part of what must land");
  await reply.task(update({ status: "complete" }));
  await reply.task(update({ status: "complete" }));
  assert.deepEqual(
    queued.map((d) => d.kind),
    [11],
    "no second text for the same call",
  );
});

test("finish stops at an aborted signal; a task's update after it is still written", async () => {
  const { reply, queued } = setup();
  const abort = new AbortController();
  abort.abort();
  await reply.finish([update({ id: "a" })], abort.signal);
  assert.deepEqual(queued, []);
  await reply.task(update({ id: "b" }));
  assert.equal(queued.length, 1);
});

test("startedAt is wall-clock milliseconds computed when the line is written", async () => {
  const { reply, queued, body, tick } = setup();
  await reply.task(update({ startedAt: 49.5 }));
  tick(10_000);
  await reply.task(update({ startedAt: 49.5, status: "complete" }));
  assert.equal(body(queued[0]).task.startedAt, 1_000_000 - 500);
  assert.equal(body(queued[1]).task.startedAt, 1_010_000 - 500);
});

const lineOf = (body: string): Line => ({
  title: "t",
  status: "complete",
  details: null,
  output: null,
  task: false,
  message: false,
  agent: null,
  calls: 0,
  preview: preview(body),
  startedAt: null,
});
const size = (json: string | undefined) => Buffer.byteLength(json ?? "");

test("a line within the room is written as is", () => {
  const line = lineOf("1 +a\n2 -b");
  assert.equal(fitLine({ thread: "t" }, line, ROOM), JSON.stringify({ thread: "t", task: line }));
});

test("a preview body past the room is cut at a line end and says how many lines went", () => {
  const rows = Array.from({ length: 40_000 }, (_, i) => `${i} +${"x".repeat(60)}`);
  const json = fitLine({ thread: "t" }, lineOf(rows.join("\n")), ROOM);
  assert.ok(size(json) <= ROOM && size(json) > ROOM - 200);
  const cut = JSON.parse(json as string).task.preview.body as string;
  const kept = cut.split("\n");
  const marker = kept.pop() as string;
  assert.match(marker, /^… \+\d+ lines$/);
  assert.equal(kept.length + Number(marker.match(/\d+/)), rows.length);
  assert.deepEqual(kept, rows.slice(0, kept.length), "whole lines only");
});

const bodyOf = (json: string | undefined) => JSON.parse(json as string).task as Line;
const text = (n: number, line = "y") => `${line}\n`.repeat(n);

test("the longest of body, details and output is cut first, to the room the rest leaves", () => {
  const task = bodyOf(
    fitLine({ thread: "t" }, { ...lineOf(text(150_000)), output: text(450_000) }, ROOM),
  );
  assert.match(task.output ?? "", /\n… \+\d+ lines$/, "the longer output is cut");
  assert.equal(task.preview?.body, text(150_000), "and the body, which then fits, is whole");
  const small = bodyOf(
    fitLine({ thread: "t" }, { ...lineOf("1 +a"), details: text(700_000) }, ROOM),
  );
  assert.equal(small.preview?.body, "1 +a", "a small body stays");
  assert.match(small.details ?? "", /\n… \+\d+ lines$/);
});

test("two long fields that fit together once one is cut both keep content", () => {
  const task = bodyOf(
    fitLine(
      { thread: "t" },
      {
        ...lineOf("1 +a"),
        details: text(7000, "y".repeat(99)),
        output: text(7000, "z".repeat(99)),
      },
      ROOM,
    ),
  );
  assert.match(
    task.details ?? "",
    /^y{99}\ny{99}\n[\s\S]*\n… \+\d+ lines$/,
    "the first of the two is cut",
  );
  assert.equal(task.output, text(7000, "z".repeat(99)), "the other then fits whole");
  assert.equal(task.preview?.body, "1 +a");
});

test("when no one field is enough the longest is cut to its marker and the next goes on", () => {
  const big = text(7000, "q".repeat(99));
  const json = fitLine({ thread: "t" }, { ...lineOf(big), details: big, output: big }, ROOM);
  assert.ok(size(json) <= ROOM);
  const task = bodyOf(json);
  for (const field of [task.preview?.body, task.details])
    assert.match(field ?? "", /\n… \+\d+ lines$/, "a count, never a bare ellipsis");
  assert.equal(task.output, big, "the room that is left holds the last one whole");
});

test("a first line past the room is cut between characters, then says how many lines followed", () => {
  const json = fitLine({ thread: "t" }, lineOf(`${"a".repeat(2_000_000)}\nb\nc`), ROOM);
  assert.ok(size(json) <= ROOM && size(json) > ROOM - 20);
  const cut = bodyOf(json).preview?.body ?? "";
  assert.match(cut, /^a+…\n… \+2 lines$/);
});

test("a preview of 9 MB is cut well inside a second", () => {
  const rows = Array.from({ length: 150_000 }, (_, i) => `${i} +${"x".repeat(56)}`).join("\n");
  const started = performance.now();
  const json = fitLine({ thread: "t" }, lineOf(rows), ROOM);
  const ms = performance.now() - started;
  console.log(`fitLine on ${(rows.length / 1e6).toFixed(1)} MB: ${ms.toFixed(0)} ms`);
  assert.ok(size(json) <= ROOM && ms < 1000, `took ${ms} ms`);
});

test("a line the three fields cannot save is not written", async () => {
  const { reply, queued } = setup();
  await reply.task(update({ title: "x".repeat(ROOM) }));
  assert.deepEqual(queued, []);
});
