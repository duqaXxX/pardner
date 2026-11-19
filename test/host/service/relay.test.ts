/**
 * The relay's LaunchAgent: its plist, the `launchctl` calls of install, uninstall and restart,
 * its listing beside the daemon's (the two kinds never see each other), and the relay jobs an
 * update restarts. `launchctl` and `plutil` are faked at `Run`; the plist is written under a
 * temporary home, and the real `plutil` lints it where it exists.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCommand } from "../../../src/host/run.ts";
import { Launchd } from "../../../src/host/service/launchd.ts";
import {
  RelayLaunchd,
  relayCopyOf,
  relayJobs,
  relayLabelOf,
  relayLogPath,
  relayPlistFor,
  relayPlistPath,
} from "../../../src/host/service/relay.ts";
import { machineOf } from "../../support/relay-machine.ts";

const UID = 501;
const PROGRAM = {
  node: "/opt/homebrew/bin/node",
  entry: "/Us" + "ers/alice/.local/lib/node_modules/pardner/dist/relay/main.js",
};
const DIRECTORY = "/Us" + "ers/alice/.local/share/pardner-relay";
const COPY = "/Us" + "ers/alice/.local/lib/node_modules/pardner";

function home(t: { after(fn: () => void): void }): string {
  const path = mkdtempSync(join(tmpdir(), "pardner-relay-service-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

const relay = (path: string, run: ReturnType<typeof machineOf>, instance: string | null = null) =>
  new RelayLaunchd({ home: path, uid: UID, instance, run });

test("the names hold per instance, and share no prefix with the daemon's", () => {
  assert.equal(relayLabelOf(null), "local.pardner-relay");
  assert.equal(relayLabelOf("mini"), "local.pardner-relay.mini");
  assert.equal(
    relayPlistPath("/h", "mini"),
    "/h/Library/LaunchAgents/local.pardner-relay.mini.plist",
  );
  assert.equal(relayLogPath("/h", null), "/h/Library/Logs/pardner/pardner.relay.log");
  assert.equal(relayLogPath("/h", "mini"), "/h/Library/Logs/pardner/pardner.relay.mini.log");
  assert.ok(!relayLabelOf(null).startsWith("local.pardner."));
});

test("the plist runs the entry as serve on the directory and the address, kept alive, logging to the relay's file", () => {
  const log = relayLogPath("/h", "mini");
  assert.equal(
    relayPlistFor(PROGRAM, DIRECTORY, "0.0.0.0:7443", log, "mini"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.pardner-relay.mini</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PROGRAM.node}</string>
    <string>${PROGRAM.entry}</string>
    <string>serve</string>
    <string>--dir</string>
    <string>${DIRECTORY}</string>
    <string>--listen</string>
    <string>0.0.0.0:7443</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`,
  );
});

test("a path with markup characters is escaped, and plutil accepts the plist", {
  skip: process.platform !== "darwin",
}, (t) => {
  const path = home(t);
  const entry = "/a&b/<c>/main.js";
  const text = relayPlistFor({ ...PROGRAM, entry }, DIRECTORY, "h:1", "/l.log", null);
  assert.match(text, /<string>\/a&amp;b\/&lt;c&gt;\/main\.js<\/string>/);
  const file = join(path, "relay.plist");
  writeFileSync(file, text);
  assert.equal(runCommand("plutil", ["-lint", file]).status, 0);
});

test("install writes the plist, lints it and loads it, and says where the log is", (t) => {
  const path = home(t);
  const run = machineOf(path, []);
  const report = relay(path, run, "mini").install(PROGRAM, DIRECTORY, "127.0.0.1:7443");
  const file = relayPlistPath(path, "mini");
  assert.equal(report.code, 0);
  assert.equal(
    readFileSync(file, "utf8"),
    relayPlistFor(PROGRAM, DIRECTORY, "127.0.0.1:7443", relayLogPath(path, "mini"), "mini"),
  );
  assert.deepEqual(
    run.calls.map((call) => [call.command, ...call.args]),
    [
      ["launchctl", "list"],
      ["plutil", "-lint", file],
      ["launchctl", "bootstrap", `gui/${UID}`, file],
    ],
  );
  assert.deepEqual(report.out, [
    `Wrote ${file}.`,
    "Loaded local.pardner-relay.mini: the relay starts now and at every login.",
    `Log: ${relayLogPath(path, "mini")}`,
    "Whether it serves is in the log: look for `listening on port <n>`.",
  ]);
  assert.ok(existsSync(join(path, "Library", "Logs", "pardner")), "the log's folder exists");
});

test("install refuses while a job with the label is loaded, and writes nothing", (t) => {
  const path = home(t);
  const run = machineOf(path, [{ kind: "relay", instance: null, entry: PROGRAM.entry, pid: 7 }]);
  const file = relayPlistPath(path, null);
  const before = readFileSync(file, "utf8");
  const report = relay(path, run).install({ ...PROGRAM, node: "/other/node" }, DIRECTORY, "h:1");
  assert.equal(report.code, 1);
  assert.deepEqual(report.err, [
    "local.pardner-relay is loaded: uninstall it first to replace it.",
  ]);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(
    run.calls.some((call) => call.args[0] === "bootstrap"),
    false,
  );
});

test("install stops when plutil refuses the plist, loads nothing and leaves no plist", (t) => {
  const path = home(t);
  const run = machineOf(path, [], ["plutil -lint"]);
  const report = relay(path, run).install(PROGRAM, DIRECTORY, "h:1");
  assert.equal(report.code, 1);
  assert.match(report.err[0] as string, /^plutil refused .*local\.pardner-relay\.plist: /);
  assert.equal(
    run.calls.some((call) => call.args[0] === "bootstrap"),
    false,
  );
  assert.equal(existsSync(relayPlistPath(path, null)), false);
});

test("install reports a launchctl that refuses, with its words, and removes the plist it wrote", (t) => {
  // A plist left behind would start the relay at the next login.
  const path = home(t);
  const run = machineOf(path, [], ["launchctl bootstrap"]);
  const report = relay(path, run).install(PROGRAM, DIRECTORY, "h:1");
  assert.equal(report.code, 1);
  assert.deepEqual(report.err, [
    "launchctl bootstrap failed: refused",
    `Removed ${relayPlistPath(path, null)}.`,
  ]);
  assert.equal(existsSync(relayPlistPath(path, null)), false);
});

test("uninstall unloads the job, removes the plist and names the directory it leaves", (t) => {
  const path = home(t);
  const run = machineOf(path, [{ kind: "relay", instance: "mini", entry: PROGRAM.entry, pid: 7 }]);
  const report = relay(path, run, "mini").uninstall(DIRECTORY);
  assert.equal(report.code, 0);
  assert.equal(existsSync(relayPlistPath(path, "mini")), false);
  assert.ok(
    run.calls.some((call) => call.args.join(" ") === `bootout gui/${UID}/local.pardner-relay.mini`),
  );
  assert.deepEqual(report.out, [
    "Stopping local.pardner-relay.mini.",
    `Removed ${relayPlistPath(path, "mini")}.`,
    `Left in place: ${DIRECTORY} and ${join(path, "Library", "Logs", "pardner")}.`,
  ]);
  assert.deepEqual(relay(path, run, "mini").uninstall(DIRECTORY).code, 0);
});

test("uninstall of a job that is not there says so and touches nothing", (t) => {
  const path = home(t);
  const run = machineOf(path, []);
  assert.deepEqual(relay(path, run).uninstall(DIRECTORY).out, [
    "local.pardner-relay is not installed.",
  ]);
  assert.deepEqual(
    run.calls.map((call) => call.args[0]),
    ["list"],
  );
});

test("restart sends TERM to a running job, leaves one that does not run to launchd, and refuses one not loaded", (t) => {
  const path = home(t);
  const run = machineOf(path, [
    { kind: "relay", instance: null, entry: PROGRAM.entry, pid: 42 },
    { kind: "relay", instance: "idle", entry: PROGRAM.entry, pid: null },
  ]);
  const report = relay(path, run).restart();
  assert.deepEqual(report.out, [
    "Sent SIGTERM to local.pardner-relay (pid 42): launchd starts it again.",
  ]);
  assert.ok(
    run.calls.some((call) => call.args.join(" ") === `kill TERM gui/${UID}/local.pardner-relay`),
  );
  // launchd starts it on the copy as it is now: for an update, that is the restart it wanted.
  const idle = relay(path, run, "idle").restart();
  assert.equal(idle.code, 0);
  assert.deepEqual(idle.out, ["local.pardner-relay.idle is not running; launchd starts it again."]);
  assert.deepEqual(relay(path, run, "none").restart().err, [
    "local.pardner-relay.none is not loaded.",
  ]);
});

const BOTH = (path: string) =>
  machineOf(path, [
    { kind: "daemon", instance: null, entry: `${COPY}/dist/main.js`, pid: 11 },
    { kind: "daemon", instance: "relay", entry: `${COPY}/dist/main.js`, pid: 12 },
    { kind: "relay", instance: null, entry: `${COPY}/dist/relay/main.js`, pid: 21 },
    { kind: "relay", instance: "mini", entry: `${COPY}/dist/relay/main.js`, pid: null },
  ]);

test("the relay's listing shows relay jobs only, with the copy three folders above the entry", (t) => {
  const path = home(t);
  const report = relay(path, BOTH(path)).list();
  assert.equal(report.code, 0);
  assert.equal(relayCopyOf(`${COPY}/dist/relay/main.js`), COPY);
  const text = report.out.join("\n");
  assert.match(text, /^\(default\)\s+running, pid 21\s/m);
  assert.ok(text.includes(COPY), "the copy column is three folders above the entry");
  assert.match(text, /mini\s+loaded, not running/);
  assert.doesNotMatch(text, /pid 11|pid 12/, "no daemon is listed");
  assert.equal(report.out.length, 3, "a header and two jobs");
});

test("a relay job whose plist was removed by hand is listed as such, and a daemon is not", (t) => {
  const path = home(t);
  const run = machineOf(path, [
    { kind: "relay", instance: "mini", entry: `${COPY}/dist/relay/main.js`, pid: 9 },
    { kind: "daemon", instance: "relay", entry: `${COPY}/dist/main.js`, pid: 11 },
  ]);
  rmSync(relayPlistPath(path, "mini"));
  rmSync(join(path, "Library", "LaunchAgents", "local.pardner.relay.plist"));
  const listing = relay(path, run).instances();
  assert.deepEqual(listing, {
    rows: [{ instance: "mini", loaded: true, pid: 9, entry: "plist-gone" }],
    refused: [],
  });
  assert.match(relay(path, run).list().out.join("\n"), /mini\s+running, pid 9; its plist is gone/);
});

test("the daemon's listing shows daemons only, even one named relay", (t) => {
  const path = home(t);
  const run = BOTH(path);
  const listing = new Launchd({
    home: path,
    uid: UID,
    instance: null,
    configDir: join(path, ".config", "pardner"),
    run,
  }).instances();
  assert.ok(!("failure" in listing));
  assert.deepEqual(
    listing.rows.map((row) => [row.instance, row.pid]),
    [
      [null, 11],
      ["relay", 12],
    ],
  );
  assert.deepEqual(listing.refused, []);
});

test("a machine with no relay job says so", (t) => {
  const path = home(t);
  assert.deepEqual(relay(path, machineOf(path, [])).list().out, [
    "No pardner relay job is installed.",
  ]);
});

test("a file that is no relay job it can manage is named, not listed", (t) => {
  const path = home(t);
  const run = machineOf(path, [
    { kind: "relay", instance: "Bad_Name", entry: PROGRAM.entry, pid: 1 },
  ]);
  const listing = relay(path, run).instances();
  assert.ok(!("failure" in listing));
  assert.deepEqual(listing.rows, []);
  assert.match(
    listing.refused[0] as string,
    /local\.pardner-relay\.Bad_Name\.plist: not a pardner relay job it can manage/,
  );
});

test("a launchctl that cannot list is a failure, not an empty listing", (t) => {
  const path = home(t);
  assert.deepEqual(relay(path, machineOf(path, [], ["launchctl list"])).instances(), {
    failure: "launchctl list failed: refused",
  });
});

test("the jobs an update restarts are the running relay jobs of its copy, three folders up", (t) => {
  const path = home(t);
  const other = "/Us" + "ers/alice/other/pardner";
  const run = machineOf(path, [
    { kind: "daemon", instance: null, entry: `${COPY}/dist/main.js`, pid: 11 },
    { kind: "relay", instance: null, entry: `${COPY}/dist/relay/main.js`, pid: 21 },
    { kind: "relay", instance: "mini", entry: `${COPY}/dist/relay/main.js`, pid: 22 },
    { kind: "relay", instance: "idle", entry: `${COPY}/dist/relay/main.js`, pid: null },
    { kind: "relay", instance: "off", entry: `${COPY}/dist/relay/main.js`, pid: 23, loaded: false },
    { kind: "relay", instance: "else", entry: `${other}/dist/relay/main.js`, pid: 24 },
  ]);
  const jobs = relayJobs({ home: path, uid: UID, run }).runningOn(COPY);
  assert.ok(Array.isArray(jobs));
  assert.deepEqual(
    jobs.map((job) => job.title),
    ["the default relay", "relay `mini`"],
  );
  const report = jobs[1]?.restart();
  assert.equal(report?.code, 0);
  assert.ok(
    run.calls.some(
      (call) => call.args.join(" ") === `kill TERM gui/${UID}/local.pardner-relay.mini`,
    ),
  );
  // The daemon's own rule, two folders up, would see `<copy>/dist` and find none.
  assert.deepEqual(relayJobs({ home: path, uid: UID, run }).runningOn(`${COPY}/dist`), []);
});

test("a listing that fails is the sentence the update reports", (t) => {
  const path = home(t);
  const run = machineOf(path, [], ["launchctl list"]);
  assert.deepEqual(relayJobs({ home: path, uid: UID, run }).runningOn(COPY), {
    failure: "launchctl list failed: refused",
  });
});
