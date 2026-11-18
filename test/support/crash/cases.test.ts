/** The record check of case (e) on synthetic records (crash images design 4.1): the seals sync must be in progress at the rename, in the round of the journal sync. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CASES } from "./cases.ts";
import type { Recording } from "./segments.ts";

const e = CASES.find((c) => c.name.startsWith("(e)"));
const sync = (phase: string, id: number, path: string) => ({ op: "sync", phase, id, path });
const rename = { op: "rename", from: "relay/blobs/tmp-1", to: "relay/blobs/ab" };
const write = { op: "write", path: "relay/journal" };
const create = { op: "create", path: "relay/blobs/tmp-1" };
// Everything else the check asks for, so that each record below differs from a met one by the seals sync alone.
const names = [sync("start", 9, "relay/blobs"), sync("done", 9, "relay/blobs")];
const check = (records: object[]) =>
  e?.check({ records: () => records, answers: [] } as unknown as Recording);

test("(e) is not met when no seals sync is in progress at the rename", () => {
  const seals = (id: number) => [sync("start", id, "relay/seals"), sync("done", id, "relay/seals")];
  // The seals sync of the start barrier is over before the rename; the round's own starts after it.
  const result = check([
    create,
    ...seals(1),
    rename,
    write,
    ...seals(3),
    sync("start", 4, "relay/journal"),
    sync("done", 4, "relay/journal"),
    ...names,
  ]);
  assert.equal(typeof result, "string");
});

test("(e) is not met when the journal sync is of an earlier round than the seals sync", () => {
  const result = check([
    create,
    write,
    sync("start", 1, "relay/journal"),
    sync("start", 2, "relay/seals"),
    rename,
    sync("done", 1, "relay/journal"),
    sync("done", 2, "relay/seals"),
    write,
    ...names,
  ]);
  assert.equal(typeof result, "string");
});

test("(e) is met by a seals sync in progress at the rename and the journal sync after it", () => {
  const result = check([
    create,
    sync("start", 1, "relay/seals"),
    rename,
    write,
    sync("done", 1, "relay/seals"),
    sync("start", 2, "relay/journal"),
    sync("done", 2, "relay/journal"),
    ...names,
  ]);
  assert.equal(typeof result, "object");
});
