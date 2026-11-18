import assert from "node:assert/strict";
import {
  appendFileSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bytesEqual } from "../../src/protocol/bytes.ts";
import { signedId } from "../../src/protocol/ids.ts";
import { runningHash } from "../../src/protocol/proofs.ts";
import { DirectoryChanged, fileHeader, Journal, NotWhole } from "../../src/relay/journal.ts";
import { tempDirSync } from "../support/temp.ts";
import { fakeSeam, item, makeJournalDir, openAppending, platform, tick } from "./support.ts";

function setup() {
  const dir = tempDirSync("pardner-relay-");
  const relay = makeJournalDir(dir);
  const path = join(dir, "journal");
  return { dir, relay, path, ...fakeSeam() };
}

async function open(path: string, s: ReturnType<typeof setup>, relay = s.relay) {
  const fd = openAppending(path);
  return { fd, ...(await Journal.open(platform, s.rounds, fd, relay)) };
}

test("a new journal holds no record, and what is appended is read back at start", async () => {
  const s = setup();
  const first = await open(s.path, s);
  assert.equal(first.dropped, 0);
  assert.equal(first.journal.placed.length, 0);
  const items = [0, 1, 2].map(item);
  for (const it of items) first.journal.append(it);
  closeSync(first.fd);

  const again = await open(s.path, s);
  assert.equal(again.dropped, 0);
  assert.equal(again.journal.placed.length, 3);
  assert.deepEqual(
    again.journal.placed.map((p) => p.position),
    [0, 1, 2],
  );
  assert.deepEqual(
    again.journal.placed.map((p) => p.kind),
    items.map((i) => i.kind),
  );
  for (let i = 0; i < 3; i++) {
    const read = again.journal.read(i);
    assert.deepEqual(read, items[i]);
  }
});

test("the chain is the package's running hash over the ids", async () => {
  const s = setup();
  const { journal } = await open(s.path, s);
  const items = [0, 1, 2, 3].map(item);
  for (const it of items) journal.append(it);
  const ids = items.map((i) => signedId(platform, i.signed));
  assert.ok(bytesEqual(journal.chain, runningHash(platform, ids)));
  assert.ok(bytesEqual(journal.placed[3]?.chain as Uint8Array, runningHash(platform, ids)));
  assert.ok(bytesEqual(journal.placed[1]?.id as Uint8Array, ids[1] as Uint8Array));
});

test("offsets and length follow the file", async () => {
  const s = setup();
  const { journal, fd } = await open(s.path, s);
  const header = fileHeader("journal", s.relay).length;
  assert.equal(journal.length, header);
  const a = journal.append(item(0)).placed;
  assert.equal(a.offset, header);
  const b = journal.append(item(1)).placed;
  assert.equal(b.offset, a.offset + a.length);
  assert.equal(journal.length, fstatSync(fd).size);
  assert.equal(journal.length, b.offset + b.length);
});

test("the tail is the last 64 bytes of the file, the header's when it holds no record", async () => {
  const s = setup();
  const { journal } = await open(s.path, s);
  const header = fileHeader("journal", s.relay);
  assert.deepEqual(Array.from(journal.tail), Array.from(header.subarray(-64)));
  journal.append(item(0));
  const file = readFileSync(s.path);
  assert.deepEqual(Array.from(journal.tail), Array.from(file.subarray(-64)));
});

test("a torn tail is dropped, counted and truncated, and the records before it stay", async () => {
  const s = setup();
  const first = await open(s.path, s);
  for (const i of [0, 1, 2]) first.journal.append(item(i));
  const good = first.journal.length;
  closeSync(first.fd);
  appendFileSync(s.path, readFileSync(s.path).subarray(good - 40, good - 5));
  const again = await open(s.path, s);
  assert.equal(again.dropped, 35);
  assert.equal(again.journal.placed.length, 3);
  assert.equal(fstatSync(again.fd).size, good);
  assert.equal(again.journal.length, good);
  assert.equal(s.stops.length, 0);
  assert.ok(s.syncs.length > 0, "the truncation is synced");
});

