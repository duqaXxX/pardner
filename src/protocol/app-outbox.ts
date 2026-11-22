/**
 * What `AppLink` keeps of its own, beside `Link`'s (new channel design 3.1): the channel being created,
 * the outbox of each channel and the channels stopped on a fault. Written whole by the app, as one file.
 */
import { bytesEqual, isBytes } from "./bytes.ts";
import { idKey } from "./device-log.ts";
import {
  decodeMessage,
  fits,
  KIND_CHANNEL_NAME,
  KIND_DEVICE_NAME,
  KIND_PERSON_NAME,
  type Reference,
} from "./messages.ts";
import type { OutboxItem } from "./outbox.ts";
import type { Bytes } from "./platform.ts";
import { readName } from "./profile.ts";

/** A name the person set that this device has not read back (names design 4.4): its message name is chosen when it is set, and only a read-back of a message under it clears it. A channel's carries its `channel`; the person's and the device's go into the space. */
export interface PendingName {
  kind: number;
  channel?: Bytes | undefined;
  name: Bytes;
  content: string;
  /** The first app's name asked at setup, dropped once the person has named themselves since (4.2). */
  setup: boolean;
}

/** The app outbox as the store keeps it: entry 0 of the channel being created, entry 0 of the person's space while it is made (a slot of its own, so it never blocks a new channel), each channel's items with their built bytes, and the faulted channels. */
export interface AppOutbox {
  pending: { signed: Bytes; sig: Bytes } | null;
  space?: { signed: Bytes; sig: Bytes } | null;
  channels: { channel: Bytes; items: OutboxItem[] }[];
  faults: Bytes[];
  names?: PendingName[];
}

/** An item as a screen draws it: `waiting` for the relay, `sent` (the relay holds it, not read back yet), or `refused` (not delivered, gone from the outbox). */
export interface OutboxView {
  name: Bytes;
  kind: number;
  to: Bytes | undefined;
  re: Reference | undefined;
  /** The text the owner wrote, as the body's JSON: held in memory by a screen, on disk already in the outbox. */
  content: string;
  state: "waiting" | "sent" | "refused";
}

const sized = (b: unknown, n: number) => isBytes(b) && b.length === n;

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * The item a stored value holds, or `undefined` when it lacks the shapes `queue` and `build` need: a stored value is the
 * file's, not ours, and a wrong one would throw in every later call. A null optional field is absent, as an omitted one.
 */
function clean(raw: unknown): OutboxItem | undefined {
  if (!object(raw)) return undefined;
  const { name, kind, to, re, content, files, incarnation, built } = raw;
  const ref = object(re) ? { device: re.device, name: re.name } : undefined;
  // Damaged built bytes leave the item unbuilt: a refusal of them would be taken for a fault of the relay.
  // Built again under a new run, an item the relay had already placed is placed twice (it keys a copy by
  // sender, run and counter): rare, since it needs bytes damaged after they were accepted, and better than
  // a channel stopped for good.
  const own = (b: unknown): b is { signed: Bytes; signature: Bytes } => {
    if (!sized(name, 16) || !object(b) || !isBytes(b.signed) || !sized(b.signature, 64))
      return false;
    const m = decodeMessage(b.signed);
    return m.ok && bytesEqual(m.value.header.name, name as Bytes);
  };
  const b = own(built) ? { signed: built.signed, signature: built.signature } : undefined;
  const item = {
    name: name as Bytes,
    kind: kind as number,
    to: (to ?? undefined) as Bytes | undefined,
    re: ref as Reference | undefined,
    content: content as string,
    files: [],
    incarnation: (incarnation ?? undefined) as Bytes | undefined,
    built: b as OutboxItem["built"],
  };
  const ok =
    sized(name, 16) &&
    typeof kind === "number" &&
    typeof content === "string" &&
    Array.isArray(files) &&
    files.length === 0 && // files are refused until their keys can be sealed at rest
    (to == null || sized(to, 32)) &&
    (re == null || (ref !== undefined && sized(ref.device, 32) && sized(ref.name, 16))) &&
    fits(item) &&
    (incarnation == null || sized(incarnation, 16));
  return ok ? item : undefined;
}

/** The pending name a stored value holds, or `undefined` when it is not one. */
function cleanName(raw: unknown): PendingName | undefined {
  if (!object(raw)) return undefined;
  const { kind, channel, name, content, setup } = raw;
  const named = kind === KIND_CHANNEL_NAME;
  const ok =
    (named || kind === KIND_PERSON_NAME || kind === KIND_DEVICE_NAME) &&
    sized(name, 16) &&
    typeof content === "string" &&
    readName(kind as number, content).ok &&
    (named ? sized(channel, 32) : channel == null) &&
    typeof setup === "boolean";
  return ok
    ? {
        kind: kind as number,
        channel: (channel ?? undefined) as Bytes | undefined,
        name: name as Bytes,
        content,
        setup,
      }
    : undefined;
}

/** The app outbox in memory: what the store held, cleaned at load, and what `AppLink` changes. */
export class Boxes {
  pending: AppOutbox["pending"];
  space: AppOutbox["pending"];
  names: PendingName[] = [];
  #items = new Map<string, { channel: Bytes; items: readonly OutboxItem[] }>();
  #faults = new Map<string, Bytes>();

  /**
   * Takes what the store holds and drops what does not have the shape of a stored value, never throwing: a bad entry, item,
   * channel or fault is not kept. A missing optional field is omitted or null, both read as absent.
   */
  constructor(stored?: AppOutbox) {
    const p: unknown = stored?.pending;
    this.pending =
      object(p) && isBytes(p.signed) && sized(p.sig, 64) ? (p as Boxes["pending"]) : null;
    const h: unknown = stored?.space;
    this.space = object(h) && isBytes(h.signed) && sized(h.sig, 64) ? (h as Boxes["space"]) : null;
    const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
    for (const c of list(stored?.channels))
      if (object(c) && sized(c.channel, 32))
        this.set(
          c.channel as Bytes,
          list(c.items).flatMap((i) => clean(i) ?? []),
        );
    this.names = list(stored?.names).flatMap((n) => cleanName(n) ?? []);
    for (const f of list(stored?.faults))
      if (sized(f, 32)) this.#faults.set(idKey(f as Bytes), f as Bytes);
  }

  /** The channels that hold items. */
  channels(): Bytes[] {
    return [...this.#items.values()].map((c) => c.channel);
  }
  /** The items of `channel`, oldest first. */
  items(channel: Bytes): readonly OutboxItem[] {
    return this.#items.get(idKey(channel))?.items ?? [];
  }
  /** An empty list removes the channel. */
  set(channel: Bytes, items: readonly OutboxItem[]): void {
    if (items.length) this.#items.set(idKey(channel), { channel, items });
    else this.#items.delete(idKey(channel));
  }
  /** Whether `channel` is stopped on a fault. */
  faulted(channel: Bytes): boolean {
    return this.#faults.has(idKey(channel));
  }
  /** Stops `channel` on a fault. */
  fault(channel: Bytes): void {
    this.#faults.set(idKey(channel), channel);
  }
  /** Lets `channel` send again: its fault is dropped. */
  unfault(channel: Bytes): void {
    this.#faults.delete(idKey(channel));
  }
  /** What the store writes: a copy, not changed by what follows. */
  snapshot(): AppOutbox {
    return {
      pending: this.pending,
      ...(this.space && { space: this.space }),
      channels: [...this.#items.values()].map((c) => ({ channel: c.channel, items: [...c.items] })),
      faults: [...this.#faults.values()],
      ...(this.names.length && { names: [...this.names] }),
    };
  }
}
