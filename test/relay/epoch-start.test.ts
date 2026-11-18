/**
 * A device starts an epoch (security design 5.4, 5.7) against the relay's own process: the bot
 * builds from what its reading holds, the relay places it or answers a moved head with 2, and the
 * reading finds the channel open with the key it holds. Nothing here is built from the test's own
 * record of the logs.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { buildEpoch, EPOCH_LIFE_MS, tickEpoch, whyStart } from "../../src/protocol/epochs.ts";
import { Reading } from "../../src/protocol/reading.ts";
import { type Item, kinds, scene } from "../protocol/reading-world.ts";
import { dial } from "../support/scripted-device/link.ts";
import { tempDirSync } from "../support/temp.ts";
import { DARWIN, init, portOf } from "./process-support.ts";
import { code, connect, pushed, readAll, sent, serve, stop } from "./reading-support.ts";
import { platform } from "./support.ts";
import { keyed } from "./world.ts";

test(
  "against the relay: a bot starts the first epoch, starts the next when its channel is closed, builds again after a moved head, and starts one at 30 days",
  DARWIN,
  async () => {
    const dir = join(tempDirSync("pardner-relay-"), "relay");
    const { key, secret } = await init(dir);
    const s = scene(); // genesis, the bot's add and a channel: no epoch
    const [, ...rest] = s.wire.items;
    const who = { ...s.who, relay: key };
    const relay = serve(dir);
    try {
      const port = await portOf(relay);
      const link = await dial(platform, port, key);
      link.enrol(secret, s.alice.genesis);
      const proved = await link.proveActive(s.alice.id, s.alice.first.id, s.alice.first.sign);
      assert.equal(proved.type, "served");
      await sent(link, rest);

      const bot = await connect(port, key, s, "bot");
      const r = new Reading(who);
      const now = 1_800_000_000_000;
      await readAll(r, bot.link, bot.served);
      const seen = () => {
        const v = r.channel(s.channel);
        assert.ok(v);
        return v;
      };
      const signer = { person: s.alice.id, device: s.bot.id, sign: s.bot.sign };
      const build = () => {
        const view = seen();
        assert.ok(view);
        const made = buildEpoch(s.who.platform, view.members, view.epochs, [r.devices], signer);
        assert.ok(made.ok);
        return { view, ...made.value };
      };
      const submit = (e: { signed: Uint8Array; sig: Uint8Array }) => bot.link.submit(3, e);

      // No epoch: the bot starts the first, the relay places it, and the reading finds it open with its key.
      assert.equal(whyStart(seen(), undefined, now, false), "no-epoch");
      const first = build();
      assert.deepEqual(await submit(first), { type: "result", request: 1, code: 0 });
      assert.deepEqual(kinds(await pushed(r, bot.link)), ["rest"]);
      let view = seen();
      assert.equal(view.open, true);
      assert.ok(view.key, "it opened its own seal");
      assert.equal(
        whyStart(view, undefined, now, false),
        undefined,
        "an open epoch with its key: nothing to do",
      );
      let clock = tickEpoch(undefined, view.epochs, now, true);

      // A device of the owner is added: the epoch is closed, and the bot starts the next at the heads it read.
      s.entry(s.alice.add(s.log, keyed()));
      assert.equal(await code(link, s.wire.items.at(-1) as Item), 0);
      assert.deepEqual(kinds(await pushed(r, bot.link)), ["rest"]);
      view = seen();
      assert.equal(whyStart(view, clock, now, false), "closed");

      // The heads move between the bot's read and its submit: the relay answers 2, the bot reads again and builds anew.
      const stale = build();
      s.entry(s.alice.add(s.log, keyed()));
      assert.equal(await code(link, s.wire.items.at(-1) as Item), 0);
      assert.equal(await code(bot.link, { kind: 3, ...stale }), 2, "a moved head");
      assert.deepEqual(kinds(await pushed(r, bot.link)), ["rest"]);
      view = seen();
      assert.equal(whyStart(view, clock, now, false), "closed", "still closed: it builds again");
      const next = build();
      assert.equal(next.entry.deviceHeads[0]?.length, r.devices.length);
      assert.equal(next.entry.seq, 1);
      assert.equal(
        next.entry.seals.length,
        5,
        "alice's first device, the bot, two more of hers and her recovery key",
      );
      assert.equal(await code(bot.link, { kind: 3, ...next }), 0);
      assert.deepEqual(kinds(await pushed(r, bot.link)), ["rest"]);
      view = seen();
      assert.equal(whyStart(view, clock, now, false), undefined, "open, and its key held");

      // 30 days: the stored time of the first read gives the reason, and the relay places an epoch over an open one.
      clock = tickEpoch(clock, view.epochs, now, true);
      assert.deepEqual(clock?.since, now, "another epoch: its count starts at its first read");
      const later = now + EPOCH_LIFE_MS;
      assert.equal(whyStart(view, clock, later - 1, false), undefined);
      assert.equal(whyStart(view, clock, later, false), "aged");
      const aged = build();
      assert.equal(await code(bot.link, { kind: 3, ...aged }), 0);
      assert.deepEqual(kinds(await pushed(r, bot.link)), ["rest"]);
      assert.equal(r.channel(s.channel)?.epochs.length, 3);
      assert.equal(
        whyStart(seen(), tickEpoch(clock, seen().epochs, later, true), later, false),
        undefined,
      );
      link.close();
      bot.link.close();
    } finally {
      await stop(relay);
    }
  },
);
