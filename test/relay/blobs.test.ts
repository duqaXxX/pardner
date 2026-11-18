/**
 * Design 3.11 and 6.2, the blobs on real files: a put, a get, the rounds that make a blob held, the
 * bounds, and what a start and a removal do. A test named after one of the model's ends with
 * ` [model]`; the others hold a row of design 3.11 or a ledger row (I3, I4, N2, N3, M4, M5).
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  fstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { idKey } from "../../src/protocol/device-log.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { Blobs, type Limits, type Put } from "../../src/relay/blobs.ts";
import { Code, type Conn } from "../../src/relay/sequence.ts";
import { platform } from "./support.ts";
import { channelled, fill, type Keyed, keyed, message } from "./world.ts";

const MESSAGE = 4;
const hex = (b: Bytes) => Buffer.from(b).toString("hex");
const blobOf = (text: string) => {
  const bytes = Buffer.from(text);
  return { bytes, id: platform.sha256(bytes) };
};
type Blob = ReturnType<typeof blobOf>;

/** A relay with alice's channel and its first epoch, and the blobs over its folder. */
async function world(limits: Partial<Limits> = {}) {
  let blobs: Blobs | undefined;
  const w = await channelled((b) => blobs?.held(b) ?? false);
  blobs = new Blobs(platform, w.s.rounds, w.s.seam, join(w.dir, "blobs"), limits);
  blobs.start(w.seq);
  const folder = join(w.dir, "blobs");
  let epoch = w.open();
  /** A device joins, which closes the epoch; the next one is opened. */
  const admit = (d: Keyed) => {
    w.join(d);
    epoch = w.open();
  };
  const session = blobs.session();
  const put = (b: Blob, conn: Conn = w.a, s = session, chunks = 1): Put => {
    const size = Math.ceil(b.bytes.length / chunks);
    let out: Put = null;
    for (let at = 0; at < b.bytes.length; at += size) {
      out = blobs.put(conn, s, b.id, b.bytes.length, at, b.bytes.subarray(at, at + size));
    }
    return out;
  };
  /** Puts `b` and waits for its round: the code it was answered. */
  const stored = async (b: Blob, conn: Conn = w.a, chunks = 1) => {
    const out = put(b, conn, blobs.session(), chunks);
    assert.ok(out && "done" in out);
    return out.done;
  };
  const send = (b: Blob, over = {}, by: Keyed = w.alice.first, counter = 1) =>
    w.send(w.alice.conn(by), MESSAGE, message(by, w.channel, epoch, { counter, ...over }, [b.id]));
  const names = () => readdirSync(folder).sort();
  return { ...w, blobs, folder, admit, session, put, stored, send, names };
}
type World = Awaited<ReturnType<typeof world>>;

test("3.11 N2: a put is held and answered only after the round that syncs its data, and is then renamed to its id", async () => {
  const w = await world();
  const b = blobOf("one file");
  await w.flush();
  w.pending.hold = true;
  const out = w.put(b);
  assert.ok(out && "done" in out);
  const before = w.s.syncs.length;
  while (w.s.syncs.length === before) await tick(); // the data fsync is called and waits
  await tick();
  await tick();
  assert.equal(w.blobs.held(b.id), false, "not held while the data fsync has not resolved");
  assert.deepEqual(
    w.names().filter((n) => !n.startsWith("tmp-")),
    [],
  );
  assert.equal(w.send(b).code, Code.missing, "a message naming it is refused until it is held");
  w.pending.hold = false;
  w.pending.release?.();
  assert.equal(await out.done, Code.accepted);
  assert.equal(w.blobs.held(b.id), true);
  assert.deepEqual(w.names(), [hex(b.id)]);
  assert.deepEqual(readFileSync(join(w.folder, hex(b.id))), b.bytes);
  assert.equal(w.send(b, { counter: 2 }).code, Code.accepted);
});

test("3.6: after the rename a put is held and answered only once a round has synced `blobs/`, so no message names it first", async () => {
  const w = await world();
  const b = blobOf("one file");
  await w.flush();
  w.pending.hold = true;
  const out = w.put(b);
  assert.ok(out && "done" in out);
  let answered = false;
  void out.done.then(() => (answered = true));
  const synced = async (count: number) => {
    while (w.s.syncs.length < count) await tick();
  };
  const before = w.s.syncs.length;
  await synced(before + 1); // the data's fsync waits
  w.pending.release?.(); // the data is on disk; the hold stays for the next sync
  await synced(before + 2); // the round that syncs `blobs/` after the rename waits
  assert.ok(
    fstatSync(w.s.syncs[before + 1] as number).isDirectory(),
    "the second sync is `blobs/`",
  );
  assert.deepEqual(w.names(), [hex(b.id)], "renamed before `blobs/` is synced");
  await tick();
  assert.equal(answered, false, "not answered while `blobs/` is not synced");
  assert.equal(w.blobs.held(b.id), false, "not held while `blobs/` is not synced");
  assert.equal(w.send(b).code, Code.missing, "a message naming it is refused until it is held");
  w.pending.hold = false;
  w.pending.release?.();
  assert.equal(await out.done, Code.accepted);
  assert.equal(w.blobs.held(b.id), true);
  assert.equal(w.send(b, { counter: 2 }).code, Code.accepted);
});

