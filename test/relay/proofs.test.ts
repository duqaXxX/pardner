/**
 * The proofs, the enrolment and the give-back of design 6.1, 6.6 and 3.12, over real TLS on
 * 127.0.0.1 against a relay built from the real sequence. The requests are in `requests.test.ts`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect as tls } from "node:tls";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import { idKey } from "../../src/protocol/device-log.ts";
import { decodeFrame, encodeFrame, type Frame } from "../../src/protocol/frames.ts";
import { EXPORTER_LABEL } from "../../src/protocol/labels.ts";
import { encodeHead, encodeProof, type RelayHead } from "../../src/protocol/proofs.ts";
import { Blobs } from "../../src/relay/blobs.ts";
import { makeCertificate } from "../../src/relay/certificate.ts";
import { failedClosed, relaySigner } from "../../src/relay/directory.ts";
import { PartialBytes } from "../../src/relay/frames-in.ts";
import { FIGURES, Limits } from "../../src/relay/limits.ts";
import { Proofs } from "../../src/relay/proofs.ts";
import { Seals } from "../../src/relay/seals.ts";
import { createServer } from "../../src/relay/server.ts";
import { openAppending, platform, track } from "./support.ts";
import { enrolled, fill, type Keyed, keyed, person, rig } from "./world.ts";

type Rig = Awaited<ReturnType<typeof rig>>;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const within = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), wait(ms).then(() => false)]);

/** The relay of `r` listening over TLS, with its proofs. */
async function relayOf(r: Rig, figures: Partial<typeof FIGURES> = {}, serving = true) {
  const pem = readFileSync(join(r.dir, "key.pem"));
  const limits = new Limits(Date.now, { ...FIGURES, ...figures });
  const lock = track(openSync(r.dir, "r"));
  const incarnation = fill(7, 16);
  const seals = await Seals.open(
    platform,
    r.s.rounds,
    r.seq,
    openAppending(join(r.dir, "seals")),
    r.relay,
  );
  const blobs = new Blobs(platform, r.s.rounds, r.s.seam, join(r.dir, "blobs"));
  blobs.start(r.seq);
  const proofs = new Proofs({
    platform,
    relayPublic: r.publicKey,
    limits,
    log: r.s.log,
    serving: serving
      ? {
          seq: r.seq,
          journal: r.journal,
          rounds: r.s.rounds,
          seam: r.s.seam,
          dir: r.dir,
          lock,
          incarnation,
          seals,
          blobs,
        }
      : null,
  });
  const server = createServer({
    session: (peer) => proofs.session(peer),
    key: pem,
    cert: makeCertificate(pem, platform.random(16)),
    limits,
    budget: new PartialBytes(),
    log: r.s.log,
    random: platform.random,
  });
  const port = await server.listen("127.0.0.1", 0);
  const signHead = relaySigner(createNodePlatform(), pem);
  return { port, server, limits, proofs, incarnation, signHead };
}

/** A device's TLS connection: what the relay sent, decoded as a device would, and its binding. */
async function dial(port: number) {
  const socket = tls({ host: "127.0.0.1", port, rejectUnauthorized: false });
  socket.on("error", () => {});
  const frames: Frame[] = [];
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
      const end = 4 + buffer.readUInt32BE(0);
      const bytes = buffer.subarray(0, end);
      const frame = [false, true].map((p) => decodeFrame(bytes, p, "device")).find((f) => f.ok);
      assert.ok(frame?.ok, "a frame the package decodes");
      frames.push(frame.value);
      buffer = buffer.subarray(end);
    }
  });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await new Promise((resolve) => socket.once("secureConnect", resolve));
  const next = async (): Promise<Frame> => {
    for (let i = 0; i < 400 && frames.length === 0; i++) await wait(5);
    return frames.shift() as Frame;
  };
  const hello = await next();
  assert.equal(hello.type, "hello");
  return {
    socket,
    closed,
    nonce: (hello as Extract<Frame, { type: "hello" }>).relayNonce,
    binding: Uint8Array.from(socket.exportKeyingMaterial(32, EXPORTER_LABEL, Buffer.alloc(0))),
    next,
    /** Nothing arrives within `ms`. */
    quiet: async (ms = 150) => {
      await wait(ms);
      return frames.length === 0;
    },
    send: (frame: Frame) => void socket.write(encodeFrame(frame, false)),
    sendProven: (frame: Frame) => void socket.write(encodeFrame(frame, true)),
    sendRaw: (bytes: Uint8Array) => void socket.write(bytes),
  };
}
type Dial = Awaited<ReturnType<typeof dial>>;

