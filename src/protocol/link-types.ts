/**
 * What `Link` and its driver say to each other (step 6.3 design, 4): the effects the driver performs
 * and the states the link shows. Kept apart from `link.ts`, which re-exports them.
 */
import type { Bytes } from "./platform.ts";
import type { Kept, Out } from "./reading.ts";

/** What the driver stores before it performs the next effect; each write also holds the Reading's `kept`. */
export type Persist = { incarnation: Bytes } | { kept: Kept } | { putBack: true } | { fault: true };

/** What the driver performs, in the order returned: a `wake` replaces the timer, a `persist` is finished first. */
export type Effect =
  | { do: "dial"; conn: number; purpose: "active" | "upload" }
  | { do: "send"; conn: number; bytes: Bytes }
  | { do: "close"; conn: number; why?: string } // `why`: the error or the deadline that made the link close it
  | { do: "wake"; at: number } // the one timer: it replaces any earlier wake
  | { do: "persist"; what: Persist }
  | { do: "deliver"; out: Out }
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
  | "put-back"
  | "fault"
  | "stopped";
