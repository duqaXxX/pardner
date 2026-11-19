/**
 * What the bot sends (design 3.6): the stored outbox of each channel, built once in an open epoch
 * whose key the bot holds and sent again as the same bytes until the bot reads the message back
 * (SD 5.6, 5.9), the relay's results, and the epochs the bot starts when a channel is closed, aged or
 * out of counters (SD 5.4, 5.7). The run and its counters live in memory alone: a new start is a new
 * run, so no sender key and counter is used twice (crypto.md 1). A reply's parts are split at 64 KiB by the provider (3.8).
 */
import { bytesEqual } from "../../protocol/bytes.ts";
import { buildEpoch, tickEpoch, whyStart } from "../../protocol/epochs.ts";
import { deviceId, signedId } from "../../protocol/ids.ts";
import { KIND_PROFILE, messageChecker } from "../../protocol/messages.ts";
import {
  build,
  type Draft,
  dropStarts,
  type OutboxItem,
  queue,
  type Run,
  readBack,
  rebuild,
} from "../../protocol/outbox.ts";
import type { Bytes, Platform } from "../../protocol/platform.ts";
import type { Out, Reading } from "../../protocol/reading.ts";
import { toHex } from "./hex.ts";
import { type Pairing, SIGN } from "./pairing.ts";
import type { Store } from "./store.ts";

const MESSAGE = 4; // the item kinds of a `submit` frame
const EPOCH = 3;
const BUILT = "relay: a message could not be built, nothing is sent until the next read";

export interface OutboxOptions {
  platform: Platform;
  pairing: Pairing;
  store: Store;
  reading: Reading;
  /** `Connection.submit`: the relay's result code, or `undefined` when none came. */
  submit: (kind: 3 | 4, signed: Bytes, sig: Bytes) => Promise<number | undefined>;
  log: (line: string) => void;
  /** The run of the bot, shared with its `BotReader`: a start read back is of this run (SD 5.8). */
  run: Run;
}

export class Outbox {
  /**
   * A profile of the bot's left the outbox in this run without landing (refused, too large or
   * unwanted): no other is written before the next start (bot-profile design 3.2, condition 5).
   */
  profileDropped = false;
  #o: OutboxOptions;
  #self: Bytes;
  #sent = new Map<string, Set<string>>(); // names given result 0 since the last rest, by channel
  #waiting = new Map<string, number>(); // channel -> its epochs when a start was accepted, until read
  #busy = new Set<string>();
  #dirty = new Set<string>();
  #durable = new Set<string>(); // the ids of built bytes a write of the store is known to hold (crypto.md 4: ids, never signatures)
  #unbuildable = new Set<string>(); // channels whose epoch build failed, logged once
  #released = false;
  #dropped = new Set<string>(); // names that left the outbox without being read back: refused, too large or unwanted
  #landing = new Set<{ names: Bytes[]; done: (landed: boolean) => void }>();

  constructor(options: OutboxOptions) {
    this.#o = options;
    const { platform, pairing, store } = options;
    this.#self = deviceId(platform, pairing.device.signing, pairing.device.receiving);
    this.#dropStarts(); // a start belongs to the run that wrote it (SD 5.8)
    this.#dropProfiles();
  }

