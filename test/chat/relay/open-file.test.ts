/**
 * A click answered with a file (design G 3.3) with the reader's own bytes: a prompt with `open` goes to
 * `ChatInbound.openFile`, never to `message`, and its answer is the prompt's kind 5 with the file as its blob.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { texts } from "../../../src/core/port.ts";
import { rig, wait } from "./inbound-rig.ts";

/** A rig with one thread opened by a prompt: the thread's id, and the queue emptied. */
async function threaded() {
  const r = rig();
  r.prompt({ text: "hello" });
  await r.feed();
  await r.echo();
  const thread = r.messages[0]?.ref.thread as string;
  r.queued.length = 0;
  return { r, thread };
}

const click = async (r: Awaited<ReturnType<typeof threaded>>["r"], thread: string | undefined) => {
  r.prompt({ text: "/open src/a.ts", open: true, ...(thread ? { thread } : {}) });
  await r.feed();
  await r.echo();
};
const answers = (r: Awaited<ReturnType<typeof threaded>>["r"]) =>
  r.queued.filter((q) => q.draft.kind === 5);

test("an open prompt is answered with kind 5, no text, its modified time and the file, and reaches no session", async () => {
  const { r, thread } = await threaded();
  const content = Buffer.from("const a = 1;\n");
  r.opening.run = async () => ({
    name: "a.ts",
    title: "src/a.ts",
    content,
    modified: 1_700_000_000_000,
  });
  await click(r, thread);
  await wait();
  assert.deepEqual(r.opening.asked, ["src/a.ts"]);
  assert.equal(r.messages.length, 1, "the core's message was not called for the click");
  const [a] = answers(r);
  assert.ok(a);
  assert.deepEqual(JSON.parse(a.draft.content), {
    thread,
    markdown: "",
    modified: 1_700_000_000_000,
  });
  assert.equal(a.draft.name, undefined, "no name: none can collide in the outbox");
  assert.equal(a.draft.files?.length, 1);
  assert.deepEqual(
    [a.draft.files?.[0]?.name, Buffer.from(a.draft.files?.[0]?.bytes ?? []).toString()],
    ["a.ts", "const a = 1;\n"],
  );
  assert.equal(r.store.saved.decided.size, 2, "decided in the same write as the answer");
});

test("a refusal answers the sentence and no file", async () => {
  const { r, thread } = await threaded();
  r.opening.run = async () => ({ refusal: "That is not a file of this session." });
  await click(r, thread);
  await wait();
  const [a] = answers(r);
  assert.deepEqual(JSON.parse(a?.draft.content ?? "{}"), {
    thread,
    markdown: "That is not a file of this session.",
  });
  assert.equal(a?.draft.files, undefined);
});

test("an open prompt with no thread is answered OPEN_TOP_LEVEL as a message", async () => {
  const r = rig();
  await click(r, undefined);
  await wait();
  const [a] = answers(r);
  assert.equal(JSON.parse(a?.draft.content ?? "{}").markdown, texts.OPEN_TOP_LEVEL);
  assert.equal(JSON.parse(a?.draft.content ?? "{}").session, false);
  assert.deepEqual([r.opening.asked, r.messages.length], [[], 0]);
});

test("an open prompt does not set the prompt a request names, and a slow openFile holds no later prompt", async () => {
  const { r, thread } = await threaded();
  const first = r.inbound.promptOf(r.messages[0]?.ref as never);
  r.opening.run = () => new Promise(() => {}); // never resolves
  await click(r, thread);
  assert.deepEqual(r.inbound.promptOf({ channel: "", thread }), first);
  r.prompt({ text: "next", thread });
  await r.feed();
  await r.echo();
  assert.equal(r.messages.length, 2, "the later prompt reached the core while the file is read");
  assert.equal(r.messages[1]?.text, "next");
});

test("a relay that takes no file answers SHARE_REFUSED with its reason, and the prompt is decided", async () => {
  for (const [says, why] of [
    ["too-large", "it is too large for the relay"],
    ["refused", "the relay did not take it"],
  ] as const) {
    const { r, thread } = await threaded();
    r.files.says = says;
    r.opening.run = async () => ({
      name: "a.ts",
      title: "src/a.ts",
      content: Buffer.from("x"),
      modified: 1,
    });
    await click(r, thread);
    await wait();
    const [a] = answers(r);
    assert.equal(
      JSON.parse(a?.draft.content ?? "{}").markdown,
      texts.SHARE_REFUSED.replace("{path}", "src/a.ts").replace("{error}", why),
    );
    assert.equal(a?.draft.files, undefined);
    assert.equal(r.store.saved.decided.size, 2);
  }
});

test("a core that throws answers a sentence", async () => {
  const { r, thread } = await threaded();
  r.opening.run = async () => {
    throw new Error("boom");
  };
  await click(r, thread);
  await wait();
  assert.equal(
    JSON.parse(answers(r)[0]?.draft.content ?? "{}").markdown,
    "The bot did not run this prompt.",
  );
});

test("a click whose file the bot could not keep is answered with the sentence, no file, and decided", async () => {
  const { r, thread } = await threaded();
  r.files.says = "not-queued";
  r.opening.run = async () => ({
    name: "a.ts",
    title: "src/a.ts",
    content: Buffer.from("x"),
    modified: 1,
  });
  await click(r, thread);
  await wait();
  const [a] = answers(r);
  assert.equal(
    JSON.parse(a?.draft.content ?? "{}").markdown,
    texts.SHARE_REFUSED.replace("{path}", "src/a.ts").replace(
      "{error}",
      "the bot could not send it",
    ),
  );
  assert.equal(a?.draft.files, undefined);
  assert.equal(r.store.saved.decided.size, 2);
});
