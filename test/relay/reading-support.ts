/**
 * What the tests that drive a device's reading against the relay's process share: the relay as a
 * child, a served connection of alice's or the bot, and the frames of a read or a push handed to
 * `Reading`. The scripted device's link is only the transport; the reading is what is under test.
 */
import assert from "node:assert/strict";
import type { Frame } from "../../src/protocol/frames.ts";
import type { Out, Reading } from "../../src/protocol/reading.ts";
import type { Scene } from "../protocol/reading-world.ts";
import { dial, type Link, type Outcome } from "../support/scripted-device/link.ts";
import { run, watch } from "./process-support.ts";
import { platform } from "./support.ts";

export const serve = (dir: string) =>
  watch(run(["serve", "--dir", dir, "--listen", "127.0.0.1:0"]));
export const stop = async (c: ReturnType<typeof serve>) => {
  c.child.kill("SIGTERM");
  assert.equal(await c.exit, 0, c.err());
};

export type Pass = Extract<Outcome, { type: "pass" }>;

/** The frames of a pass the link gathered: a read's answer starts with its position. */
export function frames(p: Pass, from = 0): Frame[] {
  return [
    ...(p.read
      ? [{ type: "position" as const, from, incarnation: p.incarnation as Uint8Array }]
      : []),
    ...(p.read ? [{ type: "seals" as const, items: p.seals }] : []),
    ...p.items.map((i) => ({
      type: "item" as const,
      position: i.position,
      kind: i.kind,
      signed: i.signed,
      sig: i.sig,
    })),
    p.head,
  ];
}

/** A device's served connection to the relay: alice's first device, or the bot. */
export async function connect(port: number, key: Uint8Array, s: Scene, as: "alice" | "bot") {
  const link = await dial(platform, port, key);
  const by = as === "alice" ? s.alice.first : s.bot;
  const served = await link.proveActive(s.alice.id, by.id, by.sign);
  assert.equal(served.type, "served");
  return { link, served: served as Frame };
}

export const sent = async (link: Link, items: Scene["wire"]["items"]) => {
  for (const i of items) {
    const answer = await link.submit(i.kind, i);
    assert.deepEqual(answer, {
      type: "result",
      request: answer.type === "result" ? answer.request : 0,
      code: 0,
    });
  }
};
export const code = async (link: Link, i: Scene["wire"]["items"][number]) => {
  const answer = await link.submit(i.kind, i);
  assert.equal(answer.type, "result");
  return answer.type === "result" ? answer.code : -1;
};

/** Serves `r` the way a bot's connection does: the `served` frame, the read it asks for, and the frames of the answer. */
export async function readAll(r: Reading, link: Link, served: Frame): Promise<Out[]> {
  const outs = r.take(served);
  const ask = outs.find((o) => o.do === "read");
  assert.ok(ask?.do === "read");
  const pass = await link.read(ask.from);
  assert.equal(pass.type, "pass");
  assert.deepEqual((pass as Pass).problems, []);
  return [...outs, ...frames(pass as Pass, ask.from).flatMap((f) => r.take(f))];
}

/** What the relay pushes to a read left open, taken by `r`. */
export async function pushed(r: Reading, link: Link): Promise<Out[]> {
  const pass = await link.follow();
  assert.equal(pass.type, "pass");
  return frames(pass as Pass).flatMap((f) => r.take(f));
}

export const incarnationOf = (served: Frame) => {
  assert.equal(served.type, "served");
  return (served as Extract<Frame, { type: "served" }>).incarnation;
};
