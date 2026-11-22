/**
 * What `Link` and its driver say to each other (step 6.3 design, 4): the effects the driver performs
 * and the states the link shows. Kept apart from `link.ts`, which re-exports them.
 */
import type { LoggedEntry } from "./device-log.ts";
import type { Bytes } from "./platform.ts";
import type { Kept, Out } from "./reading.ts";

/** What the driver stores before it performs the next effect; each write also holds the Reading's `kept`. */
export type Persist = { incarnation: Bytes } | { kept: Kept } | { putBack: true } | { fault: true };

/** How a recovery connection ended (recovery design 2.3): the verified log of a reading connection, the relay's answer to the reset, its refusal, or a log it made up. */
export type RecoveryOutcome =
  | { log: readonly LoggedEntry[] }
  | { code: number }
  | { refused: number }
  | { fault: string };

/** What the driver performs, in the order returned: a `wake` replaces the timer, a `persist` is finished first. */
export type Effect =
  | { do: "dial"; conn: number; purpose: "active" | "upload" | "recover" }
  | { do: "send"; conn: number; bytes: Bytes }
  | { do: "close"; conn: number; why?: string } // `why`: the error or the deadline that made the link close it
  | { do: "wake"; at: number } // the one timer: it replaces any earlier wake
  | { do: "persist"; what: Persist }
  | { do: "deliver"; out: Out }
  | { do: "enrolled" } // the first `served` of a link given an `enrol`: entry 0 was placed, the app stops passing the secret
  | { do: "enrol-refused" } // refusal 2 on a connection that carried `enrol`: the link dropped it, `enrol` hands it a retyped one
  | { do: "recovery"; outcome: RecoveryOutcome } // a recovery connection ended with an answer; the link then stops (the log of a reading, a refusal 2 or 3, a fault), marks put-back (6), or tries `prove-active` again (a reset's result, or a refusal 5 after `ask`)
  | { do: "recovered" } // the first `served` of a link given a `recover` reset: the reset is in the log, the link is an ordinary one
  | { do: "answer"; request: number; code: number | "unanswered" };

/** Where the connection is, `unstarted` before `start`; the three steps of an upload connection all show as `uploading`. */
export type LinkState =
  | "unstarted"
  | "waiting"
  | "dialing"
  | "hello"
  | "proving"
  | "reading"
  | "rest"
  | "uploading"
  | "recovering"
  | "put-back"
  | "fault"
  | "stopped";
