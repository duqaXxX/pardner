import type { Clock } from "../../src/clock.ts";
import { ELSEWHERE, memoryChat, OWNER, SOMEONE } from "../support/memory-chat.ts";
import { type ChatRig, chatConformance, type Person } from "./chat.ts";

// ---- the memory chat

const STEADY: Clock = { sleep: async () => {}, time: () => 1_780_000_000 };

function memoryPerson(
  person: ReturnType<ReturnType<typeof memoryChat>["as"]>,
  who: string,
  order: ReturnType<typeof ordering> = ordering(),
): Person {
  return {
    says: async (channel, text, options) => {
      const sent = await order.run(() => person.says(channel, text, options));
      return { id: sent.id, ref: sent.ref, author: who };
    },
    answers: async (asked, answer) => {
      await person.answers(asked.requestId, answer);
    },
    picks: async (listed, row) => {
      await person.picks(listed.message, row);
    },
    picksFile: async (listed, path) => {
      await person.picksFile(listed.message, path);
    },
    picksView: async (listed, view) => {
      await person.picksView(listed.message, view);
    },
    picksPoint: async (listed, promptId) => {
      await person.picksPoint(listed.message, promptId);
    },
    picksAction: async (listed, action) => {
      await person.picksAction(listed.message, action);
    },
    picksSuggested: async (listed, send) => {
      await person.picksSuggested(listed.message, send);
    },
    deletes: async (said) => {
      await person.deletes(said);
    },
    stops: async (ref) => {
      await order.run(() => person.stops(ref));
    },
    types: async (shown, _ref, text) => {
      if (shown.id === null) throw new Error("a suggestion is a message of the chat");
      await person.types(shown.id, text);
    },
  };
}

/**
 * A stand-in for a provider's slow check: the memory chat checks nothing and calls `inbound` as
 * the owner acts, so its rig makes the owner's sends one after the other, in the order they were
 * made, and holds the next one on request. It orders whole handlings, where a provider orders up
 * to the handover alone, which is enough for the contract: the handover order is the send order.
 */
function ordering() {
  let tail: Promise<unknown> = Promise.resolve();
  let gate: Promise<void> | null = null;
  return {
    run<T>(act: () => Promise<T>): Promise<T> {
      const mine = gate ?? Promise.resolve();
      gate = null;
      const result = tail.then(() => mine).then(act);
      tail = result.catch(() => {});
      return result;
    },
    hold(): { readonly held: Promise<void>; release(): void } {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { held: Promise.resolve(), release };
    },
  };
}

async function memoryRig(
  threadIds: "own" | "opening" = "own",
  without: { channelLists?: false; lookups?: false } = {},
): Promise<ChatRig> {
  const chat = memoryChat({ suggestions: true, threadIds, lists: true, folds: true, ...without });
  const provider = await chat.build({
    variables: {},
    allowedRoot: "/work",
    scratchDir: "/scratch",
    clock: STEADY,
    steady: STEADY,
    core: () => {
      throw new Error("the memory chat never reads the core");
    },
  });
  const channel = chat.openChannel("work");
  const sends = ordering();
  return {
    provider,
    channel,
    thread: chat.openThread(channel),
    owner: memoryPerson(chat.as(OWNER), OWNER, sends),
    holdNextCheck: () => sends.hold(),
    other: memoryPerson(chat.as(SOMEONE), SOMEONE),
    ownerElsewhere: memoryPerson(chat.as(OWNER, ELSEWHERE), OWNER),
    keep: (thread) => chat.keepThread(thread),
    ownerOnlyNotices: false,
    read: (scope) =>
      chat.messages(scope.channel, scope.thread).map((m) => ({
        id: m.id,
        // A folded message shows its title, and keeps what it showed inside.
        text: m.inside === null ? m.text : `${m.text}\n${m.inside}`,
        pressable: m.pressable,
        ownerOnly: false,
      })),
    settle: async () => {},
    refuseWrites: () => chat.removeChannel(channel),
    removeChannel: (gone) => chat.removeChannel(gone),
    removeThread: (gone) => chat.removeThread(gone),
    failLookups: () => chat.failChannelLookups(),
  };
}

chatConformance("the memory chat", () => memoryRig());
// A thread named by its opening message's id, as some chats' are: the other thread model of the seam.
chatConformance("the memory chat, threads named by their opening message", () =>
  memoryRig("opening"),
);
// The relay's shape: no list in a channel and no lookup. What those capabilities serve is skipped by name.
chatConformance("the memory chat without channel lists and lookups", () =>
  memoryRig("own", { channelLists: false, lookups: false }),
);