/** `prove active` of `by` for `person` on connection `c`; `over` changes a field of the proof. */
function proveActive(
  r: Rig,
  c: Dial,
  by: Keyed,
  personId: Uint8Array,
  over: Record<string, unknown> = {},
  signer: Keyed = by,
): Frame {
  const proof = {
    kind: "active" as const,
    relay: r.relay,
    deviceNonce: fill(3),
    relayNonce: c.nonce,
    binding: c.binding,
    person: personId,
    device: by.id,
    ...over,
  };
  const sig = platform.sign(signer.sign, encodeProof(proof));
  assert.ok(sig.ok);
  return { type: "prove-active", proof, sig: sig.value };
}

const refusedWith = async (c: Dial, reason: number) => {
  const frame = await c.next();
  assert.deepEqual(frame, { type: "refused", reason });
  assert.equal(await within(c.closed, 2000), true, "a refusal closes the connection");
};

test("an active device's proof is answered served with the incarnation, and leaves the pool that is evicted (6.1)", async (t) => {
  const r = await enrolled();
  const relay = await relayOf(r);
  t.after(() => relay.server.close());
  const c = await dial(relay.port);
  c.send(proveActive(r, c, r.alice.first, r.alice.id));
  assert.deepEqual(await c.next(), { type: "served", incarnation: relay.incarnation });
  assert.equal(relay.limits.unserved, 0, "a served connection leaves the pool that is evicted");
  c.sendProven({ type: "read", from: 0 });
  assert.equal((await c.next()).type, "position", "a request after the proof is answered");
});

test("a person the relay does not hold, and a device the person's log does not name, are refused as unknown (6.1)", async (t) => {
  const r = await enrolled();
  const relay = await relayOf(r);
  t.after(() => relay.server.close());
  const stranger = person();
  const a = await dial(relay.port);
  a.send(proveActive(r, a, stranger.first, stranger.id));
  await refusedWith(a, 2);
  const b = await dial(relay.port);
  b.send(proveActive(r, b, keyed(), r.alice.id));
  await refusedWith(b, 2);
});

test("a signature that does not verify is refused with reason 5, a removed device's too (6.1: the signature before 'removed')", async (t) => {
  const r = await enrolled();
  const bob = keyed();
  r.join(bob);
  r.extend({ kind: "remove", device: bob.id });
  const relay = await relayOf(r);
  t.after(() => relay.server.close());
  const forged = await dial(relay.port);
  forged.send(proveActive(r, forged, r.alice.first, r.alice.id, {}, keyed()));
  await refusedWith(forged, 5);
  const removedForged = await dial(relay.port);
  removedForged.send(proveActive(r, removedForged, bob, r.alice.id, {}, keyed()));
  await refusedWith(removedForged, 5);
  const removed = await dial(relay.port);
  removed.send(proveActive(r, removed, bob, r.alice.id));
  await refusedWith(removed, 1);
});

test("ten proofs refused with reason 5 ban the address; a reason 2 counts toward nothing (4.4)", async (t) => {
  const r = await enrolled();
  const relay = await relayOf(r);
  t.after(() => relay.server.close());
  const refused = async (
    reason: number,
    over: Parameters<typeof proveActive>[4],
    by = r.alice.first,
  ) => {
    const c = await dial(relay.port);
    c.send(proveActive(r, c, by, r.alice.id, over, keyed()));
    await refusedWith(c, reason);
  };
  for (let i = 0; i < 9; i++) await refused(5, {});
  const stranger = await dial(relay.port);
  stranger.send(proveActive(r, stranger, keyed(), person().id));
  await refusedWith(stranger, 2);
  await refused(5, {});
  const banned = await new Promise<boolean>((resolve) => {
    const s = tls({ host: "127.0.0.1", port: relay.port, rejectUnauthorized: false });
    s.on("error", () => resolve(true));
    s.on("secureConnect", () => resolve(false));
  });
  assert.equal(banned, true, "the eleventh connection is destroyed before TLS");
});

