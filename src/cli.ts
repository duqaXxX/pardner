/**
 * The command line of `pardner`. With no argument the command runs the daemon, which is what the
 * service starts; the other forms answer and end without reading `.env` or taking the
 * single-instance lock. `--instance <name>`, or `PARDNER_INSTANCE` when the flag is absent, picks
 * which of the machine's daemons a command is about (`core/instance.ts`); this file is the only
 * reader of the variable.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configDirOf,
  DEFAULT_INSTANCE,
  INSTANCE_VARIABLE,
  type Instance,
  parseInstanceName,
} from "./core/instance.ts";
import { directoryHeld, UpdateUnderWay, updateDirectory, updateLock } from "./core/lock.ts";
import { answerWizard, type SetupModules } from "./core/wizard.ts";
import {
  type InstallResult,
  installVersion,
  isNewer,
  latestVersion,
  type NpmFailure,
  type Refusal,
  updatableCopy,
} from "./host/npm.ts";
import { findOnPath, type Program, programOf } from "./host/program.ts";
import { askTerminal, chooseTerminal, readLine } from "./host/prompter.ts";
import { type RelayProgram, relayDirOf, runRelayChild } from "./host/relay-child.ts";
import { type RunAsync, runAsync, runCommand } from "./host/run.ts";
import { Launchd } from "./host/service/launchd.ts";
import { loadedOn } from "./host/service/listing.ts";
import { RelayLaunchd, type RelayManager, relayJobs } from "./host/service/relay.ts";
import {
  type CopyJobs,
  type Report,
  SERVICE_ACTIONS,
  type ServiceAction,
  type ServiceManager,
} from "./host/service/seam.ts";
import { changelogOf, installedVersion } from "./version.ts";

export const USAGE = [
  "usage: pardner [--instance <name>]                    run the daemon",
  `       pardner service <${SERVICE_ACTIONS.join("|")}> [--instance <name>]`,
  "       pardner setup [--instance <name>]",
  "       pardner update [--check] [--yes]",
  "       pardner relay init [--instance <name>]",
  "       pardner relay serve --listen <host>:<port> [--instance <name>]",
  "       pardner relay service <install --listen <host>:<port>|uninstall|list> [--instance <name>]",
  "       pardner --version | --help",
  "",
  `--instance picks one of the machine's daemons; ${INSTANCE_VARIABLE} does the same when the flag`,
  "is absent. `service list` shows every instance and takes no --instance.",
  "`setup` asks for the tokens and writes the instance's `.env`; it refuses a file that exists.",
  "`update` installs the latest version of the copy that `npm install -g` replaces and restarts",
  "the services that run it, asking first unless --yes; --check only prints the versions.",
  "`relay` makes and runs a relay on this machine; its `--instance` names a relay and",
  `${INSTANCE_VARIABLE} does not apply to it. \`relay service list\` takes no --instance.`,
].join("\n");

export type Invocation =
  | { kind: "run"; instance: Instance }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "service"; action: ServiceAction; instance: Instance }
  | { kind: "setup"; instance: Instance }
  | { kind: "update"; check: boolean; yes: boolean }
  | { kind: "relay"; action: "init" | "uninstall" | "list"; instance: Instance }
  | { kind: "relay"; action: "serve" | "install"; instance: Instance; listen: string }
  | { kind: "invalid"; reason: string };

type Invalid = Extract<Invocation, { kind: "invalid" }>;

function isAction(text: string | undefined): text is ServiceAction {
  return (SERVICE_ACTIONS as readonly (string | undefined)[]).includes(text);
}

const invalid = (reason: string): Invalid => ({ kind: "invalid", reason });

/** The arguments without the flag `name` and its value, and the value when it was given. */
function takeFlag(
  args: readonly string[],
  name: "--instance" | "--listen",
): { rest: string[]; flag: string | undefined } | Invalid {
  const rest: string[] = [];
  let flag: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument !== name) {
      rest.push(argument);
      continue;
    }
    if (flag !== undefined) return invalid(`${name} is given twice`);
    const value = args[index + 1];
    if (value === undefined)
      return invalid(`${name} needs a ${name === "--listen" ? "value" : "name"}`);
    flag = value;
    index += 1;
  }
  return { rest, flag };
}

/**
 * `relay`'s arguments after the word: `init`, `serve`, or `service` with `install`, `uninstall` or
 * `list`. The instance is the flag's alone (`PARDNER_INSTANCE` names one of the daemons), and
 * `--listen` is checked as the relay checks it, since a job that exits on a bad address would be
 * started again every 10 seconds.
 */
