/**
 * The memory chat as the chat of the session harness: the engine's tests run on the chat that
 * implements the seam and nothing else. The channel and the thread are the neutral ids of
 * `ids.ts`, so a test names them as the tests of the core do. A capability is on only where a
 * test asks for it (`MemoryChatOptions`); the calls made for it are read with `MemoryChat.calls`.
 */
import { ChatError } from "../../src/chat/seam.ts";
import { CHANNEL, THREAD } from "./ids.ts";
import { type MemoryChatOptions, memoryChat, OWNER } from "./memory-chat.ts";
import type { ChatSetup } from "./sessions.ts";
import { SettledClock } from "./settle.ts";

/**
 * What the relay chat declares (`src/chat/relay/provider.ts`, `NONE`): no capability at all, so
 * `threadOpen` and `loopCard`, which the memory chat otherwise declares, are off. Every harness on
 * the memory chat starts from it: a block turns on what it reads.
 */
export const RELAY_SET: MemoryChatOptions = { threadOpen: false, loopCard: false };

/** The memory chats of one test: every harness it makes shares one room. */
export function memoryChats(options: MemoryChatOptions = {}): ChatSetup {
  const entry = memoryChat({ ...RELAY_SET, ...options });
  const channel = entry.openChannel(CHANNEL.replace("chan-", ""));
  if (channel !== CHANNEL) throw new Error(`the memory chat names its channel ${channel}`);
  return {
    make: () => {
      const clock = new SettledClock();
      const chat = entry.provide(clock);
      entry.adopt({ channel, thread: THREAD });
      return {
        chat,
        channel,
        thread: THREAD,
        clock,
        texts: () => entry.written(channel).map((message) => message.text),
        // The listener tells the chat of every owner message before the core sees it.
        heard: (where, thread) => {
          entry.adopt({ channel: where, thread });
          try {
            entry.write(where, thread, OWNER, "a message of the owner", "message");
          } catch (error) {
            // A test that took the channel away: the owner's message is not the daemon's to refuse.
            if (!(error instanceof ChatError)) throw error;
          }
        },
        room: entry,
      };
    },
    reset: () => {},
  };
}
