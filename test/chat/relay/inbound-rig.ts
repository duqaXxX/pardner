/**
 * The rig of `inbound.test.ts`, shared with `app-answers.test.ts`: real sealed and signed messages of
 * `test/protocol/sequence.ts` fed to `Inbound` as the connection would, the outbox and the store replaced
 * by records.
 */
import { Inbound } from "../../../src/chat/relay/inbound.ts";
import type { Outbox } from "../../../src/chat/relay/outbox.ts";
import type { Store } from "../../../src/chat/relay/store.ts";
import type { ChatInbound, InboundMessage, OwnerAnswer } from "../../../src/chat/seam.ts";
import type { Message } from "../../../src/protocol/messages.ts";
import type { Draft } from "../../../src/protocol/outbox.ts";
import type { Bytes } from "../../../src/protocol/platform.ts";
import { Bot } from "../../protocol/bot.ts";
import { epochOf, fill, Party, Sequence } from "../../protocol/sequence.ts";

export const inc = fill(9, 16);
export const E1 = epochOf(1);
export const SEL = { model: "default", effort: "default", bypass: false };
export const wait = () => new Promise((r) => setTimeout(r, 20));

export function rig() {
  const app = new Party();
  const bot = new Bot(inc).owns(app);
  const seq = new Sequence();
  const queued: { channel: Bytes; draft: Draft }[] = [];
  const saved = { incarnation: inc, decided: new Map() };
  const store = {
    saved,
    change: async (edit: (s: typeof saved) => void) => edit(saved),
  } as unknown as Store;
  const outbox = {
    queue: async (channel: Bytes, draft: Draft, also?: (s: typeof saved) => void) => {
      also?.(saved); // the same write as the message
      return !!queued.push({ channel, draft });
    },
  } as unknown as Outbox;
  const logs: string[] = [];
  const inbound = new Inbound({
    platform: bot.platform,
    self: bot.id,
    store,
    outbox,
    run: bot.run,
    log: (l) => logs.push(l),
  });
  const messages: InboundMessage[] = [];
  const answers: [string, OwnerAnswer][] = [];
  let hold: Promise<void> = Promise.resolve();
  const throwing = { on: false };
  const target = {
    message: (m: InboundMessage) => {
      messages.push(m);
      return hold;
    },
    answer: async (_ref: unknown, id: string, a: OwnerAnswer) => {
      answers.push([id, a]);
      if (throwing.on) throw new TypeError("the core threw");
      return true;
    },
  } as unknown as ChatInbound;
  inbound.start(target);
  let fed = 0;
  /** Feeds what the sequence gained, in order, each at the bot's place. */
  const feed = async (place = bot.place) => {
    for (; fed < seq.items.length; fed++) {
      inbound.take({ do: "message", message: seq.items[fed] as Message, place, position: fed });
    }
    await wait();
  };
  /** The bot's queued notices, written and read back: its starts are of its run. */
  const echo = async () => {
    for (const { channel, draft } of queued.splice(0)) {
      bot.say({ ...draft, content: "{}" });
      bot.flush(seq, E1, inc, channel); // in the channel of its prompt
      bot.outbox = [];
    }
    await feed();
  };
  const prompt = (content: object, to = bot.id) => {
    app.say({ kind: 2, to, content: JSON.stringify(content) });
    app.flush(seq, E1, inc);
  };
  /** What the reading emits on a redial under the same incarnation: no rewind, it reads on. */
  const reconnect = () =>
    inbound.take({ do: "incarnation", incarnation: inc, first: false, changed: false });
  return {
    throwing,
    reconnect,
    app,
    bot,
    seq,
    queued,
    store,
    inbound,
    messages,
    answers,
    logs,
    feed,
    echo,
    prompt,
    hold: (p: Promise<void>) => (hold = p),
  };
}
