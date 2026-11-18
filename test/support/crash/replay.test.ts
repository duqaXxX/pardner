/** The replay of hand-made records (design 3.1, 3.2): the micro-operations, what covers them, the digest. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONFIGS,
  coveredAt,
  digest,
  emptyBase,
  M,
  micros,
  parse,
  type Rec,
  replay,
  type State,
} from "./replay.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const sync = (id: number, path: string): Rec[] => [
  { op: "sync", phase: "start", id, path },
  { op: "sync", phase: "done", id, path },
];
/** The covering record index of each operation of `recs` under `cfg`. */
const covers = (recs: Rec[], cfg = M, base = emptyBase()) => {
  const m = micros(recs, base, cfg.split);
  return m.ops.map((o) => coveredAt(o, cfg, m));
};
const tree = (
  entries: [string, number][],
  rest: [number, State extends Map<number, infer N> ? N : never][],
): State => new Map([[0, { entries: new Map(entries) }], ...rest]);

test("a line the recorder could not model fails the parse", () => {
  assert.throws(
    () => parse('{"op":"create","path":"a"}\n{"op":"unmodelled","name":"unlinkSync"}\n'),
    /unlinkSync/,
  );
});

test("a recursive remove unlinks the subtree, children first", () => {
  const recs: Rec[] = [
    { op: "mkdir", path: "d" },
    { op: "create", path: "d/f" },
    { op: "remove", path: "d" },
  ];
  assert.deepEqual(
    micros(recs, emptyBase(), false).ops.map((o) => o.t),
    ["link", "link", "unlink", "unlink"],
  );
  assert.equal(digest(replay(recs, emptyBase())), digest(emptyBase()));
});

test("a rename is one atomic operation, or three split; between two directories it names both", () => {
  const base = tree(
    [
      ["d1", 1],
      ["d2", 2],
    ],
    [
      [1, { entries: new Map([["x", 3]]) }],
      [2, { entries: new Map() }],
      [3, { data: Buffer.from("1") }],
    ],
  );
  const mv: Rec[] = [{ op: "rename", from: "d1/x", to: "d2/y" }];
  const [one] = micros(mv, base, false).ops;
  assert.ok(one?.t === "mv" && one.from[0] === 1 && one.to[0] === 2 && one.to[1] === "y");
  assert.deepEqual(
    micros(mv, base, true).ops.map((o) => o.t),
    ["link", "unlink"],
  );
  const over: Rec[] = [
    { op: "rename", from: "d1/x", to: "d2/x" },
    { op: "rename", from: "d2/x", to: "d1/x" },
  ];
  assert.deepEqual(
    micros(over, base, true).ops.map((o) => o.t),
    ["link", "unlink", "link", "unlink"],
  );
});

test("a directory sync covers an entry under M and not without A2; a file sync covers its data", () => {
  const recs: Rec[] = [
    { op: "create", path: "a" },
    { op: "write", path: "a", off: 0, data: b64("x") },
    ...sync(0, ""),
    ...sync(1, "a"),
  ];
  assert.deepEqual(covers(recs), [3, 5]);
  assert.deepEqual(covers(recs, CONFIGS[1]), [Number.POSITIVE_INFINITY, 5]);
  assert.deepEqual(
    covers(recs, { ...M, a2: false, a3: true }),
    [5, 5],
    "A3: the file's sync covers its entry",
  );
});

test("a write made while its file's sync is in flight is not covered by it", () => {
  const recs: Rec[] = [
    { op: "create", path: "a" },
    { op: "sync", phase: "start", id: 0, path: "a" },
    { op: "write", path: "a", off: 0, data: b64("x") },
    { op: "sync", phase: "done", id: 0, path: "a" },
  ];
  assert.equal(covers(recs)[1], Number.POSITIVE_INFINITY);
});

test("the digest hashes names, contents and modes, and not the root's own mode", () => {
  const one = (mode: number | undefined, rootMode?: number): State =>
    new Map([
      [0, { entries: new Map([["f", 1]]), mode: rootMode }],
      [1, { data: Buffer.from("1"), mode }],
    ]);
  assert.notEqual(digest(one(0o600)), digest(one(0o644)));
  assert.equal(digest(one(0o600, 0o700)), digest(one(0o600, 0o755)));
});

test("a durable mark covers the records it names and no other operation", () => {
  const recs: Rec[] = [
    { op: "create", path: "a" },
    { op: "create", path: "b" },
    { op: "writefile", path: "b", data: "", mode: 0o600 },
    { op: "chmod", path: "b", mode: 0o640 },
    { op: "durable", recs: [2, 3] },
  ];
  assert.deepEqual(covers(recs), [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 4, 4, 4]);
  const [before, after] = [recs.slice(0, 3), recs.slice(0, 4)];
  assert.notEqual(
    digest(replay(before, emptyBase())),
    digest(replay(after, emptyBase())),
    "a mode is part of the state",
  );
});
