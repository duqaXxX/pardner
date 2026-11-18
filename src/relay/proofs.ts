/**
 * Design 6.1 and 6.6: what a connection's first frames do. Proofs are checked in the design's order
 * and answered `served` or `refused`; an enrolment places the first genesis and is never answered;
 * a head given back is decided by `giveback.ts`. A served device holds four connections.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bytesEqual } from "../protocol/bytes.ts";
import { idKey } from "../protocol/device-log.ts";
import type { Frame } from "../protocol/frames.ts";
import { deviceId } from "../protocol/ids.ts";
import type { Bytes, Platform } from "../protocol/platform.ts";
import { checkProof, type Expect } from "../protocol/proofs.ts";
import type { Blobs } from "./blobs.ts";
import { changed, writeMark } from "./directory.ts";
import { giveBack } from "./giveback.ts";
import { DirectoryChanged, type Journal } from "./journal.ts";
import type { Limits } from "./limits.ts";
import { errorFields, type Log } from "./log.ts";
import { type Handler, Requests } from "./requests.ts";
import type { Rounds, Seam } from "./round.ts";
import type { Seals } from "./seals.ts";
import { Code, type Sequence } from "./sequence.ts";
import type { Peer, Session } from "./server.ts";

/** What a serving relay holds; a relay that started failed closed has none of it. */
export interface Serving {
  seq: Sequence;
  journal: Journal;
  rounds: Rounds;
  seam: Seam;
  dir: string;
  /** The directory's descriptor, which the mark's round syncs. */
  lock: number;
  incarnation: Bytes;
  seals: Seals;
  blobs: Blobs;
}

export interface ProofsDeps {
  platform: Platform;
  relayPublic: Bytes;
  limits: Limits;
  log: Log;
  serving: Serving | null;
}

/** The reasons of `refused` and the code of a give-back that failed the relay closed (design 6.7). */
const Reason = { removed: 1, unknown: 2, notCurrent: 3, bad: 5, failedClosed: 6 } as const;
/** A device's served connections: a fifth closes the oldest; and the one frame after `prove upload` (4.6). */
const PER_DEVICE = 4;
const UPLOAD_FRAME_MAX = 4096;

export class Proofs {
  #d: ProofsDeps;
  /** A head given back is being decided: the mark is written, and until it is nothing is sent (6.5). */
  #deciding = false;
  /** The relay is failed closed: the mark is on disk, or it started so. */
  #failed: boolean;
  /** Rule 11 found the directory changed: nothing more is answered (3.7). */
  #stopped = false;
  #requests: Requests | null;
  #peers = new Set<Peer>();
  /** Per device id, its served connections in the order they were served. */
  #served = new Map<string, Set<Peer>>();

  constructor(deps: ProofsDeps) {
    this.#d = deps;
    this.#failed = deps.serving === null;
    this.#requests = deps.serving
      ? new Requests({
          serving: deps.serving,
          silent: () => this.#silent,
          removed: (devices) => this.removed(devices),
          unchanged: () => this.#unchanged(),
          fail: (error) => this.#fail(error),
        })
      : null;
  }

  /** A connection's frames; an error nothing expected stops the relay with 75 (design 2.4), never the process with 1. */
  session(peer: Peer): Session {
    const session = this.#session(peer);
    return {
      closed: session.closed,
      frame: (f) => {
        try {
          return session.frame(f);
        } catch (error) {
          this.#fail(error);
          return false;
        }
      },
    };
  }