test("a proof replayed on another connection is refused: its relay nonce and its binding are this connection's (4.2)", async (t) => {
  const r = await enrolled();
  const relay = await relayOf(r);
  t.after(() => relay.server.close());
  const first = await dial(relay.port);
  const proof = proveActive(r, first, r.alice.first, r.alice.id);
  first.send(proof);
  assert.equal((await first.next()).type, "served");
  const second = await dial(relay.port);
  second.send(proof);
  await refusedWith(second, 5);
  // The nonce is this connection's but the binding is another's: a relay in the middle of two sessions.
  const third = await dial(relay.port);
  third.send(proveActive(r, third, r.alice.first, r.alice.id, { binding: first.binding }));
  await refusedWith(third, 5);
  // And a proof for another relay.
  const fourth = await dial(relay.port);
  fourth.send(proveActive(r, fourth, r.alice.first, r.alice.id, { relay: fill(8) }));
  await refusedWith(fourth, 5);
});

test("a device holds four served connections: a fifth closes the oldest (4.6)", async (t) => {
  const r = await enrolled();
  const relay = await relayOf(r);
  t.after(() => relay.server.close());
  const open: Dial[] = [];
  for (let i = 0; i < 5; i++) {
    const c = await dial(relay.port);
    c.send(proveActive(r, c, r.alice.first, r.alice.id));
    assert.equal((await c.next()).type, "served");
    open.push(c);
    await wait(10);
  }
  assert.equal(await within(open[0]?.closed as Promise<void>, 2000), true, "the oldest is closed");
  for (const c of open.slice(1)) assert.equal(await within(c.closed, 100), false);
});

test("a closed connection leaves its device's set: the newest two closed and two opened keep four live (4.6)", async (t) => {
  const r = await enrolled();
  const relay = await relayOf(r);
  t.after(() => relay.server.close());
  const open: Dial[] = [];
  const serve = async () => {
    const c = await dial(relay.port);
    c.send(proveActive(r, c, r.alice.first, r.alice.id));
    assert.equal((await c.next()).type, "served");
    open.push(c);
    await wait(10);
  };
  for (let i = 0; i < 4; i++) await serve();
  open[2]?.socket.destroy();
  open[3]?.socket.destroy();
  await wait(100);
  await serve();
  await serve();
  for (const c of [...open.slice(0, 2), ...open.slice(4)])
    assert.equal(await within(c.closed, 100), false);
});

test("served waits until what the proof rests on is on disk: a device added and not yet synced (3.6, 6.1)", async (t) => {
  const r = await enrolled();
  const bob = keyed();
  await r.flush();
  const relay = await relayOf(r);
  t.after(() => {
    r.pending.hold = false;
    r.pending.release?.();
    return relay.server.close();
  });
  r.pending.hold = true;
  r.join(bob); // placed in memory, its round held
  const c = await dial(relay.port);
  c.send(proveActive(r, c, bob, r.alice.id));
  assert.equal(await c.quiet(300), true, "no served while the round is held");
  r.pending.hold = false;
  r.pending.release?.();
  assert.equal((await c.next()).type, "served");
});

test("the connections of a removed device are told refused 1 and closed; another device's stay (6.1)", async (t) => {
  const r = await enrolled();
  const bob = keyed();
  r.join(bob);
  const relay = await relayOf(r);
  t.after(() => relay.server.close());
  const mine = await dial(relay.port);
  mine.send(proveActive(r, mine, r.alice.first, r.alice.id));
  const his = await dial(relay.port);
  his.send(proveActive(r, his, bob, r.alice.id));
  assert.equal((await mine.next()).type, "served");
  assert.equal((await his.next()).type, "served");
  const out = r.send(r.a, 1, r.alice.remove(r.log(), bob));
  assert.deepEqual(out.removed.map(idKey), [idKey(bob.id)]);
  relay.proofs.removed(out.removed);
  assert.deepEqual(await his.next(), { type: "refused", reason: 1 });
  assert.equal(await within(his.closed, 2000), true);
  assert.equal(await within(mine.closed, 100), false);
});

/** `prove recovery` of `r`'s person naming `newDevice`; `over` changes a field of the proof. */
function proveRecovery(
  r: Awaited<ReturnType<typeof enrolled>>,
  c: Dial,
  newDevice: Keyed,
  over: Record<string, unknown> = {},
  deviceSigner: Keyed = newDevice,
): Frame {
  const proof = {
    kind: "recovery" as const,
    relay: r.relay,
    deviceNonce: fill(3),
    relayNonce: c.nonce,
    binding: c.binding,
    person: r.alice.id,
    recovery: r.alice.recovery.recoveryId,
    newDevice: newDevice.device,
    ...over,
  };
  const bytes = encodeProof(proof);
  const sigs = [r.alice.recovery, deviceSigner].map((k) => platform.sign(k.sign, bytes));
  assert.ok(sigs[0]?.ok && sigs[1]?.ok);
  return { type: "prove-recovery", proof, recoverySig: sigs[0].value, deviceSig: sigs[1].value };
}

