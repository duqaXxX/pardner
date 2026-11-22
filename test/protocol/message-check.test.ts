/**
 * The check of a received message (design 6.4, security design 5.6) on real bytes and signatures.
 * A test named after one of the model's ends with ` [model]`; the others hold a sentence of 5.6 or
 * a row of the table of 6.4.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import {
  checkDeviceEntry,
  type DeviceKeys,
  encodeDeviceEntry,
  type LoggedEntry,
} from "../../src/protocol/device-log.ts";
import type { LoggedEpoch } from "../../src/protocol/epochs.ts";
import { deviceId, recoveryKeyId } from "../../src/protocol/ids.ts";
import {
  encodeMessage,
  type MessageHeader,
  messageChecker,
  sealMessage,
} from "../../src/protocol/messages.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { runVectors } from "../../src/protocol/vectors.ts";
import { makeProof } from "./proof.ts";

const platform = createNodePlatform();
const fill = (n: number, length = 32): Bytes => new Uint8Array(length).fill(n);
const epochKey = fill(7);
const empty = { files: [], content: "{}" };
const base: Omit<MessageHeader, "blobs"> = {
  channel: fill(1),
  counter: 1,
  epoch: fill(2),
  sender: fill(3),
  run: fill(4, 16),
  incarnation: fill(5, 16),
  time: 1_700_000_000_000,
  kind: 1,
  name: fill(6, 16),
};
const header = (over: Partial<MessageHeader> = {}): MessageHeader => ({
  ...base,
  blobs: [],
  ...over,
});

const pk = (n: number): Bytes => Uint8Array.of(4, ...fill(n, 64));
let n = 0;
/** The platform's name of each signing key made here, by the key in hex: whoever holds a key can prove it. */
const holders = new Map<string, string>();
const hexOf = (b: Bytes) => Buffer.from(b).toString("hex");
/** The proof of possession of `device` for `person`, signed with the device's own key (design 6.1). */
function proofOf(person: Bytes, device: DeviceKeys) {
  const name = holders.get(hexOf(device.signing));
  assert.ok(
    name,
    "a device named in a log of this test is made by `device()`, so that its key is held",
  );
  return makeProof(platform, name, person, device);
}
/** A device whose log names it (and, for `kind` "bot", as a bot), with its keys held by the platform. */
function device(kind: "app" | "bot", recovery = { signing: pk(1), receiving: pk(2) }) {
  const id = n++;
  const s = platform.makeKeyPair(`msg.${id}.s`, "sign");
  const r = platform.makeKeyPair(`msg.${id}.r`, "receive");
  assert.ok(s.ok && r.ok);
  const keys = { signing: s.value, receiving: r.value };
  holders.set(hexOf(keys.signing), `msg.${id}.s`);
  const did = deviceId(platform, keys.signing, keys.receiving);
  const bytes = encodeDeviceEntry({
    seq: 0,
    kind: "genesis",
    device: { kind, ...keys },
    recovery,
    signer: did,
  });
  const signature = platform.sign(`msg.${id}.s`, bytes);
  assert.ok(signature.ok);
  const verdict = checkDeviceEntry(platform, [], bytes, signature.value);
  assert.ok(verdict.ok);
  return { id: did, keys, sign: `msg.${id}.s`, log: [verdict.value] as LoggedEntry[] };
}
type Device = ReturnType<typeof device>;

/**
 * Extends `owner`'s log with an entry the owner's device signs; the check must pass. An add carries
 * the proof of the device it names, made with that device's own key: here its holder is a party
 * to the entry, as a stolen key or a copied key file would be.
 */
function step(owner: Device, body: Record<string, unknown>) {
  const person = (owner.log[0] as LoggedEntry).id;
  const entry = {
    person,
    seq: owner.log.length,
    prev: owner.log.at(-1)?.id,
    signer: owner.id,
    ...body,
    ...(body.kind === "add" ? { proof: proofOf(person, body.device as DeviceKeys) } : {}),
    ...(body.kind === "reset" && body.newDevice
      ? {
          newDevice: {
            device: body.newDevice,
            proof: proofOf(person, body.newDevice as DeviceKeys),
          },
        }
      : {}),
  } as Parameters<typeof encodeDeviceEntry>[0];
  const bytes = encodeDeviceEntry(entry);
  const signature = platform.sign(owner.sign, bytes);
  assert.ok(signature.ok);
  const verdict = checkDeviceEntry(platform, owner.log, bytes, signature.value);
  assert.ok(verdict.ok);
  owner.log.push(verdict.value);
}