  #session(peer: Peer): Session {
    this.#peers.add(peer);
    if (this.#deciding) peer.pause();
    let enrolled = false;
    let uploads = false;
    let device: string | undefined;
    // What the connection's requests do, once a proof that allows them is served.
    let handler: Handler | undefined;
    return {
      closed: () => {
        handler?.closed();
        this.#peers.delete(peer);
        const set = device === undefined ? undefined : this.#served.get(device);
        set?.delete(peer);
        if (set?.size === 0) this.#served.delete(device as string);
      },
      frame: (f) => {
        // A frame read before the connection was paused: answered nothing, its connection is refused 6 below.
        if (this.#deciding || this.#stopped) return false;
        if (this.#failed) {
          // A relay that failed closed serves nothing, to anyone: every proof is answered unchecked.
          if (f.type === "enrol") return true;
          if (f.type.startsWith("prove-")) {
            this.#d.limits.refusedProof();
            peer.end({ type: "refused", reason: Reason.failedClosed });
          } else peer.close();
          return false;
        }
        if (f.type === "enrol" && !enrolled) {
          enrolled = true;
          this.#enrol(peer, f);
          return true;
        }
        if (f.type === "upload-done" && uploads) return this.#uploadDone(peer, f);
        if (f.type === "prove-active") {
          device = this.#active(peer, f);
          uploads = device !== undefined;
          if (uploads)
            handler = this.#requests?.open(
              peer,
              { person: f.proof.person, device: f.proof.device },
              "active",
            );
          return uploads;
        }
        if (!enrolled && f.type === "prove-upload") {
          const sigs = [f.deviceSig, f.relaySig];
          if (!checkProof(this.#d.platform, f.proof, sigs, this.#expect(peer)).ok)
            return this.#refuse(peer, Reason.bad);
          this.#d.limits.upload(peer.held);
          peer.allow(UPLOAD_FRAME_MAX);
          uploads = true;
          return true;
        }
        if (!enrolled && f.type === "prove-recovery") {
          handler = this.#recovery(peer, f);
          return handler !== undefined;
        }
        if (handler) return handler.frame(f);
        peer.close();
        return false;
      },
    };
  }

  /**
   * The hourly removal of the blobs no message names (3.11), under the guard of a round's: rule 11
   * first (3.7), and nothing while deciding, once failed closed or stopped (6.5).
   */
  expire(): void {
    const s = this.#d.serving;
    if (!s || this.#silent || !this.#unchanged()) return;
    try {
      s.blobs.expire();
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Design 6.1: the devices a round's removal took out lose their connections, told why. */
  removed(devices: readonly Bytes[]): void {
    if (this.#silent) return;
    for (const id of devices) {
      for (const peer of this.#served.get(idKey(id)) ?? []) {
        peer.end({ type: "refused", reason: Reason.removed });
      }
      this.#served.delete(idKey(id));
    }
  }

  /** Deciding, failed closed or stopped: no answer is sent but the failed-closed ones (6.5, 3.7). */
  get #silent(): boolean {
    return this.#deciding || this.#failed || this.#stopped;
  }

  /** Rule 11 (design 3.7) before an answer: false when the directory changed, and the relay has stopped. */
  #unchanged(): boolean {
    const { dir, lock, journal } = this.#d.serving as Serving;
    const check = changed(dir, lock, journal);
    if (check !== null)
      this.#stop(`rule 11: the directory differs from what the relay wrote (${check})`);
    return check === null;
  }

  /** An error nothing expected (design 2.4): no answer, every connection closed, the process starts again. */
  #fail(error: unknown): void {
    if (error instanceof DirectoryChanged)
      this.#stop("rule 11: the directory differs from what the relay wrote (journal)");
    else
      this.#stop(
        `unexpected ${error instanceof Error ? error.name : typeof error} (${errorFields(error)})`,
      );
  }

  #stop(line: string): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#d.log.error(`${line}: answering nothing, stopping`);
    for (const peer of this.#peers) peer.close();
    (this.#d.serving as Serving).seam.stop(75);
  }

  #expect(peer: Peer): Expect {
    return { relayPublic: this.#d.relayPublic, relayNonce: peer.nonce, binding: peer.binding };
  }

  /**
   * Refuses and closes; reason 5 counts toward the ban (4.4). A refusal that rests on what the
   * sequence holds, a removal or the current recovery key, waits until everything placed is on disk
   * (SD 5.3: an answer is never sent from a state a restart could lose).
   */
  #refuse(peer: Peer, reason: 1 | 2 | 3 | 5): false {
    this.#d.limits.refusedProof();
    if (reason === Reason.bad) this.#d.limits.refusedFive(peer.remote);
    if (reason === Reason.removed || reason === Reason.notCurrent) {
      const { rounds } = this.#d.serving as Serving;
      void rounds.wait(rounds.written).then(() => {
        if (!this.#silent) peer.end({ type: "refused", reason });
      });
    } else peer.end({ type: "refused", reason });
    return false;
  }

  /** `prove active` in the order of 6.1; the device's idKey once it is served, else undefined. */
  #active(peer: Peer, f: Extract<Frame, { type: "prove-active" }>): string | undefined {
    const s = this.#d.serving as Serving;
    const { proof } = f;
    const found = s.seq.standing(proof.person, proof.device);
    if (!found?.device) return void this.#refuse(peer, Reason.unknown);
    if (!checkProof(this.#d.platform, proof, [f.sig], this.#expect(peer), found.device).ok)
      return void this.#refuse(peer, Reason.bad);
    if (!found.active) return void this.#refuse(peer, Reason.removed);
    this.#d.limits.serve(peer.held, "active");
    peer.allow();
    const key = idKey(proof.device);
    const set = this.#served.get(key) ?? new Set<Peer>();
    this.#served.set(key, set);
    if (set.size >= PER_DEVICE) {
      const oldest = set.values().next().value as Peer;
      set.delete(oldest);
      oldest.close();
    }
    set.add(peer);
    // Served once what the proof depends on, a genesis just placed, is on disk (6.6).
    void s.rounds.wait(s.rounds.written).then(() => {
      if (!this.#silent) peer.send({ type: "served", incarnation: s.incarnation });
    });
    return key;
  }

  /** `prove recovery`: no answer; the connection moves to the recovery pool, and may submit its reset. */
  #recovery(peer: Peer, f: Extract<Frame, { type: "prove-recovery" }>): Handler | undefined {
    const { proof } = f;
    const found = (this.#d.serving as Serving).seq.standing(proof.person);
    if (!found) return void this.#refuse(peer, Reason.unknown);
    const { recovery, recoveryId } = found;
    if (!recovery || !recoveryId || !bytesEqual(recoveryId, proof.recovery))
      return void this.#refuse(peer, Reason.notCurrent);
    const sigs = [f.recoverySig, f.deviceSig];
    if (!checkProof(this.#d.platform, proof, sigs, this.#expect(peer), recovery).ok)
      return void this.#refuse(peer, Reason.bad);
    if (!this.#d.limits.serve(peer.held, "recovery")) return void peer.close();
    peer.allow();
    const { signing, receiving } = proof.newDevice;
    const device = deviceId(this.#d.platform, signing, receiving);
    return (this.#requests as Requests).open(
      peer,
      { person: proof.person, device, recovery: proof.recovery },
      "recovery",
    );
  }

  /** Design 6.6: never answered; the proof that follows tells whether it was taken. */
  #enrol(peer: Peer, f: Extract<Frame, { type: "enrol" }>): void {
    const s = this.#d.serving as Serving;
    let spent = false;
    const ticket = s.seq.enrol(f.signed, f.sig, () => {
      spent = this.#secretHolds(s.dir, f.secret);
      if (!spent) this.#d.limits.refusedFive(peer.remote);
      return spent;
    });
    // The secret is no longer needed once the genesis it allowed is on disk (design 3.3).
    if (ticket !== null && spent) {
      void s.rounds.wait(ticket).then(() => {
        try {
          rmSync(join(s.dir, "enrol"), { force: true });
        } catch (error) {
          this.#d.log.error(`the enrolment file could not be removed (${errorFields(error)})`);
        }
      });
    }
  }

  #secretHolds(dir: string, secret: Bytes): boolean {
    try {
      const kept = readFileSync(join(dir, "enrol"));
      const given = createHash("sha256").update(secret).digest();
      return kept.length === given.length && timingSafeEqual(kept, given);
    } catch {
      return false;
    }
  }

  /** Design 3.12: the head alone decides; the connection is closed once it is answered. */
  #uploadDone(peer: Peer, f: Extract<Frame, { type: "upload-done" }>): boolean {
    if (!this.#unchanged()) return false;
    const s = this.#d.serving as Serving;
    const given = giveBack(this.#d.platform, this.#d.relayPublic, s.journal.placed, f.head, f.sig);
    if (given.verdict === "closed") this.#failClosed(peer, f.request, given.first);
    else {
      const code = given.verdict === "accepted" ? Code.accepted : Code.refused;
      peer.end({ type: "result", request: f.request, code });
    }
    return false;
  }

  /**
   * Design 6.5, for the connections PR 6 has: no frame is read from any of them from now on, those
   * that arrive meanwhile included, and nothing is sent until the mark is on disk. Only then is the
   * relay failed closed: the uploader is told, the others are refused, and every connection closes.
   * A mark that fails stops the relay (75) with nothing sent.
   */
  #failClosed(uploader: Peer, request: number, first: number): void {
    const s = this.#d.serving as Serving;
    this.#deciding = true;
    for (const peer of this.#peers) peer.pause();
    this.#d.log.error(`failed closed: a head given back differs from the sequence at ${first}`);
    writeMark(s.rounds, s.seam, s.dir, s.lock, first).then(
      () => {
        this.#deciding = false;
        this.#failed = true;
        uploader.end({ type: "result", request, code: Code.putBack });
        for (const peer of this.#peers) {
          if (peer !== uploader) peer.end({ type: "refused", reason: Reason.failedClosed });
        }
      },
      () => {},
    );
  }
}
