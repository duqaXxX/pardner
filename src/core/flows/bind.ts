/**
 * `/bind`, typed or picked from the list of folders: which folder a channel's next thread
 * starts in. The core decides which folders the list holds and what the answer says; the chat
 * draws the list.
 */
import type { ChannelBind, ListPick, MessageId } from "../../chat/seam.ts";
import { compareCodePoints } from "../../text.ts";
import { errorName } from "../../values.ts";
import { type Refusal, resolveDirectory, untrustedNotice } from "../sessions/directory.ts";
import {
  DirectoryMissing,
  type DirectoryUnavailable,
  DirectoryUnreadable,
  DirectoryUntrusted,
} from "../sessions/errors.ts";
import * as texts from "../texts.ts";
import { fill, named } from "../texts.ts";
import type { BindFlow } from "./contract.ts";
import { type FlowDeps, isCancelled, logger, type Talk } from "./talk.ts";

/**
 * The answer to a bind: what keeps a session from starting in the folder, if anything
 * (`BIND_UNAVAILABLE` keeps priority: what would stop every session there matters more than
 * where an existing thread's session lives), else the old folders existing threads keep working
 * in, if any. `inNotice` makes a folder safe to stand inside the notice.
 */
export function boundText(
  directory: string,
  unavailable: DirectoryUnavailable | null,
  oldFolders: readonly string[],
  inNotice: (text: string) => string,
): string {
  if (unavailable !== null) {
    return fill(texts.BIND_UNAVAILABLE, {
      directory: inNotice(directory),
      reason: unavailable.message,
    });
  }
  if (oldFolders.length === 0) {
    return fill(texts.BIND_OK, { directory: inNotice(directory) });
  }
  const old = oldFolders.map((folder) => `\`${inNotice(folder)}\``).join(", ");
  return fill(texts.BIND_OK_ELSEWHERE, { directory: inNotice(directory), old });
}

/** A folder picked from the list, and what follows `/bind <folder>`. */
export interface Binding extends BindFlow {
  /** The pick of a folder from a list `list()` posted. */
  picked(pick: Extract<ListPick, { type: "folder" }>): Promise<void>;
}

// What the owner is told for each reason a typed path binds nothing.
const REFUSALS: Readonly<Record<Refusal, string>> = {
  missing: texts.BIND_MISSING,
  file: texts.BIND_FILE,
  outside: texts.BIND_OUTSIDE,
};

/** The state a folder check names; null for an unavailability this reply has no word for. */
function stateOf(unavailable: DirectoryUnavailable | null): ChannelBind["state"] | null {
  if (unavailable === null) return "usable";
  if (unavailable instanceof DirectoryUntrusted) return "untrusted";
  if (unavailable instanceof DirectoryMissing) return "missing";
  if (unavailable instanceof DirectoryUnreadable) return "unreadable";
  return null;
}

