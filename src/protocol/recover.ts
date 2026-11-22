/**
 * The recovery connection (recovery design 2.3, 3) as a pure state machine, a third purpose of the
 * device's connection beside the active one and the give-back upload: it proves with the recovery key,
 * reads the whole device log, and either ends there (the reading connection of 2.3 step 3) or builds
 * the reset against that log and submits it. The relay cuts such a connection 30 s after the device's
 * last frame and answers one log request and one submit, so nothing waits on the person here.
 * Sans-I/O like `Upload`: frames in with the time, frames to send or the outcome out.
 */
import { bytesEqual, isBytes } from "./bytes.ts";
import { buildReset } from "./device-builders.ts";
import {
  activeDevices,
  checkDeviceEntry,
  currentRecovery,
  type DeviceKeys,
  idKey,
  type LoggedEntry,
  type PublicKeys,
} from "./device-log.ts";
import type { Frame } from "./frames.ts";
import { recoveryKeyId } from "./ids.ts";
import type { RecoveryOutcome } from "./link-types.ts";
import type { Bytes } from "./platform.ts";
import { type Proof, sessionOf, signProof } from "./proofs.ts";
import type { Who } from "./reading.ts";
import type { Step } from "./upload.ts";

/**
 * What a recovery is given. `key` is the recovery key the person typed: its id and the name its signing
 * key is held under. With no `reset` the connection reads the log and ends. With one, `proof` is this
 * device's proof of possession, made once, `trusted` the devices a `No` keeps (empty after a `Yes`) and
 * `replacement` the new recovery key's public keys: the set is this device and the trusted ones still
 * active in the log read, so a rebuild never asks again (2.4).
 */
export interface RecoverOptions {
  key: { id: Bytes; sign: string };
  reset?: { proof: Bytes; trusted: readonly Bytes[]; replacement?: PublicKeys };
}

/** What one recovery connection is built from; `keys` and `sign` are the device's own. */
export interface RecoveryConnection extends RecoverOptions {
  who: Who;
  keys: DeviceKeys;
  sign: string;
  patience: number;
}

const sized = (b: unknown, n: number): boolean => isBytes(b) && b.length === n;

/** Whether `o` has the shape `Link.recover` takes: values of the wrong length would throw later, inside a connection. */
export function shapedRecover(o: RecoverOptions | undefined): boolean {
  const { key, reset: r } = o ?? ({} as Partial<RecoverOptions>);
  const keys = (k: Partial<PublicKeys> | undefined) =>
    sized(k?.signing, 65) && sized(k?.receiving, 65);
  return (
    sized(key?.id, 32) &&
    typeof key?.sign === "string" &&
    (!r ||
      (sized(r.proof, 64) &&
        Array.isArray(r.trusted) &&
        r.trusted.every((id) => sized(id, 32)) &&
        (!r.replacement || keys(r.replacement))))
  );
}

const LOG = 1; // the request ids of the two this connection makes
const SUBMIT = 2;

/** One recovery connection, from the dial to its end. */
export class Recovery {
  #o: RecoveryConnection;
  #phase: "dial" | "hello" | "log" | "submit" = "dial";
  #binding: Bytes = new Uint8Array();
  #deadline: number;
  #log: LoggedEntry[] = [];

  constructor(options: RecoveryConnection, now: number) {
    this.#o = options;
    this.#deadline = now + options.patience;
  }

  get deadline(): number {
    return this.#deadline;
  }

  /** Whether TLS is up: no frame arrives before. */
  get open(): boolean {
    return this.#phase !== "dial";
  }

  opened(binding: Bytes): void {
    if (this.#phase === "dial") [this.#binding, this.#phase] = [binding, "hello"];
  }

  /** A frame of the relay: `hello` sends the proof and the log request, the log's end the reset, an answer ends it. */
  frame(f: Frame, now: number): Step {
    const { patience } = this.#o;
    if (this.#phase === "dial") return undefined;
    if (this.#phase === "hello" && f.type === "hello") {
      [this.#phase, this.#deadline] = ["log", now + patience];
      return { send: this.#prove(f.relayNonce) };
    }
    // The relay never answers a recovery proof: a refusal is its whole answer, and ends the connection.
    // Asked again only after `ask`, as a give-back's refusal is, since a refusal 5 counts toward the relay's ban; a put-back (6) is final.
    if (f.type === "refused")
      return { done: { slow: f.reason !== 6, recovery: { refused: f.reason } } };
    this.#deadline = now + patience;
    if (this.#phase === "log" && f.type === "log") return this.#add(f);
    if (this.#phase === "log" && f.type === "result" && f.request === LOG)
      return f.code === 0 ? this.#read() : end({ fault: "the relay refused its log" });
    if (this.#phase === "submit" && f.type === "result" && f.request === SUBMIT)
      return end({ code: f.code });
    return undefined;
  }

  #prove(relayNonce: Bytes): Frame[] {
    const { who, keys, sign, key } = this.#o;
    const session = sessionOf(who.platform, who.relay, relayNonce, this.#binding);
    const proof: Proof = {
      ...session,
      kind: "recovery",
      person: who.person,
      recovery: key.id,
      newDevice: keys,
    };
    const [recoverySig, deviceSig] = [key.sign, sign].map((name) =>
      signProof(who.platform, name, proof),
    ) as [Bytes, Bytes];
    return [
      { type: "prove-recovery", proof, recoverySig, deviceSig },
      { type: "recovery-log", request: LOG },
    ];
  }

  // Each entry is checked against the log so far, as any device does: a log the relay made up never reaches the person.
  #add(f: Extract<Frame, { type: "log" }>): Step {
    for (const e of f.entries) {
      const v = checkDeviceEntry(this.#o.who.platform, this.#log, e.signed, e.sig);
      if (!v.ok) return end({ fault: "a log entry that does not hold" });
      this.#log.push(v.value);
    }
    return undefined;
  }

  #read(): Step {
    const { who, key, reset, keys } = this.#o;
    const first = this.#log[0];
    const current = currentRecovery(who.platform, this.#log);
    if (
      !first ||
      !bytesEqual(first.id, who.person) ||
      !current ||
      !bytesEqual(recoveryKeyId(who.platform, current.signing, current.receiving), key.id)
    )
      return end({
        fault: "a log that is not this person's, or whose recovery key is not the one typed",
      });
    if (!reset) return end({ log: this.#log });
    const active = activeDevices(who.platform, this.#log);
    const set = [
      who.self,
      ...reset.trusted.filter(
        (id, i, all) =>
          active.has(idKey(id)) &&
          !bytesEqual(id, who.self) &&
          all.findIndex((x) => bytesEqual(x, id)) === i, // a device twice would never build
      ),
    ];
    const built = buildReset(
      who.platform,
      key.sign,
      this.#log,
      key.id,
      set,
      { device: keys, proof: reset.proof },
      reset.replacement,
    );
    if (!built.ok) return end({ fault: "a reset the log would refuse" });
    this.#phase = "submit";
    const { signed, sig } = built.value;
    return { send: [{ type: "submit", request: SUBMIT, kind: 1, signed, sig }] };
  }
}

const end = (recovery: RecoveryOutcome): Step => ({ done: { slow: false, recovery } });
