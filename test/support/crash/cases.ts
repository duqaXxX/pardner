/**
 * The six cases of crash images design 4.1 and the `init` workload (4.3): a script each, and the record
 * check that says the state it needs was reached. A check that is not met is a failure of the workload,
 * never a pass. A met check names the state by a predicate over an image's applied and dropped operations.
 */
import type { Image } from "./images.ts";
import { digest, emptyBase, type Rec, replay } from "./replay.ts";
import type { Recording } from "./segments.ts";

const j = (...steps: object[]) => steps.map((s) => JSON.stringify(s)).join("\n");
const enrol = { op: "prove", device: "app1", enrol: "s1", as: "g", expect: "served" };
const submit = (entry: string, as: string, more: object = {}) => ({
  op: "submit",
  entry,
  as,
  expect: "result 0",
  ...more,
});
const message = (as: string, run: string, more: object = {}) =>
  submit("message", as, { epoch: "e2", run, ...more });
const proves = (conn: string, device = "app1") => ({ op: "prove", conn, device, expect: "served" });
const read = (items: string[], more: object = {}) => ({
  op: "read",
  from: 0,
  expect: { items, n: items.length },
  ...more,
});
const hold = (files: string[], ms = 300) => ({ op: "relay", act: "hold", files, ms });
const awaitHold = (file: string) => ({ op: "relay", act: "await-hold", file });

type Sync = { path: string; start: number; done?: number };
/** Every sync of the record, with the index of its `done` (none when the process ended first: ids restart with each process). */
export function syncsOf(recs: Rec[]): Sync[] {
  const all: Sync[] = [];
  const open = new Map<number, Sync>();
  recs.forEach((r, i) => {
    if (r.op !== "sync") return;
    if (r.phase === "start") {
      const s = { path: r.path, start: i };
      all.push(s);
      open.set(r.id, s);
    } else {
      const s = open.get(r.id);
      if (s) s.done = i;
      open.delete(r.id);
    }
  });
  return all;
}
const writes = (recs: Rec[], path: string) =>
  recs.flatMap((r, i) => (r.op === "write" && r.path === path ? [i] : []));
const between = (xs: number[], from: number, to: number) => xs.filter((x) => x > from && x < to);

/** A met check: which images are in the state the case needs (`applied` and `dropped` name operations `kind@record`). */
export type Window = { state: (image: Image) => boolean };
export type Case = { name: string; script: string; check: (rec: Recording) => Window | string };
const applied = (i: Image, rec: number) => i.applied.includes(`write@${rec}`);

const J = "relay/journal";
const S = "relay/seals";

