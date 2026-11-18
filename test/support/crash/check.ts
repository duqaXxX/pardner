/**
 * The checker (crash images design 5): the relay is started on the folder of an image, with its real
 * `fsync`, and what it does and serves is held against what the device was told before the cut. The
 * checks speak the protocol through the scripted device's link; none reads the relay's files for
 * their format or imports the relay's code (design 6, never allowed 5).
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bytes, Platform } from "../../../src/protocol/platform.ts";
import { relayChild } from "../../relay/child.ts";
import { wait, watch } from "../../relay/process-support.ts";
import { dial, type Link, type Pass } from "../scripted-device/link.ts";
import { parse as parseScript, run } from "../scripted-device/script.ts";
import { build } from "./folder.ts";
import { enumerate, type Image } from "./images.ts";
import { answered } from "./oracle.ts";
import { CONFIGS, emptyBase } from "./replay.ts";
import { sealsAndBlobs } from "./seals.ts";
import type { Answer, Recording } from "./segments.ts";

const START_MS = 10_000;
/** The folders a run kept for its findings, for a test to remove (a `serve` by hand wants them, design 5.4). */
export const kept: string[] = [];
/** The folders of the runs in progress: a run that is cut short (Ctrl-C) leaves them, and `removeUnkept` takes them. */
export const roots = new Set<string>();
/** Removes the folders of the runs in progress that keep no finding (design 5.4 keeps a finding's image for a `serve` by hand). */
export function removeUnkept() {
  for (const dir of roots)
    if (!kept.includes(dir))
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  roots.clear();
}
/** Whether a finding is a defect of the relay: reachable under M or M with A3 (design 3.2, 5.4); the other configurations are RD 11's dependency. */
export const isDefect = (f: { configs: string[] }) =>
  f.configs.some((c) => c === "M" || c === "M with A3");
let enrolments = 0;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** How the relay's start on a folder ended: serving on a port, waiting for an init, exited, or not within `START_MS`. */
export async function started(child: ReturnType<typeof watch>) {
  for (let t = 0; t < START_MS; t += 20) {
    const port = /listening on port (\d+)/.exec(child.err())?.[1];
    if (port) return { kind: "serving" as const, port: Number(port) };
    if (/waiting for init/.test(child.err())) return { kind: "waiting" as const };
    const code = await Promise.race([child.exit, wait(20).then(() => "running" as const)]);
    if (code !== "running") return { kind: "exit" as const, code };
  }
  return { kind: "timeout" as const };
}

/** Ends the relay with SIGTERM, and with SIGKILL when it has not exited within `START_MS`. */
export async function stop(child: ReturnType<typeof watch>) {
  child.child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), START_MS);
  });
  if ((await Promise.race([child.exit, late]).finally(() => clearTimeout(timer))) === "late")
    child.child.kill("SIGKILL");
}

const generationOf = (rec: Recording, cut: number) =>
  rec.generations.filter((g) => g <= cut).length;

/** The read that ends a generation (5.3): its last from 0, or for a failed-closed one the last before the `copy` act that made its base. */
export function referenceOf(rec: Recording, gen: number): Answer | undefined {
  const reads = rec.answers.filter((a) => a.kind === "read" && a.items[0]?.position === 0);
  const closed = rec.answers.find((a) => a.gen === gen && a.kind === "closed");
  const limit = gen > 0 ? rec.opened[gen - 1]?.base : closed?.L;
  return (
    reads.findLast((a) => a.gen === gen) ??
    (closed && limit !== undefined ? reads.findLast((a) => a.L <= limit) : undefined)
  );
}

/**
 * The script's one device (design 4.1). It is demanded (a refusal is a finding) once its `served` answer
 * of this generation is bound before the cut, or when a put-back under the running relay made the
 * generation from a copy taken after it was served: the relay keeps its connection, so the copy holds its genesis.
 */
function deviceOf(rec: Recording, gen: number, oracle: Answer[]) {
  const me = rec.devices.get(
    rec.opened.slice(0, gen).findLastIndex((o) => o.base === undefined) + 1,
  );
  const own = (a: Answer): a is Answer & { kind: "served" } =>
    a.kind === "served" && hex(a.me?.id ?? new Uint8Array()) === hex(me?.id ?? new Uint8Array(1));
  const mine = rec.answers.filter(own);
  const { base, kept } = rec.opened[gen - 1] ?? {};
  const carried = kept && base !== undefined ? mine.findLast((a) => a.L <= base) : undefined;
  const served = mine.findLast((a) => a.gen === gen) ?? carried;
  if (!me || !served) return undefined;
  return {
    me,
    person: served.person,
    relay: served.relay,
    demanded: oracle.some(own) || !!carried,
  };
}

/** Thrown when no read from 0 ends the generation of an image: a failure of the workload, never a finding. */
export class NoReference extends Error {}

/** What a judged image leaves: the relay's log, the images no check could probe, the sequence the start served from 0, and the sequence an image of a start's own start must serve (design 5.5). */
export type Log = { text: string; unprobed: number; items?: string; must?: string };

