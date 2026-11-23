/**
 * The relay chat as the seam's provider (design 3.8, 3.9): every capability false, the lines of the
 * daemon's own written as texts (kind 1), and the owner's prompts and answers handed to the core
 * by `Inbound`; a request to the owner (kind 9) and its withdrawal or rewrite (kind 11) are written
 * here. A reply is written as parts (kind 4), each naming the answer its prompt gets when the core is
 * done with the prompt (`Inbound`, 3.8), and the turn's tool calls as lines (a text, then an edit when the
 * line changes); the footer and the running list draw nothing.
 */

import { refKey } from "../../protocol/device-reader.ts";
import type { Bytes, Platform } from "../../protocol/platform.ts";
import {
  type AgentAccount,
  type ChannelBind,
  type ChannelChat,
  type ChatCapabilities,
  ChatError,
  type ChatInbound,
  type ChatProvider,
  type MessageId,
  type OwnerRequest,
  type Reply,
  type TaskUpdate,
  type ThreadChat,
  type ThreadRef,
} from "../seam.ts";
import { fromHex, referenceOf, toHex } from "./hex.ts";
import { type Inbound, questionsOf } from "./inbound.ts";
import { fitLine, type Line } from "./line.ts";
import type { Outbox } from "./outbox.ts";

const NONE: ChatCapabilities = {
  nativeStreaming: false,
  rootStatus: false,
  acknowledgement: false,
  activityLine: false,
  fileUpload: false,
  threadLists: false,
  channelLists: false,
  lookups: false,
  messageFold: false,
  threadTags: false,
  threadPins: false,
  threadTitles: false,
  threadDelete: false,
  channelClean: false,
  threadOpen: false,
  commandSuggestions: false,
  loopCard: false,
};

/** What a request's body may hold: the frame (1 MiB, PD 6.7) less room for the header, the signature and the seal. */
const REQUEST_ROOM = 1_048_576 - 4096;

/** The request as the app needs it: the core's id and the agent's call id stay on the bot (store the minimum). */
const shown = (request: OwnerRequest) =>
  Object.fromEntries(Object.entries(request).filter(([k]) => k !== "requestId" && k !== "callId"));

/** A part holds at most 64 KiB of text (3.8); a longer text becomes several, cut between characters. */
const PART = 65_536;

/** `text` in pieces of at most `PART` bytes of UTF-8, none cut inside a character. */
export function splitParts(text: string): string[] {
  const pieces: string[] = [];
  let from = 0;
  let at = 0;
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > PART) {
      pieces.push(text.slice(from, at));
      from = at;
      bytes = 0;
    }
    at += character.length;
    bytes += size;
  }
  if (at > from) pieces.push(text.slice(from));
  return pieces;
}

/** The start, stop and end of the connection the provider runs over. */
export interface Link {
  start(): void;
  stop(): Promise<void>;
  close(): void;
  /** The agent's account, for the bot's profile (bot-profile design 4.3). */
  account?(account: AgentAccount | null): void;
}

export class RelayProvider implements ChatProvider {
  readonly name = "relay";
  readonly identities: readonly string[];
  readonly capabilities = NONE;
  #outbox: Outbox;
  #inbound: Inbound;
  #self: Bytes;
  #random: Platform["random"];
  #link: Link | undefined;
  #steady: { time(): number } | undefined;
  #now: () => number;

  constructor(
    self: Bytes,
    outbox: Outbox,
    inbound: Inbound,
    platform: Pick<Platform, "random" | "now">,
    link?: Link,
    steady?: { time(): number },
  ) {
    this.#link = link;
    this.#steady = steady;
    this.#now = () => platform.now();
    this.#self = self;
    this.#random = (length) => platform.random(length);
    this.identities = [`relay:${toHex(self)}`];
    this.#outbox = outbox;
    this.#inbound = inbound;
  }

