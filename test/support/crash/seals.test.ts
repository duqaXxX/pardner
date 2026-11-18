/** The seal and blob checks on recorded runs (design 5.3): a clean image passes, a wrong answer or a lost blob is a finding. */
import assert from "node:assert/strict";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { relayKeyId } from "../../../src/protocol/ids.ts";
import { DARWIN } from "../../relay/process-support.ts";
import { checkRecording, kept } from "./check.ts";
import type { Image } from "./images.ts";
import { digest, emptyBase, replay } from "./replay.ts";
import type { Recording } from "./segments.ts";
import { recorded } from "./workload.ts";

/** Two devices, an epoch sealed to the second, a blob and a message that names it, and the read that ends the run. */
const SCRIPT = `{"op":"prove","device":"app1","enrol":"s1","as":"g","expect":"served"}
{"op":"submit","entry":"create","as":"ch","expect":"result 0"}
{"op":"submit","entry":"add","device":"app2","as":"a2","expect":"result 0"}
{"op":"submit","entry":"epoch","as":"e1","expect":"result 0"}
{"op":"give-seal","epoch":"e1","recipient":"app2","expect":"result 0"}
{"op":"put-blob","as":"b1","expect":"result 0"}
{"op":"submit","entry":"message","epoch":"e1","files":["b1"],"counter":2,"as":"m2","expect":"result 0"}
{"op":"read","from":0,"expect":{"items":["g","ch","a2","e1","m2"],"n":5}}`;

/** The image no write is lost from: what the whole record leaves. */
const wholeAtEnd = (rec: Recording) => {
  const whole = digest(replay(rec.records(), emptyBase()));
  return (i: Image) => i.hash === whole;
};
after(() => {
  for (const dir of kept) rmSync(dir, { recursive: true, force: true });
});
const T = { ...DARWIN, timeout: 60_000 };
/** One run of the script for the tests that only add answers and take them away: recording it costs most of their time. */
let once: ReturnType<typeof recorded> | undefined;
const shared = () => {
  once ??= recorded(SCRIPT);
  return once;
};

test(
  "the whole image of a run with a seal and a blob is served as answered, nothing unprobed",
  T,
  async () => {
    const { platform, rec } = await shared();
    const [seal, served] = [
      rec.answers.find((a) => a.kind === "seal"),
      rec.answers.find((a) => a.kind === "served"),
    ];
    assert.ok(rec.answers.some((a) => a.kind === "blob"));
    assert.ok(seal?.kind === "seal" && served?.kind === "served");
    assert.equal(seal.maker, served.me?.id, "the maker of a seal is the device that gave it (K5)");
    const run = await checkRecording(rec, platform, 1, wholeAtEnd(rec));
    assert.deepEqual(
      [run.images >= 1, run.failures, run.findings.map((f) => f.check), run.unprobed],
      [true, [], [], 0],
    );
  },
);

test(
  "a seal answered result 0 that its recipient is not served is a finding, and one to a device the relay does not know too (K4)",
  T,
  async () => {
    const { platform, rec } = await shared();
    const seal = rec.answers.find((a) => a.kind === "seal");
    assert.ok(seal?.kind === "seal" && seal.recipient);
    const wrong = async (answer: typeof seal) => {
      rec.answers.push({ ...answer, L: rec.length() });
      const found = await checkRecording(rec, platform, 1, wholeAtEnd(rec));
      rec.answers.pop();
      assert.deepEqual(found.failures, []);
      return found;
    };
    const epoch = await wrong({ ...seal, epoch: new Uint8Array(32).fill(5) });
    assert.match(epoch.findings[0]?.check ?? "", /not served to its recipient/);
    const stranger = await wrong({
      ...seal,
      recipient: { ...seal.recipient, id: new Uint8Array(32).fill(4) },
    });
    assert.match(stranger.findings[0]?.check ?? "", /does not serve/);
    const recovery = await wrong({ ...seal, recipient: undefined });
    assert.deepEqual([recovery.findings.length, recovery.unprobed], [0, 1]);
  },
);

test("a message held whose blob is not is a finding", T, async () => {
  const { platform, rec } = await shared();
  const lose = (folder: string) => {
    const blobs = join(folder, "live", "relay", "blobs");
    for (const n of readdirSync(blobs)) rmSync(join(blobs, n));
  };
  const { findings } = await checkRecording(rec, platform, 1, wholeAtEnd(rec), lose);
  assert.match(findings[0]?.check ?? "", /names a blob the relay does not hold/);
});

test(
  "a lost decision answered later: the same head must be answered result 11 again",
  T,
  async () => {
    const { platform, rec } = await shared();
    const [read, served] = [
      rec.answers.findLast((a) => a.kind === "read"),
      rec.answers.findLast((a) => a.kind === "served"),
    ];
    assert.ok(read?.kind === "read" && served?.kind === "served");
    const head = {
      relay: relayKeyId(platform, served.relay),
      n: read.head.n,
      chain: read.head.chain,
    };
    // The uncut run is said to have answered 11 to this head after the last record: a start on an image with no mark must answer 11 too.
    rec.answers.push({
      L: rec.records().length + 1,
      gen: 0,
      kind: "closed",
      head: { head, sig: read.head.sig },
      me: read.me,
      relay: served.relay,
    });
    const { findings } = await checkRecording(rec, platform, 1, wholeAtEnd(rec));
    assert.match(findings[0]?.check ?? "", /not result 11/);
  },
);

test(
  "a marked image with no device known is probed with the printed secret, and counted unprobed when nothing was printed",
  T,
  async () => {
    const { platform, rec } = await shared();
    const recs = rec.records();
    const made =
      recs.findIndex((r) => r.op === "print" && r.text.startsWith("the relay is made")) + 1;
    // The whole image after init, which every later cut up to the next write leaves as well; no answer is bound yet.
    const after = digest(replay(recs.slice(0, made), emptyBase()));
    const first = rec.answers.find((a) => a.kind === "served")?.L ?? 0;
    const at = (i: Image) => i.hash === after && i.cut < first;
    const mark = (folder: string) =>
      writeFileSync(join(folder, "live", "relay", "failed-closed"), "");
    const probed = await checkRecording(rec, platform, 1, at, mark);
    assert.deepEqual(
      [probed.images, probed.findings.map((f) => f.check), probed.unprobed],
      [1, [], 0],
    );
  },
);

test(
  "a marked image after a put-back, in a run that never proves, is probed with the directory's own printed secret (R4-1)",
  T,
  async () => {
    const { platform, rec } = await recorded(`{"op":"relay","act":"copy","as":"k1"}
{"op":"relay","act":"put-back","copy":"k1"}`);
    const mark = (folder: string) =>
      writeFileSync(join(folder, "live", "relay", "failed-closed"), "");
    const { images, findings, unprobed } = await checkRecording(
      rec,
      platform,
      1,
      wholeAtEnd(rec),
      mark,
    );
    assert.deepEqual([images, findings.map((f) => f.check), unprobed], [2, [], 0]);
  },
);