test("3.11: chunks in order are one put; a chunk out of order, a size that changes or too many bytes refuse it and remove the file", async () => {
  const w = await world();
  const b = blobOf("a file of some length");
  assert.equal(w.put(b, w.a, w.session, 3) !== null, true);
  assert.equal(await w.stored(b, w.a, 3), Code.accepted);
  const other = blobOf("another file");
  const s = w.blobs.session();
  assert.equal(
    w.blobs.put(w.a, s, other.id, other.bytes.length, 0, other.bytes.subarray(0, 4)),
    null,
  );
  const skipped = w.blobs.put(w.a, s, other.id, other.bytes.length, 6, other.bytes.subarray(6, 8));
  assert.deepEqual(skipped, { code: Code.refused, ticket: w.s.rounds.written });
  const t = w.blobs.session();
  w.blobs.put(w.a, t, other.id, other.bytes.length, 0, other.bytes.subarray(0, 4));
  const resized = w.blobs.put(w.a, t, other.id, other.bytes.length + 1, 4, other.bytes.subarray(4));
  assert.deepEqual(resized, { code: Code.refused, ticket: w.s.rounds.written });
  const u = w.blobs.session();
  const over = w.blobs.put(w.a, u, other.id, 4, 0, other.bytes);
  assert.deepEqual(over, { code: Code.refused, ticket: w.s.rounds.written });
  assert.deepEqual(w.names(), [hex(b.id)], "no temporary file is left");
});

test("3.11: a last chunk whose hash is not the id is refused, and its file is removed", async () => {
  const w = await world();
  const b = blobOf("the real bytes");
  const lie = w.blobs.put(w.a, w.blobs.session(), b.id, 5, 0, Buffer.from("other"));
  assert.deepEqual(lie, { code: Code.refused, ticket: w.s.rounds.written });
  assert.deepEqual(w.names(), []);
});

test("3.11: a size over the largest blob is too large, at the first chunk", async () => {
  const w = await world({ maxBlob: 10 });
  const b = blobOf("eleven byte");
  assert.deepEqual(w.put(b), { code: 8, ticket: w.s.rounds.written });
  assert.deepEqual(w.names(), []);
});

test("3.11: one put in flight on a connection; a second is refused and the first goes on", async () => {
  const w = await world();
  const b = blobOf("first of two");
  const c = blobOf("second");
  w.blobs.put(w.a, w.session, b.id, b.bytes.length, 0, b.bytes.subarray(0, 3));
  const second = w.blobs.put(w.a, w.session, c.id, c.bytes.length, 0, c.bytes);
  assert.deepEqual(second, { code: Code.refused, ticket: w.s.rounds.written });
  const rest = w.blobs.put(w.a, w.session, b.id, b.bytes.length, 3, b.bytes.subarray(3));
  assert.ok(rest && "done" in rest);
  assert.equal(await rest.done, Code.accepted);
});

test("3.11: a blob that is held is accepted at its first chunk and the rest are ignored", async () => {
  const w = await world();
  const b = blobOf("kept already");
  await w.stored(b);
  const s = w.blobs.session();
  const again = w.blobs.put(w.a, s, b.id, b.bytes.length, 0, b.bytes.subarray(0, 4));
  assert.deepEqual(again, { code: Code.accepted, ticket: w.s.rounds.written });
  assert.equal(w.blobs.put(w.a, s, b.id, b.bytes.length, 4, b.bytes.subarray(4)), null);
  assert.deepEqual(w.names(), [hex(b.id)]);
});

test("3.11 N3: a write error on the temporary file refuses that put (too large for ENOSPC, refused otherwise), removes it, and the relay serves on", async () => {
  for (const [code, answer] of [
    ["ENOSPC", 8],
    ["EIO", 1],
  ] as const) {
    const w = await world();
    const real = w.s.seam.write;
    w.s.seam.write = (_fd, _bytes) => {
      throw Object.assign(new Error("disk"), { code });
    };
    const b = blobOf(`a blob under ${code}`);
    assert.deepEqual(w.put(b), { code: answer, ticket: w.s.rounds.written });
    assert.deepEqual(w.names(), []);
    w.s.seam.write = real;
    assert.deepEqual(w.s.stops, [], "the relay does not stop for a blob");
    assert.equal(await w.stored(b), Code.accepted);
  }
});

