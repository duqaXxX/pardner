/**
 * The app's connection against a real relay (step 6.3 design, 7.3): the Swift `RelayConnectionTests`
 * dial a relay this file starts, with the keys of a device this file enrols. The two sides keep step
 * by files: Swift creates `<dir>/<name>.step` and waits for `<dir>/<name>.done`, and Node, which
 * watches the folder (`spawnSync` would block this process), acts in between:
 * a second device submits, the relay stops and serves again on its port, a device is removed.
 * Only a Mac with Xcode can run it.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, type FSWatcher, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { RelayProcess } from "../support/scripted-device/relay-process.ts";
import {
  parse,
  run,
  type Step,
  type Target,
  type World,
} from "../support/scripted-device/script.ts";
import { tempDirSync } from "../support/temp.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const APP = join(ROOT, "app");

function skipReason(): string | false {
  if (process.platform !== "darwin")
    return "Network.framework and JavaScriptCore run on macOS only";
  // The Command Line Tools alone have `swiftc` and not what `swift test` needs.
  const developer = spawnSync("xcode-select", ["-p"], { encoding: "utf8" });
  return /\.app\/Contents\/Developer/.test(developer.stdout) ? false : "no Xcode is selected";
}

/**
 * The steps of the Swift side, each a file `<dir>/<name>.step` it creates whole (renamed in): `swift
 * test` holds a test's standard error until the run ends, so lines would arrive too late (measured
 * 2026-11-19, swift 6.4.2). `fs.watch` can miss an event, so a poll every 200 ms backs it.
 */
class Steps {
  #dir: string;
  #ended: Error | undefined;
  #watcher: FSWatcher;

  constructor(dir: string) {
    this.#dir = dir;
    this.#watcher = watch(dir, () => {});
  }

  /** The Swift side ended: nothing more will come. */
  end(error: Error) {
    this.#ended = error;
  }

  close() {
    this.#watcher.close();
  }

