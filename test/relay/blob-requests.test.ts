/**
 * Design 3.11, 6.2 and 6.3 step 3: a served connection's `put blob` and `get blob`, and what each
 * round does to the blobs (`sweep`, `dropRemoved`, `expire`). As in `requests.test.ts`, an answer
 * before its round is tested with the round held, never with an `fsync` that returns at once.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { Frame } from "../../src/protocol/frames.ts";
import { KIND_BUILD } from "../../src/protocol/messages.ts";
import { Blobs } from "../../src/relay/blobs.ts";
import { type Device, hold, relayOver, settle } from "./session.ts";
import { platform } from "./support.ts";
import { channelled, fill, keyed, message } from "./world.ts";

const MESSAGE = 4;
const DEVICE = 1;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (n: number, seed: number) => Buffer.alloc(n, seed);

async function world(limits: ConstructorParameters<typeof Blobs>[4] = {}) {
  let blobs: Blobs | undefined;
  const w = await channelled((b) => blobs?.held(b) ?? true);
  const bot = keyed("bot");
  w.join(bot); // a build is a bot's: it joins before the epoch that holds it
  const epoch = w.open();
  await w.flush();
  blobs = new Blobs(platform, w.s.rounds, w.s.seam, join(w.dir, "blobs"), limits);
  const relay = await relayOver(w, {}, blobs);
  const me = await relay.connect().prove(w.alice.first, w.alice);
  const botConn = await relay.connect().prove(bot, w.alice);
  let request = 0;
  const send = (d: Device, f: Frame extends infer F ? F : never) => d.frame(f);
  const put = (
    d: Device,
    data: Uint8Array,
    over: { size?: number; offset?: number; chunk?: Uint8Array; blob?: Uint8Array } = {},
  ) => {
    const id = ++request;
    send(d, {
      type: "put-blob",
      request: id,
      blob: over.blob ?? platform.sha256(data),
      size: over.size ?? data.length,
      offset: over.offset ?? 0,
      chunk: over.chunk ?? data,
    });
    return id;
  };
  const get = (d: Device, blob: Uint8Array, offset = 0) => {
    const id = ++request;
    send(d, { type: "get-blob", request: id, blob, offset });
    return id;
  };
  const text = (counter: number, files: Uint8Array[], over = {}) =>
    message(w.alice.first, w.channel, epoch, { counter, ...over }, files);
  const submit = (d: Device, e: { signed: Uint8Array; sig: Uint8Array }) => {
    d.frame({ type: "submit", request: ++request, kind: MESSAGE, ...e });
    return request;
  };
  return { ...relay, epoch, me, bot, botConn, put, get, text, submit, blobs };
}
const results = (d: Device) =>
  d.sent.filter((f): f is Extract<Frame, { type: "result" }> => f.type === "result");
const chunks = (d: Device) =>
  d.sent.filter((f): f is Extract<Frame, { type: "blob" }> => f.type === "blob");

test("6.2 put blob: answered accepted once the data's round is on disk, and held then (3.11)", async () => {
  const w = await world();
  const data = bytes(100, 7);
  const release = hold(w);
  const id = w.put(w.me, data);
  await settle();
  assert.deepEqual(results(w.me), [], "nothing is answered while its round is held");
  assert.equal(w.blobs.held(platform.sha256(data)), false);
  await release();
  assert.deepEqual(results(w.me), [{ type: "result", request: id, code: 0 }]);
  assert.equal(w.blobs.held(platform.sha256(data)), true);
});

test("6.2 put blob: chunks in order answer only at the last; a hash that is not the id is refused 1; a size over the largest is 8; a removed device 5", async () => {
  const w = await world({ maxBlob: 64 });
  const data = bytes(40, 3);
  const id = platform.sha256(data);
  w.put(w.me, data, { chunk: data.subarray(0, 10) });
  await settle();
  assert.deepEqual(results(w.me), [], "a chunk before the last is not answered");
  const last = w.put(w.me, data, { offset: 10, chunk: data.subarray(10) });
  await settle();
  assert.deepEqual(results(w.me).at(-1), { type: "result", request: last, code: 0 });
  assert.equal(w.blobs.held(id), true);
  const wrong = w.put(w.me, bytes(5, 1), { blob: fill(9) });
  await settle();
  assert.equal(results(w.me).at(-1)?.request, wrong);
  assert.equal(results(w.me).at(-1)?.code, 1);
  const big = w.put(w.me, bytes(65, 2));
  await settle();
  assert.deepEqual(results(w.me).at(-1), { type: "result", request: big, code: 8 });
  const bob = keyed();
  assert.equal(w.me.sent.length > 0, true);
  w.join(bob);
  await w.flush();
  const gone = await w.connect().prove(bob, w.alice);
  w.submit(w.me, w.text(1, [])); // keeps the epoch open for what follows
  w.me.frame({ type: "submit", request: 90, kind: DEVICE, ...w.alice.remove(w.log(), bob) });
  await settle();
  const removed = w.put(gone, bytes(4, 5));
  await settle();
  assert.equal(results(gone).find((r) => r.request === removed)?.code, 5);
});

test("6.2 submit and get: a message naming a blob not held is missing 7; once put it is accepted and the blob is given in chunks from the offset, answered after its round (6.2)", async () => {
  const w = await world();
  const data = bytes(600 * 1024, 4);
  const id = platform.sha256(data);
  const missing = w.submit(w.me, w.text(1, [id]));
  await settle();
  assert.equal(results(w.me).find((r) => r.request === missing)?.code, 7);
  w.put(w.me, data);
  await settle();
  const ok = w.submit(w.me, w.text(1, [id]));
  await settle();
  assert.equal(results(w.me).find((r) => r.request === ok)?.code, 0);
  const reader = await w.connect().prove(w.alice.first, w.alice);
  w.get(reader, id, 1000);
  await settle();
  const sent = chunks(reader);
  assert.equal(sent.length, 2, "the 512 KiB chunk and the rest");
  assert.equal(sent[0]?.offset, 1000);
  assert.equal(sent[0]?.size, data.length);
  const joined = Buffer.concat(sent.map((c) => c.chunk));
  assert.deepEqual(joined, data.subarray(1000));
});

test("6.2 get blob: not held or not wanted is gone 9, a removed device 5; the answer waits for the round of the state it was judged on (3.6)", async () => {
  const w = await world();
  const data = bytes(30, 6);
  const id = platform.sha256(data);
  const unknown = w.get(w.me, fill(8));
  await settle();
  assert.equal(results(w.me).find((r) => r.request === unknown)?.code, 9);
  w.put(w.me, data);
  await settle();
  const unnamed = w.get(w.me, id);
  await settle();
  assert.equal(
    results(w.me).find((r) => r.request === unnamed)?.code,
    9,
    "held but no message names it",
  );
  const reader = await w.connect().prove(w.alice.first, w.alice);
  const release = hold(w);
  w.submit(w.me, w.text(1, [id]));
  w.get(reader, id);
  await settle();
  assert.equal(chunks(reader).length, 0, "nothing is given from a state not on disk");
  await release();
  assert.equal(chunks(reader).length, 1);
});

test("4.5 get blob: a socket that does not drain holds one chunk and the rest follows on 'drain'", async () => {
  const w = await world();
  const data = bytes(1100 * 1024, 2);
  const id = platform.sha256(data);
  w.put(w.me, data);
  await settle();
  w.submit(w.me, w.text(1, [id]));
  await settle();
  const reader = await w.connect().prove(w.alice.first, w.alice);
  reader.block();
  w.get(reader, id);
  await settle();
  assert.equal(chunks(reader).length, 1);
  assert.equal(reader.drains(), 1);
  await reader.flush();
  await reader.flush();
  await reader.flush();
  assert.equal(chunks(reader).length, 3);
  assert.deepEqual(Buffer.concat(chunks(reader).map((c) => c.chunk)), data);
});

test("4.5 a message placed while a blob of eight chunks streams reaches a following device, with its head, before the blob's last chunk (#153)", async () => {
  const w = await world();
  const data = bytes(8 * 512 * 1024, 2);
  const id = platform.sha256(data);
  w.put(w.me, data);
  await settle();
  w.submit(w.me, w.text(1, [id]));
  await settle();
  const reader = await w.connect().prove(w.alice.first, w.alice);
  reader.frame({ type: "read", from: 0 });
  await settle();
  assert.equal(reader.types().at(-1), "head", "the follow's first pass ended");
  const before = reader.sent.length;
  reader.blockAfter(1);
  w.get(reader, id);
  await settle();
  assert.equal(chunks(reader).length, 1, "the file is on its way");
  w.submit(w.me, w.text(2, []));
  await settle();
  for (let i = 0; i < 20 && chunks(reader).length < 8; i++) {
    reader.blockAfter(1);
    await reader.flush();
  }
  assert.equal(chunks(reader).length, 8);
  const types = reader.types(before);
  const last = types.lastIndexOf("blob");
  assert.ok(types.indexOf("item") !== -1 && types.indexOf("item") < last, types.join(" "));
  assert.ok(
    types.indexOf("head") !== -1 && types.indexOf("head") < last,
    "the head that ends the new items too",
  );
  assert.deepEqual(Buffer.concat(chunks(reader).map((c) => c.chunk)), data);
});

test("6.3 step 3: the round that removes a device drops the unnamed blobs only it put (3.11)", async () => {
  const w = await world();
  const bob = keyed();
  w.join(bob);
  await w.flush();
  const gone = await w.connect().prove(bob, w.alice);
  const data = bytes(20, 9);
  w.put(gone, data);
  await settle();
  assert.equal(w.blobs.held(platform.sha256(data)), true);
  w.me.frame({ type: "submit", request: 70, kind: DEVICE, ...w.alice.remove(w.log(), bob) });
  await settle();
  assert.equal(w.blobs.held(platform.sha256(data)), false);
  assert.equal(existsSync(join(w.dir, "blobs", hex(platform.sha256(data)))), false);
});

test("6.3 step 3: a round removes the blob a later build replaced (3.11)", async () => {
  const w = await world({ expiry: 1000 });
  const [a, b, stale] = [bytes(8, 1), bytes(8, 2), bytes(8, 3)];
  for (const d of [a, b, stale]) w.put(w.me, d);
  await settle();
  const build = (counter: number, name: number, blob: Uint8Array) =>
    w.submit(
      w.botConn,
      message(w.bot, w.channel, w.epoch, { counter, kind: KIND_BUILD, name: fill(name, 16) }, [
        blob,
      ]),
    );
  build(1, 6, platform.sha256(a));
  await settle();
  assert.equal(w.blobs.held(platform.sha256(a)), true, "the only build is wanted");
  build(2, 7, platform.sha256(b));
  await settle();
  await settle();
  assert.equal(w.blobs.held(platform.sha256(a)), false, "replaced once the later build is on disk");
  assert.equal(w.blobs.held(platform.sha256(b)), true);
  assert.equal(
    w.blobs.held(platform.sha256(stale)),
    true,
    "one nobody named is not a round's business",
  );
});

/** A bot's build named `name` with `blob`, as the bot's connection sends it. */
const buildOf = (
  w: Awaited<ReturnType<typeof world>>,
  counter: number,
  name: number,
  blob: Uint8Array,
) =>
  w.submit(
    w.botConn,
    message(w.bot, w.channel, w.epoch, { counter, kind: KIND_BUILD, name: fill(name, 16) }, [blob]),
  );

