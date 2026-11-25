/**
 * The images of a call as a text of the bot under its line (step E2 design 3.1): the content shape is
 * the shared vector file the app's tests read too; the outbox is a record whose `queueFile` is the one
 * G built. What matters most is the reply's chain: a put that never answers holds nothing behind it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Inbound } from "../../../src/chat/relay/inbound.ts";
import type { FileSent, Outbox } from "../../../src/chat/relay/outbox.ts";
import { RelayProvider } from "../../../src/chat/relay/provider.ts";
import type { Reply, TaskUpdate } from "../../../src/chat/seam.ts";
import { setWriter } from "../../../src/log.ts";
import type { Draft } from "../../../src/protocol/outbox.ts";

const self = new Uint8Array(32).fill(7);
const prompt = "ab".repeat(32) + "cd".repeat(16);
const ref = { channel: "01".repeat(32), thread: prompt };
/** Every name the provider draws is sixteen 0x11 bytes: the vector's line. */
const platform = {
  random: (n: number) => new Uint8Array(n).fill(0x11),
  now: () => 1_764_000_000_000,
};

const vectors = JSON.parse(
  readFileSync(
    new URL("../../protocol/content-vectors/session-text-content.json", import.meta.url),
    "utf8",
  ),
) as { texts: Array<{ name: string; content: Record<string, unknown> }> };
const vector = (name: string) =>
  (vectors.texts.find((t) => t.name === name) as { content: Record<string, unknown> }).content;

const PNG = { mediaType: "image/png", data: Uint8Array.of(137, 80, 78, 71) };
const timeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p.then(() => "done" as const),
    new Promise<"pending">((r) => setTimeout(() => r("pending"), ms)),
  ]);

const line = (id: string, over: Partial<TaskUpdate> = {}): TaskUpdate => ({
  id,
  title: "Read shot.png",
  status: "complete",
  details: null,
  output: null,
  name: "Read",
  task: false,
  message: false,
  agent: null,
  calls: 0,
  preview: null,
  folded: null,
  startedAt: null,
  ...over,
});

/** A provider over an outbox that records its drafts; `file` says what `queueFile` gives, or never answers. */
function setup(file: (draft: Draft) => Promise<FileSent> | FileSent = () => "queued") {
  const queued: Draft[] = [];
  const files: Draft[] = [];
  const held: Uint8Array[][] = [];
  const lines: string[] = [];
  const writer = setWriter((l) => lines.push(l));
  const outbox = {
    queue: async (_: unknown, draft: Draft) => {
      queued.push(draft);
      return true;
    },
    queueFile: (_: unknown, draft: Draft) => {
      files.push(draft);
      return Promise.resolve(file(draft));
    },
    holds: (names: Uint8Array[]) => {
      held.push(names);
      return true;
    },
    landed: async () => true,
    release() {},
  } as unknown as Outbox;
  const inbound = {
    closed: () => false,
    mine: new Set<string>(),
    replyOf: () => ({ name: new Uint8Array(16), text: "" }),
    expect() {},
    waiting: new Map(),
    promptOf: () => ({ device: new Uint8Array(32), name: new Uint8Array(16) }),
    end() {},
  } as unknown as Inbound;
  const provider = new RelayProvider(self, outbox, inbound, platform);
  const thread = provider.thread(ref);
  const reply = thread.openReply(() => {}, prompt);
  return { provider, thread, reply, queued, files, held, lines, restore: () => setWriter(writer) };
}

const image = (reply: Reply, id: string, images = [PNG]) => {
  assert.ok(reply.image);
  return reply.image(id, images);
};

test("the relay declares lineImages and its reply has image", () => {
  const w = setup();
  try {
    assert.equal(w.provider.capabilities.lineImages, true);
    assert.equal(typeof w.reply.image, "function");
  } finally {
    w.restore();
  }
});

test("a call's images are one text of the bot under its line: kind 1, no re, say image, the line's name, the images as files", async () => {
  const w = setup();
  try {
    await w.reply.task(line("c1"));
    const [first] = w.queued;
    assert.equal(first?.kind, 1);
    const jpeg = { mediaType: "image/jpeg", data: Uint8Array.of(255, 216) };
    await image(w.reply, "c1", [PNG, jpeg]);
    assert.equal(w.files.length, 1);
    const [draft] = w.files;
    assert.equal(draft?.kind, 1);
    assert.equal(draft?.re, undefined);
    assert.deepEqual(JSON.parse(draft?.content ?? "null"), {
      thread: prompt,
      ...vector("tool image under its line"),
    });
    assert.equal(
      JSON.parse(draft?.content ?? "{}").line,
      Buffer.from(first?.name ?? []).toString("hex"),
      "the line's message name",
    );
    assert.deepEqual(
      draft?.files?.map((f) => [f.name, f.type, [...f.bytes]]),
      [
        ["image-1.png", "image/png", [137, 80, 78, 71]],
        ["image-2.jpeg", "image/jpeg", [255, 216]],
      ],
    );
  } finally {
    w.restore();
  }
});

