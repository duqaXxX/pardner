/**
 * The outbox of a device (security design 5.6, 5.12). The 30-day age of an epoch (SD 5.7) is the
 * caller's: it measures it from the device's first read of the epoch entry, which carries no time.
 */
import { bytesEqual, isBytes } from "./bytes.ts";
import { idKey } from "./device-log.ts";
import { type SealedBlob, sealBlob } from "./files.ts";
import {
  fits,
  KIND_START,
  MAX_COUNTER,
  type MessageHeader,
  type Reference,
  sealMessage,
} from "./messages.ts";
import type { Bytes, Platform } from "./platform.ts";
import { fail, ok, type Result } from "./result.ts";

/** A file written with a message: its blob and key, kept in the outbox with the message (SD 5.12, point 4). */
export interface OutboxFile extends SealedBlob {
  size: number;
  type: string;
  name: string;
}

/** The signed bytes of a message built once: sent again, they are the same bytes, whatever epoch is open. */
export interface Built {
  signed: Bytes;
  signature: Bytes;
}

/** A message that stays here until its device reads it back in the relay's sequence (SD 5.6). */
export interface OutboxItem {
  /** Made when the owner wrote it, and carried by every copy. */
  name: Bytes;
  kind: number;
  to?: Bytes | undefined;
  re?: Reference | undefined;
  content: string;
  files: OutboxFile[];
  /** The relay's incarnation when it was first built, kept by every copy (SD 5.6). */
  incarnation?: Bytes | undefined;
  built?: Built | undefined;
}

/** What a device writes: a notice of a bot gives its own `name` (SD 5.8), any other has one made. */
export interface Draft {
  kind: number;
  to?: Bytes | undefined;
  re?: Reference | undefined;
  name?: Bytes | undefined;
  content: string;
  files?: { bytes: Bytes; type: string; name: string }[] | undefined;
}

/** Where a message is built: the open epoch with its key, and the incarnation the device reads under. */
export interface Where {
  channel: Bytes;
  epoch: Bytes;
  epochKey: Bytes;
  sender: Bytes;
  incarnation: Bytes;
}

/**
 * A run of a device: its id and the counters of its sender keys, in memory and nowhere else. A run
 * id is never used twice, so a sender key and a counter are never used twice, whatever the store
 * holds (crypto.md 1). The limit of 100,000 is per sender key, which is per run (crypto.md 1: the
 * device stops sending under that key). It has no way out to a store and none to start a counter again.
 */
export class Run {
  readonly id: Bytes;
  #counters = new Map<string, number>();
  constructor(platform: Platform) {
    this.id = platform.random(16);
  }

  /** The next counter in `epoch`, from 1; `undefined` once 100,000 are used, and it never wraps (SD 5.7). */
  next(epoch: Bytes): number | undefined {
    const key = idKey(epoch);
    const n = (this.#counters.get(key) ?? 0) + 1;
    if (n > MAX_COUNTER) return undefined;
    this.#counters.set(key, n);
    return n;
  }
}

/**
 * The outbox with one more message, a name made for it and each file sealed under a key of its own;
 * `bad-input` for a draft 6.4's table refuses, or a `to`, `re` or name of a length the encoder refuses,
 * which would block the outbox and take a counter at every flush.
 */
export function queue(
  platform: Platform,
  outbox: readonly OutboxItem[],
  d: Draft,
): Result<OutboxItem[]> {
  const sized = (b: unknown, n: number) => isBytes(b) && b.length === n;
  const fields =
    (d.to === undefined || sized(d.to, 32)) &&
    (d.re === undefined || (sized(d.re.device, 32) && sized(d.re.name, 16))) &&
    (d.name === undefined || sized(d.name, 16));
  if (!fits(d) || !fields) return fail("bad-input");
  const files = (d.files ?? []).map((f) => ({
    ...sealBlob(platform, f.bytes),
    size: f.bytes.length,
    type: f.type,
    name: f.name,
  }));
  const { kind, to, re, content } = d;
  return ok([...outbox, { name: d.name ?? platform.random(16), kind, to, re, content, files }]);
}

/**
 * The item built under `at` and signed with the key `signer`: its counter is the run's next in the
 * epoch, and its incarnation the one it already has. An item already built is returned as it is, so
 * that what is sent again is the identical bytes; once the relay answers that its epoch ended, the
 * caller `rebuild`s it. `no-such-key` when the key is missing, before a counter is taken. `"rollover"` when the run has used 100,000
 * counters in the epoch: nothing is sent, and the caller starts the next epoch (SD 5.7).
 */
export function build(
  platform: Platform,
  run: Run,
  item: OutboxItem,
  at: Where,
  signer: string,
): Result<OutboxItem | "rollover"> {
  if (item.built) return ok(item);
  if (!platform.publicKey(signer).ok) return fail("no-such-key");
  const counter = run.next(at.epoch);
  if (counter === undefined) return ok("rollover");
  const incarnation = item.incarnation ?? at.incarnation;
  const files = item.files.map((f) => ({
    blob: f.id,
    fileKey: f.key,
    size: f.size,
    type: f.type,
    name: f.name,
  }));
  const header = {
    channel: at.channel,
    counter,
    epoch: at.epoch,
    sender: at.sender,
    run: run.id,
    incarnation,
    time: platform.now(),
    kind: item.kind,
    to: item.to,
    re: item.re,
    name: item.name,
  };
  const signed = sealMessage(platform, at.epochKey, header, { files, content: item.content });
  const signature = platform.sign(signer, signed);
  if (!signature.ok) return signature;
  return ok({ ...item, incarnation, built: { signed, signature: signature.value } });
}

/** The same message for the next epoch, after the relay answered that its epoch is closed or ended: same name, files and incarnation, to be built again. */
export const rebuild = (item: OutboxItem): OutboxItem => ({ ...item, built: undefined });

/**
 * The outbox without the message `h` is a copy of, by name, when `h` is of `sender`'s own device;
 * the same array otherwise. `h` is of a message accepted under 5.6, and an outbox holds one channel's.
 */
export const readBack = (outbox: OutboxItem[], sender: Bytes, h: MessageHeader): OutboxItem[] =>
  bytesEqual(h.sender, sender) ? outbox.filter((i) => !bytesEqual(i.name, h.name)) : outbox;

/** The outbox without its starts, for a restart: a start belongs to the run that wrote it (SD 5.8). */
export const dropStarts = (outbox: readonly OutboxItem[]): OutboxItem[] =>
  outbox.filter((i) => i.kind !== KIND_START);
