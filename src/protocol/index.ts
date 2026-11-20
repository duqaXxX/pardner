/**
 * The app's joined-script entry (step 6.3 design, 6.4; app data design, 3.3 to 5): what Swift calls
 * through `ProtocolHost`. It holds one `AppLink`, the shared `Link` with what must not cross into
 * Swift taken out of its effects: no epoch key, file key or log ever leaves it.
 */
import { idKey } from "./device-log.ts";
import { encodeFrame } from "./frames.ts";
import { deviceId, relayKeyId } from "./ids.ts";
import { EXPORTER_LABEL } from "./labels.ts";
import { type Effect, Link, type LinkOptions, type Persist } from "./link.ts";
import {
  KIND_PROFILE,
  type Message,
  type MessageBody,
  openMessage,
  type Reference,
} from "./messages.ts";
import type { Bytes, Platform } from "./platform.ts";
import { encodeProfile, type Profile, Profiles } from "./profile.ts";
import type { Kept, Out } from "./reading.ts";

export { EXPORTER_LABEL };

/** The platform's names for the device's two keys: the app's key store holds them under these. */
export const SIGN = "device.sign";
export const RECEIVE = "device.receive";

/** A head the relay signed, as the app's store keeps it: the relay's key id is the pinned key's, added back on load. */
export interface StoredHead {
  n: number;
  chain: Bytes;
  sig: Bytes;
}

/** What the app's store gives back at launch (design 3.1): every field as the last confirmed write left it. */
export interface Stored {
  ids: Bytes[];
  head?: StoredHead | undefined;
  putBack: boolean;
  incarnation?: Bytes | undefined;
  fault: boolean;
}

/**
 * A store write (design 3.3): `kept` on every write, since `Link` counts it stored after any, with only
 * the ids after the `from` the store last confirmed; `incarnation` or `fault` when that is what is asked.
 */
export interface AppPersist {
  kept: { from: number; ids: Bytes[]; head: StoredHead | undefined; putBack: boolean };
  incarnation?: Bytes;
  fault?: true;
}

/** A file of an opened body, without the key that opens its blob (crypto.md 8). */
export interface FileView {
  blob: Bytes;
  size: number;
  type: string;
  name: string;
}

/**
 * What the screens read of a message (design 4.1): its place, its header, and, once its body opened
 * with its own epoch's key, the files and the text. `again` marks a message delivered unopened
 * before, now opened.
 */
export interface MessageView {
  do: "message";
  position: number;
  channel: Bytes;
  sender: Bytes;
  name: Bytes;
  epoch: Bytes;
  time: number;
  kind: number;
  to?: Bytes | undefined;
  re?: Reference | undefined;
  blobs: Bytes[];
  files?: FileView[] | undefined;
  text?: string | undefined;
  again: boolean;
}

export type View = MessageView | Exclude<Out, { do: "message" }>;

/** `Link`'s effects with `deliver` reduced to a `View` and `persist` to what the store writes, and the shown profile of a bot when it changes (design 5). */
export type AppEffect =
  | Exclude<Effect, { do: "deliver" | "persist" }>
  | { do: "deliver"; out: View }
  | { do: "persist"; what: AppPersist }
  | { do: "profile"; bot: Bytes; profile: Profile | null };

/** The device and the relay it is paired with: the public keys of the device's own keys, the relay's pinned key, and what the store holds. */
export interface AppLinkOptions {
  relay: Bytes;
  person: Bytes;
  signing: Bytes;
  receiving: Bytes;
  stored?: Stored;
  constants?: LinkOptions["constants"];
}

/**
 * The device's connection to the relay for the app: `Link`'s calls, with effects a driver in Swift
 * can take. A `persist` ends its list, and the driver answers it with `persisted`.
 */