/** A second device of `owner`'s person, added and then removed in the owner's log, and which signs for itself. */
function removedDevice(owner: Device) {
  const second = device("app");
  step(owner, { kind: "add", device: { kind: "app", ...second.keys } });
  const at = owner.log.length;
  step(owner, { kind: "remove", device: second.id });
  return Object.assign(second, { at });
}

function world() {
  const app = device("app");
  const bot = device("bot");
  const stranger = device("app");
  const removed = removedDevice(app);
  const recoveryId = recoveryKeyId(platform, pk(1), pk(2));
  const seal = (recipient: Bytes) => ({ recipient, enc: fill(0), sealed: fill(0) });
  const logs = [app.log, bot.log, stranger.log];
  const heads = logs.map((log) => ({
    person: (log[0] as LoggedEntry).id,
    length: log === app.log ? removed.at : log.length,
    last: (log[log === app.log ? removed.at - 1 : log.length - 1] as LoggedEntry).id,
  }));
  const epoch = {
    id: fill(2),
    entry: {
      channel: fill(1),
      deviceHeads: heads,
      seals: [app.id, bot.id, removed.id, recoveryId].map(seal),
    },
  } as unknown as LoggedEpoch;
  return {
    app,
    bot,
    stranger,
    removed,
    recoveryId,
    epochs: [epoch],
    logs,
  };
}

function signedBy(sender: { id: Bytes; sign: string }, over: Partial<MessageHeader> = {}) {
  const bytes = sealMessage(platform, epochKey, { ...base, sender: sender.id, ...over }, empty);
  const signature = platform.sign(sender.sign, bytes);
  assert.ok(signature.ok);
  return { bytes, signature: signature.value };
}
const verdict = (
  w: ReturnType<typeof world>,
  m: { bytes: Bytes; signature: Bytes },
  space = false,
) => {
  const v = messageChecker(platform, w.epochs, w.logs, space)(m.bytes, m.signature);
  return v.ok ? "ok" : v.rule;
};

test("5.6 conditions 2 and 3: a message of a recipient with a signature that verifies is accepted", () => {
  const w = world();
  assert.equal(verdict(w, signedBy(w.app)), "ok");
  assert.equal(verdict(w, signedBy(w.bot, { kind: 8 })), "ok");
});

// The model's test holds two halves, conditions 2 and 4; the counter half is the reader's state (PR 8).
test("5.6 conditions 2 and 4: a device shows nothing from a sender that is not a recipient of the epoch, and no second message with a counter it accepted [model]", () => {
  const w = world();
  assert.equal(verdict(w, signedBy(w.stranger)), "sender");
});

// The model's test also says "never a device": that half is the device log's (device-log.test.ts).
test("section 4, 5.6 condition 2: a recovery key is never a device and never a sender [model]", () => {
  const w = world();
  const bytes = sealMessage(platform, epochKey, { ...base, sender: w.recoveryId }, empty);
  assert.equal(verdict(w, { bytes, signature: fill(1, 64) }), "sender");
});

test("5.6 condition 2: a sender that no log names is refused, and a removed device's message stays readable", () => {
  const w = world();
  const bytes = sealMessage(platform, epochKey, { ...base, sender: fill(99) }, empty);
  assert.equal(verdict(w, { bytes, signature: fill(1, 64) }), "sender");
  assert.equal(verdict(w, signedBy(w.removed)), "ok", "active at the epoch's heads, removed since");
});

test("5.6 condition 3: a signature that does not verify, of another length or over other bytes is refused", () => {
  const w = world();
  const ok = signedBy(w.app);
  assert.equal(verdict(w, { ...ok, signature: ok.signature.slice(0, 63) }), "signature");
  assert.equal(verdict(w, { ...ok, signature: fill(1, 64) }), "signature");
  const other = signedBy(w.app, { counter: 2 });
  assert.equal(verdict(w, { bytes: ok.bytes, signature: other.signature }), "signature");
  const forged = signedBy(w.stranger, { sender: w.app.id });
  assert.equal(verdict(w, forged), "signature", "a stranger's signature under an app's id");
});

test("a message of an epoch the log does not hold, or of another channel, is refused", () => {
  const w = world();
  assert.equal(verdict(w, signedBy(w.app, { epoch: fill(50) })), "epoch");
  assert.equal(verdict(w, signedBy(w.app, { channel: fill(51) })), "epoch");
  assert.equal(verdict({ ...w, epochs: [] }, signedBy(w.app)), "epoch");
});

