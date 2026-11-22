/**
 * The bot and a person's space (personal space design 2.6, 4.2, 5): its profile goes into the space
 * alone, a person with no space gets one from the bot at rest, and a refusal in the space stops
 * nothing. Against a real relay in a child process.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { KIND_PROFILE } from "../../../src/protocol/messages.ts";
import { encodeProfile } from "../../../src/protocol/profile.ts";
import { DARWIN } from "../../relay/process-support.ts";
import { botOn, hex, rig, waiting } from "./relay-rig.ts";

type Rig = Awaited<ReturnType<typeof rig>>;
const profilesBy = async (r: Rig) =>
  (await r.held()).messages.filter((m) => m.kind === KIND_PROFILE);

test(
  "personal space: the bot writes its profile into its person's space and nowhere else",
  DARWIN,
  async () => {
    const r = await rig({ space: true });
    const b = botOn(r, { profile: { name: "mini" } });
    try {
      b.connection.start();
      await b.until(async () => (await profilesBy(r)).length === 1);
      await r.talk.epoch(); // a new epoch of the conversation channel: no profile for it
      await waiting();
      const held = await profilesBy(r);
      assert.deepEqual(
        held.map((m) => hex(m.channel)),
        [hex(r.channel)],
      );
      assert.deepEqual(
        b.lines.filter((l) => /refused/.test(l)),
        [],
      );
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "personal space: a person without a space gets one from the bot at its first rest, once",
  DARWIN,
  async () => {
    const r = await rig({ bare: true });
    let b = botOn(r, { profile: { name: "mini" } });
    try {
      b.connection.start();
      await b.until(async () => (await profilesBy(r)).length === 1);
      const space = b.connection.reading.space();
      assert.ok(space, "the reading names the space it made");
      assert.equal(hex((await profilesBy(r))[0]?.channel as Uint8Array), hex(space));
      await b.stop();
      b = botOn(r, { profile: { name: "studio" } });
      b.connection.start();
      await b.until(async () => (await profilesBy(r)).length === 2);
      assert.equal(hex(b.connection.reading.space() as Uint8Array), hex(space), "none made again");
      assert.equal(b.store.saved.faults.size, 0);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "personal space: an epoch entry the relay refuses in the space drops nothing and stops nothing; the next rest tries again",
  DARWIN,
  async () => {
    const r = await rig({ space: true });
    let refuse = false;
    const b = botOn(r, {
      profile: { name: "mini" },
      submit: (real) => async (k, s, g) => (refuse && k === 3 ? 1 : real(k, s, g)),
    });
    try {
      b.connection.start();
      await b.until(async () => (await profilesBy(r)).length === 1);
      refuse = true;
      await r.close(); // a device change closes the space: the bot owes its next epoch
      await b.until(() => b.lines.some((l) => /epoch entry was refused in the space/.test(l)));
      // The conversation channel is refused the same way and stops, as today: the space does not.
      assert.equal(b.store.saved.faults.has(hex(r.channel)), false, "the space is no fault target");
      for (let i = 0; i < 3; i++) b.outbox.take({ do: "rest", first: false });
      await waiting();
      assert.equal(
        b.lines.filter((l) => /epoch entry was refused in the space/.test(l)).length,
        1,
        "review K7: said once for the space and its epoch count, not at every rest",
      );
      const epochs = (await r.held()).epochs.length;
      refuse = false;
      assert.equal(b.store.saved.faults.has(hex(r.talk.channel)), true);
      await r.addBot(); // another device change: a push the bot reads to rest
      await b.until(async () => (await r.held()).epochs.length > epochs);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "personal space: a bot restarted over a fault stored on the space drops it at its first rest and writes again",
  DARWIN,
  async () => {
    const r = await rig({ space: true });
    let b = botOn(r, { profile: { name: "mini" } });
    try {
      b.connection.start();
      await b.until(async () => (await profilesBy(r)).length === 1);
      await b.store.change((s) => s.faults.add(hex(r.channel)));
      await b.stop();
      b = botOn(r, { profile: { name: "studio" } });
      assert.equal(b.store.saved.faults.size, 1, "stored before the reading names the space");
      b.connection.start();
      await b.until(async () => (await profilesBy(r)).length === 2);
      assert.equal(b.store.saved.faults.size, 0);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "personal space, review K2: a built profile left in a conversation channel by the version before is dropped for its class, and the space's profile still goes",
  DARWIN,
  async () => {
    const r = await rig({ bare: true });
    // Run 1 stands for the version before the change: no space made, a profile built for a conversation channel and never answered.
    let b = botOn(r, {
      submit: (real) => async (k, s, g) => (k === 2 || k === 4 ? undefined : real(k, s, g)),
    });
    try {
      b.connection.start();
      await b.rested();
      await b.outbox.queue(r.channel, {
        kind: KIND_PROFILE,
        name: new Uint8Array(16).fill(7),
        content: encodeProfile({ name: "old" }),
      });
      await b.until(() => b.queued().some((i) => i.kind === KIND_PROFILE && i.built));
      await b.stop();
      b = botOn(r, { profile: { name: "mini" } });
      b.connection.start();
      await b.until(async () => {
        const space = b.connection.reading.space();
        return (
          space !== undefined && (await profilesBy(r)).some((m) => hex(m.channel) === hex(space))
        );
      });
      assert.equal(b.outbox.profileDropped, false, "a class refusal is not a dropped profile");
      assert.deepEqual(b.queued(), [], "the stale profile left the outbox");
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "personal space, review K3: after a changed incarnation the bot asks for its space again",
  DARWIN,
  async () => {
    const r = await rig({ bare: true });
    let asked = 0;
    const b = botOn(r, {
      // The first answer is lost on the way, as a relay gone back before the space would lose it.
      submit: (real) => async (k, s, g) => (k === 2 && asked++ === 0 ? 0 : real(k, s, g)),
    });
    try {
      b.connection.start();
      await b.until(() => asked >= 1);
      await waiting();
      assert.equal(b.connection.reading.space(), undefined, "nothing was placed");
      b.outbox.take({
        do: "incarnation",
        incarnation: new Uint8Array(16),
        first: false,
        changed: true,
      });
      b.outbox.take({ do: "rest", first: false });
      await b.until(() => b.connection.reading.space() !== undefined);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);
