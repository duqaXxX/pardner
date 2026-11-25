/**
 * The bot's store (design 3.3): the minimum the bot keeps between runs, in one JSON file beside the
 * pairing file. Safety never rests on it (security design 3): what the bot acted on is read from the
 * relay's sequence, so an older copy put back costs a re-read and no more. No key is stored: epoch
 * keys are read again from the sequence at every start.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigError } from "../../core/port.ts";
import { RenamedOnly, writeFileAtomic } from "../../platform-node/key-file.ts";
import type { Decision } from "../../protocol/bot-reader.ts";
import { bytesEqual, isBytes } from "../../protocol/bytes.ts";
import type { DeviceKeys } from "../../protocol/device-log.ts";
import type { EpochClock } from "../../protocol/epochs.ts";
import { deviceId } from "../../protocol/ids.ts";
import type { OutboxItem } from "../../protocol/outbox.ts";
import type { Bytes, Platform } from "../../protocol/platform.ts";
import type { Kept } from "../../protocol/reading.ts";
import { AGAIN, toHex } from "./hex.ts";

const STORE = "store.json";

/** The store's file in `directory`. */
export const storePath = (directory: string) => join(directory, STORE);
const VERSION = 1;
const DECISIONS = new Set<unknown>(["started", "done", "cut", "unread"]);

/** What the store belongs to: the bot's device id and the relay's key (row N1). */
export interface Identity {
  readonly device: Bytes;
  readonly relay: Bytes;
}

/** The identity of a pairing's keys, hashed by `platform`. */
export const identityOf = (platform: Platform, device: DeviceKeys, relay: Bytes): Identity => ({
  device: deviceId(platform, device.signing, device.receiving),
  relay,
});

/** What is kept. Channels are named by their id in hex. */
export interface Saved extends Identity {
  /** `BotReader`'s map: a run cut by a restart is said cut and never run again. */
  decided: Map<string, Decision>;
  kept: Kept;
  /** The incarnation the bot last read under. */
  incarnation: Bytes | undefined;
  /** Whether the reading met a fault of the relay's sequence: stored until a new pairing (the model's `d.fault`). */
  fault: boolean;
  /**
   * Built messages by channel. A file of an item keeps `{key, id, size, type, name}` here and in
   * the file; its bytes are the blob file `blobs/<id hex>` (design G 3.5), and `blob` is empty.
   */
  outboxes: Map<string, OutboxItem[]>;
  /** The channels where the bot met a relay fault: stored until a new pairing (row N2). */
  faults: Set<string>;
  clocks: Map<string, EpochClock>;
}

const fresh = (who: Identity, decided: Map<string, Decision> = new Map()): Saved => ({
  ...who,
  decided,
  kept: { ids: [], head: undefined, putBack: false },
  incarnation: undefined,
  fault: false,
  outboxes: new Map(),
  faults: new Set(),
  clocks: new Map(),
});

const HEX = /^(?:[0-9a-f]{2})*$/;