export class AppLink {
  #link: Link;
  #platform: Platform;
  #saved: number; // the ids the store confirmed
  #held: AppPersist | undefined;
  // Delivered unopened, by channel and epoch, in position order: no key of their epoch yet (4.2).
  #waiting = new Map<string, { message: Message; position: number }[]>();
  #profiles = new Profiles();
  #shown = new Map<string, { bot: Bytes; profile: Profile }>(); // the profile last told to Swift
  #touched = new Map<string, Bytes>(); // the bots whose profile a message of this call may have changed
  #recheck = new Map<string, Bytes>(); // bots shown before a rewind: checked again at the next rest

  constructor(platform: Platform, o: AppLinkOptions) {
    this.#platform = platform;
    const s = o.stored;
    const head = s?.head && {
      head: { relay: relayKeyId(platform, o.relay), n: s.head.n, chain: s.head.chain },
      sig: s.head.sig,
    };
    const kept: Kept = { ids: s?.ids.slice() ?? [], head, putBack: s?.putBack ?? false };
    this.#saved = kept.ids.length;
    this.#link = new Link({
      who: {
        platform,
        relay: o.relay,
        person: o.person,
        self: deviceId(platform, o.signing, o.receiving),
        receiving: RECEIVE,
      },
      keys: { kind: "app", signing: o.signing, receiving: o.receiving },
      sign: SIGN,
      kept,
      stored: { ...(s?.incarnation && { incarnation: s.incarnation }), fault: s?.fault ?? false },
      ...(o.constants && { constants: o.constants }),
    });
  }

  start(now: number): AppEffect[] {
    return this.#view(this.#link.start(now));
  }
  opened(conn: number, binding: Bytes, now: number): AppEffect[] {
    return this.#view(this.#link.opened(conn, binding, now));
  }
  received(conn: number, bytes: Bytes, now: number): AppEffect[] {
    return this.#view(this.#link.received(conn, bytes, now));
  }
  closed(conn: number, now: number): AppEffect[] {
    return this.#view(this.#link.closed(conn, now));
  }
  tick(now: number): AppEffect[] {
    return this.#view(this.#link.tick(now));
  }
  networkUp(now: number): AppEffect[] {
    return this.#view(this.#link.networkUp(now));
  }
  stop(now: number): AppEffect[] {
    return this.#view(this.#link.stop(now));
  }
  /** The store's answer to the last `persist`: `false` when the write failed. */
  persisted(ok: boolean, now: number): AppEffect[] {
    const held = this.#held;
    this.#held = undefined;
    if (ok && held) this.#saved = held.kept.from + held.kept.ids.length;
    return this.#view(this.#link.persisted(ok, now));
  }
  /** An item past the frame limit or outside its field is `invalid`: the caller's item is wrong, the link is not. */
  submit(
    kind: 1 | 2 | 3 | 4,
    signed: Bytes,
    sig: Bytes,
    now: number,
  ): { request: number; effects: AppEffect[] } | "busy" | "invalid" {
    // The frame `Link` will cut, made first: only its failure is the item's. Any other throw is a fault.
    try {
      encodeFrame({ type: "submit", request: 1, kind, signed, sig }, true);
    } catch (error) {
      if ((error as Error)?.name === "RangeError") return "invalid";
      throw error;
    }
    const sent = this.#link.submit(kind, signed, sig, now);
    return sent === "busy" ? sent : { request: sent.request, effects: this.#view(sent.effects) };
  }

  /** The label the connection's exporter is taken under. */
  exporterLabel(): string {
    return EXPORTER_LABEL;
  }

  // A `persist` ends its list: the messages a key opened in this call, then the profiles that changed, go
  // before it (design 3.3).
  #view(effects: Effect[]): AppEffect[] {
    const out = effects.flatMap((fx) => this.#reduce(fx));
    const tail = out.at(-1)?.do === "persist" ? out.splice(-1) : [];
    return [...out, ...this.#retry(), ...this.#told(), ...tail];
  }

  #reduce(fx: Effect): AppEffect[] {
    if (fx.do === "persist") return [{ do: "persist", what: this.#write(fx.what) }];
    if (fx.do !== "deliver") return [fx];
    const out = fx.out;
    if (out.do === "incarnation" && out.changed) {
      // The Reading rewinds and every position comes again (design 4.2, 5). A bot shown before is checked
      // again once the pass reaches rest, and told `null` only if the new sequence names it nowhere.
      this.#waiting.clear();
      this.#profiles = new Profiles();
      for (const [k, { bot }] of this.#shown) this.#recheck.set(k, bot);
    }
    if (out.do === "rest") {
      for (const [k, bot] of this.#recheck) this.#touched.set(k, bot);
      this.#recheck.clear();
    }
    if (out.do !== "message") return [{ do: "deliver", out }];
    const h = out.message.header;
    const key = this.#link.reading.key(h.channel, h.epoch);
    if (key) return this.#open(out.message, out.position, key, false);
    const at = `${idKey(h.channel)} ${idKey(h.epoch)}`;
    this.#waiting.set(at, [
      ...(this.#waiting.get(at) ?? []),
      { message: out.message, position: out.position },
    ]);
    return [{ do: "deliver", out: this.#message(out.message, out.position, undefined, false) }];
  }

  #write(w: Persist): AppPersist {
    const k = this.#link.reading.kept;
    const what: AppPersist = {
      kept: {
        from: this.#saved,
        ids: k.ids.slice(this.#saved),
        head: k.head && { n: k.head.head.n, chain: k.head.head.chain, sig: k.head.sig },
        putBack: k.putBack,
      },
      ...("incarnation" in w && { incarnation: w.incarnation }),
      ...("fault" in w && { fault: true as const }),
    };
    this.#held = what;
    return what;
  }

  // The waiting messages whose epoch key is now held, by epoch and in position order; one that does not open under it is dropped.
  #retry(): AppEffect[] {
    const fx: AppEffect[] = [];
    for (const [at, list] of this.#waiting) {
      const h = (list[0] as { message: Message }).message.header;
      const key = this.#link.reading.key(h.channel, h.epoch);
      if (!key) continue;
      this.#waiting.delete(at);
      for (const { message, position } of list)
        fx.push(...this.#open(message, position, key, true));
    }
    return fx;
  }

  // A message opened now for the first time; delivered again only when it reads (`again`).
  #open(message: Message, position: number, key: Bytes, again: boolean): AppEffect[] {
    const body = openMessage(this.#platform, key, message);
    if (again && !body.ok) return [];
    const view = this.#message(message, position, body.ok ? body.value : undefined, again);
    const h = message.header;
    if (body.ok && h.kind === KIND_PROFILE) {
      this.#profiles.take(position, h, body.value.content);
      this.#touched.set(idKey(h.sender), h.sender);
    }
    return [{ do: "deliver", out: view }];
  }

  // Once per call, each bot whose shown profile changed in it.
  #told(): AppEffect[] {
    const fx: AppEffect[] = [];
    for (const [k, bot] of this.#touched) {
      const profile = this.#profiles.of(bot);
      const had = this.#shown.get(k);
      // By content: after a rewind the same profile is read again into a new object.
      if (had ? profile && encodeProfile(had.profile) === encodeProfile(profile) : !profile)
        continue;
      if (profile) this.#shown.set(k, { bot, profile });
      else this.#shown.delete(k);
      fx.push({ do: "profile", bot, profile: profile ?? null });
    }
    this.#touched.clear();
    return fx;
  }

  #message(
    message: Message,
    position: number,
    body: MessageBody | undefined,
    again: boolean,
  ): MessageView {
    const h = message.header;
    return {
      do: "message",
      position,
      channel: h.channel,
      sender: h.sender,
      name: h.name,
      epoch: h.epoch,
      time: h.time,
      kind: h.kind,
      to: h.to,
      re: h.re,
      blobs: h.blobs,
      files: body?.files.map(({ blob, size, type, name }) => ({ blob, size, type, name })),
      text: body?.content,
      again,
    };
  }
}

/** A link for the app, from the platform the host holds. */
export function appLink(platform: Platform, options: AppLinkOptions): AppLink {
  return new AppLink(platform, options);
}
