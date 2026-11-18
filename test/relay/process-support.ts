/**
 * What the process-level tests share (design 9.2): `node src/relay/main.ts` in child processes,
 * spoken to over real TLS on 127.0.0.1 through the scripted device's link.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import type { Frame } from "../../src/protocol/frames.ts";
import { dial, type Outcome } from "../support/scripted-device/link.ts";
import { MAIN, relayChild as run } from "./child.ts";
import { platform } from "./support.ts";
import type { person } from "./world.ts";

export const DARWIN = {
  skip: process.platform === "darwin" ? false : "the directory lock is the macOS mechanism",
};
export { MAIN, run };
export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A started command: what it printed, and the code it exited with. It is killed after `limit` ms (none when 0). */
export function watch(child: ChildProcess, limit = 60_000) {
  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => {
    out += d;
  });
  child.stderr?.on("data", (d) => {
    err += d;
  });
  const exit = new Promise<number | null>((resolve) => child.on("close", resolve));
  const guard = limit > 0 ? setTimeout(() => child.kill("SIGKILL"), limit) : undefined;
  void exit.then(() => clearTimeout(guard));
  return { out: () => out, err: () => err, exit, child };
}

/** `init` in a child of its own; `spawn` says how the child starts (the recorded one, for the crash images). */
export async function init(dir: string, spawn: typeof run = run) {
  const c = watch(spawn(["init", "--dir", dir]));
  assert.equal(await c.exit, 0, c.err());
  const key = /relay public key: ([0-9a-f]+)/.exec(c.out())?.[1] ?? "";
  const secret = /enrolment secret: ([0-9a-f]+)/.exec(c.out())?.[1] ?? "";
  return { key: Buffer.from(key, "hex"), secret: Buffer.from(secret, "hex") };
}

export async function portOf(c: ReturnType<typeof watch>) {
  for (let i = 0; i < 400; i++) {
    const port = Number(/listening on port (\d+)/.exec(c.err())?.[1] ?? 0);
    if (port !== 0) return port;
    await wait(50);
  }
  throw new Error(c.err());
}

export type Alice = ReturnType<typeof person>;

/** Enrols `alice` (when `secret` is given) and proves her first device on one connection. */
export async function enrolAndProve(
  port: number,
  relay: Uint8Array,
  alice: Alice,
  secret?: Uint8Array,
) {
  const link = await dial(platform, port, relay);
  if (secret) link.enrol(secret, alice.genesis);
  const answer = await link.proveActive(alice.id, alice.first.id, alice.first.sign);
  link.close();
  return answer;
}

export const incarnationOf = (frame: Outcome) => {
  assert.equal(frame.type, "served");
  return Buffer.from((frame as Extract<Frame, { type: "served" }>).incarnation).toString("hex");
};
