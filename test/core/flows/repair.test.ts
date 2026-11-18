/**
 * The core's crash repair (`flows/repair.ts`) over the memory chat with `rootStatus` on: which
 * replies, requests and root statuses of a crashed thread it repairs, what it clears from the
 * state and what it keeps for the next start, and how a refusal of the chat is told apart from a
 * message the chat no longer has. How a chat draws the stopped line is its own and is tested with it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ChatProvider, ThreadRef } from "../../../src/chat/seam.ts";
import { logger, repair } from "../../../src/core/flows/repair.ts";
import type { RequestKind } from "../../../src/core/state.ts";
import { StateStore } from "../../../src/core/state.ts";
import * as texts from "../../../src/core/texts.ts";
import { DAEMON, type MemoryChat, memoryChat } from "../../support/memory-chat.ts";
import { NO_SYNC } from "../../support/no-sync.ts";
import { STATE_MODULES } from "../../support/state-modules.ts";

const made: string[] = [];

after(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

class World {
  readonly directory = mkdtempSync(join(tmpdir(), "pardner-repair-"));
  readonly chat: MemoryChat;
  readonly provider: ChatProvider;
  readonly channel: string;
  readonly ref: ThreadRef;
  state: StateStore;

  constructor(options: { rootStatus?: boolean } = {}) {
    made.push(this.directory);
    this.chat = memoryChat({ rootStatus: options.rootStatus ?? true });
    this.provider = this.chat.provide({ sleep: async () => {}, time: () => 1_780_000_000 });
    this.channel = this.chat.openChannel("work");
    this.ref = this.chat.openThread(this.channel);
    this.state = new StateStore(join(this.directory, "state.json"), {
      modules: STATE_MODULES,
      sync: NO_SYNC,
    });
    this.state.bind(this.channel, this.directory);
    this.state.openThread(this.channel, this.ref.thread);
  }

  /** The thread's record in `state.json`. */
  get thread() {
    const found = this.state.thread(this.channel, this.ref.thread);
    assert.ok(found, "the thread is in state.json");
    return found;
  }

  /** A thread of its own in the same channel, the state knowing it. */
  another(): ThreadRef {
    const ref = this.chat.openThread(this.channel, "another thread");
    this.state.openThread(this.channel, ref.thread);
    return ref;
  }

  /** A reply the crash left open: the daemon wrote it and never ended it. */
  openReply(ref: ThreadRef = this.ref): string {
    const message = this.chat.write(ref.channel, ref.thread, DAEMON, "an answer", "reply");
    message.unfinished = true;
    this.state.replaceOpenReply(ref.channel, ref.thread, null, message.id);
    return message.id;
  }

  /** A request still showing its controls, in the state with its kind. */
  request(kind: RequestKind, ref: ThreadRef = this.ref): string {
    const message = this.chat.write(ref.channel, ref.thread, DAEMON, "a request", "request");
    message.pressable = true;
    this.state.addRequest(ref.channel, ref.thread, message.id, kind);
    return message.id;
  }

  /** The message as the chat shows it now; undefined once it is gone. */
  shown(id: string, ref: ThreadRef = this.ref) {
    return this.chat.messages(ref.channel, ref.thread).find((m) => m.id === id);
  }

  /** What the thread's messages hold, to see that a second start changes nothing. */
  snapshot(): string {
    return JSON.stringify([
      this.chat.messages(this.channel, this.ref.thread),
      this.chat.calls(),
      this.state.thread(this.channel, this.ref.thread),
    ]);
  }

  /** The core's repair, as the daemon runs it at start. */
  repair(chat: ChatProvider = this.provider): Promise<void> {
    return repair(chat, this.state);
  }
}

/** The state as a later start reads it, from the file. */
function reloaded(world: World): StateStore {
  return new StateStore(join(world.directory, "state.json"), {
    modules: STATE_MODULES,
    sync: NO_SYNC,
  });
}

