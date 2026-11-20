/**
 * The device's connection to the relay as a pure state machine (step 6.3 design, 4), the policy the
 * daemon and the app share: the order of frames, the deadlines, the back-off, the refusal rules and
 * the give-back on a connection of its own. Sans-I/O: the driver owns the socket, the timer and the
 * store, hands in each event with the time, and performs the returned effects in order.
 */
import { bytesEqual } from "./bytes.ts";
import type { DeviceKeys } from "./device-log.ts";
import { decodeFrame, encodeFrame, type Frame, FrameCutter } from "./frames.ts";
import type { Effect, LinkState, Persist } from "./link-types.ts";
import type { Bytes } from "./platform.ts";
import { type Proof, sessionOf, signProof } from "./proofs.ts";
import { type Kept, type Out, Reading, type Who } from "./reading.ts";
import { Requests } from "./requests.ts";
import { fail, ok, type Result } from "./result.ts";
import { type Outcome, Upload } from "./upload.ts";

export type { Effect, LinkState, Persist } from "./link-types.ts";

export type Enrol = { secret: Bytes; signed: Bytes; sig: Bytes };

// Whether the `enrol` frame can be cut before a proof: a 32-byte secret, a 64-byte signature and entry 0 within the unproven limit.
const framable = (enrol: unknown): boolean => {
  try {
    encodeFrame({ type: "enrol", ...(enrol as Enrol) }, false);
    return true;
  } catch {
    return false;
  }
};

/** What a link is built from: the device, its stored state, and the constants tests shorten. */
export interface LinkOptions {
  who: Who; // `who.platform` holds the device's key under `sign` and draws the nonces
  keys: DeviceKeys; // the public keys an upload proof carries
  sign: string; // the platform's name for the signing key
  kept: Kept;
  stored?: { incarnation?: Bytes; fault?: boolean };
  /**
   * The first device's entry 0 and the relay's enrolment secret: sent before the proof on every connection until the first `served`
   * or a refusal 2 on a connection that carried it (device pairing design 3.5). A value that cannot be framed throws a `RangeError`.
   */
  enrol?: Enrol;
  /** Tests shorten these; the drivers never do. */
  constants?: Partial<{ first: number; max: number; patience: number; ask: number }>;
}

// What a state waits for, when it is not a frame: the hello of a dial.
const WAITS: Partial<Record<LinkState, string>> = { dialing: "hello", hello: "hello" };

type Then = (fx: Effect[], now: number) => void; // what runs with the time of a later call
type Held = { what: Persist; next?: Then };

// What `kept` holds that a store write covers: ids are only appended, and a head is its `n` and chain
// (a signature is never an identifier, crypto.md 4).
const snap = (k: Kept) =>
  `${k.ids.length} ${k.putBack} ${k.head?.head.n} ${k.head?.head.chain.join()}`;

/** The device's connection to the relay: events in with the time, effects out; while a `persist` is held every call but `persisted` and `stop` throws. */
export class Link {
  /** The Reading the link drives, for the driver and its logs to read and never to change. */
  readonly reading: Reading;
  #o: Omit<LinkOptions, "enrol">; // the secret is kept in `#enrol` alone, which `served` empties
  #c: Required<NonNullable<LinkOptions["constants"]>>;
  #s: LinkState = "unstarted";
  #up: Upload | undefined; // the give-back connection while the link is `uploading`
  #conn = 0; // the one current connection; 0 when none
  #count = 0;
  #proven = false; // a proof was sent on it: the frames now decode and encode as proven
  #binding: Bytes = new Uint8Array();
  #enrol: Enrol | undefined; // dropped at the first `served` (entry 0 was placed) or a refusal 2 that followed it
  #carried = false; // the current connection sent it
  #cutter = new FrameCutter();
  // A `persist` waits for `persisted`: no frame is cut meanwhile, and `next` is the rest of the call
  // that emitted it.
  #held: Held | undefined;
  #until = 0; // the stored deadline of a state in FIXED
  #sent = 0; // the last read or proof sent
  #seen = 0; // the last frame received, before rest
  #asked = false; // a keepalive or probe read waits for its `position`
  #delay: number;
  #slow = false; // the last refusal asks again every `ask`
  #reqs: Requests; // the requests in flight, each with its own deadline
  #incarnation: Bytes | undefined; // what the driver's store holds
  #saved: string; // `snap` of the `kept` the driver's store holds
  // A rest was delivered in this run under the incarnation delivered last: the next is not `first`.
  // With `#incarnation`, what the flags of an incarnation or a rest are read from (app data design, 3.4).
  #rested = false;