test("refused 1 and refused 3 wait until what they rest on is on disk (6.1, SD 5.3)", async (t) => {
  const r = await enrolled();
  const bob = keyed();
  r.join(bob);
  await r.flush();
  const relay = await relayOf(r);
  t.after(() => {
    r.pending.hold = false;
    r.pending.release?.();
    return relay.server.close();
  });
  r.pending.hold = true;
  r.extend({ kind: "remove", device: bob.id }); // placed in memory, its round held
  const removed = await dial(relay.port);
  removed.send(proveActive(r, removed, bob, r.alice.id));
  assert.equal(await removed.quiet(300), true, "refused 1 waits for the removal");
  const wrong = await dial(relay.port);
  wrong.send(proveRecovery(r, wrong, keyed(), { recovery: keyed().recoveryId }));
  assert.equal(await wrong.quiet(300), true, "refused 3 waits too");
  r.pending.hold = false;
  r.pending.release?.();
  await refusedWith(removed, 1);
  await refusedWith(wrong, 3);
});

test("a proof of recovery names the current recovery key: another's is refused 3, a bad signature 5, a good one is not answered and holds a pool slot (6.1)", async (t) => {
  const r = await enrolled();
  const relay = await relayOf(r, {}, true);
  t.after(() => relay.server.close());
  const fresh = keyed();
  const recover = (c: Dial, over: Record<string, unknown> = {}, deviceSigner = fresh) =>
    proveRecovery(r, c, fresh, over, deviceSigner);
  const wrong = await dial(relay.port);
  wrong.send(recover(wrong, { recovery: keyed().recoveryId }));
  await refusedWith(wrong, 3);
  const unknown = await dial(relay.port);
  unknown.send(recover(unknown, { person: fill(1) }));
  await refusedWith(unknown, 2);
  const forged = await dial(relay.port);
  forged.send(recover(forged, {}, keyed()));
  await refusedWith(forged, 5);
  const good = await dial(relay.port);
  good.send(recover(good));
  assert.equal(await good.quiet(300), true, "no answer until a request");
  assert.equal(relay.limits.unserved, 0, "it is in the recovery pool, never evicted");
  const second = await dial(relay.port);
  second.send(recover(second));
  const third = await dial(relay.port);
  third.send(recover(third));
  assert.equal(
    await within(third.closed, 2000),
    true,
    "two a connection address, the third closes with no answer",
  );
  assert.equal(await within(good.closed, 100), false);
});

/** A proof of upload of `head` from `by` on `c`, the relay's signature over the head given. */
function proveUpload(r: Rig, c: Dial, by: Keyed, head: RelayHead, relaySig: Uint8Array): Frame {
  const proof = {
    kind: "upload" as const,
    relay: r.relay,
    deviceNonce: fill(3),
    relayNonce: c.nonce,
    binding: c.binding,
    device: by.device,
    head,
  };
  const sig = platform.sign(by.sign, encodeProof(proof));
  assert.ok(sig.ok);
  return { type: "prove-upload", proof, deviceSig: sig.value, relaySig };
}

/** The relay's head over its first `n` items, signed as it does. */
function headOf(
  r: Rig,
  relay: { signHead: (m: Uint8Array) => Uint8Array },
  n: number,
  chain?: Uint8Array,
) {
  const head: RelayHead = {
    relay: r.relay,
    n,
    chain: chain ?? (n === 0 ? fill(0) : (r.journal.placed[n - 1]?.chain as Uint8Array)),
  };
  return { head, sig: relay.signHead(encodeHead(head)) };
}

test("a give-back of a head the relay holds is accepted with nothing written; the connection waits in the pool until answered and closes after (3.12, 4.4)", async (t) => {
  const r = await enrolled();
  r.join(keyed());
  const relay = await relayOf(r);
  t.after(() => relay.server.close());
  const length = r.journal.placed.length;
  const { head, sig } = headOf(r, relay, 2);
  const c = await dial(relay.port);
  c.send(proveUpload(r, c, keyed(), head, sig));
  assert.equal(await c.quiet(200), true, "a proof of upload is not answered");
  assert.equal(relay.limits.unserved, 1, "counted with the unproven ones until answered");
  c.sendProven({ type: "upload-done", request: 7, head, sig });
  assert.deepEqual(await c.next(), { type: "result", request: 7, code: 0 });
  assert.equal(await within(c.closed, 2000), true);
  assert.equal(r.journal.placed.length, length, "nothing taken");
  assert.equal(failedClosed(r.dir), false);
  assert.equal(relay.limits.unserved, 0);
});

