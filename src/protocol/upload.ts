/**
 * The give-back upload connection (relay continuity design 5.11) as a pure state machine, the part
 * of the device's connection policy that gives a head the relay lost back on a connection of its
 * own. Sans-I/O like `Link`, which owns the socket and the frames' bytes: this takes the relay's
 * frames with the time and returns the frames to send or how the upload ended.
 */
import type { DeviceKeys } from "./device-log.ts";
import type { Frame } from "./frames.ts";
import type { RecoveryOutcome } from "./link-types.ts";
import type { Bytes } from "./platform.ts";
import { type Proof, type RelayHead, sessionOf, signProof } from "./proofs.ts";
import type { Who } from "./reading.ts";

/** What an upload is built from: the device, the head it holds and gives back (the caller passes the one held at the dial), and how long it waits for an answer. */
export interface UploadOptions {
  who: Who; // `who.platform` holds the device's key under `sign` and draws the nonce
  keys: DeviceKeys; // the public keys the proof carries
  sign: string; // the platform's name for the signing key
  head: { head: RelayHead; sig: Bytes }; // the head the device held at the dial, as the relay signed it
  patience: number;
}

/** How an upload ended: the relay's result code or its refusal reason, neither on a drop; `recovery` is a recovery connection's own answer; `slow` asks again only after `ask`, and is only ever raised: false never clears it. */
export type Outcome = {
  code?: number;
  refusal?: number;
  slow: boolean;
  recovery?: RecoveryOutcome;
};

/** What a frame of the relay makes the upload do: send frames, end, or nothing. */
export type Step = { send: Frame[] } | { done: Outcome } | undefined;

/** One give-back connection, from the dial to the answer. */
export class Upload {
  #o: UploadOptions;
  #phase: "dial" | "hello" | "wait" = "dial";
  #binding: Bytes = new Uint8Array();
  #deadline: number;

  /** An upload dialed at `now`. */
  constructor(options: UploadOptions, now: number) {
    this.#o = options;
    this.#deadline = now + options.patience;
  }

  /** When the upload gives up: `patience` from the dial (hello shares it), then from the proof and each answer. */
  get deadline(): number {
    return this.#deadline;
  }

  /** Whether TLS is up: no frame arrives before. */
  get open(): boolean {
    return this.#phase !== "dial";
  }

  /** TLS is up and the relay's key is the pinned one; `binding` is this connection's exporter. */
  opened(binding: Bytes): void {
    if (this.#phase === "dial") [this.#binding, this.#phase] = [binding, "hello"];
  }

  /** A frame of the relay: `hello` sends the proof and the head together, the answer ends it, anything else waits on. */
  frame(f: Frame, now: number): Step {
    const { patience } = this.#o;
    if (this.#phase === "dial") return undefined; // nothing arrives before TLS is up
    if (this.#phase === "hello" && f.type === "hello") {
      [this.#phase, this.#deadline] = ["wait", now + patience];
      return { send: this.#prove(f.relayNonce) };
    }
    if (f.type === "result" && f.request === 1) return { done: { code: f.code, slow: false } };
    // A refusal other than 6 (put back) asks again only after `ask`.
    if (f.type === "refused") return { done: { refusal: f.reason, slow: f.reason !== 6 } };
    this.#deadline = now + patience;
    return undefined;
  }

  #prove(relayNonce: Bytes): Frame[] {
    const { who, keys, sign, head } = this.#o;
    const session = sessionOf(who.platform, who.relay, relayNonce, this.#binding);
    const proof: Proof = { ...session, kind: "upload", device: keys, head: head.head };
    const deviceSig = signProof(who.platform, sign, proof);
    return [
      { type: "prove-upload", proof, deviceSig, relaySig: head.sig },
      { type: "upload-done", request: 1, head: head.head, sig: head.sig },
    ];
  }
}
