import assert from "node:assert/strict";
/** A bot for the tests: a party that reads the sequence in order and acts through its `BotReader`. */
import { BotReader, type Place, restartBot } from "../../src/protocol/bot-reader.ts";
import { bytesEqual } from "../../src/protocol/bytes.ts";
import {
  checkDeviceEntry,
  encodeDeviceEntry,
  type LoggedEntry,
} from "../../src/protocol/device-log.ts";
import { Seen } from "../../src/protocol/device-reader.ts";
import type { Message } from "../../src/protocol/messages.ts";
import { Run, readBack } from "../../src/protocol/outbox.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { makeProof } from "./proof.ts";
import { epochOf, keyOf, Party, type Sequence, SIGN } from "./sequence.ts";

export const hex = (b: Bytes) => Buffer.from(b).toString("hex");

/** The device log of a person whose devices are `app`, which signs the genesis, and `bot`, which it adds with the bot's proof. */
export function ownerLog(app: Party, bot: Party): LoggedEntry[] {
  const recovery = {
    signing: Uint8Array.of(4, ...new Uint8Array(64).fill(1)),
    receiving: Uint8Array.of(4, ...new Uint8Array(64).fill(2)),
  };
  const log: LoggedEntry[] = [];
  const push = (entry: Parameters<typeof encodeDeviceEntry>[0]) => {
    const bytes = encodeDeviceEntry(entry);
    const signature = app.platform.sign(SIGN, bytes);
    assert.ok(signature.ok);
    const verdict = checkDeviceEntry(app.platform, log, bytes, signature.value);
    assert.ok(verdict.ok);
    log.push(verdict.value);
  };
  push({ seq: 0, kind: "genesis", device: { kind: "app", ...app.keys }, recovery, signer: app.id });
  const person = (log[0] as LoggedEntry).id;
  const device = { kind: "bot" as const, ...bot.keys };
  push({
    seq: 1,
    kind: "add",
    device,
    proof: makeProof(bot.platform, SIGN, person, device),
    person,
    prev: person,
    signer: app.id,
  });
  return log;
}

const open: Place = {
  epoch: epochOf(1),
  member: true,
  key: keyOf(epochOf(1)),
  log: [],
  length: 0,
};

export class Bot extends Party {
  reader: BotReader;
  seen = new Seen();
  cursor = 0;
  place: Place = open;
  readonly ran: string[] = [];
  /** A crash right after the start is read back, before the answer: the run is lost with the process. */
  crashAfterStart = false;
  /** The ciphertexts of the blobs the relay holds, by id. */
  readonly blobs = new Map<string, Bytes>();
  fetch: (id: Bytes) => Bytes | "gone" | "wait" = (id) => this.blobs.get(hex(id)) ?? "gone";
  incarnation: Bytes;
  /** `twin` is this bot again, its folder put back: the same keys, and so the same id. */
  constructor(incarnation: Bytes, decided = new Map(), twin?: Bot) {
    super(undefined, twin);
    this.incarnation = incarnation;
    this.reader = new BotReader(this.platform, this.id, incarnation, this.run, decided);
  }
  /** Reads `seq` from the cursor; a prompt that waits for a file stops the pass there. */
  read(seq: Sequence): void {
    while (this.cursor < seq.items.length) {
      const m = seq.items[this.cursor] as Message;
      if (this.seen.check(m.header) === "again") {
        this.cursor++;
        continue;
      }
      if (bytesEqual(m.header.sender, this.id))
        this.outbox = readBack(this.outbox, this.id, m.header);
      const step = this.reader.read(m, this.place, this.fetch);
      if (step.wait) return;
      this.seen.add(m.header);
      for (const notice of step.notices) this.say({ ...notice, content: "{}" });
      if (step.run) {
        if (this.crashAfterStart) {
          this.restart();
          return;
        }
        this.ran.push(step.run.body.content);
        this.say({ kind: 5, re: step.run.ref, content: "answer" });
        this.reader.answered(step.run.ref);
      }
      this.cursor++;
    }
  }
  /** The owner's device log is the one of `app`: its prompts come from an active device. */
  owns(app: Party): this {
    this.place = { ...this.place, log: ownerLog(app, this), length: 2 };
    return this;
  }
  /** A restart: a new run, what was started cut, the starts of the outbox gone, the sequence read again. */
  restart(): void {
    this.run = new Run(this.platform);
    const restarted = restartBot(
      this.platform,
      this.id,
      this.incarnation,
      this.reader.decided,
      this.outbox,
      this.run,
    );
    this.reader = restarted.reader;
    this.outbox = restarted.outbox;
    this.seen = restarted.seen;
    this.cursor = 0;
  }
}