test("a second start repairs nothing", async () => {
  const world = new World();
  world.openReply();
  world.request("question");
  world.state.setStatusPending(world.channel, world.ref.thread, "working");
  await world.repair();
  const after = world.snapshot();
  await world.repair();
  assert.equal(world.snapshot(), after);
  assert.deepEqual(world.chat.calls("showStatus").length, 1);
});

test("an open reply is ended where it stands with the stopped line, and the field clears", async () => {
  const world = new World();
  const id = world.openReply();
  await world.repair();
  const reply = world.shown(id);
  assert.ok(reply);
  assert.equal(reply.text, `an answer\n${texts.STOPPED_BEFORE_ANSWER}`);
  assert.equal(reply.unfinished, false);
  assert.equal(world.chat.messages(world.channel, world.ref.thread).length, 2, "nothing is posted");
  assert.deepEqual(world.thread.openReplies, []);
});

test("a reply the chat refuses to end keeps its field for the next start, which ends it", async (t) => {
  const warnings: string[] = [];
  t.mock.method(logger, "warning", (message: string) => warnings.push(message));
  const world = new World();
  const id = world.openReply();
  world.chat.refuse("endReply", id, { once: true });
  await world.repair();
  assert.equal(world.shown(id)?.text, "an answer");
  assert.equal(world.shown(id)?.unfinished, true);
  assert.deepEqual(world.thread.openReplies, [id]);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.includes(`${world.channel}/${world.ref.thread}`));
  assert.ok(warnings[0]?.includes("a reply"));

  await world.repair();
  assert.ok(world.shown(id)?.text.endsWith(texts.STOPPED_BEFORE_ANSWER));
  assert.deepEqual(world.thread.openReplies, []);
});

test("more than one open reply in a thread are all repaired", async () => {
  // A background task's own reply can outlive the turn that started it: two open at once.
  const world = new World();
  const first = world.openReply();
  const second = world.openReply();
  await world.repair();
  for (const id of [first, second])
    assert.ok(world.shown(id)?.text.endsWith(texts.STOPPED_BEFORE_ANSWER));
  assert.deepEqual(world.thread.openReplies, []);
});

test("one reply the chat refuses does not stop the next one", async (t) => {
  t.mock.method(logger, "warning", () => {});
  const world = new World();
  const first = world.openReply();
  const second = world.openReply();
  world.chat.refuse("endReply", first);
  await world.repair();
  assert.deepEqual(world.thread.openReplies, [first]);
  assert.ok(world.shown(second)?.text.endsWith(texts.STOPPED_BEFORE_ANSWER));
});

test("a start the chat did not serve leaves the repair to the next one", async (t) => {
  // Every call of the repair refused: the three fields were cleared all the same, and the second
  // start made no call: the reply stayed open, the request kept its controls and the root its status.
  t.mock.method(logger, "warning", () => {});
  const world = new World();
  const reply = world.openReply();
  const request = world.request("question");
  const root = world.chat.rootOf(world.ref);
  assert.ok(root);
  world.state.setStatusPending(world.channel, world.ref.thread, "waiting");
  for (const [call, id] of [
    ["endReply", reply],
    ["withdraw", request],
    ["showStatus", root.id],
  ] as const) {
    world.chat.refuse(call, id, { once: true });
  }
  await world.repair();
  assert.deepEqual(world.thread.openReplies, [reply]);
  assert.deepEqual(world.thread.requests, [request]);
  assert.equal(world.thread.status, "waiting");
  // What a list of the sessions shows meanwhile: one that does not run.
  assert.equal(world.thread.ended, "error");
  assert.equal(world.shown(reply)?.unfinished, true);
  assert.equal(world.shown(request)?.pressable, true);

  await world.repair();
  assert.ok(world.shown(reply)?.text.endsWith(texts.STOPPED_BEFORE_ANSWER));
  assert.equal(world.shown(request), undefined);
  assert.deepEqual(
    world.chat.calls("showStatus").map((call) => call.args[0]),
    ["error", "error"],
  );
  assert.deepEqual(world.thread.openReplies, []);
  assert.deepEqual(world.thread.requests, []);
  assert.equal(world.thread.status, null);
  assert.equal(world.thread.ended, "error");

  const third = world.snapshot();
  await world.repair();
  assert.equal(world.snapshot(), third);
});

