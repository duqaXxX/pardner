/**
 * What reaches the core from the relay (design 3.7): each message of the reading goes through the
 * bot's `BotReader`, which holds security design 5.8; a prompt becomes `ChatInbound.message`, and a
 * reply of the owner's to a request becomes `ChatInbound.answer`. The reader's notices (start, cut,
 * not read) are queued in the outbox, and its decisions are stored before anything is handed on.
 */

import { BotReader, type Notice, type Prompt } from "../../protocol/bot-reader.ts";
import { bytesEqual } from "../../protocol/bytes.ts";
import { refKey } from "../../protocol/device-reader.ts";
import { type Message, openMessage, type Reference } from "../../protocol/messages.ts";
import type { Draft, Run } from "../../protocol/outbox.ts";
import type { Bytes, Platform } from "../../protocol/platform.ts";
import type { Out } from "../../protocol/reading.ts";
import type {
  ChatInbound,
  InboundMessage,
  OwnerAnswer,
  SetupSelection,
  ThreadRef,
} from "../seam.ts";
import { referenceOf, toHex } from "./hex.ts";
import type { Outbox } from "./outbox.ts";
import type { Store } from "./store.ts";

/** A request the bot wrote and waits on: the core's id for it, its thread and the type its answer must have. */
export type Waiting = {
  requestId: string;
  ref: ThreadRef;
} & (
  | { type: Exclude<OwnerAnswer["type"], "question"> }
  /** `questions`: the text of each question, the only keys an answer may use. */
  | { type: "question"; questions: readonly string[] }
);

/** The question texts of a request as shown (the body's `request`), or `undefined` when it holds none that can be read. */
export function questionsOf(request: unknown): string[] | undefined {
  const asked = record(request)?.questions;
  if (!Array.isArray(asked)) return undefined;
  const texts = asked.map((q) => record(q)?.text);
  return texts.every((t) => typeof t === "string") ? (texts as string[]) : undefined;
}

