/** The notice the daemon owes a channel after a restart, posted once the chat is connected. */
import type { ChatProvider } from "../../chat/seam.ts";
import { getLogger } from "../../log.ts";
import { errorName } from "../../values.ts";
import type { RestartNotice, StateStore } from "../state.ts";
import * as texts from "../texts.ts";
import { fill } from "../texts.ts";
import { clockTime } from "./update.ts";

export const logger = getLogger("pardner.core.flows.notices");

/**
 * The message a restart asked from the chat left (`state.json`'s `restart_notice`), rewritten in
 * place into what happened: the daemon is back, on the version asked or not. `notice` is what the
 * file held before the chat could hear the owner (a restart asked since is another's to rewrite),
 * `installed` the version that runs and `now` the wall-clock seconds. The key is forgotten
 * whatever the outcome (the message deleted, the chat refusing), so a start never rewrites twice,
 * and only while it is still `notice`.
 */
export async function rewriteRestartNotice(
  chat: ChatProvider,
  state: Pick<StateStore, "clearRestartNotice">,
  notice: RestartNotice | null,
  installed: string,
  now: number,
): Promise<void> {
  if (notice === null) return;
  const text =
    notice.version === null
      ? fill(texts.UPDATE_RESTARTED, { time: clockTime(now) })
      : notice.version === installed
        ? fill(texts.UPDATE_DONE, { version: installed })
        : fill(texts.UPDATE_NOT_TAKEN, { installed, asked: notice.version });
  try {
    await chat.channel(notice.channel).rewrite(notice.message, text);
  } catch (error) {
    logger.warning(
      `could not rewrite the restart notice in ${notice.channel}: ${errorName(error)}`,
    );
  }
  try {
    state.clearRestartNotice(notice);
  } catch (error) {
    logger.warning(`could not forget the restart notice: ${errorName(error)}`);
  }
}
