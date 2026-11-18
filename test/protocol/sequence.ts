/**
 * A relay's one sequence and the devices that write to it and read it, for the tests of the outbox
 * and of what a bot acts on: real messages, sealed and signed, with the relay reduced to a list
 * that takes each signed message once (security design 5.0, duty 5).
 */
import assert from "node:assert/strict";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import { bytesEqual } from "../../src/protocol/bytes.ts";
import { deviceId } from "../../src/protocol/ids.ts";
import { decodeMessage, type Message, openMessage } from "../../src/protocol/messages.ts";
import { build, type Draft, type OutboxItem, queue, Run } from "../../src/protocol/outbox.ts";
import type { Bytes } from "../../src/protocol/platform.ts";

export const fill = (n: number, length = 32): Bytes => new Uint8Array(length).fill(n);

/** The platform key name of a device's signature. */
export const SIGN = "device.sign";
export const channel = fill(1);
export const epochOf = (n: number): Bytes => fill(10 + n);
export const keyOf = (epoch: Bytes): Bytes => fill(100 + (epoch[0] as number));

/** The relay's sequence: the signed messages in the order it took them. */
export class Sequence {
  readonly items: Message[] = [];
  readonly #signed: Bytes[] = [];
  submit(signed: Bytes): void {
    if (this.#signed.some((s) => bytesEqual(s, signed))) return;
    const decoded = decodeMessage(signed);
    assert.ok(decoded.ok);
    this.#signed.push(signed);
    this.items.push(decoded.value);
  }
}

/** A device with a key of its own, a run, and an outbox. */
export class Party {
  readonly platform: ReturnType<typeof createNodePlatform>;
  outbox: OutboxItem[] = [];
  run: Run;
  readonly id: Bytes;
  readonly keys: { signing: Bytes; receiving: Bytes };
  /**
   * A device with the id its keys give, or, for a test that needs no log, one named `id`. A `twin`
   * is the same device again (its folder put back): the same keys, and so the same id.
   */
  constructor(id?: Bytes, twin?: Party) {
    this.platform = twin?.platform ?? createNodePlatform();
    if (twin) this.keys = twin.keys;
    else {
      const signing = this.platform.makeKeyPair(SIGN, "sign");
      const receiving = this.platform.makeKeyPair("device.receive", "receive");
      assert.ok(signing.ok && receiving.ok);
      this.keys = { signing: signing.value, receiving: receiving.value };
    }
    this.id = id ?? deviceId(this.platform, this.keys.signing, this.keys.receiving);
    this.run = new Run(this.platform);
  }
  say(draft: Draft): OutboxItem {
    const queued = queue(this.platform, this.outbox, draft);
    assert.ok(queued.ok);
    this.outbox = queued.value;
    return this.outbox.at(-1) as OutboxItem;
  }
  /** Builds and puts every message of the outbox into `seq`, under the epoch and the incarnation read. */
  flush(seq: Sequence, epoch: Bytes, incarnation: Bytes, in_: Bytes = channel): void {
    this.outbox = this.outbox.map((item) => {
      const result = build(
        this.platform,
        this.run,
        item,
        { channel: in_, epoch, epochKey: keyOf(epoch), sender: this.id, incarnation },
        SIGN,
      );
      assert.ok(result.ok);
      const built = result.value;
      if (built === "rollover") return item;
      assert.ok(built.built);
      seq.submit(built.built.signed);
      return built;
    });
  }
}

export const opened = (platform: Party["platform"], m: Message) => {
  const body = openMessage(platform, keyOf(m.header.epoch), m);
  assert.ok(body.ok);
  return body.value;
};
