/**
 * The adapter from the host layer to the core's questions (`updatesHost`): what
 * supervised, sharing and the lock mean on the machine, over a machine whose npm and service
 * managers are fields (`FakeMachine`). The real machine is never reached.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { logPath } from "../src/host/service/launchd.ts";
import { relayJobs } from "../src/host/service/relay.ts";
import { logger, updatesHost } from "../src/updates-host.ts";
import { changelogOf } from "../src/version.ts";
import { machineOf } from "./support/relay-machine.ts";
import { FakeJobs, FakeMachine, FakeService } from "./support/updates.ts";

function setup(t: TestContext, name: string | null = null, service = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "awd-updates-host-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const machine = new FakeMachine(base, "0.3.0");
  const own = new FakeService();
  if (service) machine.services.set(name ?? "", own);
  const restarts: string[] = [];
  const host = updatesHost({
    machine,
    instance: { name },
    home: join(base, "home"),
    installed: "0.3.0",
    restart: () => restarts.push("restart"),
  });
  return { base, machine, host, own, restarts };
}

const entry = (copy: string, version = "0.3.0") => ({ copy, version });

test("a daemon is supervised only when its service runs this very process", (t) => {
  const running = setup(t);
  assert.equal(running.host.supervised(), false, "not running");
  running.own.pid = process.pid;
  assert.equal(running.host.supervised(), true, "running this process");
  const other = setup(t);
  other.own.pid = process.pid + 1;
  assert.equal(other.host.supervised(), false, "another process");
});

test("which process started the daemon is asked of the service manager once it answers", (t) => {
  const { host, own } = setup(t);
  let asked = 0;
  const runningPid = own.runningPid.bind(own);
  own.runningPid = () => {
    asked += 1;
    return runningPid();
  };
  // No pid is no answer: a manager that cannot say looks the same as a service that is not running.
  assert.equal(host.supervised(), false);
  assert.equal(host.supervised(), false);
  assert.equal(asked, 2, "asked again while the manager gave no pid");
  own.pid = process.pid;
  for (let draw = 0; draw < 5; draw += 1) assert.equal(host.supervised(), true);
  own.pid = process.pid + 1; // the page is redrawn on every refresh: the manager is not asked again
  assert.equal(host.supervised(), true);
  assert.equal(asked, 3);
});

test("a system with no service manager is never supervised, shares nothing and restarts nothing", async (t) => {
  const { host, machine } = setup(t, null, false);
  assert.equal(host.supervised(), false);
  assert.deepEqual(host.sharing(machine.copy), []);
  await host.restartOthers(machine.copy);
});

test("sharing is the other loaded instances on the copy, this one left out", (t) => {
  const { host, machine, own } = setup(t);
  own.rows = [
    { instance: null, loaded: true, pid: process.pid, entry: entry(machine.copy) },
    { instance: "work2", loaded: true, pid: null, entry: entry(machine.copy) },
    { instance: "elsewhere", loaded: true, pid: 7, entry: entry("/another/copy") },
    { instance: "off", loaded: false, pid: null, entry: entry(machine.copy) },
  ];
  assert.deepEqual(host.sharing(machine.copy), ["work2"]);
});

test("a named instance leaves itself out and counts the default one", (t) => {
  const { host, machine, own } = setup(t, "work2");
  own.rows = [
    { instance: null, loaded: true, pid: 5, entry: entry(machine.copy) },
    { instance: "work2", loaded: true, pid: process.pid, entry: entry(machine.copy) },
  ];
  assert.deepEqual(host.sharing(machine.copy), [null]);
});

test("a listing that failed shares nothing", (t) => {
  const { host, machine, own } = setup(t);
  own.instances = () => ({ failure: "launchctl failed" });
  assert.deepEqual(host.sharing(machine.copy), []);
});

test("the restart goes to each other instance that runs, through its own manager", async (t) => {
  const { host, machine, own } = setup(t);
  const work2 = new FakeService();
  const idle = new FakeService();
  machine.services.set("work2", work2);
  machine.services.set("idle", idle);
  own.rows = [
    { instance: null, loaded: true, pid: process.pid, entry: entry(machine.copy) },
    { instance: "work2", loaded: true, pid: 9, entry: entry(machine.copy) },
    { instance: "idle", loaded: true, pid: null, entry: entry(machine.copy) },
  ];
  await host.restartOthers(machine.copy);
  assert.deepEqual([own.restarts, work2.restarts, idle.restarts], [0, 1, 0]);
});

test("a restart that a manager refuses does not stop the others, and is reported", async (t) => {
  const { host, machine, own } = setup(t);
  const first = new FakeService();
  const second = new FakeService();
  first.code = 1;
  machine.services.set("a", first);
  machine.services.set("b", second);
  own.rows = [
    { instance: "a", loaded: true, pid: 1, entry: entry(machine.copy) },
    { instance: "b", loaded: true, pid: 2, entry: entry(machine.copy) },
  ];
  assert.deepEqual(await host.restartOthers(machine.copy), [{ instance: "a", status: 1 }]);
  assert.deepEqual([first.restarts, second.restarts], [1, 1]);
});

test("an instance with no service manager to restart it is reported with no status", async (t) => {
  const { host, machine, own } = setup(t);
  own.rows = [{ instance: "gone", loaded: true, pid: 3, entry: entry(machine.copy) }];
  assert.deepEqual(await host.restartOthers(machine.copy), [{ instance: "gone", status: null }]);
});

test("jobs that cannot be read leave the instances' failures told", async (t) => {
  const { host, machine, own } = setup(t);
  own.rows = [{ instance: "gone", loaded: true, pid: 3, entry: entry(machine.copy) }];
  machine.copyJobs = {
    runningOn: () => {
      throw new Error("EACCES: the agents folder cannot be read");
    },
  };
  assert.deepEqual(await host.restartOthers(machine.copy), [{ instance: "gone", status: null }]);
});

test("every restart that went through reports nothing", async (t) => {
  const { host, machine, own } = setup(t);
  machine.services.set("work2", new FakeService());
  own.rows = [{ instance: "work2", loaded: true, pid: 9, entry: entry(machine.copy) }];
  assert.deepEqual(await host.restartOthers(machine.copy), []);
});

test("the restart goes to each running job of the copy, and the ones it did not reach are named by title", async (t) => {
  const { host, machine } = setup(t);
  const jobs = new FakeJobs({
    [machine.copy]: ["job-1", "job-2", "job-3"],
    "/elsewhere": ["job-9"],
  });
  jobs.codes.set("job-2", 1);
  machine.copyJobs = jobs;
  assert.deepEqual(await host.restartOthers(machine.copy), [
    { job: "job-2", reason: "restart refused" },
  ]);
  assert.deepEqual(jobs.restarted, ["job-1", "job-2", "job-3"], "a refusal does not stop the rest");
  assert.deepEqual(jobs.asked, [machine.copy]);
});

test("a job listing that cannot be read is logged, and the daemons' restarts stand", async (t) => {
  const { host, machine, own } = setup(t);
  const work2 = new FakeService();
  machine.services.set("work2", work2);
  own.rows = [{ instance: "work2", loaded: true, pid: 9, entry: entry(machine.copy) }];
  const jobs = new FakeJobs({});
  jobs.failure = "launchctl list failed";
  machine.copyJobs = jobs;
  const warned = t.mock.method(logger, "warning", () => {});
  assert.deepEqual(await host.restartOthers(machine.copy), []);
  assert.equal(work2.restarts, 1);
  assert.match(
    String(warned.mock.calls[0]?.arguments[0]),
    /could not list the jobs on the copy: launchctl list failed/,
  );
});

test("the relay jobs of the copy are restarted through the host's jobs, three folders above their entry", async (t) => {
  const { host, machine, base } = setup(t);
  const home = join(base, "home");
  const run = machineOf(
    home,
    [
      {
        kind: "relay",
        instance: null,
        entry: join(machine.copy, "dist", "relay", "main.js"),
        pid: 5,
      },
      {
        kind: "relay",
        instance: "mini",
        entry: join(machine.copy, "dist", "relay", "main.js"),
        pid: 6,
      },
      { kind: "relay", instance: "else", entry: "/elsewhere/pardner/dist/relay/main.js", pid: 7 },
    ],
    ["launchctl kill"],
  );
  machine.copyJobs = relayJobs({ home, uid: 501, run });
  assert.deepEqual(await host.restartOthers(machine.copy), [
    { job: "the default relay", reason: "launchctl kill failed: refused" },
    { job: "relay `mini`", reason: "launchctl kill failed: refused" },
  ]);
  assert.equal(run.calls.filter((call) => call.args[0] === "kill").length, 2);
});

test("an update under way is asked of the machine's lock, this daemon's own take included", async (t) => {
  const { host } = setup(t);
  assert.equal(await host.updateHeld(), false);
  const held = await host.lock();
  assert.ok(held);
  assert.equal(await host.updateHeld(), true);
  await held.release();
  assert.equal(await host.updateHeld(), false);
});

// The probe's error comes from a file where a folder should be. Windows names its pipe from the
// folder's real path and answers ENOENT there, which reads as no lock: the case does not exist.
const NO_ENOTDIR = process.platform === "win32" && "Windows answers ENOENT, which reads as free";

test("a lock that cannot be asked about is no update under way, and is logged by its name", {
  skip: NO_ENOTDIR,
}, async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "awd-updates-host-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  // A file where the folder `.config` should be: the system answers ENOTDIR, not "free".
  const home = join(base, "home");
  writeFileSync(home, "");
  const host = updatesHost({
    machine: new FakeMachine(base, "0.3.0"),
    instance: { name: null },
    home,
    installed: "0.3.0",
    restart: () => {},
  });
  const warned = t.mock.method(logger, "warning", () => {});
  assert.equal(await host.updateHeld(), false);
  assert.equal(warned.mock.calls.length, 1);
  assert.match(
    String(warned.mock.calls[0]?.arguments[0]),
    /could not tell whether an update is under way: /,
  );
});

test("the lock is taken once on the machine and null while another process holds it", async (t) => {
  const { host } = setup(t);
  const held = await host.lock();
  assert.ok(held);
  assert.equal(await host.lock(), null);
  await held.release();
  const again = await host.lock();
  assert.ok(again);
  await again.release();
});

test("the questions go to npm with this process's entry and version", async (t) => {
  const { host, machine } = setup(t);
  const { signal } = new AbortController();
  assert.deepEqual(await host.latest(signal), { failure: { kind: "network" } });
  machine.newest = "0.3.1";
  assert.deepEqual(await host.latest(signal), { version: "0.3.1" });
  assert.deepEqual(await host.updatable(signal), { copy: machine.copy });
  assert.equal(host.copyVersion(machine.copy), "0.3.0");
  assert.deepEqual(await host.install(machine.copy, "0.3.1", signal), {
    kind: "installed",
    version: "0.3.1",
  });
  assert.equal(host.copyVersion(machine.copy), "0.3.1");
  assert.equal(host.installed, "0.3.0", "the version this process started as");
  // The signal that ends a question or an install reaches npm in every one of them.
  assert.ok(machine.npmSignals.length > 0);
  for (const given of machine.npmSignals) assert.equal(given, signal);
});

test("an entry file that is gone is a copy being replaced, not a copy outside the global folder", async (t) => {
  const { host, machine } = setup(t);
  machine.newest = "0.3.1";
  assert.deepEqual(await host.updatable(new AbortController().signal), { copy: machine.copy });
  // Another process's `npm install -g` moved the folder away: the file is not there for a while.
  rmSync(machine.entry());
  const asked = machine.npm.length;
  assert.deepEqual(await host.updatable(new AbortController().signal), { swapping: true });
  assert.equal(machine.npm.length, asked, "npm is not asked about a copy that is not there");
});

test("an entry that cannot be resolved because the file is gone is the same swap", async (t) => {
  const { host, machine } = setup(t);
  machine.entry = () => {
    throw Object.assign(new Error("ENOENT: no such file or directory, realpath"), {
      code: "ENOENT",
    });
  };
  assert.deepEqual(await host.updatable(new AbortController().signal), { swapping: true });
  machine.entry = () => {
    throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  };
  await assert.rejects(host.updatable(new AbortController().signal), /EACCES/);
});

test("restart asks this daemon's own stop; the log and the changelog are the instance's and the version's", (t) => {
  const { host, restarts, base } = setup(t, "work2");
  host.restart();
  assert.deepEqual(restarts, ["restart"]);
  assert.equal(host.logFile, logPath(join(base, "home"), "work2"));
  assert.equal(host.changelog("0.3.1"), changelogOf("0.3.1"));
});
