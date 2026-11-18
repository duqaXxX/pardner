/**
 * Real keys, entries, epochs and messages for the tests of the relay's duties: every item is
 * signed by the platform and checked by the package, and only the relay's own check is under test.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import {
  type DeviceEntry,
  type DeviceKeys,
  encodeDeviceEntry,
  idKey,
  type LoggedEntry,
} from "../../src/protocol/device-log.ts";
import {
  buildEpoch,
  type EpochEntry,
  encodeEpochEntry,
  openEpochSeal,
  sealEpochKey,
} from "../../src/protocol/epochs.ts";
import { deviceId, recoveryKeyId } from "../../src/protocol/ids.ts";
import { encodeMemberEntry, type MemberEntry } from "../../src/protocol/member-log.ts";
import { type MessageHeader, sealMessage } from "../../src/protocol/messages.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { relayPublicKey, relaySigner } from "../../src/relay/directory.ts";
import { Code, type Conn, type Fetched, type Read, Sequence } from "../../src/relay/sequence.ts";
import { makeProof } from "../protocol/proof.ts";
import { tempDirSync } from "../support/temp.ts";
import { fakeSeam, makeRelayDir, openAppending, platform } from "./support.ts";

let counter = 0;
export const fill = (n: number, length = 32): Bytes => new Uint8Array(length).fill(n);

/** A device or a recovery key: a signing and a receiving key the platform holds, by name (`name` when a script names it). */
export function keyed(kind: "app" | "bot" = "app", name = `relay.${counter++}`) {
  const signing = platform.makeKeyPair(`${name}.s`, "sign");
  const receiving = platform.makeKeyPair(`${name}.r`, "receive");
  assert.ok(signing.ok && receiving.ok, `the key ${name} is already held`);
  const keys = { signing: signing.value, receiving: receiving.value };
  return {
    sign: `${name}.s`,
    keys,
    device: { kind, ...keys } as DeviceKeys,
    id: deviceId(platform, keys.signing, keys.receiving),
    recoveryId: recoveryKeyId(platform, keys.signing, keys.receiving),
  };
}
export type Keyed = ReturnType<typeof keyed>;

/** `bytes` signed by `by`: what a `submit` frame carries. */
export function signedBy(by: Keyed, bytes: Bytes) {
  const sig = platform.sign(by.sign, bytes);
  assert.ok(sig.ok);
  return { signed: bytes, sig: sig.value };
}

/** A person: a first device, a recovery key, and the entries that extend its log as the relay holds it. */
export function person(first = keyed(), recovery = keyed()) {
  const genesis = signedBy(
    first,
    encodeDeviceEntry({
      seq: 0,
      kind: "genesis",
      device: first.device,
      recovery: recovery.keys,
      signer: first.id,
    }),
  );
  const id = platform.sha256(genesis.signed);
  return {
    first,
    recovery,
    id,
    genesis,
    conn: (device = first): Conn => ({ person: id, device: device.id }),
    /** The entry at `log`'s end, signed by `by` (the first device, or the recovery key for a reset). */
    entry(log: readonly LoggedEntry[], body: Record<string, unknown>, by = first) {
      const signer = by === recovery ? by.recoveryId : by.id;
      const head = { person: id, seq: log.length, prev: log.at(-1)?.id, signer };
      return signedBy(by, encodeDeviceEntry({ ...head, ...body } as unknown as DeviceEntry));
    },
    add(log: readonly LoggedEntry[], other: Keyed) {
      return this.entry(log, {
        kind: "add",
        device: other.device,
        proof: makeProof(platform, other.sign, id, other.device),
      });
    },
    remove(log: readonly LoggedEntry[], other: Keyed) {
      return this.entry(log, { kind: "remove", device: other.id });
    },
  };
}
export type Person = ReturnType<typeof person>;

/** A member entry signed by `by`'s first device. */
export function memberEntry(by: Person, log: { id: Bytes }[], body: Record<string, unknown>) {
  const head = log.length ? { channel: (log[0] as { id: Bytes }).id, prev: log.at(-1)?.id } : {};
  return signedBy(
    by.first,
    encodeMemberEntry({
      ...head,
      seq: log.length,
      ...body,
      signerPerson: by.id,
      signerDevice: by.first.id,
    } as unknown as MemberEntry),
  );
}

/**
 * An epoch entry for the channel of `seq` at the heads the relay holds now, sealed to its recipients
 * by the package's builder; `over` changes the entry before it is signed and `extra` seals to more.
 */
