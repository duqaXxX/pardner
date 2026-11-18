/** The images of hand-made records (design 3.3), with the counts worked out by hand in each test. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { enumerate, type Image } from "./images.ts";
import { CONFIGS, emptyBase, M, type Rec, type State } from "./replay.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");
/** The root's files as `name=content`, so that a test names an image by what it holds. */
const ls = (s: State) =>
  [...(s.get(0) as { entries: Map<string, number> }).entries]
    .map(([n, i]) => `${n}=${(s.get(i) as { data: Buffer }).data.toString("latin1")}`)
    .sort()
    .join(",");
const cutOf = (images: Image[]) => new Map(images.map((i) => [ls(i.state), i.cut]));

const sync = (id: number, path: string): Rec[] => [
  { op: "sync", phase: "start", id, path },
  { op: "sync", phase: "done", id, path },
];
const FILE: Rec[] = [
  { op: "create", path: "a" },
  { op: "write", path: "a", off: 0, data: b64("abcdef") },
  ...sync(0, "a"),
  { op: "print", text: "answered" },
];

test("a created and written file, synced: seven contents, each with the latest cut that leaves it", () => {
  const { images, window, fallback } = enumerate(FILE, emptyBase(), M);
  assert.equal(images.length, 7);
  assert.equal(window, 2, "the entry and the write, before the sync completes");
  assert.equal(fallback, false);
  const cuts = cutOf(images);
  // The write is covered from cut 4 on: the whole content is left by every later cut, up to the print.
  assert.equal(cuts.get("a=abcdef"), 5);
  assert.equal(
    cuts.get(""),
    5,
    "the entry is never covered (no directory sync): it may always be lost",
  );
  assert.equal(cuts.get("a="), 3, "an empty file is left only while the write is uncovered");
  assert.equal(cuts.get("a=ab"), 3);
  assert.equal(cuts.get("a=abcd"), 3);
  assert.equal(cuts.get("a=\0\0\0\0\0\0"), 3, "the size reached the disk before the data");
});

test("a content left before an answer and after it is checked at the later cut (design 3.3, 7.4)", () => {
  const { images } = enumerate(FILE, emptyBase(), M);
  const answered = FILE.length; // the print is the last record: an answer bound at it
  const whole = images.find((i) => ls(i.state) === "a=abcdef");
  assert.ok(
    whole && whole.cut >= answered,
    "the cut before the answer would check no answered state",
  );
});

test("a directory sync covers the entry under M and not without A2", () => {
  const recs: Rec[] = [{ op: "create", path: "a" }, ...sync(0, "")];
  const [m, noA2] = [CONFIGS[0], CONFIGS[1]];
  assert.ok(m && noA2);
  assert.equal(cutOf(enumerate(recs, emptyBase(), m).images).get(""), 2);
  assert.equal(cutOf(enumerate(recs, emptyBase(), noA2).images).get(""), 3);
});

test("an atomic rename never leaves the destination missing; a split one can", () => {
  const base = (): State =>
    new Map<number, { entries: Map<string, number> } | { data: Buffer }>([
      [0, { entries: new Map([["x", 1]]) }],
      [1, { data: Buffer.from("old") }],
    ]);
  const recs: Rec[] = [
    { op: "create", path: "tmp" },
    { op: "write", path: "tmp", off: 0, data: b64("new") },
    ...sync(0, "tmp"),
    { op: "rename", from: "tmp", to: "x" },
  ];
  const lacks = (c: (typeof CONFIGS)[number]) =>
    enumerate(recs, base(), c).images.some(
      (i) =>
        !ls(i.state)
          .split(",")
          .some((e) => e.startsWith("x=")),
    );
  assert.equal(lacks(CONFIGS[0] as (typeof CONFIGS)[number]), false);
  assert.equal(lacks(CONFIGS[2] as (typeof CONFIGS)[number]), true);
});

test("a window past 6 builds no subsets and says so", () => {
  const recs: Rec[] = [{ op: "create", path: "a" }];
  for (let i = 0; i < 6; i++) recs.push({ op: "write", path: "a", off: i, data: b64("x") });
  const r = enumerate(recs, emptyBase(), M);
  assert.equal(r.window, 7);
  assert.equal(r.fallback, true);
  const how = r.images.map((i) => i.how);
  for (const kind of ["prefix", "torn", "dropped"])
    assert.ok(
      how.some((h) => h.startsWith(kind)),
      `${kind} images are built past 6`,
    );
});

