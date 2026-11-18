/**
 * The device's reading against the relay's own process (design 9.2's setup: `node src/relay/main.ts`
 * in child processes, spoken to over real TLS on 127.0.0.1 by the scripted device's link). The link
 * is only the transport here: what is under test is `Reading`, fed the frames the relay sent.
 */
import assert from "node:assert/strict";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BotReader } from "../../src/protocol/bot-reader.ts";
import { relayKeyId } from "../../src/protocol/ids.ts";
import { Run } from "../../src/protocol/outbox.ts";
import { Reading } from "../../src/protocol/reading.ts";
import { failedClosed } from "../../src/relay/directory.ts";
import { kinds, prompt, type Scene, scene } from "../protocol/reading-world.ts";
import { dial } from "../support/scripted-device/link.ts";
import { tempDirSync } from "../support/temp.ts";
import { DARWIN, init, portOf } from "./process-support.ts";
import {
  code,
  connect,
  incarnationOf,
  pushed,
  readAll,
  sent,
  serve,
  stop,
} from "./reading-support.ts";
import { platform } from "./support.ts";
import { keyed } from "./world.ts";

test(
  "against the relay: the logs, the open rule, a prompt at its place, a push, a restart, the head given back, and a relay put back by hand",
  DARWIN,
  async () => {
    const dir = join(tempDirSync("pardner-relay-"), "relay");
    const copy = `${dir}-copy`;
    const { key, secret } = await init(dir);
    const s = scene();
    const e1 = s.epoch();
    const [genesis, ...rest] = s.wire.items;
    assert.ok(genesis);
    const who = { ...s.who, relay: key };
    let relay = serve(dir);
    try {
      let port = await portOf(relay);
      // alice enrols, adds the bot, creates a channel and starts its epoch; the bot reads it all.
      const app = await dial(platform, port, key);
      app.enrol(secret, s.alice.genesis);
      assert.equal(
        (await app.proveActive(s.alice.id, s.alice.first.id, s.alice.first.sign)).type,
        "served",
      );
      await sent(app, rest);
      let bot = await connect(port, key, s, "bot");
      const r = new Reading(who);
      const first = await readAll(r, bot.link, bot.served);
      assert.deepEqual(kinds(first), ["incarnation", "read", "rest"]);
      assert.equal(r.kept.ids.length, s.wire.items.length, "the whole sequence, at its positions");
      assert.equal(r.channel(s.channel)?.open, true);
      assert.deepEqual(r.channel(s.channel)?.key, e1.key, "it opened its seal in the entry");
      const incarnation = incarnationOf(bot.served);

      // A restart of the relay is a new incarnation: read again from 0, each id the same.
      app.close();
      bot.link.close();
      r.dropped();
      await stop(relay);
      cpSync(dir, copy, { recursive: true }); // what a backup of the directory holds
      relay = serve(dir);
      port = await portOf(relay);
      bot = await connect(port, key, s, "bot");
      const ids = [...r.kept.ids];
      const second = await readAll(r, bot.link, bot.served);
      assert.deepEqual(second[0], {
        do: "incarnation",
        incarnation: incarnationOf(bot.served),
        first: false,
        changed: true,
      });
      assert.deepEqual(second[1], { do: "read", from: 0 });
      assert.deepEqual(second.at(-1), { do: "rest", first: true });
      assert.notDeepEqual(incarnationOf(bot.served), incarnation);
      assert.deepEqual(r.kept.ids, ids, "every id the same");

      // A prompt: a push gives it at its place, and BotReader asks for its start there.
      const alice = await connect(port, key, s, "alice");
      const p = prompt(s, e1, undefined, 1, incarnationOf(bot.served));
      assert.equal(await code(alice.link, { kind: 4, ...p }), 0);
      s.wire.put(4, p);
      const got = await pushed(r, bot.link);
      assert.deepEqual(kinds(got), ["message", "rest"], "a push gives the message at its place");
      const message = got[0];
      assert.ok(message?.do === "message");
      const reader = new BotReader(
        platform,
        s.bot.id,
        incarnationOf(bot.served),
        new Run(platform),
      );
      const step = reader.read(message.message, message.place, () => "gone");
      assert.deepEqual(
        step.notices.map((n) => n.kind),
        [3],
      );

      // The head it holds is the relay's own: given back, the relay accepts it and changes nothing.
      const held = r.kept.head;
      assert.ok(held);
      assert.deepEqual(held.head.relay, relayKeyId(platform, key));
      assert.equal(held.head.n, s.wire.items.length);
      const gave = await bot.link.uploadDone(held.head, held.sig);
      assert.deepEqual(gave, { type: "result", request: 1, code: 0 });
      // The relay ends a connection it took a head on: the bot dials again and reads from its cursor.
      r.dropped();
      bot = await connect(port, key, s, "bot");
      const resumed = await readAll(r, bot.link, bot.served);
      assert.deepEqual(kinds(resumed), ["incarnation", "read", "rest"]);
      assert.deepEqual(resumed[1], { do: "read", from: s.wire.items.length });

      // The open rule is the relay's: a device added closes the epoch, and a message in it is refused.
      s.entry(s.alice.add(s.log, keyed()));
      assert.equal(
        await code(alice.link, s.wire.items.at(-1) as Scene["wire"]["items"][number]),
        0,
      );
      const late = prompt(s, e1, undefined, 2);
      assert.equal(await code(alice.link, { kind: 4, ...late }), 3, "the relay answers closed");
      assert.deepEqual(kinds(await pushed(r, bot.link)), ["rest"]);
      assert.equal(r.channel(s.channel)?.open, false, "the reading says closed as the relay does");
      const e2 = s.epoch();
      assert.equal(
        await code(alice.link, s.wire.items.at(-1) as Scene["wire"]["items"][number]),
        0,
      );
      const open = prompt(s, e2, undefined, 3);
      assert.equal(await code(alice.link, { kind: 4, ...open }), 0, "open again");
      s.wire.put(4, open);
      assert.deepEqual(kinds(await pushed(r, bot.link)), ["rest"], "the epoch entry");
      assert.equal(r.channel(s.channel)?.open, true);
      assert.deepEqual(r.channel(s.channel)?.key, e2.key);
      alice.link.close();
      bot.link.close();

      // The directory is put back by hand to the copy, which lacks all of it: the relay ends before what the bot read.
      r.dropped();
      await stop(relay);
      rmSync(dir, { recursive: true });
      cpSync(copy, dir, { recursive: true });
      relay = serve(dir);
      port = await portOf(relay);
      const behind = await connect(port, key, s, "bot");
      const outs = await readAll(r, behind.link, behind.served);
      const give = outs.at(-1);
      assert.ok(give?.do === "give-back");
      assert.equal(r.sendable, false);
      const result = await behind.link.uploadDone(give.head, give.sig);
      assert.deepEqual(result, { type: "result", request: 1, code: 11 });
      assert.equal(failedClosed(dir), true);
      assert.deepEqual(r.gaveBack(11), [{ do: "put-back" }]);
      assert.equal(r.kept.putBack, true);
      const refused = await dial(platform, port, key);
      assert.deepEqual(await refused.proveActive(s.alice.id, s.bot.id, s.bot.sign), {
        type: "refused",
        reason: 6,
      });
    } finally {
      await stop(relay);
    }
  },
);
