/**
 * A scheduled run's line and the bot's guess at the next prompt as texts of the bot (step E1 design
 * 3.1 and 3.2). The outbox is a record; the content shapes are the shared vector file the app's tests
 * read too.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Inbound } from "../../../src/chat/relay/inbound.ts";
import type { Outbox } from "../../../src/chat/relay/outbox.ts";
import { RelayProvider } from "../../../src/chat/relay/provider.ts";
import { setWriter } from "../../../src/log.ts";
import type { Draft } from "../../../src/protocol/outbox.ts";
import { platform } from "../../relay/support.ts";

const self = new Uint8Array(32).fill(7);
const prompt = "ab".repeat(32) + "cd".repeat(16);
const ref = { channel: "01".repeat(32), thread: prompt };

const vectors = JSON.parse(
  readFileSync(
    new URL("../../protocol/content-vectors/session-text-content.json", import.meta.url),
    "utf8",
  ),
) as { texts: Array<{ name: string; content: Record<string, unknown> }> };
const vector = (name: string) =>
  (vectors.texts.find((t) => t.name === name) as { content: Record<string, unknown> }).content;

/** A provider over an outbox that records its drafts; `answers` says what each queue gives, in turn. */
function setup(answers: Array<boolean | Error> = []) {
  const queued: Draft[] = [];
  const outbox = {
    queue: async (_: unknown, draft: Draft) => {
      const answer = answers.shift() ?? true;
      queued.push(draft);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    holds: () => true,
  } as unknown as Outbox;
  const inbound = {
    closed: () => false,
    mine: new Set<string>(),
    replyOf: () => ({ name: new Uint8Array(16), text: "" }),
  } as unknown as Inbound;
  const provider = new RelayProvider(self, outbox, inbound, platform);
  const thread = provider.thread(ref);
  const body = (d: Draft | undefined) => JSON.parse(d?.content ?? "null");
  return { provider, thread, queued, body };
}

test("the relay declares the run line and the next prompt hint, and no loop card", () => {
  const { provider, thread } = setup();
  const { capabilities } = provider;
  assert.equal(capabilities.scheduledRunLine, true);
  assert.equal(capabilities.nextPromptHint, true);
  assert.equal(capabilities.loopCard, false);
  assert.equal(typeof thread.scheduledRun, "function");
  assert.equal(typeof thread.suggestNext, "function");
});

test("a run's line is a text of its own: kind 1, no re, say run, the time and the words", async () => {
  const w = setup();
  const content = vector("scheduled run line");
  await w.thread.scheduledRun?.(content.at as number);
  assert.equal(w.queued.length, 1);
  const [draft] = w.queued;
  assert.equal(draft?.kind, 1);
  assert.equal(draft?.re, undefined);
  assert.deepEqual(w.body(draft), { thread: prompt, ...content });
});

test("a guess is a text of its own: kind 1, no re, say next, no markdown", async () => {
  const w = setup();
  await w.thread.suggestNext?.("run the tests");
  const [draft] = w.queued;
  assert.equal(draft?.kind, 1);
  assert.equal(draft?.re, undefined);
  assert.deepEqual(w.body(draft), { thread: prompt, ...vector("suggested next prompt") });
  assert.equal("markdown" in w.body(draft), false);
});

test("a guess is cut to 2,000 characters", async () => {
  const w = setup();
  await w.thread.suggestNext?.("x".repeat(5000));
  assert.equal(w.body(w.queued[0]).next.length, 2000);
});

test("the cut never splits a character: a 4-byte one at the boundary stays whole or goes", async () => {
  const w = setup();
  await w.thread.suggestNext?.(`${"x".repeat(1999)}\u{1F600}y`);
  const cut = w.body(w.queued[0]).next as string;
  assert.equal(Array.from(cut).length, 2000);
  assert.equal(cut.endsWith("\u{1F600}"), true);
  assert.equal(/\p{Surrogate}/u.test(cut), false, "no lone surrogate");
});

test("both lands after the text the reply still holds", async () => {
  for (const write of [
    (t: ReturnType<typeof setup>["thread"]) => t.scheduledRun?.(1_763_999_940_000),
    (t: ReturnType<typeof setup>["thread"]) => t.suggestNext?.("run the tests"),
  ]) {
    const w = setup();
    const reply = w.thread.openReply(() => {}, prompt);
    await reply.text("held words");
    await write(w.thread);
    assert.deepEqual(
      w.queued.map((d) => d.kind),
      [4, 1],
    );
    assert.equal(w.body(w.queued[0]).markdown, "held words");
  }
});

test("a refused queue never rejects, is logged by name, and the run's reply goes on", async (t) => {
  const lines: string[] = [];
  const writer = setWriter((line) => lines.push(line));
  t.after(() => setWriter(writer));
  for (const [name, write] of [
    ["run", (t: ReturnType<typeof setup>["thread"]) => t.scheduledRun?.(1)],
    ["next", (t: ReturnType<typeof setup>["thread"]) => t.suggestNext?.("run the tests")],
  ] as const) {
    for (const answer of [false, new Error("disk")]) {
      const w = setup([answer]);
      await assert.doesNotReject(async () => write(w.thread), name);
      assert.equal(w.queued.length, 1);
    }
  }
  assert.equal(lines.length, 4);
  assert.ok(
    lines.some((line) => line.includes("Error")),
    "an error is named",
  );
  assert.ok(
    lines.every((line) => !line.includes("run the tests")),
    "no words in the log",
  );
});