// Bytes, maps and sets are tagged so that the file holds what the protocol's own types hold. The
// replacer reads the holder's raw value: a Node Buffer would otherwise reach it through `toJSON`.
function encode(saved: Saved): string {
  check(saved);
  // The sealed bytes are a blob file, and `put` is memory alone: a store that came back says every blob again.
  const onDisk = (item: OutboxItem) => ({
    ...item,
    files: item.files.map(({ blob: _blob, put: _put, ...file }) => file),
  });
  const outboxes = new Map([...saved.outboxes].map(([key, list]) => [key, list.map(onDisk)]));
  return JSON.stringify(
    { ...saved, outboxes, version: VERSION },
    function (this: Record<string, unknown>, key, value: unknown) {
      const raw = this[key];
      if (isBytes(raw)) return { $hex: toHex(raw) };
      if (raw instanceof Map) return { $map: [...raw] };
      if (raw instanceof Set) return { $set: [...raw] };
      return value;
    },
  );
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const text = (v: unknown): v is string => typeof v === "string";

/** Throws unless every element of `saved` has the shape the store writes. */
function check(saved: Saved): void {
  const bad = (what: string) => {
    throw new Unparsable(`the store has a wrong ${what}`);
  };
  if (!isBytes(saved.device) || !isBytes(saved.relay)) bad("identity");
  for (const [key, state] of saved.decided)
    if (!text(key) || !DECISIONS.has(state)) bad("decision");
  const { ids, head, putBack } = saved.kept ?? {};
  if (!Array.isArray(ids) || !ids.every(isBytes) || typeof putBack !== "boolean") bad("reading");
  if (head !== undefined) {
    const h = head as { head?: Record<string, unknown>; sig?: unknown };
    const inner = h.head;
    if (
      !record(inner) ||
      !isBytes(inner.relay) ||
      !isBytes(inner.chain) ||
      !Number.isInteger(inner.n) ||
      !isBytes(h.sig)
    )
      bad("head");
  }
  if (saved.incarnation !== undefined && !isBytes(saved.incarnation)) bad("incarnation");
  if (typeof saved.fault !== "boolean") bad("flag");
  for (const [channel, items] of saved.outboxes) {
    if (!text(channel) || !Array.isArray(items)) bad("outbox");
    for (const item of items) {
      const built = item.built as Record<string, unknown> | undefined;
      const optionalBytes = (v: unknown) => v === undefined || isBytes(v);
      const re = item.re as Record<string, unknown> | undefined;
      if (
        !record(item) ||
        !isBytes(item.name) ||
        !Number.isInteger(item.kind) ||
        !text(item.content) ||
        !Array.isArray(item.files) ||
        !item.files.every(
          (f) =>
            record(f) &&
            isBytes(f.key) &&
            f.key.length === 32 &&
            isBytes(f.id) &&
            f.id.length === 32 &&
            isBytes(f.blob) &&
            Number.isInteger(f.size) &&
            f.size >= 0 &&
            text(f.type) &&
            text(f.name),
        ) ||
        !optionalBytes(item.to) ||
        !optionalBytes(item.incarnation) ||
        (re !== undefined && !(record(re) && isBytes(re.device) && isBytes(re.name))) ||
        (built !== undefined &&
          !(record(built) && isBytes(built.signed) && isBytes(built.signature)))
      )
        bad("outbox item");
    }
  }
  for (const channel of saved.faults) if (!text(channel)) bad("fault");
  for (const [channel, clock] of saved.clocks) {
    if (!text(channel) || !record(clock) || !isBytes(clock.epoch) || !Number.isFinite(clock.since))
      bad("clock");
  }
}

/** A store that is not JSON, or not what the store writes: it has nothing to keep (an I/O error is not this). */
class Unparsable extends ConfigError {}

function decode(content: string): Saved {
  const saved = JSON.parse(content, (_key, value: unknown) => {
    const tagged = value as { $hex?: unknown; $map?: unknown; $set?: unknown } | null;
    if (text(tagged?.$hex)) {
      if (!HEX.test(tagged.$hex)) throw new Error("bad hex");
      return Uint8Array.from(Buffer.from(tagged.$hex, "hex"));
    }
    if (Array.isArray(tagged?.$map)) return new Map(tagged.$map as [unknown, unknown][]);
    if (Array.isArray(tagged?.$set)) return new Set(tagged.$set);
    return value;
  }) as Saved & { version?: unknown };
  if (saved.outboxes instanceof Map)
    for (const items of saved.outboxes.values())
      for (const item of Array.isArray(items) ? items : [])
        for (const file of Array.isArray(item?.files) ? item.files : [])
          if (record(file)) file.blob = new Uint8Array(0); // the bytes are a blob file
  if (
    !record(saved) ||
    saved.version !== VERSION ||
    !(saved.decided instanceof Map) ||
    !(saved.outboxes instanceof Map) ||
    !(saved.faults instanceof Set) ||
    !(saved.clocks instanceof Map)
  ) {
    throw new Error("wrong shape");
  }
  check(saved);
  return saved;
}

/** The file's content, `undefined` when there is none; a file that does not read or parse is refused, naming it. */
function load(path: string): Saved | undefined {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(`${path} does not read: remove it, or ${AGAIN}`);
  }
  try {
    return decode(content);
  } catch {
    throw new Unparsable(`${path} does not parse: remove it, or ${AGAIN}`);
  }
}

