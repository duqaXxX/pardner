/**
 * The images a call's result holds (step E2 design 3.1), as the renderer hands them to a sink: once,
 * after the line's end, for a call of the turn's own, to a chat that declares `lineImages`. The core
 * never reads the bytes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallImage, SessionEvent } from "../../../src/agent/seam.ts";
import type { TaskUpdate } from "../../../src/chat/seam.ts";
import { Previews } from "../../../src/core/reply/previews.ts";
import { type Sink, TurnRenderer } from "../../../src/core/reply/renderer.ts";
import { MEMORY_NAMES } from "../../support/names.ts";
import { PLAIN_TOOLS } from "../../support/plain-agent.ts";

class Imaged implements Sink {
  readonly log: string[] = [];
  readonly images: Array<[string, readonly CallImage[]]> = [];
  async text(value: string): Promise<void> {
    this.log.push(`text ${value}`);
  }
  async task(update: TaskUpdate): Promise<void> {
    this.log.push(`task ${update.id} ${update.status}`);
  }
  async image(id: string, images: readonly CallImage[]): Promise<void> {
    this.log.push(`image ${id}`);
    this.images.push([id, images]);
  }
  async finish(): Promise<void> {}
  async closeOut(): Promise<boolean> {
    return true;
  }
  async waitLanded(): Promise<boolean> {
    return true;
  }
  async settle(): Promise<boolean> {
    return true;
  }
}

const SHOT: CallImage = { mediaType: "image/png", data: Uint8Array.of(137, 80, 78, 71) };

function renderer(sink: Sink, lineImages = true): TurnRenderer {
  return new TurnRenderer(
    sink,
    MEMORY_NAMES,
    new Previews(PLAIN_TOOLS),
    null,
    true,
    () => false,
    (id) => id,
    () => false,
    () => 0,
    (text) => text,
    () => false,
    lineImages,
  );
}

const start = (callId: string, parentCallId: string | null = null): SessionEvent => ({
  type: "call_started",
  callId,
  toolName: "run",
  input: { command: "shot", summary: "shot", line: "shot" },
  parentCallId,
});

const end = (
  callId: string,
  images: readonly CallImage[],
  parentCallId: string | null = null,
): SessionEvent => ({
  type: "call_ended",
  callId,
  isError: false,
  output: "done",
  images,
  fileChange: null,
  model: null,
  parentCallId,
});

test("a call's images are handed over once, after its line's end", async () => {
  const sink = new Imaged();
  const r = renderer(sink);
  await r.feed(start("c1"));
  await r.feed(end("c1", [SHOT, SHOT]));
  assert.equal(sink.log.at(-2), "task c1 complete");
  assert.equal(sink.log.at(-1), "image c1");
  assert.equal(sink.images.length, 1);
  assert.deepEqual(sink.images[0], ["c1", [SHOT, SHOT]]);
});

test("a call with no image hands over none", async () => {
  const sink = new Imaged();
  const r = renderer(sink);
  await r.feed(start("c1"));
  await r.feed(end("c1", []));
  assert.deepEqual(sink.images, []);
});

test("a call a subagent made hands over none", async () => {
  const sink = new Imaged();
  const r = renderer(sink);
  await r.feed(start("c1"));
  await r.feed(start("inner", "c1"));
  await r.feed(end("inner", [SHOT], "c1"));
  await r.feed(end("c1", []));
  assert.deepEqual(sink.images, []);
});

test("a sink of a chat that does not declare lineImages is handed none", async () => {
  const sink = new Imaged();
  const r = renderer(sink, false);
  await r.feed(start("c1"));
  await r.feed(end("c1", [SHOT]));
  assert.deepEqual(sink.images, []);
});

test("a sink with no image member is handed nothing, whatever the chat declares", async () => {
  const sink = new Imaged();
  const plain: Sink = {
    text: (value) => sink.text(value),
    task: (update) => sink.task(update),
    finish: () => sink.finish(),
    closeOut: () => sink.closeOut(),
    waitLanded: () => sink.waitLanded(),
    settle: () => sink.settle(),
  };
  const r = renderer(plain);
  await r.feed(start("c1"));
  await assert.doesNotReject(r.feed(end("c1", [SHOT])));
  assert.deepEqual(sink.images, []);
});

test("a call the renderer drew no line for hands over none", async () => {
  const sink = new Imaged();
  const r = renderer(sink);
  await r.feed(end("never-started", [SHOT]));
  assert.deepEqual(sink.images, []);
});
