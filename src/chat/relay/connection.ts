/**
 * The bot's connection to the relay (design 3.5): TLS 1.3 with the relay's key pinned from the pairing,
 * the hello, the exporter binding (crypto.md 10), `prove active`, then the reading of 3.4 driven by
 * what the relay sends. It dials again after a drop, backs off, gives its head back on a connection of its own; it stops for good when the relay
 * must be recreated or the reading met a fault, and any other error is a drop. `submit` is the one
 * request it sends for a caller, on a served connection at rest. Shares no code with the scripted device's link.
 */
import { X509Certificate } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { type TLSSocket, connect as tls } from "node:tls";
import { isDeepStrictEqual } from "node:util";
import { bytesEqual } from "../../protocol/bytes.ts";
import { decodeFrame, encodeFrame, type Frame, frameLength } from "../../protocol/frames.ts";
import { deviceId, relayKeyId } from "../../protocol/ids.ts";
import { EXPORTER_LABEL } from "../../protocol/labels.ts";
import type { Bytes, Platform } from "../../protocol/platform.ts";
import { encodeProof, type Proof, type Session } from "../../protocol/proofs.ts";
import { type Out, Reading, type State } from "../../protocol/reading.ts";
import { type Pairing, RECEIVE, SIGN } from "./pairing.ts";
import type { Store } from "./store.ts";

const FIRST = 1000; // the first back-off, doubled to MAX, back to FIRST at rest
const MAX = 60_000;
const ASK = 10 * 60_000; // a refused bot asks again, and a bot at rest sends a read when it sent nothing for this long (RD 4.6: 15 minutes)
const PATIENCE = 30_000; // without a frame before rest, or without an answer to a read
const SPKI = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");

/** Time, for a test to drive: `wait` is a back-off, `idle` a limit on silence. True when the time passed, false when `signal` ended it. */
export interface Clock {
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<boolean>;
  idle(ms: number, signal: AbortSignal): Promise<boolean>;
}

const sleep = (ms: number, signal: AbortSignal) => delay(ms, true, { signal }).catch(() => false);

const realClock: Clock = { now: () => performance.now(), wait: sleep, idle: sleep };

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

interface Link {
  send(frame: Frame): void;
  next(): Promise<Frame | undefined>;
  binding(): Bytes;
  close(): void;
}

/** A socket as frames: `next` is `undefined` once it is closed or sent bytes that are no frame. Each frame is allocated once, from its length. */
function framed(socket: TLSSocket): Link {
  let proven = false;
  let closed = false;
  let need = 4;
  let got = 0;
  let chunk = Buffer.allocUnsafe(4);
  const queue: Frame[] = [];
  let waiter: ((f: Frame | undefined) => void) | undefined;
  const end = () => {
    closed = true;
    socket.destroy();
    waiter?.(undefined);
    waiter = undefined;
  };
  socket.setKeepAlive(true, 30_000);
  socket.on("error", end);
  socket.on("close", end);
  // A chunk is a string only after `socket.setEncoding()`, never called here.
  socket.on("data", (received) => {
    const data = received as Buffer;
    for (let at = 0; at < data.length && !closed; ) {
      const take = Math.min(need - got, data.length - at);
      data.copy(chunk, got, at, at + take);
      got += take;
      at += take;
      if (got < need) return;
      if (need === 4) {
        const size = frameLength(chunk, proven);
        if (!size.ok) return end();
        need = 4 + size.value;
        chunk = Buffer.concat([chunk], need);
        continue;
      }
      const frame = decodeFrame(chunk, proven, "device");
      [need, got, chunk] = [4, 0, Buffer.allocUnsafe(4)];
      if (!frame.ok) return end();
      if (waiter) {
        waiter(frame.value);
        waiter = undefined;
      } else queue.push(frame.value);
    }
  });
  return {
    send(frame) {
      const bytes = encodeFrame(frame, proven);
      if (frame.type.startsWith("prove-")) proven = true;
      if (!closed) socket.write(bytes);
    },
    next: () =>
      new Promise((resolve) => {
        const held = queue.shift();
        if (held || closed) resolve(held);
        else waiter = resolve;
      }),
    binding: () =>
      Uint8Array.from(socket.exportKeyingMaterial(32, EXPORTER_LABEL, Buffer.alloc(0))),
    close: () => socket.destroy(),
  };
}