test("the bytes that are not a message are refused as decode", () => {
  const w = world();
  assert.equal(verdict(w, { bytes: fill(1, 10), signature: fill(1, 64) }), "decode");
});

test("a `to` that is not a bot among the recipients is refused, after the signature", () => {
  const w = world();
  assert.equal(verdict(w, signedBy(w.app, { kind: 2, to: w.bot.id })), "ok");
  assert.equal(verdict(w, signedBy(w.app, { kind: 2, to: w.app.id })), "to", "an app is no bot");
  assert.equal(
    verdict(w, signedBy(w.app, { kind: 2, to: w.stranger.id })),
    "to",
    "not a recipient",
  );
  assert.equal(
    verdict(w, signedBy(w.app, { kind: 2, to: w.recoveryId })),
    "to",
    "a recovery key is no bot",
  );
  const unsigned = signedBy(w.app, { kind: 2, to: w.app.id });
  assert.equal(verdict(w, { ...unsigned, signature: fill(1, 64) }), "signature");
});

test("the id is the hash of the signed bytes: two signatures of one message give one id, a change gives another", () => {
  const w = world();
  const first = signedBy(w.app);
  const again = platform.sign(w.app.sign, first.bytes);
  assert.ok(again.ok);
  assert.notDeepEqual(again.value, first.signature, "ECDSA signs differently each time");
  const id = (signature: Bytes) => {
    const v = messageChecker(platform, w.epochs, w.logs, false)(first.bytes, signature);
    assert.ok(v.ok);
    return v.value.id;
  };
  assert.deepEqual(id(first.signature), id(again.value));
  assert.deepEqual(id(first.signature), platform.sha256(first.bytes));
  const second = signedBy(w.app, { counter: 2 });
  const next = messageChecker(platform, w.epochs, w.logs, false)(second.bytes, second.signature);
  assert.ok(next.ok);
  assert.notDeepEqual(next.value.id, id(first.signature));
});

test("R1-1: a device is read from the log where it is active at the epoch's heads", () => {
  const w = world();
  const late = removedDevice(w.stranger); // added and removed after the heads, which cut the log at its genesis
  const epoch = w.epochs[0] as unknown as { entry: { seals: unknown[] } };
  epoch.entry.seals.push({ recipient: late.id, enc: fill(0), sealed: fill(0) });
  assert.equal(verdict(w, signedBy(late)), "sender", "not active at the heads");
});

test("C1-1: a member cannot name another member's device, under either kind: the add is refused with `proof` [cross-log]", () => {
  const w = world();
  const mallory = device("app");
  const person = (mallory.log[0] as LoggedEntry).id;
  // The proof the owner's log holds for its own second device: made for the owner's person.
  const copied = ((w.app.log[1] as LoggedEntry).entry as { proof: Bytes }).proof;
  for (const kind of ["app", "bot"] as const) {
    for (const keys of [w.bot.keys, w.removed.keys]) {
      const named = { kind, ...keys };
      // Mallory's own key signs a proof for her person, or she copies the owner's.
      const made = makeProof(platform, mallory.sign, person, named);
      for (const proof of [made, copied]) {
        const bytes = encodeDeviceEntry({
          person,
          seq: 1,
          prev: mallory.log[0]?.id,
          kind: "add",
          device: named,
          proof,
          signer: mallory.id,
        });
        const signature = platform.sign(mallory.sign, bytes);
        assert.ok(signature.ok);
        assert.deepEqual(checkDeviceEntry(platform, mallory.log, bytes, signature.value), {
          ok: false,
          rule: "proof",
        });
      }
    }
  }
});

test("R1-1: two logs that name one id with two kinds name no device, in either order", () => {
  const w = world();
  const other = device("app");
  step(other, { kind: "add", device: { kind: "app", ...w.bot.keys } }); // the bot's keys, named as an app
  const heads = (w.epochs[0] as unknown as { entry: { deviceHeads: unknown[] } }).entry.deviceHeads;
  heads.push({
    person: (other.log[0] as LoggedEntry).id,
    length: other.log.length,
    last: (other.log.at(-1) as LoggedEntry).id,
  });
  const prompt = signedBy(w.app, { kind: 2, to: w.bot.id });
  const answer = signedBy(w.bot, { kind: 5, re: { device: w.app.id, name: fill(9, 16) } });
  for (const logs of [
    [...w.logs, other.log],
    [other.log, ...w.logs],
  ]) {
    const check = messageChecker(platform, w.epochs, logs, false);
    const [a, b] = [check(prompt.bytes, prompt.signature), check(answer.bytes, answer.signature)];
    assert.deepEqual([a.ok ? "ok" : a.rule, b.ok ? "ok" : b.rule], ["to", "sender"]);
  }
});

