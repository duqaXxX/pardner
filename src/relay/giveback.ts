/** Design 3.12: a head given back, decided on the head alone, in the order of the model's `Relay.upload`. */
import { bytesEqual } from "../protocol/bytes.ts";
import type { Bytes, Platform } from "../protocol/platform.ts";
import { checkHead, type RelayHead } from "../protocol/proofs.ts";
import type { Placed } from "./journal.ts";

const ZERO = new Uint8Array(32);

/** `refused` stops nothing; `closed` is a head the sequence does not hold, which differs at `first`. */
export type Given = { verdict: "refused" | "accepted" } | { verdict: "closed"; first: number };

/**
 * A head not under this relay's key is refused. One under its key that the sequence does not hold
 * (shorter than `n`, or another running hash at `n`) means the directory was put back by hand. The
 * length is checked before the hash, so that a head longer than the sequence is not compared with
 * the hash at its end.
 */
export function giveBack(
  platform: Platform,
  relayPublic: Bytes,
  placed: readonly Placed[],
  head: RelayHead,
  sig: Bytes,
): Given {
  if (!checkHead(platform, relayPublic, head, sig)) return { verdict: "refused" };
  if (head.n > placed.length) return { verdict: "closed", first: placed.length };
  const chain = head.n === 0 ? ZERO : (placed[head.n - 1] as Placed).chain;
  return bytesEqual(chain, head.chain)
    ? { verdict: "accepted" }
    : { verdict: "closed", first: head.n };
}