test("a reply, a request and a root the chat no longer has count as repaired", async (t) => {
  // The owner deleted the thread of a crashed session: nothing is left to ask about again.
  t.mock.method(logger, "warning", () => {});
  const world = new World();
  const reply = world.openReply();
  const request = world.request("question");
  const root = world.chat.rootOf(world.ref);
  assert.ok(root);
  world.state.setStatusPending(world.channel, world.ref.thread, "working");
  for (const id of [reply, request, root.id]) world.chat.remove(id);
  await world.repair();
  assert.deepEqual(world.thread.openReplies, []);
  assert.deepEqual(world.thread.requests, []);
  assert.equal(world.thread.status, null);
});

test("a request the chat did not withdraw stays for the next start, beside one it did", async (t) => {
  t.mock.method(logger, "warning", () => {});
  const world = new World();
  world.openReply();
  const kept = world.request("question");
  const gone = world.request("question");
  world.chat.refuse("withdraw", kept);
  await world.repair();
  assert.deepEqual(world.thread.requests, [kept]);
  assert.equal(world.shown(gone), undefined);
  assert.equal(world.shown(kept)?.pressable, true);
});

test("stale requests of a turn with a reply are withdrawn and a gone one still counts as done", async () => {
  const world = new World();
  world.openReply();
  const first = world.request("question");
  const second = world.request("question");
  world.chat.remove(second);
  await world.repair();
  assert.equal(world.shown(first), undefined);
  assert.deepEqual(world.thread.requests, []);
});

test("a root left waiting or working gets the error status, and the field clears", async () => {
  for (const status of ["waiting", "working"] as const) {
    const world = new World();
    world.state.setStatusPending(world.channel, world.ref.thread, status);
    await world.repair();
    assert.deepEqual(world.chat.calls("showStatus"), [
      { ref: world.ref, call: "showStatus", args: ["error", { notify: true }] },
    ]);
    assert.equal(world.thread.status, null, status);
    // What a list of the sessions shows for it from now on.
    assert.equal(world.thread.ended, "error", status);
  }
});

test("a root left waiting or working tells the owner its work failed", async () => {
  const world = new World();
  const other = world.another();
  world.state.setStatusPending(world.channel, world.ref.thread, "working");
  world.state.setStatusPending(world.channel, other.thread, null, "done"); // ended before the crash
  await world.repair();
  assert.deepEqual(world.chat.calls("showStatus"), [
    { ref: world.ref, call: "showStatus", args: ["error", { notify: true }] },
  ]);
});

test("a root whose error was shown before the crash is repaired without telling the owner again", async () => {
  // An answer that never reached the chat: the status was shown, and told, while `state.json`
  // kept the pending one for this repair.
  const world = new World();
  world.state.setStatusPending(world.channel, world.ref.thread, "working", "error");
  await world.repair();
  assert.deepEqual(world.chat.calls("showStatus"), [
    { ref: world.ref, call: "showStatus", args: ["error", { notify: false }] },
  ]);
  assert.equal(world.thread.status, null);
});

test("a root the chat will not show the error on keeps its word for the next start", async (t) => {
  t.mock.method(logger, "warning", () => {});
  const world = new World();
  const root = world.chat.rootOf(world.ref);
  assert.ok(root);
  world.state.setStatusPending(world.channel, world.ref.thread, "working");
  world.chat.refuse("showStatus", root.id);
  await world.repair();
  assert.equal(world.thread.status, "working");
  assert.equal(world.thread.ended, "error");
});

