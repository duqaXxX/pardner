/**
 * The bot's outbox and the faults stored on a space or a spare (personal space design 2.6, review
 * K9), on a reading reduced to what the outbox asks of it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Outbox } from "../../../src/chat/relay/outbox.ts";
import { botPlatform, loadPairing, pair } from "../../../src/chat/relay/pairing.ts";
import { identityOf, Store } from "../../../src/chat/relay/store.ts";
import { Run } from "../../../src/protocol/outbox.ts";
import type { Bytes } from "../../../src/protocol/platform.ts";
import type { Reading } from "../../../src/protocol/reading.ts";
import { fill } from "../../relay/world.ts";
import { tempDirSync } from "../../support/temp.ts";
import { hex } from "./relay-rig.ts";

test("personal space, review K9: at a rest every stored fault on a channel of the space class is dropped, a spare's included, and a conversation channel's is kept", async () => {
  const dir = tempDirSync("pardner-chat-");
  await pair(dir, fill(1), fill(2, 65), "alice");
  const pairing = loadPairing(dir);
  const held = botPlatform(dir);
  const store = Store.open(dir, identityOf(held, pairing.device, pairing.relay));
  const [space, spare, talk] = [fill(11), fill(12), fill(13)];
  await store.change((s) => {
    for (const c of [space, spare, talk]) s.faults.add(hex(c));
  });
  const class_ = new Map([
    [hex(space), true],
    [hex(spare), true],
    [hex(talk), false],
  ]);
  const reading = {
    sendable: false,
    space: (): Bytes => space,
    channels: (): Bytes[] => [],
    channel: (id: Bytes) => (class_.has(hex(id)) ? { space: class_.get(hex(id)) } : undefined),
    devices: [],
  } as unknown as Reading;
  const outbox = new Outbox({
    platform: held,
    pairing,
    store,
    reading,
    run: new Run(held),
    submit: async () => undefined,
    giveSeal: async () => undefined,
    put: async () => undefined,
    log: () => {},
  });
  outbox.take({ do: "rest", first: true });
  for (let i = 0; i < 50 && store.saved.faults.size > 1; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([...store.saved.faults], [hex(talk)]);
  held.erase();
});
