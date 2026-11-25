/**
 * The model's request to share a file of the session's folder into its thread (`DaemonActions.share`):
 * read inside the bound folder alone, answered as a line for the model instead of a message to the owner.
 */

import { basename } from "node:path";
import { ChatError, type ThreadChat } from "../../chat/seam.ts";
import { getLogger } from "../../log.ts";
import { errorName } from "../../values.ts";
import { type OpenedPath, openPath, titleIn } from "../files/openable.ts";
import { NotAFile, TooLarge } from "../files/read.ts";
import { sizeText } from "../guide.ts";
import {
  fill,
  SHARE_DONE,
  SHARE_EMPTY,
  SHARE_NOT_A_FILE,
  SHARE_REFUSED,
  SHARE_STOPPED,
  SHARE_TOO_LARGE,
} from "../texts.ts";

/** The part of a thread's chat a share needs: the upload is there, or no share is offered. */
export interface ShareTarget {
  readonly share: NonNullable<ThreadChat["share"]>;
  readonly written: ThreadChat["written"];
}

const logger = getLogger("pardner.core.sessions.share");

/**
 * Shares `path` (untrusted: the model wrote it; absolute, or relative to `working`, the folder the
 * session works in) into `thread`, up to `limit` bytes. Containment is checked against `folder`,
 * the bound one, so a working folder outside it shares nothing; `touched`, which only typed `/open`
 * passes, lets a file the session's calls named through (`openPath`). Resolves with the line for the model, a refusal included; rejects only for a failure
 * that is no refusal. The signal is checked before the upload: the chat has no abort for a call
 * in flight.
 */
export async function shareFile(
  folder: string,
  working: string,
  thread: ShareTarget,
  limit: number,
  path: string,
  signal: AbortSignal,
  touched?: (path: string) => Promise<boolean>,
  refusal = SHARE_NOT_A_FILE,
): Promise<string> {
  const stopped = fill(SHARE_STOPPED, { path });
  if (signal.aborted) return stopped;
  if (path === "") return fill(refusal, { path });
  let opened: OpenedPath;
  try {
    opened = await openPath(folder, working, path, limit, touched);
  } catch (error) {
    if (error instanceof NotAFile) return fill(refusal, { path });
    if (error instanceof TooLarge) return fill(SHARE_TOO_LARGE, { path, size: sizeText(limit) });
    throw error;
  }
  const { content } = opened;
  // Refused here, not left to whatever the chat answers to an upload of length 0.
  if (content.length === 0) return fill(SHARE_EMPTY, { path });
  if (signal.aborted) return stopped;
  const title = await titleIn(folder, opened.target, path);
  try {
    await thread.share({ name: basename(title), title, content });
  } catch (error) {
    if (!(error instanceof ChatError)) throw error;
    // The chat's own code, never the file or its path.
    logger.warning(`could not share a file for the model: ${errorName(error)}`);
    return fill(SHARE_REFUSED, { path: title, error: error.name });
  }
  // The chat clears a thread's status line when the app shares into it.
  thread.written();
  return fill(SHARE_DONE, { path: title });
}
