/**
 * The memory chat's provider: the chat seam implemented over a `Room`, with every capability
 * false. Nothing streams, nothing reacts, no activity line, no session index, no file upload,
 * and a line for the owner alone is a message of the thread.
 *
 * The seam is read as written. A member that "never rejects" swallows a refusal of the room; one
 * that rejects with `ChatError` lets the room's through. A call for a capability this chat lacks
 * does nothing but leave a record in `Room.strayCalls`, which a test asserts empty. So does a
 * thread asked for that the chat never issued.
 */

import { isDeepStrictEqual } from "node:util";
import type { CallImage, Question } from "../../../src/agent/seam.ts";
import {
  type Activity,
  type AgentAccount,
  type ChannelBind,
  type ChannelChat,
  type ChatCapabilities,
  ChatError,
  type ChatInbound,
  type ChatProvider,
  type CommandSuggestion,
  type FooterFields,
  type LoopCard,
  type Markup,
  type MessageId,
  type OpenMessageChange,
  type OwnerList,
  type OwnerRequest,
  type Presence,
  type Reply,
  type RootStatus,
  type RunningList,
  type SessionIndex,
  type SessionStatus,
  type StatusOptions,
  type TaskUpdate,
  type ThreadChat,
  type ThreadList,
  type ThreadRef,
} from "../../../src/chat/seam.ts";
import { DAEMON, type MessageKind, type Placed, type Room, type StoredMessage } from "./room.ts";

const CAPABILITIES: ChatCapabilities = {
  nativeStreaming: false,
  rootStatus: false,
  acknowledgement: false,
  activityLine: false,
  fileUpload: false,
  threadLists: false,
  channelLists: true,
  lookups: true,
  messageFold: false,
  threadTags: false,
  threadPins: false,
  threadTitles: false,
  threadDelete: false,
  channelClean: false,
  threadOpen: true,
  commandSuggestions: false,
  loopCard: true,
  scheduledRunLine: false,
  nextPromptHint: false,
  lineImages: false,
};

/** The capabilities the memory chat declares only to record the calls made for them. */
export interface Recorded {
  readonly nativeStreaming?: boolean;
  readonly rootStatus?: boolean;
  readonly acknowledgement?: boolean;
  readonly activityLine?: boolean;
  /** With `activityLine`: what `ThreadChat.activityRefused` answers. */
  readonly activityRefused?: boolean;
  /** The two the memory chat declares unless false, as the relay does not. */
  readonly threadOpen?: boolean;
  readonly loopCard?: boolean;
  /** `scheduledRunLine` and `nextPromptHint`, which the memory chat declares only when true. */
  readonly scheduledRunLine?: boolean;
  readonly nextPromptHint?: boolean;
  /** `lineImages`, which the memory chat declares only when true: `ReplySink.image` records the call. */
  readonly lineImages?: boolean;
  /** The memory chat declares `channelLists` unless false, as the relay does not. */
  readonly channelLists?: boolean;
  /** The memory chat declares `lookups` unless false, as the relay does not. */
  readonly lookups?: boolean;
  /**
   * The provider has a session index (`ChatProvider.index`) and records each `refresh` as the
   * call `index.refresh`, with the sessions it names (none: any may have changed) and what
   * `page` answers at that moment, the way a page read when it is drawn.
   */
  readonly index?: { readonly page?: () => unknown };
}