test("a damaged record ends the journal: it and everything after it go", async () => {
  const s = setup();
  const first = await open(s.path, s);
  for (const i of [0, 1, 2, 3]) first.journal.append(item(i));
  const second = first.journal.placed[1] as { offset: number; length: number };
  const total = first.journal.length;
  closeSync(first.fd);
  const file = readFileSync(s.path);
  file[second.offset + 20] = (file[second.offset + 20] as number) ^ 1;
  writeFileSync(s.path, file);
  const again = await open(s.path, s);
  assert.equal(again.journal.placed.length, 1);
  assert.equal(again.dropped, total - second.offset);
  assert.equal(fstatSync(again.fd).size, second.offset);
});

test("a record with a good check but a wrong position or chain is dropped too", async () => {
  const forge = async (mutate: (record: Buffer) => void) => {
    const s = setup();
    const first = await open(s.path, s);
    for (const i of [0, 1]) first.journal.append(item(i));
    const second = first.journal.placed[1] as { offset: number; length: number };
    closeSync(first.fd);
    const file = readFileSync(s.path);
    const record = file.subarray(second.offset, second.offset + second.length);
    mutate(record);
    // a writer that can recompute `check` is no attacker of the design, only a copy gone wrong
    const sum = platform.sha256(record.subarray(0, record.length - 32));
    record.set(sum, record.length - 32);
    writeFileSync(s.path, file);
    return (await open(s.path, s)).journal.placed.length;
  };
  assert.equal(await forge((r) => (r[11] = 9)), 1, "position");
  assert.equal(
    await forge((r) => (r[r.length - 40] = (r[r.length - 40] as number) ^ 1)),
    1,
    "chain",
  );
});

test("a length that runs past the end is a torn tail", async () => {
  const s = setup();
  const first = await open(s.path, s);
  first.journal.append(item(0));
  closeSync(first.fd);
  appendFileSync(s.path, Buffer.from([0x7f, 0xff, 0xff, 0xff, 1, 2, 3]));
  const again = await open(s.path, s);
  assert.equal(again.journal.placed.length, 1);
  assert.equal(again.dropped, 7);
});

test("a journal under another relay's id, or with no header, is not whole", async () => {
  const s = setup();
  await assert.rejects(open(s.path, s, new Uint8Array(32).fill(9)), NotWhole);
  writeFileSync(s.path, new Uint8Array(10));
  await assert.rejects(open(s.path, s), NotWhole);
});

test("a record counts as durable once the round that covers it has synced", async () => {
  const s = setup();
  let release: () => void = () => {};
  let calls = 0;
  const held = fakeSeam({
    sync: () => {
      calls++;
      return calls === 1 ? Promise.resolve() : new Promise<void>((resolve) => (release = resolve));
    },
  });
  const fd = openAppending(s.path);
  const { journal } = await Journal.open(platform, held.rounds, fd, s.relay);
  assert.equal(journal.durable, 0);
  const { ticket } = journal.append(item(0));
  journal.append(item(1));
  assert.equal(journal.durable, 0);
  await tick();
  assert.equal(journal.durable, 0, "the round has not finished");
  release();
  await held.rounds.wait(ticket);
  assert.equal(journal.durable, 2);
});

test("a short write throws, stops with 75, indexes nothing, and the next start drops it", async () => {
  const s = setup();
  let short = false;
  const faulty = fakeSeam({
    write: (fd, bytes) => writeSync(fd, short ? bytes.subarray(0, bytes.length - 9) : bytes),
  });
  const fd = openAppending(s.path);
  const { journal } = await Journal.open(platform, faulty.rounds, fd, s.relay);
  journal.append(item(0));
  const good = journal.length;
  short = true;
  assert.throws(() => journal.append(item(1)));
  assert.deepEqual(faulty.stops, [75]);
  assert.equal(journal.placed.length, 1);
  assert.equal(journal.length, good);
  assert.ok(fstatSync(fd).size > good);
  closeSync(fd);
  const again = await open(s.path, s);
  assert.equal(again.journal.placed.length, 1);
  assert.ok(again.dropped > 0);
});

test("a write that throws ENOSPC stops with 75 and leaves the journal as it was", async () => {
  const s = setup();
  const faulty = fakeSeam({
    write: () => {
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC", syscall: "write" });
    },
  });
  const fd = openAppending(s.path);
  const { journal } = await Journal.open(platform, faulty.rounds, fd, s.relay);
  assert.throws(() => journal.append(item(0)));
  assert.deepEqual(faulty.stops, [75]);
  assert.equal(journal.placed.length, 0);
});