test("a chat with no root status has the stored word cleared", async () => {
  const world = new World({ rootStatus: false });
  world.state.setStatusPending(world.channel, world.ref.thread, "waiting");
  await world.repair();
  assert.equal(world.thread.status, null);
  assert.equal(world.thread.ended, "error");
});

test("a status that is neither working nor waiting is cleared with nothing shown", async () => {
  const world = new World();
  world.state.setStatusPending(world.channel, world.ref.thread, "done");
  await world.repair();
  assert.deepEqual(world.chat.calls("showStatus"), []);
  assert.equal(world.thread.status, null);
});

test("one thread's failure does not stop the others", async (t) => {
  const errors: string[] = [];
  t.mock.method(logger, "error", (message: string) => errors.push(message));
  const world = new World();
  const other = world.another();
  const reply = world.openReply();
  world.state.setStatusPending(world.channel, other.thread, "working");
  // A chat that throws for the first thread, as one whose call fails outright would.
  const failing = {
    capabilities: world.provider.capabilities,
    thread: (ref: ThreadRef) => {
      if (ref.thread === world.ref.thread) throw new Error("boom");
      return world.provider.thread(ref);
    },
  } as unknown as ChatProvider;
  await world.repair(failing);
  assert.deepEqual(world.thread.openReplies, [reply]);
  assert.equal(world.state.thread(world.channel, other.thread)?.status, null);
  assert.deepEqual(
    world.chat.calls("showStatus").map((call) => call.ref),
    [other],
  );
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.includes(`${world.channel}/${world.ref.thread}`));
  assert.ok(errors[0]?.includes("Error"));
});

test("repair stores no message content in the state file", async () => {
  const world = new World();
  const id = world.openReply();
  const message = world.chat.message(id);
  assert.ok(message);
  world.chat.edit(message, "secret");
  await world.repair();
  assert.ok(!readFileSync(join(world.directory, "state.json"), "utf8").includes("secret"));
});

test("a failed state write is logged and swallowed", async (t) => {
  const warnings: string[] = [];
  t.mock.method(logger, "warning", (message: string) => warnings.push(message));
  const world = new World();
  const id = world.openReply();
  t.mock.method(world.state, "replaceOpenReply", () => {
    throw new Error("disk full");
  });
  await world.repair(); // must not throw
  assert.ok(world.shown(id)?.text.endsWith(texts.STOPPED_BEFORE_ANSWER));
  assert.deepEqual(warnings, ["could not update state.json during crash repair: Error"]);
});

test("a request left by a turn with no reply becomes the stopped line, not a withdrawal", async () => {
  // The question or approval that opened the turn: a reply starts on its first write, so no reply
  // message exists. Withdrawing the request would leave the thread with the owner's message alone.
  const world = new World();
  const id = world.request("question");
  world.state.setStatusPending(world.channel, world.ref.thread, "waiting");
  await world.repair();
  const line = world.shown(id);
  assert.ok(line);
  assert.equal(line.text, texts.STOPPED_BEFORE_ANSWER);
  assert.equal(line.kind, "notice");
  assert.equal(line.pressable, false);
  assert.equal(world.chat.messages(world.channel, world.ref.thread).length, 2, "nothing is posted");
  assert.deepEqual(world.thread.requests, []); // it leaves the tracked list
  assert.deepEqual(world.thread.openReplies, []);
  assert.equal(world.thread.status, null);
  assert.equal(world.thread.ended, "error");
  const second = world.snapshot();
  await world.repair();
  assert.equal(world.snapshot(), second);
});

test("a request of a turn that had a reply is still withdrawn, the reply carrying the line", async () => {
  const world = new World();
  const reply = world.openReply();
  const request = world.request("question");
  await world.repair();
  assert.equal(world.shown(request), undefined);
  assert.ok(world.shown(reply)?.text.endsWith(texts.STOPPED_BEFORE_ANSWER));
  assert.equal(world.shown(reply)?.kind, "reply");
  assert.deepEqual(world.thread.requests, []);
});