test("a proof of upload whose head is under another key, or whose signature is the device's only, is refused 5 (6.1)", async (t) => {
  const r = await enrolled();
  const relay = await relayOf(r);
  t.after(() => relay.server.close());
  const { head } = headOf(r, relay, 1);
  const bad = await dial(relay.port);
  bad.send(proveUpload(r, bad, keyed(), head, fill(9, 64)));
  await refusedWith(bad, 5);
});

test("an upload connection holds one frame of 4,096 bytes and closes on any other (4.6)", async (t) => {
  const r = await enrolled();
  const relay = await relayOf(r);
  t.after(() => relay.server.close());
  const { head, sig } = headOf(r, relay, 1);
  const long = await dial(relay.port);
  long.send(proveUpload(r, long, keyed(), head, sig));
  long.sendRaw(Buffer.from([0, 0, 0x10, 1, 0x0c]));
  assert.equal(await within(long.closed, 2000), true);
  const other = await dial(relay.port);
  other.send(proveUpload(r, other, keyed(), head, sig));
  other.sendProven({ type: "read", from: 0 });
  assert.equal(await within(other.closed, 2000), true);
  assert.equal(failedClosed(r.dir), false);
});

test("a served device that finds the relay behind gives back on its served connection; a head under another key is refused 1 and stops nothing (3.12)", async (t) => {
  const r = await enrolled();
  const relay = await relayOf(r);
  t.after(() => relay.server.close());
  const c = await dial(relay.port);
  c.send(proveActive(r, c, r.alice.first, r.alice.id));
  assert.equal((await c.next()).type, "served");
  const { head } = headOf(r, relay, 1);
  c.sendProven({ type: "upload-done", request: 1, head, sig: fill(9, 64) });
  assert.deepEqual(await c.next(), { type: "result", request: 1, code: 1 });
  assert.equal(await within(c.closed, 2000), true);
  assert.equal(failedClosed(r.dir), false);
});

for (const [name, make] of [
  [
    "a head longer than the sequence",
    (r: Rig) => ({ n: r.journal.placed.length + 3, chain: fill(4) }),
  ],
  [
    "a head longer than the sequence whose hash is the one at its end",
    (r: Rig) => ({ n: r.journal.placed.length + 1, chain: r.journal.placed.at(-1)?.chain }),
  ],
  ["another running hash at n", () => ({ n: 2, chain: fill(4) })],
] as const) {
  test(`${name} fails the relay closed: the mark first, then result 11, refused 6 to the others, and every later proof refused 6 (3.12, 6.5)`, async (t) => {
    const r = await enrolled();
    r.join(keyed());
    const relay = await relayOf(r);
    t.after(() => relay.server.close());
    const served = await dial(relay.port);
    served.send(proveActive(r, served, r.alice.first, r.alice.id));
    assert.equal((await served.next()).type, "served");
    const over = make(r) as { n: number; chain?: Uint8Array };
    const { head, sig } = headOf(r, relay, over.n, over.chain);
    const up = await dial(relay.port);
    up.send(proveUpload(r, up, keyed(), head, sig));
    up.sendProven({ type: "upload-done", request: 9, head, sig });
    assert.deepEqual(await up.next(), { type: "result", request: 9, code: 11 });
    assert.equal(failedClosed(r.dir), true, "the mark is on disk before the answer");
    assert.deepEqual(await served.next(), { type: "refused", reason: 6 });
    assert.equal(await within(served.closed, 2000), true);
    assert.equal(await within(up.closed, 2000), true);
    const later = await dial(relay.port);
    later.send(proveActive(r, later, r.alice.first, r.alice.id));
    await refusedWith(later, 6);
  });
}

/** A relay with alice and bob served-ready, a head of its key it does not hold, and the mark's round held. */
async function deciding(t: { after: (f: () => unknown) => void }) {
  const r = await enrolled();
  r.join(keyed());
  await r.flush();
  const relay = await relayOf(r);
  t.after(() => {
    r.pending.hold = false;
    r.pending.release?.();
    return relay.server.close();
  });
  const { head, sig } = headOf(r, relay, 2, fill(4));
  const up = await dial(relay.port);
  up.send(proveUpload(r, up, keyed(), head, sig));
  await wait(50);
  const decide = () => {
    r.pending.hold = true; // every fsync from now on waits: the mark's round does not complete
    up.sendProven({ type: "upload-done", request: 9, head, sig });
  };
  const release = () => {
    r.pending.hold = false;
    r.pending.release?.();
  };
  return { r, relay, up, decide, release };
}

