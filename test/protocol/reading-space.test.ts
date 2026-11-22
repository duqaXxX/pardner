/**
 * The device's reading of a person's space (personal space design 2.3, 5): which channel is the
 * space, a spare left out of `channels()`, and a message checked in the class of its channel.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { idKey } from "../../src/protocol/device-log.ts";
import type { LoggedEpoch } from "../../src/protocol/epochs.ts";
import { signedId } from "../../src/protocol/ids.ts";
import {
  checkMemberEntry,
  encodeMemberEntry,
  type LoggedMember,
  spaceNonce,
} from "../../src/protocol/member-log.ts";
import { Reading } from "../../src/protocol/reading.ts";
import type { Sequence } from "../../src/relay/sequence.ts";
import { platform } from "../relay/support.ts";
import { epochEntry, fill, memberEntry, message, signedBy } from "../relay/world.ts";
import { addChannel, kinds, play, type Scene, scene } from "./reading-world.ts";

const read = (s: Scene) => {
  const r = new Reading(s.who);
  const outs = play(r, [s.wire.served(), ...s.wire.read()]);
  return { r, outs };
};

test("2.3: space() is the first placed channel of the person's space nonce, and channels() leaves out a spare", () => {
  const s = scene();
  const nonce = spaceNonce(platform, s.alice.id);
  const first = addChannel(s, nonce);
  const spare = addChannel(s, nonce, "bot");
  const { r, outs } = read(s);
  assert.equal(r.state, "rest", "a spare faults nothing");
  assert.deepEqual(kinds(outs).at(-1), "rest");
  assert.deepEqual(r.space(), first.id);
  assert.deepEqual(r.channels(), [s.channel, first.id]);
  assert.equal(
    r.channel(spare.id)?.space,
    true,
    "a spare is of the space class and is still folded",
  );
  assert.equal(r.channel(first.id)?.space, true);
  assert.equal(r.channel(s.channel)?.space, false);
});

test("2.3: a person with no space has none, and a nonce of another person's space makes none", () => {
  const s = scene();
  assert.equal(read(s).r.space(), undefined);
  const other = signedId(platform, fill(9)); // a person the reading never held
  addChannel(s, spaceNonce(platform, other));
  const { r } = read(s);
  assert.equal(r.space(), undefined);
  assert.equal(r.channels().length, 2, "it is an ordinary channel");
});

test("S5: the reading accepts a profile in the space and not in a conversation channel, and a prompt in the conversation channel and not in the space", () => {
  const s = scene();
  const talk = s.epoch();
  const space = addChannel(s, spaceNonce(platform, s.alice.id));
  const home = space.epoch();
  const put = (channel: Uint8Array, epoch: { id: Uint8Array; key: Uint8Array }, over = {}) =>
    s.wire.put(4, message(s.bot, channel, epoch, { ...over }));
  put(s.channel, talk, { kind: 13, counter: 1 });
  put(space.id, home, { kind: 13, counter: 1 });
  s.wire.put(4, message(s.alice.first, s.channel, talk, { kind: 2, to: s.bot.id, counter: 1 }));
  s.wire.put(4, message(s.alice.first, space.id, home, { kind: 2, to: s.bot.id, counter: 2 }));
  const given = read(s).outs.filter((o) => o.do === "message");
  assert.deepEqual(
    given.map((o) => [o.do === "message" ? o.message.header.kind : 0]),
    [[13], [2]],
  );
  assert.deepEqual(
    given.map((o) => (o.do === "message" ? idKey(o.message.header.channel) : "")),
    [idKey(space.id), idKey(s.channel)],
  );
});