/**
 * Resets the store of `directory` to `who`'s, keeping only `decided` (a new pairing, row I1, or the
 * end of one cut by a crash, row N1): from `old` when the caller has read it, else from the file.
 * A store that does not parse has nothing to keep; one that cannot be read at all fails the reset.
 */
export function resetStore(directory: string, who: Identity, old?: Saved): Saved {
  const path = join(directory, STORE);
  let decided = old?.decided;
  if (!old) {
    try {
      decided = load(path)?.decided;
    } catch (error) {
      if (!(error instanceof Unparsable)) throw error;
    }
  }
  const saved = fresh(who, decided);
  try {
    writeFileAtomic(path, encode(saved));
  } catch (error) {
    // `RenamedOnly`: the file holds the reset, only the flush of its directory failed.
    if (!(error instanceof RenamedOnly)) throw new ConfigError(`${path} cannot be written`);
  }
  return saved;
}

/** One writer: every change goes through `change`, and the file is written whole, one write at a time. */
export class Store {
  readonly saved: Saved;
  #path: string;
  #last: Promise<void> = Promise.resolve();
  #queued: Promise<void> | undefined;

  /** The folder of the store's file, where `blobs/` is. */
  get directory(): string {
    return dirname(this.#path);
  }

  private constructor(path: string, saved: Saved) {
    this.#path = path;
    this.saved = saved;
  }

  /**
   * Opens the store of `directory` for `who`. A store that does not read fails the start, naming the
   * file (row M1, C15); one of another identity is reset keeping `decided` (row N1); none is empty.
   */
  static open(directory: string, who: Identity): Store {
    const path = join(directory, STORE);
    const saved = load(path);
    if (saved && bytesEqual(saved.device, who.device) && bytesEqual(saved.relay, who.relay)) {
      return new Store(path, saved);
    }
    return new Store(path, saved ? resetStore(directory, who, saved) : fresh(who));
  }

  /**
   * Applies the synchronous `edit` to a copy of what is kept, checks the copy and swaps it in; an
   * edit that throws or leaves a shape the store refuses changes nothing, and the call rejects with
   * its error. Resolves when a write holding the change is on disk; changes that arrive during a
   * write share the next one. "On disk" is the file's rename: if only the flush of the directory
   * failed, the call still resolves (a start the bot loses that way is read back as cut, SD 5.8).
   */
  change(edit: (saved: Saved) => void): Promise<void> {
    const draft = structuredClone(this.saved);
    try {
      if ((edit(draft) as unknown) instanceof Promise) throw new Error("an edit is synchronous");
      check(draft);
    } catch (error) {
      return Promise.reject(error);
    }
    Object.assign(this.saved, draft);
    return this.#save();
  }

  #save(): Promise<void> {
    if (this.#queued) return this.#queued;
    const queued = this.#last.then(() => {
      this.#queued = undefined;
      try {
        writeFileAtomic(this.#path, encode(this.saved));
      } catch (error) {
        // The file holds the whole text: only the flush of its directory failed.
        if (!(error instanceof RenamedOnly)) throw error;
      }
    });
    this.#queued = queued;
    // A failed write is the caller's to see; the chain goes on, and a caller that dropped the promise ends nothing.
    this.#last = queued.catch(() => {});
    return queued;
  }
}
