/**
 * The relay's job on macOS: a user LaunchAgent, `local.pardner-relay[.<name>]`, that runs the
 * relay's own entry file (relay design 2.1: the relay is a program of its own). The label shares no
 * prefix with the daemon's `local.pardner.`, so neither listing sees the other's jobs, and the log
 * name holds a dot, which no daemon instance can produce. Everything that names the relay in the
 * host layer is in this file.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { packageVersion } from "../../version.ts";
import { copyOf } from "../program.ts";
import type { RelayProgram } from "../relay-child.ts";
import { failed, isInstanceName, listedJob, listedRows, ok, plistFacts, xml } from "./launchd.ts";
import { listReport } from "./listing.ts";
import type { InstanceListing, InstanceRow, Report, Run } from "./seam.ts";

const BASE_LABEL = "local.pardner-relay";

export function relayLabelOf(instance: string | null): string {
  return instance === null ? BASE_LABEL : `${BASE_LABEL}.${instance}`;
}

export function relayPlistPath(home: string, instance: string | null): string {
  return join(home, "Library", "LaunchAgents", `${relayLabelOf(instance)}.plist`);
}

/** `pardner.relay.log` or `pardner.relay.<name>.log`. */
export function relayLogPath(home: string, instance: string | null): string {
  const name = instance === null ? "" : `.${instance}`;
  return join(home, "Library", "Logs", "pardner", `pardner.relay${name}.log`);
}

/** The package folder of the copy whose relay entry is `entry`: three folders above `dist/relay/main.js`. */
export function relayCopyOf(entry: string): string {
  return dirname(copyOf(entry));
}