export const CASES: Case[] = [
  {
    name: "init",
    script: "",
    check: (rec) => {
      const recs = rec.records();
      const made = recs.findIndex(
        (r) => r.op === "print" && r.text.startsWith("the relay is made"),
      );
      const key = recs.findIndex((r) => r.op === "print" && r.text.includes("relay public key"));
      return made > key && key >= 0
        ? { state: (i) => i.cut <= made + 1 }
        : "init printed no key before the relay is made";
    },
  },
  {
    name: "(a) a cut inside a held round",
    script: j(
      enrol,
      submit("create", "ch"),
      submit("epoch", "e1"),
      submit("add", "a2", { device: "app2" }),
      submit("epoch", "e2"),
      proves("c2"),
      proves("c3"),
      proves("c4"),
      hold(["journal"]),
      {
        op: "together",
        lists: [
          [
            { ...message("m0", "r0"), pipe: true },
            awaitHold("journal"),
            {
              op: "together",
              lists: [
                [message("m1", "r1", { conn: "c2" })],
                [message("m2", "r2", { conn: "c3" })],
                [
                  { ...message("m3", "r3", { conn: "c4" }), pipe: true },
                  {
                    op: "give-seal",
                    conn: "c4",
                    epoch: "e1",
                    recipient: "app2",
                    expect: "result 0",
                  },
                ],
              ],
            },
          ],
        ],
      },
      read(["g", "ch", "e1", "a2", "e2", "m0", "m1", "m2", "m3"]),
    ),
    check: (rec) => {
      const recs = rec.records();
      const all = syncsOf(recs);
      const jw = writes(recs, J);
      const sw = writes(recs, S);
      for (const held of all.filter((s) => s.path === J && s.done !== undefined)) {
        const under = between(jw, held.start, held.done ?? 0);
        const seal = between(sw, held.start, held.done ?? 0);
        if (under.length < 3 || seal.length < 1) continue;
        const later = all.find(
          (s) =>
            s.path === J &&
            s.start > Math.max(...under) &&
            s.start > (held.done ?? 0) &&
            s.done !== undefined,
        );
        const sealed = all.find(
          (s) => s.path === S && s.start > Math.max(...seal) && s.done !== undefined,
        );
        // Some of the held round's writes reached the disk and some did not, once all of them were written.
        if (later?.done !== undefined && sealed)
          return {
            state: (i) =>
              i.cut > Math.max(...under) &&
              under.some((w) => applied(i, w)) &&
              under.some((w) => !applied(i, w)),
          };
      }
      return "no round held three journal writes and a seals write after its sync start, then a later round covered them";
    },
  },
  {
    name: "(b) a cut between two files of one round",
    script: j(
      enrol,
      submit("create", "ch"),
      submit("epoch", "e1"),
      proves("c2"),
      hold(["blob"]),
      {
        op: "together",
        lists: [
          [{ op: "put-blob", conn: "c2", as: "b1", expect: "result 0" }],
          [
            awaitHold("blob"),
            { ...submit("add", "a2", { device: "app2" }), pipe: true },
            { op: "give-seal", epoch: "e1", recipient: "app2", expect: "result 0", pipe: true },
          ],
        ],
      },
      proves("c3", "app2"),
      read(["g", "ch", "e1", "a2"], { conn: "c3" }),
    ),
    check: (rec) => {
      const recs = rec.records();
      const [seal] = writes(recs, S);
      if (seal === undefined) return "no seal was written";
      const add = writes(recs, J).findLast((w) => w < seal) ?? -1;
      const round = syncsOf(recs).find(
        (s) => s.path === S && s.start > seal && s.done !== undefined,
      );
      const covered = syncsOf(recs).some(
        (s) =>
          s.path === J && s.start > add && s.done !== undefined && s.done < (round?.start ?? 0),
      );
      if (add < 0 || !round || covered)
        return "the add and the seal were not both written before one round's sync of seals";
      // The seal reached the disk and the add before it did not.
      return { state: (i) => applied(i, seal) && i.dropped.includes(`write@${add}`) };
    },
  },
  {
    name: "(c) a decision to fail closed, lost by a cut",
    script: j(
      enrol,
      read(["g"], { head: "h0" }),
      { op: "relay", act: "copy", as: "k1" },
      submit("add", "a2", { device: "app2" }),
      read(["g", "a2"], { head: "h1" }),
      { op: "relay", act: "put-back", copy: "k1" },
      { op: "prove", device: "app1", expect: "served" },
      { op: "prove", conn: "u2", device: "app1", head: "h1", wait: 300, expect: "silent" },
      { op: "upload-done", conn: "u2", head: "h1", expect: "result 11" },
      { op: "read", from: 0, expect: "refused 6" },
    ),
    check: (rec) => {
      const recs = rec.records();
      const made = recs.findIndex((r) => r.op === "create" && r.path.endsWith("tmp-failed-closed"));
      const renamed = recs.findIndex((r) => r.op === "rename" && r.to.endsWith("failed-closed"));
      const dir = syncsOf(recs).find(
        (s) => s.path === "relay" && s.start > renamed && s.done !== undefined,
      );
      if (made < 0 || renamed < made || !dir || !rec.answers.some((a) => a.kind === "closed"))
        return "the mark was not created, renamed and synced in the last segment, or the give-back was not answered result 11";
      return { state: (i) => i.cut > made && i.cut <= (dir.done ?? 0) + 1 };
    },
  },
  {
    name: "(d) a head signed before the cut",
    script: j(
      enrol,
      read(["g"], { head: "h1" }),
      submit("create", "ch"),
      read(["g", "ch"], { head: "h2" }),
      submit("add", "a2", { device: "app2" }),
      read(["g", "ch", "a2"], { head: "h3" }),
      submit("epoch", "e2"),
      read(["g", "ch", "a2", "e2"], { head: "h4" }),
      { op: "put-blob", as: "b1", expect: "result 0" },
      message("m1", "r1", { files: ["b1"], counter: 2 }),
      read(["g", "ch", "a2", "e2", "m1"]),
    ),
    check: (rec) => {
      const recs = rec.records();
      const reads = rec.answers.filter((a) => a.kind === "read").slice(0, 4);
      const later = (L: number) => writes(recs, J).some((w) => w >= L);
      if (reads.length < 4 || !reads.every((a) => later(a.L)))
        return "a read was not followed by a journal write";
      // Each content a read was answered on: the head it signed is about that prefix.
      const heads = new Set(reads.map((a) => digest(replay(recs.slice(0, a.L), emptyBase()))));
      return { state: (i) => heads.has(i.hash) };
    },
  },
  {
    name: "(e) a message held whose blob's names are not",
    script: j(
      enrol,
      submit("add", "a2", { device: "app2" }),
      submit("create", "ch"),
      submit("epoch", "e2"),
      proves("c2"),
      proves("c3", "app2"),
      hold(["blob", "seals"]),
      {
        op: "together",
        lists: [
          [
            { op: "put-blob", conn: "c2", as: "b1", expect: "result 0" },
            message("m1", "r1", { conn: "c2", files: ["b1"], counter: 2 }),
          ],
          [
            awaitHold("blob"),
            {
              op: "give-seal",
              conn: "c3",
              epoch: "e2",
              recipient: "app1",
              expect: "result 0",
              pipe: true,
            },
            { ...message("m2", "r2", { conn: "c3" }), pipe: true },
          ],
        ],
      },
      read(["g", "a2", "ch", "e2", "m2", "m1"]),
    ),
    check: (rec) => {
      const recs = rec.records();
      const all = syncsOf(recs);
      const rename = recs.findIndex((r) => r.op === "rename" && r.from.includes("/blobs/tmp-"));
      // The round's seals sync is in progress at the rename, and the journal sync that follows it is the same round's.
      const seals = all.find((s) => s.path === S && s.start < rename && (s.done ?? 0) > rename);
      const done = all.find(
        (s) => s.path === J && seals !== undefined && s.start > seals.start && s.done !== undefined,
      );
      const made = recs.findLastIndex(
        (r, i) => i < rename && r.op === "create" && r.path.includes("/blobs/tmp-"),
      );
      const m = writes(recs, J).find((w) => w > rename);
      if (rename < 0 || made < 0 || !seals || done?.done === undefined || m === undefined)
        return "tmp-P was not renamed during a sync of seals, followed by that round's journal sync and a journal write";
      // The directory sync of blobs that follows makes the rename durable: a relay that writes M's write only after it leaves no image with M's write and no rename.
      const names = all.find((s) => s.path === "relay/blobs" && s.start > rename);
      if (names?.done === undefined) return "the rename of tmp-P was never made durable";
      // The blob has no name (neither tmp-P nor the final one) and M's write reached the disk; where the relay orders them so that no such image exists, the images with no name for the blob.
      const nameless = (i: Image) =>
        i.dropped.includes(`mv@${rename}`) && i.dropped.includes(`link@${made}`);
      return { state: m < names.done ? (i) => applied(i, m) && nameless(i) : nameless };
    },
  },
  {
    name: "(f) a write a killed process left unsynced",
    script: j(
      enrol,
      submit("create", "ch"),
      submit("epoch", "e2"),
      hold(["journal"], 10_000),
      {
        op: "together",
        lists: [
          [
            { ...message("m1", "r1", { expect: "no answer" }), pipe: true },
            awaitHold("journal"),
            { op: "relay", act: "kill" },
          ],
        ],
      },
      { op: "relay", act: "serve" },
      { op: "prove", device: "app1", expect: "served" },
      read(["g", "ch", "e2", "m1"]),
    ),
    check: (rec) => {
      const recs = rec.records();
      const open = syncsOf(recs).findLast((s) => s.path === J && s.done === undefined);
      const carried = writes(recs, J).findLast((w) => w < (open?.start ?? 0));
      const last = rec.answers.findLast((a) => a.kind === "read");
      const counted =
        last?.kind === "read" &&
        last.head.n === 1 + rec.answers.filter((a) => a.kind === "item").length + 1;
      if (!open || carried === undefined || !counted)
        return "no journal write was left unsynced by the killed process, or the read's head does not count it";
      return { state: (i) => i.dropped.includes(`write@${carried}`) };
    },
  },
];