/** A base of two named files, both durable. */
const two = (a = "", b = ""): State =>
  new Map<number, { entries: Map<string, number> } | { data: Buffer }>([
    [
      0,
      {
        entries: new Map([
          ["a", 1],
          ["b", 2],
        ]),
      },
    ],
    [1, { data: Buffer.from(a) }],
    [2, { data: Buffer.from(b) }],
  ]);
const A: Rec = { op: "write", path: "a", off: 0, data: b64("AAAAAA") };
const B: Rec = { op: "write", path: "b", off: 0, data: b64("BBBBBB") };

test("a torn image keeps every later operation covered at its cut (design 3.2)", () => {
  const recs: Rec[] = [A, B, ...sync(0, "b"), { op: "print", text: "b answered" }];
  const last = enumerate(recs, two(), M).images.filter((i) => i.cut === recs.length);
  assert.deepEqual(
    last.filter((i) => !ls(i.state).includes("b=BBBBBB")).map((i) => i.how),
    [],
  );
});

test("a state with the first write torn and the second, synced, whole is built", () => {
  const recs: Rec[] = [A, B, ...sync(0, "b")];
  const all = enumerate(recs, two(), M).images.map((i) => ls(i.state));
  assert.ok(all.includes("a=AA,b=BBBBBB"));
});

test("a size that reaches the disk before its data is built for a write that grows the file only", () => {
  const over = enumerate([{ ...A, data: b64("AAAA") }], two("xxxxxx"), M).images.map((i) =>
    ls(i.state),
  );
  assert.ok(!over.some((s) => s.includes("\0")), "an overwrite changes no size");
  const grows = enumerate([A], two(), M).images.map((i) => ls(i.state));
  assert.ok(grows.includes("a=\0\0\0\0\0\0,b="));
  const straddles = enumerate([{ ...A, off: 4, data: b64("AAAA") }], two("xxxxxx"), M).images;
  const states = straddles.map((i) => ls(i.state));
  assert.ok(states.includes("a=xxxxxx\0\0,b="), "past the old end only");
  assert.ok(!states.some((s) => s.startsWith("a=xxxx\0")), "the old bytes stay");
});

test("a content is kept once per generation, and a skipped cut is not built (design 2.3, 5.2)", () => {
  const print: Rec = { op: "print", text: "answered" };
  const recs: Rec[] = [{ op: "create", path: "a" }, print, print];
  const emptyFile = (cuts: Parameters<typeof enumerate>[3]) =>
    enumerate(recs, emptyBase(), M, cuts)
      .images.filter((i) => ls(i.state) === "a=")
      .map((i) => i.cut);
  assert.deepEqual(emptyFile({}), [3]);
  assert.deepEqual(emptyFile({ gen: (cut) => (cut > 1 ? 1 : 0) }).sort(), [1, 3]);
  assert.ok(
    enumerate(recs, emptyBase(), M, { skip: (cut) => cut === 3 }).images.every((i) => i.cut < 3),
  );
});

test("an image names the operations it applied and the ones it dropped", () => {
  const image = enumerate([A, B], two(), M).images.find(
    (i) => i.cut === 2 && i.applied.join() === "write@1",
  );
  assert.deepEqual(image?.dropped, ["write@0"]);
});

test("M with A3 builds images M does not: a torn image keeps what A3 covers after its torn write (design 3.2)", () => {
  const b64 = (t: string) => Buffer.from(t).toString("base64");
  const recs: Rec[] = [
    { op: "create", path: "a" },
    { op: "write", path: "a", off: 0, data: b64("abcdef") },
    { op: "create", path: "b" },
    { op: "sync", phase: "start", id: 0, path: "b" },
    { op: "sync", phase: "done", id: 0, path: "b" },
    { op: "print", text: "answered" },
  ];
  const a3 = CONFIGS.find((c) => c.name === "M with A3");
  assert.ok(a3);
  const m = new Set(enumerate(recs, emptyBase(), M).images.map((i) => i.hash));
  const extra = enumerate(recs, emptyBase(), a3).images.filter((i) => !m.has(i.hash));
  assert.ok(extra.length > 0, "A3 does not only remove images");
});
