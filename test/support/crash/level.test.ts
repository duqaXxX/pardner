/** Design 5.5's images of a start's own start: which configurations label them, where `listening` is, and the demand after it. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnNode } from "../../relay/child.ts";
import { DARWIN, watch } from "../../relay/process-support.ts";
import { judge, type Log, started, stop } from "./check.ts";
import { build } from "./folder.ts";
import { innerImages, listeningAt } from "./level.ts";
import { recordedBody } from "./record.ts";
import { CONFIGS, digest, emptyBase, parse, type Rec, replay } from "./replay.ts";
import { recorded } from "./workload.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const start: Rec[] = [
  { op: "create", path: "a" },
  { op: "write", path: "a", off: 0, data: b64("abcdef") },
  { op: "sync", phase: "start", id: 0, path: "a" },
  { op: "sync", phase: "done", id: 0, path: "a" },
  { op: "rename", from: "a", to: "b" },
  { op: "print", text: "listening on port 1" },
];

test("an inner image carries the configurations of the outer image that reach it, and no other", () => {
  const split = "M split rename";
  const onlyM = innerImages(start, emptyBase(), ["M"]);
  assert.ok(onlyM.length > 0);
  assert.ok(onlyM.every((i) => i.configs.join() === "M"));
  const both = innerImages(start, emptyBase(), ["M", split]);
  const labels = new Set(both.map((i) => i.configs.join()));
  // The split rename builds images M cannot, and M's images the split rename builds too carry both.
  assert.deepEqual([...labels].sort(), [split, `M,${split}`].sort());
  assert.equal(new Set(both.map((i) => i.image.hash)).size, both.length);
  assert.equal(innerImages(start, emptyBase(), [split]).length, both.length);
  assert.ok(CONFIGS.some((c) => c.name === split));
});

test("a real start's record holds the listening line as a print record, and the demand has an index to bind to", {
  ...DARWIN,
  timeout: 60_000,
}, async () => {
  const { rec } = await recorded(
    '{"op":"prove","device":"app1","enrol":"s1","as":"g","expect":"served"}',
  );
  const folder = mkdtempSync(join(tmpdir(), "pardner-level-test-"));
  try {
    build(replay(rec.records(), emptyBase()), join(folder, "live"));
    const record = join(folder, "record");
    const args = ["serve", "--dir", join(folder, "live", "relay"), "--listen", "127.0.0.1:0"];
    const child = watch(spawnNode(recordedBody(join(folder, "live"), record, args)), 0);
    try {
      await started(child);
    } finally {
      await stop(child);
    }
    const recs = parse(readFileSync(record, "utf8"));
    const at = listeningAt(recs);
    assert.notEqual(at, -1);
    assert.equal(listeningAt(recs.slice(0, at)), -1);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("an image whose start serves another sequence than the outer start's is a finding (PARDNER_CRASH_FULL=1)", {
  ...DARWIN,
  skip: !process.env.PARDNER_CRASH_FULL && "set PARDNER_CRASH_FULL=1 to run every image",
  timeout: 60_000,
}, async () => {
  const { rec, platform } = await recorded(
    '{"op":"prove","device":"app1","enrol":"s1","as":"g","expect":"served"}\n{"op":"read","from":0,"expect":{"items":["g"],"n":1}}',
  );
  const recs = rec.records();
  const image = {
    config: "M",
    cut: recs.length,
    how: "prefix",
    state: replay(recs, emptyBase()),
    hash: digest(replay(recs, emptyBase())),
    applied: [],
    dropped: [],
  };
  const judged = async (must?: string) => {
    const folder = mkdtempSync(join(tmpdir(), "pardner-level-test-"));
    try {
      build(image.state, join(folder, "live"));
      const log: Log = { text: "", unprobed: 0, must };
      return { failed: await judge(image, rec, platform, folder, log), items: log.items };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  };
  const first = await judged();
  assert.equal(first.failed, undefined);
  assert.equal((await judged(first.items)).failed, undefined);
  assert.match(String((await judged("not-the-sequence")).failed), /another sequence/);
});