/** The footer as one line of words. */
function footerLine(footer: FooterFields): string {
  const { changes, sessionTokens, contextPercent, sessionLimit, weekLimit } = footer;
  return [
    // No number: the scenarios run on the real clock, and their footers must read the same.
    footer.work === null ? null : "worked",
    footer.planning ? "plan" : footer.bypass ? "bypass" : null,
    footer.model,
    footer.effort === null || footer.effortObserved === null
      ? footer.effort
      : `${footer.effort} (${footer.effortObserved})`,
    footer.folder,
    footer.branch,
    footer.gitUntrusted ? "git not trusted" : null,
    changes === null ? null : `+${changes[0]} -${changes[1]}`,
    sessionTokens === null ? null : `${sessionTokens} tokens`,
    contextPercent === null ? null : `${contextPercent}% context`,
    sessionLimit === null ? null : `session ${sessionLimit.percent}%`,
    weekLimit === null ? null : `week ${weekLimit.percent}%`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

type Segment =
  | { readonly kind: "text"; text: string }
  | { readonly kind: "task"; update: TaskUpdate };

/** What a call's `signal` does (seam.ts): the caller stops waiting, the call runs to its end. */
export function releasing<T>(call: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return call;
  if (signal.aborted) {
    call.catch(() => undefined); // the call runs on: its rejection is no one's to see
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    call.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * One reply: a single message whose content grows. Its text and its task lines stand in the
 * order they first came; a task line changes where it stands. After `finish` a line of a run of
 * calls shows its folded words, or goes when they are empty, and from `rest` or `closeOut` on the
 * list of what still runs (on the reply the room names) and the footer are added. The message is
 * always an edit, so `rest` only lets them show.
 */
class MemoryReply implements Reply, Placed {
  readonly #room: Room;
  readonly #ref: ThreadRef;
  readonly #onOpen: OpenMessageChange;
  readonly #segments: Segment[] = [];
  #message: StoredMessage | null = null;
  #finished = false;
  #rested = false;
  #closed = false;
  /** The session's footer, once it is drawn under this reply; it stays for good. */
  #footer: string | null = null;
  /** The list of what still runs the room placed here. */
  #list: RunningList | null = null;
  #lost = false;
  #landed = false;
  readonly #landing: Promise<boolean>;
  #resolveLanding: (landed: boolean) => void = () => {};

  /** Present with `messageFold`. */
  readonly posted?: () => readonly MessageId[];

  /** Present with `lineImages`; the call is recorded and nothing is drawn. */
  readonly image?: (id: string, images: readonly CallImage[]) => Promise<void>;

  constructor(
    room: Room,
    ref: ThreadRef,
    onOpen: OpenMessageChange,
    folds = false,
    images = false,
  ) {
    if (folds) this.posted = () => (this.#message === null ? [] : [this.#message.id]);
    if (images) {
      this.image = async (id, held) => {
        room.record(ref, "image", [id, held]);
      };
    }
    this.#room = room;
    this.#ref = ref;
    this.#onOpen = onOpen;
    room.join(this);
    this.#landing = new Promise((resolve) => {
      this.#resolveLanding = resolve;
    });
  }

  get message(): StoredMessage | null {
    return this.#message;
  }

  get resting(): boolean {
    return this.#finished && (this.#rested || this.#landed);
  }

  assign(list: RunningList | null): void {
    if (isDeepStrictEqual(list, this.#list)) return;
    this.#list = list;
    if (this.#drawsFooter) this.#write();
  }

  async showFooter(footer: FooterFields): Promise<boolean> {
    this.#room.record(this.#ref, "showFooter", [footer]);
    // An end that did not land has no message the footer is known to sit under.
    if (!this.#landed) return false;
    if (!this.#room.edits) {
      // Nothing to rewrite: the footer is a message below the reply, once.
      this.#footer ??= footerLine(footer);
      try {
        this.#room.write(this.#ref.channel, this.#ref.thread, DAEMON, this.#footer, "notice");
        return true;
      } catch (error) {
        if (!(error instanceof ChatError)) throw error;
        this.#footer = null;
        return false;
      }
    }
    this.#footer ??= footerLine(footer);
    this.#write();
    return !this.#lost;
  }

  // A reply is one message that never moves, so it ends where it is whatever sits below it.
  get last(): boolean {
    if (this.#message === null) return false;
    const { others, marks } = this.#room.around(this.#message);
    const at = this.#message.position;
    return others.every((other) => other < at) && marks.every((mark) => mark < at);
  }

  get overtaken(): boolean {
    if (this.#message === null) return false;
    const at = this.#message.position;
    return this.#room.around(this.#message).others.some((other) => other > at);
  }

  async text(markdown: string): Promise<void> {
    this.#room.record(this.#ref, "text", [markdown]);
    await this.#room.passes("text");
    const last = this.#segments.at(-1);
    if (last?.kind === "text") last.text += markdown;
    else this.#segments.push({ kind: "text", text: markdown });
    this.#write();
    await this.#room.lag();
  }

  async task(update: TaskUpdate): Promise<void> {
    this.#room.record(this.#ref, "task", [update]);
    const held = this.#segments.find((s) => s.kind === "task" && s.update.id === update.id);
    if (held?.kind === "task") held.update = update;
    else this.#segments.push({ kind: "task", update });
    this.#write();
    await this.#room.lag();
  }

  /** A `signal` only releases the caller: the turn's end goes on once the call is let through. */
  finish(closing: readonly TaskUpdate[], signal?: AbortSignal): Promise<void> {
    return releasing(this.#finish(closing), signal);
  }

  async #finish(closing: readonly TaskUpdate[]): Promise<void> {
    await this.#room.passes("finish");
    for (const update of closing) await this.task(update);
    this.#finished = true;
    // What the reply writes is what the places would give it.
    this.#list = this.#room.listIf(this.#ref, this);
    this.#write();
    this.#room.place(this.#ref);
  }

  rest(): void {
    if (this.#rested) return;
    this.#rested = true;
    this.#list = this.#room.listIf(this.#ref, this);
    this.#write();
    this.#room.place(this.#ref);
  }

  /** The list shows once the reply waits (`rest`) or ended; a reply that only finished ends at once. */
  get #drawsFooter(): boolean {
    return this.#room.edits && this.#finished && (this.#rested || this.#closed);
  }

  /** A `signal` only releases the caller: the end goes on to land once the call is let through. */
  closeOut(signal?: AbortSignal): Promise<boolean> {
    return releasing(this.#closeOut(), signal);
  }

  async #closeOut(): Promise<boolean> {
    await this.#room.passes("closeOut", !this.#closed);
    if (this.#closed) return this.#landed;
    this.#closed = true;
    if (this.#message !== null && this.#room.refuses("closeOut", this.#message.id)) {
      // The end did not land: the message stays as it was, unfinished.
      this.#landed = false;
      this.#resolveLanding(false);
      return false;
    }
    this.#land();
    return this.#landed;
  }

  /** The end's own work, once the chat takes it: the list and the footer show, the reply is ended. */
  #land(): void {
    this.#list = this.#room.listIf(this.#ref, this);
    this.#write();
    this.#landed = !this.#lost;
    if (this.#landed && this.#message !== null) {
      this.#message.unfinished = false;
      this.#onOpen(this.#message.id, null);
    }
    if (this.#landed) this.#room.place(this.#ref);
    this.#resolveLanding(this.#landed);
  }

  /**
   * The chat's one retry of an end that did not land: it lands unless the chat still refuses it
   * (a refusal made `once` is used up by the first attempt).
   */
  #retryEnd(): boolean {
    if (!this.#closed || this.#landed) return this.#landed;
    if (this.#message !== null && this.#room.refuses("closeOut", this.#message.id)) return false;
    this.#land();
    return this.#landed;
  }

  waitLanded(signal?: AbortSignal): Promise<boolean> {
    return releasing(
      this.#room
        .passes("waitLanded")
        .then(() => this.#landing)
        .then((landed) => landed || this.#retryEnd()),
      signal,
    );
  }

  /** The last chance of a reply whose end did not land: one more try, then what it is. */
  async settle(): Promise<boolean> {
    this.#retryEnd();
    this.#write();
    return !this.#lost && (!this.#closed || this.#landed);
  }

  #render(): string {
    const lines = this.#segments.flatMap((segment) => {
      if (segment.kind === "text") return [segment.text.trim()];
      const { folded, preview, status, title } = segment.update;
      if (this.#finished && folded !== null) return [folded];
      // The preview is where the core keeps an answered question's answers: under the line.
      const shown = preview === null ? [] : [preview.title, preview.summary, preview.body];
      return [`[${status}] ${title}`, ...shown];
    });
    if (this.#drawsFooter) {
      const list = this.#list;
      if (list !== null) {
        lines.push(list.title);
        for (const { text, agent } of list.lines) {
          lines.push(
            agent === null
              ? `- ${text}`
              : `- ${text} · ${agent.calls} ${agent.calls === 1 ? "call" : "calls"}`,
          );
          if (agent !== null) lines.push(`  ⎿ ${agent.step}`);
        }
      }
      lines.push(this.#footer ?? "");
    }
    return lines.filter((line) => line !== "").join("\n");
  }

  /** Brings the message to what the reply is now; a refusal of the room is a write that did not land. */
  #write(): void {
    const text = this.#render();
    try {
      if (this.#message === null) {
        if (text === "") return;
        this.#message = this.#room.write(
          this.#ref.channel,
          this.#ref.thread,
          DAEMON,
          text,
          "reply",
        );
        this.#message.unfinished = true;
        this.#onOpen(null, this.#message.id);
        // A reply below the one that shows the list takes it off that one at once.
        this.#room.place(this.#ref);
      } else {
        // A write the chat refuses (`Room.refuse("rewrite", id)`) is one that did not land.
        if (this.#room.refuses("rewrite", this.#message.id)) throw new ChatError("refused");
        this.#room.edit(this.#message, text);
      }
      this.#lost = false;
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
      this.#lost = true;
    }
  }
}

/** The record of an answered question: each question and what was answered to it. */
function answered(
  questions: readonly Question[],
  answers: Readonly<Record<string, string | readonly string[]>>,
): string {
  return questions
    .flatMap((question) => {
      const answer = answers[question.text];
      if (answer === undefined) return [];
      return [`${question.text}: ${typeof answer === "string" ? answer : answer.join(", ")}`];
    })
    .join("\n");
}

// The loop card of each thread, by room: a thread object is made afresh for every lookup.
const loopCards = new WeakMap<Room, Map<string, StoredMessage>>();

/** A list as one message: its title, then a line per file with its counts, or per prompt. */
function listText(list: ThreadList, title: string): string {
  if (list.type === "rewind-points") {
    return [title, ...list.points.map((point) => point.text)].join("\n");
  }
  if (list.type === "rewind-actions") {
    const { files } = list;
    return [
      `${title}: ${list.point.text}`,
      ...(files === null
        ? []
        : [`code: ${files.count} files +${files.insertions} -${files.deletions}`]),
      ...(list.conversation ? ["conversation"] : []),
    ].join("\n");
  }
  if (list.type === "suggestion") return [title, list.text].join("\n");
  const rows = list.files.map((file) =>
    file.large
      ? `${file.path} large`
      : file.binary
        ? `${file.path} binary`
        : `${file.path} +${file.added} -${file.removed}`,
  );
  const views = list.views.map((view) => (view.id === list.view ? `[${view.label}]` : view.label));
  const shown = list.shown === undefined ? [] : [`shown ${list.shown.path}`, list.shown.text];
  return [title, views.join(" "), ...rows, ...shown].join("\n");
}

class MemoryThread implements ThreadChat {
  readonly #room: Room;
  readonly #ref: ThreadRef;
  /** Present with `threadLists`. */
  readonly offer?: (list: ThreadList, title: string, replacing?: MessageId) => Promise<MessageId>;
  /** Present with `fileUpload`. */
  readonly share?: (file: {
    readonly name: string;
    readonly title: string;
    readonly content: Uint8Array;
  }) => Promise<string | null>;
  /** Present with `fileUpload`. */
  readonly unshare?: (file: string) => Promise<void>;
  /** Present with `threadLists` and a limit on what a list holds. */
  readonly fitsList?: (list: ThreadList, title: string) => boolean;
  /** Present with `messageFold`. */
  readonly fold?: (message: MessageId, title: string) => Promise<boolean>;
  /** Present with `rootStatus`: the call is recorded, and the status is shown unless refused. */
  readonly showStatus?: (status: RootStatus, options?: StatusOptions) => Promise<boolean>;
  /** Present with `rootStatus`. */
  readonly clearStatus?: () => Promise<void>;
  /** Present with `rootStatus`. */
  readonly settleStatus?: () => Promise<void>;
  /** Present with `scheduledRunLine`. */
  readonly scheduledRun?: (at: number) => Promise<void>;
  /** Present with `nextPromptHint`; the call is recorded and nothing is drawn. */
  readonly suggestNext?: (text: string) => Promise<void>;
  /** Present with `acknowledgement`. */
  readonly acknowledge?: (message: MessageId) => Promise<void>;
  /** Present with `activityLine`. */
  readonly showActivity?: (activity: Activity | null) => void;
  /** Present with `activityLine`; reading it is recorded. */
  readonly activityRefused?: boolean;
  readonly #folds: boolean;
  readonly #images: boolean;

  constructor(
    room: Room,
    ref: ThreadRef,
    lists: boolean,
    files: boolean,
    folds: boolean,
    fits: number | undefined,
    recorded: Recorded,
  ) {
    this.#room = room;
    this.#ref = ref;
    this.#folds = folds;
    this.#images = recorded.lineImages === true;
    if (recorded.rootStatus === true) {
      this.showStatus = async (status, options) => {
        room.record(ref, "showStatus", [status, options]);
        const root = room.rootOf(ref);
        return root === null || !room.refuses("showStatus", root.id);
      };
      this.clearStatus = async () => {
        room.record(ref, "clearStatus", []);
      };
      this.settleStatus = async () => {
        room.record(ref, "settleStatus", []);
      };
    }
    if (recorded.scheduledRunLine === true) {
      // The time as the memory chat draws any moment: fixed, in UTC, so that a test can read it.
      this.scheduledRun = async (at) => {
        const time = new Date(at).toISOString().slice(0, 16);
        await this.#post(`Running scheduled task (${time} UTC)`, "notice").catch(() => {});
      };
    }
    if (recorded.nextPromptHint === true) {
      this.suggestNext = async (text) => {
        room.record(ref, "suggestNext", [text]);
      };
    }
    if (recorded.acknowledgement === true) {
      this.acknowledge = async (message) => {
        room.record(ref, "acknowledge", [message]);
      };
    }
    if (recorded.activityLine === true) {
      this.showActivity = (activity) => {
        room.record(ref, "showActivity", [activity]);
      };
      Object.defineProperty(this, "activityRefused", {
        get: () => {
          room.record(ref, "activityRefused", []);
          return recorded.activityRefused === true;
        },
      });
    }
    if (folds) {
      // The title is what the message shows now; what it showed is kept behind it.
      this.fold = async (id, title) => {
        const message = room.message(id);
        if (message === null || message.channel !== ref.channel) return false;
        try {
          const inside = message.text;
          room.edit(message, title);
          message.inside = inside;
        } catch (error) {
          if (!(error instanceof ChatError)) throw error;
          return false;
        }
        message.kind = "notice";
        room.settled(id);
        return true;
      };
    }
    if (lists) {
      this.offer = async (list, title, replacing) => {
        if (room.shownRefused && list.type === "diff" && list.shown !== undefined) {
          throw new ChatError("refused");
        }
        const text = listText(list, title);
        const held = replacing === undefined ? null : room.message(replacing);
        let message: StoredMessage;
        if (held === null) {
          message = room.write(ref.channel, ref.thread, DAEMON, text, "list");
        } else {
          room.edit(held, text);
          message = held;
        }
        room.addThreadList({ message: message.id, ref, list, title }, replacing);
        return message.id;
      };
    }
    if (lists && fits !== undefined) {
      this.fitsList = (list) => list.type !== "diff" || (list.shown?.text.length ?? 0) <= fits;
    }
    if (files && !room.noShare) {
      this.share = async (file) =>
        room.addShared({
          ref,
          name: file.name,
          title: file.title,
          content: Buffer.from(file.content).toString("utf8"),
        });
      if (!room.noUnshare) {
        this.unshare = async (file) => {
          if (room.unshareRefused) throw new ChatError("refused");
          room.removeShared(file);
        };
      }
    }
  }

  openReply(onOpenMessage: OpenMessageChange): Reply {
    return new MemoryReply(this.#room, this.#ref, onOpenMessage, this.#folds, this.#images);
  }

  showRunning(list: RunningList | null): void {
    this.#room.showRunning(this.#ref, list);
  }

  written(): void {}

  async notice(text: string): Promise<MessageId | null> {
    return this.#post(text, "notice").catch(() => null);
  }

  async ask(requestId: string, request: OwnerRequest, title: string): Promise<MessageId> {
    // A chat that places a post outside a thread whose first message is gone (#221) tells
    // the core so; this one refuses the same way.
    if (!this.#room.knowsThread(this.#ref)) {
      throw new ChatError("thread_gone", { permanent: true, failure: "gone" });
    }
    const message = this.#room.write(this.#ref.channel, this.#ref.thread, DAEMON, title, "request");
    this.#room.addRequest({ requestId, message: message.id, ref: this.#ref, request, title });
    return message.id;
  }

  async withdraw(request: MessageId): Promise<boolean> {
    await this.#room.passes("withdraw");
    if (this.#room.refuses("withdraw", request)) return false;
    this.#room.remove(request);
    return true;
  }

  async keepAnswers(
    request: MessageId,
    questions: readonly Question[],
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): Promise<void> {
    rewritten(this.#room, request, answered(questions, answers));
  }

  async rewrite(message: MessageId, text: string): Promise<void> {
    rewritten(this.#room, message, text);
  }

  async tell(text: string, options?: { readonly stays?: boolean }): Promise<void> {
    // Recorded, not derived from: this chat has no line for the owner alone, so a `tell` that
    // stays and one that does not look alike on screen; the core's choice is read from the call.
    this.#room.record(this.#ref, "tell", [text, options]);
    if (!this.#room.knowsThread(this.#ref)) {
      this.#room.dropped.push(text); // the seam: a line for a gone thread is dropped
      return;
    }
    await this.#post(text, "notice").catch(() => {});
  }

  async say(markdown: string, options?: { readonly ownerOnly?: boolean }): Promise<void> {
    this.#room.record(this.#ref, "say", [markdown, options]);
    await this.#post(markdown, "reference");
  }

  async link(): Promise<string | null> {
    return null;
  }

  async endReply(reply: MessageId, note: string): Promise<boolean> {
    if (this.#room.refuses("endReply", reply)) return false;
    const message = this.#room.message(reply);
    if (message === null) return true;
    try {
      this.#room.edit(message, `${message.text}\n${note}`);
      message.unfinished = false;
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
      return false;
    }
    return true;
  }

  async showLoop(card: LoopCard): Promise<void> {
    // The time as the memory chat draws any moment: fixed, in UTC, so that a test can read it.
    const label = `${card.label} · ${new Date(card.at).toISOString().slice(11, 16)} UTC`;
    const footer = card.footer === null ? "" : footerLine(card.footer);
    const text = [label, card.text, footer].filter((part) => part !== "").join("\n");
    const cards = loopCards.get(this.#room) ?? new Map<string, StoredMessage>();
    loopCards.set(this.#room, cards);
    const key = `${this.#ref.channel}/${this.#ref.thread}`;
    try {
      const held = cards.get(key);
      if (held !== undefined && this.#room.message(held.id) !== null) {
        this.#room.edit(held, text);
      } else {
        cards.set(
          key,
          this.#room.write(this.#ref.channel, this.#ref.thread, DAEMON, text, "notice"),
        );
      }
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
    }
  }

  get loopCardLast(): boolean {
    const held = loopCards.get(this.#room)?.get(`${this.#ref.channel}/${this.#ref.thread}`);
    if (held === undefined) return false;
    return this.#room.messages(this.#ref.channel, this.#ref.thread).at(-1)?.id === held.id;
  }

  async endLoop(line: string): Promise<void> {
    loopCards.get(this.#room)?.delete(`${this.#ref.channel}/${this.#ref.thread}`);
    await this.#post(line, "notice").catch(() => {});
  }

  async close(): Promise<void> {}

  async #post(text: string, kind: MessageKind): Promise<MessageId> {
    return this.#room.write(this.#ref.channel, this.#ref.thread, DAEMON, text, kind).id;
  }
}

/** Rewrites a message into a notice with nothing left to press; `ChatError` for one that is not there. */
function rewritten(room: Room, id: MessageId, text: string): void {
  if (room.refuses("rewrite", id)) throw new ChatError("refused", { failure: "refused" });
  const message = room.message(id);
  if (message === null) throw new ChatError("message_not_found");
  room.edit(message, text);
  room.settled(id);
  message.kind = "notice";
}

class MemoryChannel implements ChannelChat {
  readonly #room: Room;
  readonly #channel: string;

  /** Present with `channelLists`. */
  readonly offer?: (list: OwnerList, title: string) => Promise<void>;

  constructor(room: Room, channel: string, lists: boolean) {
    this.#room = room;
    this.#channel = channel;
    if (lists) {
      this.offer = async (list, title) => {
        const message = room.write(channel, null, DAEMON, title, "list");
        room.addList({ message: message.id, channel, list, title });
      };
    }
  }

  async notice(text: string, answers?: MessageId, bind?: ChannelBind): Promise<MessageId | null> {
    this.#answered("notice", text, answers);
    // The folder a `/bind` answer carries, recorded as `calls("bind")`; the text is drawn as ever.
    if (bind !== undefined) this.#room.record(null, "bind", [text, bind]);
    return this.#room.write(this.#channel, null, DAEMON, text, "notice").id;
  }

  async say(markdown: string, answers?: MessageId): Promise<void> {
    this.#answered("say", markdown, answers);
    this.#room.write(this.#channel, null, DAEMON, markdown, "reference");
  }

  /** The channel lines that answer a prompt of the owner's are recorded with it, as `calls("answers")`. */
  #answered(how: string, text: string, answers?: MessageId): void {
    if (answers !== undefined) this.#room.record(null, "answers", [how, text, answers]);
  }

  async open(markdown: string, lead?: { lead: string; words: string }): Promise<ThreadRef> {
    const root = this.#room.write(this.#channel, null, DAEMON, markdown, "reference", true);
    const ref = { channel: this.#channel, thread: root.thread as string };
    if (lead !== undefined) this.#room.keepLead(ref, lead);
    return ref;
  }

  async withdraw(list: MessageId): Promise<boolean> {
    await this.#room.passes("withdraw");
    if (this.#room.refuses("withdraw", list)) return false;
    this.#room.remove(list);
    return true;
  }

  async rewrite(list: MessageId, text: string): Promise<void> {
    rewritten(this.#room, list, text);
  }

  // This chat has no line for the owner alone: it is a notice of the channel.
  async tell(text: string): Promise<void> {
    this.#room.write(this.#channel, null, DAEMON, text, "notice");
  }
}

/** The chat provider over a room. */
export class MemoryProvider implements ChatProvider {
  readonly name = "Memory chat";
  readonly identities: readonly string[];
  readonly capabilities: ChatCapabilities;
  /** Present with `fileUpload`. */
  readonly fileLimit?: number;
  /** Present with `commandSuggestions`: the suggestion is a message the owner sends a text from. */
  readonly suggestCommands?: (ref: ThreadRef, suggestion: CommandSuggestion) => Promise<void>;
  /** Present with `Recorded.index`. */
  readonly index?: SessionIndex;
  /** Present with `rootStatus`: the call is recorded. */
  readonly statusMark?: (status: SessionStatus) => string;
  readonly #room: Room;
  readonly #lists: boolean;
  readonly #files: boolean;
  readonly #folds: boolean;
  readonly #fits: number | undefined;
  readonly #recorded: Recorded;
  #inbound: ChatInbound | null = null;

  constructor(
    room: Room,
    identities: readonly string[],
    suggests = false,
    lists = false,
    files = false,
    fileLimit = 1 << 20,
    folds = false,
    fits?: number,
    recorded: Recorded = {},
  ) {
    this.#room = room;
    this.#fits = fits;
    this.#recorded = recorded;
    this.identities = identities;
    this.#lists = lists;
    this.#files = files;
    this.#folds = folds;
    if (files) this.fileLimit = fileLimit;
    this.capabilities = {
      ...CAPABILITIES,
      commandSuggestions: suggests,
      threadLists: lists,
      channelLists: recorded.channelLists !== false,
      lookups: recorded.lookups !== false,
      messageFold: folds,
      fileUpload: files,
      nativeStreaming: recorded.nativeStreaming === true,
      rootStatus: recorded.rootStatus === true,
      acknowledgement: recorded.acknowledgement === true,
      activityLine: recorded.activityLine === true,
      threadOpen: recorded.threadOpen !== false,
      loopCard: recorded.loopCard !== false,
      scheduledRunLine: recorded.scheduledRunLine === true,
      nextPromptHint: recorded.nextPromptHint === true,
      lineImages: recorded.lineImages === true,
    };
    if (recorded.lookups !== false) {
      this.channelState = async (channel) => {
        if (room.lookupFails()) return "no answer";
        return room.knows(channel) ? "there" : "gone";
      };
      this.threadState = async (ref) => {
        if (room.lookupFails()) return "no answer";
        return room.knowsThread(ref) ? "there" : "gone";
      };
    }
    if (recorded.index !== undefined) {
      const page = recorded.index.page;
      this.index = {
        refresh: (changed) =>
          room.record(null, "index.refresh", [
            changed === undefined ? null : [...changed],
            page?.(),
          ]),
      };
    }
    if (recorded.rootStatus === true) {
      this.statusMark = (status: SessionStatus) => {
        room.record(null, "statusMark", [status]);
        return `status ${status}`;
      };
    }
    if (suggests) {
      this.suggestCommands = async (ref, suggestion) => {
        const lines = suggestion.candidates.map((c) => `${c.text} ${c.description}`.trim());
        const message = room.write(
          ref.channel,
          ref.thread,
          DAEMON,
          [`field: ${suggestion.typed}`, ...lines].join("\n"),
          "suggestion",
        );
        room.addSuggestion({ message: message.id, ref, suggestion });
      };
    }
  }

  thread(ref: ThreadRef): ThreadChat {
    // A thread is a name the chat gave out: the core builds none from something else (a message id).
    if (this.#room.openedAt(ref) === null) this.#room.stray(`thread ${ref.channel}/${ref.thread}`);
    return new MemoryThread(
      this.#room,
      ref,
      this.#lists,
      this.#files,
      this.#folds,
      this.#fits,
      this.#recorded,
    );
  }

  channel(channel: string): ChannelChat {
    return new MemoryChannel(this.#room, channel, this.capabilities.channelLists);
  }

  escape(text: string, markup: Markup): string {
    // The chat's control characters of `words`, as a chat with markup would write them.
    if (markup === "words")
      return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return text;
  }

  channelName(channel: string, _markup: Markup): string {
    return `#${channel}`;
  }

  leadOf(ref: ThreadRef): { lead: string; words: string } | null {
    return this.#room.leadOf(ref);
  }

  openedAt(ref: ThreadRef): number | null {
    return this.#room.openedAt(ref);
  }

  get cleanupControl(): string | undefined {
    return this.#room.cleanupControl ?? undefined;
  }

  /** Present with `lookups`. */
  readonly channelState?: (channel: string) => Promise<Presence>;
  /** Present with `lookups`. */
  readonly threadState?: (ref: ThreadRef) => Promise<Presence>;

  agentAccount(account: AgentAccount | null): void {
    this.#room.accounts.push(account);
  }

  async start(inbound: ChatInbound): Promise<void> {
    this.#inbound = inbound;
    this.#room.attach(inbound);
  }

  async stop(): Promise<void> {
    if (this.#inbound !== null) this.#room.detach(this.#inbound);
  }

  async close(): Promise<void> {}
}
