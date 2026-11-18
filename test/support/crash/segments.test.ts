/** The record of a run of the scripted device: closes that rebuild the directory, answers bound to the record (design 2.3, 5.2). */
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DARWIN } from "../../relay/process-support.ts";
import { RelayProcess } from "../scripted-device/relay-process.ts";
import { parse, run } from "../scripted-device/script.ts";
import { tempDirSync } from "../temp.ts";
import { coveredAt, digest, emptyBase, M, micros, type Rec, replay } from "./replay.ts";
import { Recording } from "./segments.ts";

const SCRIPTS = new URL("../scripted-device/scripts/relay/", import.meta.url);

/** Runs `source` on a recorded relay and stops it; returns the relay for its recording. */
async function recorded(source: string) {
  const relay = new RelayProcess(true);
  try {
    const steps = parse(`${source}\n{"op":"relay","act":"stop"}`);
    await run(steps, await relay.open(), undefined, relay, (seen) =>
      relay.recording?.observe(seen),
    );
  } finally {
    await relay.close();
  }
  return relay;
}
const cleanup = (relay: RelayProcess) =>
  rmSync(dirname(dirname(relay.dir)), { recursive: true, force: true });

test(
  "a recorded run closes on a record that rebuilds the directory, and every answer comes after the sync that makes it durable",
  DARWIN,
  async () => {
    const relay =
      await recorded(`{"op":"prove","device":"app1","enrol":"s1","as":"g","expect":"served"}
{"op":"submit","entry":"add","device":"app2","as":"a2","expect":"result 0"}
{"op":"read","from":0,"expect":{"items":["g","a2"],"n":2}}`);
    const rec = relay.recording;
    assert.ok(rec);
    rec.verify("the end of the test");
    assert.deepEqual(
      rec.answers.map((a) => a.kind),
      ["served", "item", "read"],
    );
    const recs = rec.records();
    const m = micros(recs, emptyBase(), false);
    for (const a of rec.answers.filter((a) => a.kind !== "read")) {
      const open = m.ops.filter(
        (o, i) => o.rec < a.L && o.t === "write" && coveredAt(o, M, m) >= a.L,
      );
      const journal = recs
        .map((r, i) => [r, i] as const)
        .filter(([r]) => r.op === "write" && r.path === "relay/journal");
      assert.ok(
        journal.length > 0 && open.every((o) => !journal.some(([, i]) => i === o.rec)),
        `${a.kind} answered with a journal write not yet synced`,
      );
    }
    cleanup(relay);
  },
);

test(
  "a put-back under a running relay is written down as a durable copy, and the answers before it no longer bind",
  DARWIN,
  async () => {
    const relay = await recorded(readFileSync(new URL("put-back-under.jsonl", SCRIPTS), "utf8"));
    const rec = relay.recording;
    assert.ok(rec);
    assert.equal(rec.generations.length, 1);
    const [from, to] = rec.synthetic[0] ?? [0, 0];
    const recs = rec.records();
    assert.deepEqual(recs[to - 1], {
      op: "durable",
      recs: recs.slice(from, to - 1).map((_, i) => from + i),
    });
    assert.ok(
      recs.slice(from, to - 1).some((r) => r.op === "writefile" && r.path === "relay/journal"),
      "the journal the copy replaced",
    );
    assert.ok(rec.answers.some((a) => a.gen === 0) && rec.answers.some((a) => a.gen === 1));
    // The generation says which copy it was made from, and that the relay kept its connections.
    const copied = rec.copied.get("k1");
    assert.ok(copied !== undefined && copied < from);
    assert.deepEqual(rec.opened, [{ base: copied, kept: true }]);
    const device = rec.devices.get(0);
    assert.ok(device && rec.answers.some((a) => a.kind === "served" && a.me?.id === device.id));
    cleanup(relay);
  },
);

test("a write by the test marks its own records durable, not the child's written while it ran", () => {
  const root = tempDirSync("pardner-crash-root-");
  const file = join(tempDirSync("pardner-crash-record-"), "record");
  const rec = new Recording(root, file);
  rec.testWrite(() => {
    // The relay's own record, in the gap between the test's reading and its writing.
    writeFileSync(join(root, "c"), "", { mode: 0o600 });
    appendFileSync(
      file,
      `${JSON.stringify({ op: "writefile", path: "c", made: true, data: "", mode: 0o600 })}\n`,
    );
    writeFileSync(join(root, "a"), "1");
  });
  const m = micros(rec.records(), emptyBase(), false);
  const covered = m.ops.map((o) => coveredAt(o, M, m));
  const done = covered.map((c) => Number.isFinite(c));
  assert.deepEqual([done.slice(0, 2), done.slice(2).every(Boolean)], [[false, false], true]);
  rec.testWrite(() => chmodSync(join(root, "a"), 0o640), false);
  assert.equal(rec.generations.length, 1, "a write that changes no sequence opens no generation");
});

test(
  "a journal cut to what was synced opens no generation, and the answers before it still bind",
  DARWIN,
  async () => {
    const relay = await recorded(readFileSync(new URL("disk-fails.jsonl", SCRIPTS), "utf8"));
    const rec = relay.recording;
    try {
      assert.ok(rec);
      assert.deepEqual([rec.generations.length, rec.synthetic.length], [0, 1]);
      assert.ok(rec.answers.every((a) => a.gen === 0));
    } finally {
      cleanup(relay);
    }
  },
);
