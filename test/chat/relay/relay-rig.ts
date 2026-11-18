import assert from "node:assert/strict";
import { type Clock, Connection } from "../../../src/chat/relay/connection.ts";
import { Inbound } from "../../../src/chat/relay/inbound.ts";
import { Outbox } from "../../../src/chat/relay/outbox.ts";
import { botPlatform, loadPairing, pair } from "../../../src/chat/relay/pairing.ts";
import { identityOf, Store } from "../../../src/chat/relay/store.ts";
import type { ChatInbound, InboundMessage, OwnerAnswer } from "../../../src/chat/seam.ts";
import { decode } from "../../../src/protocol/bytes.ts";
import {
  checkDeviceEntry,
  idKey,
  type LoggedEntry,
  readDevice,
} from "../../../src/protocol/device-log.ts";
import type { LoggedEpoch } from "../../../src/protocol/epochs.ts";
import { deviceId, signedId } from "../../../src/protocol/ids.ts";
import { checkMemberEntry, type LoggedMember } from "../../../src/protocol/member-log.ts";
import {
  decodeMessage,
  type MessageHeader,
  openMessage,
  sealMessage,
} from "../../../src/protocol/messages.ts";
import { Run } from "../../../src/protocol/outbox.ts";
import type { Bytes } from "../../../src/protocol/platform.ts";
import type { Out } from "../../../src/protocol/reading.ts";
import type { Sequence } from "../../../src/relay/sequence.ts";
import { platform } from "../../relay/support.ts";
import {
  addBody,
  epochEntry,
  fill,
  keyed,
  memberEntry,
  person,
  signedBy,
} from "../../relay/world.ts";
import { dial } from "../../support/scripted-device/link.ts";
import { RelayProcess } from "../../support/scripted-device/relay-process.ts";
import { tempDirSync } from "../../support/temp.ts";

export const hex = (b: Bytes) => Buffer.from(b).toString("hex");
export type Submit = (kind: 3 | 4, signed: Bytes, sig: Bytes) => Promise<number | undefined>;

export let counter = 0;
export let sent = 0;
/** A relay, alice with the bot added and a channel with its first epoch sealed to both. */
export async function rig() {
  const tag = `in${++counter}`;
  const relay = new RelayProcess();
  const target = await relay.open();
  const alice = person(keyed("app", `${tag}-app`), keyed("app", `${tag}-sheet`));
  const dir = tempDirSync("pardner-chat-");
  const string = await pair(dir, alice.id, target.relay);
  const bot = decode(Uint8Array.from(Buffer.from(string, "hex")), (r) => ({
    device: readDevice(r),
    proof: r.sig(),
  }));
  assert.ok(bot.ok);
  const log: LoggedEntry[] = [];
  const everyKey: Bytes[] = []; // the key of every epoch of every channel, for `body`
  let relayIncarnation: Bytes = new Uint8Array(16);
  const as = async <T>(use: (link: Awaited<ReturnType<typeof dial>>) => Promise<T>) => {
    const link = await dial(platform, target.port, target.relay);
    link.enrol(target.secret as Bytes, alice.genesis);
    const served = await link.proveActive(alice.id, alice.first.id, alice.first.sign);
    assert.equal(served.type, "served");
    relayIncarnation = (served as unknown as { incarnation: Bytes }).incarnation;
    try {
      return await use(link);
    } finally {
      link.close();
    }
  };
  const put = async (kind: 1 | 2 | 3, e: { signed: Bytes; sig: Bytes }) => {
    const answer = await as((link) => link.submit(kind, e));
    assert.deepEqual(answer, { type: "result", request: 1, code: 0 });
  };
  const genesis = checkDeviceEntry(platform, [], alice.genesis.signed, alice.genesis.sig);
  assert.ok(genesis.ok);
  log.push(genesis.value);
  const device = async (body: Record<string, unknown>) => {
    const e = alice.entry(log, body);
    await put(1, e);
    const v = checkDeviceEntry(platform, log, e.signed, e.sig);
    assert.ok(v.ok);
    log.push(v.value);
  };
  await device({ kind: "add", device: bot.value.device, proof: bot.value.proof });
  /** A channel of alice's with its first epoch, sealed to alice and the bot. */
  const open = async (nonce: number) => {
    const members: LoggedMember[] = [];
    const epochs: LoggedEpoch[] = [];
    const keys: Bytes[] = [];
    const create = memberEntry(alice, [], { kind: "create", nonce: fill(nonce, 16) });
    await put(2, create);
    const channel = signedId(platform, create.signed);
    const m = checkMemberEntry(platform, [], create.signed, create.sig, log);
    assert.ok(m.ok);
    members.push(m.value);
    /** alice's next epoch at the heads she holds. */
    const epoch = async () => {
      const seq = {
        channels: new Map([[idKey(channel), { members, epochs }]]),
        devices: new Map([[idKey(alice.id), log]]),
      } as unknown as Sequence;
      const e = epochEntry(seq, channel, { person: alice, device: alice.first }, [alice]);
      await put(3, e);
      epochs.push({ entry: e.entry, id: signedId(platform, e.signed) });
      keys.push(e.key);
      everyKey.push(e.key);
    };
    await epoch();

    /** A message of alice's in the channel's first epoch. */
    const send = async (
      header: Partial<MessageHeader>,
      content: object,
    ): Promise<{ name: string }> => {
      const epoch = epochs[0] as LoggedEpoch;
      const signed = sealMessage(
        platform,
        keys[0] as Bytes,
        {
          channel,
          counter: ++sent,
          epoch: epoch.id,
          sender: alice.first.id,
          run: fill(4, 16),
          incarnation: fill(5, 16),
          time: 1_700_000_000_000,
          kind: 2,
          name: fill(100 + sent, 16),
          ...header,
        },
        { files: [], content: JSON.stringify(content) },
      );
      const e = signedBy(alice.first, signed);
      assert.equal(((await as((link) => link.submit(4, e))) as { code: number }).code, 0);
      const sealed = decodeMessage(signed);
      assert.ok(sealed.ok);
      return { name: hex(sealed.value.header.name) };
    };
    return { channel, epoch, send };
  };
  const first = await open(3);
  return {
    relay,
    dir,
    channel: first.channel,
    /** Another channel of alice's, its first epoch sealed to alice and the bot. */
    open,
    alice,
    botId: deviceId(platform, bot.value.device.signing, bot.value.device.receiving),
    send: first.send,
    epoch: first.epoch,
    /** The relay's incarnation, as a device proving itself is told it. */
    async incarnation(): Promise<Bytes> {
      await as(async () => {});
      return relayIncarnation;
    },
    port: target.port,
    /** The content of a message `held` gave, opened in the first epoch's key, as the device would. */
    body(m: { signed: Bytes }): Record<string, unknown> {
      const d = decodeMessage(m.signed);
      assert.ok(d.ok);
      for (const key of everyKey) {
        const opened = openMessage(platform, key, d.value);
        if (opened.ok) return JSON.parse(opened.value.content);
      }
      return assert.fail("no epoch's key opens the message");
    },
    close: () => device({ ...addBody(alice, keyed("app", `${tag}-more`)) }),
    /** What the relay holds, decoded: the epoch entries and the bot's messages. */
    async held() {
      const pass = await as((link) => link.read(0));
      assert.equal(pass.type, "pass");
      const items = (pass as { items: { kind: number; signed: Bytes }[] }).items;
      return {
        epochs: items.filter((i) => i.kind === 3).map((i) => signedId(platform, i.signed)),
        messages: items
          .filter((i) => i.kind === 4)
          .map((i) => {
            const d = decodeMessage(i.signed);
            assert.ok(d.ok);
            return { ...d.value.header, signed: i.signed };
          }),
      };
    },
    stop: () => relay.act("stop", { op: "act", line: 0 }),
  };
}