  /** A text of the bot's own (3.8): `say` says how the app draws it. */
  async #text(
    channel: string,
    say: "notice" | "say" | "tell",
    markdown: string,
    thread?: string,
    answers?: MessageId,
    bind?: ChannelBind,
  ) {
    // A line that answers a top-level prompt names it (`re`), which is how the app draws it under that prompt.
    const re = answers ? referenceOf(answers) : undefined;
    // A long text is several texts, each at most 64 KiB (3.8).
    const pieces = splitParts(markdown);
    const parts = pieces.length ? pieces : [markdown];
    for (const [index, piece] of parts.entries()) {
      // The folder rides the first piece only: a reader takes it from the answer's start.
      const content = JSON.stringify({
        ...(thread ? { thread } : {}),
        say,
        markdown: piece,
        ...(bind && index === 0 ? { bind } : {}),
      });
      const queued = await this.#outbox.queue(fromHex(channel), { kind: 1, re, content });
      if (!queued) throw new ChatError("relay_not_queued", { failure: "failed" });
    }
  }

  /**
   * A request to the owner (3.8): its name is the message id, kept with the id, thread and type the
   * answer must have before anything is written, so that no reply can arrive first.
   */
  async #ask(ref: ThreadRef, requestId: string, request: OwnerRequest, title: string) {
    const re = this.#inbound.promptOf(ref);
    if (!re) throw new ChatError("relay_no_prompt", { failure: "refused", permanent: true });
    const body = shown(request);
    const content = JSON.stringify({ thread: ref.thread, request: body, title });
    // A request is not split: one that cannot fit is refused, so the core says it could not be shown.
    if (Buffer.byteLength(content) > REQUEST_ROOM)
      throw new ChatError("relay_too_large", { failure: "refused", permanent: true });
    const name = this.#random(16);
    // The texts come from the body as written, as `#ownRequest` reads them after a restart.
    const questions = questionsOf(body);
    if (request.type === "question") {
      if (!questions) throw new ChatError("relay_not_queued", { failure: "failed" });
      this.#inbound.expect(name, { requestId, ref, type: request.type, questions });
    } else this.#inbound.expect(name, { requestId, ref, type: request.type });
    const queued = await this.#outbox
      .queue(fromHex(ref.channel), { kind: 9, re, name, content })
      .catch(() => false);
    if (!queued) {
      this.#inbound.waiting.delete(refKey({ device: this.#self, name }));
      throw new ChatError("relay_not_queued", { failure: "failed" });
    }
    return toHex(name);
  }

  /** An edit of the bot's own request (kind 11): once queued, nothing waits on the request. False when it was not queued. */
  async #edit(ref: ThreadRef, request: MessageId, body: object): Promise<boolean> {
    const name = fromHex(request);
    if (name.length !== 16) return false;
    const content = JSON.stringify({ thread: ref.thread, ...body });
    const queued = await this.#outbox
      .queue(fromHex(ref.channel), { kind: 11, re: { device: this.#self, name }, content })
      .catch(() => false);
    if (queued) this.#inbound.end(name);
    return queued;
  }

  /**
   * A reply (3.8). While the prompt it is for has no answer yet, its text is written as parts (kind 4) that name
   * that answer and is added to its text. Text written after the answer, or by a reply with no prompt of its own
   * (a report turn), goes out as texts of the thread (kind 1): no part names an answer that is sent or never will be.
   */
  #reply(ref: ThreadRef, prompt?: MessageId): Reply {
    const outbox = this.#outbox;
    const inbound = this.#inbound;
    const me = this.#self;
    const random = this.#random;
    const wall = this.#now;
    const steady = this.#steady;
    const reference = prompt ? referenceOf(prompt) : undefined;
    const names: Bytes[] = [];
    let lost = false;
    const write = async (
      kind: number,
      name: Bytes,
      content: string,
      re?: { device: Bytes; name: Bytes },
    ) => {
      const draft = { kind, re, name, content };
      if (await outbox.queue(fromHex(ref.channel), draft).catch(() => false)) names.push(name);
      else lost = true;
    };
    // The lines written for this reply, by the core's id: the line's text name and the update as last written.
    // A line is no part of `names`: one the outbox refuses must not make the reply unlanded (design 2.5).
    const lines = new Map<string, { name: Bytes; last: TaskUpdate }>();
    let finished = false;
    const lineOf = (u: TaskUpdate): Line => {
      const { id: _id, name: _name, folded: _folded, startedAt, ...rest } = u;
      const ago = steady && startedAt !== null ? (steady.time() - startedAt) * 1000 : null;
      return { ...rest, startedAt: ago === null ? null : Math.round(wall() - ago) };
    };
    /** Writes a line's text (`first`) or its edit, both by the text's `name`; true when queued. */
    const putLine = async (u: TaskUpdate, name: Bytes, first: boolean) => {
      const frame = first ? { thread: ref.thread, say: "task" } : { thread: ref.thread };
      const content = fitLine(frame, lineOf(u), REQUEST_ROOM);
      if (content === undefined) return;
      const draft = first
        ? { kind: 1, re: reference, name, content }
        : { kind: 11, re: { device: me, name }, content };
      return outbox.queue(fromHex(ref.channel), draft).catch(() => false);
    };
    const writing = () => !!reference && !finished && !inbound.closed(reference);
    // A line's edit follows when its status, output or preview changed; at the turn's end, when any field did.
    const changed = (a: TaskUpdate, b: TaskUpdate, any: boolean) =>
      any
        ? JSON.stringify(a) !== JSON.stringify(b)
        : a.status !== b.status ||
          a.output !== b.output ||
          JSON.stringify(a.preview) !== JSON.stringify(b.preview);
    const update = async (u: TaskUpdate, closing: boolean) => {
      const held = lines.get(u.id);
      if (!held) {
        const name = random(16);
        // Kept whether or not the queue said yes: a refusal is mostly a store write that failed after the draft
        // was held, so writing the line again would show one call twice. A line too large to write is not kept.
        if ((await putLine(u, name, true)) !== undefined) lines.set(u.id, { name, last: u });
      } else if (changed(held.last, u, closing) && (await putLine(u, held.name, false)))
        held.last = u;
    };
    const landed = (signal?: AbortSignal) =>
      lost ? Promise.resolve(false) : outbox.landed(names, signal);
    return {
      last: true, // a reply is never moved: nothing below it changes where it ends
      overtaken: false,
      async text(markdown, options) {
        const pieces = splitParts(markdown);
        if (reference && !inbound.closed(reference)) {
          const answer = inbound.replyOf(reference);
          answer.text += markdown;
          if (pieces.length === 0 && options?.ending) pieces.push("");
          for (const [i, piece] of pieces.entries()) {
            const ending = options?.ending && i === pieces.length - 1;
            const content = JSON.stringify({
              thread: ref.thread,
              markdown: piece,
              ...(ending ? { ending } : {}),
            });
            await write(4, random(16), content, { device: me, name: answer.name });
          }
        } else {
          for (const piece of pieces) {
            const content = JSON.stringify({ thread: ref.thread, say: "say", markdown: piece });
            await write(1, random(16), content);
          }
        }
      },
      async task(u) {
        if (writing()) await update(u, false);
      },
      async finish(closing, signal) {
        if (writing()) for (const u of closing) if (!signal?.aborted) await update(u, true);
        finished = true;
      },
      rest() {},
      showFooter: async () => false, // owed: the footer is read and offered again (seam)
      // At once, as the seam splits it: false when a part is still unread, and the core then waits in `waitLanded`.
      closeOut: async () => !lost && outbox.holds(names),
      waitLanded: landed,
      // A last look: whether the reply has landed now. It never waits, so an idle close does not stall on an unreachable relay.
      settle: async () => !lost && outbox.holds(names),
    };
  }

  thread(ref: ThreadRef): ThreadChat {
    const text = (say: "notice" | "say" | "tell") => (markdown: string) =>
      this.#text(ref.channel, say, markdown, ref.thread);
    return {
      showRunning() {},
      openReply: (_onOpen, prompt) => this.#reply(ref, prompt),
      written() {},
      notice: text("notice"),
      say: text("say"),
      tell: text("tell"),
      ask: (requestId, request, title) => this.#ask(ref, requestId, request, title),
      withdraw: (request) => this.#edit(ref, request, { withdrawn: true }),
      keepAnswers: async (request) => {
        if (!(await this.#edit(ref, request, { answered: true })))
          throw new ChatError("relay_not_queued", { failure: "failed" });
      },
      rewrite: async (message, markdown) => {
        if (!(await this.#edit(ref, message, { markdown })))
          throw new ChatError("relay_not_queued", { failure: "failed" });
      },
      link: async () => null,
      endReply: async () => false,
      close: async () => {},
    };
  }

  channel(channel: string): ChannelChat {
    const text = (say: "notice" | "say" | "tell") => (markdown: string, answers?: MessageId) =>
      this.#text(channel, say, markdown, undefined, answers);
    return {
      notice: async (markdown, answers, bind) => {
        // Placed in the outbox before the first await, as `bind.ts` relies on.
        await this.#text(channel, "notice", markdown, undefined, answers, bind);
        return null;
      },
      say: text("say"),
      tell: (markdown) => text("tell")(markdown),
      withdraw: async () => false,
      rewrite: async () => {},
    };
  }

  escape = (text: string) => text;
  channelName = (channel: string) => channel.slice(0, 8);
  openedAt = () => null;

  async start(inbound: ChatInbound): Promise<void> {
    this.#inbound.start(inbound);
    this.#link?.start();
  }
  /** The agent's account, handed to the bot's profile. */
  agentAccount(account: AgentAccount | null): void {
    this.#link?.account?.(account);
  }

  /** Nothing reaches the core from here on, and no reply waits on a read-back that cannot come. */
  async stop(): Promise<void> {
    this.#inbound.start(undefined);
    this.#outbox.release();
    await this.#link?.stop();
  }
  async close(): Promise<void> {
    this.#link?.close();
  }
}
