/**
 * The device's connection to the relay as a pure state machine (step 6.3 design, 4), the policy the
 * daemon and the app share: the order of frames, the deadlines, the back-off, the refusal rules and
 * the give-back on a connection of its own. Sans-I/O: the driver owns the socket, the timer and the
 * store, hands in each event with the time, and performs the returned effects in order.
 */
import { bytesEqual, isBytes } from "./bytes.ts";
import type { DeviceKeys } from "./device-log.ts";
import type { HistorySeal } from "./epochs.ts";
import { decodeFrame, encodeFrame, type Frame, FrameCutter } from "./frames.ts";
import type { Effect, LinkState, Persist } from "./link-types.ts";
import type { Bytes } from "./platform.ts";
import { type Proof, sessionOf, signProof } from "./proofs.ts";
import { type Kept, type Out, Reading, type Who } from "./reading.ts";
import { type RecoverOptions, Recovery, shapedRecover } from "./recover.ts";
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
  /**
   * A recovery (recovery design 2.3): without `reset` the link reads the device log on a recovery connection, tells it and stops;
   * with one every connection tries `prove-active` first, and a refusal that is not a removal sends the reset on a recovery connection
   * of its own, until the first `served` (see `RecoverOptions`).
   */
  recover?: RecoverOptions;
  /** Tests shorten these; the drivers never do. */
  constants?: Partial<{ first: number; max: number; patience: number; ask: number }>;
}

// What a state waits for, when it is not a frame: the hello of a dial.
const WAITS: Partial<Record<LinkState, string>> = { dialing: "hello", hello: "hello" };

type Then = (fx: Effect[], now: number) => void; // what runs with the time of a later call
type Held = { what: Persist; next?: Then };

/** A put or a get of the link: `handle` is what the driver knows it by, `wire` the request of the attempt in flight, `at` the bytes sent or received. */
type Transfer = { handle: number; blob: Bytes; wire?: number | undefined; at: number };
type Put = Transfer & { bytes: Bytes };
type Get = Transfer & { size: number }; // the size the signed body declared: no frame may say another

const CHUNK = 524_288; // the relay's own: a put-blob chunk and a blob frame (relay `blobs.ts`)
const REFUSED = 1; // the relay's `refused` result code, for a get the link ends itself

// What `kept` holds that a store write covers: ids are only appended, and a head is its `n` and chain
// (a signature is never an identifier, crypto.md 4).
const snap = (k: Kept) =>
  `${k.ids.length} ${k.putBack} ${k.head?.head.n} ${k.head?.head.chain.join()}`;

/** The device's connection to the relay: events in with the time, effects out; while a `persist` is held every call but `persisted` and `stop` throws. */
export class Link {
  /** The Reading the link drives, for the driver and its logs to read and never to change. */
  readonly reading: Reading;
  #o: Omit<LinkOptions, "enrol" | "recover">; // the secret is kept in `#enrol` alone, which `served` empties
  #c: Required<NonNullable<LinkOptions["constants"]>>;
  #s: LinkState = "unstarted";
  #up: Upload | Recovery | undefined; // the give-back or recovery connection while the link is `uploading` or `recovering`
  #conn = 0; // the one current connection; 0 when none
  #count = 0;
  #proven = false; // a proof was sent on it: the frames now decode and encode as proven
  #binding: Bytes = new Uint8Array();
  #enrolled = false; // the link told `enrolled`: the setter takes nothing more
  #enrol: Enrol | undefined; // dropped at the first `served` (entry 0 was placed) or a refusal 2 that followed it
  #carried = false; // the current connection sent it
  #recover: RecoverOptions | undefined; // dropped at the first `served` of a reset recovery
  #next: "active" | "recover" = "active"; // the purpose of the next dial: a reading recovery stays on `recover`, a reset one goes there only after a refusal
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
  #puts: Put[] = []; // one at a time on the wire (the relay refuses another while one is written): the first is the one sending
  #gets: Get[] = [];
  #paced = 0; // chunks sent on this connection whose write the driver has not reported
  #incarnation: Bytes | undefined; // what the driver's store holds
  #saved: string; // `snap` of the `kept` the driver's store holds
  // A rest was delivered in this run under the incarnation delivered last: the next is not `first`.
  // With `#incarnation`, what the flags of an incarnation or a rest are read from (app data design, 3.4).
  #rested = false;