test("a file is named from the media type: png, jpeg, gif, webp, else img", async () => {
  const w = setup();
  try {
    await w.reply.task(line("c1"));
    const types = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"];
    await image(
      w.reply,
      "c1",
      types.map((mediaType) => ({ mediaType, data: Uint8Array.of(1) })),
    );
    assert.deepEqual(
      w.files[0]?.files?.map((f) => f.name),
      ["image-1.png", "image-2.jpeg", "image-3.gif", "image-4.webp", "image-5.img"],
    );
  } finally {
    w.restore();
  }
});

test("an image after the line's end update goes out, one for a line the reply wrote", async () => {
  const w = setup();
  try {
    await w.reply.task(line("c1", { status: "in_progress" }));
    await w.reply.task(line("c1"));
    await image(w.reply, "c1");
    assert.deepEqual(
      w.queued.map((d) => d.kind),
      [1, 11],
      "the line's text, then its end",
    );
    assert.equal(w.files.length, 1);
  } finally {
    w.restore();
  }
});

test("an image of a call with no line is dropped and the call's id logged", async () => {
  const w = setup();
  try {
    await image(w.reply, "toolu_unknown");
    assert.deepEqual(w.files, []);
    assert.equal(w.lines.filter((l) => l.includes("toolu_unknown")).length, 1, w.lines.join("|"));
  } finally {
    w.restore();
  }
});

test("an image above the chat's limit is dropped and logged by size; the others go", async () => {
  const w = setup();
  try {
    await w.reply.task(line("c1"));
    const big = { mediaType: "image/png", data: new Uint8Array(w.provider.fileLimit + 1) };
    await image(w.reply, "c1", [big, PNG]);
    assert.deepEqual(
      w.files[0]?.files?.map((f) => f.name),
      ["image-1.png"],
    );
    assert.equal(w.files[0]?.files?.[0]?.bytes.length, 4);
    assert.ok(
      w.lines.some((l) => l.includes(String(w.provider.fileLimit + 1)) && l.includes("c1")),
      w.lines.join("|"),
    );
    const alone = setup();
    try {
      await alone.reply.task(line("c1"));
      await image(alone.reply, "c1", [big]);
      assert.deepEqual(alone.files, [], "an image of none sent writes no text");
    } finally {
      alone.restore();
    }
  } finally {
    w.restore();
  }
});

test("the item is no part of the reply: a refused or failed put is logged, and the reply stays landed", async () => {
  for (const answer of ["refused", "too-large", "not-queued"] as const) {
    const w = setup(() => answer);
    try {
      await w.reply.task(line("c1"));
      await image(w.reply, "c1");
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(await w.reply.settle(), true);
      assert.ok(
        w.lines.some((l) => l.includes("c1") && l.includes(answer)),
        `${answer}: ${w.lines.join("|")}`,
      );
      const names = w.held.at(-1) ?? [];
      assert.equal(names.length, 0, "neither the line nor the image is a name of the reply");
    } finally {
      w.restore();
    }
  }
});

test("a queueFile that rejects is logged and never rejects the image", async () => {
  const w = setup(() => Promise.reject(new Error("disk")));
  try {
    await w.reply.task(line("c1"));
    await assert.doesNotReject(image(w.reply, "c1"));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(
      w.lines.some((l) => l.includes("c1")),
      w.lines.join("|"),
    );
  } finally {
    w.restore();
  }
});

// Round 1 of the design (E2-R1-1): a put the relay never answers must hold no later write of the reply,
// no `settle` and no request of the thread. The scratch proof `2026-11-24-e2-chain-stall-proof.test.ts`
// showed that a chain step which waited on the relay did; this is it turned around.
test("a put that never answers holds no later task, settle or request", async () => {
  const w = setup(() => new Promise<FileSent>(() => {}));
  try {
    await w.reply.task(line("c1"));
    const imaged = image(w.reply, "c1");
    assert.equal(
      await timeout(imaged, 300),
      "done",
      "the image resolves once sealed and kept aside",
    );
    assert.equal(w.files.length, 1, "queueFile was called before the image resolved");
    const later = w.reply.task(line("c2", { title: "Bash ls" }));
    const settled = w.reply.settle();
    const asked = w.thread.ask(
      "r-1",
      { type: "hold", requestId: "r-1", other: { channel: "c", thread: "t" }, link: "l" } as never,
      "A request",
    );
    assert.equal(await timeout(later, 300), "done", "the next call's line is written");
    assert.equal(await timeout(settled, 300), "done", "settle does not wait on the relay");
    assert.equal(await timeout(asked, 300), "done", "an approval card is written");
    assert.deepEqual(
      w.queued.map((d) => d.kind),
      [1, 1, 9],
    );
  } finally {
    w.restore();
  }
});
