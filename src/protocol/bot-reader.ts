import { bytesEqual } from "./bytes.ts";
import { activeDevices, idKey, type LoggedEntry, namedDevices } from "./device-log.ts";
import { refKey, Seen } from "./device-reader.ts";
import { openBlob } from "./files.ts";
import {
  cutName,
  type Message,
  type MessageBody,
  openMessage,
  type Reference,
  unreadName,
} from "./messages.ts";
import { dropStarts, type OutboxItem, type Run } from "./outbox.ts";
import type { Bytes, Platform } from "./platform.ts";

/** What the bot's store holds of a prompt, by `refKey`: it survives a restart (SD 5.8, "a bot set up again keeps what it decided"). */
export type Decision = "started" | "done" | "cut" | "unread";

/** A prompt, or a reply, the bot may act on: its sender and name, and its opened body. */
export interface Prompt {
  ref: Reference;
  /** The request of the bot's own that this message answers: a reply (kind 10), where a prompt has none. */
  answers?: Reference | undefined;
  body: MessageBody;
  /** The files of `body`, opened, in its order: the bot held them when it started, and does not fetch them again (5.12, point 7). */
  files: Bytes[];
}

/** Where in the relay's sequence a message is read: the bot's epoch, key and owner's log as they stood there (SD 5.8, conditions 1 to 3). */
export interface Place {
  /** The epoch the bot holds as current. */
  epoch: Bytes;
  /** Whether the bot is a recipient of it. */
  member: boolean;
  /** That epoch's key, when the bot holds it: no other epoch's. */
  key: Bytes | undefined;
  /** The owner's device log as the bot holds it, every entry checked (the model's `deviceLog`); it must name the bot. */
  log: readonly LoggedEntry[];
  /** How many entries of `log` the sequence has reached here (the model's `pass.logLen`). */
  length: number;
}

/** A message the bot writes, for the caller to queue with its content: a start (3), a cut (6) or a not-read notice (7), naming the prompt. */
export interface Notice {
  kind: 3 | 6 | 7;
  re: Reference;
  name: Bytes;
}

/** What reading one message asks of the caller: queue the notices; run `run`, then `answered`; `wait` leaves the message to be read again. */
export interface Step {
  notices: Notice[];
  run?: Prompt | undefined;
  wait?: boolean | undefined;
}

/** A blob's ciphertext, `"gone"` when the relay says so, or `"wait"` when it does not answer. */
export type Blobs = (id: Bytes) => Bytes | "gone" | "wait";

const NONE: Step = { notices: [] };

/**
 * What a bot acts on (security design 5.8), for the messages the caller accepted under 5.6 (the
 * check and the seen-set) and passes in the relay's order, each at its `Place`. `decided` is the
 * store: the caller keeps it after every call. The rest is in memory and starts again with a run.
 * A restart is `restartBot`: it builds the reader again, and a store holding "started" is a cut.
 */
export class BotReader {
  readonly decided: Map<string, Decision>;
  #platform: Platform;
  #self: Bytes;
  #incarnation: Bytes;
  #run: Run;
  #pending = new Map<string, Prompt>(); // prompts whose start the bot has written
  #late = new Map<string, Reference>(); // prompts of another incarnation, which it does not run
  #requests = new Set<string>(); // the requests (kind 9) it wrote and has read in this pass: what a reply may name
  #said = new Set<string>(); // the cuts said in this run

  constructor(
    platform: Platform,
    self: Bytes,
    incarnation: Bytes,
    run: Run,
    decided: Map<string, Decision> = new Map(),
  ) {
    this.#platform = platform;
    this.#self = self;
    this.#incarnation = incarnation;
    this.#run = run;
    this.decided = decided;
    for (const [key, state] of decided) if (state === "started") decided.set(key, "cut"); // a run that died between its start and its answer
  }