test("3.11 a later copy of an older build is unwanted when it is placed: the round that covers it removes its blob (F4)", async () => {
  const w = await world();
  const [a, b, copy] = [bytes(8, 1), bytes(8, 2), bytes(8, 3)];
  for (const d of [a, b, copy]) w.put(w.me, d);
  await settle();
  buildOf(w, 1, 6, platform.sha256(a));
  buildOf(w, 2, 7, platform.sha256(b));
  await settle();
  await settle();
  assert.equal(w.blobs.held(platform.sha256(a)), false, "the first build was replaced");
  buildOf(w, 3, 6, platform.sha256(copy));
  await settle();
  await settle();
  assert.equal(
    w.blobs.held(platform.sha256(copy)),
    false,
    "a copy of the replaced build is not wanted",
  );
  assert.equal(w.blobs.held(platform.sha256(b)), true, "the newest build's blob stays");
});

test("3.11 a blob a build made unwanted and a message wanted again stays, and leaves the round's list (F4)", async () => {
  const w = await world();
  const [a, b] = [bytes(8, 1), bytes(8, 2)];
  for (const d of [a, b]) w.put(w.me, d);
  await settle();
  buildOf(w, 1, 6, platform.sha256(a));
  await settle();
  const release = hold(w);
  buildOf(w, 2, 7, platform.sha256(b));
  w.submit(w.me, w.text(1, [platform.sha256(a)]));
  await release();
  await settle();
  assert.equal(w.blobs.held(platform.sha256(a)), true, "a message names it: wanted");
  assert.equal(w.seq.toCheck.size, 0, "nothing is left for later rounds to look at");
});

