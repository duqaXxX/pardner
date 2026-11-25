/** `ThreadChat.share` of the relay chat (design G 3.4): a file row written through `queueFile`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Inbound } from "../../../src/chat/relay/inbound.ts";
import type { Outbox } from "../../../src/chat/relay/outbox.ts";
import { RelayProvider } from "../../../src/chat/relay/provider.ts";
import type { ChatError } from "../../../src/chat/seam.ts";
import type { Draft } from "../../../src/protocol/outbox.ts";
import { platform } from "../../relay/support.ts";

const self = new Uint8Array(32).fill(7);
const ref = { channel: "01".repeat(32), thread: "ab".repeat(32) + "cd".repeat(16) };

function setup(says: "queued" | "too-large" | "refused" | "not-queued", gate?: Promise<void>) {
  const drafts: Draft[] = [];
  const outbox = {
    queueFile: async (_: unknown, draft: Draft) => {
      await gate;
      drafts.push(draft);
      return says;
    },
  } as unknown as Outbox;
  const provider = new RelayProvider(self, outbox, {} as Inbound, platform);
  return { provider, drafts };
}

test("the relay chat declares file upload with a 30 MB limit and no provider openFile", () => {
  const { provider } = setup("queued");
  assert.equal(provider.capabilities.fileUpload, true);
  assert.equal(provider.fileLimit, 31_457_280);
  assert.equal((provider as { openFile?: unknown }).openFile, undefined);
});

test("share writes a file row with the file and resolves only once it is appended", async () => {
  let open = () => {};
  const { provider, drafts } = setup("queued", new Promise<void>((r) => (open = r)));
  let done = false;
  const shared = provider
    .thread(ref)
    .share?.({ name: "a.ts", title: "src/a.ts", content: new Uint8Array([1, 2, 3]) })
    .then((id) => {
      done = true;
      return id;
    });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false, "not before the append");
  open();
  assert.equal(await shared, null);
  const [d] = drafts;
  assert.equal(d?.kind, 1);
  assert.deepEqual(JSON.parse(d?.content ?? "{}"), {
    thread: ref.thread,
    say: "file",
    title: "src/a.ts",
  });
  assert.deepEqual([d?.files?.[0]?.name, [...(d?.files?.[0]?.bytes ?? [])]], ["a.ts", [1, 2, 3]]);
});

test("a file the relay does not take fails the share with a reason the owner can read", async () => {
  for (const [says, reason, failure] of [
    ["too-large", "it is too large for the relay", "refused"],
    ["refused", "the relay did not take it", "refused"],
    ["not-queued", "the bot could not send it", "failed"],
  ] as const) {
    const { provider } = setup(says);
    await assert.rejects(
      provider
        .thread(ref)
        .share?.({ name: "a", title: "a", content: new Uint8Array(1) }) as Promise<unknown>,
      (e: ChatError) => e.name === reason && e.failure === failure,
    );
  }
});
