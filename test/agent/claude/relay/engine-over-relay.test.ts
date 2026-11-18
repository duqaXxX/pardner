/**
 * The engine over the relay (plan 3.1): the session harness with the relay's `RelayProvider` as its
 * chat, over a real relay process, and alice's scripted device as the owner. Each block plays a
 * recording that crosses a member of the seam the relay implements, and asserts what alice reads
 * back as properties (every part names an answer that exists, texts in order, a request withdrawn
 * once), never as a snapshot.
 */
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { DARWIN } from "../../../relay/process-support.ts";
import {
  canUseToolCall,
  harnessFor,
  type Item,
  requestWhileStreaming,
  type Script,
  sdkMessages,
} from "../../../support/sessions.ts";
import {
  assertConsistent,
  FIRST,
  firstOptions,
  type Read,
  recordedQuestion,
  relayWorld,
  shownAs,
  turnSaying,
} from "./relay-session.ts";

/** The relay, the harness over it with `scripts`, and the bot connected. */
async function started(t: TestContext, scripts: Script[]) {
  const w = await relayWorld(t);
  try {
    const h = harnessFor(t, {}, w.setup)(...scripts);
    await w.attach(h);
    await w.connect();
    return { w, h };
  } catch (error) {
    await w.cleanUp();
    throw error;
  }
}

/** The answer of prompt `name` once it is read back, and the parts that name it. */
const answerOf = (read: Read, name: string) => read.answers.find((a) => a.re === name);
const partsOf = (read: Read, name: string) => {
  const answer = answerOf(read, name);
  return read.parts.filter((p) => p.re === answer?.name);
};

test(
  "a plain reply is parts naming the prompt's answer, which holds the whole text",
  DARWIN,
  async (t) => {
    const { w } = await started(t, [{ turns: [sdkMessages("tools")] }]);
    await w.begin("list the files");
    await w.until((read) => answerOf(read, FIRST) !== undefined);
    const read = await w.read();
    assertConsistent(read, w.thread);
    const parts = partsOf(read, FIRST);
    assert.ok(parts.length >= 1);
    const text = String(answerOf(read, FIRST)?.body.markdown);
    assert.ok(text.length > 0);
    assert.equal(parts.map((p) => String(p.body.markdown)).join(""), text);
    assert.deepEqual(read.requests, []);
  },
);

