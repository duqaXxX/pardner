/**
 * The bot's connection to the relay (design 3.5): the driver of `Link` (`src/protocol/link.ts`), which
 * holds the policy: the hello, the exporter binding (crypto.md 10), `prove active`, the reading of 3.4,
 * the back-off, the refusals, the give-back on a connection of its own, and the request `submit` sends.
 * This file holds what only Node can do: TLS 1.3 with the relay's key pinned from the pairing, one timer,
 * the store, the log. Socket events, the timer and `submit` go through one queue, taken one at a time,
 * so no frame is handled while a store write is in flight. Shares no code with the scripted device's link.
 */
import { X509Certificate } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { type TLSSocket, connect as tls } from "node:tls";
import type { HistorySeal } from "../../protocol/epochs.ts";
import { deviceId } from "../../protocol/ids.ts";
import { EXPORTER_LABEL } from "../../protocol/labels.ts";
import { type Effect, Link, type Persist } from "../../protocol/link.ts";
import type { Bytes, Platform } from "../../protocol/platform.ts";
import type { Out, Reading } from "../../protocol/reading.ts";
import { type Pairing, RECEIVE, SIGN } from "./pairing.ts";
import type { Store } from "./store.ts";

const SPKI = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");

/** Time, for a test to drive: `wait` is a back-off, `idle` a limit on silence. True when the time passed, false when `signal` ended it. */
export interface Clock {
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<boolean>;
  idle(ms: number, signal: AbortSignal): Promise<boolean>;
}

const sleep = (ms: number, signal: AbortSignal) => delay(ms, true, { signal }).catch(() => false);

export const realClock: Clock = { now: () => performance.now(), wait: sleep, idle: sleep };

export interface ConnectionOptions {
  /** Where the relay is, read at each dial. */
  address: () => { host: string; port: number };
  pairing: Pairing;
  /** Holds the bot's keys under the names of `pairing.ts`. */
  platform: Platform;
  store: Store;
  log: (line: string) => void;
  /** Told of each incarnation, message, rest, put-back and fault, after the store holds what it changed. */
  on: (out: Out) => void;
  clock?: Clock;
}

type Event = (now: number) => Effect[];

export class Connection {
  readonly reading: Reading;
  #o: ConnectionOptions;
  #clock: Clock;
  #link: Link;
  #sockets = new Map<number, TLSSocket>();
  #events: Event[] = [];
  #wake: (() => void) | undefined; // the loop, asleep until an event comes
  #run: Promise<void> | undefined;
  #started = false; // `start` ran: events are taken from then on, a dial's first `closed` included
  #ended = false; // the loop ended: the link is final
  #stopped = false; // `stop` was called: a later `start` does nothing
  #conn = 0; // the last connection dialed
  #now = 0; // the time handed to the last call of the link
  #timer = new AbortController();
  #armed: string | undefined; // the deadline the timer waits for, and how
  #waitAt = -1; // the deadline of the back-off already logged
  #pending = new Map<number, (code: number | undefined) => void>();