  constructor(options: LinkOptions) {
    const { enrol, recover, ...rest } = options;
    const { who, kept, stored = {}, constants } = rest;
    if (enrol && !framable(enrol))
      throw new RangeError(
        "enrol: a 32-byte secret, entry 0, and a 64-byte signature in one frame",
      );
    this.#o = rest;
    this.#enrol = enrol;
    if (recover && !this.recover(recover).ok)
      throw new RangeError("recover: a key id, a proof and keys of their lengths");
    this.#c = { first: 1000, max: 60_000, patience: 30_000, ask: 600_000, ...constants };
    this.#delay = this.#c.first;
    this.#reqs = new Requests(this.#c.patience);
    this.#incarnation = stored.incarnation;
    this.#saved = snap(kept);
    this.reading = new Reading(who, kept, stored);
  }

  /** The enrolment secret again, after the relay refused it: the next connection sends it. A value that cannot be framed changes nothing, and neither does one after the link told `enrolled`: entry 0 is placed. */
  enrol(value: Enrol): Result<undefined> {
    if (this.#enrolled || !framable(value)) return fail("bad-input");
    this.#enrol = value;
    return ok(undefined);
  }

  /** A recovery for a link not yet started, as the option gives it; `bad-input` once the link started. */
  recover(value: RecoverOptions): Result<undefined> {
    if (this.#s !== "unstarted" || !shapedRecover(value)) return fail("bad-input");
    [this.#recover, this.#next] = [value, value.reset ? "active" : "recover"];
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
      [this.#s] = [state, this.#abandon(fx)]; // a put or a get queued before the start is never sent
      const out: Out = state === "fault" ? { do: state, why: "stored" } : { do: state };
      fx.push({ do: "deliver", out });
    } else this.#dial(this.#next, now, fx);
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
      if (this.#s === "waiting") this.#dial(this.#next, now, fx);
      else if (this.#s === "rest" && !this.#asked) this.#ask(now, fx);
      else this.#end(now, fx, this.#late(now));
    }
    return this.#finish(fx);
  }

  /** The network came back (the app only): a dead connection is found in `patience`, a back-off cut short. */
  networkUp(now: number): Effect[] {
    const fx = this.#fx();
    if (this.#s === "waiting" && !this.#slow) this.#dial(this.#next, now, fx);
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
    return this.#request((request) => ({ type: "submit", request, kind, signed, sig }), now);
  }

  /** Gives the relay a history seal this device made (security design 5.3, step 6), as `submit` sends an item: its `result` code answers it, `busy` when the reading is not at rest. */
  giveSeal(
    seal: HistorySeal,
    sig: Bytes,
    now: number,
  ): { request: number; effects: Effect[] } | "busy" {
    return this.#request((request) => ({ type: "give-seal", request, seal, sig }), now);
  }

  #request(
    frame: (request: number) => Frame,
    now: number,
  ): { request: number; effects: Effect[] } | "busy" {
    const fx = this.#fx();
    if (!this.reading.sendable) return "busy";
    const request = this.#reqs.next;
    this.#send(frame(request), fx); // a frame past the limit throws before the request is added
    this.#reqs.add(now);
    return { request, effects: this.#finish(fx) };
  }

  /**
   * Puts a blob in chunks of 512 KiB, one at a time on the connection, and names the put by `request`: its `answer` is the relay's code, or
   * `unanswered` once the link is final. The put is a request from its first chunk, so an early answer (a blob the relay holds, a refusal) ends
   * it; the next chunk goes when the driver reports the last `paced` send written (`written`). A drop starts the put again on the next
   * connection. `busy` once the link is final, `bad-input` for a blob id that is not 32 bytes.
   */
  putBlob(
    blob: Bytes,
    bytes: Bytes,
    now: number,
  ): { request: number; effects: Effect[] } | "busy" | "bad-input" {
    const fx = this.#fx();
    if (!isBytes(blob) || blob.length !== 32 || !isBytes(bytes)) return "bad-input"; // a frame that cannot be cut would throw at each rest
    if (this.#final()) return "busy";
    const request = this.#reqs.reserve();
    this.#puts.push({ handle: request, blob, bytes, at: 0 });
    this.#pump(now, fx);
    return { request, effects: this.#finish(fx) };
  }

  /**
   * Fetches a blob of `size` bytes (the sealed size the signed body declares) from offset 0: the relay streams it to its end and answers only a refusal, so the get is no request waiting for a
   * `result`. Each frame is a `blob` effect in order; the `answer` (code 0) follows the last, or carries the refusal. A drop asks again
   * from the last offset received on the next connection. A frame that says another size ends the get as `refused` and drops the connection. `busy` once the link is final, `bad-input` for a blob id that is not 32 bytes.
   */
  getBlob(
    blob: Bytes,
    size: number,
    now: number,
  ): { request: number; effects: Effect[] } | "busy" | "bad-input" {
    const fx = this.#fx();
    if (!isBytes(blob) || blob.length !== 32 || !Number.isSafeInteger(size) || size < 0)
      return "bad-input";
    if (this.#final()) return "busy";
    const request = this.#reqs.reserve();
    this.#gets.push({ handle: request, blob, at: 0, size });
    this.#pump(now, fx);
    return { request, effects: this.#finish(fx) };
  }

  /** The driver wrote out a `paced` send of connection `conn`: the put's next chunk goes once none is left unwritten, and its last starts the put's deadline. */
  written(conn: number, now: number): Effect[] {
    const fx = this.#fx();
    if (this.#current(conn)) this.#paced = Math.max(0, this.#paced - 1);
    if (this.#current(conn) && this.#paced === 0) {
      const put = this.#puts[0];
      if (put?.wire !== undefined && put.at < put.bytes.length) this.#chunk(put, fx);
      else if (put?.wire !== undefined) this.#reqs.due(put.wire, now);
    }
    return this.#finish(fx);
  }

  /** Ends the connection and the dialing for good. */
  stop(_now: number): Effect[] {
    if (this.#s === "stopped") return [];
    const fx: Effect[] = [];
    if (this.#conn) fx.push({ do: "close", conn: this.#conn });
    this.#teardown(fx);
    this.#abandon(fx);
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

  #dial(purpose: "active" | "upload" | "recover", now: number, fx: Effect[]): void {
    [this.#conn, this.#proven, this.#carried] = [++this.#count, false, false];
    this.#s = { active: "dialing", upload: "uploading", recover: "recovering" }[
      purpose
    ] as LinkState;
    this.#until = now + this.#c.patience;
    if (purpose === "upload") {
      const head = this.reading.kept.head as NonNullable<Kept["head"]>;
      this.#up = new Upload({ ...this.#o, head, patience: this.#c.patience }, now);
    }
    if (purpose === "recover") {
      this.#up = new Recovery(
        { ...this.#o, ...(this.#recover as RecoverOptions), patience: this.#c.patience },
        now,
      );
      if (this.#recover?.reset) this.#next = "active"; // whatever ends it, the next connection tries `prove-active` again
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
    // An upload or a recovery waits for the hello until its proof is sent, then for the answer.
    const give = this.#proven
      ? `answer to the ${this.#s === "recovering" ? "recovery" : "give-back"}`
      : "hello";
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

  #send(frame: Frame, fx: Effect[], paced = false): void {
    const bytes = encodeFrame(frame, this.#proven);
    if (frame.type.startsWith("prove-")) this.#proven = true;
    fx.push({ do: "send", conn: this.#conn, bytes, ...(paced && { paced }) });
  }

  #final = (): boolean => ["stopped", "put-back", "fault"].includes(this.#s);

  /** Starts the first put and every get not in flight, once the reading is at rest. */
  #pump(now: number, fx: Effect[]): void {
    if (!this.#conn || !this.reading.sendable) return;
    const put = this.#puts[0];
    if (put && put.wire === undefined) {
      put.wire = this.#reqs.add(now, true); // no deadline until its last chunk is written out
      this.#chunk(put, fx);
    }
    for (const get of this.#gets) {
      if (get.wire !== undefined) continue;
      get.wire = this.#reqs.add(now, true); // a stream has no deadline, and its id is not given to another request
      this.#send({ type: "get-blob", request: get.wire, blob: get.blob, offset: get.at }, fx);
    }
  }

  #chunk(put: Put, fx: Effect[]): void {
    const chunk = put.bytes.subarray(put.at, put.at + CHUNK);
    const frame = {
      type: "put-blob",
      request: put.wire as number,
      blob: put.blob,
      size: put.bytes.length,
      offset: put.at,
      chunk,
    } as const;
    this.#send(frame, fx, true);
    [put.at, this.#paced] = [put.at + chunk.length, this.#paced + 1];
  }

  /** A `result` or `blob` frame of a put or a get: whether it was one's, and what it ends. */
  #transfer(f: Frame, now: number, fx: Effect[]): boolean {
    if (f.type !== "result" && f.type !== "blob") return false;
    const put = this.#puts[0];
    if (put?.wire === f.request && f.type === "result") {
      this.#puts.shift();
      this.#reqs.answer(f.request);
      fx.push({ do: "answer", request: put.handle, code: f.code });
      this.#pump(now, fx); // the next put
      return true;
    }
    const get = this.#gets.find((g) => g.wire === f.request);
    if (!get) return false;
    const end = (code: number) => {
      this.#gets.splice(this.#gets.indexOf(get), 1);
      this.#reqs.answer(f.request);
      fx.push({ do: "answer", request: get.handle, code });
    };
    if (f.type === "result") {
      end(f.code);
      return true;
    }
    // In order, one size, and a frame that moves: what the relay never sends is a drop, and the get goes on from `at`.
    const { size, offset, chunk } = f;
    if (size !== get.size) {
      end(REFUSED); // a relay that streams more than the body declared is not buffered
      throw new Error("a blob frame of another size");
    }
    if (offset !== get.at || offset + chunk.length > size || (!chunk.length && offset < size))
      throw new Error("a blob frame out of order");
    get.at = offset + chunk.length;
    fx.push({ do: "blob", request: get.handle, size, offset, chunk });
    if (get.at >= size) end(0);
    return true;
  }

  /** The puts and gets answered `unanswered`, for a link that will not dial again. */
  #abandon(fx: Effect[]): void {
    for (const { handle } of [...this.#puts, ...this.#gets])
      fx.push({ do: "answer", request: handle, code: "unanswered" });
    [this.#puts, this.#gets] = [[], []];
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
    if (f.type === "served" && this.#recover?.reset) {
      this.#recover = undefined; // the reset is in the log: an ordinary link from here
      fx.push({ do: "recovered" });
    }
    if (f.type === "served" && this.#enrol) {
      this.#enrol = undefined;
      this.#enrolled = true;
      fx.push({ do: "enrolled" });
    }
    if (!this.#transfer(f, now, fx) && f.type === "result" && this.#reqs.answer(f.request))
      fx.push({ do: "answer", request: f.request, code: f.code });
    if (f.type === "position") this.#asked = false;
    this.#perform(r.take(f), now, fx, (later, at) => {
      if (r.state !== "reading" && r.state !== "rest") this.#end(at, later, true);
      else {
        if (this.#s !== "proving" || f.type === "served") this.#s = r.state;
        this.#pump(at, later);
      }
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
  #upload(up: Upload | Recovery, f: Frame, now: number, fx: Effect[]): void {
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
        // Not a removal: the device is not in the log yet, or the reset is what the relay still waits for.
        if (this.#recover?.reset && out.reason !== 1) this.#next = "recover";
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
    const { recovery } = outcome ?? {};
    if (outcome?.slow)
      [this.#slow, close] = [
        true,
        recovery ? "recovery refused" : `give-back refused, reason ${outcome.refusal}`,
      ];
    const outs = this.#up ? this.reading.gaveBack(outcome?.code, outcome?.refusal) : [];
    if (recovery) fx.push({ do: "recovery", outcome: recovery });
    // Retrying cannot change the log of a reading, a refusal 2 or 3 or a fault: the link ends. A refusal 6 puts the relay back, as on the active path.
    const refused = recovery && "refused" in recovery ? recovery.refused : 0;
    if (refused === 6) outs.push(...this.reading.take({ type: "refused", reason: 6 }));
    if (recovery && ("log" in recovery || "fault" in recovery || refused === 2 || refused === 3))
      fx.push(...this.stop(now));
    else this.#perform(outs, now, fx, (later, at) => this.#drop(at, later, close));
  }

  /** Answers, tells the Reading, then dials the upload, stops, or waits. */
  #drop(now: number, fx: Effect[], close: boolean | string): void {
    const r = this.reading;
    if (close)
      fx.push({ do: "close", conn: this.#conn, ...(close === true ? {} : { why: close }) });
    this.#teardown(fx);
    if (r.state !== "giving-back") r.dropped();
    if (r.state === "put-back" || r.state === "fault") [this.#s] = [r.state, this.#abandon(fx)];
    else if (r.state === "giving-back") this.#dial("upload", now, fx);
    else {
      const wait = this.#slow ? this.#c.ask : this.#delay;
      if (!this.#slow) this.#delay = Math.min(this.#delay * 2, this.#c.max);
      [this.#s, this.#until] = ["waiting", now + wait];
    }
  }

  // A request in flight is answered once, whatever ended the connection (4.4, 6); a put or a get is not one's: it starts again on the next.
  #teardown(fx: Effect[]): void {
    const wires = new Set([...this.#puts, ...this.#gets].map((t) => t.wire));
    for (const request of this.#reqs.clear())
      if (!wires.has(request)) fx.push({ do: "answer", request, code: "unanswered" });
    for (const t of [...this.#puts, ...this.#gets])
      [t.wire, t.at] = [undefined, "bytes" in t ? 0 : t.at];
    this.#paced = 0;
    [this.#conn, this.#held, this.#up] = [0, undefined, undefined];
    this.#cutter.reset();
  }
}
