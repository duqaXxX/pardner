/**
 * The crash images by hand (crash images design 7.2): `node test/support/crash/cli.ts <workload|folder|cases|init>
 * [--config <name>] [--parallel N] [--level 1]`. A workload is a script file, a folder of them (searched down), `init` or `cases`
 * (init and the six cases of 4.1, each with its record check); `--level 1` adds design 5.5's images of each image's own
 * start. Prints design 5.4's report and a line per workload;
 * exits 1 on a finding under M or M with A3, a failure of a workload or an image no check could probe. A finding
 * only under M without A2 or M with the split rename is RD 11's dependency (design 3.2): reported, never a failure.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CASES } from "./cases.ts";
import { checkRecording, type Finding, isDefect, kept, removeUnkept } from "./check.ts";
import { levelOne } from "./level.ts";
import { CONFIGS } from "./replay.ts";
import type { Recording } from "./segments.ts";
import { recorded } from "./workload.ts";

/** The scripts of a path: the file itself, or every `.jsonl` under a folder. */
export function scriptsUnder(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .sort()
    .flatMap((n) => scriptsUnder(join(path, n)))
    .filter((p) => p.endsWith(".jsonl"));
}

const report = (name: string, f: Finding) =>
  [
    `FINDING ${name}: ${f.configs.join(", ")}: ${f.how}@${f.cut}`,
    `  check: ${f.check}`,
    `  applied (${f.applied.length}): ${f.applied.slice(-12).join(" ")}`,
    `  dropped (${f.dropped.length}): ${f.dropped.join(" ")}`,
    `  relay log: ${f.log.trim().split("\n").slice(-6).join(" | ")}`,
    `  image kept: ${f.folder}`,
  ].join("\n");

type Opts = { config?: string; parallel: number; level: number };

/** One workload: records it, judges every image under the chosen configurations, prints the report; true when it is clean. */
async function runOne(
  name: string,
  source: string,
  check: ((r: Recording) => unknown) | undefined,
  o: Opts,
) {
  const configs = CONFIGS.filter((c) => !o.config || c.name === o.config);
  const begun = Date.now();
  const out = {
    images: 0,
    window: 0,
    findings: [] as Finding[],
    failures: [] as string[],
    unprobed: 0,
    extra: "",
  };
  try {
    const { rec, platform } = await recorded(source);
    const window = check?.(rec);
    if (typeof window === "string") throw new Error(`the record check: ${window}`);
    const run = await checkRecording(rec, platform, o.parallel, undefined, undefined, configs);
    Object.assign(out, { images: run.images, window: run.window, unprobed: run.unprobed });
    out.findings.push(...run.findings);
    out.failures.push(...run.failures);
    if (o.level > 0) {
      const l = await levelOne(rec, platform, run.judged, o.parallel);
      out.findings.push(...l.findings);
      out.failures.push(...l.failures);
      out.unprobed += l.unprobed;
      out.extra = `, level 1: ${l.starts} starts that change the directory, ${l.images} images, ${l.bound} held to the outer sequence`;
    }
  } catch (e) {
    out.failures.push(`workload failure: ${(e as Error).message}`);
  }
  for (const f of out.findings) console.log(report(name, f));
  for (const f of out.failures) console.log(`FAILURE ${name}: ${f}`);
  const per = configs.map(
    (c) => `${c.name} ${out.findings.filter((f) => f.configs.includes(c.name)).length}`,
  );
  console.log(
    `${name}: ${out.images} images, window ${out.window}, ${((Date.now() - begun) / 1000).toFixed(1)} s, findings ${per.join(", ")}, ${out.failures.length} failures, ${out.unprobed} unprobed${out.extra}`,
  );
  return out.failures.length === 0 && out.unprobed === 0 && !out.findings.some(isDefect);
}

/** Runs the command line `argv`; resolves to the exit code (0 clean, 1 a finding, a failure or an unprobed image). */
export async function main(argv: string[]) {
  const usage = `usage: cli.ts <workload|folder|init|cases> [--config ${CONFIGS.map((c) => c.name).join("|")}] [--parallel N] [--level 1]`;
  const parse = () =>
    parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string" },
        parallel: { type: "string" },
        level: { type: "string" },
      },
    });
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse();
  } catch (e) {
    throw new Error(`${(e as Error).message}\n${usage}`);
  }
  const { values, positionals } = parsed;
  const o: Opts = {
    config: values.config,
    parallel: Number(values.parallel ?? 1),
    level: Number(values.level ?? 0),
  };
  const [target] = positionals;
  if (
    !target ||
    !(o.parallel >= 1) ||
    ![0, 1].includes(o.level) ||
    (o.config && !CONFIGS.some((c) => c.name === o.config))
  )
    throw new Error(usage);
  const work: [string, string, ((r: Recording) => unknown) | undefined][] =
    target === "init" || target === "cases"
      ? CASES.filter((c) => target === "cases" || c.name === "init").map((c) => [
          c.name,
          c.script,
          c.check,
        ])
      : scriptsUnder(resolve(target)).map((p) => [p, readFileSync(p, "utf8"), undefined]);
  if (work.length === 0) throw new Error(`no .jsonl script under ${target}\n${usage}`);
  let clean = true;
  for (const [name, source, check] of work) clean = (await runOne(name, source, check, o)) && clean;
  console.log(
    clean ? "clean" : `findings, failures or unprobed images; images kept: ${kept.join(" ")}`,
  );
  return clean ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Ctrl-C: the folders of the run in progress go, the kept ones stay (relay children end with this process).
  process.on("SIGINT", () => {
    removeUnkept();
    process.exit(130);
  });
  process.exitCode = await main(process.argv.slice(2));
}