/** The plist that runs `program` as `serve` on `directory` and `listen`, kept alive. */
export function relayPlistFor(
  program: RelayProgram,
  directory: string,
  listen: string,
  log: string,
  instance: string | null,
): string {
  const args = [program.node, program.entry, "serve", "--dir", directory, "--listen", listen];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${relayLabelOf(instance)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((text) => `    <string>${xml(text)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** What the machine's service manager does for the relay's job. */
export interface RelayManager {
  /** Writes the job's definition and loads it; refused while a job with the label is loaded. */
  install(program: RelayProgram, directory: string, listen: string): Report;
  /** Unloads the job and removes its definition; leaves `directory` and the log. */
  uninstall(directory: string): Report;
  /** Every relay job on the machine, printed. */
  list(): Report;
  /** The data `list` prints: the rows are the relay jobs, `entry.copy` the copy of each. */
  instances(): InstanceListing;
}

export interface RelayLaunchdOptions {
  home: string;
  uid: number;
  /** The relay instance's name, null for the default. `list` ignores it. */
  instance: string | null;
  run: Run;
}

const OWN_PLIST = /^local\.pardner-relay(?:\.(.+))?\.plist$/;

class LaunchctlFailed extends Error {}

/** The relay instance a loaded label names (null for the default), or undefined for another job. */
function instanceOfLabel(label: string): string | null | undefined {
  if (label === BASE_LABEL) return null;
  const name = label.startsWith(`${BASE_LABEL}.`) ? label.slice(BASE_LABEL.length + 1) : "";
  return isInstanceName(name) ? name : undefined;
}

export class RelayLaunchd implements RelayManager {
  readonly #options: RelayLaunchdOptions;

  constructor(options: RelayLaunchdOptions) {
    this.#options = options;
  }

  get #label(): string {
    return relayLabelOf(this.#options.instance);
  }

  get #plist(): string {
    return relayPlistPath(this.#options.home, this.#options.instance);
  }

  get #log(): string {
    return relayLogPath(this.#options.home, this.#options.instance);
  }

  #launchctl(args: readonly string[]): string {
    const result = this.#options.run("launchctl", args);
    if (result.status !== 0) {
      const said = (result.stderr || result.stdout).trim();
      throw new LaunchctlFailed(`launchctl ${args[0]} failed${said === "" ? "" : `: ${said}`}`);
    }
    return result.stdout;
  }

  #job(): ReturnType<typeof listedJob> {
    return listedJob(this.#launchctl(["list"]), this.#label);
  }

  /** The action's report, or the sentence of a launchctl or file failure. */
  #guarded(action: () => Report): Report {
    try {
      return action();
    } catch (error) {
      // A file it could not write: Node's message names its path and reason.
      const system = error instanceof Error && "code" in error && typeof error.code === "string";
      if (error instanceof LaunchctlFailed || system) return failed(1, [error.message]);
      throw error;
    }
  }

  install(program: RelayProgram, directory: string, listen: string): Report {
    return this.#guarded(() => {
      if (this.#job() !== null) {
        return failed(1, [`${this.#label} is loaded: uninstall it first to replace it.`]);
      }
      mkdirSync(dirname(this.#plist), { recursive: true });
      mkdirSync(dirname(this.#log), { recursive: true });
      writeFileSync(
        this.#plist,
        relayPlistFor(program, directory, listen, this.#log, this.#options.instance),
      );
      // A plist left behind after a refusal would start the relay at the next login.
      const lint = this.#options.run("plutil", ["-lint", this.#plist]);
      if (lint.status !== 0) {
        rmSync(this.#plist);
        return failed(1, [`plutil refused ${this.#plist}: ${(lint.stdout || lint.stderr).trim()}`]);
      }
      try {
        this.#launchctl(["bootstrap", `gui/${this.#options.uid}`, this.#plist]);
      } catch (error) {
        rmSync(this.#plist);
        if (!(error instanceof LaunchctlFailed)) throw error;
        return failed(1, [error.message, `Removed ${this.#plist}.`]);
      }
      return ok([
        `Wrote ${this.#plist}.`,
        `Loaded ${this.#label}: the relay starts now and at every login.`,
        `Log: ${this.#log}`,
        "Whether it serves is in the log: look for `listening on port <n>`.",
      ]);
    });
  }

  uninstall(directory: string): Report {
    return this.#guarded(() => {
      const loaded = this.#job() !== null;
      const present = existsSync(this.#plist);
      if (!loaded && !present) return ok([`${this.#label} is not installed.`]);
      const out: string[] = [];
      if (loaded) {
        this.#launchctl(["bootout", `gui/${this.#options.uid}/${this.#label}`]);
        out.push(`Stopping ${this.#label}.`);
      }
      if (present) {
        rmSync(this.#plist);
        out.push(`Removed ${this.#plist}.`);
      }
      out.push(`Left in place: ${directory} and ${dirname(this.#log)}.`);
      return ok(out);
    });
  }

  list(): Report {
    return listReport(this.instances(), "No pardner relay job is installed.");
  }

  instances(): InstanceListing {
    try {
      const directory = join(this.#options.home, "Library", "LaunchAgents");
      const files = existsSync(directory)
        ? readdirSync(directory)
            .filter((name) => OWN_PLIST.test(name))
            .sort()
        : [];
      const listing = this.#launchctl(["list"]);
      const rows: InstanceRow[] = [];
      // A job can outlive its plist (the file removed by hand): launchd keeps it loaded, and only
      // `launchctl list` knows, as for the daemon's listing.
      for (const { label, pid } of listedRows(listing)) {
        const instance = instanceOfLabel(label);
        if (instance !== undefined && !files.includes(`${label}.plist`)) {
          rows.push({ instance, loaded: true, pid, entry: "plist-gone" });
        }
      }
      const refused: string[] = [];
      for (const file of files) {
        const name = OWN_PLIST.exec(file)?.[1] ?? null;
        const facts = plistFacts(this.#options.run, join(directory, file));
        const reason =
          name !== null && !isInstanceName(name)
            ? `${JSON.stringify(name)} is not an instance name`
            : facts === null
              ? "its plist cannot be read"
              : facts.label !== relayLabelOf(name)
                ? `its Label is ${facts.label}, not ${relayLabelOf(name)}`
                : null;
        if (reason !== null) {
          refused.push(`${file}: not a pardner relay job it can manage: ${reason}`);
          continue;
        }
        const job = listedJob(listing, relayLabelOf(name));
        const base = { instance: name, loaded: job !== null, pid: job?.pid ?? null };
        const entry = facts?.args[1];
        if (entry === undefined) rows.push({ ...base, entry: "unreadable" });
        else {
          const copy = relayCopyOf(entry);
          rows.push({
            ...base,
            entry: { copy, version: packageVersion(join(copy, "package.json")) },
          });
        }
      }
      // The default instance first, then the others by name, as the daemon's listing.
      rows.sort((a, b) => (a.instance ?? "").localeCompare(b.instance ?? ""));
      return { rows, refused };
    } catch (error) {
      if (error instanceof LaunchctlFailed) return { failure: error.message };
      throw error;
    }
  }
}
