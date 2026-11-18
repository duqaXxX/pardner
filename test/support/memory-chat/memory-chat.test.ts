/**
 * The memory chat's own behaviour, beyond what the conformance suite asks of any provider: the
 * names it makes, the date it records, what a reply shows, the calls it records for a capability
 * it lacks, and the chat outliving a provider.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChatError,
  type ChatInbound,
  type FooterFields,
  type TaskUpdate,
} from "../../../src/chat/seam.ts";
import { memoryChat, OWNER } from "../memory-chat.ts";
import { releasing } from "./provider.ts";

let now = 1_780_000_000;
const CLOCK = { sleep: async () => {}, time: () => now };

const NOBODY: ChatInbound = {
  message: async () => {},
  answer: async () => true,
  picked: async () => {},
  unbound: async () => {},
  rootGone: async () => {},
  stop: async () => false,
};

async function built(chat = memoryChat()) {
  const provider = await chat.build({
    variables: {},
    allowedRoot: "/work",
    scratchDir: "/scratch",
    clock: CLOCK,
    steady: CLOCK,
    core: () => {
      throw new Error("the memory chat never reads the core");
    },
  });
  return { chat, provider, channel: chat.openChannel("work") };
}

function line(id: string, title: string, folded: string | null = null): TaskUpdate {
  return {
    id,
    title,
    status: "complete",
    details: null,
    output: null,
    name: "Read",
    task: false,
    message: false,
    calls: 0,
    preview: null,
    folded,
    startedAt: null,
  };
}

test("its identities are the ones it is given, and one default otherwise", async () => {
  assert.deepEqual(
    (await built(memoryChat({ identities: ["T000ACME:U000BOT", "app-token:0123abcd"] }))).provider
      .identities,
    ["T000ACME:U000BOT", "app-token:0123abcd"],
  );
  const { provider } = await built();
  assert.deepEqual(provider.identities, ["memory:daemon"]);
});

test("its names are no numbers, and a thread is dated from the clock of its context", async () => {
  const { chat, provider, channel } = await built();
  await provider.start(NOBODY);
  now = 1_780_000_100;
  const sent = await chat.as(OWNER).says(channel, "hello");
  for (const name of [sent.id, sent.ref.thread, channel]) {
    assert.ok(Number.isNaN(Number(name)), `${name} reads as a number`);
  }
  assert.equal(provider.openedAt(sent.ref), 1_780_000_100);
  assert.equal(provider.openedAt({ channel, thread: "nothing" }), null);
});

test("a reply is one message: text and task lines in order, what runs, then the footer", async () => {
  const { chat, provider, channel } = await built();
  const ref = chat.openThread(channel);
  const reply = provider.thread(ref).openReply(() => {});
  await reply.text("First words\n\n");
  await reply.task(line("a", "Read a.txt"));
  await reply.text("More words");
  await reply.task(line("a", "Read a.txt (again)"));
  await reply.task(line("b", "Read b.txt", "Read 1 file"));
  await reply.task(line("c", "Read c.txt", ""));
  assert.deepEqual(chat.texts(channel, ref.thread).slice(1), [
    "First words\n[complete] Read a.txt (again)\nMore words\n[complete] Read b.txt\n[complete] Read c.txt",
  ]);
  await reply.finish([]);
  await reply.closeOut();
  await reply.showFooter({
    bypass: true,
    planning: false,
    model: "model-a",
    effort: null,
    advisor: null,
    effortObserved: null,
    folder: "/work",
    branch: null,
    gitUntrusted: false,
    changes: [3, 1],
    sessionTokens: null,
    contextPercent: 12,
    sessionLimit: null,
    weekLimit: null,
    account: null,
    accountPlan: null,
    work: null,
  });
  provider
    .thread(ref)
    .showRunning({ title: "1 shell still running", lines: [{ text: "Sleep", agent: null }] });
  assert.deepEqual(chat.texts(channel, ref.thread).slice(1), [
    "First words\n[complete] Read a.txt (again)\nMore words\nRead 1 file\n1 shell still running\n- Sleep\nbypass · model-a · /work · +3 -1 · 12% context",
  ]);
  provider.thread(ref).showRunning(null);
  assert.ok(!chat.texts(channel, ref.thread).join().includes("1 shell"));
});

test("a chat that cannot rewrite a message draws no list and posts the footer as a message", async () => {
  const { chat, provider, channel } = await built(memoryChat({ edits: false }));
  const ref = chat.openThread(channel);
  const thread = provider.thread(ref);
  const reply = thread.openReply(() => {});
  await reply.text("An answer");
  await reply.finish([]);
  assert.equal(await reply.closeOut(), true);
  thread.showRunning({ title: "1 shell still running", lines: [{ text: "Sleep", agent: null }] });
  const footer = {
    bypass: false,
    planning: false,
    model: "model-a",
    effort: null,
    advisor: null,
    effortObserved: null,
    folder: "/work",
    branch: null,
    gitUntrusted: false,
    changes: null,
    sessionTokens: null,
    contextPercent: null,
    sessionLimit: null,
    weekLimit: null,
    account: null,
    accountPlan: null,
    work: null,
  };
  assert.equal(await reply.showFooter(footer), true, "the footer landed");
  assert.deepEqual(chat.texts(channel, ref.thread).slice(1), ["An answer", "model-a · /work"]);
});

test("a member a capability it lacks would serve is absent", async () => {
  const { chat, provider, channel } = await built();
  const thread = provider.thread(chat.openThread(channel));
  for (const member of [
    "showStatus",
    "clearStatus",
    "settleStatus",
    "acknowledge",
    "showActivity",
    "activityRefused",
  ] as const) {
    assert.equal(thread[member], undefined, member);
  }
  assert.equal(provider.statusMark, undefined);
});

test("the chat outlives a provider: a new one over the same entry sees the threads", async () => {
  const { chat, provider, channel } = await built();
  await provider.start(NOBODY);
  now = 1_780_000_200;
  const sent = await chat.as(OWNER).says(channel, "before the restart");
  await provider.stop();
  const next = await built(chat);
  assert.equal(chat.provider, next.provider);
  assert.equal(next.provider.openedAt(sent.ref), 1_780_000_200);
  assert.deepEqual(chat.texts(channel), ["before the restart"]);
});

test("a thread that is not there takes no message", async () => {
  const { chat, channel } = await built();
  await assert.rejects(chat.as(OWNER).says(channel, "hi", { thread: "nothing" }), /no thread/);
});

test("the footer goes under the reply it is drawn on, and a footer drawn before stays", async () => {
  const { chat, provider, channel } = await built();
  const sent = await chat.as(OWNER).says(channel, "hello");
  const thread = provider.thread(sent.ref);
  const footer = {
    bypass: false,
    planning: false,
    model: "model-a",
    effort: null,
    advisor: null,
    effortObserved: null,
    folder: null,
    branch: null,
    gitUntrusted: false,
    changes: null,
    sessionTokens: null,
    contextPercent: null,
    sessionLimit: null,
    weekLimit: null,
    account: null,
    accountPlan: null,
    work: null,
  };
  const upper = thread.openReply(() => {});
  await upper.text("Upper");
  await upper.finish([]);
  await upper.closeOut();
  const lower = thread.openReply(() => {});
  await lower.text("Lower");
  await lower.finish([]);
  await lower.closeOut();
  const withFooter = () =>
    chat
      .texts(channel, sent.ref.thread)
      .filter((text) => text.includes("model-a"))
      .map((text) => text.split("\n")[0]);
  assert.deepEqual(withFooter(), [], "an end shows none");
  // the session ends: the footer goes under the reply it names, and nowhere else
  assert.equal(await lower.showFooter(footer), true);
  assert.deepEqual(withFooter(), ["Lower"]);
  // a footer drawn earlier stays when a later end draws another under a newer reply
  const newest = thread.openReply(() => {});
  await newest.text("Newest");
  await newest.finish([]);
  await newest.closeOut();
  assert.equal(await newest.showFooter(footer), true);
  assert.deepEqual(withFooter(), ["Lower", "Newest"]);
});

test("the control of an update offer names the version, and the page's has no message", async () => {
  const { chat, provider, channel } = await built();
  const picks: unknown[] = [];
  await provider.start({ ...NOBODY, picked: async (pick) => void picks.push(pick) });
  await provider.channel(channel).offer(
    {
      type: "update",
      from: "0.3.0",
      to: "0.3.1",
      changelog: "https://example.test",
      sharing: [],
    },
    "Update pardner 0.3.0 → 0.3.1",
  );
  const [list] = chat.lists();
  assert.ok(list !== undefined);
  await assert.rejects(chat.as(OWNER).picks(list.message, "0.3.2"), /installs 0\.3\.1/);
  assert.equal(await chat.as(OWNER).picks(list.message, "0.3.1"), true);
  assert.equal(await chat.as(OWNER).picksOnPage("0.3.1"), true);
  assert.equal(await chat.as("U000OTHER").picksOnPage("0.3.1"), false);
  assert.deepEqual(picks, [
    { type: "update", channel, version: "0.3.1", list: list.message },
    { type: "update", channel: null, version: "0.3.1", list: null },
  ]);
});

test("a line told to the owner in a channel is a notice of the channel", async () => {
  const { chat, provider, channel } = await built();
  await provider.channel(channel).tell("An update is already under way");
  assert.deepEqual(chat.texts(channel), ["An update is already under way"]);
});

test("the four capabilities few chats have are declared only when asked", async () => {
  const none = (await built()).provider.capabilities;
  for (const name of [
    "nativeStreaming",
    "rootStatus",
    "acknowledgement",
    "activityLine",
  ] as const) {
    assert.equal(none[name], false, name);
    const { provider } = await built(memoryChat({ [name]: true }));
    assert.equal(provider.capabilities[name], true, name);
  }
});

test("rootStatus records the status calls in order with their arguments, and shows nothing", async () => {
  const { chat, provider, channel } = await built(memoryChat({ rootStatus: true }));
  const ref = chat.openThread(channel);
  const thread = provider.thread(ref);
  const before = chat.texts(channel, ref.thread);
  assert.equal(await thread.showStatus?.("working", { notify: true }), true);
  await thread.showStatus?.("waiting");
  await thread.settleStatus?.();
  await thread.clearStatus?.();
  assert.equal(provider.statusMark?.("done") === undefined, false);
  assert.deepEqual(
    chat.calls().map(({ ref: where, call, args }) => [where, call, args]),
    [
      [ref, "showStatus", ["working", { notify: true }]],
      [ref, "showStatus", ["waiting", undefined]],
      [ref, "settleStatus", []],
      [ref, "clearStatus", []],
      [null, "statusMark", ["done"]],
    ],
  );
  assert.deepEqual(chat.texts(channel, ref.thread), before);
});

test("acknowledgement and activityLine record their calls, and the refusal flag when it is read", async () => {
  const { chat, provider, channel } = await built(
    memoryChat({ acknowledgement: true, activityLine: true, activityRefused: true }),
  );
  const thread = provider.thread(chat.openThread(channel));
  await thread.acknowledge?.("m-1");
  thread.showActivity?.({ kind: "compacting" });
  thread.showActivity?.(null);
  assert.equal(thread.activityRefused, true);
  assert.deepEqual(
    chat.calls().map(({ call, args }) => [call, args]),
    [
      ["acknowledge", ["m-1"]],
      ["showActivity", [{ kind: "compacting" }]],
      ["showActivity", [null]],
      ["activityRefused", []],
    ],
  );
  assert.deepEqual(chat.calls("acknowledge").length, 1);
  assert.equal(
    (await built(memoryChat({ activityLine: true }))).provider.thread(chat.openThread(channel))
      .activityRefused,
    false,
  );
});

test("the texts handed to a reply are recorded as the calls were made, joined or not", async () => {
  for (const nativeStreaming of [false, true]) {
    const { chat, provider, channel } = await built(memoryChat({ nativeStreaming }));
    const reply = provider.thread(chat.openThread(channel)).openReply(() => {});
    await reply.text("one ");
    await reply.text("two");
    assert.deepEqual(
      chat.calls("text").map((c) => c.args),
      [["one "], ["two"]],
      String(nativeStreaming),
    );
  }
});

test("a refusal names one call on one message: the others are served, once or every time", async () => {
  const { chat, provider, channel } = await built(memoryChat({ rootStatus: true }));
  const ref = chat.openThread(channel);
  const thread = provider.thread(ref);
  const first = await provider.channel(channel).notice("first");
  const second = await provider.channel(channel).notice("second");
  assert.ok(first !== null && second !== null);

  chat.refuse("withdraw", first);
  assert.equal(await thread.withdraw(first), false);
  assert.equal(await thread.withdraw(first), false);
  assert.equal(await thread.withdraw(second), true);
  assert.ok(chat.texts(channel).includes("first"));
  assert.ok(!chat.texts(channel).includes("second"));

  chat.refuse("rewrite", first, { once: true });
  await assert.rejects(
    thread.rewrite(first, "changed"),
    (error) => error instanceof ChatError && error.failure === "refused",
  );
  await thread.rewrite(first, "changed");
  assert.ok(chat.texts(channel).includes("changed"));

  const reply = await new Promise<string>((resolve) => {
    const open = thread.openReply((_old, fresh) => {
      if (fresh !== null) resolve(fresh);
    });
    void open.text("words");
  });
  chat.refuse("endReply", reply);
  assert.equal(await thread.endReply(reply, "ended"), false);
  assert.ok(!chat.texts(channel, ref.thread).join().includes("ended"));
  assert.equal(await thread.endReply("m-none", "ended"), true);

  const root = chat.rootOf(ref);
  assert.ok(root !== null);
  chat.refuse("showStatus", root.id, { once: true });
  assert.equal(await thread.showStatus?.("working"), false);
  assert.equal(await thread.showStatus?.("working"), true);
  const other = provider.thread(chat.openThread(channel));
  assert.equal(await other.showStatus?.("working"), true);
});

test("task lines and footers are recorded with the texts, in the order they were handed over", async () => {
  const { chat, provider, channel } = await built();
  const reply = provider.thread(chat.openThread(channel)).openReply(() => {});
  await reply.text("words");
  await reply.task(line("a", "Read a.txt"));
  await reply.finish([]);
  await reply.closeOut();
  await reply.showFooter({
    bypass: false,
    planning: false,
    model: "model-a",
    advisor: null,
    effort: null,
    effortObserved: null,
    folder: "/work",
    branch: null,
    gitUntrusted: false,
    changes: null,
    sessionTokens: null,
    contextPercent: null,
    sessionLimit: null,
    weekLimit: null,
    account: null,
    accountPlan: null,
    work: { durationMs: 5, doneAt: 9 },
  });
  assert.deepEqual(
    chat.calls().map((call) => call.call),
    ["text", "task", "showFooter"],
  );
  const [drawn] = chat.calls("showFooter");
  assert.ok(drawn !== undefined);
  assert.deepEqual((drawn.args[0] as FooterFields).work, { durationMs: 5, doneAt: 9 });
});

test("a call held waits until it is released, and says it was reached", async () => {
  const { chat, provider, channel } = await built();
  const thread = provider.thread(chat.openThread(channel));
  const id = await provider.channel(channel).notice("first");
  assert.ok(id !== null);
  const held = chat.hold("withdraw");
  let done = false;
  const withdrawing = thread.withdraw(id).then((answer) => {
    done = true;
    return answer;
  });
  await held.reached.wait();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  assert.ok(chat.texts(channel).includes("first"));
  held.release();
  assert.equal(await withdrawing, true);
  assert.ok(!chat.texts(channel).includes("first"));
  // Released for good: the next call does not wait.
  assert.equal(await thread.withdraw(id), true);
});

test("a thread adopted by name is one the chat knows, and `written` lists what the daemon wrote", async () => {
  const { chat, provider, channel } = await built();
  const ref = { channel, thread: "thread-7" };
  assert.equal(chat.knowsThread(ref), false);
  chat.adopt(ref);
  assert.equal(chat.knowsThread(ref), true);
  await provider.thread(ref).notice("a line");
  await provider.channel(channel).notice("another");
  chat.write(channel, ref.thread, OWNER, "the owner's", "message");
  assert.deepEqual(
    chat.written(channel).map((message) => message.text),
    ["a line", "another"],
  );
  assert.deepEqual(chat.strayCalls(), []);
});

test("a reply whose end is refused answers false, stays unfinished, and the others end", async () => {
  const { chat, provider, channel } = await built();
  const thread = provider.thread(chat.openThread(channel));
  const first = thread.openReply(() => {});
  await first.text("one");
  const second = thread.openReply(() => {});
  await second.text("two");
  const [firstMessage, secondMessage] = chat.written(channel);
  assert.ok(firstMessage !== undefined && secondMessage !== undefined);
  chat.refuse("closeOut", firstMessage.id);
  assert.equal(await first.closeOut(), false);
  assert.equal(await first.waitLanded(), false);
  assert.equal(chat.written(channel)[0]?.unfinished, true);
  assert.equal(await second.closeOut(), true);
  assert.equal(chat.written(channel)[1]?.unfinished, false);
});

test("a held text waits for the release, and the held end is refused when it is let go", async () => {
  const { chat, provider, channel } = await built();
  const ref = chat.openThread(channel);
  const thread = provider.thread(ref);
  const reply = thread.openReply(() => {});
  await reply.text("before");
  const [message] = chat.written(channel);
  assert.ok(message !== undefined);
  const held = chat.hold("text");
  let written = false;
  const writing = reply.text(" after").then(() => {
    written = true;
  });
  await held.reached.wait();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(written, false);
  assert.equal(chat.texts(channel, ref.thread).at(-1), "before");
  held.release();
  await writing;
  assert.equal(chat.texts(channel, ref.thread).at(-1), "before after");
  // An end held and refused: it answers false once it is let go.
  chat.refuse("closeOut", message.id);
  const ending = chat.hold("closeOut");
  const closing = reply.closeOut();
  await ending.reached.wait();
  ending.release();
  assert.equal(await closing, false);
});

test("the retry of a refused end is held until it is let go, and then says it did not land", async () => {
  const { chat, provider, channel } = await built();
  const reply = provider.thread(chat.openThread(channel)).openReply(() => {});
  await reply.text("words");
  const [message] = chat.written(channel);
  assert.ok(message !== undefined);
  chat.refuse("closeOut", message.id);
  const retry = chat.hold("waitLanded");
  assert.equal(await reply.closeOut(), false);
  let answer: boolean | null = null;
  const waiting = reply.waitLanded().then((landed) => {
    answer = landed;
  });
  await retry.reached.wait();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answer, null);
  retry.release();
  await waiting;
  assert.equal(answer, false);
});

test("a tell and a say are recorded with their options, and the chat derives nothing from them", async () => {
  const { chat, provider, channel } = await built(memoryChat());
  const ref = chat.openThread(channel);
  const thread = provider.thread(ref);
  await thread.tell("kept", { stays: true });
  await thread.tell("owner alone");
  await thread.say("read", { ownerOnly: true });
  await thread.say("read by all");
  assert.deepEqual(
    chat.calls().map(({ ref: where, call, args }) => [where, call, args]),
    [
      [ref, "tell", ["kept", { stays: true }]],
      [ref, "tell", ["owner alone", undefined]],
      [ref, "say", ["read", { ownerOnly: true }]],
      [ref, "say", ["read by all", undefined]],
    ],
  );
  // The same two lines on screen whatever the option: the room has no line for the owner alone.
  assert.deepEqual(chat.texts(channel, ref.thread).slice(1), [
    "kept",
    "owner alone",
    "read",
    "read by all",
  ]);
});

test("a call that rejects after its signal aborted is handled and the caller is released", async () => {
  const unhandled: unknown[] = [];
  const note = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", note);
  try {
    const stopped = new AbortController();
    stopped.abort(new Error("released"));
    const call = Promise.reject(new Error("the call failed"));
    await assert.rejects(releasing(call, stopped.signal), /released/);
    await new Promise((resolve) => setImmediate(resolve)); // an unhandled rejection surfaces here
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", note);
  }
});