function parseRelay(args: readonly string[], flag: string | undefined): Invocation {
  const taken = takeFlag(args, "--listen");
  if ("kind" in taken) return taken;
  const [first, ...more] = taken.rest;
  const service = first === "service";
  const [text, ...rest] = service ? more : taken.rest;
  const known = service ? ["install", "uninstall", "list"] : ["init", "serve"];
  if (text === undefined || !known.includes(text)) {
    return invalid(
      service
        ? "relay service needs install, uninstall or list"
        : "relay needs init, serve or service",
    );
  }
  if (rest.length > 0) return invalid(`unknown argument ${JSON.stringify(rest[0])}`);
  const action = text as "init" | "serve" | "install" | "uninstall" | "list";
  const words = service ? `relay service ${action}` : `relay ${action}`;
  const { flag: listen } = taken;
  if (action === "list" && flag !== undefined) {
    return invalid("relay service list takes no --instance: it lists every relay job");
  }
  const instance = flag === undefined ? DEFAULT_INSTANCE : parseInstanceName(flag);
  if (action !== "serve" && action !== "install") {
    if (listen !== undefined) return invalid(`${words} takes no --listen`);
    if ("refusal" in instance) return invalid(`--instance: ${instance.refusal}`);
    return { kind: "relay", action, instance };
  }
  // The relay's own check, which this file cannot import (`src/relay/main.ts`, `parse`).
  const port = /^.+:(\d{1,5})$/.exec(listen ?? "")?.[1];
  if (listen === undefined || port === undefined || Number(port) > 65535) {
    return invalid(`${words} needs --listen <host>:<port>`);
  }
  if ("refusal" in instance) return invalid(`--instance: ${instance.refusal}`);
  return { kind: "relay", action, instance, listen };
}

/** The instance the flag names, else the variable, else the default; the refusal says which. */
function instanceOf(flag: string | undefined, env: Env): Instance | Invalid {
  const variable = env[INSTANCE_VARIABLE];
  const named =
    flag !== undefined
      ? { source: "--instance", text: flag }
      : variable !== undefined && variable !== ""
        ? { source: INSTANCE_VARIABLE, text: variable }
        : null;
  if (named === null) return DEFAULT_INSTANCE;
  const parsed = parseInstanceName(named.text);
  return "refusal" in parsed
    ? invalid(`${named.source}: ${parsed.refusal}`)
    : { name: parsed.name };
}

/** `update`'s own flags: `--check` and `--yes`, once each and not together. */
function parseUpdate(
  args: ReadonlyArray<string | undefined>,
  flag: string | undefined,
): Invocation {
  if (flag !== undefined) {
    return invalid("update takes no instance: it updates the copy that all of them run");
  }
  const given = { "--check": false, "--yes": false };
  for (const argument of args) {
    if (argument === undefined) continue;
    if (argument !== "--check" && argument !== "--yes") {
      return invalid(`unknown argument ${JSON.stringify(argument)}`);
    }
    if (given[argument]) return invalid(`${argument} is given twice`);
    given[argument] = true;
  }
  if (given["--check"] && given["--yes"]) {
    return invalid("--check installs nothing, so --yes has no meaning with it");
  }
  return { kind: "update", check: given["--check"], yes: given["--yes"] };
}

/** The variables the command line reads; `process.env` in the entry. */
export type Env = Readonly<Record<string, string | undefined>>;

/** What the arguments after the command ask for; anything else is `invalid`, with the reason. */
export function parseArguments(args: readonly string[], env: Env = {}): Invocation {
  const taken = takeFlag(args, "--instance");
  if ("kind" in taken) return taken;
  const { rest: positional, flag } = taken;
  const [first, second, ...rest] = positional;
  if (first === "relay") return parseRelay(positional.slice(1), flag);
  if (first === "update") return parseUpdate([second, ...rest], flag);
  if (first === "setup") {
    if (second !== undefined) return invalid(`unknown argument ${JSON.stringify(second)}`);
    const instance = instanceOf(flag, env);
    return "kind" in instance ? instance : { kind: "setup", instance };
  }
  if (first === undefined) {
    const instance = instanceOf(flag, env);
    return "kind" in instance ? instance : { kind: "run", instance };
  }
  if (first === "service") {
    if (!isAction(second)) {
      return invalid(`service needs one of: ${SERVICE_ACTIONS.join(", ")}`);
    }
    if (rest.length > 0) return invalid(`unknown argument ${JSON.stringify(rest[0])}`);
    if (second === "list") {
      return flag === undefined
        ? { kind: "service", action: second, instance: DEFAULT_INSTANCE }
        : invalid("service list takes no instance: it lists them all");
    }
    const instance = instanceOf(flag, env);
    return "kind" in instance ? instance : { kind: "service", action: second, instance };
  }
  if (second !== undefined) return invalid(`unknown argument ${JSON.stringify(second)}`);
  if (first === "--version" || first === "--help") {
    if (flag !== undefined) return invalid(`${first} takes no instance`);
    return { kind: first === "--version" ? "version" : "help" };
  }
  return invalid(`unknown argument ${JSON.stringify(first)}`);
}