test("3.11 expire: an unnamed blob goes after its time and a named one stays", async () => {
  const w = await world({ expiry: 1000 });
  const [named, stale] = [bytes(8, 1), bytes(8, 3)];
  for (const d of [named, stale]) w.put(w.me, d);
  await settle();
  w.submit(w.me, w.text(1, [platform.sha256(named)]));
  await settle();
  const later = w.s.seam.now() + 2000;
  w.s.seam.now = () => later;
  w.blobs.expire();
  assert.equal(w.blobs.held(platform.sha256(stale)), false, "unnamed for longer than its time");
  assert.equal(w.blobs.held(platform.sha256(named)), true, "a named blob stays");
});

test("6.2 put blob: a refusal that rests on a removal not yet on disk waits for it (3.6)", async () => {
  const w = await world();
  const bob = keyed();
  w.join(bob);
  await w.flush();
  const gone = await w.connect().prove(bob, w.alice);
  const release = hold(w);
  w.me.frame({ type: "submit", request: 71, kind: DEVICE, ...w.alice.remove(w.log(), bob) });
  const id = w.put(gone, bytes(4, 5));
  await settle();
  assert.deepEqual(results(gone), [], "result 5 is not sent from a state a restart could lose");
  await release();
  assert.deepEqual(results(gone), [{ type: "result", request: id, code: 5 }]);
});