  constructor(options: LinkOptions) {
    const { enrol, ...rest } = options;
    const { who, kept, stored = {}, constants } = rest;
    if (enrol && !framable(enrol))
      throw new RangeError(
        "enrol: a 32-byte secret, entry 0, and a 64-byte signature in one frame",
      );
    this.#o = rest;
    this.#enrol = enrol;
    this.#c = { first: 1000, max: 60_000, patience: 30_000, ask: 600_000, ...constants };
    this.#delay = this.#c.first;
    this.#reqs = new Requests(this.#c.patience);
    this.#incarnation = stored.incarnation;
    this.#saved = snap(kept);
    this.reading = new Reading(who, kept, stored);
  }

  /** The enrolment secret again, after the relay refused it: the next connection sends it. A value that cannot be framed changes nothing. */
  enrol(value: Enrol): Result<undefined> {
    if (!framable(value)) return fail("bad-input");
    this.#enrol = value;
    return ok(undefined);
  }

  /** Where the link is now. */
  get state(): LinkState {
    return this.#s;
  }

  /** Dials at once, or delivers a stored put-back or fault and dials never. */
  start(now: number): Effect[] {
    const fx = this.#fx();
    if (this.#s !== "unstarted") return this.#finish(fx); // acts once, from the initial state
    const { state } = this.reading;
    if (state === "put-back" || state === "fault") {
      this.#s = state;
      const out: Out = state === "fault" ? { do: state, why: "stored" } : { do: state };
      fx.push({ do: "deliver", out });
    } else this.#dial("active", now, fx);
    return this.#finish(fx);
  }

  /** TLS is up and the relay's key is the pinned one; `binding` is this connection's exporter. */
  opened(conn: number, binding: Bytes, _now: number): Effect[] {
    const fx = this.#fx();
    const up = this.#up;
    if (this.#current(conn) && (up ? !up.open : this.#s === "dialing")) {
      if (up) up.opened(binding);
      else [this.#binding, this.#s] = [binding, "hello"]; // an upload signs with its own binding
    }
    return this.#finish(fx);
  }

  /** Bytes of connection `conn`, cut into frames here; a bad length or frame closes it. */
  received(conn: number, bytes: Bytes, now: number): Effect[] {
    const fx = this.#fx();
    const up = this.#up;
    if (!this.#current(conn) || (up ? !up.open : this.#s === "dialing")) return this.#finish(fx);
    this.#cutter.push(bytes);
    this.#drain(conn, now, fx);
    return this.#finish(fx);
  }

  /**
   * The driver's answer to the last `persist`, which ends its call: the rest of that call and the
   * frames held follow here. `false` drops the connection and the value is emitted again, except a
   * put-back or fault, whose failed write is not: the driver logs it and the link goes on, since the
   * value is final and nothing more is stored for it.
   */
  persisted(ok: boolean, now: number): Effect[] {
    const [fx, held, conn] = [[], this.#held, this.#conn];
    if (!held) return this.#finish(fx); // nothing to answer
    this.#held = undefined;
    // The store holds the value only once written, so a failed write is emitted again.
    if (ok && "incarnation" in held.what) this.#incarnation = held.what.incarnation;
    if (ok) this.#saved = snap(this.reading.kept);
    if (ok || "putBack" in held.what || "fault" in held.what) this.#drain(conn, now, fx, held.next);
    else this.#drop(now, fx, true);
    return this.#finish(fx);
  }

  /** The socket `conn` ended for any reason; a token that is not current is ignored. */
  closed(conn: number, now: number): Effect[] {
    const fx = this.#fx();
    if (this.#current(conn)) this.#end(now, fx, false);
    return this.#finish(fx);
  }

  /** The driver's timer fired; before the earliest deadline it only arms again. */
  tick(now: number): Effect[] {
    const fx = this.#fx();
    // A request deadline that passed closes the link; a tick before every deadline only re-arms, and
    // a state with no deadline (unstarted, final) does nothing.
    if (this.#reqs.late(now).length) this.#end(now, fx, this.#late(now));
    else if (now >= (this.#own() ?? Infinity)) {
      if (this.#s === "waiting") this.#dial("active", now, fx);
      else if (this.#s === "rest" && !this.#asked) this.#ask(now, fx);
      else this.#end(now, fx, this.#late(now));
    }
    return this.#finish(fx);
  }

  /** The network came back (the app only): a dead connection is found in `patience`, a back-off cut short. */
  networkUp(now: number): Effect[] {
    const fx = this.#fx();
    if (this.#s === "waiting" && !this.#slow) this.#dial("active", now, fx);
    else if ((this.#s === "reading" || this.#s === "rest") && !this.#asked) this.#ask(now, fx);
    return this.#finish(fx);
  }

  /**
   * Sends one item at rest and names its request (several may be in flight, each answered by its
   * own `result`), or `busy` when the reading is not at rest; a frame past the limit throws before the request is added, for the driver to pass on.
   */
  submit(
    kind: 1 | 2 | 3 | 4,
    signed: Bytes,
    sig: Bytes,
    now: number,
  ): { request: number; effects: Effect[] } | "busy" {
    const fx = this.#fx();
    if (!this.reading.sendable) return "busy";
    const request = this.#reqs.next;
    this.#send({ type: "submit", request, kind, signed, sig }, fx); // a frame past the limit throws before the request is added
    this.#reqs.add(now);
    return { request, effects: this.#finish(fx) };
  }

  /** Ends the connection and the dialing for good. */
  stop(_now: number): Effect[] {
    if (this.#s === "stopped") return [];
    const fx: Effect[] = [];
    if (this.#conn) fx.push({ do: "close", conn: this.#conn });
    this.#teardown(fx);
    if (this.reading.state !== "giving-back") this.reading.dropped();
    this.#s = "stopped";
    return this.#finish(fx);
  }

  /** Runs `first`, then cuts and handles the frames held, until a `persist` waits or the connection ends. */
  #drain(conn: number, now: number, fx: Effect[], first?: Then): void {
    try {
      first?.(fx, now);
      while (this.#conn === conn && !this.#held) {
        const cut = this.#cutter.next(this.#proven);
        if (cut.ok && !cut.value) break; // not whole yet
        const frame = cut.ok ? decodeFrame(cut.value as Bytes, this.#proven, "device") : cut;
        if (!frame.ok) return void this.#end(now, fx, true);
        if (this.#up) this.#upload(this.#up, frame.value, now, fx);
        else this.#active(frame.value, now, fx);
      }
    } catch (error) {
      // A failed signature or a Reading that throws is a drop, as a socket error is; the driver logs why.
      if (this.#conn === conn)
        this.#end(now, fx, `connection error: ${(error as Error)?.message || "error"}`);
    }
  }

  #dial(purpose: "active" | "upload", now: number, fx: Effect[]): void {
    [this.#conn, this.#proven, this.#carried] = [++this.#count, false, false];
    this.#s = purpose === "upload" ? "uploading" : "dialing";
    this.#until = now + this.#c.patience;
    if (purpose === "upload") {
      const head = this.reading.kept.head as NonNullable<Kept["head"]>;
      this.#up = new Upload({ ...this.#o, head, patience: this.#c.patience }, now);
    }
    fx.push({ do: "dial", conn: this.#conn, purpose });
  }

  /** Whether `conn` is the one current connection; 0 is no connection, before `start` and after `stop` too. */
  #current = (conn: number): boolean => conn > 0 && conn === this.#conn;

  /** The start of every call but `persisted` and `stop`: the driver answers a held `persist` first. */
  #fx(): Effect[] {
    if (this.#held) throw new Error("a persist is held: the driver must answer persisted first");
    return [];
  }

  /** Ends every call that leaves the link live with the `wake` for its earliest deadline. */
  #finish(fx: Effect[]): Effect[] {
    if (this.#held) return fx; // a `persist` ends its call: `persisted` gives the wake
    const at = Math.min(this.#own() ?? Infinity, this.#reqs.deadline ?? Infinity);
    if (at < Infinity) fx.push({ do: "wake", at });
    return fx;
  }

  /** The `why` of the deadline that passed at `now`: what the link was waiting for. */
  #late(now: number): string {
    // An upload waits for the hello until its proof is sent, then for the answer.
    const give = this.#proven ? "answer to the give-back" : "hello";
    const waits = this.#reqs.late(now).length
      ? "answer to a request"
      : ((this.#up ? give : WAITS[this.#s]) ?? "frame");
    return `no ${waits} for ${this.#c.patience / 1000} s, connection dropped`;
  }

  /** The connection deadline of the state (4.2). */
  #own(): number | undefined {
    const { patience, ask } = this.#c;
    if (this.#up) return this.#up.deadline;
    // These states hold one stored instant; the others compute theirs from the frames.
    if (["waiting", "dialing", "hello"].includes(this.#s)) return this.#until;
    // The relay's limit counts what the device sends (RD 4.6): a read is due `ask` after the last
    // frame sent, however many arrived; before rest, or with a read unanswered, silence is `patience`.
    if (this.#s === "rest") return this.#sent + (this.#asked ? patience : ask);
    if (this.#s === "proving" || this.#s === "reading")
      return Math.max(this.#seen, this.#asked ? this.#sent : 0) + patience;
    return undefined;
  }

  #send(frame: Frame, fx: Effect[]): void {
    const bytes = encodeFrame(frame, this.#proven);
    if (frame.type.startsWith("prove-")) this.#proven = true;
    fx.push({ do: "send", conn: this.#conn, bytes });
  }

  // A read the relay answers with a `position`, which `patience` waits for.
  #ask(now: number, fx: Effect[]): void {
    this.#send({ type: "read", from: this.reading.cursor }, fx);
    [this.#sent, this.#asked] = [now, true];
  }

  /** The proof, as soon as `hello` came: it binds this connection's binding. */
  #prove(relayNonce: Bytes, now: number, fx: Effect[]): void {
    const { who, sign } = this.#o;
    const session = sessionOf(who.platform, who.relay, relayNonce, this.#binding);
    // The relay never answers `enrol`: the proof that follows says whether entry 0 was placed.
    if (this.#enrol) this.#send({ type: "enrol", ...this.#enrol }, fx);
    this.#carried = !!this.#enrol;
    const proof: Proof = { ...session, kind: "active", person: who.person, device: who.self };
    this.#send({ type: "prove-active", proof, sig: signProof(who.platform, sign, proof) }, fx);
    this.#s = "proving";
    [this.#sent, this.#seen, this.#asked] = [now, now, false];
  }

  #active(f: Frame, now: number, fx: Effect[]): void {
    const r = this.reading;
    if (this.#s === "hello" && f.type === "hello") return void this.#prove(f.relayNonce, now, fx);
    this.#seen = now;
    if (f.type === "served" && this.#enrol) {
      this.#enrol = undefined;
      fx.push({ do: "enrolled" });
    }
    if (f.type === "result" && this.#reqs.answer(f.request))
      fx.push({ do: "answer", request: f.request, code: f.code });
    if (f.type === "position") this.#asked = false;
    this.#perform(r.take(f), now, fx, (later, at) => {
      if (r.state !== "reading" && r.state !== "rest") this.#end(at, later, true);
      else if (this.#s !== "proving" || f.type === "served") this.#s = r.state;
    });
  }

  /** Acts on `outs` in order, then `done`; a `persist` ends the list, and the rest runs once it is stored. */
  #perform(outs: Out[], now: number, fx: Effect[], done: Then): void {
    for (const [i, raw] of outs.entries()) {
      const out = this.#settle(raw);
      if (!this.#act(out, now, fx)) continue;
      (this.#held as Held).next = (later, at) => {
        if (out.do === "rest") [this.#delay, this.#slow] = [this.#c.first, false]; // the write held
        later.push(this.#deliver(out));
        this.#perform(outs.slice(i + 1), at, later, done);
      };
      return;
    }
    done(fx, now);
  }

  /** The upload's frames to send, or its end: the Reading hears the outcome in `#end`. */
  #upload(up: Upload, f: Frame, now: number, fx: Effect[]): void {
    const step = up.frame(f, now);
    if (step && "send" in step) for (const g of step.send) this.#send(g, fx);
    else if (step) this.#end(now, fx, true, step.done);
  }

  /**
   * An incarnation's or a rest's flags, read from what the store confirmed and what was delivered rather
   * than from the Reading, which moves before the write: a failed write leaves them as they were.
   */
  #settle(out: Out): Out {
    const stored = this.#incarnation;
    if (out.do === "incarnation")
      return {
        ...out,
        first: stored === undefined,
        // The Reading's own `changed` too: it rewound, though the relay serves again what the store holds.
        changed: stored !== undefined && (out.changed || !bytesEqual(stored, out.incarnation)),
      };
    if (out.do === "rest") return { ...out, first: !this.#rested };
    return out;
  }

  /** The deliver of `out`, once nothing is left to store for it. */
  #deliver(out: Out): Effect {
    if (out.do === "incarnation" && (out.first || out.changed)) this.#rested = false;
    if (out.do === "rest") this.#rested = true;
    return { do: "deliver", out };
  }

  /** Acts on one output; true when it emitted a `persist`, whose `deliver` waits for the write. */
  #act(out: Out, now: number, fx: Effect[]): boolean {
    switch (out.do) {
      case "read":
        this.#send({ type: "read", from: out.from }, fx);
        [this.#sent, this.#asked] = [now, true]; // its `position` is awaited as a probe's is
        return false;
      case "give-back": // `#end` dials the upload
        return false;
      case "incarnation":
        if (bytesEqual(this.#incarnation ?? new Uint8Array(), out.incarnation)) break;
        return this.#persist({ incarnation: out.incarnation }, fx);
      case "rest": {
        const k = this.reading.kept;
        if (snap(k) !== this.#saved)
          return this.#persist({ kept: { ...k, ids: k.ids.slice() } }, fx);
        [this.#delay, this.#slow] = [this.#c.first, false];
        break;
      }
      case "refused":
        this.#slow = [1, 5].includes(out.reason) || (out.reason === 2 && !!this.reading.kept.head);
        // The secret did not hold (3.5): sent again on the back-off it would earn a ban, so the app is asked for it.
        if (out.reason === 2 && this.#carried) {
          [this.#enrol, this.#carried] = [undefined, false];
          fx.push({ do: "enrol-refused" });
        }
        break;
      case "put-back":
      case "fault":
        return this.#persist(out.do === "fault" ? { fault: true } : { putBack: true }, fx);
    }
    fx.push(this.#deliver(out));
    return false;
  }

  #persist(what: Persist, fx: Effect[]): true {
    this.#held = { what };
    fx.push({ do: "persist", what });
    return true;
  }

  /** Everything a drop does (2.1, 9), and the upload's end (10); `close` is true, or the reason, to close the socket too. */
  #end(now: number, fx: Effect[], close: boolean | string, outcome?: Outcome): void {
    // An upload connection ends with its answer: the Reading hears it before the wait is chosen.
    if (outcome?.slow) [this.#slow, close] = [true, `give-back refused, reason ${outcome.refusal}`];
    const outs = this.#up ? this.reading.gaveBack(outcome?.code, outcome?.refusal) : [];
    this.#perform(outs, now, fx, (later, at) => this.#drop(at, later, close));
  }

  /** Answers, tells the Reading, then dials the upload, stops, or waits. */
  #drop(now: number, fx: Effect[], close: boolean | string): void {
    const r = this.reading;
    if (close)
      fx.push({ do: "close", conn: this.#conn, ...(close === true ? {} : { why: close }) });
    this.#teardown(fx);
    if (r.state !== "giving-back") r.dropped();
    if (r.state === "put-back" || r.state === "fault") this.#s = r.state;
    else if (r.state === "giving-back") this.#dial("upload", now, fx);
    else {
      const wait = this.#slow ? this.#c.ask : this.#delay;
      if (!this.#slow) this.#delay = Math.min(this.#delay * 2, this.#c.max);
      [this.#s, this.#until] = ["waiting", now + wait];
    }
  }

  // A request in flight is answered once, whatever ended the connection (4.4, 6).
  #teardown(fx: Effect[]): void {
    for (const request of this.#reqs.clear())
      fx.push({ do: "answer", request, code: "unanswered" });
    [this.#conn, this.#held, this.#up] = [0, undefined, undefined];
    this.#cutter.reset();
  }
}
