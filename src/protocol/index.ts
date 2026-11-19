/**
 * The app's joined-script entry (step 6.3 design, 6.4): what Swift calls through `ProtocolHost`. It
 * holds one `AppLink`, the shared `Link` with what must not cross into Swift taken out of its effects.
 */
import { encodeFrame } from "./frames.ts";
import { deviceId } from "./ids.ts";
import { EXPORTER_LABEL } from "./labels.ts";
import { type Effect, Link, type LinkOptions } from "./link.ts";
import { openMessage } from "./messages.ts";
import type { Bytes, Platform } from "./platform.ts";
import type { Out } from "./reading.ts";

export { EXPORTER_LABEL };

/** The platform's names for the device's two keys: the app's key store holds them under these. */
export const SIGN = "device.sign";
export const RECEIVE = "device.receive";

/** What the screens read of a message: its channel, sender and name, and the opened text (the epoch key and the channel's logs stay in the host). */
export type View =
  | { do: "message"; channel: Bytes; sender: Bytes; name: Bytes; text: string | undefined }
  | Exclude<Out, { do: "message" }>;

/** `Link`'s effects, `deliver` reduced to a `View`; a `persist` never appears: the app has no store in 6.3, so `AppLink` answers each one itself. */
export type AppEffect =
  | Exclude<Effect, { do: "deliver" | "persist" }>
  | { do: "deliver"; out: View };

/** The device and the relay it is paired with: the public keys of the device's own keys, and the relay's pinned key. */
export interface AppLinkOptions {
  relay: Bytes;
  person: Bytes;
  signing: Bytes;
  receiving: Bytes;
  constants?: LinkOptions["constants"];
}

/**
 * The device's connection to the relay for the app: `Link`'s calls, with effects a driver in Swift can take.
 * Every `persist` is answered inside the host, as stored: the app has no store in 6.3, and the store's
 * pull request returns them (the incarnation, `kept`, put-back and fault) to the driver with stored state.
 */
export class AppLink {
  #link: Link;
  #platform: Platform;

  constructor(platform: Platform, o: AppLinkOptions) {
    this.#platform = platform;
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
      kept: { ids: [], head: undefined, putBack: false },
      ...(o.constants && { constants: o.constants }),
    });
  }

  start(now: number): AppEffect[] {
    return this.#view(this.#link.start(now), now);
  }
  opened(conn: number, binding: Bytes, now: number): AppEffect[] {
    return this.#view(this.#link.opened(conn, binding, now), now);
  }
  received(conn: number, bytes: Bytes, now: number): AppEffect[] {
    return this.#view(this.#link.received(conn, bytes, now), now);
  }
  closed(conn: number, now: number): AppEffect[] {
    return this.#view(this.#link.closed(conn, now), now);
  }
  tick(now: number): AppEffect[] {
    return this.#view(this.#link.tick(now), now);
  }
  networkUp(now: number): AppEffect[] {
    return this.#view(this.#link.networkUp(now), now);
  }
  stop(now: number): AppEffect[] {
    return this.#view(this.#link.stop(now), now);
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
    return sent === "busy"
      ? sent
      : { request: sent.request, effects: this.#view(sent.effects, now) };
  }

  /** The label the connection's exporter is taken under. */
  exporterLabel(): string {
    return EXPORTER_LABEL;
  }

  // A `persist` ends its list, so it is answered here and what the answer returns follows.
  #view(effects: Effect[], now: number): AppEffect[] {
    const out: AppEffect[] = [];
    for (let rest = effects; rest.length > 0; ) {
      const last = rest.at(-1) as Effect;
      const stored = last.do === "persist";
      for (const fx of stored ? rest.slice(0, -1) : rest) out.push(this.#reduce(fx));
      rest = stored ? this.#link.persisted(true, now) : [];
    }
    return out;
  }

  #reduce(fx: Effect): AppEffect {
    if (fx.do !== "deliver" || fx.out.do !== "message") return fx as AppEffect;
    const { message, place } = fx.out;
    const body = place.key ? openMessage(this.#platform, place.key, message) : undefined;
    const { channel, sender, name } = message.header;
    return {
      do: "deliver",
      out: {
        do: "message",
        channel,
        sender,
        name,
        text: body?.ok ? body.value.content : undefined,
      },
    };
  }
}

/** A link for the app, from the platform the host holds. */
export function appLink(platform: Platform, options: AppLinkOptions): AppLink {
  return new AppLink(platform, options);
}