export class Connection {
  readonly reading: Reading;
  #o: ConnectionOptions;
  #clock: Clock;
  #stop = new AbortController();
  #run: Promise<void> = Promise.resolve();
  #link: Link | undefined;
  #delay = FIRST;
  #slow = false; // the last refusal asks again every ASK
  #self: Bytes;
  #served: Link | undefined; // the link `submit` may use: proven, and read to rest at some time
  #request = 1; // the last request id of a `submit`
  #pending = new Map<number, (code: number | undefined) => void>();

  constructor(options: ConnectionOptions) {
    this.#o = options;
    this.#clock = options.clock ?? realClock;
    const { pairing, platform, store } = options;
    this.#self = deviceId(platform, pairing.device.signing, pairing.device.receiving);
    this.reading = new Reading(
      {
        platform,
        relay: pairing.relay,
        person: pairing.person,
        self: this.#self,
        receiving: RECEIVE,
      },
      structuredClone(store.saved.kept),
      { incarnation: store.saved.incarnation, fault: store.saved.fault },
    );
  }

  /** Starts dialing; a stored put-back or fault dials nothing, and tells the caller. */
  start(): void {
    const { log, on } = this.#o;
    if (this.reading.state === "put-back") {
      log("relay: it must be recreated, the bot dials no more");
      on({ do: "put-back" });
    } else if (this.reading.state === "fault") {
      log("relay: a fault is stored, the bot dials no more");
      on({ do: "fault", why: "stored" });
    } else this.#run = this.#loop();
  }

