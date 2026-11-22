/**
 * Personal space design 2.3 and 2.4 on the relay: S1, S2, S5 and S6 at submit, and none of them at
 * restore. A test named after one of the model's `personal space:` tests ends with ` [model]`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { idKey } from "../../src/protocol/device-log.ts";
import { encodeHistorySeal } from "../../src/protocol/epochs.ts";
import { encodeMemberEntry, spaceNonce } from "../../src/protocol/member-log.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { Seals } from "../../src/relay/seals.ts";
import { SealsFile } from "../../src/relay/seals-file.ts";
import { Code } from "../../src/relay/sequence.ts";
import { openAppending, platform } from "./support.ts";
import {
  enrolled,
  epochEntry,
  fill,
  type Keyed,
  keyed,
  memberEntry,
  message,
  person,
  signedBy,
} from "./world.ts";

const DEVICE = 1;
const MEMBER = 2;
const EPOCH = 3;
const MESSAGE = 4;

/** alice, a bot and a second app; her space and a conversation channel, each with an epoch open. */
async function world() {
  const w = await enrolled();
  const { alice, a, send } = w;
  const bot = keyed("bot");
  const second = keyed();
  w.join(bot);
  w.join(second);
  const nonce = spaceNonce(platform, alice.id);
  const create = (by: Keyed, n: Bytes) =>
    signedBy(
      by,
      encodeMemberEntry({
        seq: 0,
        kind: "create",
        nonce: n,
        signerPerson: alice.id,
        signerDevice: by.id,
      }),
    );
  const [home, talk] = [create(alice.first, nonce), create(alice.first, fill(3, 16))];
  for (const c of [home, talk]) assert.equal(send(a, MEMBER, c).code, Code.accepted);
  const [space, chat] = [platform.sha256(home.signed), platform.sha256(talk.signed)];
  const open = (channel: Bytes, by: Keyed = alice.first) => {
    const e = epochEntry(w.seq, channel, { person: alice, device: by }, [alice]);
    assert.equal(send(alice.conn(by), EPOCH, e).code, Code.accepted);
    return { id: platform.sha256(e.signed), key: e.key };
  };
  const epochs = { space: open(space), chat: open(chat) };
  return { ...w, bot, second, create, home, space, chat, epochs, open };
}
type World = Awaited<ReturnType<typeof world>>;

/** A message by `sender` of `kind` in `channel`; a counter of its own keeps the slots apart. */
let counter = 1;
const say = (
  w: World,
  sender: Keyed,
  channel: Bytes,
  epoch: { id: Bytes; key: Bytes },
  over = {},
) =>
  w.send(
    w.alice.conn(sender),
    MESSAGE,
    message(sender, channel, epoch, { counter: counter++, ...over }),
  );

test("personal space: a second space of one person is answered position taken, and its maker reads the first [model]", async () => {
  const w = await world();
  const again = w.create(w.second, spaceNonce(platform, w.alice.id));
  assert.equal(w.send(w.alice.conn(w.second), MEMBER, again).code, Code.position);
  assert.equal(w.seq.channels.has(idKey(platform.sha256(again.signed))), false);
  // The first, sent again, is the bytes the relay holds: accepted (duty 5).
  assert.equal(w.send(w.a, MEMBER, w.home).code, Code.accepted);
  // A conversation channel of the same device is no space: placed.
  const plain = w.create(w.second, fill(8, 16));
  assert.equal(w.send(w.alice.conn(w.second), MEMBER, plain).code, Code.accepted);
});

test("personal space: an add person in a space is refused by the relay, and in a conversation channel it is placed [model]", async () => {
  const w = await world();
  const stranger = person().id;
  const add = (members: { id: Bytes }[]) =>
    memberEntry(w.alice, members, { kind: "add", person: stranger, role: "member" });
  const held = (channel: Bytes) => w.seq.channels.get(idKey(channel))?.members ?? [];
  assert.equal(w.send(w.a, MEMBER, add(held(w.space))).code, Code.refused);
  assert.equal(held(w.space).length, 1);
  assert.equal(w.send(w.a, MEMBER, add(held(w.chat))).code, Code.accepted);
});