  async wait(name: string, ms: number): Promise<void> {
    const file = join(this.#dir, `${name}.step`);
    for (const deadline = Date.now() + ms; !existsSync(file); await delay(200)) {
      if (this.#ended) throw this.#ended;
      if (Date.now() > deadline) throw new Error(`no step ${name} within ${ms} ms`);
    }
  }
}

test("the app connects to a real relay, follows it, submits, survives a restart and a removal", {
  skip: skipReason(),
  timeout: 900_000, // the build of the package from nothing, and the steps below
}, async () => {
  const folder = tempDirSync("pardner-app-relay-");
  const relay = new RelayProcess();
  const steps = new Steps(folder);
  const tail: string[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<number | null> | undefined;
  try {
    const script = join(folder, "protocol.js");
    execFileSync(process.execPath, [join(ROOT, ".github/scripts/join-protocol.mjs"), script], {
      cwd: ROOT,
      timeout: 120_000,
    });
    // The device's keys are made here, in a file the Swift side reads: per run, in this folder, gone with it.
    const keyFile = join(folder, "keys.json");
    const platform = createNodePlatform(undefined, { keyFile });
    const named = (name: string) =>
      Buffer.from(platform.sha256(new TextEncoder().encode(name)).slice(0, 16)).toString("hex");
    const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

    let target: Target = await relay.open();
    let person: Bytes = new Uint8Array();
    const ids = new Map<string, string>();
    const item: { kind?: number; signed?: string; sig?: string } = {};

    const spawnSwift = () => {
      const env = {
        ...process.env,
        PARDNER_JOINED_SCRIPT: script,
        PARDNER_RELAY_PORT: String(target.port),
        PARDNER_RELAY_PIN: hex(target.relay),
        PARDNER_PERSON: hex(person),
        PARDNER_KEY_FILE: keyFile,
        PARDNER_SYNC_DIR: folder,
        PARDNER_APP1_ID: ids.get("app1") ?? "",
        PARDNER_APP2_ID: ids.get("app2") ?? "",
        PARDNER_NAME_FOLLOW: named("follow"),
        PARDNER_NAME_OWN: named("own"),
        PARDNER_ITEM_KIND: String(item.kind),
        PARDNER_ITEM_SIGNED: item.signed ?? "",
        PARDNER_ITEM_SIG: item.sig ?? "",
      };
      child = spawn(
        "swift",
        ["test", "--filter", "RelayConnectionTests", "--scratch-path", join(folder, "build")],
        { cwd: APP, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      exited = new Promise((resolve) => child?.on("close", resolve));
      for (const stream of [child.stdout, child.stderr]) {
        createInterface({ input: stream as NodeJS.ReadableStream }).on("line", (line) => {
          tail.push(line);
          if (tail.length > 400) tail.shift();
        });
      }
      void exited.then((code) =>
        steps.end(new Error(`swift test ended with ${code} before a step`)),
      );
    };

    // Each act of the script that is the Swift side's, and the relay's own for the others.
    const world: World = {
      async act(name: string, step: Step) {
        const kept = { target, ended: false };
        if (name === "swift-begin") spawnSwift();
        else if (name === "swift-wait") await steps.wait(String(step.name), 600_000);
        else if (name === "swift-done")
          writeFileSync(join(folder, `${String(step.name)}.done`), "");
        else {
          const done = await relay.act(name, step);
          target = done.target;
          return done;
        }
        return kept;
      },
    };
    const lines: Record<string, unknown>[] = [
      { op: "prove", device: "app1", enrol: "sheet1", as: "g", expect: "served" },
      { op: "submit", entry: "create", as: "ch", expect: "result 0" },
      { op: "submit", entry: "add", device: "app2", as: "a2", expect: "result 0" },
      { op: "submit", entry: "epoch", as: "e1", expect: "result 0" },
      // The item the app submits, built here as the first device and sent by the app.
      { op: "export", entry: "message", epoch: "e1", as: "own", name: "own" },
      { op: "close" },
      { op: "prove", conn: "c2", device: "app2", expect: "served" },
      { op: "read", conn: "c2", from: 0, expect: { items: ["g", "ch", "a2", "e1"], n: 4 } },
      { op: "relay", act: "swift-begin" },
      { op: "relay", act: "swift-wait", name: "rest" },
      {
        op: "submit",
        conn: "c2",
        entry: "message",
        epoch: "e1",
        name: "follow",
        as: "follow",
        expect: "result 0",
      },
      // A channel's name: the link tells it as a `names` effect, which the driver ignores until the app shows names (names design 9, N2).
      {
        op: "submit",
        conn: "c2",
        entry: "message",
        epoch: "e1",
        name: "chan-name",
        kind: 14,
        content: '{"name":"general"}',
        counter: 2,
        as: "chan-name",
        expect: "result 0",
      },
      { op: "relay", act: "swift-done", name: "rest" },
      { op: "relay", act: "swift-wait", name: "exchanged" },
      { op: "read", conn: "c2", from: 4, expect: { items: ["follow", "chan-name", "own"], n: 7 } },
      { op: "relay", act: "restart-same-port" },
      { op: "relay", act: "swift-done", name: "exchanged" },
      { op: "relay", act: "swift-wait", name: "restarted" },
      { op: "prove", conn: "c2", device: "app2", expect: "served" },
      { op: "submit", conn: "c2", entry: "remove", device: "app1", as: "r1", expect: "result 0" },
      { op: "relay", act: "swift-done", name: "restarted" },
      { op: "relay", act: "swift-wait", name: "finished" },
      { op: "relay", act: "swift-done", name: "finished" },
    ];
    await run(
      parse(lines.map((l) => JSON.stringify(l)).join("\n")),
      target,
      platform,
      world,
      (seen) => {
        person = seen.person;
        if (seen.step.op === "prove" && seen.me) ids.set(String(seen.step.device), hex(seen.me.id));
      },
      (kind, built) => {
        Object.assign(item, { kind, signed: hex(built.signed), sig: hex(built.sig) });
      },
    );
    const code = await exited;
    if (code !== 0) throw new Error(`swift test ended with ${code}:\n${tail.join("\n")}`);
  } catch (error) {
    // Let the Swift side run out (every step is released) so that its report, which `swift test` prints at the end, shows what it saw.
    for (const name of ["rest", "exchanged", "restarted", "finished"])
      writeFileSync(join(folder, `${name}.done`), "");
    await Promise.race([exited, delay(300_000)]);
    if (tail.length) console.error(tail.join("\n"));
    throw error;
  } finally {
    steps.close();
    child?.kill("SIGTERM");
    await Promise.race([exited, delay(30_000)]);
    await relay.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
  }
});
