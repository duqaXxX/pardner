import assert from "node:assert/strict";
import { readFileSync, rmSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { DARWIN } from "../../relay/process-support.ts";
import { checkRecording, isDefect, kept, referenceOf } from "./check.ts";
import { enumerate, type Image } from "./images.ts";
import { CONFIGS, digest, emptyBase, M, replay } from "./replay.ts";
import { type Answer, Recording } from "./segments.ts";
import { recorded } from "./workload.ts";

after(() => {
  for (const dir of kept) rmSync(dir, { recursive: true, force: true });
});
let once: ReturnType<typeof recorded> | undefined;
const shared = () => (once ??= recorded(SCRIPT));
const SCRIPTS = new URL("../scripted-device/scripts/relay/", import.meta.url);
const SCRIPT = `{"op":"prove","device":"app1","enrol":"s1","as":"g","expect":"served"}
{"op":"submit","entry":"add","device":"app2","as":"a2","expect":"result 0"}
{"op":"read","from":0,"head":"h1","expect":{"items":["g","a2"],"n":2}}`;
const LOST = `{"op":"prove","device":"app1","enrol":"sheet1","as":"g","expect":"served"}
{"op":"read","from":0,"expect":{"items":["g"],"n":1}}
{"op":"relay","act":"lose"}
{"op":"prove","device":"app1","expect":"nothing listens"}
{"op":"relay","act":"recreate"}
{"op":"prove","device":"app5","enrol":"sheet5","as":"g5","expect":"served"}
{"op":"read","from":0,"expect":{"items":["g5"],"n":1}}`;

const summary = (r: Awaited<ReturnType<typeof checkRecording>>) => [
  r.failures,
  r.findings.map((f) => `${f.how}@${f.cut} ${f.check}`),
];
const kindOf = (i: Image, last: number) =>
  i.cut === last && i.dropped.length === 0 ? "prefix" : (i.how.split(" ")[0] ?? "");
const chosen = (last: number) => {
  const kinds: string[] = [];
  return {
    kinds,
    only: (i: Image) => {
      const kind = kindOf(i, last);
      if (i.cut < last - 6 || kinds.includes(kind) || !["prefix", "torn", "dropped"].includes(kind))
        return false;
      kinds.push(kind);
      return true;
    },
  };
};

test("a prefix, a torn and a dropped image of a recorded enrolment and added device are started and served as told", {
  ...DARWIN,
  timeout: 60_000,
}, async () => {
  const { platform, rec } = await shared();
  const pick = chosen(rec.records().length);
  const picked = await checkRecording(rec, platform, 2, pick.only);
  assert.deepEqual(pick.kinds.sort(), ["dropped", "prefix", "torn"]);
  assert.deepEqual(summary(picked), [[], []]);
});

test("the images next to a lose and a recreate are not judged by the generation before (CR1)", {
  ...DARWIN,
  timeout: 90_000,
}, async () => {
  const { platform, rec } = await recorded(LOST);
  const near = (i: Image) =>
    i.config === "M" && (rec.generations.includes(i.cut) || i.cut === rec.records().length);
  const lost = await checkRecording(rec, platform, 2, near);
  const defects = lost.findings.filter(isDefect);
  assert.deepEqual(
    [lost.images > 0, lost.failures, defects.map((f) => `${f.how}@${f.cut} ${f.check}`)],
    [true, [], []],
  );
});

test("a generation no read ends is a failure of the workload, apart from the findings (CR7)", {
  ...DARWIN,
  timeout: 60_000,
}, async () => {
  const { platform, rec } = await recorded(
    readFileSync(new URL("put-back-under.jsonl", SCRIPTS), "utf8"),
  );
  const [boundary] = rec.generations;
  const whole = digest(replay(rec.records().slice(0, boundary), emptyBase()));
  const { findings, failures } = await checkRecording(rec, platform, 2, (i) => i.hash === whole);
  assert.deepEqual(failures, ["generation 0: no read from 0 ends it"]);
  assert.deepEqual(
    findings.map((f) => f.check),
    [],
  );
});

test("a generation whose script never proves again is read as the device it names, and a lost genesis is found (R2-1)", {
  ...DARWIN,
  timeout: 60_000,
}, async () => {
  const { platform, rec } = await recorded(
    readFileSync(new URL("put-back-under-equal.jsonl", SCRIPTS), "utf8"),
  );
  assert.ok(rec.answers.some((a) => a.gen === 1 && a.kind === "read"));
  assert.ok(!rec.answers.some((a) => a.gen === 1 && a.kind === "served"));
  const whole = digest(replay(rec.records(), emptyBase()));
  const last = (i: Image) => i.hash === whole && i.cut === rec.records().length;
  const plain = await checkRecording(rec, platform, 1, last);
  assert.ok(plain.images > 0 && plain.unprobed === 0);
  assert.deepEqual(summary(plain), [[], []]);
  const cut = (folder: string) => truncateSync(join(folder, "live", "relay", "journal"), 54);
  const lost = await checkRecording(rec, platform, 1, last, cut);
  assert.match(lost.findings[0]?.check ?? "", /is not served/);
});

test("the checker reads as the script's first device, not as one that proves after the cut (R3-1)", {
  ...DARWIN,
  timeout: 90_000,
}, async () => {
  const { platform, rec } =
    await recorded(`{"op":"prove","device":"app1","enrol":"s1","as":"g","expect":"served"}
{"op":"submit","entry":"add","device":"app2","as":"a2","expect":"result 0"}
{"op":"prove","conn":"c2","device":"app2","expect":"served"}
{"op":"read","conn":"c2","from":0,"expect":{"items":["g","a2"],"n":2}}`);
  const found = await checkRecording(rec, platform, 2, (i) => i.config === "M" && i.cut >= 38);
  assert.ok(found.images > 0);
  assert.deepEqual(summary(found), [[], []]);
});

test("a failed-closed generation with no read of its own is judged by the base's sequence (R2-2)", () => {
  const rec = new Recording("root", "file");
  const read = (L: number, gen: number, n: number): Answer => ({
    L,
    gen,
    kind: "read",
    items: Array.from({ length: n }, (_, position) => ({ position, id: new Uint8Array(32) })),
    head: { n, chain: new Uint8Array(32), sig: new Uint8Array(64) },
  });
  rec.answers.push(read(10, 0, 1), read(30, 0, 3), {
    L: 50,
    gen: 1,
    kind: "closed",
    relay: new Uint8Array(1),
  });
  rec.generations.push(40);
  rec.opened.push({ base: 20 });
  assert.equal(referenceOf(rec, 1)?.L, 10);
  rec.opened[0] = {};
  assert.equal(referenceOf(rec, 1), undefined);
});

test("an image whose enrol entry is lost after init printed its key is a finding, edited or natural (CR2)", {
  ...DARWIN,
  timeout: 90_000,
}, async () => {
  const { platform, rec } = await shared();
  const recs = rec.records();
  const made =
    recs.findIndex((r) => r.op === "print" && r.text.startsWith("the relay is made")) + 1;
  const after = digest(replay(recs.slice(0, made), emptyBase()));
  const spent = (folder: string) => rmSync(join(folder, "live", "relay", "enrol"));
  const edited = await checkRecording(rec, platform, 1, (i) => i.hash === after, spent);
  assert.match(edited.findings[0]?.check ?? "", /does not enrol/);
  assert.deepEqual([edited.failures, edited.unprobed], [[], 0]);
  const first = rec.answers.find((a) => a.kind === "served")?.L ?? 0;
  const noEnrol = (i: Image) => {
    const root = i.state.get(0) as { entries: Map<string, number> };
    const dir = i.state.get(root.entries.get("relay") ?? -1);
    return (
      i.config !== "M" &&
      i.cut < first &&
      dir !== undefined &&
      "entries" in dir &&
      !dir.entries.has("enrol")
    );
  };
  const natural = await checkRecording(rec, platform, 2, noEnrol);
  assert.ok(natural.images > 0 && natural.failures.length === 0 && natural.unprobed === 0);
  assert.ok(natural.findings.every((f) => !isDefect(f)));
  assert.ok(
    natural.findings.some((f) => /does not enrol/.test(f.check)),
    "an enrol entry lost after the print is found",
  );
});

test("the key printed by init names the directory across a put-back, so no image of it is unprobed (R4-1)", {
  ...DARWIN,
  timeout: 60_000,
}, async () => {
  // A copy taken before the device was enrolled, put back under the running relay.
  const { platform, rec } = await recorded(`{"op":"relay","act":"copy","as":"k0"}
{"op":"prove","device":"app1","enrol":"s1","as":"g","expect":"served"}
{"op":"read","from":0,"expect":{"items":["g"],"n":1}}
{"op":"relay","act":"put-back-under","copy":"k0"}
{"op":"relay","act":"restart"}
{"op":"prove","device":"app1","enrol":"s1","as":"g2","expect":"served"}
{"op":"read","from":0,"expect":{"items":["g2"],"n":1}}`);
  const [boundary] = rec.generations;
  const found = await checkRecording(
    rec,
    platform,
    2,
    (i) => i.cut >= (boundary ?? 0) && i.config === "M",
  );
  assert.ok(found.images > 0);
  assert.deepEqual(
    [found.failures, found.findings.map((f) => f.check), found.unprobed],
    [[], [], 0],
  );
});

test("an answer the image does not bear out is a finding, with its configurations and the kept folder", {
  ...DARWIN,
  timeout: 60_000,
}, async () => {
  const { platform, rec } = await shared();
  const whole = digest(replay(rec.records(), emptyBase()));
  const wrong = async (a: Parameters<typeof rec.answers.push>[0]) => {
    rec.answers.push(a);
    const found = await checkRecording(rec, platform, 2, (i) => i.hash === whole);
    rec.answers.pop();
    assert.deepEqual(found.failures, []);
    return found;
  };
  const read = rec.answers.findLast((a) => a.kind === "read");
  assert.ok(read?.kind === "read");
  const item = await wrong({
    L: rec.length(),
    gen: 0,
    kind: "item",
    id: new Uint8Array(32).fill(7),
  });
  assert.match(item.findings[0]?.check ?? "", /not in the sequence/);
  const f = item.findings[0];
  assert.ok(f && f.configs.length > 0 && f.applied.length > 0 && f.folder);
  const moved = await wrong({
    ...read,
    L: rec.length(),
    items: [{ position: 1, id: new Uint8Array(32) }],
  });
  assert.match(moved.findings[0]?.check ?? "", /position 1 read before the cut differs/);
  const head = await wrong({ ...read, L: rec.length(), head: { ...read.head, n: 9 } });
  assert.match(head.findings[0]?.check ?? "", /given back was answered/);
});

async function everyImage(t: { diagnostic(m: string): void }, source: string) {
  const { platform, rec } = await recorded(source);
  const start = Date.now();
  const { images, window, findings, failures, unprobed } = await checkRecording(rec, platform, 2);
  const lines = findings.map(
    (f) =>
      `${isDefect(f) ? "DEFECT" : "dependency"} ${f.configs.join(", ")}: ${f.how}@${f.cut} ${f.check} (${f.folder})`,
  );
  const seconds = (Date.now() - start) / 1000;
  t.diagnostic(
    `${rec.records().length} records, ${images} images, window ${window}, ${seconds} s two at a time, ${lines.length} findings, ${unprobed} unprobed\n${lines.join("\n")}`,
  );
  assert.deepEqual([failures, lines.filter((l) => l.startsWith("DEFECT")), unprobed], [[], [], 0]);
}
const FULL = {
  ...DARWIN,
  timeout: 280_000,
  skip: process.env.PARDNER_CRASH_FULL
    ? false
    : "set PARDNER_CRASH_FULL=1 to run every image (about a minute each)",
};
test("every image of that workload under every configuration (PARDNER_CRASH_FULL=1)", FULL, (t) =>
  everyImage(t, SCRIPT),
);
test("every image of a lost and a recreated directory (PARDNER_CRASH_FULL=1)", FULL, (t) =>
  everyImage(t, LOST),
);
