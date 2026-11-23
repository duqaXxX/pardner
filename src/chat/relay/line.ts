/**
 * A turn's line as the thread carries it (turn work design 2.2, 2.5): the core's `TaskUpdate` without
 * the fields the app never reads, kept within the room a message body has.
 */

import type { TaskUpdate } from "../seam.ts";

/** The line as written: `startedAt` in wall-clock milliseconds, and no id, tool name or fold. */
export type Line = Omit<TaskUpdate, "id" | "name" | "folded" | "startedAt"> & {
  readonly startedAt: number | null;
};

/** The three fields that may be cut, in the order they are (the preview's body first). */
const CUTS: readonly [(l: Line) => string | null, (l: Line, v: string) => Line][] = [
  [
    (l) => l.preview?.body ?? null,
    (l, v) => ({ ...l, preview: l.preview && { ...l.preview, body: v } }),
  ],
  [(l) => l.details, (l, v) => ({ ...l, details: v })],
  [(l) => l.output, (l, v) => ({ ...l, output: v })],
];

/** The bytes `text` takes inside a JSON string, quotes left out. */
const escaped = (text: string) => Buffer.byteLength(JSON.stringify(text)) - 2;

/** The first `count` characters of `text`, none cut inside a surrogate pair. */
const prefix = (text: string, count: number) => {
  const end = /[\ud800-\udbff]/.test(text[count - 1] ?? "") ? count - 1 : count;
  return text.slice(0, end);
};

/** The largest `n` in `[low, high]` for which `fits(n)`, or `low - 1` when none does. */
function largest(low: number, high: number, fits: (n: number) => boolean): number {
  let best = low - 1;
  for (let a = low, b = high; a <= b; ) {
    const mid = (a + b) >> 1;
    if (fits(mid)) {
      best = mid;
      a = mid + 1;
    } else b = mid - 1;
  }
  return best;
}

/**
 * `text` cut to at most `room` bytes inside a JSON string: whole lines and `\n… +N lines`, or, when the first
 * line alone is too long, that line cut between characters, `…`, and the count when more lines followed.
 * When not even that fits, the shortest form of it (the caller goes on to the next field).
 */
function cutText(text: string, room: number): string {
  if (escaped(text) <= room) return text;
  const lines = text.split("\n");
  const marker = (dropped: number) => `… +${dropped} lines`;
  // Bytes of the first `n` lines each followed by a newline (two bytes in JSON), in a running sum.
  const sums = [0];
  for (const [i, line] of lines.entries()) sums.push((sums[i] as number) + escaped(line) + 2);
  const keep = largest(
    1,
    lines.length - 1,
    (n) => (sums[n] as number) + Buffer.byteLength(marker(lines.length - n)) <= room,
  );
  if (keep >= 1) return `${lines.slice(0, keep).join("\n")}\n${marker(lines.length - keep)}`;
  const tail = lines.length > 1 ? `\n${marker(lines.length - 1)}` : "";
  const first = lines[0] as string;
  const spare = room - escaped(tail) - 3; // the tail, and the ellipsis after the cut line
  const chars = largest(0, first.length, (n) => escaped(prefix(first, n)) <= spare);
  return `${prefix(first, Math.max(chars, 0))}…${tail}`;
}

/**
 * The serialized body of `line` (`frame` holds the fields before the line) within `room` bytes of UTF-8,
 * or undefined when cutting the three fields is not enough. The longest of the preview's body, the details
 * and the output (that order breaks a tie) is cut to the room the rest leaves, and when cutting it to its
 * shortest form is not enough the next longest is cut too.
 */
export function fitLine(frame: object, line: Line, room: number): string | undefined {
  const body = (l: Line) => JSON.stringify({ ...frame, task: l });
  let current = line;
  const open = CUTS.filter(([get]) => (get(line) ?? "") !== "").sort(
    (x, y) => (y[0](line)?.length ?? 0) - (x[0](line)?.length ?? 0),
  );
  for (const [get, set] of open) {
    if (Buffer.byteLength(body(current)) <= room) break;
    const rest = Buffer.byteLength(body(set(current, "")));
    current = set(current, cutText(get(current) as string, room - rest)); // `rest` holds the field's quotes
  }
  const json = body(current);
  return Buffer.byteLength(json) <= room ? json : undefined;
}