export function epochEntry(
  seq: Sequence,
  channel: Bytes,
  by: { person: Person; device: Keyed },
  persons: Person[],
  over: Partial<EpochEntry> = {},
  extra: { id: Bytes; receiving: Bytes }[] = [],
) {
  const held = seq.channels.get(idKey(channel));
  assert.ok(held);
  const logs = persons.map((p) => seq.devices.get(idKey(p.id)) as LoggedEntry[]);
  const built = buildEpoch(platform, held.members, held.epochs, logs, {
    person: by.person.id,
    device: by.device.id,
    sign: by.device.sign,
  });
  assert.ok(built.ok);
  // The package keeps the key to itself: the test reads it back from the seal of the signing device.
  const opened = openEpochSeal(
    platform,
    by.device.sign.replace(/\.s$/, ".r"),
    { entry: built.value.entry, id: platform.sha256(built.value.signed) },
    by.device.id,
  );
  assert.ok(opened.ok);
  const key = opened.value;
  const prev = held.epochs.at(-1)?.id;
  const seals = extra.map((r) => {
    const sealed = sealEpochKey(platform, channel, prev, r.id, r.receiving, key);
    assert.ok(sealed.ok);
    return sealed.value;
  });
  const entry: EpochEntry = {
    ...built.value.entry,
    seals: [...built.value.entry.seals, ...seals],
    ...over,
  };
  return { ...signedBy(by.device, encodeEpochEntry(entry)), key, entry };
}

/** A message of `sender` in `epoch`, signed; `over` changes the header, `files` the blobs it names. */
export function message(
  sender: Keyed,
  channel: Bytes,
  epoch: { id: Bytes; key: Bytes },
  over: Partial<MessageHeader> = {},
  files: Bytes[] = [],
) {
  const header = {
    channel,
    counter: 1,
    epoch: epoch.id,
    sender: sender.id,
    run: fill(4, 16),
    incarnation: fill(5, 16),
    time: 1_700_000_000_000,
    kind: 1,
    name: fill(6, 16),
    ...over,
  };
  const body = {
    files: files.map((blob) => ({ blob, fileKey: fill(9), size: 1, type: "x", name: "f" })),
    content: "{}",
  };
  return signedBy(sender, sealMessage(platform, epoch.key, header, body));
}

/** A relay directory with a journal and a `Sequence` over it, as `serve` would build them. */
export async function rig(held: (blob: Bytes) => boolean = () => true) {
  const dir = tempDirSync("pardner-relay-");
  const relay = makeRelayDir(dir);
  const pem = readFileSync(join(dir, "key.pem"));
  const sign = relaySigner(createNodePlatform(), pem);
  const pending: { hold: boolean; release?: () => void } = { hold: false };
  const s = fakeSeam({
    sync: async (fd) => {
      s.syncs.push(fd);
      if (pending.hold) await new Promise<void>((resolve) => (pending.release = resolve));
    },
  });
  const restart = async () => {
    const { journal, seq } = await Sequence.open(
      platform,
      s.rounds,
      openAppending(join(dir, "journal")),
      { relay, sign, held },
    );
    return { journal, seq };
  };
  const first = await restart();
  return {
    ...first,
    s,
    relay,
    dir,
    publicKey: relayPublicKey(pem),
    pending,
    restart,
    flush: () => s.rounds.wait(s.rounds.written),
  };
}

export const DEVICE = 1;
type Signed = { signed: Bytes; sig: Bytes };

/** The body of an add of `device` to `p`'s log, with the proof of possession the device makes. */
export const addBody = (p: Person, device: Keyed) => ({
  kind: "add",
  device: device.device,
  proof: makeProof(platform, device.sign, p.id, device.device),
});

/** A relay with alice enrolled; `extend` and `join` add entries her first device signs, which the relay must accept. */
export async function enrolled(held?: (blob: Bytes) => boolean) {
  const r = await rig(held);
  const alice = person();
  assert.equal(typeof r.seq.enrol(alice.genesis.signed, alice.genesis.sig, () => true), "number");
  const log = () => r.seq.devices.get(idKey(alice.id)) as LoggedEntry[];
  const send = (conn: Conn, kind: number, e: Signed) => r.seq.submit(conn, kind, e.signed, e.sig);
  const a = alice.conn();
  const extend = (body: Record<string, unknown>) => {
    const out = send(a, DEVICE, alice.entry(log(), body));
    assert.equal(out.code, Code.accepted);
    return out;
  };
  const join = (device: Keyed) => extend(addBody(alice, device));
  return { ...r, alice, a, log, send, extend, join };
}

/** The read a device is served: the test fails when the relay answered "removed". */
export function served(answer: Fetched): Read {
  assert.equal(answer.removed, false);
  return answer as Read;
}

const MEMBER = 2;
const EPOCH = 3;

/** A relay with alice enrolled, her channel created and its first epoch placed. */
export async function channelled(held: (blob: Bytes) => boolean = () => true) {
  const r = await enrolled(held);
  const { alice, a, send } = r;
  const create = memberEntry(alice, [], { kind: "create", nonce: fill(3, 16) });
  assert.equal(send(a, MEMBER, create).code, Code.accepted);
  const channel = platform.sha256(create.signed);
  const epoch = (
    by: Keyed = alice.first,
    over = {},
    extra: Parameters<typeof epochEntry>[5] = [],
  ) => {
    const e = epochEntry(r.seq, channel, { person: alice, device: by }, [alice], over, extra);
    return { ...e, id: platform.sha256(e.signed) };
  };
  const open = (by: Keyed = alice.first) => {
    const e = epoch(by);
    assert.equal(send(alice.conn(by), EPOCH, e).code, Code.accepted);
    return { id: e.id, key: e.key, entry: e };
  };
  return { ...r, channel, epoch, open, create };
}