  constructor(options: ConnectionOptions) {
    this.#o = options;
    this.#clock = options.clock ?? realClock;
    const { pairing, platform, store } = options;
    this.#link = new Link({
      who: {
        platform,
        relay: pairing.relay,
        person: pairing.person,
        self: deviceId(platform, pairing.device.signing, pairing.device.receiving),
        receiving: RECEIVE,
      },
      keys: pairing.device,
      sign: SIGN,
      kept: structuredClone(store.saved.kept),
      stored: { incarnation: store.saved.incarnation, fault: store.saved.fault },
    });
    this.reading = this.#link.reading;
  }

  /** Starts dialing; a stored put-back or fault dials nothing, and tells the caller. */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#events.push((now) => this.#link.start(now));
    this.#run = this.#loop();
  }

  /**
   * Sends one item and gives the relay's result code, or `undefined` when nothing was sent (the
   * reading is not at rest) or the connection ended before the answer: the item is then sent again.
   */
  submit(kind: 1 | 2 | 3 | 4, signed: Bytes, sig: Bytes): Promise<number | undefined> {
    return this.#ask((now) => this.#link.submit(kind, signed, sig, now));
  }

  /** Gives the relay a history seal this device made: its result code, or `undefined` as `submit` answers it. */
  giveSeal(seal: HistorySeal, sig: Bytes): Promise<number | undefined> {
    return this.#ask((now) => this.#link.giveSeal(seal, sig, now));
  }

  #ask(send: (now: number) => ReturnType<Link["submit"]>): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
      this.#push((now) => {
        try {
          const sent = send(now);
          if (sent === "busy") resolve(undefined);
          else this.#pending.set(sent.request, resolve);
          return sent === "busy" ? [] : sent.effects;
        } catch (error) {
          reject(error);
          return [];
        }
      }, resolve);
    });
  }

  /** Ends the connection and the dialing; resolves when the loop has ended. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#push((now) => this.#link.stop(now));
    await this.#run;
  }

  /** Queues an event; `refuse` is called instead when the loop has ended and nothing would take it. */
  #push(event: Event, refuse?: (code: undefined) => void): void {
    if (this.#ended || !this.#started) {
      refuse?.(undefined);
      return;
    }
    this.#events.push(event);
    this.#wake?.();
  }

  async #loop(): Promise<void> {
    // The link's final states: put-back and fault dial no more, stopped ends for good.
    const final = () => ["put-back", "fault", "stopped"].includes(this.#link.state);
    do {
      const next = this.#events.shift();
      if (!next) {
        await new Promise<void>((resolve) => (this.#wake = resolve));
        continue;
      }
      await this.#run1(next);
    } while (!final());
    this.#ended = true;
    this.#timer.abort();
    for (const socket of this.#sockets.values()) socket.destroy();
    // What was queued behind the last event meets the final link: a `submit` is `busy` and settles.
    for (const next of this.#events.splice(0)) await this.#run1(next);
    for (const resolve of this.#pending.values()) resolve(undefined);
    this.#pending.clear();
  }

  /** One event through the link and its effects; a throw is logged and the loop goes on. */
  async #run1(event: Event): Promise<void> {
    try {
      await this.#perform(event(this.#time()));
    } catch (error) {
      this.#o.log(`relay: connection error: ${(error as Error).message}`);
    }
  }

  #time(): number {
    this.#now = Math.max(this.#now, this.#clock.now()); // the link is never given an earlier time
    return this.#now;
  }

  /**
   * Performs the effects in order, each on its own: a throw is logged and the others still run (a
   * `persist` must be answered, the `wake` armed), then the current connection is dropped. A `persist`
   * ends its list, so what the store's answer returns follows it.
   */
  async #perform(effects: Effect[]): Promise<void> {
    let failed = false;
    const conn = this.#conn; // the connection the throw is about: a dial in this list replaces #conn
    for (const fx of effects) {
      if (fx.do === "persist") {
        await this.#perform(this.#link.persisted(await this.#write(fx.what), this.#time()));
        break;
      }
      try {
        this.#effect(fx);
      } catch (error) {
        this.#o.log(`relay: connection error: ${(error as Error).message}`);
        failed = true;
        // A dial that threw has no socket to bring its `closed`.
        if (fx.do === "dial") this.#push((now) => this.#link.closed(fx.conn, now));
      }
    }
    // Destroying the socket brings its `closed` through the queue.
    if (failed) this.#sockets.get(conn)?.destroy();
  }

  #effect(fx: Exclude<Effect, { do: "persist" }>): void {
    switch (fx.do) {
      case "dial":
        this.#waitAt = -1;
        this.#conn = fx.conn;
        this.#dial(fx.conn, fx.purpose);
        break;
      case "send":
        this.#sockets.get(fx.conn)?.write(fx.bytes);
        break;
      case "close":
        if (fx.why) this.#o.log(`relay: ${fx.why}`);
        this.#sockets.get(fx.conn)?.destroy();
        this.#sockets.delete(fx.conn);
        break;
      case "wake":
        this.#arm(fx.at);
        break;
      case "deliver":
        this.#deliver(fx.out);
        break;
      case "answer":
        this.#pending.get(fx.request)?.(fx.code === "unanswered" ? undefined : fx.code);
        this.#pending.delete(fx.request);
        break;
    }
  }

  /** The one timer: a back-off goes to `wait` and ticks at its deadline, any other deadline to `idle`. */
  #arm(at: number): void {
    const waiting = this.#link.state === "waiting";
    // The link repeats its wake after every call: a timer already waiting for that deadline stays.
    if (this.#armed === `${waiting} ${at}`) return;
    this.#armed = `${waiting} ${at}`;
    this.#timer.abort();
    this.#timer = new AbortController();
    const { signal } = this.#timer;
    const ms = Math.max(at - this.#now, 0); // the time the link was last given, as its deadlines are
    if (waiting && at !== this.#waitAt) {
      this.#waitAt = at;
      this.#o.log(`relay: connection ended, dialing again in ${ms / 1000} s`);
    }
    const timer = waiting ? this.#clock.wait(ms, signal) : this.#clock.idle(ms, signal);
    void timer.then((passed) => {
      if (!passed || signal.aborted) return; // a timer that is no longer the armed one does nothing
      this.#armed = undefined;
      this.#push((now) => {
        this.#now = Math.max(now, at);
        return this.#link.tick(this.#now);
      });
    });
  }

  /** Writes what the link asks to store; false when the store did not write. */
  async #write(what: Persist): Promise<boolean> {
    const final = "putBack" in what || "fault" in what;
    try {
      await this.#o.store.change((s) => {
        if ("incarnation" in what) s.incarnation = what.incarnation;
        if ("fault" in what) s.fault = true;
        s.kept = structuredClone("kept" in what ? what.kept : this.reading.kept);
      });
      return true;
    } catch (error) {
      // A failed write of put-back or fault is logged and not repeated; any other is a drop, and the store writes again with its next change.
      const { message } = error as Error;
      this.#o.log(
        final
          ? `relay: the store did not write: ${message}`
          : `relay: connection error: ${message}`,
      );
      return false;
    }
  }

  /** Tells the log and the caller of what the reading said, after the store holds what it changed. */
  #deliver(out: Out): void {
    const { log, on } = this.#o;
    switch (out.do) {
      case "rest":
        log("relay: read to rest");
        break;
      case "refused":
        log(`relay: refused, reason ${out.reason}`);
        return;
      case "put-back":
        log("relay: it must be recreated, the bot dials no more");
        break;
      case "fault":
        log(
          out.why === "stored"
            ? "relay: a fault is stored, the bot dials no more"
            : `relay: fault, ${out.why}, the bot dials no more`,
        );
        break;
    }
    on(out);
  }

  /** TLS up to `conn`; its events go to the queue, `closed` once, and `opened` only when the relay's key is the pinned one. */
  #dial(conn: number, purpose: "active" | "upload" | "recover"): void {
    if (purpose === "upload") this.#o.log("relay: giving back the head held");
    const { host, port } = this.#o.address();
    const socket = tls({
      host,
      port,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      // The relay's certificate is self-signed and made anew at each
      // start, so no chain can verify it: the bot compares the relay's
      // key with the one pinned at pairing (#pinned) before it sends a
      // byte of its own.
      rejectUnauthorized: false,
    });
    this.#sockets.set(conn, socket);
    socket.setKeepAlive(true, 30_000);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (this.#sockets.get(conn) === socket) this.#sockets.delete(conn);
      this.#push((now) => this.#link.closed(conn, now));
    });
    socket.once("secureConnect", () => {
      try {
        if (!this.#pinned(socket)) {
          this.#o.log("relay: its key is not the one the bot was paired with, nothing sent");
          return void socket.destroy();
        }
        const binding = Uint8Array.from(
          socket.exportKeyingMaterial(32, EXPORTER_LABEL, Buffer.alloc(0)),
        );
        this.#push((now) => this.#link.opened(conn, binding, now));
      } catch (error) {
        // No binding, no proof: a drop.
        this.#o.log(`relay: connection error: ${(error as Error).message}`);
        socket.destroy();
      }
    });
    // A chunk is a string only after `socket.setEncoding()`, never called here.
    socket.on("data", (chunk) =>
      this.#push((now) => this.#link.received(conn, chunk as Buffer, now)),
    );
  }

  /** Whether the certificate's key is the pinned one: the key's DER against the pairing's, whatever kind of key it is. */
  #pinned(socket: TLSSocket): boolean {
    try {
      const der = new X509Certificate(socket.getPeerCertificate().raw).publicKey.export({
        type: "spki",
        format: "der",
      });
      return Buffer.concat([SPKI, this.#o.pairing.relay]).equals(der);
    } catch {
      return false;
    }
  }
}