  /**
   * Reads the next message of the sequence: the bot's own (what it acted on) or a prompt for it.
   * Every message `Seen.check` does not call "again" comes here, and `Seen.add` follows unless the
   * step is `wait`.
   */
  read(m: Message, place: Place, blobs: Blobs): Step {
    return bytesEqual(m.header.sender, this.#self) ? this.#own(m) : this.#act(m, place, blobs);
  }

  /** What a bot reads of its own in the sequence: there, and not in its store, is what it acted on. */
  #own(m: Message): Step {
    const { kind, re, run } = m.header;
    if (!re) return NONE;
    const key = refKey(re);
    if (kind === 9) this.#requests.add(refKey({ device: this.#self, name: m.header.name }));
    const state = this.decided.get(key);
    if (kind === 7) {
      this.decided.set(key, state ?? "unread");
      this.#pending.delete(key);
    }
    if (kind === 5 && state === "cut") this.decided.set(key, "done"); // a run of an earlier life that did end
    if (kind !== 3) return NONE;
    if (state) this.#pending.delete(key);
    // SD 5.8 has a start of the current run under an earlier incarnation, read back after "not run",
    // said cut; the model does not, and neither does this: it goes to the maintainer. Nothing runs either way.
    // A prompt it said it does not run, whose start of an earlier run comes later: that run was cut.
    if (state === "cut" || (state === "unread" && !bytesEqual(run, this.#run.id)))
      return this.#cut(re);
    if (state) return NONE; // the first start in the sequence decided
    const prompt = this.#pending.get(key);
    if (!prompt || !bytesEqual(run, this.#run.id)) {
      this.decided.set(key, "cut"); // a start of an earlier run: it was cut, or its answer comes next
      return this.#cut(re);
    }
    this.decided.set(key, "started");
    return { notices: [], run: prompt };
  }

  /**
   * A prompt, or a reply to a request of its own, the bot may act on, judged at its place in the
   * sequence: the bot writes its start. One from a device the owner's log does not show active gets
   * no notice, as in the model. The incarnation rule is a prompt's alone: a reply handed on twice is
   * harmless, since the core answers false for a request no longer waiting (ledger, "The model's reply rule").
   */
  #act(m: Message, place: Place, blobs: Blobs): Step {
    const h = m.header;
    if ((h.kind !== 2 && h.kind !== 10) || !h.to || !bytesEqual(h.to, this.#self)) return NONE; // condition 4
    if (!bytesEqual(h.epoch, place.epoch)) return NONE; // condition 2
    // Condition 3, on the log as far as the sequence has read it. A log that does not name this bot
    // is not its owner's: the bot obeys its owner alone (invariant 1).
    const log = place.log.slice(0, place.length);
    if (!namedDevices(this.#platform, log).has(idKey(this.#self))) return NONE;
    if (!activeDevices(this.#platform, log).has(idKey(h.sender))) return NONE;
    if (h.kind === 10 && !(h.re && this.#requests.has(refKey(h.re)))) return NONE; // answers no request of this bot's, read earlier
    const re = { device: h.sender, name: h.name };
    const key = refKey(re);
    if (this.decided.get(key) === "cut") return this.#cut(re); // its store holds the cut, whose start a relay that went back may lack
    if (this.decided.has(key) || this.#pending.has(key) || this.#late.has(key)) return NONE;
    if (h.kind === 2 && !bytesEqual(h.incarnation, this.#incarnation)) {
      this.#late.set(key, re); // taken before the relay last started: perhaps run under it
      return NONE;
    }
    // Readable: a recipient that holds the key, and every file named is held and opens (5.12, point 7).
    const opened =
      place.member && place.key ? openMessage(this.#platform, place.key, m) : undefined;
    let body = opened?.ok ? opened.value : undefined;
    const files: Bytes[] = [];
    for (const f of body?.files ?? []) {
      const blob = blobs(f.blob);
      if (blob === "wait") return { notices: [], wait: true }; // no answer: read again later, never "not read"
      const file = blob === "gone" ? undefined : openBlob(this.#platform, f.blob, f.fileKey, blob);
      if (!file?.ok) {
        body = undefined; // the first file that fails decides
        break;
      }
      files.push(file.value);
    }
    if (!body) {
      this.decided.set(key, "unread"); // never acted on later, when a key arrives
      return { notices: [{ kind: 7, re, name: unreadName(this.#platform, re) }] };
    }
    this.#pending.set(key, { ref: re, answers: h.kind === 10 ? h.re : undefined, body, files });
    return { notices: [{ kind: 3, re, name: this.#platform.random(16) }] }; // it acts when it reads this back
  }

  /** The bot says a run was cut, in a message named after the prompt, once in a run. */
  #cut(re: Reference): Step {
    const key = refKey(re);
    if (this.#said.has(key)) return NONE;
    this.#said.add(key);
    return { notices: [{ kind: 6, re, name: cutName(this.#platform, re) }] };
  }

  /**
   * Once the bot has read to the relay's end, the prompts of another incarnation it did not act on
   * are said not run, each in a message named after the prompt. Said at the end, so that a start of
   * its own of an earlier run, later in the sequence, is read first and the prompt is shown cut.
   */
  caughtUp(): Notice[] {
    const notices: Notice[] = [];
    for (const [key, re] of this.#late) {
      if (this.decided.has(key)) continue;
      this.decided.set(key, "unread");
      notices.push({ kind: 7, re, name: unreadName(this.#platform, re) });
    }
    this.#late.clear();
    return notices;
  }

  /**
   * Served under a new incarnation: it forgets every start it decided and did not read back (SD 5.8).
   * The caller reads the sequence again from the start, with a new `Seen`.
   */
  newIncarnation(incarnation: Bytes): void {
    this.#incarnation = incarnation;
    this.#pending.clear();
    this.#requests.clear(); // read again from the start: a reply names a request read earlier in that pass
  }

  /** The run has answered `ref`: the caller has queued the answer. */
  answered(ref: Reference): void {
    this.decided.set(refKey(ref), "done");
    this.#pending.delete(refKey(ref));
  }
}

/**
 * A restart, the one way: a new reader on the same store (what was started and not answered is a
 * cut and never run again), the outbox without its starts, a new seen-set. The caller reads the
 * sequence again from its start, and calls `caughtUp` only after a complete pass, never after a `wait`.
 */
export function restartBot(
  platform: Platform,
  self: Bytes,
  incarnation: Bytes,
  decided: Map<string, Decision>,
  outbox: OutboxItem[],
  run: Run,
) {
  const reader = new BotReader(platform, self, incarnation, run, decided);
  return { reader, outbox: dropStarts(outbox), seen: new Seen() };
}