test("R1-2: an edit and a part name the sender's own message, a reply the message of its `to`", () => {
  const w = world();
  const name = fill(9, 16);
  const edit = (by: typeof w.app, of: Bytes) =>
    signedBy(by, { kind: 11, re: { device: of, name } });
  assert.equal(verdict(w, edit(w.app, w.app.id)), "ok");
  assert.equal(verdict(w, edit(w.bot, w.app.id)), "re", "a replacement from another device");
  const part = (of: Bytes) => signedBy(w.bot, { kind: 4, re: { device: of, name } });
  assert.equal(verdict(w, part(w.bot.id)), "ok");
  assert.equal(verdict(w, part(w.app.id)), "re");
  const reply = (of: Bytes) =>
    signedBy(w.app, { kind: 10, to: w.bot.id, re: { device: of, name } });
  assert.equal(verdict(w, reply(w.bot.id)), "ok");
  assert.equal(verdict(w, reply(w.app.id)), "re");
});

test("R1-3: the Sent-by column: an app sends prompts and replies, a bot the rest, text and edits are open", () => {
  const w = world();
  const re = { device: w.app.id, name: fill(9, 16) };
  const own = { device: w.bot.id, name: fill(9, 16) };
  const sent: [number, Partial<MessageHeader>][] = [
    [2, { to: w.bot.id }],
    [3, { re }],
    [4, { re: own }],
    [5, { re }],
    [6, { re }],
    [7, { re }],
    [8, {}],
    [9, { re }],
    [10, { to: w.bot.id, re: own }],
    [12, {}],
    [13, {}],
  ];
  for (const [kind, over] of sent) {
    const app = kind === 2 || kind === 10;
    const [right, wrong] = app ? [w.app, w.bot] : [w.bot, w.app];
    const space = kind === 13; // a profile is checked in the class of its channel
    assert.equal(verdict(w, signedBy(right, { kind, ...over }), space), "ok", `kind ${kind}`);
    assert.equal(verdict(w, signedBy(wrong, { kind, ...over }), space), "kind", `kind ${kind}`);
  }
  assert.equal(verdict(w, signedBy(w.app, { kind: 1 })), "ok");
  assert.equal(verdict(w, signedBy(w.bot, { kind: 1 })), "ok");
});

test("R1-5: a counter past 100,000 is not sealed and not accepted", () => {
  const w = world();
  assert.doesNotThrow(() => sealMessage(platform, epochKey, { ...base, counter: 100_000 }, empty));
  assert.throws(
    () => sealMessage(platform, epochKey, { ...base, counter: 100_001 }, empty),
    RangeError,
  );
  assert.throws(() => sealMessage(platform, epochKey, { ...base, counter: 2 ** 32 }, empty));
  const bytes = encodeMessage({
    header: header({ sender: w.app.id, counter: 100_001 }),
    ciphertext: fill(0, 16),
  });
  const signature = platform.sign(w.app.sign, bytes);
  assert.ok(signature.ok);
  assert.equal(verdict(w, { bytes, signature: signature.value }), "counter");
});

test("5.6 condition 2: a recovery key that was replaced is not a sender either [model]", () => {
  const rs = platform.makeKeyPair("msg.rec.s", "sign");
  const rr = platform.makeKeyPair("msg.rec.r", "receive");
  assert.ok(rs.ok && rr.ok);
  const old = { signing: rs.value, receiving: rr.value };
  const app = device("app", old);
  const next = { signing: pk(7), receiving: pk(8) };
  const reset = encodeDeviceEntry({
    person: (app.log[0] as LoggedEntry).id,
    seq: 1,
    prev: app.log[0]?.id,
    kind: "reset",
    set: [app.id],
    recovery: next,
    signer: recoveryKeyId(platform, old.signing, old.receiving),
  });
  const signature = platform.sign("msg.rec.s", reset);
  assert.ok(signature.ok);
  const done = checkDeviceEntry(platform, app.log, reset, signature.value);
  assert.ok(done.ok);
  app.log.push(done.value);
  const oldId = recoveryKeyId(platform, old.signing, old.receiving);
  const epochs = epochOf([app], [app.id, oldId]);
  const bytes = sealMessage(platform, epochKey, { ...base, sender: oldId }, empty);
  const signed = platform.sign("msg.rec.s", bytes);
  assert.ok(signed.ok);
  assert.equal(messageChecker(platform, epochs, [app.log], false)(bytes, signed.value).ok, false);
});