test("3.11 put blob: a connection that closes before the last chunk loses its temporary file at once", async () => {
  const w = await world();
  const data = bytes(40, 3);
  w.put(w.me, data, { chunk: data.subarray(0, 10) });
  await settle();
  assert.equal(readdirSync(join(w.dir, "blobs")).filter((n) => n.startsWith("tmp-")).length, 1);
  w.me.closed();
  assert.equal(readdirSync(join(w.dir, "blobs")).filter((n) => n.startsWith("tmp-")).length, 0);
});

/** A blob of alice's that a message names, held; and bob, who is about to be removed, served. */
async function named() {
  const w = await world();
  const bob = keyed();
  w.join(bob);
  await w.flush();
  const bobConn = await w.connect().prove(bob, w.alice);
  const data = bytes(40, 3);
  const id = platform.sha256(data);
  w.put(w.me, data);
  await settle();
  w.submit(w.me, w.text(1, [id]));
  await settle();
  return { w, bob, bobConn, id, data };
}

test("3.6 get blob: a refusal 5 rests on a removal that is not on disk, and waits for it (S2)", async () => {
  const { w, bob, bobConn, id } = await named();
  w.pending.hold = true;
  w.submit(w.me, w.text(2, []));
  await settle();
  const roundA = w.pending.release;
  const got = w.get(bobConn, id);
  w.me.frame({ type: "submit", request: 90, kind: DEVICE, ...w.alice.remove(w.log(), bob) });
  await settle();
  const removal = w.s.rounds.written;
  roundA?.();
  await settle();
  assert.ok(w.s.rounds.synced < removal, "the removal is not on disk");
  assert.equal(
    results(bobConn).find((r) => r.request === got),
    undefined,
  );
  w.pending.hold = false;
  w.pending.release?.();
  await settle();
  assert.equal(results(bobConn).find((r) => r.request === got)?.code, 5, "after its round");
});