test("with no reply only a question or an approval becomes the stopped line", async () => {
  // The setup form, the same-folder hold and the shell confirmation are requests too, but the
  // owner's message was never sent for them: a line saying the answer stopped would be false.
  for (const [kind, rewritten] of [
    ["question", true],
    ["approval", true],
    ["setup", false],
    ["hold", false],
    ["shell", false],
  ] as const) {
    const world = new World();
    const id = world.request(kind);
    await world.repair();
    const shown = world.shown(id);
    if (rewritten) assert.equal(shown?.text, texts.STOPPED_BEFORE_ANSWER, kind);
    else assert.equal(shown, undefined, kind);
    assert.deepEqual(world.thread.requests, [], kind);
    assert.deepEqual(world.thread.requestKinds, {}, kind);
  }
});

test("with a reply every kind of request is withdrawn", async () => {
  for (const kind of ["question", "approval", "setup", "hold", "shell"] as const) {
    const world = new World();
    const reply = world.openReply();
    const id = world.request(kind);
    await world.repair();
    assert.equal(world.shown(id), undefined, kind);
    assert.ok(world.shown(reply)?.text.endsWith(texts.STOPPED_BEFORE_ANSWER), kind);
    assert.equal(
      world.chat
        .messages(world.channel, world.ref.thread)
        .filter((m) => m.text === texts.STOPPED_BEFORE_ANSWER).length,
      0,
      kind,
    );
  }
});

test("a request with no kind, written before the kinds, is withdrawn", async () => {
  const world = new World();
  const message = world.chat.write(world.channel, world.ref.thread, DAEMON, "a request", "request");
  const path = join(world.directory, "state.json");
  const file = JSON.parse(readFileSync(path, "utf8"));
  file.channels[world.channel].threads[world.ref.thread].requests = [message.id];
  writeFileSync(path, JSON.stringify(file));
  world.state = reloaded(world);
  await world.repair();
  assert.equal(world.shown(message.id), undefined);
  assert.deepEqual(world.thread.requests, []);
});

test("two requests with no reply leave one stopped line, the other is withdrawn", async () => {
  const world = new World();
  const first = world.request("question");
  const second = world.request("approval");
  await world.repair();
  assert.equal(world.shown(first)?.text, texts.STOPPED_BEFORE_ANSWER);
  assert.equal(world.shown(second), undefined);
  assert.deepEqual(world.thread.requests, []);
});

test("a refused rewrite does not use up the thread's stopped line", async (t) => {
  t.mock.method(logger, "warning", () => {});
  const world = new World();
  const first = world.request("question");
  const second = world.request("question");
  world.chat.refuse("rewrite", first);
  await world.repair();
  assert.equal(world.shown(first), undefined, "withdrawn in place of rewritten");
  assert.equal(world.shown(second)?.text, texts.STOPPED_BEFORE_ANSWER);
});

test("a request that cannot be rewritten is withdrawn, and kept when that fails too", async (t) => {
  const warnings: string[] = [];
  t.mock.method(logger, "warning", (message: string) => warnings.push(message));
  const world = new World();
  const id = world.request("question");
  world.chat.refuse("rewrite", id);
  await world.repair();
  assert.equal(world.shown(id), undefined);
  assert.deepEqual(world.thread.requests, []);
  assert.ok(warnings.some((line) => line.includes("could not rewrite a stale request")));

  const other = new World();
  const kept = other.request("question");
  other.chat.refuse("rewrite", kept);
  other.chat.refuse("withdraw", kept);
  await other.repair();
  assert.deepEqual(other.thread.requests, [kept]);
  assert.equal(other.shown(kept)?.pressable, true);
});

test("a request whose message is gone counts as repaired, rewritten or not", async () => {
  const world = new World();
  const id = world.request("question");
  world.chat.remove(id);
  await world.repair();
  assert.deepEqual(world.thread.requests, []);
});