/** An epoch whose heads are the whole logs of `persons` and whose recipients are `ids`. */
const epochOf = (persons: Device[], ids: Bytes[]) =>
  [
    {
      id: fill(2),
      entry: {
        channel: fill(1),
        deviceHeads: persons.map((d) => ({
          person: (d.log[0] as LoggedEntry).id,
          length: d.log.length,
          last: (d.log.at(-1) as LoggedEntry).id,
        })),
        seals: ids.map((recipient) => ({ recipient, enc: fill(0), sealed: fill(0) })),
      },
    },
  ] as unknown as LoggedEpoch[];

// The reviewer's scratch tests A, B and C.
test("A: an edit whose re names another device's message is refused", () => {
  const app = device("app");
  const bot = device("bot", { signing: pk(3), receiving: pk(4) });
  const forged = signedBy(bot, { kind: 11, re: { device: app.id, name: fill(9, 16) } });
  const v = messageChecker(
    platform,
    epochOf([app, bot], [app.id, bot.id]),
    [app.log, bot.log],
    false,
  )(forged.bytes, forged.signature);
  assert.equal(v.ok, false);
});

test("B: an app sends an answer, a bot sends a prompt: the Sent-by column", () => {
  const app = device("app");
  const bot = device("bot", { signing: pk(3), receiving: pk(4) });
  const bot2 = device("bot", { signing: pk(5), receiving: pk(6) });
  const check = messageChecker(
    platform,
    epochOf([app, bot, bot2], [app.id, bot.id, bot2.id]),
    [app.log, bot.log, bot2.log],
    false,
  );
  const answer = signedBy(app, { kind: 5, re: { device: app.id, name: fill(9, 16) } });
  const prompt = signedBy(bot2, { kind: 2, to: bot.id });
  assert.deepEqual(
    [check(answer.bytes, answer.signature).ok, check(prompt.bytes, prompt.signature).ok],
    [false, false],
  );
});

test("C: the verdict on `to` does not depend on the order of the logs when two name one key pair with two kinds", () => {
  const a = device("app");
  const bot = device("bot", { signing: pk(3), receiving: pk(4) });
  const b = device("app", { signing: pk(5), receiving: pk(6) });
  step(b, { kind: "add", device: { kind: "app", ...bot.keys } }); // B names A's bot's keys as an app
  step(b, { kind: "remove", device: bot.id });
  const epochs = epochOf([a, bot, b], [a.id, bot.id, b.id]);
  const prompt = signedBy(a, { kind: 2, to: bot.id });
  const verdicts = [
    [a.log, bot.log, b.log],
    [b.log, a.log, bot.log],
  ].map((logs) => {
    const v = messageChecker(platform, epochs, logs, false)(prompt.bytes, prompt.signature);
    return v.ok ? "ok" : v.rule;
  });
  assert.deepEqual(verdicts, ["ok", "ok"]);
});

test("C1-3: a device added after the epoch's heads, and still active in the log, is not a sender", () => {
  const w = world();
  const later = device("app");
  step(w.stranger, { kind: "add", device: { kind: "app", ...later.keys } }); // the head cuts the log before it
  (w.epochs[0] as unknown as { entry: { seals: unknown[] } }).entry.seals.push({
    recipient: later.id,
    enc: fill(0),
    sealed: fill(0),
  });
  assert.equal(verdict(w, signedBy(later)), "sender");
});

test("C1-3: the log of a person who is not a member at the heads is not read", () => {
  const w = world();
  const outsider = device("app");
  (w.epochs[0] as unknown as { entry: { seals: unknown[] } }).entry.seals.push({
    recipient: outsider.id,
    enc: fill(0),
    sealed: fill(0),
  });
  assert.equal(verdict({ ...w, logs: [...w.logs, outsider.log] }, signedBy(outsider)), "sender");
});