export interface Output {
  out(text: string): void;
  err(text: string): void;
}

/** What `answer` needs of the machine; `machineHost` is the real one. */
export interface Host {
  /** The service manager of this system for `instance`, or null where pardner has none. */
  service(instance: Instance): ServiceManager | null;
  /**
   * The program the service is to start: this command's Node and entry, and of `agentExecutables`
   * those this command's `PATH` finds.
   */
  program(agentExecutables: readonly string[]): Program;
  /** Whether an install of pardner runs on this machine now, as far as can be told. */
  updateUnderWay(): boolean;
}

/**
 * The relay's entry beside the running command: `relay/main.ts` when this runs from `src/`,
 * `relay/main.js` from `dist/`, so the sources and an installed copy behave alike.
 */
function relayEntry(): string {
  const here = fileURLToPath(import.meta.url);
  return realpathSync(join(dirname(here), "relay", `main${extname(here)}`));
}

/** The commands the agents in `agents` declare. */
function executablesOf(agents: SetupModules["agents"]): string[] {
  return Object.values(agents).flatMap((agent) => agent.executable ?? []);
}

export const machineHost: Host = {
  service: (instance) =>
    process.platform === "darwin"
      ? new Launchd({
          home: homedir(),
          uid: process.getuid?.() ?? 0,
          instance: instance.name,
          configDir: configDirOf(instance, homedir()),
          run: runCommand,
        })
      : null,
  program: (agentExecutables) =>
    programOf(process.argv[1] ?? "", process.env.PATH ?? "", process.execPath, agentExecutables),
  // A service exists on macOS alone, so its mechanism is read directly, and synchronously.
  updateUnderWay: () => {
    try {
      return directoryHeld(updateDirectory(homedir()));
    } catch {
      return false; // A lock that cannot be read must not keep the owner from stopping a service.
    }
  },
};

/**
 * Answers an invocation that does not run the daemon, and returns the exit status: 0, 2 for
 * arguments it does not know (with the usage on stderr), or the service action's own status.
 * `agents` are the registry's, whose commands the service's `PATH` finds.
 */
export function answer(
  invocation: Exclude<Invocation, { kind: "run" | "update" | "setup" | "relay" }>,
  output: Output,
  agents: SetupModules["agents"],
  host: Host = machineHost,
): number {
  switch (invocation.kind) {
    case "version":
      output.out(`${installedVersion()}\n`);
      return 0;
    case "help":
      output.out(`${USAGE}\n`);
      return 0;
    case "invalid":
      output.err(`pardner: ${invocation.reason}\n${USAGE}\n`);
      return 2;
    case "service": {
      const manager = host.service(invocation.instance);
      if (manager === null) {
        output.err("pardner service: pardner runs as a service on macOS only, for now.\n");
        return 1;
      }
      // `bootout` kills a running daemon within `ExitTimeOut`, and npm with it if it is installing.
      // The lock does not say who holds it, so another instance's or a terminal's update counts too.
      if (
        (invocation.action === "stop" || invocation.action === "uninstall") &&
        manager.runningPid() !== null &&
        host.updateUnderWay()
      ) {
        output.err(
          `pardner service ${invocation.action}: an update of pardner is under way on this machine; run this again once it has ended.\n`,
        );
        return 1;
      }
      const report =
        invocation.action === "install"
          ? manager.install(host.program(executablesOf(agents)))
          : manager[invocation.action]();
      for (const line of report.out) output.out(`${line}\n`);
      for (const line of report.err) output.err(`${line}\n`);
      return report.code;
    }
  }
}