export interface InboundOptions {
  platform: Platform;
  self: Bytes;
  store: Store;
  outbox: Outbox;
  /** The run of the bot, the outbox's own (R6): a start read back is of this run. */
  run: Run;
  log: (line: string) => void;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const parse = (text: string) => {
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/** Every type of an answer: a record, so that a type added to the seam's union stops the build here. */
const TYPES: Record<OwnerAnswer["type"], true> = {
  permission: true,
  question: true,
  hold: true,
  setup: true,
  shell: true,
  terminal: true,
};

const strings = (value: unknown) =>
  record(value) !== undefined && Object.values(value as object).every((v) => typeof v === "string");

/**
 * The owner's answer, field by field as the seam's union has it, or `undefined`: the core reads these
 * fields without checking their types, so a wrong one is never passed on.
 */
function answerOf(value: unknown, request: Waiting): OwnerAnswer | undefined {
  const a = record(value);
  const type = request.type;
  if (a?.type !== type) return undefined;
  if (type === "permission")
    return typeof a.allow === "boolean" ? { type, allow: a.allow } : undefined;
  if (type === "hold") return typeof a.send === "boolean" ? { type, send: a.send } : undefined;
  if (type === "shell") return typeof a.run === "boolean" ? { type, run: a.run } : undefined;
  if (type === "terminal") return typeof a.go === "boolean" ? { type, go: a.go } : undefined;
  if (type === "setup") {
    const s = record(a.selection);
    const ok =
      s &&
      typeof s.model === "string" &&
      typeof s.effort === "string" &&
      typeof s.bypass === "boolean";
    return ok
      ? {
          type,
          selection: { model: s.model, effort: s.effort, bypass: s.bypass } as SetupSelection,
        }
      : undefined;
  }
  const answers = a.answers === null ? null : record(a.answers);
  const each =
    answers &&
    Object.values(answers).every(
      (v) => typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string")),
    );
  if (answers === undefined || (answers !== null && !each) || !strings(a.notes)) return undefined;
  // The agent matches answers to questions by their text: a key that names none is the app's, never passed on.
  // A skip answers none, so it has no note; a note is for an answered question (seam). An answer names one at least.
  if (request.type !== "question") return undefined;
  const texts = request.questions;
  const keys = answers ? Object.keys(answers) : [];
  if (answers && keys.length === 0) return undefined;
  if (!keys.every((k) => texts.includes(k))) return undefined;
  if (!Object.keys(a.notes as object).every((k) => keys.includes(k))) return undefined;
  return { type: "question", answers: answers as never, notes: a.notes as Record<string, string> };
}

export class Inbound {
  /**
   * The requests waiting for an answer, by the request's `refKey`: those asked in this run, and after a
   * restart those rebuilt from the bot's own kind 9 read back (`#ownRequest`).
   */
  readonly waiting = new Map<string, Waiting>();
  /** The requests this process saw withdrawn, rewritten or answered: a read-back never brings one back. */
  readonly #ended = new Set<string>();
  #o: InboundOptions;
  #reader: BotReader;
  #target: ChatInbound | undefined;
  #chain: Promise<void> = Promise.resolve();
  #latest = new Map<string, Reference>(); // the latest prompt handed on in each channel's thread, for a request to name
  #channels = new Map<string, Bytes>(); // the channel of each prompt or reply read, for the notices of `caughtUp`
  #replies = new Map<string, { name: Bytes; text: string }>(); // by prompt: its answer's name and the text of its replies
  #answered = new Set<string>(); // the prompts of this process that have their answer queued

  constructor(options: InboundOptions) {
    this.#o = options;
    this.#reader = new BotReader(
      options.platform,
      options.self,
      options.store.saved.incarnation ?? new Uint8Array(16),
      options.run,
      new Map(options.store.saved.decided),
    );
  }

  /** Opens the way to the core (`ChatProvider.start`); `undefined` closes it. */
  start(target: ChatInbound | undefined): void {
    this.#target = target;
  }

  /** Records a request the bot wrote, so that the owner's reply to it reaches `answer`. */
  expect(name: Bytes, request: Waiting): void {
    this.waiting.set(refKey({ device: this.#o.self, name }), request);
  }

  /**
   * The prompt a request in `thread` names (3.8): the latest the owner wrote there since this start, else
   * the one that opened it, whose sender and name the thread's id holds. `undefined` for an id that is no prompt's.
   */
  promptOf(ref: ThreadRef): Reference | undefined {
    const latest = this.#latest.get(`${ref.channel}/${ref.thread}`);
    if (latest) return latest;
    return referenceOf(ref.thread);
  }

  /**
   * What the replies written for `prompt` add up to: the name of its answer, which each part names,
   * chosen when the first one opens, and their whole text, which the answer holds (3.8).
   */
  replyOf(prompt: Reference): { name: Bytes; text: string } {
    const key = refKey(prompt);
    let reply = this.#replies.get(key);
    if (!reply) {
      reply = { name: this.#o.platform.random(16), text: "" };
      this.#replies.set(key, reply);
    }
    return reply;
  }

  /** Whether `prompt` has its answer queued or being queued: a reply's text after it is a text of the thread's, not a part. */
  closed(prompt: Reference): boolean {
    return this.#answered.has(refKey(prompt));
  }

  /** The request `name` waits on no more: it is withdrawn, rewritten or answered. */
  end(name: Bytes): void {
    const key = refKey({ device: this.#o.self, name });
    this.waiting.delete(key);
    this.#ended.add(key);
  }

  /** Told of each `Out` of the connection, after the outbox. */
  take(out: Out): void {
    if (out.do === "incarnation") {
      // A redial under the same incarnation reads on from the cursor: what is in flight stays (reading.ts, #serve).
      if (out.first || out.changed) this.#reader.newIncarnation(out.incarnation);
    } else if (out.do === "rest") {
      if (out.first) this.#queue(undefined, this.#reader.caughtUp());
      this.#channels.clear();
    } else if (out.do === "message") {
      const { message, place } = out;
      const h = message.header;
      if (bytesEqual(h.sender, this.#o.self) && (h.kind === 9 || h.kind === 11))
        this.#ownRequest(message, place.key);
      const step = this.#reader.read(message, place, () => "gone"); // files come with step 6: a prompt with one is not read (Q5)
      if (h.kind === 2 || h.kind === 10)
        this.#channels.set(refKey({ device: h.sender, name: h.name }), h.channel);
      this.#queue(h.channel, step.notices);
      if (!step.run) return;
      const run = step.run;
      // Stored before it is handed on: a crash after the hand-on is then read as a cut, never run again (5.8, condition 5).
      // A write that fails hands nothing on: the prompt is said cut after a restart (SD 5.8).
      this.#chain = this.#chain
        .then(() => this.#persist())
        .then(() => this.#handOn(run, h.channel), this.#stored)
        .catch(() => this.#o.log("relay: a hand-on failed"));
    }
  }

  /**
   * The bot's own request read back: after a restart it is what a reply to it needs to reach the core,
   * which answers false for it. An edit of one (a withdrawal or a rewrite) ends the wait. The requestId
   * is the message's name, which no live request has.
   */
  #ownRequest(message: Message, key: Bytes | undefined): void {
    const h = message.header;
    if (h.kind === 11) {
      if (h.re) this.end(h.re.name);
      return;
    }
    const at = refKey({ device: this.#o.self, name: h.name });
    if (this.waiting.has(at) || this.#ended.has(at)) return;
    const opened = key ? openMessage(this.#o.platform, key, message) : undefined;
    const body = opened?.ok ? parse(opened.value.content) : undefined;
    const type = record(body?.request)?.type;
    if (typeof body?.thread !== "string" || typeof type !== "string" || !Object.hasOwn(TYPES, type))
      return;
    const base = {
      requestId: toHex(h.name),
      ref: { channel: toHex(h.channel), thread: body.thread },
    };
    if (type === "question") {
      const questions = questionsOf(body.request);
      // A question request whose texts cannot be read waits for nothing: no answer could be checked.
      if (questions) this.waiting.set(at, { ...base, type, questions });
      return;
    }
    this.waiting.set(at, { ...base, type: type as Exclude<OwnerAnswer["type"], "question"> });
  }

  #stored = (e: Error) => this.#o.log(`relay: the store did not write: ${e.message}`);

  #persist(): Promise<void> {
    return this.#o.store.change((s) => {
      s.decided = new Map(this.#reader.decided);
    });
  }

  #queue(channel: Bytes | undefined, notices: Notice[]): void {
    for (const n of notices) {
      const to = channel ?? this.#channels.get(refKey(n.re));
      if (to) this.#put(to, { kind: n.kind, re: n.re, name: n.name, content: "{}" });
      else this.#o.log("relay: a notice had no channel");
    }
    if (notices.some((n) => n.kind !== 3)) this.#persist().catch(this.#stored); // a start is stored when it is read back
  }

  /** Queues a message; a refusal or a failed write is logged, and nothing more is claimed of it. */
  async #put(channel: Bytes, draft: Draft): Promise<boolean> {
    const queued = await this.#o.outbox.queue(channel, draft).catch((e: Error) => {
      this.#stored(e);
      return false;
    });
    if (!queued) this.#o.log("relay: a message was not queued");
    return queued;
  }

  /** Starts the hand-on and returns at once: the chain keeps the order of the calls, and a turn never holds the reading (C7). */
  #handOn(run: Prompt, channel: Bytes): void {
    const body = parse(run.body.content);
    if (run.answers) {
      void this.#answer(run, run.answers, body, channel);
      return;
    }
    const { device, name } = run.ref;
    const id = toHex(device) + toHex(name);
    const thread =
      typeof body?.thread === "string" && referenceOf(body.thread) ? body.thread : undefined;
    const target = this.#target;
    if (!target || typeof body?.text !== "string") {
      this.#o.log("relay: a prompt was not handed on");
      void this.#finish(
        run,
        channel,
        thread ?? id,
        "The bot did not run this prompt.",
        undefined,
        !!thread,
      );
      return;
    }
    const text = body.text;
    this.#latest.set(`${toHex(channel)}/${thread ?? id}`, run.ref);
    const message: InboundMessage = {
      ref: { channel: toHex(channel), thread: thread ?? id },
      id,
      topLevel: thread === undefined,
      text,
      plain: text,
      bare: text,
      literal: false,
      content: async () => text,
      // The core is done with the prompt: its replies are written, and the answer closes it. Not once
      // stopped: a prompt the core never finished stays unanswered, and is read as cut after a restart.
      handled: (session) => {
        if (!this.#target) return;
        const reply = this.#replies.get(refKey(run.ref));
        this.#replies.delete(refKey(run.ref));
        void this.#finish(run, channel, thread ?? id, reply?.text ?? "", reply?.name, session);
      },
    };
    // The core calls `handled` itself after any throw of its own, and says then whether it opened a
    // session: the relay answers on its own only a prompt the core never took (above).
    target.message(message).catch(() => {
      this.#o.log("relay: the core did not take a prompt");
    });
  }

  /**
   * The answer of a message the bot handed on (kind 5, `re` it): once queued, the message is done.
   * `session`: false writes `"session": false`, for a top-level prompt whose thread holds no session
   * (a word, a refusal, a prompt the bot did not run), which the app draws as a message.
   */
  async #finish(
    run: Prompt,
    channel: Bytes,
    thread: string,
    markdown: string,
    name?: Bytes,
    session = true,
  ): Promise<void> {
    // One answer per prompt (3.8): the first of the core's done, a refusal and a failure wins.
    const key = refKey(run.ref);
    if (this.#answered.has(key)) return;
    this.#answered.add(key);
    // The answer and the decision are one write: a crash between them would leave an answered prompt undecided.
    const queued = await this.#o.outbox
      .queue(
        channel,
        {
          kind: 5,
          re: run.ref,
          name,
          content: JSON.stringify({ thread, markdown, ...(session ? {} : { session: false }) }),
        },
        (saved) => {
          this.#reader.answered(run.ref);
          saved.decided = new Map(this.#reader.decided);
        },
      )
      .catch((e: Error) => {
        this.#stored(e);
        return false;
      });
    if (!queued) {
      this.#answered.delete(key); // nothing is claimed of an answer that was not queued
      this.#o.log("relay: a message was not queued");
    }
  }

  /**
   * A reply: a well-formed answer of the waiting request's type goes to the core, which says false for
   * a request no longer waiting (seam). Every reply is answered (kind 5), saying why when it was not
   * handed on; a malformed one leaves the request waiting, and a throw of the core keeps it too, so that
   * a correct retry can still arrive.
   */
  async #answer(
    run: Prompt,
    answers: Reference,
    body: Record<string, unknown> | undefined,
    channel: Bytes,
  ): Promise<void> {
    const key = refKey(answers);
    const request = this.waiting.get(key);
    const thread = request?.ref.thread ?? "";
    const target = this.#target;
    const answer = request && answerOf(body?.answer, request);
    let said = "";
    if (!request) said = "The bot is no longer waiting for this answer.";
    else if (!answer) said = "The bot could not read this answer.";
    else if (!target) said = "The bot could not take this answer.";
    else {
      try {
        // False: the core no longer waits on it, and it tells the owner itself (seam).
        if (!(await target.answer(request.ref, request.requestId, answer, null)))
          said = "The bot is no longer waiting for this answer.";
        this.end(answers.name);
      } catch {
        said = "The bot could not take this answer.";
      }
    }
    if (said) this.#o.log("relay: a reply was not handed on");
    await this.#finish(run, channel, thread, said);
  }
}
