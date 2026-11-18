/**
 * What the scripted device's link hands on (design 6.2): the ids it saw and the last chain it checked,
 * seeded into the next link of the same relay directory, across a restart of the relay.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dial, type Held, type Link, type Outcome } from "../support/scripted-device/link.ts";
import { RelayProcess } from "../support/scripted-device/relay-process.ts";
import { DARWIN } from "./process-support.ts";
import { platform } from "./support.ts";
import { fill, keyed, person } from "./world.ts";

function passOf(o: Outcome) {
  assert.equal(o.type, "pass");
  return o as Extract<Outcome, { type: "pass" }>;
}

test(
  "a link seeded with what the one before held checks a head after a restart, with no read from 0",
  DARWIN,
  async () => {
    const relay = new RelayProcess();
    const links: Link[] = [];
    try {
      const target = await relay.open();
      const alice = person(keyed("app", "forms-alice-app"), keyed("app", "forms-alice-sheet"));
      const open = async (to: typeof target, held?: Held) => {
        const link = await dial(platform, to.port, to.relay, 2000, held);
        links.push(link);
        const first = alice.first;
        if (to === target) link.enrol(target.secret as Uint8Array, alice.genesis);
        assert.equal((await link.proveActive(alice.id, first.id, first.sign)).type, "served");
        return link;
      };
      const before = await open(target);
      const whole = passOf(await before.read(0));
      assert.deepEqual([whole.problems, whole.chainChecked], [[], true]);
      const seed = before.held();
      assert.equal(seed.checked.n, 1);

      const restarted = (await relay.act("restart", { op: "relay", line: 1 })).target;
      const bare = passOf(await (await open(restarted)).read(1));
      assert.deepEqual(
        [bare.head.n, bare.chainChecked],
        [1, false],
        "a link with nothing held cannot check the chain from 1",
      );
      const seeded = passOf(await (await open(restarted, seed)).read(1));
      assert.deepEqual([seeded.problems, seeded.chainChecked], [[], true]);

      const wrong = { ids: seed.ids, checked: { n: 1, chain: fill(7) } };
      const bad = passOf(await (await open(restarted, wrong)).read(0));
      assert.deepEqual(
        bad.problems,
        ["the chain does not hold"],
        "the positive twin is the seed above",
      );
    } finally {
      for (const link of links) link.close();
      await relay.close();
    }
  },
);