test("3.6 put blob: the last chunk's refusal 5 rests on a removal that is not on disk, and waits for it (S2)", async () => {
  const { w, bob, bobConn } = await named();
  const data = bytes(40, 4);
  w.pending.hold = true;
  const put = w.put(bobConn, data);
  await settle();
  const roundA = w.pending.release;
  w.me.frame({ type: "submit", request: 91, kind: DEVICE, ...w.alice.remove(w.log(), bob) });
  await settle();
  const removal = w.s.rounds.written;
  roundA?.();
  await settle();
  assert.ok(w.s.rounds.synced < removal, "the removal is not on disk");
  assert.equal(
    results(bobConn).find((r) => r.request === put),
    undefined,
  );
  w.pending.hold = false;
  w.pending.release?.();
  await settle();
  assert.equal(results(bobConn).find((r) => r.request === put)?.code, 5);
});

test("4.5 a peer that never drains, asking for the same blob again and again, is given one chunk (C1, S3)", async () => {
  const w = await world();
  const data = bytes(1100 * 1024, 5);
  const id = platform.sha256(data);
  w.put(w.me, data);
  await settle();
  w.submit(w.me, w.text(1, [id]));
  await settle();
  const reader = await w.connect().prove(w.alice.first, w.alice);
  reader.block();
  for (let i = 0; i < 200; i++) w.get(reader, id);
  await settle();
  const queued = chunks(reader).reduce((n, c) => n + c.chunk.length, 0);
  assert.equal(queued, 512 * 1024, "one chunk, however many gets");
  await reader.flush();
  assert.ok(chunks(reader).length > 1, "and the rest once it drains");
});

test("6.5 a get stream the relay decides to fail closed in the middle of sends no more chunks (T2)", async () => {
  const w = await world();
  const data = bytes(1100 * 1024, 6);
  const id = platform.sha256(data);
  w.put(w.me, data);
  await settle();
  w.submit(w.me, w.text(1, [id]));
  await settle();
  const reader = await w.connect().prove(w.alice.first, w.alice);
  reader.block();
  w.get(reader, id);
  await settle();
  assert.equal(chunks(reader).length, 1);
  const uploader = w.connect();
  const { head, sig } = w.headOf(w.journal.placed.length + 3, fill(4));
  uploader.upload(keyed(), head, sig);
  uploader.frame({ type: "upload-done", request: 9, head, sig });
  await settle();
  await reader.flush();
  assert.equal(chunks(reader).length, 1, "nothing after the decision");
});

test("3.7 put blob: a chunk that answers nothing is not a request that looks at the directory; the answer it ends with does (C8)", async () => {
  const w = await world();
  const data = bytes(40, 7);
  const first = w.put(w.me, data, { chunk: data.subarray(0, 10) });
  appendFileSync(join(w.dir, "journal"), "a copy put by hand");
  assert.equal(
    w.me.frame({
      type: "put-blob",
      request: first,
      blob: platform.sha256(data),
      size: 40,
      offset: 10,
      chunk: data.subarray(10, 20),
    }),
    true,
  );
  assert.deepEqual(w.s.stops, []);
  w.put(w.me, data, { chunk: data.subarray(20), offset: 20 });
  await settle();
  assert.deepEqual(w.s.stops, [75]);
  assert.deepEqual(results(w.me), []);
});