test("3.11 N3: a short write on the temporary file is a refusal too", async () => {
  const w = await world();
  w.s.seam.write = (_fd, bytes) => bytes.length - 1;
  assert.deepEqual(w.put(blobOf("short")), { code: 1, ticket: w.s.rounds.written });
  assert.deepEqual(w.names(), []);
  assert.deepEqual(w.s.stops, []);
});

test("3.11 N3: the free space after the put and the puts in flight must stay above the floor", async () => {
  const w = await world({ floor: 100 });
  w.s.seam.free = () => 200;
  const a = blobOf("0123456789012345678901234567890123456789"); // 40 bytes
  const b = blobOf("abcdefghijabcdefghijabcdefghijabcdefghij".replace(/a/g, "z"));
  const c = blobOf("ABCDEFGHIJABCDEFGHIJABCDEFGHIJABCDEFGHIJ");
  assert.equal(w.blobs.put(w.a, w.session, a.id, 40, 0, a.bytes.subarray(0, 4)), null);
  const t = w.blobs.session();
  assert.equal(w.blobs.put(w.a, t, b.id, 40, 0, b.bytes.subarray(0, 4)), null);
  const u = w.blobs.session();
  const out = w.blobs.put(w.a, u, c.id, 40, 0, c.bytes.subarray(0, 4));
  assert.deepEqual(out, { code: 8, ticket: w.s.rounds.written }, "200 - 80 - 40 is under 100");
});

test("3.11 M5: a finished put whose connection closes during its round is held; one that closes before its last chunk loses its file", async () => {
  const w = await world();
  const b = blobOf("finished while closing");
  await w.flush();
  w.pending.hold = true;
  const s = w.blobs.session();
  const out = w.put(b, w.a, s);
  assert.ok(out && "done" in out);
  w.blobs.closeSession(s);
  w.pending.hold = false;
  w.pending.release?.();
  assert.equal(await out.done, Code.accepted);
  assert.equal(w.blobs.held(b.id), true);
  const c = blobOf("half a file");
  const t = w.blobs.session();
  w.blobs.put(w.a, t, c.id, c.bytes.length, 0, c.bytes.subarray(0, 4));
  assert.equal(w.names().length, 2);
  w.blobs.closeSession(t);
  assert.deepEqual(w.names(), [hex(b.id)]);
});

test("5.12: every device the owner holds fetches the file, and a removed device can neither put nor fetch one [model]", async () => {
  const w = await world();
  const other = keyed();
  w.admit(other);
  const b = blobOf("shared file");
  assert.equal(await w.stored(b), Code.accepted);
  assert.equal(w.send(b).code, Code.accepted);
  for (const conn of [w.a, w.alice.conn(other)]) {
    const got = w.blobs.get(conn, b.id, 0);
    assert.equal(got.code, 0);
  }
  w.extend({ kind: "remove", device: other.id });
  const gone = w.alice.conn(other);
  assert.deepEqual(w.blobs.get(gone, b.id, 0), { code: Code.removed });
  const x = blobOf("x");
  assert.deepEqual(w.blobs.put(gone, w.blobs.session(), x.id, 1, 0, x.bytes), {
    code: Code.removed,
    ticket: w.s.rounds.written,
  });
});

test("3.11: a get gives the blob in chunks from an offset, only while a message names and wants it", async () => {
  const w = await world();
  const b = blobOf("0123456789");
  await w.stored(b);
  assert.deepEqual(w.blobs.get(w.a, b.id, 0), { code: 9 }, "no message names it yet");
  assert.equal(w.send(b).code, Code.accepted);
  const first = w.blobs.get(w.a, b.id, 4);
  assert.ok(first.code === 0 && "chunk" in first);
  assert.equal(first.size, 10);
  assert.equal(first.offset, 4);
  assert.equal(Buffer.from(first.chunk).toString(), "456789");
  assert.deepEqual(w.blobs.get(w.a, fill(77), 0), { code: 9 });
});

/** Two builds of one bot: the first is replaced by the second. */
async function twoBuilds(w: World) {
  const bot = keyed("bot");
  w.admit(bot);
  const first = blobOf("build one");
  const second = blobOf("build two");
  const build = async (b: Blob, name: number, counter: number) => {
    await w.stored(b, w.alice.conn(bot));
    assert.equal(w.send(b, { kind: 12, name: fill(name, 16) }, bot, counter).code, Code.accepted);
  };
  await build(first, 1, 1);
  await w.flush();
  return { bot, first, second, build };
}