test("an item read back that differs from its id is a directory changed", async () => {
  const s = setup();
  const { journal, fd } = await open(s.path, s);
  const placed = journal.append(item(0)).placed;
  journal.append(item(1));
  // the same length, other bytes, written over the running journal
  const file = readFileSync(s.path);
  file[placed.offset + 20] = (file[placed.offset + 20] as number) ^ 1;
  writeFileSync(s.path, file);
  assert.throws(() => journal.read(0), DirectoryChanged);
  assert.deepEqual(journal.read(1), item(1));
  void fd;
});

test("a bad check in the third record keeps two (1b-C2)", async () => {
  const s = setup();
  const first = await open(s.path, s);
  for (const i of [0, 1, 2, 3]) first.journal.append(item(i));
  const third = first.journal.placed[2] as { offset: number; length: number };
  closeSync(first.fd);
  const file = readFileSync(s.path);
  // A signature byte: nothing else of the record changes, so only `check` can tell.
  const at = third.offset + third.length - 32 - 32 - 1;
  file[at] = (file[at] as number) ^ 1;
  writeFileSync(s.path, file);
  const again = await open(s.path, s);
  assert.equal(again.journal.placed.length, 2);
});

test("at start every record read counts as durable (1b-C3)", async () => {
  const s = setup();
  const first = await open(s.path, s);
  for (const i of [0, 1, 2]) first.journal.append(item(i));
  closeSync(first.fd);
  const again = await open(s.path, s);
  assert.equal(again.journal.durable, 3);
});

test("read checks the record's kind and signature against memory, not its id alone (1b-CR6)", async () => {
  for (const where of ["kind", "sig"] as const) {
    const s = setup();
    const { journal } = await open(s.path, s);
    const placed = journal.append(item(0)).placed;
    const file = readFileSync(s.path);
    const at = where === "kind" ? placed.offset + 12 : placed.offset + placed.length - 64 - 1;
    file[at] = (file[at] as number) ^ 1;
    writeFileSync(s.path, file);
    assert.throws(() => journal.read(0), DirectoryChanged, where);
  }
});

test("the tail follows many small appends and one large (1b-CR9)", async () => {
  const s = setup();
  const { journal } = await open(s.path, s);
  for (const i of [0, 1]) {
    journal.append(item(i));
    assert.deepEqual(Array.from(journal.tail), Array.from(readFileSync(s.path).subarray(-64)));
  }
  journal.append({ kind: 1, signed: new Uint8Array(500).fill(3), sig: new Uint8Array(64) });
  assert.deepEqual(Array.from(journal.tail), Array.from(readFileSync(s.path).subarray(-64)));
});

test("read refuses a record replaced by another whole one that chains to the same first record (N2)", async () => {
  const a = setup();
  const b = setup();
  const first = await open(a.path, a);
  const other = await open(b.path, b);
  for (const j of [first.journal, other.journal]) j.append(item(0));
  first.journal.append(item(1));
  other.journal.append(item(4)); // the same length as item(1): the file keeps its size
  const at = first.journal.placed[1] as { offset: number };
  const forked = Buffer.concat([
    readFileSync(a.path).subarray(0, at.offset),
    readFileSync(b.path).subarray(at.offset),
  ]);
  assert.equal(forked.length, first.journal.length);
  writeFileSync(a.path, forked);
  assert.throws(() => first.journal.read(1), DirectoryChanged);
  assert.deepEqual(first.journal.read(0), item(0));
});

test("a start hands each whole record to the caller as it reads it, and none of the dropped tail", async () => {
  const s = setup();
  const first = await open(s.path, s);
  const items = [0, 1, 2].map(item);
  for (const it of items) first.journal.append(it);
  closeSync(first.fd);
  appendFileSync(s.path, Buffer.from([0, 0, 0, 9, 1]));
  const seen: [number, number][] = [];
  const fd = openAppending(s.path);
  const again = await Journal.open(platform, s.rounds, fd, s.relay, (placed, read) => {
    assert.deepEqual(read, items[placed.position]);
    seen.push([placed.position, placed.kind]);
  });
  assert.deepEqual(seen, [
    [0, 1],
    [1, 2],
    [2, 3],
  ]);
  assert.equal(again.dropped, 5);
});
