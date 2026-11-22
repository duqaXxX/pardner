import assert from "node:assert/strict";
import { test } from "node:test";
import { Inbound } from "../../../src/chat/relay/inbound.ts";
import type { Outbox } from "../../../src/chat/relay/outbox.ts";
import { RelayProvider } from "../../../src/chat/relay/provider.ts";
import type { Store } from "../../../src/chat/relay/store.ts";
import type { ChatProvider } from "../../../src/chat/seam.ts";
import { Run } from "../../../src/protocol/outbox.ts";
import { platform } from "../../relay/support.ts";

const self = new Uint8Array(32).fill(7);

/** The relay provider over an outbox that is never used. */
function provider(): ChatProvider {
  const outbox = {} as unknown as Outbox;
  const store = { saved: { incarnation: undefined, decided: new Map() } } as unknown as Store;
  const inbound = new Inbound({
    platform,
    self,
    store,
    outbox,
    run: new Run(platform),
    log: () => {},
  });
  return new RelayProvider(self, outbox, inbound, platform);
}

test("the relay chat has the members its capabilities declare, and no stub for the others", () => {
  const relay = provider();
  const { capabilities } = relay;
  assert.equal(capabilities.channelLists, false);
  assert.equal(capabilities.lookups, false);
  assert.equal(relay.channel("ab".repeat(32)).offer, undefined, "ChannelChat.offer");
  assert.equal(relay.channelState, undefined, "channelState");
  assert.equal(relay.threadState, undefined, "threadState");
});
