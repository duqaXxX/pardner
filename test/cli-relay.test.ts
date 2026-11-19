/**
 * `pardner relay init|serve`: the arguments it reads, the names per instance, and what
 * `answerRelay` hands the child (a stub entry; see `test/host/relay-child.test.ts`).
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  answerRelay,
  machineRelayHost,
  type Output,
  parseArguments,
  type RelayHost,
} from "../src/cli.ts";
import { relayDirOf } from "../src/host/relay-child.ts";

const relay = (action: string, name: string | null, listen: string | null) =>
  listen === null
    ? { kind: "relay", action, instance: { name } }
    : { kind: "relay", action, instance: { name }, listen };

const refused = (args: string[], reason: string, env = {}) =>
  assert.deepEqual(parseArguments(args, env), { kind: "invalid", reason });

test("relay init and relay serve parse, with an instance from the flag", () => {
  assert.deepEqual(parseArguments(["relay", "init"]), relay("init", null, null));
  assert.deepEqual(
    parseArguments(["relay", "init", "--instance", "mini"]),
    relay("init", "mini", null),
  );
  assert.deepEqual(
    parseArguments(["relay", "serve", "--listen", "0.0.0.0:7443"]),
    relay("serve", null, "0.0.0.0:7443"),
  );
  assert.deepEqual(
    parseArguments(["relay", "serve", "--instance", "mini", "--listen", "[::1]:7443"]),
    relay("serve", "mini", "[::1]:7443"),
  );
});

test("PARDNER_INSTANCE does not apply to a relay, whatever it holds", () => {
  assert.deepEqual(
    parseArguments(["relay", "init"], { PARDNER_INSTANCE: "dev" }),
    relay("init", null, null),
  );
  assert.deepEqual(
    parseArguments(["relay", "init"], { PARDNER_INSTANCE: "Bad Name" }),
    relay("init", null, null),
  );
});

test("relay refuses what it does not know", () => {
  refused(["relay"], "relay needs init or serve");
  refused(["relay", "service", "install"], "relay needs init or serve");
  refused(["relay", "init", "now"], 'unknown argument "now"');
  refused(["relay", "init", "--listen", "h:1"], "relay init takes no --listen");
  refused(["relay", "serve"], "relay serve needs --listen <host>:<port>");
  refused(["relay", "serve", "--listen", "host"], "relay serve needs --listen <host>:<port>");
  refused(["relay", "serve", "--listen", "h:70000"], "relay serve needs --listen <host>:<port>");
  refused(["relay", "serve", "--listen"], "--listen needs a value");
  refused(["relay", "serve", "--listen", "a:1", "--listen", "a:2"], "--listen is given twice");
  refused(
    ["relay", "init", "--instance", "default"],
    '--instance: the instance name "default" would read as the default instance, which has no name: leave the instance out to use it',
  );
  assert.equal(parseArguments(["relay", "init", "--instance", "Bad"]).kind, "invalid");
});

test("the relay's folder is per instance", () => {
  assert.equal(relayDirOf(null, "/h"), "/h/.local/share/pardner-relay");
  assert.equal(relayDirOf("mini", "/h"), "/h/.local/share/pardner-relay-mini");
});

function setup(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "pardner-cli-relay-"));
  const entry = join(home, "main.mjs");
  writeFileSync(
    entry,
    'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.STUB_OUT, JSON.stringify(process.argv.slice(2)));\nprocess.exit(5);\n',
  );
  process.env.STUB_OUT = join(home, "args.json");
  t.after(() => {
    delete process.env.STUB_OUT;
    rmSync(home, { recursive: true, force: true });
  });
  const host: RelayHost = {
    home,
    relayProgram: () => ({ node: process.execPath, entry }),
  };
  const err: string[] = [];
  const output: Output = { out: () => {}, err: (text) => err.push(text) };
  return { home, host, output, err };
}

test("init makes the parent folder with mode 0700 and runs the entry with the instance's directory", async (t) => {
  const { home, host, output } = setup(t);
  const code = await answerRelay(relay("init", "mini", null) as never, output, host);
  assert.equal(code, 5, "the child's exit code");
  const dir = relayDirOf("mini", home);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "args.json"), "utf8")), [
    "init",
    "--dir",
    dir,
  ]);
  assert.equal(statSync(join(home, ".local", "share")).mode & 0o777, 0o700);
  // `~/.local` takes the default mode, as a folder made here with none: never 0700 because of
  // the share folder's.
  mkdirSync(join(home, "default-mode"));
  assert.equal(
    statSync(join(home, ".local")).mode & 0o777,
    statSync(join(home, "default-mode")).mode & 0o777,
  );
  assert.equal(existsSync(dir), false, "the relay's own init makes the directory, not the CLI");
});

test("init leaves a ~/.local/share that exists as it is", async (t) => {
  const { home, host, output } = setup(t);
  const share = join(home, ".local", "share");
  mkdirSync(share, { recursive: true, mode: 0o755 });
  chmodSync(share, 0o755);
  await answerRelay(relay("init", null, null) as never, output, host);
  assert.equal(statSync(share).mode & 0o777, 0o755);
});

test("serve passes the directory and the address", async (t) => {
  const { home, host, output } = setup(t);
  await answerRelay(relay("serve", null, "127.0.0.1:0") as never, output, host);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "args.json"), "utf8")), [
    "serve",
    "--dir",
    relayDirOf(null, home),
    "--listen",
    "127.0.0.1:0",
  ]);
});

test("an entry that is missing is told on stderr and gives 1", async (t) => {
  const { host, output, err } = setup(t);
  host.relayProgram = () => {
    throw new Error("ENOENT: no such file, realpath '/x/relay/main.ts'");
  };
  assert.equal(await answerRelay(relay("serve", null, "h:1") as never, output, host), 1);
  assert.match(err.join(""), /^pardner relay: ENOENT/);
});

test("the relay runs on this command's Node, from the entry beside this command", () => {
  const { node, entry } = machineRelayHost.relayProgram();
  assert.equal(node, process.execPath, "the Node that passed main.ts's version check");
  assert.ok(entry.endsWith(join("src", "relay", "main.ts")), entry);
  assert.ok(existsSync(entry), entry);
});
