/**
 * An image text (`say: "image"`, step E2 design 3.1) whose file is lost or refused is dropped whole and
 * logged, where G turns any other message into a text (design G 3.5): against a real relay in a child
 * process, as `outbox-files.test.ts`.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BlobFiles } from "../../../src/chat/relay/blob-files.ts";
import { DARWIN } from "../../relay/process-support.ts";
import { botOn, rig } from "./relay-rig.ts";

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) % 251);
const image = JSON.stringify({ thread: "t", say: "image", line: "11".repeat(16) });
const row = JSON.stringify({ thread: "t", say: "file", title: "a" });
const draft = (content: string, name: string) => ({
  kind: 1,
  content,
  files: [{ bytes: bytes(100), type: "image/png", name }],
});
const pretend = () => async () => 0;

test(
  "an image text whose blob file is lost at a restart is dropped whole and logged; a file row still becomes a text",
  DARWIN,
  async () => {
    const r = await rig();
    const first = botOn(r, { put: pretend });
    assert.equal(await first.outbox.queueFile(r.channel, draft(image, "image-1.png")), "queued");
    assert.equal(await first.outbox.queueFile(r.channel, draft(row, "a.txt")), "queued");
    assert.equal(await first.outbox.queueFile(r.channel, draft(image, "image-2.png")), "queued");
    const before = first.queued();
    await first.stop();
    const files = new BlobFiles(join(r.dir, "blobs"));
    for (const i of before.slice(0, 2)) files.remove(i.files[0]?.id as Uint8Array);
    writeFileSync(join(r.dir, "blobs", "ab".repeat(32)), "x");
    const b = botOn(r, { put: pretend });
    try {
      const now = b.queued();
      assert.deepEqual(
        now.map((i) => JSON.parse(i.content).say),
        ["tell", "image"],
        "the image text with no file is gone, the file row is a tell, the image with its file stays",
      );
      assert.equal(now[1]?.files.length, 1);
      assert.equal(b.lines.filter((l) => l.includes("an image was dropped")).length, 1);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "an image text whose put is refused or too large after the append is dropped whole and logged",
  DARWIN,
  async () => {
    const r = await rig();
    const first = botOn(r, { put: pretend });
    assert.equal(await first.outbox.queueFile(r.channel, draft(image, "image-1.png")), "queued");
    await first.stop();
    const b = botOn(r, { put: () => async () => 8 });
    try {
      b.connection.start();
      await b.until(() => b.queued().length === 0);
      assert.deepEqual((await r.held()).messages, [], "nothing of it was sent");
      assert.ok(
        b.lines.some((l) => l.includes("an image was dropped")),
        b.lines.join(" | "),
      );
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);