test("while the mark is written nothing is sent to anyone, a connection opened then included, and no mark is on disk; once it is, result 11 and refused 6 (6.5, review CR-S1)", async (t) => {
  const { r, relay, up, decide, release } = await deciding(t);
  decide();
  await wait(100);
  assert.equal(failedClosed(r.dir), false, "the mark is not on disk yet");
  assert.equal(await up.quiet(10), true, "the uploader is told nothing before the mark");
  const late = await dial(relay.port);
  late.send(proveActive(r, late, r.alice.first, r.alice.id));
  assert.equal(
    await late.quiet(300),
    true,
    "a connection opened during the round is answered nothing",
  );
  assert.equal(failedClosed(r.dir), false);
  release();
  assert.deepEqual(await up.next(), { type: "result", request: 9, code: 11 });
  assert.equal(failedClosed(r.dir), true, "the mark is on disk when the answer is sent");
  assert.deepEqual(await late.next(), { type: "refused", reason: 6 });
  assert.equal(await within(late.closed, 2000), true);
});

test("a mark that cannot be written stops the relay with 75 and sends nothing to anyone (6.5)", async (t) => {
  const { r, relay, up, decide } = await deciding(t);
  const served = await dial(relay.port);
  served.send(proveActive(r, served, r.alice.first, r.alice.id));
  assert.equal((await served.next()).type, "served");
  r.s.seam.sync = async () => {
    throw new Error("disk");
  };
  decide();
  const late = await dial(relay.port);
  late.send(proveActive(r, late, r.alice.first, r.alice.id));
  for (let i = 0; i < 100 && r.s.stops.length === 0; i++) await wait(10);
  assert.deepEqual(r.s.stops, [75]);
  for (const c of [up, served, late]) assert.equal(await c.quiet(200), true);
  assert.equal(failedClosed(r.dir), false);
});

test("while deciding, an answer queued behind a round is dropped (served or refused 1) and a removal tells nobody; the first frame every connection gets is refused 6 (6.5, 6.1)", async (t) => {
  const { r, relay, decide, release } = await deciding(t);
  const gone = keyed();
  r.join(gone);
  await r.flush();
  r.pending.hold = true;
  r.extend({ kind: "remove", device: gone.id }); // a write whose round is held: what follows waits for it
  const refused = await dial(relay.port);
  refused.send(proveActive(r, refused, gone, r.alice.id));
  const served = await dial(relay.port);
  served.send(proveActive(r, served, r.alice.first, r.alice.id));
  await wait(100);
  decide();
  await wait(100);
  relay.proofs.removed([r.alice.first.id]);
  assert.equal(await served.quiet(200), true);
  release();
  assert.deepEqual(await served.next(), { type: "refused", reason: 6 });
  assert.deepEqual(await refused.next(), { type: "refused", reason: 6 }, "refused 1 was queued");
});

test("a failed-closed decision pauses every connection that exists and every one that arrives, and answers them only after the mark (6.5)", async (t) => {
  const r = await enrolled();
  r.join(keyed());
  await r.flush();
  const relay = await relayOf(r);
  t.after(() => {
    r.pending.hold = false;
    r.pending.release?.();
    return relay.server.close();
  });
  const peer = () => {
    const calls: string[] = [];
    const fake = {
      remote: "127.0.0.1",
      held: relay.limits.open("127.0.0.1", () => {}) as NonNullable<ReturnType<Limits["open"]>>,
      nonce: fill(1, 32),
      binding: fill(2, 32),
      allow: () => {},
      send: (f: Frame) => {
        calls.push(`send ${f.type}`);
        return true;
      },
      end: (f: Frame) => void calls.push(`end ${f.type}`),
      close: () => void calls.push("close"),
      pause: () => void calls.push("pause"),
      resume: () => void calls.push("resume"),
      drain: () => {},
    };
    relay.limits.hello(fake.held);
    return { fake, calls, session: relay.proofs.session(fake) };
  };
  const before = peer();
  const up = peer();
  const { head, sig } = headOf(r, relay, 2, fill(4));
  assert.equal(
    up.session.frame(proveUpload(r, up.fake as unknown as Dial, keyed(), head, sig)),
    true,
  );
  r.pending.hold = true;
  assert.equal(up.session.frame({ type: "upload-done", request: 9, head, sig }), false);
  const after = peer();
  assert.deepEqual(before.calls, ["pause"]);
  assert.deepEqual(up.calls, ["pause"]);
  assert.deepEqual(after.calls, ["pause"], "paused at once, before anything is read");
  assert.equal(
    after.session.frame(proveActive(r, after.fake as unknown as Dial, r.alice.first, r.alice.id)),
    false,
  );
  await wait(100);
  assert.deepEqual(after.calls, ["pause"], "a frame read meanwhile is answered nothing");
  r.pending.hold = false;
  r.pending.release?.();
  for (let i = 0; i < 100 && after.calls.length < 2; i++) await wait(10);
  assert.deepEqual(up.calls, ["pause", "end result"]);
  assert.deepEqual(before.calls, ["pause", "end refused"]);
  assert.deepEqual(after.calls, ["pause", "end refused"]);
});

