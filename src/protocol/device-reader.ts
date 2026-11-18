import { bytesEqual } from "./bytes.ts";
import { idKey } from "./device-log.ts";
import type { Message, MessageHeader, Reference } from "./messages.ts";

/** The key of a prompt, by its sender and name: the store's, and every device's. */
export const refKey = (r: Reference): string => `${idKey(r.device)}${idKey(r.name)}`;

/**
 * What a device remembers of the messages it accepted, in memory (security design 5.6). The caller
 * builds a new one when it reads the sequence again from the start.
 */
export class Seen {
  #slots = new Set<string>();
  #names = new Set<string>();

  #slot = (h: MessageHeader) => `${idKey(h.epoch)}${idKey(h.sender)}${idKey(h.run)}${h.counter}`;
  #name = (h: MessageHeader) => `${idKey(h.sender)}${idKey(h.name)}`;

  /**
   * "again": the sender, run and counter were accepted in that epoch (condition 4): refuse it.
   * "copy": a new counter under a name of that sender already shown, a message built again: accepted,
   * not shown a second time. "first": shown. It records nothing: `add` does, once the message is
   * read, so that one a bot has to read again (a file it waits for) is not refused the second time.
   */
  check(h: MessageHeader): "first" | "copy" | "again" {
    if (this.#slots.has(this.#slot(h))) return "again";
    return this.#names.has(this.#name(h)) ? "copy" : "first";
  }

  /** Records an accepted message. */
  add(h: MessageHeader): void {
    this.#slots.add(this.#slot(h));
    this.#names.add(this.#name(h));
  }
}

/** How a prompt is shown: an answer wins; then a removed bot, as the model's R9; then the bot's cut or not-read notice (SD 5.8). */
export type PromptState = "answered" | "cut" | "unread" | "removed" | "open";

/**
 * The state of `prompt` in the accepted `messages`. Only what the bot it is addressed to wrote
 * counts; `botActive` is whether the device log still holds that bot.
 */
export function promptState(
  messages: readonly Message[],
  prompt: Message,
  botActive: boolean,
): PromptState {
  const { to: bot, sender, name } = prompt.header;
  if (!bot) return "open";
  const key = refKey({ device: sender, name });
  let said: PromptState = "open";
  for (const { header: h } of messages) {
    if (!bytesEqual(h.sender, bot) || !h.re || refKey(h.re) !== key) continue;
    if (h.kind === 5) return "answered";
    if (h.kind === 6) said = "cut";
    else if (h.kind === 7 && said === "open") said = "unread";
  }
  return !botActive ? "removed" : said;
}

/** An edit is honoured only from the writer of the message it replaces, with the address that message had. */
export const editHonoured = (original: MessageHeader, edit: MessageHeader): boolean =>
  bytesEqual(original.sender, edit.sender) &&
  (original.to === undefined
    ? edit.to === undefined
    : edit.to !== undefined && bytesEqual(original.to, edit.to));