test("a reply over 64 KiB is several parts, none over the limit, in order", DARWIN, async (t) => {
  const long = Array.from({ length: 70_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(
    "",
  );
  const { w } = await started(t, [{ turns: [turnSaying(long)] }]);
  await w.begin("write a lot");
  await w.until((read) => answerOf(read, FIRST) !== undefined);
  const read = await w.read();
  assertConsistent(read, w.thread);
  const parts = partsOf(read, FIRST);
  assert.ok(parts.length >= 2, "a text over 64 KiB is cut into parts");
  for (const part of parts)
    assert.ok(Buffer.byteLength(String(part.body.markdown)) <= 65_536, "a part is over 64 KiB");
  const text = parts.map((p) => String(p.body.markdown)).join("");
  assert.ok(text.includes(long), "the parts hold the text in order, whole");
  assert.equal(String(answerOf(read, FIRST)?.body.markdown), text);
});

/** The first request alice can read, once there is one. */
async function request(w: Awaited<ReturnType<typeof started>>["w"], count = 1) {
  await w.until((read) => read.requests.length >= count);
  const read = await w.read();
  return read.requests[count - 1] as Read["requests"][number];
}

test(
  "a permission request is written, allowed by alice's answer, and the turn goes on",
  DARWIN,
  async (t) => {
    const ask = canUseToolCall("Bash", { command: "ls" });
    const { w, h } = await started(t, [{ turns: [[ask, ...sdkMessages("tools")]] }]);
    await w.begin("run ls");
    const asked = await request(w);
    assert.equal((asked.body.request as { type: string }).type, "permission");
    assert.equal(asked.body.thread, w.thread);
    await w.answer(asked.name, { type: "permission", allow: true });
    await w.until((read) => answerOf(read, FIRST) !== undefined);
    const read = await w.read();
    assertConsistent(read, w.thread);
    const result = h.clients[0]?.permissionResults[0];
    assert.ok(result !== undefined && "allow" in result && result.allow, "the agent was told yes");
    assert.equal(read.requests.length, 1);
    assert.ok(partsOf(read, FIRST).length >= 1, "the reply follows the answer");
    // The answered request is taken off alice's screen, once.
    assert.deepEqual(
      read.edits.map((e) => e.re),
      [asked.name],
    );
  },
);

test("a request the agent gives up is withdrawn once (kinds 9 and 11)", DARWIN, async (t) => {
  const abort = new AbortController();
  const turn: Item[] = [
    ...sdkMessages("tools").slice(0, 21),
    requestWhileStreaming("Bash", { command: "rm -rf build" }, "toolu_a", abort),
    ...sdkMessages("tools").slice(21),
  ];
  const { w, h } = await started(t, [{ turns: [turn] }]);
  await w.begin("clean");
  const asked = await request(w);
  abort.abort();
  await w.until((read) => read.edits.length >= 1);
  await w.until((read) => answerOf(read, FIRST) !== undefined);
  const read = await w.read();
  assertConsistent(read, w.thread);
  assert.deepEqual(
    read.edits.map((e) => [e.re, e.body.withdrawn]),
    [[asked.name, true]],
  );
  const refused = h.clients[0]?.permissionResults[0];
  assert.ok(refused !== undefined && "allow" in refused && !refused.allow);
  // A late answer to the withdrawn request reaches no one: it is answered, and the agent is not asked again.
  const late = await w.answer(asked.name, { type: "permission", allow: true });
  await w.replyAnswered(late.name);
  assert.equal(h.clients[0]?.permissionResults.length, 1);
});

test(
  "a question is answered by alice, her answers reach the agent, the form is kept",
  DARWIN,
  async (t) => {
    const recorded = recordedQuestion();
    const call = canUseToolCall(recorded.toolName, recorded.input);
    const { w, h } = await started(t, [{ turns: [[call, ...sdkMessages("tools")]] }]);
    await w.begin("ask me");
    const asked = await request(w);
    const shown = shownAs(asked.body);
    assert.equal(shown.type, "question");
    const answers = Object.fromEntries(
      Object.entries(firstOptions(shown)).map(([question, labels]) => [question, labels[0]]),
    );
    await w.answer(asked.name, { type: "question", answers, notes: {} });
    await w.until((read) => answerOf(read, FIRST) !== undefined);
    const read = await w.read();
    assertConsistent(read, w.thread);
    const result = h.clients[0]?.permissionResults[0];
    assert.ok(result !== undefined && "answered" in result && result.answered);
    assert.deepEqual(result.answers, answers);
    assert.equal(read.requests.length, 1);
    // The answered form is kept as one edit of the request: answered, in the prompt's thread.
    assert.deepEqual(read.edits, [{ re: asked.name, body: { thread: w.thread, answered: true } }]);
  },
);

test(
  "!stop typed by alice during a turn withdraws the open request once, and both prompts are answered",
  DARWIN,
  async (t) => {
    const ask = canUseToolCall("Bash", { command: "rm -rf build" });
    const { w, h } = await started(t, [{ turns: [[ask, ...sdkMessages("interrupt")]] }]);
    await w.begin("clean");
    const asked = await request(w);
    await w.prompt("!stop", w.thread);
    await w.until((read) => answerOf(read, FIRST) !== undefined && read.edits.length === 1);
    const read = await w.read();
    assertConsistent(read, w.thread);
    assert.deepEqual(
      read.edits.map((e) => [e.re, e.body.withdrawn]),
      [[asked.name, true]],
    );
    const refused = h.clients[0]?.permissionResults[0];
    assert.ok(refused !== undefined && "allow" in refused && !refused.allow);
    assert.equal(read.requests.length, 1);
    // The stop's own answer: the word is a prompt too, and the relay closes it.
    await w.until((r) => r.answers.length === 2);
  },
);

test(
  "a prompt sent during a turn reaches the agent at once and gets an answer of its own",
  DARWIN,
  async (t) => {
    const ask = canUseToolCall("Bash", { command: "ls" });
    const { w, h } = await started(t, [
      { turns: [[ask, ...turnSaying("first reply")], turnSaying("second reply")] },
    ]);
    await w.begin("first");
    const asked = await request(w);
    await w.prompt("second", w.thread);
    // The second prompt is read while the first turn waits on alice.
    await w.b.until(() => h.clients[0]?.queries.length === 2);
    await w.answer(asked.name, { type: "permission", allow: true });
    await w.until((read) => read.answers.length >= 2);
    const read = await w.read();
    assertConsistent(read, w.thread);
    assert.deepEqual(h.clients[0]?.queries, ["first", "second"]);
    const texts = read.answers.map((a) => String(a.body.markdown));
    assert.equal(texts.filter((x) => x.includes("first reply")).length, 1);
    assert.equal(texts.filter((x) => x.includes("second reply")).length, 1);
    // Each prompt's answer holds its own parts only.
    for (const answer of read.answers) {
      const own = read.parts.filter((p) => p.re === answer.name);
      if (own.length === 0) continue; // an answer with no parts holds its whole text itself
      assert.equal(own.map((p) => String(p.body.markdown)).join(""), answer.body.markdown);
    }
  },
);
