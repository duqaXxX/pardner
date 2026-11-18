/** What the device was told before the cut, held against the sequence a start serves (crash images design 5.2). */
import { relayKeyId } from "../../../src/protocol/ids.ts";
import type { Bytes, Platform } from "../../../src/protocol/platform.ts";
import { dial, type Pass } from "../scripted-device/link.ts";
import type { Answer } from "./segments.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * The items, reads and enrolments answered, and the head of the largest read given back: `by` is the
 * device that proved last, `port` the start's. The first answer the sequence does not bear out is returned.
 */
export async function answered(
  got: Pass,
  told: Answer[],
  by: { relay: Bytes } | undefined,
  platform: Platform,
  port: number,
): Promise<string | undefined> {
  const ids = got.items.map((i) => hex(i.id));
  for (const a of told) {
    if (a.kind === "item" && !ids.includes(hex(a.id)))
      return "an item answered result 0 is not in the sequence";
    if (a.kind === "read")
      for (const i of a.items)
        if (ids[i.position] !== hex(i.id))
          return `position ${i.position} read before the cut differs`;
    if (a.kind === "served" && a.enrol && ids[0] !== hex(a.person))
      return "the genesis is not position 0";
  }
  const head = told.reduce<Answer | undefined>(
    (top, a) => (a.kind === "read" && (top?.kind !== "read" || a.head.n > top.head.n) ? a : top),
    undefined,
  );
  if (head?.kind !== "read" || !head.me || !by) return undefined;
  const link = await dial(platform, port, by.relay);
  const h = { relay: relayKeyId(platform, by.relay), n: head.head.n, chain: head.head.chain };
  await link.proveUpload(head.me, h, head.head.sig, 300);
  const done = await link.uploadDone(h, head.head.sig);
  link.close();
  return done.type === "result" && done.code === 0
    ? undefined
    : `the head ${head.head.n} given back was answered ${JSON.stringify(done)} (RD 3.6)`;
}
