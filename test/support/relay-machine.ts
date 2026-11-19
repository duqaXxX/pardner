/**
 * A machine with relay jobs and daemons on it, for the tests of the relay's service and of the
 * updates that restart it: plists written under a temporary home, `launchctl` and `plutil` faked
 * at `Run` (the plist's facts come from the job list, not from a real `plutil`). Nothing real runs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { plistFor } from "../../src/host/service/launchd.ts";
import { relayLabelOf, relayLogPath, relayPlistFor } from "../../src/host/service/relay.ts";
import type { Run } from "../../src/host/service/seam.ts";

export interface MachineJob {
  /** `relay` for a relay's job, `daemon` for a daemon's. */
  kind: "relay" | "daemon";
  /** The instance's name, null for the default. */
  instance: string | null;
  /** The entry file the plist starts. */
  entry: string;
  /** The pid `launchctl list` shows; null for a loaded job that does not run. */
  pid: number | null;
  /** Whether `launchctl list` shows it; default true. */
  loaded?: boolean;
}

export interface Call {
  command: string;
  args: readonly string[];
}

const labelOf = (job: MachineJob): string =>
  job.kind === "relay"
    ? relayLabelOf(job.instance)
    : job.instance === null
      ? "local.pardner"
      : `local.pardner.${job.instance}`;

/** Writes each job's plist under `home` and returns a `Run` that answers for them, recording calls. */
export function machineOf(
  home: string,
  jobs: readonly MachineJob[],
  failing: readonly string[] = [],
): Run & { calls: Call[] } {
  const agents = join(home, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  const facts = new Map<string, { Label: string; ProgramArguments: string[] }>();
  for (const job of jobs) {
    const label = labelOf(job);
    const file = join(agents, `${label}.plist`);
    const args = [
      process.execPath,
      job.entry,
      ...(job.kind === "daemon" && job.instance !== null ? ["--instance", job.instance] : []),
    ];
    writeFileSync(
      file,
      job.kind === "relay"
        ? relayPlistFor(
            { node: process.execPath, entry: job.entry },
            join(home, "dir"),
            "127.0.0.1:1",
            relayLogPath(home, job.instance),
            job.instance,
          )
        : plistFor(
            { node: process.execPath, main: job.entry, npmBin: null, agentExecutables: [] },
            "/log",
            job.instance,
          ),
    );
    facts.set(basename(file), { Label: label, ProgramArguments: args });
  }
  const listing = [
    "PID\tStatus\tLabel",
    ...jobs
      .filter((job) => job.loaded !== false)
      .map((job) => `${job.pid ?? "-"}\t0\t${labelOf(job)}`),
  ].join("\n");
  const calls: Call[] = [];
  const run = ((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    if (failing.includes(`${command} ${args[0]}`)) {
      return { status: 1, stdout: "", stderr: "refused" };
    }
    if (command === "launchctl" && args[0] === "list") {
      return { status: 0, stdout: listing, stderr: "" };
    }
    if (command === "plutil" && args[0] === "-convert") {
      const found = facts.get(basename(args.at(-1) as string));
      if (found === undefined) return { status: 1, stdout: "", stderr: "unreadable" };
      return { status: 0, stdout: JSON.stringify(found), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  }) as Run & { calls: Call[] };
  run.calls = calls;
  return run;
}