test("5.12: a build replaces the one before it on the relay: the replaced blob is removed by the round that holds the new build [model]", async () => {
  const w = await world();
  const { first, second, build } = await twoBuilds(w);
  await build(second, 2, 2);
  assert.equal(w.blobs.held(first.id), true, "kept until the new build is on disk");
  await w.flush();
  w.blobs.sweep();
  assert.equal(w.blobs.held(first.id), false);
  assert.equal(w.blobs.held(second.id), true);
  assert.deepEqual(w.blobs.get(w.a, first.id, 0), { code: 9 });
  assert.deepEqual(w.names(), [hex(second.id)]);
});

test("F2, 5.12 point 8: the blob a later build replaces goes only once that build is on disk [model]", async () => {
  const w = await world();
  const { bot, first, second } = await twoBuilds(w);
  await w.stored(second, w.alice.conn(bot));
  await w.flush();
  w.pending.hold = true;
  assert.equal(w.send(second, { kind: 12, name: fill(2, 16) }, bot, 2).code, Code.accepted);
  w.blobs.sweep();
  assert.equal(
    w.blobs.held(first.id),
    true,
    "the later build is not on disk: the first is the newest there",
  );
  w.pending.hold = false;
  w.pending.release?.();
  await w.flush();
  w.blobs.sweep();
  assert.equal(w.blobs.held(first.id), false);
});

test("5.12: the blob of a replaced build, put again by a bot whose folder went back, is not kept [model]", async () => {
  const w = await world();
  const { bot, first, second, build } = await twoBuilds(w);
  await build(second, 2, 2);
  await w.flush();
  w.blobs.sweep();
  const again = w.put(first, w.alice.conn(bot), w.blobs.session());
  assert.deepEqual(again, { code: 9, ticket: w.s.rounds.written });
  assert.deepEqual(w.names(), [hex(second.id)]);
});

test("3.11 I4: at start a temporary file whose hash a message names is renamed in, and any other is removed", async () => {
  const w = await world();
  const named = blobOf("named by a message");
  await w.stored(named);
  assert.equal(w.send(named).code, Code.accepted);
  await w.flush();
  renameSync(join(w.folder, hex(named.id)), join(w.folder, "tmp-1111")); // the rename was lost
  writeFileSync(join(w.folder, "tmp-2222"), "a stray put");
  const restarted = await w.restart();
  const next = new Blobs(platform, w.s.rounds, w.s.seam, w.folder);
  next.start(restarted.seq);
  assert.deepEqual(w.names(), [hex(named.id)]);
  assert.equal(next.held(named.id), true);
});

test("3.11 M4: a start removes the blob its sequence no longer wants", async () => {
  const w = await world();
  const { first, second, build } = await twoBuilds(w);
  await build(second, 2, 2);
  await w.flush();
  const restarted = await w.restart();
  const next = new Blobs(platform, w.s.rounds, w.s.seam, w.folder);
  next.start(restarted.seq);
  assert.equal(next.held(first.id), false);
  assert.equal(next.held(second.id), true);
  assert.deepEqual(w.names(), [hex(second.id)]);
});

test("3.11 I3: the unnamed blobs of one device, and of all, are bounded", async () => {
  const w = await world({ unnamedDevice: 10, unnamedAll: 14 });
  const other = keyed();
  w.admit(other);
  assert.equal(await w.stored(blobOf("123456")), Code.accepted);
  const over = blobOf("abcdefg");
  assert.deepEqual(
    w.put(over),
    { code: 8, ticket: w.s.rounds.written },
    "6 + 7 is over 10 for one device",
  );
  assert.equal(await w.stored(blobOf("abcdef"), w.alice.conn(other)), Code.accepted);
  const third = blobOf("xyz");
  assert.deepEqual(
    w.put(third, w.alice.conn(other)),
    { code: 8, ticket: w.s.rounds.written },
    "12 + 3 is over 14 in all",
  );
});

test("3.11 I3: a blob a message names leaves the unnamed count", async () => {
  const w = await world({ unnamedDevice: 10, unnamedAll: 10 });
  const a = blobOf("123456");
  await w.stored(a);
  assert.equal(w.send(a).code, Code.accepted);
  assert.equal(await w.stored(blobOf("abcdef")), Code.accepted);
});