/** What `relay` needs of the machine: the home its directory is under, and what it runs. */
export interface RelayHost {
  home: string;
  /**
   * The Node running this command, which passed `main.ts`'s version check, and the relay entry
   * beside it, resolved to its real path.
   */
  relayProgram(): RelayProgram;
  /**
   * What the relay's job runs: the Node the daemon's job would use, a path that survives a Node
   * update, and the same entry.
   */
  relayServiceProgram(): RelayProgram;
  /** The job manager of the relay instance named (null: the default one); null where pardner has none. */
  relayService(name: string | null): RelayManager | null;
}

/** What the relay's job manager needs of this machine. */
const relayMachine = () => ({ home: homedir(), uid: process.getuid?.() ?? 0, run: runCommand });

const machineRelayManager = (name: string | null): RelayManager | null =>
  process.platform === "darwin" ? new RelayLaunchd({ ...relayMachine(), instance: name }) : null;

export const machineRelayHost: RelayHost = {
  home: homedir(),
  relayProgram: () => ({ node: process.execPath, entry: relayEntry() }),
  relayServiceProgram: () => ({
    node: findOnPath("node", process.env.PATH ?? "") ?? process.execPath,
    entry: relayEntry(),
  }),
  relayService: machineRelayManager,
};

/** The relay jobs, for an update to restart beside the daemons. */
export const machineJobs = (): CopyJobs | null =>
  process.platform === "darwin" ? relayJobs(relayMachine()) : null;

/**
 * Answers `pardner relay`: `init` and `serve` run the relay's own entry as a child and return its
 * exit status; the `service` actions go to the relay's job manager. 1 when either could not start.
 */