export function binding(deps: FlowDeps, talk: Talk): Binding {
  const { agent, chat, sessions, state, names, allowedRoot } = deps;
  const inNotice = (text: string): string => chat.escape(text, "notice");

  /**
   * An answer to a bind, with the channel's folder as stored and its state, when it has one. The
   * stored folder is read last and `inChannel` follows with no await between (a notice takes its
   * place among the channel's lines at the call, `ChannelChat.notice`), so of two binds in flight
   * the last reply names the folder the store ends with. A check awaits, so a folder changed
   * meanwhile is read again. A refusal always reaches the owner: a check that fails sends the text alone.
   */
  const reply = async (
    channel: string,
    text: string,
    answers?: MessageId,
    known?: { directory: string; unavailable: DirectoryUnavailable | null },
  ): Promise<void> => {
    let checked = known;
    for (;;) {
      const folder = state.channel(channel)?.directory;
      if (folder === undefined) return talk.inChannel(channel, text, answers);
      if (checked?.directory === folder) {
        const bindState = stateOf(checked.unavailable);
        return talk.inChannel(
          channel,
          text,
          answers,
          bindState === null ? undefined : { folder, state: bindState },
        );
      }
      try {
        checked = { directory: folder, unavailable: await sessions.unavailable(folder) };
      } catch (error) {
        if (isCancelled(error)) throw error;
        logger.warning(`could not check the bound folder for a bind reply: ${errorName(error)}`);
        return talk.inChannel(channel, text, answers);
      }
    }
  };

  /** The folder a typed path or a pick names, inside the allowed root; null, told, otherwise. */
  const folderNamed = async (
    channel: string,
    path: string,
    answers?: MessageId,
  ): Promise<string | null> => {
    const resolved = resolveDirectory(path, allowedRoot);
    if ("directory" in resolved) return resolved.directory;
    const refusal = REFUSALS[resolved.refused];
    await reply(
      channel,
      fill(refusal, { path: inNotice(path), root: inNotice(allowedRoot) }),
      answers,
    );
    return null;
  };

  /** The repositories below `directory` still to trust; a failed lookup is logged and names none. */
  const untrusted = async (directory: string): Promise<string[]> => {
    try {
      return await untrustedNotice(agent, directory, names, inNotice);
    } catch (error) {
      if (isCancelled(error)) throw error;
      logger.warning(`could not look for repositories to trust: ${errorName(error)}`);
      return [];
    }
  };

  // Thread entries keep their own folder either side of the bind (`StateStore.bind`), so the
  // old folders can be read now: those of the channel's threads that differ from the new one.
  const announce = async (
    channel: string,
    directory: string,
    answers?: MessageId,
  ): Promise<void> => {
    const unavailable = await sessions.unavailable(directory);
    const record = state.channel(channel);
    const threads = record === null ? [] : [...record.threads.values()];
    const oldFolders = [
      ...new Set(threads.map((thread) => thread.directory).filter((old) => old !== directory)),
    ].sort(compareCodePoints);
    // A folder no session can start in names no repository below it: that comes first.
    const below = unavailable === null ? await untrusted(directory) : [];
    await reply(
      channel,
      [boundText(directory, unavailable, oldFolders, inNotice), ...below].join("\n"),
      answers,
      { directory, unavailable },
    );
  };

  return {
    async to(channel, path, answers) {
      const directory = await folderNamed(channel, path, answers);
      if (directory === null) return;
      if (!(await sessions.bind(channel, directory))) {
        await reply(channel, texts.BIND_BUSY, answers);
        return;
      }
      await announce(channel, directory, answers);
    },

    async list(channel, answers) {
      const picker = chat.channel(channel);
      if (!chat.capabilities.channelLists || picker.offer === undefined) {
        const root = inNotice(allowedRoot);
        const line = fill(texts.BIND_NO_LIST, { root });
        const trust = agent.capabilities.folderTrust ? named(texts.BIND_NO_LIST_TRUST, names) : "";
        await talk.inChannel(channel, [line, trust].filter(Boolean).join(" "), answers);
        return;
      }
      const record = state.channel(channel);
      const folders = await sessions.foldersIn(allowedRoot);
      // An agent with no record of trust is offered every folder: no title names its trust.
      const trusted =
        folders.length > 0 ? named(texts.BIND_LIST, names) : named(texts.BIND_EMPTY, names);
      const title = fill(agent.capabilities.folderTrust ? trusted : texts.BIND_LIST_ANY, {
        root: allowedRoot,
      });
      await picker.offer(
        {
          type: "folders",
          root: allowedRoot,
          folders,
          bound: record === null ? null : record.directory,
        },
        title,
      );
    },

    async picked(pick) {
      const { channel } = pick;
      // The pick is not trusted: its folder goes through the same check as a typed `/bind`.
      const directory = await folderNamed(channel, pick.path);
      if (directory === null) return;
      const record = state.channel(channel);
      if (record !== null && record.directory === directory) {
        await reply(channel, fill(texts.BIND_ALREADY, { directory: inNotice(directory) }));
        return;
      }
      // A list can be old: unlike a typed `/bind`, a pick never ends work in flight either.
      if (!(await sessions.bind(channel, directory))) {
        await reply(channel, texts.BIND_BUSY);
        return;
      }
      await announce(channel, directory);
      // The list is a message of the channel, not a thread's request: withdrawn through the
      // channel, as `/resume` does.
      if (!talk.stopped) await chat.channel(channel).withdraw(pick.list);
    },
  };
}
