/**
 * Design 6.2, 6.3, 4.5 and 3.7: what a served connection's requests do. A frame is evaluated by the
 * sequence in the model's order and answered once its round is on disk, after the directory was
 * checked again (rule 11); a `read` stays open, and each round that completes pushes what it put on
 * disk to the connections that follow, after the connections of the devices it removed are told.
 * Everything is sent through the connection's outbox (4.5). Nothing is sent once the relay decided to
 * fail closed (6.5) or stopped (3.7): `silent` is the session's.
 */

import { bytesEqual } from "../protocol/bytes.ts";
import { decodeHistorySeal, encodeHistorySeal } from "../protocol/epochs.ts";
import { encodeFrame, type Frame } from "../protocol/frames.ts";
import type { Bytes } from "../protocol/platform.ts";
import { Outbox } from "./outbox.ts";
import type { Serving } from "./proofs.ts";
import { Code, type Conn } from "./sequence.ts";
import type { Peer } from "./server.ts";

/** Seals in one `seals` frame: it stays under the limit of 1 MiB whatever the count (PD 6.7). */
const SEALS_MAX = 256;
/** What one `log` frame holds of entries, under the 1 MiB of a frame whatever its other fields (PD 6.7). */
const LOG_BYTES = (1 << 20) - 64;
/** The bytes an entry takes in a `log` frame beside its signed bytes: their length and the signature. */
const ENTRY_EXTRA = 4 + 64;
/** A connection with more answers than this waiting for their round is paused, and resumed at the lower bound (4.5). */
const WAITING_MAX = 64;
const WAITING_RESUME = 32;
/** Under this size a `submit` is far from the limit of the `item` frame that gives it back. */
const LARGE = 1 << 19;
type ResultCode = Extract<Frame, { type: "result" }>["code"];

/** What a connection does with the frames after its proof; `frame` returns false when the connection is over. */
export interface Handler {
  frame(frame: Frame): boolean;
  closed(): void;
}

export interface RequestsDeps {
  serving: Serving;
  /** The relay says nothing more: it is deciding to fail closed, has failed closed, or stopped. */
  silent: () => boolean;
  /** The devices a completed round removed: their connections are told and closed (6.1). */
  removed: (devices: Bytes[]) => void;
  /** Rule 11 (3.7): false when the directory changed under the relay, which then closes every connection and stops with 75. */
  unchanged: () => boolean;
  /** An error nothing expected: the relay stops with 75 and says so in its log (2.4). */
  fail: (error: unknown) => void;
}

/** A connection's follow: where it is in the sequence, and whether a pass is writing for it. */
interface Follow {
  out: Outbox;
  conn: Conn;
  cursor: number;
  /** How many of the seals on disk it has been given. */
  seals: number;
  /** The `position` frame of the read that started it is not sent yet. */
  starting: boolean;
  /** A pass is queued or running. */
  passing: boolean;
  /** A round completed while it was passing: another pass follows. */
  again: boolean;
  live: boolean;
}

