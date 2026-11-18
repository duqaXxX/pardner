/**
 * Design 1, C4 and C9: the daemon killed with `SIGKILL` while the plain agent holds a turn, then
 * started again. The kill follows the turn, not a delay (row N3): the child prints a line once the
 * agent holds it, and the test kills on that line.
 */
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { hex, rig } from "../chat/relay/relay-rig.ts";
import { daemon, owner, pause, until, world } from "./bot-rig.ts";
import { DARWIN } from "./process-support.ts";

type Rig = Awaited<ReturnType<typeof rig>>;
const named = (h: { re?: { name: Uint8Array } }) => hex(h.re?.name ?? new Uint8Array());

/** A bound channel, a prompt through its setup, and the first child holding its turn; `first` is ended by `stop`. */
async function held(r: Rig, onBound?: () => void) {
  const w = world(r);
  const first = daemon(r, w, ["hold"]);
  const device = owner(r);
  const stop = () => first.kill("SIGINT");
  try {
    await device.says(`/bind ${w.folder("work")}`);
    await until(
      async () => (await device.bodies(1)).length > 0,
      `the bind to be said: ${first.err()}`,
    );
    onBound?.();
    const prompt = await device.says("hello");
    await device.answersSetup(prompt.thread);
    await until(() => first.count("held") === 1, `the agent to hold the turn: ${first.err()}`);
    return { w, first, device, prompt, stop };
  } catch (error) {
    await stop();
    await r.stop();
    throw error;
  }
}

test(
  "C4: killed with SIGKILL while the agent holds the turn, the bot starts again: the prompt does not run twice and the device reads a cut for it",
  DARWIN,
  async () => {
    const r = await rig();
    const run = await held(r);
    let second: ReturnType<typeof daemon> | undefined;
    try {
      const starts = (await run.device.bodies(3)).filter((m) => named(m) === run.prompt.name);
      assert.equal(starts.length, 1, "the start is written and read back before the turn runs");
      await run.first.kill("SIGKILL");
      second = daemon(r, run.w, ["again"]);
      await until(
        async () => (await run.device.bodies(6)).some((m) => named(m) === run.prompt.name),
        `a cut for the prompt: ${second.err()}`,
      );
      await pause(1_500);
      assert.equal(run.first.count("held"), 1, "the first process held the turn");
      assert.equal(
        second.count("prompts") + second.count("held"),
        0,
        "the agent is not given the prompt again",
      );
      assert.equal(
        (await run.device.bodies(5)).filter((m) => named(m) === run.prompt.name).length,
        0,
      );
    } finally {
      await second?.kill("SIGINT");
      await r.stop();
    }
  },
);

test(
  "C9: the store put back from a copy made before the prompt ran, the bot killed and started again: the prompt does not run again",
  DARWIN,
  async () => {
    const r = await rig();
    const copy = join(r.dir, "store-before.json");
    const run = await held(r, () => copyFileSync(join(r.dir, "store.json"), copy));
    let second: ReturnType<typeof daemon> | undefined;
    try {
      await run.first.kill("SIGKILL");
      copyFileSync(copy, join(r.dir, "store.json"));
      second = daemon(r, run.w, ["again"]);
      await until(
        async () => (await run.device.bodies(6)).some((m) => named(m) === run.prompt.name),
        `a cut for the prompt: ${second.err()}`,
      );
      await pause(2_500);
      assert.equal(
        second.count("prompts") + second.count("held"),
        0,
        `the prompt ran again: ${second.err()}`,
      );
      assert.equal(
        (await run.device.bodies(5)).filter((m) => named(m) === run.prompt.name).length,
        0,
      );
    } finally {
      await second?.kill("SIGINT");
      await r.stop();
    }
  },
);