test("personal space: a relay restarting over a space holding an add and an accept placed by an older relay starts, and the space stays its person's [model]", async () => {
  const w = await world();
  const bob = person();
  const log = [{ id: w.space }];
  const add = memberEntry(w.alice, log, { kind: "add", person: bob.id, role: "member" });
  log.push({ id: platform.sha256(add.signed) });
  const accept = memberEntry(bob, log, { kind: "accept" });
  for (const [kind, e] of [
    [DEVICE, bob.genesis],
    [MEMBER, add],
    [MEMBER, accept],
  ] as const)
    w.journal.append({ kind, ...e });
  await w.flush();
  const started = await w.restart();
  const held = started.seq.channels.get(idKey(w.space));
  assert.equal(held?.members.length, 3);
  assert.deepEqual([...(held?.persons ?? [])], [idKey(w.alice.id)]);
  // The same two entries in a conversation channel make bob a member.
  const other = [{ id: w.chat }];
  const invite = memberEntry(w.alice, other, { kind: "add", person: bob.id, role: "member" });
  other.push({ id: platform.sha256(invite.signed) });
  for (const [kind, e] of [
    [MEMBER, invite],
    [MEMBER, memberEntry(bob, other, { kind: "accept" })],
  ] as const)
    w.journal.append({ kind, ...e });
  await w.flush();
  const again = await w.restart();
  assert.equal(again.seq.channels.get(idKey(w.chat))?.persons.size, 2);
});

test("personal space: a relay restarting over a journal with a kind 13 in a conversation channel, placed before the change, starts [model]", async () => {
  const w = await world();
  w.journal.append({
    kind: MESSAGE,
    ...message(w.bot, w.chat, w.epochs.chat, { kind: 13, counter: counter++ }),
  });
  await w.flush();
  await w.restart();
});

test("personal space: a profile outside the space and a prompt inside it are refused by the relay [model]", async () => {
  const w = await world();
  // A device change closed both epochs under `join`; the world joined its devices before them.
  assert.equal(say(w, w.bot, w.space, w.epochs.space, { kind: 13 }).code, Code.accepted);
  assert.equal(say(w, w.bot, w.chat, w.epochs.chat, { kind: 13 }).code, Code.refused);
  const prompt = { kind: 2, to: w.bot.id };
  assert.equal(say(w, w.alice.first, w.chat, w.epochs.chat, prompt).code, Code.accepted);
  assert.equal(say(w, w.alice.first, w.space, w.epochs.space, prompt).code, Code.refused);
  assert.equal(say(w, w.alice.first, w.space, w.epochs.space, { kind: 1 }).code, Code.refused);
});

/** A seals file over a restart that also holds bob's log, as a relay that held two persons would. */
async function sealing(w: World) {
  const bob = person();
  w.journal.append({ kind: DEVICE, signed: bob.genesis.signed, sig: bob.genesis.sig });
  await w.flush();
  const started = await w.restart();
  const path = `${w.dir}/seals`;
  const seals = await Seals.open(
    platform,
    w.s.rounds,
    started.seq,
    openAppending(path),
    w.relay,
    w.s.log,
  );
  const seal = (channel: Bytes, epoch: Bytes, maker: Keyed, to: Keyed, id = to.id) =>
    signedBy(
      maker,
      encodeHistorySeal({
        channel,
        epoch,
        recipient: id,
        enc: to.keys.receiving,
        sealed: fill(7, 48),
        maker: maker.id,
      }),
    );
  return { bob, seals, seal, seq: started.seq };
}

test("personal space: the relay keeps no history seal of a space epoch to another person's device or recovery key [model]", async () => {
  const w = await world();
  const { bob, seals, seal } = await sealing(w);
  const give = (s: { signed: Bytes; sig: Bytes }) => seals.give(w.a, s.signed, s.sig).code;
  const home = (to: Keyed, id?: Bytes) => seal(w.space, w.epochs.space.id, w.alice.first, to, id);
  assert.equal(give(home(bob.first)), Code.refused);
  assert.equal(give(home(bob.recovery, bob.recovery.recoveryId)), Code.refused);
  // The person's own other device and recovery key are kept.
  assert.equal(give(home(w.second)), Code.accepted);
  assert.equal(give(home(w.alice.recovery, w.alice.recovery.recoveryId)), Code.accepted);
  // The same seal for a conversation channel is kept: a log the relay holds names bob's device.
  assert.equal(give(seal(w.chat, w.epochs.chat.id, w.alice.first, bob.first)), Code.accepted);
});

test("personal space, review K6: a seal the relay already holds is accepted again, whatever S6 says of it now", async () => {
  const w = await world();
  const { bob, seal, seq } = await sealing(w);
  const old = seal(w.space, w.epochs.space.id, w.alice.first, bob.first);
  // What an older relay kept: the file holds a seal of a space epoch to another person's device.
  const { file } = await SealsFile.open(
    platform,
    w.s.rounds,
    openAppending(`${w.dir}/seals`),
    w.relay,
  );
  file.append(old);
  await w.flush();
  const again = await Seals.open(
    platform,
    w.s.rounds,
    seq,
    openAppending(`${w.dir}/seals`),
    w.relay,
    w.s.log,
  );
  assert.equal(again.give(w.a, old.signed, old.sig).code, Code.accepted);
});