/** The relay is started on `folder`, built from `image`, and the checks of design 5.1 to 5.3 are made against the oracle of its cut; the finding, or undefined. */
export async function judge(
  image: Image,
  rec: Recording,
  platform: Platform,
  folder: string,
  log: Log,
  main?: string,
) {
  const dir = join(folder, "live", "relay");
  const gen = generationOf(rec, image.cut);
  const own = rec
    .records()
    .slice(rec.generations.filter((g) => g <= image.cut).at(-1) ?? 0, image.cut);
  // The directory's own `init`: a put-back goes on with it, a `lose` or `recreate` begins another (RD 3.1).
  const lineage =
    rec.generations.filter((g, k) => g <= image.cut && rec.opened[k]?.base === undefined).at(-1) ??
    0;
  const printed = rec
    .records()
    .slice(lineage, image.cut)
    .findLast((r) => r.op === "print" && r.text.includes("relay public key"));
  const made = own.some((r) => r.op === "print" && r.text.startsWith("the relay is made"));
  const answers = rec.answers.filter((a) => a.gen === gen);
  const oracle = answers.filter((a) => a.L <= image.cut);
  const marked = existsSync(join(dir, "failed-closed"));
  const serve = () =>
    watch(relayChild(["serve", "--dir", dir, "--listen", "127.0.0.1:0"], main), 0);
  const child = serve();
  let link: Link | undefined;
  try {
    const out = await started(child);
    if (out.kind === "waiting")
      return !existsSync(dir) && !made
        ? undefined
        : "waiting for an init, though the relay was made";
    if (out.kind !== "serving") return `the start ended as ${JSON.stringify(out)} (design 5.1)`;
    if (oracle.some((a) => a.kind === "closed") && !marked)
      return "result 11 was answered and the image holds no failed-closed (RD 6.5)";
    const device = deviceOf(rec, gen, oracle);
    let seen: Pass | undefined;
    if (device) {
      link = await dial(platform, out.port, device.relay);
      const proof = await link.proveActive(device.person, device.me.id, device.me.sign);
      if (marked && !(proof.type === "refused" && proof.reason === 6))
        return "a marked start did not refuse 6";
      if (!marked && proof.type !== "served" && device.demanded)
        return `the device answered before the cut is not served: ${proof.type}`;
      const got = !marked && proof.type === "served" ? await link.read(0) : undefined;
      if (got && (got.type !== "pass" || got.problems.length > 0))
        return `the read failed: ${got.type} ${got.type === "pass" ? got.problems : ""}`;
      if (got?.type === "pass") seen = got;
      if (seen) log.items = seen.items.map((i) => hex(i.id)).join();
      if (log.must !== undefined && log.must !== log.items)
        return "the start served another sequence, or none, than the outer start did (design 5.5)";
    }
    // A marked start with no device to prove as is probed by enrolling with what `init` printed, or counted unprobed.
    const probe = marked && !device ? await enrols(printed, out.port, "refused 6") : undefined;
    const failed =
      probe ??
      (seen &&
        (prefix(seen) ??
          (await answered(seen, oracle, device, platform, out.port)) ??
          (link && (await sealsAndBlobs(link, seen, oracle, platform, out.port, log))) ??
          (!marked && device ? await again(answers, device, out.port) : undefined)));
    if (failed) return failed;
    const left = existsSync(join(dir, "blobs"))
      ? readdirSync(join(dir, "blobs")).filter((n) => n.startsWith("tmp-"))
      : [];
    if (left.length > 0 || existsSync(join(dir, "tmp-failed-closed")))
      return "a temporary file is left after the start (RD 3.11)";
    if (seen && existsSync(join(dir, "enrol")) === seen.items.some((i) => i.kind === 1))
      return "enrol is present exactly when the sequence holds a device entry (RD 3.3)";
    // No sequence was read, so no device is enrolled: what `init` printed must enrol one (RD 3.1).
    return !seen && !marked ? await enrols(printed, out.port, "served") : undefined;
  } finally {
    log.text = child.err();
    link?.close();
    await stop(child);
  }

  /**
   * Case (c), RD 6.5: a decision to fail closed that the uncut run answered after this cut is lost with
   * the mark; the same head given back is answered `result 11` again, and a second start is failed closed.
   */
  async function again(all: Answer[], by: { relay: Bytes }, port: number) {
    const lost = all.find((a) => a.kind === "closed" && a.L > image.cut && a.head && a.me);
    if (lost?.kind !== "closed" || !lost.head || !lost.me) return undefined;
    const to = await dial(platform, port, by.relay);
    await to.proveUpload(lost.me, lost.head.head, lost.head.sig, 300);
    const done = await to.uploadDone(lost.head.head, lost.head.sig);
    to.close();
    if (done.type !== "result" || done.code !== 11)
      return `the head of a lost decision was answered ${JSON.stringify(done)}, not result 11 (RD 6.5)`;
    await stop(child);
    const second = serve();
    try {
      const up = await started(second);
      return up.kind === "serving" && existsSync(join(dir, "failed-closed"))
        ? undefined
        : "a second start after the decision is not failed closed (RD 6.5)";
    } finally {
      await stop(second);
    }
  }

  /** The key and secret `init` printed enrol a device, or a failed-closed start refuses them 6 (RD 3.1, 6.5); with nothing printed the image is unprobed. */
  async function enrols(text: (typeof own)[number] | undefined, port: number, expect: string) {
    const key = text?.op === "print" && /relay public key: ([0-9a-f]+)/.exec(text.text)?.[1];
    const secret = text?.op === "print" && /enrolment secret: ([0-9a-f]+)/.exec(text.text)?.[1];
    if (!key || !secret) {
      log.unprobed++;
      return undefined;
    }
    // Key names are held by the platform for good: each enrolment of a check has names of its own.
    const n = ++enrolments;
    const step = parseScript(
      `{"op":"prove","device":"d${n}","enrol":"r${n}","expect":"${expect}"}`,
    );
    const target = { port, relay: Buffer.from(key, "hex"), secret: Buffer.from(secret, "hex") };
    try {
      await run(step, target, platform);
    } catch (e) {
      return `the secret printed by init does not enrol: ${(e as Error).message}`;
    }
  }

  /** The sequence read from 0 is a prefix, item for item, of the generation's reference (RD 3.2, design 5.3). */
  function prefix(got: Pass) {
    const ref = referenceOf(rec, gen);
    if (ref?.kind !== "read") throw new NoReference(`generation ${gen}: no read from 0 ends it`);
    const ids = got.items.map((i) => hex(i.id));
    return ids.length > ref.items.length ||
      ids.some((id, i) => id !== hex(ref.items[i]?.id ?? new Uint8Array()))
      ? "the sequence is not a prefix of the reference (RD 3.2)"
      : undefined;
  }
}

