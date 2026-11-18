/**
 * The golden files: what the code does at one seam for every recorded SDK stream. They are
 * snapshots. `npm run golden` (`write-golden.ts`) writes them again from the code as it is, and
 * the golden tests fail when the code no longer produces what the files hold. A change to a
 * reply therefore shows as a diff under `test/golden/`, which is to be read before it is committed.
 *
 * The seam (`reply/<name>.json`): the calls `TurnRenderer` makes on its sink, in order. `whole` is
 * one renderer fed the whole recording, then closed as a finished turn is; `turns` is one fresh
 * renderer per turn. The recording goes through one `Translator`, as one session's would.
 *
 * The files must be byte-for-byte reproducible: no wall clock, keys sorted.
 */
import type { SessionEvent } from "../../src/agent/seam.ts";
import type { TaskUpdate } from "../../src/chat/seam.ts";
import { type Sink, TurnRenderer } from "../../src/core/reply/renderer.ts";
import { CLAUDE_PREVIEWS } from "./claude-tools.ts";
import type { Json, JsonObject } from "./fixtures.ts";
import { NAMES } from "./names.ts";
import { recordedEvents, splitTurns } from "./replay.ts";

type SinkCall =
  | { call: "text"; markdown: string; notice: boolean; ending: boolean }
  | { call: "task"; update: TaskUpdate }
  | { call: "finish"; closing: readonly TaskUpdate[] }
  | { call: "close_out" }
  | { call: "wait_landed" }
  | { call: "settle" };

/** Every call the renderer makes on its sink, as the plain objects the golden files hold. */
class RecordingSink implements Sink {
  calls: SinkCall[] = [];

  async text(
    markdown: string,
    options: { readonly notice?: boolean; readonly ending?: boolean } = {},
  ): Promise<void> {
    this.calls.push({
      call: "text",
      markdown,
      notice: options.notice ?? false,
      ending: options.ending ?? false,
    });
  }

  async task(update: TaskUpdate): Promise<void> {
    this.calls.push({ call: "task", update });
  }

  async finish(closing: readonly TaskUpdate[]): Promise<void> {
    this.calls.push({ call: "finish", closing });
  }

  async closeOut(): Promise<boolean> {
    this.calls.push({ call: "close_out" });
    return true;
  }

  async waitLanded(): Promise<boolean> {
    this.calls.push({ call: "wait_landed" });
    return true;
  }

  async settle(): Promise<boolean> {
    this.calls.push({ call: "settle" });
    return true;
  }
}

/** One renderer fed `events`, then closed as a finished turn is. */
async function replayReply(events: readonly SessionEvent[]): Promise<unknown> {
  const sink = new RecordingSink();
  // A fixed clock: a golden holds the same `startedAt` on every run.
  const renderer = new TurnRenderer(
    sink,
    NAMES,
    CLAUDE_PREVIEWS,
    null,
    true,
    () => false,
    (id) => id,
    () => false,
    () => 0,
  );
  for (const event of events) await renderer.feed(event);
  await renderer.close();
  await renderer.closeOut();
  return {
    calls: sink.calls,
    result_set: renderer.result !== null,
    running_tasks: renderer.runningTasks,
  };
}

/** What the reply seam does for a recording, as its golden file holds it. */
export async function replyGolden(name: string): Promise<JsonObject> {
  const events = recordedEvents(name);
  const turns: unknown[] = [];
  for (const turn of splitTurns(events)) turns.push(await replayReply(turn));
  return plain({ recording: name, whole: await replayReply(events), turns });
}

/** `value` as the JSON it is written as, so that a test compares what a file can hold. */
export function plain(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function sorted(value: Json): Json {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== "object" || value === null) return value;
  const keys = Object.keys(value).sort();
  return Object.fromEntries(keys.map((key) => [key, sorted(value[key] as Json)]));
}

/** The bytes of a golden file: keys sorted, one space of indent, a final line end. */
export function dump(value: Json): string {
  return `${JSON.stringify(sorted(value), null, 1)}\n`;
}