test("a relay that started failed closed answers every proof refused 6, unchecked, and serves nothing (5.1)", async (t) => {
  const r = await rig();
  const relay = await relayOf(r, {}, false);
  t.after(() => relay.server.close());
  const alice = person();
  const c = await dial(relay.port);
  c.send(proveActive(r, c, alice.first, alice.id, {}, keyed()));
  await refusedWith(c, 6);
  const d = await dial(relay.port);
  d.send({ type: "enrol", secret: fill(1), signed: alice.genesis.signed, sig: alice.genesis.sig });
  d.send(proveActive(r, d, alice.first, alice.id));
  await refusedWith(d, 6);
  assert.equal(r.seq.devices.size, 0, "nothing is placed");
});

/** A relay with no person, and the enrolment secret `init` would have printed. */
async function fresh() {
  const r = await rig();
  const secret = fill(0x5e);
  const enrolFile = join(r.dir, "enrol");
  (await import("node:fs")).writeFileSync(enrolFile, createHash("sha256").update(secret).digest());
  const relay = await relayOf(r);
  return { r, relay, secret, enrolFile, alice: person() };
}

test("an enrolment with the secret is never answered; the proof that follows is served once the genesis is on disk, and the secret's file goes (6.6, 3.3)", async (t) => {
  const { r, relay, secret, enrolFile, alice } = await fresh();
  t.after(() => relay.server.close());
  const c = await dial(relay.port);
  c.send({ type: "enrol", secret, signed: alice.genesis.signed, sig: alice.genesis.sig });
  assert.equal(await c.quiet(200), true, "nothing is sent for the enrolment");
  c.send(proveActive(r, c, alice.first, alice.id));
  assert.deepEqual(await c.next(), { type: "served", incarnation: relay.incarnation });
  await r.flush();
  for (let i = 0; i < 100 && existsSync(enrolFile); i++) await wait(5);
  assert.equal(
    existsSync(enrolFile),
    false,
    "valid once: the hash is removed with the genesis on disk",
  );
  assert.equal(r.seq.devices.size, 1);
});

test("the secret's file stays until the genesis it allowed is on disk (6.6, 3.3)", async (t) => {
  const { r, relay, secret, enrolFile, alice } = await fresh();
  t.after(() => {
    r.pending.hold = false;
    r.pending.release?.();
    return relay.server.close();
  });
  r.pending.hold = true;
  const c = await dial(relay.port);
  c.send({ type: "enrol", secret, signed: alice.genesis.signed, sig: alice.genesis.sig });
  c.send(proveActive(r, c, alice.first, alice.id));
  assert.equal(await c.quiet(300), true, "not served while the round is held");
  assert.equal(
    existsSync(enrolFile),
    true,
    "the secret is still good while the genesis is not on disk",
  );
  r.pending.hold = false;
  r.pending.release?.();
  assert.equal((await c.next()).type, "served");
  for (let i = 0; i < 100 && existsSync(enrolFile); i++) await wait(5);
  assert.equal(existsSync(enrolFile), false);
});