export type Finding = {
  cut: number;
  how: string;
  configs: string[];
  check: string;
  applied: string[];
  dropped: string[];
  log: string;
  folder: string;
};

/**
 * Every image of the record under every configuration, each content judged once per generation and cut
 * with the oracle of its latest cut (design 3.3), `parallel` at a time. The record must rebuild the
 * directory first. An image that needs the reference of a generation no read ends is a failure of the
 * workload, apart from the findings, and is not judged. `judged` holds each image with its configurations and the sequence its start served (for design 5.5). `edit` changes each built folder before its start, to show that a check can fail.
 */
export async function checkRecording(
  rec: Recording,
  platform: Platform,
  parallel = 1,
  only: (image: Image) => boolean = () => true,
  edit: (folder: string) => void = () => {},
  configs = CONFIGS,
  main?: string,
) {
  rec.verify("the end of the run");
  const recs = rec.records();
  const tmp = mkdtempSync(join(tmpdir(), "pardner-crash-images-"));
  roots.add(tmp);
  const inside = (cut: number) => rec.synthetic.some(([from, to]) => from < cut && cut < to);
  const failures = new Set<string>();
  const jobs = new Map<string, { image: Image; configs: string[]; items?: string }>();
  let window = 0;
  const findings: Finding[] = [];
  let unprobed = 0;
  try {
    for (const cfg of configs) {
      const found = enumerate(recs, emptyBase(), cfg, {
        skip: inside,
        gen: (c) => generationOf(rec, c),
      });
      window = Math.max(window, found.window);
      for (const image of found.images.filter(only)) {
        const key = `${image.hash}@${image.cut}`;
        const job = jobs.get(key) ?? { image, configs: [] };
        job.configs.push(cfg.name);
        jobs.set(key, job);
      }
    }
    const queue = [...jobs.values()];
    await Promise.all(
      Array.from({ length: parallel }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          const folder = mkdtempSync(join(tmp, "image-"));
          build(job.image.state, join(folder, "live"));
          edit(folder);
          const log: Log = { text: "", unprobed: 0 };
          const failed = await judge(job.image, rec, platform, folder, log, main).catch(
            (e: Error) => {
              if (!(e instanceof NoReference)) return `the check threw: ${e.message}`;
              failures.add(e.message);
            },
          );
          if (failed) {
            const { cut, how, applied, dropped } = job.image;
            findings.push({
              cut,
              how,
              configs: job.configs,
              check: failed,
              applied,
              dropped,
              log: log.text,
              folder,
            });
          } else rmSync(folder, { recursive: true, force: true });
          job.items = log.items;
          unprobed += log.unprobed > 0 ? 1 : 0;
        }
      }),
    );
  } finally {
    // A finding keeps its folder for a `serve` by hand (design 5.4); with none nothing is left.
    if (findings.length === 0) rmSync(tmp, { recursive: true, force: true });
    else kept.push(tmp);
    roots.delete(tmp);
  }
  return {
    images: jobs.size,
    window,
    findings,
    failures: [...failures],
    unprobed,
    judged: [...jobs.values()],
  };
}
