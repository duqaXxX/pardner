/**
 * The relay chat as a whole (design 1): a real relay, the daemon in a child process (`daemon-child.ts`)
 * and alice's scripted device as the owner. The device reads what the bot wrote the way the app would:
 * each message opened in the epoch's key.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toHex } from "../../src/chat/relay/hex.ts";
import { loadPairing } from "../../src/chat/relay/pairing.ts";
import type { MessageHeader } from "../../src/protocol/messages.ts";
import { hex, type rig } from "../chat/relay/relay-rig.ts";
import { tempDirSync } from "../support/temp.ts";

export type Rig = Awaited<ReturnType<typeof rig>>;
export type Held = MessageHeader & { signed: Uint8Array };

const CHILD = new URL("./bot-child.ts", import.meta.url).pathname;

/** What a test waits for: `done` holds within `ms`, polled. */
export async function until(done: () => boolean | Promise<boolean>, what: string, ms = 30_000) {
  for (const end = Date.now() + ms; !(await done()); await new Promise((s) => setTimeout(s, 40)))
    assert.ok(Date.now() < end, `waited for ${what}`);
}

export const pause = (ms: number) => new Promise((s) => setTimeout(s, ms));

/** The folders of one world: the config the bot was paired in, a home, a root of folders sessions may use. */
export function world(r: Rig) {
  const base = realpathSync(tempDirSync("pardner-daemon-"));
  const root = join(base, "root");
  const home = join(base, "home");
  mkdirSync(root);
  mkdirSync(home);
  const folder = (name: string) => {
    mkdirSync(join(root, name));
    return join(root, name);
  };
  const pairing = loadPairing(r.dir);
  writeFileSync(
    join(r.dir, ".env"),
    [
      "PARDNER_AGENT=plain",
      `ALLOWED_ROOT=${root}`,
      `RELAY_ADDRESS=127.0.0.1:${r.port}`,
      `RELAY_KEY=${toHex(pairing.relay)}`,
      `RELAY_OWNER=${toHex(pairing.person)}`,
    ].join("\n"),
  );
  chmodSync(join(r.dir, ".env"), 0o600);
  return { base, home, folder };
}

/** The daemon in a child: what it printed, and how to end it. */
export function daemon(r: Rig, w: ReturnType<typeof world>, script: string[]) {
  const child: ChildProcess = spawn(
    process.execPath,
    [CHILD, r.dir, w.home, w.base, JSON.stringify(script)],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => {
    out += d;
  });
  child.stderr?.on("data", (d) => {
    err += d;
  });
  const exit = new Promise<number | null>((resolve) => child.once("close", resolve));
  return {
    out: () => out,
    err: () => err,
    exit,
    /** The last number printed after `word`. */
    count: (word: string) =>
      Number([...out.matchAll(new RegExp(`${word} (\\d+)`, "g"))].at(-1)?.[1] ?? 0),
    /** Ends the child with `signal`; a stop that a held turn keeps waiting is ended with SIGKILL after 8 s. */
    async kill(signal: NodeJS.Signals) {
      child.kill(signal);
      const guard = setTimeout(() => child.kill("SIGKILL"), 8_000);
      await exit;
      clearTimeout(guard);
    },
  };
}
export type Daemon = ReturnType<typeof daemon>;

/** The owner's device: sends prompts and reads what the bot wrote. */
export function owner(r: Rig, send: Rig["send"] = r.send) {
  const bodies = async (kind: number) =>
    (await r.held()).messages.filter((m) => m.kind === kind) as Held[];
  const self = {
    /** Sends `text`, in `thread` when given; the prompt's name in hex. */
    async says(text: string, thread?: string) {
      const { name } = await send(
        { to: r.botId, incarnation: await r.incarnation() },
        thread ? { text, thread } : { text },
      );
      return { name, thread: thread ?? hex(r.alice.first.id) + name };
    },
    bodies,
    /** Every body of `kind`, opened. */
    async opened(kind: number) {
      return (await bodies(kind)).map((m) => ({ header: m, body: r.body(m) }));
    },
    /** Answers the setup request the bot made in `thread`, with the plain agent's effort. */
    async answersSetup(thread: string) {
      let request: Held | undefined;
      await until(async () => {
        request = (await bodies(9)).find((m) => r.body(m).thread === thread);
        return request !== undefined;
      }, "a setup request");
      const found = request as Held;
      await send(
        {
          kind: 10,
          to: r.botId,
          re: { device: r.botId, name: found.name },
          incarnation: await r.incarnation(),
        },
        {
          answer: { type: "setup", selection: { model: "default", effort: "full", bypass: false } },
        },
      );
    },
  };
  return self;
}