/** An `item` is a `submit` and 4 bytes more (PD 6.7): a submit whose item would pass the frame limit is placed nowhere. */
function itemFits(f: Extract<Frame, { type: "submit" }>): boolean {
  if (f.signed.length < LARGE) return true;
  try {
    encodeFrame({ type: "item", position: 0, kind: f.kind, signed: f.signed, sig: f.sig }, true);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

export class Requests {
  #d: RequestsDeps;
  #follows = new Set<Follow>();
  /** Removals placed and not yet on disk, in ticket order. */
  #removals: { ticket: number; devices: Bytes[] }[] = [];

  constructor(deps: RequestsDeps) {
    this.#d = deps;
    deps.serving.rounds.onRound = () => this.#guard(() => this.#settle());
  }

  /** The requests of a connection that proved itself as `conn`; a recovery's may only submit its one reset. */
  open(peer: Peer, conn: Conn, kind: "active" | "recovery"): Handler {
    const s = this.#d.serving;
    const out = new Outbox(peer, this.#d.silent, this.#d.fail);
    const blobs = s.blobs.session();
    let waiting = 0;
    let paused = false;
    let submitted = false;
    // The connection's own reset is on the sequence: the key it replaced is no reason to refuse its log.
    let resetPlaced = false;
    let logged = false;
    let follow: Follow | undefined;
    // An answer is built once its ticket is on disk and the socket has room, after rule 11 looked at
    // the directory again; the outbox builds none once the relay went silent (6.5) or the connection closed.
    const answer = <T>(ready: Promise<T>, build: (value: T) => void) => {
      if (++waiting > WAITING_MAX && !paused) {
        paused = true;
        peer.pause();
      }
      ready
        .then((value) =>
          out.answer(() => {
            waiting--;
            if (paused && waiting <= WAITING_RESUME) {
              paused = false;
              peer.resume();
            }
            if (this.#d.unchanged()) build(value);
          }),
        )
        .catch(this.#d.fail);
    };
    const after = (ticket: number) => s.rounds.wait(ticket);
    const reply = (request: number, code: number) =>
      out.send({ type: "result", request, code: code as ResultCode });
    // A refusal that rests on the state in memory waits for what is written now (3.6).
    const settled = async (code: number) => {
      if (code !== 0) await after(s.rounds.written);
      return code;
    };
    // A get: a chunk per step while the socket takes them (4.5), a `result` when the blob is not given.
    const chunks = function* (request: number, blob: Bytes, from: number): Generator<void> {
      for (let offset = from; ; ) {
        const got = s.blobs.get(conn, blob, offset);
        if (got.code !== 0) return answer(settled(got.code), (code) => reply(request, code));
        const { size, chunk } = got as { size: number; chunk: Bytes };
        out.send({ type: "blob", request, size, offset, chunk });
        offset += chunk.length;
        if (offset >= size) return;
        yield;
      }
    };
    // A recovery log: the device log in as many `log` frames as it takes, in order, each whole, and a
    // `result` with the request id and code 0 that closes them (PD 6.7). The entries are read as each
    // frame is built. The key may have been replaced since the proof by a reset that is on disk, and not
    // by the connection's own: then the log is no longer the connection's (the model's `recoveryLog`).
    const log = function* (request: number): Generator<void> {
      const current = s.seq.recoveryOnDisk(conn.person);
      if (!resetPlaced && (!current || !conn.recovery || !bytesEqual(current, conn.recovery))) {
        out.end({ type: "refused", reason: 3 });
        return;
      }
      const entries = (s.seq.recoveryLog(conn.person) ?? [])[Symbol.iterator]();
      let next = entries.next();
      do {
        // At least one entry to a frame, so that the list ends.
        const frame: { signed: Bytes; sig: Bytes }[] = [];
        for (let bytes = 0; !next.done; next = entries.next()) {
          bytes += next.value.signed.length + ENTRY_EXTRA;
          if (frame.length > 0 && bytes > LOG_BYTES) break;
          frame.push(next.value);
        }
        out.send({ type: "log", request, entries: frame });
        yield;
      } while (!next.done);
      out.send({ type: "result", request, code: 0 });
    };
    const stop = () => {
      if (follow) follow.live = false;
      if (follow) this.#follows.delete(follow);
    };
    /** A device the log names and no longer holds as active: its submit is answered 5 before its size is looked at (6.2). */
    const removed = () => {
      const standing = s.seq.standing(conn.person, conn.device);
      return standing?.device !== undefined && !standing.active;
    };
    const evaluate = (f: Frame): boolean => {
      // A chunk of a put is no answer: rule 11 looks at the directory before the one it ends with (3.7).
      if (f.type !== "put-blob" && !this.#d.unchanged()) return false;
      if (f.type === "submit" && (kind === "active" || (!submitted && f.kind === 1))) {
        submitted = true;
        const placed =
          itemFits(f) || removed()
            ? s.seq.submit(conn, f.kind, f.signed, f.sig)
            : { code: Code.tooLarge, ticket: 0, removed: [] };
        if (placed.removed.length > 0)
          this.#removals.push({ ticket: placed.ticket, devices: placed.removed });
        if (kind === "recovery" && placed.code === Code.accepted) resetPlaced = true;
        const result: Frame = {
          type: "result",
          request: f.request,
          code: placed.code as ResultCode,
        };
        answer(after(placed.ticket), () =>
          kind === "recovery" ? out.end(result) : out.send(result),
        );
      } else if (kind === "active" && f.type === "read") {
        const read = f;
        answer(after(s.rounds.written), () => {
          // A removed device gets no follow: the fetch finds it removed, and the round that placed
          // its removal tells it (6.3, step 2).
          stop();
          follow = {
            out,
            conn,
            cursor: read.from,
            seals: 0,
            starting: true,
            passing: false,
            again: false,
            live: true,
          };
          this.#follows.add(follow);
          // The removals this round covers are told first (C4): its settle, a microtask away, then
          // gives every follower its pass, this one included. Else this follow alone is given its.
          if (!this.#removalsDue()) this.#kick(follow);
        });
      } else if (kind === "active" && f.type === "give-seal") {
        const given = s.seals.give(conn, encodeHistorySeal(f.seal), f.sig);
        answer(after(given.ticket), () => reply(f.request, given.code));
      } else if (kind === "recovery" && f.type === "recovery-log" && !logged) {
        const asked = f;
        // One log to a recovery connection (4.6): each asks for the whole device log.
        logged = true;
        // What the recovery reads is what is on disk: its answer waits for the writes so far (3.6).
        answer(after(s.rounds.written), () => out.stream(log(asked.request)));
      } else if (kind === "active" && f.type === "put-blob") {
        const put = s.blobs.put(conn, blobs, f.blob, f.size, f.offset, f.chunk);
        if (put === null) return true;
        if ("done" in put) answer(put.done.then(settled), (code) => reply(f.request, code));
        else answer(after(put.ticket), () => reply(f.request, put.code));
      } else if (kind === "active" && f.type === "get-blob") {
        const get = f;
        // The bytes are given only from a state a restart keeps: a blob's names wait for the next round (3.6).
        answer(after(s.rounds.written), () =>
          out.stream(chunks(get.request, get.blob, get.offset)),
        );
      } else {
        peer.close();
        return false;
      }
      return true;
    };
    return {
      closed: () => {
        out.close();
        s.blobs.closeSession(blobs);
        stop();
      },
      frame: evaluate,
    };
  }

  /** What runs on a round's completion must not throw out of it: the relay stops with 75. */
  #guard(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.#d.fail(error);
    }
  }

  /** Design 6.3, in its order: the removals the disk covers are told and closed and the blobs the round made unwanted removed, then each follower is given what is new. */
  #settle(): void {
    const { rounds } = this.#d.serving;
    if (this.#d.silent() || rounds.failed || !this.#d.unchanged()) return;
    const { blobs } = this.#d.serving;
    while (this.#removals[0] && this.#removals[0].ticket <= rounds.synced) {
      const { devices } = this.#removals.shift() as { devices: Bytes[] };
      this.#d.removed(devices);
      blobs.dropRemoved(devices);
    }
    blobs.sweep();
    for (const f of this.#follows) this.#kick(f);
  }

  /** Whether a round has completed that covers a removal not yet told. */
  #removalsDue(): boolean {
    const [next] = this.#removals;
    return next !== undefined && next.ticket <= this.#d.serving.rounds.synced;
  }

  #kick(f: Follow): void {
    if (f.passing) f.again = true;
    else {
      f.passing = true;
      f.out.stream(this.#pass(f));
    }
  }

  /**
   * One frame per step while the socket takes them (4.5): the position and the seals of a read, the
   * seals added since, then each item up to what is on disk and the head that ends them. A peer that
   * does not read holds the frame that filled its socket, not the sequence. A new read replaces the
   * follow while the socket holds a slice: its run ends after the frame it was held at.
   */
  *#pass(f: Follow): Generator<void> {
    const { seq, seals, journal, incarnation } = this.#d.serving;
    try {
      do {
        f.again = false;
        // Nothing is read, and no head signed, for a follower that has nothing new (C6).
        const more = seals.since(f.conn, f.seals);
        if (!f.starting && journal.durable <= f.cursor && more.length === 0) return;
        const got = seq.fetch(f.conn, f.cursor);
        // A device removed in memory is told at its removal's round, not by silence here.
        if (got.removed || !f.live) return;
        if (f.starting) {
          f.out.send({ type: "position", from: f.cursor, incarnation });
          yield;
          if (!f.live) return;
        }
        if (f.starting || more.length > 0) {
          f.seals += more.length;
          const given = more.flatMap((r) => {
            const seal = decodeHistorySeal(r.signed);
            return seal.ok ? [{ seal: seal.value, sig: r.sig }] : [];
          });
          // A read's seals come before its first item even when there are none (PD 6.7).
          for (let at = 0; at === 0 || at < given.length; at += SEALS_MAX) {
            f.out.send({ type: "seals", items: given.slice(at, at + SEALS_MAX) });
            yield;
            if (!f.live) return;
          }
        }
        f.starting = false;
        for (const { position, kind, signed, sig } of got.items()) {
          f.cursor = position + 1;
          f.out.send({ type: "item", position, kind: kind as 1, signed, sig });
          yield;
          if (!f.live) return;
        }
        f.out.send({ type: "head", n: got.head.n, chain: got.head.chain, sig: got.sig });
        yield;
      } while (f.again);
    } finally {
      f.passing = false;
    }
  }
}