test("3.11 sweep: a round looks only at the blobs a build placed made unwanted, not at every blob held (C7)", async () => {
  const w = await world();
  for (let i = 0; i < 20; i++) w.put(w.me, bytes(8, 100 + i));
  await settle();
  const wanted = mock.method(w.seq, "wanted");
  w.submit(w.me, w.text(1, []));
  await settle();
  assert.equal(wanted.mock.callCount(), 0);
  mock.restoreAll();
});

test("6.3 a round that put nothing in the sequence reads for no follower and signs no head (C6)", async () => {
  const w = await world();
  const watcher = await w.connect().prove(w.alice.first, w.alice);
  watcher.frame({ type: "read", from: 0 });
  await settle();
  const seen = watcher.sent.length;
  const fetch = mock.method(w.seq, "fetch");
  w.put(w.me, bytes(8, 77));
  await settle();
  assert.equal(w.blobs.held(platform.sha256(bytes(8, 77))), true, "a round ran");
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(watcher.sent.length, seen, "and the follower was sent nothing");
  mock.restoreAll();
});

test("6.5 a round that completes after the decision to fail closed removes no blob and tells no device (T2)", async () => {
  const w = await world();
  const bob = keyed();
  w.join(bob);
  await w.flush();
  const gone = await w.connect().prove(bob, w.alice);
  const data = bytes(20, 8);
  w.put(gone, data);
  await settle();
  assert.equal(w.blobs.held(platform.sha256(data)), true);
  const release = hold(w);
  w.me.frame({ type: "submit", request: 72, kind: DEVICE, ...w.alice.remove(w.log(), bob) });
  const uploader = w.connect();
  const { head, sig } = w.headOf(w.journal.placed.length + 3, fill(4));
  uploader.upload(keyed(), head, sig);
  uploader.frame({ type: "upload-done", request: 9, head, sig });
  await release();
  assert.equal(
    w.blobs.held(platform.sha256(data)),
    true,
    "the relay touches nothing once it decided",
  );
  assert.deepEqual(
    gone.sent.filter((f) => f.type === "refused"),
    [{ type: "refused", reason: 6 }],
    "told only what 6.5 says",
  );
});

test("3.11 expire: nothing goes while the relay decides to fail closed or once it has, and nothing once rule 11 found the directory changed (F3)", async () => {
  const w = await world({ expiry: 1000 });
  const [a, b] = [bytes(8, 1), bytes(8, 3)];
  w.put(w.me, a);
  w.put(w.me, b);
  await settle();
  const later = w.s.seam.now() + 2000;
  w.s.seam.now = () => later;
  const release = hold(w);
  const uploader = w.connect();
  const { head, sig } = w.headOf(w.journal.placed.length + 3, fill(4));
  uploader.upload(keyed(), head, sig);
  uploader.frame({ type: "upload-done", request: 9, head, sig });
  w.proofs.expire();
  assert.equal(
    w.blobs.held(platform.sha256(a)),
    true,
    "the mark is not on disk: the relay decides",
  );
  await release();
  w.proofs.expire();
  assert.equal(w.blobs.held(platform.sha256(a)), true, "failed closed: nothing is removed");
  assert.equal(w.blobs.held(platform.sha256(b)), true);
});

test("3.11 expire: a directory that is not the one the relay wrote loses no blob, and the relay stops with 75 (F3)", async () => {
  const w = await world({ expiry: 1000 });
  const data = bytes(8, 1);
  w.put(w.me, data);
  await settle();
  const later = w.s.seam.now() + 2000;
  w.s.seam.now = () => later;
  appendFileSync(join(w.dir, "journal"), "x");
  w.proofs.expire();
  assert.equal(w.blobs.held(platform.sha256(data)), true);
  assert.deepEqual(w.s.stops, [75]);
});

test("3.11 expire: the guard lets a round's own removal through: an unnamed blob past its time goes (F3)", async () => {
  const w = await world({ expiry: 1000 });
  const data = bytes(8, 1);
  w.put(w.me, data);
  await settle();
  const later = w.s.seam.now() + 2000;
  w.s.seam.now = () => later;
  w.proofs.expire();
  assert.equal(w.blobs.held(platform.sha256(data)), false);
});