test("3.11 I3: a removed device's unnamed blobs are dropped, one another active device also put is kept, a named one stays", async () => {
  const w = await world();
  const other = keyed();
  w.admit(other);
  const mine = blobOf("only by the removed");
  const both = blobOf("by two devices");
  const named = blobOf("named by a message");
  await w.stored(mine, w.alice.conn(other));
  await w.stored(both, w.alice.conn(other));
  assert.deepEqual(w.put(both), { code: Code.accepted, ticket: w.s.rounds.written });
  await w.stored(named, w.alice.conn(other));
  assert.equal(w.send(named, {}, w.alice.first, 3).code, Code.accepted);
  const out = w.extend({ kind: "remove", device: other.id });
  w.blobs.dropRemoved(out.removed);
  assert.equal(w.blobs.held(mine.id), false);
  assert.equal(w.blobs.held(both.id), true);
  assert.equal(w.blobs.held(named.id), true);
});

test("3.11: an unnamed blob is removed after 24 hours, a named one is not", async () => {
  const w = await world();
  const a = blobOf("unnamed");
  const b = blobOf("named");
  await w.stored(a);
  await w.stored(b);
  assert.equal(w.send(b).code, Code.accepted);
  let now = w.s.seam.now();
  w.s.seam.now = () => now;
  w.blobs.expire();
  assert.equal(w.blobs.held(a.id), true);
  now += 24 * 3600 * 1000 + 1;
  w.blobs.expire();
  assert.equal(w.blobs.held(a.id), false);
  assert.equal(w.blobs.held(b.id), true);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("F2-inverse, 4b-C1: a sweep keeps a blob that a placed message, not yet on disk, wants", async () => {
  const w = await world();
  const { bot, first, second } = await twoBuilds(w);
  await w.stored(second, w.alice.conn(bot));
  await w.flush();
  w.pending.hold = true;
  const build = w.send(second, { kind: 12, name: fill(2, 16) }, bot, 2);
  assert.equal(build.code, Code.accepted);
  await tick();
  assert.equal(
    w.send(first, {}, w.alice.first, 1).code,
    Code.accepted,
    "held, so a message names it",
  );
  const round = w.pending.release as (() => void) | undefined;
  w.pending.release = undefined;
  round?.(); // the round that covers the build, not the message after it
  await w.s.rounds.wait(build.ticket);
  w.blobs.sweep();
  const kept = w.blobs.held(first.id);
  w.pending.hold = false;
  (w.pending.release as (() => void) | undefined)?.();
  await w.flush();
  assert.equal(w.seq.wanted(first.id, "durable"), true, "a message on disk wants it now");
  assert.equal(kept, true);
});

test("3.11 4b-CR1: a blob put again on a connection that held it once, after it was removed, is taken", async () => {
  const w = await world();
  const b = blobOf("will expire and be put again");
  await w.stored(b);
  const s = w.blobs.session();
  assert.deepEqual(w.blobs.put(w.a, s, b.id, b.bytes.length, 0, b.bytes.subarray(0, 4)), {
    code: 0,
    ticket: w.s.rounds.written,
  });
  let now = w.s.seam.now();
  w.s.seam.now = () => now;
  now += 24 * 3600 * 1000 + 1;
  w.blobs.expire();
  assert.equal(w.blobs.held(b.id), false);
  assert.equal(w.blobs.put(w.a, s, b.id, b.bytes.length, 0, b.bytes.subarray(0, 4)), null);
  const last = w.blobs.put(w.a, s, b.id, b.bytes.length, 4, b.bytes.subarray(4));
  assert.ok(last !== null && "done" in last);
});

test("3.11 4b-CR3: puts in flight count toward the unnamed bounds, for one device and in all", async () => {
  const w = await world({ unnamedDevice: 10, unnamedAll: 14 });
  const other = keyed();
  w.admit(other);
  const x = blobOf("12345678");
  const y = blobOf("abcdefgh");
  const first = (b: Blob, conn: Conn) =>
    w.blobs.put(conn, w.blobs.session(), b.id, b.bytes.length, 0, b.bytes.subarray(0, 2));
  assert.equal(first(x, w.a), null);
  assert.deepEqual(
    first(y, w.a),
    { code: 8, ticket: w.s.rounds.written },
    "8 + 8 is over 10 for one device",
  );
  const small = blobOf("abcde");
  assert.equal(
    first(small, w.alice.conn(other)),
    null,
    "5 for another device: 13 in all is under 14",
  );
  const third = blobOf("xyz");
  assert.deepEqual(
    first(third, w.alice.conn(other)),
    { code: 8, ticket: w.s.rounds.written },
    "3 more is 16 in all",
  );
});

test("3.11 4b-CR2: a temporary file that cannot be made refuses the put, and a file that cannot be removed does not stop the relay", {
  skip: process.platform === "win32" ? "no directory mode" : false,
}, async () => {
  const w = await world({ floor: 100 });
  w.s.seam.free = () => 150;
  const b = blobOf("0123456789012345678901234567890123456789");
  chmodSync(w.folder, 0o500);
  try {
    assert.deepEqual(w.put(b), { code: 1, ticket: w.s.rounds.written });
  } finally {
    chmodSync(w.folder, 0o700);
  }
  const s = w.blobs.session();
  assert.equal(w.blobs.put(w.a, s, b.id, 40, 0, b.bytes.subarray(0, 4)), null);
  chmodSync(w.folder, 0o500);
  try {
    assert.deepEqual(w.blobs.put(w.a, s, b.id, 40, 9, b.bytes.subarray(9, 12)), {
      code: 1,
      ticket: w.s.rounds.written,
    });
  } finally {
    chmodSync(w.folder, 0o700);
  }
  assert.equal(
    w.blobs.put(w.a, w.blobs.session(), b.id, 40, 0, b.bytes.subarray(0, 4)),
    null,
    "the put in flight no longer counts",
  );
});

test("3.11 4b-CR4: a chunk past the declared size is refused before it is written", async () => {
  const w = await world();
  let writes = 0;
  const real = w.s.seam.write;
  w.s.seam.write = (fd, bytes) => {
    writes += 1;
    return real(fd, bytes);
  };
  const out = w.blobs.put(w.a, w.blobs.session(), fill(1), 4, 0, Buffer.from("twelve bytes"));
  assert.deepEqual(out, { code: 1, ticket: w.s.rounds.written });
  assert.equal(writes, 0);
  assert.deepEqual(w.names(), []);
});

test("3.11 4b-CR5: a get of a file that is short or gone answers gone, never zeros or an error", async () => {
  const w = await world();
  const b = blobOf("0123456789");
  await w.stored(b);
  assert.equal(w.send(b).code, Code.accepted);
  writeFileSync(join(w.folder, hex(b.id)), "0123");
  assert.deepEqual(w.blobs.get(w.a, b.id, 0), { code: 9 });
  rmSync(join(w.folder, hex(b.id)));
  assert.deepEqual(w.blobs.get(w.a, b.id, 0), { code: 9 });
});

test("3.11 4b-CR8: a size or an offset that is no count is refused, and a get past the end too", async () => {
  const w = await world();
  const b = blobOf("abcd");
  for (const [size, offset] of [
    [Number.NaN, 0],
    [-1, 0],
    [4.5, 0],
    [4, -1],
    [4, 1.5],
  ] as const) {
    const out = w.blobs.put(w.a, w.blobs.session(), b.id, size, offset, b.bytes);
    assert.deepEqual(out, { code: 1, ticket: w.s.rounds.written }, `${size} ${offset}`);
  }
  await w.stored(b);
  assert.equal(w.send(b).code, Code.accepted);
  for (const offset of [5, -1, 1.5, Number.NaN])
    assert.deepEqual(w.blobs.get(w.a, b.id, offset), { code: 1 });
});

test("3.11 4b-CR6: a put whose device was removed while its round ran is not held", async () => {
  const w = await world();
  const other = keyed();
  w.admit(other);
  const b = blobOf("by a device about to go");
  await w.flush();
  w.pending.hold = true;
  const out = w.put(b, w.alice.conn(other));
  assert.ok(out && "done" in out);
  w.extend({ kind: "remove", device: other.id });
  w.pending.hold = false;
  w.pending.release?.();
  assert.equal(await out.done, Code.removed);
  assert.equal(w.blobs.held(b.id), false);
  assert.deepEqual(w.names(), []);
});

test("3.11 4b-CR7: a put of a held blob refreshes its age", async () => {
  const w = await world();
  const b = blobOf("put twice");
  await w.stored(b);
  let now = w.s.seam.now();
  w.s.seam.now = () => now;
  const hour = 3600 * 1000;
  now += 23 * hour;
  w.put(b, w.a, w.blobs.session());
  now += 2 * hour;
  w.blobs.expire();
  assert.equal(w.blobs.held(b.id), true, "put again an hour before its day was up");
  now += 23 * hour;
  w.blobs.expire();
  assert.equal(w.blobs.held(b.id), false);
});

test("3.11 4b-C7: a held blob that a message no longer wants is gone at a put, as in the model", async () => {
  const w = await world();
  const { bot, first, second } = await twoBuilds(w);
  await w.stored(second, w.alice.conn(bot));
  await w.flush();
  w.pending.hold = true;
  assert.equal(w.send(second, { kind: 12, name: fill(2, 16) }, bot, 2).code, Code.accepted);
  assert.equal(w.blobs.held(first.id), true);
  assert.deepEqual(w.put(first, w.alice.conn(bot), w.blobs.session()), {
    code: 9,
    ticket: w.s.rounds.written,
  });
});

test("3.11 4b-C6: a put that is unwanted when its round ends is gone, and its file goes", async () => {
  const w = await world();
  const { bot, first, second } = await twoBuilds(w);
  await w.stored(second, w.alice.conn(bot));
  await w.flush();
  rmSync(join(w.folder, hex(first.id))); // the file is gone: the blob is wanted and not held
  const restarted = await w.restart();
  const next = new Blobs(platform, w.s.rounds, w.s.seam, w.folder);
  next.start(restarted.seq);
  assert.equal(next.held(first.id), false);
  w.pending.hold = true;
  const out = next.put(
    w.alice.conn(bot),
    next.session(),
    first.id,
    first.bytes.length,
    0,
    first.bytes,
  );
  assert.ok(out && "done" in out);
  const current = restarted.seq.channels.get(idKey(w.channel))?.epochs.at(-1)?.id as Bytes;
  const m = message(
    bot,
    w.channel,
    { id: current, key: fill(1) },
    { kind: 12, name: fill(2, 16), counter: 9 },
    [second.id],
  );
  assert.equal(
    restarted.seq.submit(w.alice.conn(bot), MESSAGE, m.signed, m.sig).code,
    Code.accepted,
  );
  w.pending.hold = false;
  w.pending.release?.();
  assert.equal(await out.done, 9);
  assert.deepEqual(w.names(), [hex(second.id)]);
});

test("3.11 4b-C6: a start keeps a blob no message names, which counts as put by no device", async () => {
  const w = await world();
  const b = blobOf("nobody named me");
  await w.stored(b);
  const restarted = await w.restart();
  const next = new Blobs(platform, w.s.rounds, w.s.seam, w.folder);
  next.start(restarted.seq);
  assert.equal(next.held(b.id), true);
  next.dropRemoved([w.alice.first.id]);
  assert.equal(next.held(b.id), true, "put by no device: no removal takes it");
});

test("3.11 4b-C5, N2, 3.6: the data is synced by a round, the folder by the next, and only then is the blob held", async () => {
  const w = await world();
  const b = blobOf("synced in order");
  await w.flush();
  const heldAtSync: boolean[] = [];
  const real = w.s.seam.sync;
  w.s.seam.sync = (fd) => {
    heldAtSync.push(w.blobs.held(b.id));
    return real(fd);
  };
  const out = w.put(b);
  assert.ok(out && "done" in out);
  await out.done;
  await w.flush();
  assert.deepEqual(
    heldAtSync,
    [false, false],
    "the data's round, then the folder's, both before the hold",
  );
  assert.equal(w.blobs.held(b.id), true);
});

test("3.11 4b-CR6: a removed device's put of a blob held meanwhile is answered removed and does not join by", async () => {
  const w = await world();
  const other = keyed();
  w.admit(other);
  const third = keyed();
  w.admit(third);
  const b = blobOf("held meanwhile");
  await w.flush();
  w.pending.hold = true;
  const out2 = w.put(b, w.alice.conn(third), w.blobs.session()); // finishes first: held, by {third}
  const out = w.put(b, w.alice.conn(other), w.blobs.session());
  assert.ok(out && "done" in out && out2 && "done" in out2);
  w.blobs.dropRemoved(w.extend({ kind: "remove", device: other.id }).removed);
  w.pending.hold = false;
  w.pending.release?.();
  assert.equal(await out2.done, Code.accepted);
  assert.equal(await out.done, Code.removed);
  w.blobs.dropRemoved(w.extend({ kind: "remove", device: third.id }).removed);
  assert.equal(w.blobs.held(b.id), false, "by held the removed putter, the blob would stay");
});

test("3.11 I3, 3.6: two devices that put one blob in one round both put it, so removing one keeps it", async () => {
  const w = await world();
  const other = keyed();
  w.admit(other);
  const b = blobOf("put twice at once");
  await w.flush();
  w.pending.hold = true;
  const first = w.put(b, w.a, w.blobs.session());
  const second = w.put(b, w.alice.conn(other), w.blobs.session());
  assert.ok(first && "done" in first && second && "done" in second);
  w.pending.hold = false;
  w.pending.release?.();
  assert.deepEqual(await Promise.all([first.done, second.done]), [Code.accepted, Code.accepted]);
  assert.deepEqual(w.names(), [hex(b.id)]);
  w.blobs.dropRemoved(w.extend({ kind: "remove", device: other.id }).removed);
  assert.equal(w.blobs.held(b.id), true, "the first device put it too");
});

test("3.11 4b-CR6, 3.6: a device removed while its blob's names are synced is answered removed, and its blob goes", async () => {
  const w = await world();
  const other = keyed();
  w.admit(other);
  const b = blobOf("removed while named");
  await w.flush();
  w.pending.hold = true;
  const before = w.s.syncs.length;
  const out = w.put(b, w.alice.conn(other));
  assert.ok(out && "done" in out);
  while (w.s.syncs.length < before + 1) await tick(); // the data's round
  w.pending.release?.();
  while (w.s.syncs.length < before + 2) await tick(); // the round that syncs `blobs/` after the rename
  w.blobs.dropRemoved(w.extend({ kind: "remove", device: other.id }).removed);
  w.pending.hold = false;
  w.pending.release?.();
  assert.equal(await out.done, Code.removed);
  assert.equal(w.blobs.held(b.id), false);
  assert.deepEqual(w.names(), []);
});

test("3.11 I3, 3.6: a second put of a blob whose names are being synced joins it, and the first device's removal keeps it", async () => {
  const w = await world();
  const other = keyed();
  w.admit(other);
  const third = keyed();
  w.admit(third);
  const b = blobOf("two puts, one device removed");
  await w.flush();
  w.pending.hold = true;
  const before = w.s.syncs.length;
  const first = w.put(b, w.alice.conn(third), w.blobs.session());
  while (w.s.syncs.length < before + 1) await tick(); // the first's data round
  const second = w.put(b, w.alice.conn(other), w.blobs.session()); // its data goes in the next round
  assert.ok(first && "done" in first && second && "done" in second);
  w.pending.release?.(); // the first is renamed and kept
  while (w.s.syncs.length < before + 2) await tick(); // the second's data, and `blobs/`
  w.pending.release?.(); // the second finds the first kept: it joins, and renames nothing
  while (w.s.syncs.length < before + 3) await tick();
  w.blobs.dropRemoved(w.extend({ kind: "remove", device: third.id }).removed);
  w.pending.hold = false;
  w.pending.release?.();
  assert.deepEqual(await Promise.all([first.done, second.done]), [Code.removed, Code.accepted]);
  await w.flush();
  assert.equal(w.blobs.held(b.id), true, "the second device put it too");
  assert.deepEqual(w.names(), [hex(b.id)], "never allowed 13: held with its file under its name");
});

test("3.11 4b-C3: the bound of one device refuses a second put in flight when the bound of all is far off", async () => {
  const w = await world({ unnamedDevice: 10 });
  const first = blobOf("123456");
  const second = blobOf("abcdefg");
  assert.ok(w.put(first, w.a, w.blobs.session()));
  assert.deepEqual(
    w.put(second, w.a, w.blobs.session()),
    { code: Code.tooLarge, ticket: w.s.rounds.written },
    "6 in flight + 7 is over 10 for the device",
  );
});

test("3.11 4b-C6: a dropped put's descriptor is closed", async () => {
  const w = await world();
  const closed: number[] = [];
  const close = w.s.rounds.close.bind(w.s.rounds);
  w.s.rounds.close = (fd: number) => {
    closed.push(fd);
    close(fd);
  };
  const b = blobOf("a file of some length");
  const s = w.blobs.session();
  w.blobs.put(w.a, s, b.id, b.bytes.length, 0, b.bytes.subarray(0, 4));
  const skipped = w.blobs.put(w.a, s, b.id, b.bytes.length, 9, b.bytes.subarray(9));
  assert.deepEqual(skipped, { code: Code.refused, ticket: w.s.rounds.written });
  assert.equal(closed.length, 1);
  assert.throws(() => fstatSync(closed[0] as number), { code: "EBADF" });
});

test("3.11 4b-C6: a put finished on a blob held meanwhile joins by and refreshes its age", async () => {
  const w = await world();
  const other = keyed();
  w.admit(other);
  const b = blobOf("held by the first finisher");
  await w.flush();
  const start = w.s.seam.now();
  let later: number | undefined;
  // The first finish keeps the blob and stamps `start`; the second finds it kept and stamps 23 hours on.
  let finishing = false;
  let stamps = 0;
  w.s.seam.now = () => later ?? (finishing && stamps++ > 0 ? start + 23 * 3600 * 1000 : start);
  w.pending.hold = true;
  const out = w.put(b, w.a, w.blobs.session());
  const out2 = w.put(b, w.alice.conn(other), w.blobs.session());
  assert.ok(out && "done" in out && out2 && "done" in out2);
  finishing = true;
  w.pending.hold = false;
  w.pending.release?.();
  assert.equal(await out.done, Code.accepted);
  assert.equal(await out2.done, Code.accepted);
  later = start + 24 * 3600 * 1000 + 1;
  w.blobs.expire();
  assert.equal(w.blobs.held(b.id), true, "the second put refreshed its age");
  w.blobs.dropRemoved(w.extend({ kind: "remove", device: w.alice.first.id }).removed);
  assert.equal(w.blobs.held(b.id), true, "the second putter is in by");
});