/** A bot on `dir`; `submit` wraps the connection's, and `now` is the time the outbox counts epochs by. */
export function botOn(
  r: Awaited<ReturnType<typeof rig>>,
  over: {
    submit?: (real: Submit) => Submit;
    now?: () => number;
    port?: number;
    clock?: Clock;
    /** What the fake core answers to an answer: false for a request it no longer waits on. */
    taken?: boolean;
  } = {},
) {
  const pairing = loadPairing(r.dir);
  const held = botPlatform(r.dir);
  const store = Store.open(r.dir, identityOf(held, pairing.device, pairing.relay));
  const lines: string[] = [];
  const outs: Out[] = [];
  const connection: Connection = new Connection({
    address: () => ({ host: "127.0.0.1", port: over.port ?? r.port }),
    ...(over.clock ? { clock: over.clock } : {}),
    pairing,
    platform: held,
    store,
    log: (l) => lines.push(l),
    on: (out) => {
      outs.push(out);
      outbox.take(out);
      inbound.take(out);
    },
  });
  const run = new Run(held);
  const real: Submit = (k, s, g) => connection.submit(k, s, g);
  const outbox: Outbox = new Outbox({
    platform: over.now ? { ...held, now: over.now } : held,
    pairing,
    store,
    reading: connection.reading,
    run,
    submit: over.submit?.(real) ?? real,
    log: (l) => lines.push(l),
  });
  const inbound = new Inbound({
    platform: held,
    self: deviceId(held, pairing.device.signing, pairing.device.receiving),
    store,
    outbox,
    run,
    log: (l) => lines.push(l),
  });
  const messages: InboundMessage[] = [];
  const answers: [string, OwnerAnswer][] = [];
  const target = {
    message: async (m: InboundMessage) => void messages.push(m),
    answer: async (_ref: unknown, id: string, a: OwnerAnswer) =>
      !!answers.push([id, a]) && (over.taken ?? true),
  };
  inbound.start(target as unknown as ChatInbound);
  const until = async (done: () => boolean | Promise<boolean>) => {
    for (
      const end = Date.now() + 20_000;
      !(await done());
      await new Promise((s) => setTimeout(s, 25))
    )
      assert.ok(Date.now() < end, `waited for what never came: ${lines.join(" | ")}`);
  };
  const queued = () => store.saved.outboxes.get(hex(r.channel)) ?? [];
  return {
    connection,
    outbox,
    store,
    inbound,
    messages,
    answers,
    lines,
    outs,
    until,
    queued,
    rested: () => until(() => outs.some((o) => o.do === "rest")),
    async stop() {
      await connection.stop();
      held.erase();
    },
  };
}

export const incarnation = (b: ReturnType<typeof botOn>) =>
  (b.outs.find((o) => o.do === "incarnation") as { incarnation: Bytes }).incarnation;
export const waiting = () => new Promise((s) => setTimeout(s, 300));
