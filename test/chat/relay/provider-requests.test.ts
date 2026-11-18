import assert from "node:assert/strict";
import { test } from "node:test";
import { Inbound } from "../../../src/chat/relay/inbound.ts";
import type { Outbox } from "../../../src/chat/relay/outbox.ts";
import { RelayProvider } from "../../../src/chat/relay/provider.ts";
import type { Store } from "../../../src/chat/relay/store.ts";
import { ChatError, type OwnerRequest } from "../../../src/chat/seam.ts";
import { Run } from "../../../src/protocol/outbox.ts";
import { platform } from "../../relay/support.ts";

const self = new Uint8Array(32).fill(7);
const thread = "ab".repeat(32) + "cd".repeat(16);
const hold: OwnerRequest = {
  type: "hold",
  requestId: "h",
  other: { channel: "c", thread: "t" },
  link: "l",
};

/** A provider over an outbox that queues as `queue` says; `queued` collects what it was given. */
function setup(queue: () => Promise<boolean> = async () => true) {
  const queued: { kind: number; content: string }[] = [];
  const outbox = {
    queue: async (_: unknown, draft: { kind: number; content: string }) => {
      queued.push(draft);
      return queue();
    },
  } as unknown as Outbox;
  const store = { saved: { incarnation: undefined, decided: new Map() } } as unknown as Store;
  const inbound = new Inbound({
    platform,
    self,
    store,
    outbox,
    run: new Run(platform),
    log: () => {},
  });
  const provider = new RelayProvider(self, outbox, inbound, platform);
  return { inbound, queued, chat: provider.thread({ channel: "01".repeat(32), thread }) };
}

const refused = (code: string) => (e: unknown) => e instanceof ChatError && e.message === code;

test("a queue that says false leaves no waiting request, and ask throws a ChatError", async () => {
  const { inbound, chat } = setup(async () => false);
  await assert.rejects(chat.ask("h", hold, "t"), refused("relay_not_queued"));
  assert.equal(inbound.waiting.size, 0);
});

test("a queue that rejects leaves no waiting request, and ask throws a ChatError", async () => {
  const { inbound, chat } = setup(async () => {
    throw new Error("EIO");
  });
  await assert.rejects(chat.ask("h", hold, "t"), refused("relay_not_queued"));
  assert.equal(inbound.waiting.size, 0);
});

test("an edit whose queue fails keeps the request waiting, and one that works ends it", async () => {
  let ok = false;
  const { inbound, chat } = setup(async () => ok);
  const id = await chat.ask("h", hold, "t").catch(() => "");
  assert.equal(id, ""); // not queued: nothing to withdraw
  ok = true;
  const made = await chat.ask("h", hold, "t");
  ok = false;
  assert.equal(await chat.withdraw(made), false);
  assert.equal(inbound.waiting.size, 1);
  await assert.rejects(chat.rewrite(made, "x"), refused("relay_not_queued"));
  assert.equal(inbound.waiting.size, 1);
  ok = true;
  assert.equal(await chat.withdraw(made), true);
  assert.equal(inbound.waiting.size, 0);
});

test("a thread that is no prompt's id has no prompt to name", async () => {
  const { inbound } = setup();
  const provider = new RelayProvider(
    self,
    { queue: async () => true } as unknown as Outbox,
    inbound,
    platform,
  );
  const bad = provider.thread({ channel: "01".repeat(32), thread: "t" });
  await assert.rejects(bad.ask("h", hold, "t"), refused("relay_no_prompt"));
});

test("a request over the frame is refused before anything is recorded or written", async () => {
  const { inbound, queued, chat } = setup();
  const big: OwnerRequest = {
    type: "permission",
    callId: "call-1",
    toolName: "Write",
    input: { text: "x".repeat(1_048_576) },
    title: null,
    description: null,
    plan: null,
  };
  await assert.rejects(chat.ask("h", big, "t"), refused("relay_too_large"));
  assert.deepEqual([inbound.waiting.size, queued.length], [0, 0]);
});

test("the body drops the core's request id and the agent's call id", async () => {
  const { queued, chat } = setup();
  await chat.ask(
    "h",
    {
      type: "permission",
      callId: "call-1",
      toolName: "Write",
      input: {},
      title: null,
      description: null,
      plan: null,
    },
    "t",
  );
  const body = JSON.parse(queued[0]?.content ?? "{}");
  assert.deepEqual(Object.keys(body.request).sort(), [
    "description",
    "input",
    "plan",
    "title",
    "toolName",
    "type",
  ]);
});

test("keepAnswers writes a kind 11 that says answered, and ends the request", async () => {
  const { inbound, queued, chat } = setup();
  const id = await chat.ask("h", hold, "t");
  await chat.keepAnswers(id, [], {});
  assert.equal(queued[1]?.kind, 11);
  assert.equal(JSON.parse(queued[1]?.content ?? "{}").answered, true);
  assert.equal(inbound.waiting.size, 0);
});