test("an enrolment with a wrong secret places nothing, its proof is refused as unknown, and ten of them ban the address (6.6, 4.4)", async (t) => {
  const { r, relay, alice } = await fresh();
  t.after(() => relay.server.close());
  for (let i = 0; i < 10; i++) {
    const c = await dial(relay.port);
    c.send({
      type: "enrol",
      secret: fill(1),
      signed: alice.genesis.signed,
      sig: alice.genesis.sig,
    });
    c.send(proveActive(r, c, alice.first, alice.id));
    await refusedWith(c, 2);
  }
  assert.equal(r.seq.devices.size, 0);
  const banned = await new Promise<boolean>((resolve) => {
    const s = tls({ host: "127.0.0.1", port: relay.port, rejectUnauthorized: false });
    s.on("error", () => resolve(true));
    s.on("secureConnect", () => resolve(false));
  });
  assert.equal(banned, true, "the eleventh connection is destroyed before TLS");
});

test("a replayed enrolment: the identical genesis is served again and writes nothing; another genesis, even with the right secret, places nothing (6.6)", async (t) => {
  const { r, relay, secret, alice } = await fresh();
  t.after(() => relay.server.close());
  const first = await dial(relay.port);
  first.send({ type: "enrol", secret, signed: alice.genesis.signed, sig: alice.genesis.sig });
  first.send(proveActive(r, first, alice.first, alice.id));
  assert.equal((await first.next()).type, "served");
  await r.flush();
  const length = r.journal.placed.length;
  // The file is gone, and the secret with it: the identical genesis needs neither.
  const again = await dial(relay.port);
  again.send({
    type: "enrol",
    secret: fill(1),
    signed: alice.genesis.signed,
    sig: alice.genesis.sig,
  });
  again.send(proveActive(r, again, alice.first, alice.id));
  assert.equal((await again.next()).type, "served");
  const bob = person();
  const other = await dial(relay.port);
  other.send({ type: "enrol", secret, signed: bob.genesis.signed, sig: bob.genesis.sig });
  other.send(proveActive(r, other, bob.first, bob.id));
  await refusedWith(other, 2);
  assert.equal(r.journal.placed.length, length, "nothing more is placed");
});

test("a second enrol on one connection, and a proof of another kind after an enrol, close it (6.1)", async (t) => {
  const { r, relay, secret, alice } = await fresh();
  t.after(() => relay.server.close());
  const twice = await dial(relay.port);
  const enrol: Frame = {
    type: "enrol",
    secret,
    signed: alice.genesis.signed,
    sig: alice.genesis.sig,
  };
  twice.send(enrol);
  twice.send(enrol);
  assert.equal(await within(twice.closed, 2000), true);
  const { head, sig } = headOf(r, relay, 0);
  const upload = await dial(relay.port);
  upload.send({
    type: "enrol",
    secret: fill(1),
    signed: alice.genesis.signed,
    sig: alice.genesis.sig,
  });
  upload.send(proveUpload(r, upload, keyed(), head, sig));
  assert.equal(await within(upload.closed, 2000), true);
});

test("section 7: every refused proof is counted, whatever its reason (1, 2, 3, 5, 6), and an enrolment is no proof (F6)", async (t) => {
  const r = await enrolled();
  const bob = keyed();
  r.join(bob);
  r.extend({ kind: "remove", device: bob.id });
  const relay = await relayOf(r);
  t.after(() => relay.server.close());
  const refused = async (frame: (c: Dial) => Frame, reason: number) => {
    const c = await dial(relay.port);
    c.send(frame(c));
    await refusedWith(c, reason);
  };
  const stranger = person();
  const newcomer = keyed();
  await refused((c) => proveActive(r, c, bob, r.alice.id), 1);
  await refused((c) => proveActive(r, c, stranger.first, stranger.id), 2);
  await refused((c) => proveRecovery(r, c, newcomer, { recovery: keyed().recoveryId }), 3);
  await refused((c) => proveActive(r, c, r.alice.first, r.alice.id, {}, keyed()), 5);
  assert.equal(relay.limits.take().refused, 4, "one for each reason of a served relay");

  const closed = await relayOf(await rig(), {}, false);
  t.after(() => closed.server.close());
  const c = await dial(closed.port);
  c.send(proveActive(r, c, stranger.first, stranger.id));
  await refusedWith(c, 6);
  assert.equal(closed.limits.take().refused, 1, "a failed-closed relay's refusal 6");

  const secret = await fresh();
  t.after(() => secret.relay.server.close());
  const e = await dial(secret.relay.port);
  e.send({
    type: "enrol",
    secret: fill(1),
    signed: secret.alice.genesis.signed,
    sig: secret.alice.genesis.sig,
  });
  assert.equal(await e.quiet(200), true, "an enrolment is never answered");
  assert.equal(secret.relay.limits.take().refused, 0, "a wrong secret is no refused proof");
});