  /** Puts a message in the outbox of `channel`, stored before it is built; false for a draft the package refuses. */
  async queue(
    channel: Bytes,
    draft: Draft,
    also?: (saved: Store["saved"]) => void,
  ): Promise<boolean> {
    const key = toHex(channel);
    if (draft.files?.length) return false; // files come with step 6 (SD 5.12)
    const next = queue(this.#o.platform, this.#o.store.saved.outboxes.get(key) ?? [], draft);
    if (!next.ok) return false;
    await this.#o.store.change((s) => {
      s.outboxes.set(key, next.value);
      also?.(s); // in the same write as the message
    });
    this.pump();
    return true;
  }

  /** Told of each `Out` of the connection: a message of the bot's own read back, a new incarnation, a rest. */
  take(out: Out): void {
    if (out.do === "incarnation") {
      if (out.changed) this.#dropStarts();
    } else if (out.do === "message" && bytesEqual(out.message.header.sender, this.#self)) {
      const key = toHex(out.message.header.channel);
      const held = this.#o.store.saved.outboxes.get(key) ?? [];
      const rest = readBack(held, this.#self, out.message.header);
      if (rest.length !== held.length)
        void this.#save((s) => s.outboxes.set(key, rest)).then(() => this.#land());
    } else if (out.do === "rest") {
      this.#sent.clear(); // what the pass did not read back is sent again, as the same bytes
      this.#waiting.clear();
      this.pump();
    }
  }

  /** Whether every message in `names` was read back: false while one is still held and for one that was dropped. */
  holds(names: Bytes[]): boolean {
    return this.#state(names) === "landed";
  }

  #state(names: Bytes[], held = this.#heldNames()): "landed" | "pending" | "failed" {
    if (names.some((n) => this.#dropped.has(toHex(n)))) return "failed";
    return names.some((n) => held.has(toHex(n))) ? "pending" : "landed";
  }

  /** The names of every message an outbox holds, indexed once for all the waiters of a pass. */
  #heldNames(): Set<string> {
    return new Set([...this.#o.store.saved.outboxes.values()].flat().map((i) => toHex(i.name)));
  }

  /**
   * Resolves true once every message in `names` is read back, false when one was dropped (refused,
   * too large or unwanted: it never landed), when `signal` aborts or after `release`.
   */
  landed(names: Bytes[], signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const abort = () => end(false);
      const waiter = { names, done: (landed: boolean) => end(landed) };
      const end = (landed: boolean) => {
        this.#landing.delete(waiter);
        signal?.removeEventListener("abort", abort);
        resolve(landed);
      };
      if (signal?.aborted || this.#released) return end(false);
      signal?.addEventListener("abort", abort, { once: true });
      this.#landing.add(waiter);
      this.#land();
    });
  }

  /** Resolves the waiters of `landed` whose messages are read back or dropped. */
  #land(): void {
    if (this.#landing.size === 0) return;
    const held = this.#heldNames();
    for (const waiter of this.#landing) {
      const state = this.#state(waiter.names, held);
      if (state !== "pending") waiter.done(state === "landed");
    }
  }

  /** The bot is stopping: nothing more is read back, so every wait on landing, now or later, ends false. */
  release(): void {
    this.#released = true;
    for (const waiter of [...this.#landing]) waiter.done(false);
  }

  /** Sends what each channel's outbox holds, once the reading is at rest. */
  pump(): void {
    if (!this.#o.reading.sendable) return;
    for (const channel of this.#o.reading.channels()) {
      const key = toHex(channel);
      if (this.#busy.has(key)) this.#dirty.add(key);
      else void this.#drain(channel, key);
    }
  }

  /**
   * A profile not built yet holds what an earlier run would have written: built now, it would count
   * as this run's (bot-profile design 3.2, condition 3) and keep a changed name or a newly learned
   * account out of its epoch. Dropped at start, the writer decides again at rest from this run's
   * configuration; a built one carries its own run and stays.
   */
  #dropProfiles(): void {
    const stale = (i: OutboxItem) => i.kind === KIND_PROFILE && !i.built;
    if (![...this.#o.store.saved.outboxes.values()].some((l) => l.some(stale))) return;
    this.#save((s) => {
      for (const [key, list] of s.outboxes)
        s.outboxes.set(
          key,
          list.filter((i) => !stale(i)),
        );
    });
  }

  #dropStarts(): void {
    const { outboxes } = this.#o.store.saved;
    if (![...outboxes.values()].some((l) => dropStarts(l).length !== l.length)) return;
    this.#save((s) => {
      for (const [key, list] of s.outboxes) s.outboxes.set(key, dropStarts(list));
    });
  }

  #save(edit: (s: Store["saved"]) => void): Promise<void> {
    return this.#o.store
      .change(edit)
      .catch((e: Error) => this.#o.log(`relay: the store did not write: ${e.message}`));
  }

  /** `item` replaced by `next` in its channel's outbox, or removed when `next` is `undefined`; rejects when the write fails. */
  #put(key: string, item: OutboxItem, next?: OutboxItem): Promise<void> {
    if (!next) this.#dropped.add(toHex(item.name));
    if (!next && item.kind === KIND_PROFILE) this.profileDropped = true;
    return this.#o.store
      .change((s) =>
        s.outboxes.set(
          key,
          (s.outboxes.get(key) ?? []).flatMap((i) =>
            bytesEqual(i.name, item.name) ? (next ? [next] : []) : [i],
          ),
        ),
      )
      .then(() => this.#land());
  }

  async #drain(channel: Bytes, key: string): Promise<void> {
    this.#busy.add(key);
    try {
      do {
        this.#dirty.delete(key);
        while (await this.#step(channel, key));
      } while (this.#dirty.has(key));
    } catch (error) {
      this.#o.log(`relay: sending stopped: ${(error as Error).message}`);
    } finally {
      this.#busy.delete(key);
    }
  }

  /** One item or one epoch start; true when the next may follow at once. */
  async #step(channel: Bytes, key: string): Promise<boolean> {
    const { platform, store, reading, submit, log } = this.#o;
    const view = reading.channel(channel);
    const incarnation = store.saved.incarnation;
    if (!view || !incarnation || !reading.sendable || store.saved.faults.has(key)) return false;
    const now = platform.now();
    const had = store.saved.clocks.get(key);
    const clock = tickEpoch(had, view.epochs, now, true);
    if (clock && clock !== had) {
      await store.change((s) => s.clocks.set(key, clock));
      return true; // the reading may have moved during the write: start again on a fresh view
    }
    const why = whyStart(view, clock, now, false);
    if (why) return this.#start(channel, key, why);
    const sent = this.#sent.get(key) ?? new Set<string>();
    const item = (store.saved.outboxes.get(key) ?? []).find((i) => !sent.has(toHex(i.name)));
    if (!item) return false;
    const last = view.epochs.at(-1);
    const at = {
      channel,
      epoch: last?.id as Bytes,
      epochKey: view.key as Bytes,
      sender: this.#self,
      incarnation,
    };
    const made = build(platform, this.#o.run, item, at, SIGN);
    if (!made.ok) {
      log(BUILT);
      return false;
    }
    const ready = made.value;
    if (ready === "rollover") return this.#start(channel, key, "rollover");
    const built = ready.built as NonNullable<OutboxItem["built"]>; // `build` always returns an item built
    const name = toHex(item.name);
    const written = toHex(signedId(this.#o.platform, built.signed));
    if (!this.#durable.has(written)) {
      // Stored before it is sent (SD 5.9), and a failed write stops here: a write that failed may
      // have left the bytes in memory, so each build is sent only once a write is known to hold it.
      await store.change((s) => {
        if (!item.built)
          s.outboxes.set(
            key,
            (s.outboxes.get(key) ?? []).map((i) => (bytesEqual(i.name, item.name) ? ready : i)),
          );
      });
      this.#durable.add(written);
    }
    let code: number | undefined;
    try {
      code = await submit(MESSAGE, built.signed, built.signature);
    } catch {
      code = 8; // a frame the protocol cannot encode: it is too large, whatever the relay would say
    }
    switch (code) {
      case undefined:
        return false;
      case 0:
        this.#sent.set(key, (this.#sent.get(key) ?? new Set<string>()).add(name));
        return true;
      case 3: // closed
      case 4: // ended: the same message is built again in the next epoch, with a counter of its own
        await this.#put(key, item, rebuild(ready));
        // A newer epoch already read: build in it at once, not at the next rest.
        return !bytesEqual(reading.channel(channel)?.epochs.at(-1)?.id ?? at.epoch, at.epoch);
      case 1: {
        // A relay of an earlier version does not know the kind: not a fault (design 3.2, S2).
        if (item.kind === KIND_PROFILE) {
          log("relay: the relay refused the bot's profile");
          await this.#put(key, item);
          return true;
        }
        const verdict = messageChecker(platform, view.epochs, [reading.devices])(
          built.signed,
          built.signature,
        );
        // Kind, `to` and `re` depend on the draft alone: a refusal by them is the bot's own, not the relay's.
        if (!verdict.ok && ["kind", "to", "re"].includes(verdict.rule)) {
          log("relay: a message was refused for its kind or its recipient, not delivered");
          await this.#put(key, item);
          return true;
        }
        return this.#fault(key, "a message");
      }
      case 8:
        log("relay: a message was too large, not delivered");
        await this.#put(key, item);
        return true;
      case 9:
        log("relay: a message names a file the relay no longer wants, not delivered");
        await this.#put(key, item);
        return true;
      default:
        log(`relay: a message was answered with ${code}, nothing more is sent until the next read`);
        return false;
    }
  }

  /** The next epoch of a channel, built at the heads the bot read; its result is read back, not acted on. */
  async #start(channel: Bytes, key: string, why: string): Promise<false> {
    const { platform, pairing, reading, submit, log } = this.#o;
    const view = reading.channel(channel);
    if (!view || this.#waiting.get(key) === view.epochs.length) return false;
    const built = buildEpoch(platform, view.members, view.epochs, [reading.devices], {
      person: pairing.person,
      device: this.#self,
      sign: SIGN,
    });
    if (!built.ok) {
      if (!this.#unbuildable.has(key)) log(`relay: an epoch could not be built (${built.error})`);
      this.#unbuildable.add(key);
      return false;
    }
    this.#unbuildable.delete(key);
    const code = await submit(EPOCH, built.value.signed, built.value.sig);
    if (code === 0) {
      this.#waiting.set(key, view.epochs.length);
      log(`relay: an epoch was started (${why})`);
    } else if (code === 1) await this.#fault(key, "an epoch entry");
    else if (code !== undefined && code !== 2)
      log(`relay: an epoch entry was answered with ${code}`); // 2: the heads moved, the push that follows is read
    return false;
  }

  /** The relay refused what the bot built at the heads it read: the channel stops, across restarts (row N2). */
  async #fault(key: string, what: string): Promise<false> {
    await this.#save((s) => s.faults.add(key));
    this.#o.log(`relay: ${what} was refused, the relay is at fault, this channel sends no more`);
    return false;
  }
}
