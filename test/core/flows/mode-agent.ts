/**
 * A plain agent with what a session's setup applies, and a record of what the core did to each of
 * its processes: the permission modes it set, the models, the efforts and the interrupts.
 *
 * It lists the plain models, has a mode that skips permission requests (and, with `auto`, one the
 * folder's own settings may start it in), and says by `live` whether an effort is set on a running
 * process (`liveEffort`) or only by starting another. `native` is the mode a process says it
 * started in, as a folder whose own settings start the agent in bypass makes it. A test holds
 * what the core waits on: `gates` hold every start of a process (until the gate is set), every
 * `setModel`, `setEffort` and `setPermissionMode` in the same way, and `modelFails` makes `setModel` reject.
 */
import type {
  Capabilities,
  ModelInfo,
  RequestHandler,
  StartOptions,
} from "../../../src/agent/seam.ts";
import type { AsyncEvent } from "../../support/fake-clock.ts";
import { PLAIN_MODELS, PlainAgent } from "../../support/plain-agent.ts";

export const DEFAULT_MODE = "standard";
export const BYPASS_MODE = "unrestricted";
export const AUTO_MODE = "automatic";

/** What the core did to one process. */
export interface Recorded {
  /** The permission modes set on it, in order. */
  readonly modes: string[];
  /** The models set on it, in order. */
  readonly models: (string | null)[];
  /** The efforts set on it while it ran, in order. */
  readonly efforts: (string | null)[];
  /** How many times it was interrupted. */
  interrupts: number;
}

export interface ModeAgentOptions {
  /** The agent lists these models (`PLAIN_MODELS` when `true`), which a session takes with `setModel`. */
  readonly models?: readonly ModelInfo[] | true;
  /** An effort is set on a running process (`liveEffort`). */
  readonly live?: boolean;
  /** The agent has an automatic mode, which a folder's settings may start it in. */
  readonly auto?: boolean;
}

/** What a test holds the core on: each waits until set. */
export interface Gates {
  /** The next process start. */
  start?: AsyncEvent;
  setModel?: AsyncEvent;
  setEffort?: AsyncEvent;
  setPermissionMode?: AsyncEvent;
}

export class ModeAgent extends PlainAgent {
  /** One record per process the agent started, in the order of `sessions`. */
  readonly recorded: Recorded[] = [];
  /** The mode a process says it started in. */
  native = DEFAULT_MODE;
  readonly gates: Gates = {};
  /** `setModel` rejects with this. */
  modelFails: Error | null = null;

  constructor(options: ModeAgentOptions = {}) {
    super(
      options.models === undefined
        ? {}
        : { models: options.models === true ? PLAIN_MODELS : options.models },
    );
    const capabilities: Capabilities = {
      ...this.capabilities,
      liveEffort: options.live ?? false,
      permissionModes: {
        default: DEFAULT_MODE,
        auto: options.auto === true ? AUTO_MODE : null,
        bypass: BYPASS_MODE,
        plan: null,
      },
    };
    (this as { capabilities: Capabilities }).capabilities = Object.freeze(capabilities);
  }

  /** Opens every gate: what a block that failed leaves shut must not keep the teardown waiting. */
  openGates(): void {
    for (const gate of Object.values(this.gates)) gate.set();
  }

  override async start(options: StartOptions, requests: RequestHandler) {
    const record: Recorded = { modes: [], models: [], efforts: [], interrupts: 0 };
    this.recorded.push(record); // a start held at its gate is already on the record
    await this.gates.start?.wait();
    const session = await super.start(options, requests);
    session.setPermissionMode = async (mode) => {
      record.modes.push(mode);
      await this.gates.setPermissionMode?.wait();
    };
    session.setModel = async (model) => {
      record.models.push(model);
      await this.gates.setModel?.wait();
      if (this.modelFails !== null) throw this.modelFails;
    };
    if (this.capabilities.liveEffort) {
      session.setEffort = async (level) => {
        record.efforts.push(level);
        await this.gates.setEffort?.wait();
      };
    }
    const interrupt = session.interrupt.bind(session);
    session.interrupt = async () => {
      record.interrupts += 1;
      await interrupt();
    };
    const info = session.info.bind(session);
    const native = this.native;
    session.info = async () => ({ ...(await info()), permissionMode: native });
    return session;
  }
}
