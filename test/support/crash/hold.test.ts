/** `hold`, `await-hold` and `together` (crash images design 4.1): a sync waits after `sync start`, and what is sent meanwhile is written under it. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createNodePlatform } from "../../../src/platform-node/platform.ts";
import { DARWIN } from "../../relay/process-support.ts";
import { RelayProcess } from "../scripted-device/relay-process.ts";
import { parse, run } from "../scripted-device/script.ts";
import { recorded } from "./workload.ts";

type Row = { op: string; id?: number; phase?: string; path?: string };
/** The record index of the `sync start` that the `sync done` at `at` ends (ids restart in each process). */
const startOf = (recs: Row[], at: number) =>
  recs.findLastIndex(
    (r, i) => i < at && r.op === "sync" && r.phase === "start" && r.id === recs[at]?.id,
  );
const line = (o: object) => JSON.stringify(o);
const message = (as: string, run: string) => ({
  op: "submit",
  entry: "message",
  epoch: "e1",
  run,
  as,
  expect: "result 0",
});
const HELD = [
  { op: "prove", device: "app1", enrol: "s1", as: "g", expect: "served" },
  { op: "submit", entry: "create", as: "ch", expect: "result 0" },
  { op: "submit", entry: "epoch", as: "e1", expect: "result 0" },
  { op: "relay", act: "hold", files: ["journal"], ms: 400 },
  // The first message is pipelined: its round reaches the held sync, and the second is written while it waits.
  {
    op: "together",
    lists: [
      [
        { ...message("m1", "r1"), pipe: true },
        { op: "relay", act: "await-hold", file: "journal" },
        message("m2", "r2"),
      ],
    ],
  },
  { op: "read", from: 0, expect: { items: ["g", "ch", "e1", "m1", "m2"], n: 5 } },
]
  .map(line)
  .join("\n");

test("a held journal sync starts and the next submit is written under it", {
  ...DARWIN,
  timeout: 60_000,
}, async () => {
  const { rec } = await recorded(HELD);
  const recs = rec.records();
  const starts = new Map<number, number>();
  const under: number[] = [];
  recs.forEach((r, i) => {
    if (r.op === "sync" && r.phase === "start" && r.path === "relay/journal") starts.set(r.id, i);
    else if (r.op === "sync" && r.phase === "done") starts.delete(r.id);
    else if (r.op === "write" && r.path === "relay/journal" && starts.size > 0) under.push(i);
  });
  assert.equal(under.length, 1, "the second item is written between a sync start and its done");
  // Design 7.4: no answer is bound below the `sync done` that covers its journal write, also on a held round.
  const writes = recs
    .flatMap((r, i) => (r.op === "write" && r.path === "relay/journal" ? [i] : []))
    .slice(1);
  const answers = rec.answers.filter((x) => x.kind === "item").map((x) => x.L);
  assert.equal(writes.length, answers.length);
  writes.forEach((w, k) => {
    const done = recs.findIndex(
      (r, i) =>
        i > w &&
        r.op === "sync" &&
        r.phase === "done" &&
        r.path === "relay/journal" &&
        startOf(recs, i) > w,
    );
    assert.ok(
      done > 0 && done < (answers[k] ?? 0),
      `item ${k}: answered at ${answers[k]}, durable at ${done}`,
    );
  });
});

const files = (relay: RelayProcess) => {
  const root = dirname(dirname(relay.dir));
  return ["hold", "hold.waiting.journal"].map((f) => existsSync(join(root, f)));
};

test("the recorder ends a hold at its deadline while the process lives, and removes its waiting file", {
  ...DARWIN,
  timeout: 60_000,
}, async () => {
  const relay = new RelayProcess(true);
  try {
    const world = createNodePlatform();
    await run(parse(HELD), await relay.open(), world, relay, (seen) =>
      relay.recording?.observe(seen),
    );
    // No stop yet: the files are gone because the wait ended, not because the process did.
    assert.deepEqual(files(relay), [true, false]);
  } finally {
    await relay.close();
  }
  assert.deepEqual(files(relay), [false, false]);
});

test("a stop on a round held far past the stop limit is answered in time", {
  ...DARWIN,
  timeout: 60_000,
}, async () => {
  const script = [
    { op: "prove", device: "app1", enrol: "s1", as: "g", expect: "served" },
    { op: "submit", entry: "create", as: "ch", expect: "result 0" },
    { op: "submit", entry: "epoch", as: "e1", expect: "result 0" },
    { op: "relay", act: "hold", files: ["journal"], ms: 60_000 },
    {
      op: "together",
      lists: [
        [
          { ...message("m1", "r1"), expect: "no answer", pipe: true },
          { op: "relay", act: "await-hold", file: "journal" },
          { op: "relay", act: "stop" },
        ],
      ],
    },
  ]
    .map(line)
    .join("\n");
  await recorded(script);
});