export async function answerRelay(
  invocation: Extract<Invocation, { kind: "relay" }>,
  output: Output,
  host: RelayHost = machineRelayHost,
): Promise<number> {
  const directory = relayDirOf(invocation.instance.name, host.home);
  const refuse = (sentence: string): number => {
    output.err(`pardner relay: ${sentence}\n`);
    return 1;
  };
  try {
    if (invocation.action === "init" || invocation.action === "serve") {
      // `init` makes the directory and not the folder it is in, `~/.local/share`: 0700 when made
      // here, and `~/.local` with the default mode.
      const parent = dirname(directory);
      if (invocation.action === "init" && !existsSync(parent)) {
        mkdirSync(dirname(parent), { recursive: true });
        mkdirSync(parent, { mode: 0o700 });
      }
      const args =
        "listen" in invocation
          ? ["serve", "--dir", directory, "--listen", invocation.listen]
          : ["init", "--dir", directory];
      return await runRelayChild(host.relayProgram(), args, output.err);
    }
    const manager = host.relayService(invocation.instance.name);
    if (manager === null) return refuse("it runs as a service on macOS only, for now.");
    let report: Report;
    if ("listen" in invocation) {
      const flag =
        invocation.instance.name === null ? "" : ` --instance ${invocation.instance.name}`;
      // `key.pem` is what `init` writes: a folder without it is no relay, and a job on it would
      // exit and be started again every 10 seconds.
      if (!existsSync(join(directory, "key.pem"))) {
        return refuse(`${directory} holds no relay: \`pardner relay init${flag}\` makes it.`);
      }
      if (directoryHeld(directory)) {
        return refuse(
          `a relay is running on ${directory}: \`pardner relay service uninstall${flag}\` stops one installed as a service, \`pgrep -f relay/main\` finds one started by hand, to stop with \`kill\`; then install.`,
        );
      }
      report = manager.install(host.relayServiceProgram(), directory, invocation.listen);
    } else {
      report = invocation.action === "list" ? manager.list() : manager.uninstall(directory);
    }
    for (const line of report.out) output.out(`${line}\n`);
    for (const line of report.err) output.err(`${line}\n`);
    return report.code;
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Answers every invocation but `run` and `setup`, awaiting the ones that run something (`update`,
 * `relay`), and returns the exit status.
 */
export async function answerCommand(
  invocation: Exclude<Invocation, { kind: "run" | "setup" }>,
  output: Output,
  agents: SetupModules["agents"],
): Promise<number> {
  if (invocation.kind === "update") return answerUpdate(invocation, output);
  if (invocation.kind === "relay") return answerRelay(invocation, output);
  return answer(invocation, output, agents);
}

/** What `setup` needs of the machine beyond the service: the home and a terminal to ask on. */
export interface SetupHost extends Host {
  home: string;
  /** Whether there is a terminal to ask on. */
  interactive: boolean;
  /** The line the owner types after `message`, or null when they end the wizard. */
  ask(message: string, secret: boolean): Promise<string | null>;
  /** The name the owner picks from `names`, `preselected` first, or null when they end the wizard. */
  choose(message: string, names: readonly string[], preselected: string): Promise<string | null>;
}

export const machineSetupHost: SetupHost = {
  ...machineHost,
  home: homedir(),
  // A getter, as in `machineUpdateHost`.
  get interactive() {
    return process.stdin.isTTY === true && process.stdout.isTTY === true;
  },
  ask: askTerminal,
  choose: chooseTerminal,
};

/**
 * Answers `pardner setup` with `modules`, the one chat and the agents the registry holds; the
 * owner picks the agent. Returns the wizard's exit status.
 */
export function answerSetup(
  invocation: Extract<Invocation, { kind: "setup" }>,
  modules: SetupModules,
  output: Output,
  host: SetupHost = machineSetupHost,
): Promise<number> {
  const manager = host.service(invocation.instance);
  return answerWizard(invocation.instance, modules, output, {
    home: host.home,
    interactive: host.interactive,
    prompter: { ask: host.ask, choose: host.choose },
    installService:
      manager === null ? null : () => manager.install(host.program(executablesOf(modules.agents))),
  });
}

/** What `update` needs of the machine beyond the service: npm, the home, a terminal. */
export interface UpdateHost extends Host {
  /** The other jobs that run a copy, which an update restarts with the daemons; null where there are none. */
  jobs(): CopyJobs | null;
  /** Runs npm. */
  run: RunAsync;
  /** The owner's home, where the update lock lives. */
  home: string;
  /** The version of this process, read from its own `package.json` at its start. */
  version(): string;
  /** Whether there is a terminal to ask on. */
  interactive: boolean;
  /** Prints `question` and returns the line the owner types. */
  ask(question: string): Promise<string>;
}

export const machineUpdateHost: UpdateHost = {
  ...machineHost,
  jobs: machineJobs,
  run: runAsync,
  home: homedir(),
  version: installedVersion,
  // A getter: reading `process.stdin` at import would open it in the daemon too.
  get interactive() {
    return process.stdin.isTTY === true && process.stdout.isTTY === true;
  },
  ask: (question) => readLine(question),
};

const failure = (output: Output, sentence: string): number => {
  output.err(`pardner update: ${sentence}\n`);
  return 1;
};

/** Why the latest version is unknown, from what npm failed with. */
function unknownLatest(why: NpmFailure): string {
  const reason =
    why.kind === "network"
      ? "npm could not reach the registry"
      : why.kind === "permission"
        ? "npm may not read what it needs"
        : why.status === null
          ? "npm could not be run"
          : `npm ended with status ${why.status}`;
  return `the latest version is unknown: ${reason}.`;
}

/** Why the copy is not one `update` replaces. */
function notUpdated(refusal: Refusal): string {
  switch (refusal.kind) {
    case "not-global":
      return `this copy is not updated by this command: it is not the copy \`npm install -g\` replaces (${refusal.folder}).`;
    case "link":
      return "this copy is not updated by this command: it is a link, not an install.";
    case "unpublished":
      return `this copy is not updated by this command: its version ${refusal.version} is not published on npm.`;
    case "npm":
      return unknownLatest(refusal.failure);
  }
}

/** The sentence for an install that did not leave the version asked, or null when it did. */
function installFailed(result: InstallResult, running: string, latest: string): string | null {
  switch (result.kind) {
    case "installed":
      return null;
    case "mismatch":
      return result.found === null
        ? `npm ended, but the copy's version cannot be read, so nothing was restarted; the services keep running ${running}. \`npm install -g pardner@${running}\` repairs it.`
        : `npm ended, but the copy now holds ${result.found} instead of ${latest}, so nothing was restarted; the services keep running ${running}. \`npm install -g pardner@${running}\` puts back the version that runs.`;
    case "failed": {
      const why = result.failure;
      const reason =
        why.kind === "network"
          ? "npm could not reach the registry"
          : why.kind === "permission"
            ? why.path === null
              ? "npm may not write where it installs"
              : `npm may not write to ${why.path}`
            : why.status === null
              ? "npm could not be run"
              : `npm ended with status ${why.status}`;
      return `the update failed: ${reason}. Nothing was restarted.`;
    }
  }
}

const instanceName = (instance: string | null): string => instance ?? "the default instance";

/**
 * Answers `pardner update`: `--check` prints the installed and the latest version; otherwise
 * checks that this copy is the one `npm install -g` replaces, asks (unless `--yes`), takes the
 * machine's update lock, installs the latest version, checks the copy now holds it, and sends the
 * restart to every service running this copy. Returns the exit status: 0 when it updated or had
 * nothing to do, 1 when it failed.
 */
export async function answerUpdate(
  invocation: Extract<Invocation, { kind: "update" }>,
  output: Output,
  host: UpdateHost = machineUpdateHost,
): Promise<number> {
  // Before anything is awaited: the install replaces the `package.json` this reads.
  const running = host.version();
  if (invocation.check) {
    const latest = await latestVersion(host.run);
    if ("failure" in latest) return failure(output, unknownLatest(latest.failure));
    output.out(`pardner ${running} · latest ${latest.version}\n`);
    return 0;
  }
  // Only the entry is read: an update installs no service.
  const updatable = await updatableCopy(host.run, host.program([]).main, running);
  if ("refusal" in updatable) return failure(output, notUpdated(updatable.refusal));
  const latest = await latestVersion(host.run);
  if ("failure" in latest) return failure(output, unknownLatest(latest.failure));
  if (!isNewer(latest.version, running)) {
    output.out(`pardner ${running} is already the latest version.\n`);
    return 0;
  }
  const listing = host.service(DEFAULT_INSTANCE)?.instances() ?? { rows: [], refused: [] };
  if ("failure" in listing) return failure(output, listing.failure);
  const jobs = host.jobs()?.runningOn(updatable.copy) ?? [];
  if ("failure" in jobs) return failure(output, jobs.failure);
  // The daemons and the other jobs that run this copy, each with how it is restarted. A daemon
  // waits for its running turns; another job restarts at once.
  const daemons = loadedOn(listing.rows, updatable.copy)
    .filter((row) => row.pid !== null)
    .map((row) => ({
      title: instanceName(row.instance),
      restart: () => host.service({ name: row.instance })?.restart(),
    }));
  const restarts = [...daemons, ...jobs];
  const wait =
    daemons.length === 0
      ? null
      : jobs.length === 0
        ? { sentence: " Running turns finish first.", clause: ": running turns finish first" }
        : {
            sentence: " Running turns finish first on the instances; the others restart at once.",
            clause: ": running turns finish first on the instances",
          };
  output.out(
    `Update pardner ${running} → ${latest.version} · What changed: ${changelogOf(latest.version)}\n`,
  );
  output.out(
    restarts.length === 0
      ? "No service runs this copy: it is installed and nothing restarts.\n"
      : `It restarts: ${restarts.map((job) => job.title).join(", ")}.${wait?.sentence ?? ""}\n`,
  );
  if (!invocation.yes) {
    if (!host.interactive) {
      return failure(output, "there is no terminal to ask on; --yes updates without asking.");
    }
    // Ctrl-C and Ctrl-D end the question like any answer that is not a yes.
    const reply = await host.ask("Update? [y/N] ").catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") return "";
      throw error;
    });
    if (!/^y(es)?$/i.test(reply.trim())) {
      output.out("Not updated.\n");
      return 0;
    }
  }
  let lock: Awaited<ReturnType<typeof updateLock>>;
  try {
    lock = await updateLock(host.home);
  } catch (error) {
    if (error instanceof UpdateUnderWay) {
      return failure(output, "an update of pardner is already under way on this machine.");
    }
    throw error;
  }
  try {
    output.out(`Installing pardner ${latest.version}…\n`);
    const installed = await installVersion(host.run, updatable.copy, latest.version);
    const refusal = installFailed(installed, running, latest.version);
    if (refusal !== null) return failure(output, refusal);
  } finally {
    await lock.release();
  }
  const sent: string[] = [];
  let code = 0;
  for (const job of restarts) {
    const report = job.restart();
    if (report === undefined || report.code !== 0) {
      code = 1;
      for (const line of report?.err ?? []) output.err(`${job.title}: ${line}\n`);
    } else {
      sent.push(job.title);
    }
  }
  const named =
    sent.length < 2 ? sent.join("") : `${sent.slice(0, -1).join(", ")} and ${sent.at(-1)}`;
  output.out(
    restarts.length === 0
      ? `Installed pardner ${latest.version}. No service runs this copy, so nothing was restarted.\n`
      : sent.length === 0
        ? `Installed pardner ${latest.version}.\n`
        : `Installed pardner ${latest.version}. Sent the restart to ${named}${wait?.clause ?? ""}.\n`,
  );
  return code;
}
