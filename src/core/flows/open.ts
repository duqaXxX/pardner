/** `ChatInbound.openFile`, answered from the thread's entry in `state.json`: never a live session or a turn. */
import { posix } from "node:path";
import type { ChatInbound } from "../../chat/seam.ts";
import { errorName } from "../../values.ts";
import { openPath, titleIn } from "../files/openable.ts";
import { NotAFile, TooLarge } from "../files/read.ts";
import { sizeText } from "../guide.ts";
import * as texts from "../texts.ts";
import { fill, named } from "../texts.ts";
import { type FlowDeps, logger } from "./talk.ts";

/** Whether the agent says a call of the session named a path; a record it cannot read says no. */
export function touchedBy(deps: FlowDeps, folder: string, session: string | null) {
  const { agent } = deps;
  if (session === null || agent.touched === undefined) return undefined;
  return (path: string): Promise<boolean> =>
    agent.touched?.(folder, session, path).catch((error: unknown) => {
      logger.warning(`could not read the session's record for a file: ${errorName(error)}`);
      return false;
    }) ?? Promise.resolve(false);
}

export function openFile(deps: FlowDeps): NonNullable<ChatInbound["openFile"]> {
  return async (ref, path) => {
    const stored = deps.state.thread(ref.channel, ref.thread);
    if (stored === null || stored.sessionId === null) return { refusal: texts.OPEN_TOP_LEVEL };
    const limit = deps.chat.fileLimit;
    if (!deps.chat.capabilities.fileUpload || limit === undefined) {
      return { refusal: named(texts.OPEN_UNAVAILABLE, deps.names) };
    }
    const { directory } = stored;
    try {
      const opened = await openPath(
        directory,
        directory,
        path,
        limit,
        touchedBy(deps, directory, stored.sessionId),
      );
      if (opened.content.length === 0) return { refusal: fill(texts.SHARE_EMPTY, { path }) };
      const title = await titleIn(directory, opened.target, path);
      return {
        name: posix.basename(title),
        title,
        content: opened.content,
        modified: opened.modified,
      };
    } catch (error) {
      if (error instanceof NotAFile) return { refusal: fill(texts.OPEN_NOT_OPENABLE, { path }) };
      if (error instanceof TooLarge) {
        return { refusal: fill(texts.SHARE_TOO_LARGE, { path, size: sizeText(limit) }) };
      }
      throw error;
    }
  };
}