test("CR-1: a log that does not reach its head, or holds another entry there, gives the verdict `heads`", () => {
  const w = world();
  const heads = (
    w.epochs[0] as unknown as { entry: { deviceHeads: { length: number; last: Bytes }[] } }
  ).entry.deviceHeads;
  const [first] = heads as [{ length: number; last: Bytes }];
  const ok = signedBy(w.app);
  first.length += 1; // beyond the log
  assert.equal(verdict(w, ok), "heads");
  first.length -= 1;
  first.last = fill(77); // an entry the log does not hold there
  assert.equal(verdict(w, ok), "heads");
  assert.equal(
    verdict({ ...w, logs: [w.bot.log, w.stranger.log] }, ok),
    "heads",
    "a member with no log",
  );
});

test("C1-5: an empty log among the devices gives a verdict, not an exception", () => {
  const w = world();
  const ok = signedBy(w.app);
  assert.doesNotThrow(() => verdict({ ...w, logs: [...w.logs, []] }, ok));
  assert.equal(verdict({ ...w, logs: [...w.logs, []] }, ok), "ok");
  assert.equal(verdict({ ...w, logs: [[]] }, ok), "heads");
});

test("CR-4: a checker is fixed for its life; a new one sees a log that has grown", () => {
  const w = world();
  const logs = [w.app.log, w.stranger.log];
  const before = messageChecker(platform, w.epochs, logs, false);
  const message = signedBy(w.bot);
  logs.push(w.bot.log);
  assert.equal(before(message.bytes, message.signature).ok, false, "the old checker is unchanged");
  assert.equal(
    messageChecker(platform, w.epochs, logs, false)(message.bytes, message.signature).ok,
    true,
  );
});

test("CR-5: a bot's answer, start, cut, not-read or request never names the bot's own message", () => {
  const w = world();
  const name = fill(9, 16);
  for (const kind of [3, 5, 6, 7, 9]) {
    assert.equal(verdict(w, signedBy(w.bot, { kind, re: { device: w.app.id, name } })), "ok");
    assert.equal(
      verdict(w, signedBy(w.bot, { kind, re: { device: w.bot.id, name } })),
      "re",
      `kind ${kind}`,
    );
  }
  // A text may answer its sender's own message (6.4: "none, or the message it answers").
  assert.equal(verdict(w, signedBy(w.app, { kind: 1, re: { device: w.app.id, name } })), "ok");
});

test("every `message-check` case of message.json passes", () => {
  const vectors = JSON.parse(
    readFileSync(join(import.meta.dirname, "vectors", "message.json"), "utf8"),
  );
  const checks = vectors.cases.filter((c: { op: string }) => c.op === "message-check");
  assert.ok(checks.length >= 8);
  assert.deepEqual(runVectors(platform, { ...vectors, cases: checks }), []);
});

test("S5, PD 6.4: a profile is accepted in a space only, and every other kind in a conversation channel only", () => {
  const w = world();
  const re = { device: w.app.id, name: fill(9, 16) };
  const own = { device: w.bot.id, name: fill(9, 16) };
  const sent: [number, Partial<MessageHeader>][] = [
    [1, {}],
    [2, { to: w.bot.id }],
    [3, { re }],
    [4, { re: own }],
    [5, { re }],
    [6, { re }],
    [7, { re }],
    [8, {}],
    [9, { re }],
    [10, { to: w.bot.id, re: own }],
    [11, { re: own }],
    [12, {}],
  ];
  for (const [kind, over] of sent) {
    const sender = kind === 2 || kind === 10 ? w.app : w.bot;
    assert.equal(verdict(w, signedBy(sender, { kind, ...over }), false), "ok", `kind ${kind}`);
    assert.equal(verdict(w, signedBy(sender, { kind, ...over }), true), "class", `kind ${kind}`);
  }
  assert.equal(verdict(w, signedBy(w.bot, { kind: 13 }), true), "ok");
  assert.equal(verdict(w, signedBy(w.bot, { kind: 13 }), false), "class");
});

test("sections design 2: an arrangement is an app's, accepted in a space only", () => {
  const w = world();
  assert.equal(verdict(w, signedBy(w.app, { kind: 17 }), true), "ok");
  assert.equal(verdict(w, signedBy(w.app, { kind: 17 }), false), "class");
  assert.equal(verdict(w, signedBy(w.bot, { kind: 17 }), true), "kind");
});

test("S5: the sender's kind is judged before the class, as the model orders them", () => {
  const w = world();
  assert.equal(verdict(w, signedBy(w.app, { kind: 13 }), false), "kind");
  assert.equal(verdict(w, signedBy(w.app, { kind: 13 }), true), "kind");
});