  /**
   * Sends one item and gives the relay's result code, or `undefined` when nothing was sent (the
   * reading is not at rest) or the connection ended before the answer: the item is then sent again.
   */
  submit(kind: 1 | 2 | 3 | 4, signed: Bytes, sig: Bytes): Promise<number | undefined> {
    const link = this.#served;
    if (!link || !this.reading.sendable) return Promise.resolve(undefined);
    const request = ++this.#request;
    // No answer within PATIENCE is a drop: the link is closed, and the item is sent again after the next rest.
    const limit = new AbortController();
    void this.#clock
      .idle(PATIENCE, AbortSignal.any([limit.signal, this.#stop.signal]))
      .then((late) => late && link.close());
    return new Promise<number | undefined>((resolve) => {
      this.#pending.set(request, resolve);
      try {
        link.send({ type: "submit", request, kind, signed, sig });
      } catch (error) {
        this.#pending.delete(request);
        throw error;
      }
    }).finally(() => limit.abort());
  }

  /** Ends the connection and the dialing; resolves when the loop has ended. */
  async stop(): Promise<void> {
    this.#stop.abort();
    this.#link?.close();
    await this.#run;
  }

  async #loop(): Promise<void> {
    const r = this.reading;
    const state = () => r.state as State; // the loop's own awaits move it
    const final = () => state() === "put-back" || state() === "fault";
    while (!this.#stop.signal.aborted && !final()) {
      try {
        if (state() === "giving-back") await this.#upload();
        else await this.#active();
      } catch (error) {
        // Any error is a drop (a failed store write included): the store writes again with its next change.
        this.#o.log(`relay: connection error: ${(error as Error).message}`);
        if (state() === "giving-back")
          for (const out of r.gaveBack(undefined)) await this.#act(out);
      }
      if (state() !== "giving-back") r.dropped();
      if (final() || state() === "giving-back") continue;
      const ms = this.#slow ? ASK : this.#delay;
      if (!this.#slow) this.#delay = Math.min(this.#delay * 2, MAX);
      this.#o.log(`relay: connection ended, dialing again in ${ms / 1000} s`);
      await this.#clock.wait(ms, this.#stop.signal);
    }
  }

  /** TLS up and the relay's key the pinned one, or `undefined` (nothing is sent to another key). */
  async #dial(): Promise<{ link: Link; nonce: Bytes } | undefined> {
    const { host, port } = this.#o.address();
    const socket = tls({
      host,
      port,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      rejectUnauthorized: false,
    });
    const link = framed(socket);
    this.#link = link;
    const limit = new AbortController();
    void this.#clock
      .idle(PATIENCE, AbortSignal.any([limit.signal, this.#stop.signal]))
      .then((late) => late && socket.destroy());
    let held = false;
    try {
      const up = await new Promise<boolean>((resolve) => {
        socket.once("secureConnect", () => resolve(true));
        socket.once("close", () => resolve(false));
      });
      if (!up) return undefined;
      if (!this.#pinned(socket)) {
        this.#o.log("relay: its key is not the one the bot was paired with, nothing sent");
        return undefined;
      }
      const hello = await link.next();
      if (hello?.type !== "hello") return undefined;
      held = true;
      return { link, nonce: hello.relayNonce };
    } finally {
      limit.abort();
      if (!held) link.close();
    }
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

  #session(link: Link, relayNonce: Bytes): Session {
    const { platform, pairing } = this.#o;
    return {
      relay: relayKeyId(platform, pairing.relay),
      deviceNonce: platform.random(32),
      relayNonce,
      binding: link.binding(),
    };
  }

  #sign(proof: Proof): Bytes {
    const sig = this.#o.platform.sign(SIGN, encodeProof(proof));
    if (!sig.ok) throw new Error("the platform did not sign");
    return sig.value;
  }

  async #active(): Promise<void> {
    const r = this.reading;
    const clock = this.#clock;
    const dialed = await this.#dial();
    if (!dialed) return;
    const { link, nonce } = dialed;
    let arming = new AbortController(); // the idle timer of this connection
    this.#served = link;
    try {
      const proof = {
        ...this.#session(link, nonce),
        kind: "active" as const,
        person: this.#o.pairing.person,
        device: this.#self,
      };
      link.send({ type: "prove-active", proof, sig: this.#sign(proof) });
      // The relay's limit counts what the bot sends (RD 4.6): a read is due ASK after the last frame
      // sent, however many it received; before rest, or while a read is unanswered, silence is PATIENCE.
      let sentAt = clock.now();
      let seenAt = sentAt;
      let asked = false;
      const due = () =>
        r.state === "rest" ? sentAt + (asked ? PATIENCE : ASK) : seenAt + PATIENCE;
      let armed = 0;
      let timer: Promise<"idle" | undefined> | undefined;
      const arm = () => {
        arming.abort();
        arming = new AbortController();
        armed = due();
        timer = clock
          .idle(
            Math.max(armed - clock.now(), 0),
            AbortSignal.any([arming.signal, this.#stop.signal]),
          )
          .then((late) => (late ? "idle" : undefined));
      };
      arm();
      for (;;) {
        const frame = await Promise.race([link.next(), timer]);
        if (frame === "idle") {
          if (clock.now() < due()) arm();
          else if (r.state === "rest" && !asked) {
            link.send({ type: "read", from: r.cursor });
            [sentAt, asked] = [clock.now(), true];
            arm();
          } else {
            this.#o.log("relay: no frame for 30 s, connection dropped");
            return;
          }
          continue;
        }
        if (!frame) return;
        seenAt = clock.now();
        if (frame.type === "result") {
          this.#pending.get(frame.request)?.(frame.code);
          this.#pending.delete(frame.request);
        }
        if (frame.type === "position") asked = false;
        for (const out of r.take(frame)) {
          if (out.do === "read") sentAt = clock.now();
          await this.#act(out, link);
        }
        if (r.state !== "reading" && r.state !== "rest") return;
        if (due() < armed) arm(); // a frame that leaves rest shortens the wait
      }
    } finally {
      this.#served = undefined;
      for (const resolve of this.#pending.values()) resolve(undefined);
      this.#pending.clear();
      arming.abort();
      link.close();
    }
  }

  /** Gives the head held on a connection of its own, and tells the reading the answer. */
  async #upload(): Promise<void> {
    const r = this.reading;
    const held = r.kept.head as NonNullable<typeof r.kept.head>;
    this.#o.log("relay: giving back the head held");
    let code: number | undefined;
    let refusal: number | undefined;
    const dialed = await this.#dial();
    if (dialed) {
      const { link, nonce } = dialed;
      try {
        const proof = {
          ...this.#session(link, nonce),
          kind: "upload" as const,
          device: this.#o.pairing.device,
          head: held.head,
        };
        link.send({
          type: "prove-upload",
          proof,
          deviceSig: this.#sign(proof),
          relaySig: held.sig,
        });
        link.send({ type: "upload-done", request: 1, head: held.head, sig: held.sig });
        while (code === undefined && refusal === undefined) {
          const f = await this.#answer(link);
          if (!f) break;
          if (f.type === "result" && f.request === 1) code = f.code;
          else if (f.type === "refused") refusal = f.reason;
          else this.#o.log(`relay: give-back answered with ${f.type}`);
        }
      } finally {
        link.close();
      }
    }
    if (this.#stop.signal.aborted) return;
    if (refusal !== undefined && refusal !== 6) {
      this.#o.log(`relay: give-back refused, reason ${refusal}`);
      this.#slow = true;
    }
    for (const out of r.gaveBack(code, refusal)) await this.#act(out);
  }

  /** The next frame within PATIENCE, or `undefined`. */
  async #answer(link: Link): Promise<Frame | undefined> {
    const limit = new AbortController();
    const late = this.#clock
      .idle(PATIENCE, AbortSignal.any([limit.signal, this.#stop.signal]))
      .then(() => undefined);
    try {
      return await Promise.race([link.next(), late]);
    } finally {
      limit.abort();
    }
  }

  async #act(out: Out, link?: Link): Promise<void> {
    const { log, on } = this.#o;
    switch (out.do) {
      case "read":
        link?.send({ type: "read", from: out.from });
        return;
      case "incarnation":
        if (!bytesEqual(this.#o.store.saved.incarnation ?? new Uint8Array(), out.incarnation))
          await this.#save((s) => Object.assign(s, { incarnation: out.incarnation }));
        break;
      case "rest":
        if (!isDeepStrictEqual(this.reading.kept, this.#o.store.saved.kept))
          await this.#save(() => {});
        this.#delay = FIRST;
        this.#slow = false;
        log("relay: read to rest");
        break;
      case "refused":
        this.#slow =
          out.reason === 1 ||
          out.reason === 5 ||
          (out.reason === 2 && this.reading.kept.head !== undefined);
        log(`relay: refused, reason ${out.reason}`);
        return;
      case "put-back":
        await this.#final(() => {});
        log("relay: it must be recreated, the bot dials no more");
        break;
      case "fault":
        await this.#final((s) => Object.assign(s, { fault: true }));
        log(`relay: fault, ${out.why}, the bot dials no more`);
        break;
      case "give-back":
        return;
    }
    on(out);
  }

  #final(edit: (s: Store["saved"]) => void): Promise<void> {
    return this.#save(edit).catch((error: Error) =>
      this.#o.log(`relay: the store did not write: ${error.message}`),
    );
  }

  #save(edit: (s: Store["saved"]) => void): Promise<void> {
    return this.#o.store.change((s) => {
      edit(s);
      s.kept = structuredClone(this.reading.kept);
    });
  }
}
