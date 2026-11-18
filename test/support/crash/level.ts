/**
 * One level of images of an image's own start (crash images design 5.5), by hand. A start repairs (a torn tail, the seals,
 * `tmp-` files) and a power cut can strike during it: the start of each image already judged is recorded, the images of
 * that record are built on the image as their base, and each is judged with the outer image's oracle. An image cut after
 * `listening` must serve the sequence the outer start served, since the relay signs heads over it from then on.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Platform } from "../../../src/protocol/platform.ts";
import { spawnNode } from "../../relay/child.ts";
import { watch } from "../../relay/process-support.ts";
import { type Finding, judge, kept, type Log, NoReference, roots, started, stop } from "./check.ts";
import { build, loadBase } from "./folder.ts";
import { enumerate, type Image } from "./images.ts";
import { recordedBody } from "./record.ts";
import { CONFIGS, digest, parse, type Rec, replay, type State } from "./replay.ts";
import type { Recording } from "./segments.ts";

const CHANGES = ["create", "mkdir", "remove", "truncate", "write", "writefile", "rename", "chmod"];
/** An image `checkRecording` judged, with the configurations that reach it and the sequence its start served. */
export type Outer = { image: Image; configs: string[]; items?: string };

/** The index of the record of the `listening` line, or -1 when the start never listened. */
export const listeningAt = (recs: Rec[]) =>
  recs.findIndex((r) => r.op === "print" && /listening on port/.test(r.text));

/** The images of a start's record, once each, with every configuration of the outer image that reaches them. */
export function innerImages(recs: Rec[], before: State, configs: string[]) {
  const found = new Map<string, { image: Image; configs: string[] }>();
  for (const cfg of CONFIGS.filter((c) => configs.includes(c.name)))
    for (const image of enumerate(recs, before, cfg).images) {
      const one = found.get(image.hash) ?? { image, configs: [] };
      one.configs.push(cfg.name);
      found.set(image.hash, one);
    }
  return [...found.values()];
}

/** The start of an image recorded, with the directory it began from; `rebuilt` is whether the record rebuilds what the start left. */
async function startOf(image: Image, tmp: string) {
  const folder = mkdtempSync(join(tmp, "start-"));
  try {
    build(image.state, join(folder, "live"));
    const before = loadBase(join(folder, "live"));
    const record = join(folder, "record");
    const args = ["serve", "--dir", join(folder, "live", "relay"), "--listen", "127.0.0.1:0"];
    const child = watch(spawnNode(recordedBody(join(folder, "live"), record, args)), 0);
    try {
      await started(child);
    } finally {
      await stop(child);
    }
    const recs = parse(readFileSync(record, "utf8"));
    const rebuilt = digest(replay(recs, before)) === digest(loadBase(join(folder, "live")));
    return { recs, before, rebuilt, listening: listeningAt(recs) };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Judges the start of each of `outer`, `cap` at a time; a throw in one image is a failure of the run, never a lost finding. */
export async function levelOne(rec: Recording, platform: Platform, outer: Outer[], cap: number) {
  const tmp = mkdtempSync(join(tmpdir(), "pardner-crash-level-"));
  roots.add(tmp);
  const findings: Finding[] = [];
  const failures = new Set<string>();
  let starts = 0;
  let images = 0;
  let bound = 0;
  let unprobed = 0;
  const queue = [...outer];
  try {
    await Promise.all(
      Array.from({ length: cap }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          try {
            const start = await startOf(job.image, tmp);
            if (!start.recs.some((r) => CHANGES.includes(r.op))) continue;
            if (!start.rebuilt) {
              failures.add(
                `the record of the start of ${job.image.how}@${job.image.cut} does not rebuild the directory`,
              );
              continue;
            }
            starts++;
            for (const { image, configs } of innerImages(start.recs, start.before, job.configs)) {
              images++;
              const folder = mkdtempSync(join(tmp, "image-"));
              build(image.state, join(folder, "live"));
              const must =
                image.cut > start.listening && start.listening >= 0 ? job.items : undefined;
              if (must !== undefined) bound++;
              const log: Log = { text: "", unprobed: 0, must };
              const failed = await judge(
                { ...job.image, state: image.state },
                rec,
                platform,
                folder,
                log,
              ).catch((e: Error) => {
                if (!(e instanceof NoReference)) return `the check threw: ${e.message}`;
                failures.add(e.message);
              });
              unprobed += log.unprobed > 0 ? 1 : 0;
              if (failed)
                findings.push({
                  cut: job.image.cut,
                  how: `start of ${job.image.how}@${job.image.cut}: ${image.how}@${image.cut}`,
                  configs,
                  check: failed,
                  applied: image.applied,
                  dropped: image.dropped,
                  log: log.text,
                  folder,
                });
              else rmSync(folder, { recursive: true, force: true });
            }
          } catch (e) {
            failures.add(`level one: ${(e as Error).message}`);
          }
        }
      }),
    );
  } finally {
    if (findings.length === 0) rmSync(tmp, { recursive: true, force: true });
    else kept.push(tmp);
    roots.delete(tmp);
  }
  return { starts, images, bound, findings, failures: [...failures], unprobed };
}
