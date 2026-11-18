import assert from "node:assert/strict";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createLog, errorFields } from "../../src/relay/log.ts";
import { nodeSeam, Rounds, type Seam, StorageFailed } from "../../src/relay/round.ts";
import { tempDirSync } from "../support/temp.ts";
import { fakeSeam, tick } from "./support.ts";

const bytes = (n: number) => new Uint8Array(n).fill(7);

test("one round covers every write made before it began", async () => {
  const dir = tempDirSync("pardner-relay-");
  const fd = openSync(join(dir, "f"), "a+");
  const { rounds, syncs } = fakeSeam();
  const tickets = Array.from({ length: 20 }, () => rounds.write("journal", fd, bytes(30)));
  await rounds.wait(tickets[19] as number);
  assert.deepEqual(syncs, [fd]);
  assert.equal(rounds.synced, tickets[19]);
  assert.equal(readFileSync(join(dir, "f")).length, 600);
  closeSync(fd);
});

test("a round syncs the files in the order of the design", async () => {
  const dir = tempDirSync("pardner-relay-");
  const open = (name: string) => openSync(join(dir, name), "a+");
  const [data, blobs, seals, journal, mark, directory] = ["a", "b", "c", "d", "e", "f"].map(
    open,
  ) as number[];
  const { rounds, syncs } = fakeSeam();
  rounds.touch("directory", directory as number);
  rounds.write("mark", mark as number, bytes(1));
  rounds.write("journal", journal as number, bytes(1));
  rounds.write("seals", seals as number, bytes(1));
  rounds.touch("blobs", blobs as number);
  const last = rounds.touch("blob-data", data as number);
  await rounds.wait(last);
  assert.deepEqual(syncs, [data, blobs, seals, journal, mark, directory]);
  for (const fd of [data, blobs, seals, journal, mark, directory]) rounds.close(fd as number);
});

test("a write made during a round waits for the next one", async () => {
  const dir = tempDirSync("pardner-relay-");
  const fd = openSync(join(dir, "f"), "a+");
  let release: () => void = () => {};
  let calls = 0;
  const { rounds } = fakeSeam({
    sync: async () => {
      calls++;
      if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
    },
  });
  const first = rounds.write("journal", fd, bytes(1));
  await tick();
  const second = rounds.write("journal", fd, bytes(1));
  let secondDone = false;
  void rounds.wait(second).then(() => (secondDone = true));
  release();
  await rounds.wait(first);
  assert.equal(rounds.synced >= first, true);
  await rounds.wait(second);
  assert.equal(secondDone, true);
  assert.equal(calls, 2);
  closeSync(fd);
});

test("an answer that depends on nothing written waits for nothing", async () => {
  const { rounds } = fakeSeam();
  await rounds.wait(rounds.written);
  assert.equal(rounds.written, 0);
});

test("a failed sync answers nothing, logs the code alone and stops with 75", async () => {
  const dir = tempDirSync("pardner-relay-");
  const fd = openSync(join(dir, "secret-blob-name"), "a+");
  const { rounds, stops, lines } = fakeSeam({
    sync: async () => {
      throw Object.assign(new Error(`EIO: i/o error, fsync '${dir}/secret-blob-name'`), {
        code: "EIO",
        syscall: "fsync",
        path: `${dir}/secret-blob-name`,
      });
    },
  });
  const ticket = rounds.write("journal", fd, bytes(1));
  let answered = false;
  void rounds.wait(ticket).then(() => (answered = true));
  await tick();
  await tick();
  assert.equal(answered, false);
  assert.deepEqual(stops, [75]);
  assert.equal(rounds.failed, true);
  const text = lines.join("\n");
  assert.match(text, /EIO/);
  assert.match(text, /fsync/);
  assert.doesNotMatch(text, /secret-blob-name/);
  assert.throws(() => rounds.write("journal", fd, bytes(1)), StorageFailed);
  assert.deepEqual(stops, [75]);
  closeSync(fd);
});

test("a short write is an fsync error", () => {
  const dir = tempDirSync("pardner-relay-");
  const fd = openSync(join(dir, "f"), "a+");
  const { rounds, stops, lines } = fakeSeam({ write: (_fd, b) => b.length - 1 });
  assert.throws(() => rounds.write("journal", fd, bytes(10)), StorageFailed);
  assert.deepEqual(stops, [75]);
  assert.match(lines.join("\n"), /short write/);
  closeSync(fd);
});

test("a write that throws is an fsync error and logs its code", () => {
  const dir = tempDirSync("pardner-relay-");
  const fd = openSync(join(dir, "f"), "a+");
  const { rounds, stops, lines } = fakeSeam({
    write: () => {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
        code: "ENOSPC",
        syscall: "write",
      });
    },
  });
  assert.throws(() => rounds.write("seals", fd, bytes(10)), StorageFailed);
  assert.deepEqual(stops, [75]);
  assert.match(lines.join("\n"), /ENOSPC/);
  closeSync(fd);
});

test("guard runs a call and turns its error into a stop", () => {
  const { rounds, stops } = fakeSeam();
  assert.equal(
    rounds.guard("journal", () => 5),
    5,
  );
  assert.throws(
    () =>
      rounds.guard("directory", () => {
        throw Object.assign(new Error("x"), { code: "EIO", syscall: "rename" });
      }),
    StorageFailed,
  );
  assert.deepEqual(stops, [75]);
});

test("a barrier syncs its files in turn and a failure stops", async () => {
  const dir = tempDirSync("pardner-relay-");
  const a = openSync(join(dir, "a"), "a+");
  const b = openSync(join(dir, "b"), "a+");
  const ok = fakeSeam();
  await ok.rounds.barrier([
    ["journal", a],
    ["directory", b],
  ]);
  assert.deepEqual(ok.syncs, [a, b]);
  const bad = fakeSeam({
    sync: async () => {
      throw Object.assign(new Error("x"), { code: "EIO", syscall: "fsync" });
    },
  });
  await assert.rejects(bad.rounds.barrier([["journal", a]]), StorageFailed);
  assert.deepEqual(bad.stops, [75]);
  closeSync(a);
  closeSync(b);
});

test("errorFields names a code and a syscall, never a message or a path", () => {
  const error = Object.assign(new Error("ENOENT: open 'blobs/ab12'"), {
    code: "ENOENT",
    syscall: "open",
    path: "blobs/ab12",
  });
  assert.equal(errorFields(error), "code=ENOENT syscall=open");
  assert.equal(errorFields(new Error("blobs/ab12")), "code=unknown syscall=unknown");
  assert.equal(errorFields("blobs/ab12"), "code=unknown syscall=unknown");
});

/** A rounds object over a fake write that counts what it is given, for tests that hold no file. */
function bare(over: Partial<Seam>) {
  const stops: number[] = [];
  const lines: string[] = [];
  const seam: Seam = {
    sync: async () => {},
    write: (_fd, b) => b.length,
    free: () => 1e12,
    stop: (code) => {
      stops.push(code);
    },
    now: () => 0,
    ...over,
  };
  return {
    stops,
    lines,
    rounds: new Rounds(
      seam,
      createLog(
        (l) => lines.push(l),
        () => 0,
      ),
    ),
  };
}

test("a round in flight when a write fails answers nothing after the failure (1a-C1)", async () => {
  let release: () => void = () => {};
  let writes = 0;
  const { rounds, stops } = bare({
    sync: () => new Promise<void>((resolve) => (release = resolve)),
    write: (_fd, b) => (++writes === 2 ? b.length - 1 : b.length),
  });
  const first = rounds.write("journal", 3, bytes(8));
  let answered = false;
  void rounds.wait(first).then(() => (answered = true));
  await tick();
  assert.throws(() => rounds.write("journal", 3, bytes(8)), StorageFailed);
  assert.deepEqual(stops, [75]);
  release();
  await tick();
  assert.equal(answered, false, "an answer was released after the failure");
  assert.equal(rounds.synced, 0);
});

test("wait after a failure settles nothing, a ticket synced before it included (1a-C1)", async () => {
  let calls = 0;
  const { rounds, stops } = bare({
    sync: async () => {
      if (++calls === 2) throw Object.assign(new Error("x"), { code: "EIO", syscall: "fsync" });
    },
  });
  const first = rounds.write("journal", 3, bytes(8));
  await rounds.wait(first);
  rounds.write("journal", 3, bytes(8));
  await tick();
  await tick();
  assert.deepEqual(stops, [75]);
  let answered = false;
  void rounds.wait(first).then(() => (answered = true));
  await tick();
  assert.equal(answered, false, "wait resolved after the failure");
});

test("a log line that throws still stops the relay (1a-C2)", async () => {
  const stops: number[] = [];
  const seam: Seam = {
    sync: async () => {
      throw Object.assign(new Error("x"), { code: "EIO", syscall: "fsync" });
    },
    write: (_fd, b) => b.length,
    free: () => 1e12,
    stop: (code) => {
      stops.push(code);
    },
    now: () => 0,
  };
  const rounds = new Rounds(seam, {
    info() {},
    warning() {},
    error() {
      throw new Error("the log failed");
    },
  });
  rounds.write("journal", 3, bytes(8));
  await tick();
  await tick();
  assert.equal(rounds.failed, true);
  assert.deepEqual(stops, [75]);
});

test("written is the latest ticket, which an answer waits for (1a-CR3)", async () => {
  const { rounds } = bare({});
  assert.equal(rounds.written, 0);
  const a = rounds.write("journal", 3, bytes(1));
  const b = rounds.write("journal", 3, bytes(1));
  assert.equal(rounds.written, b);
  assert.ok(a < b);
  assert.ok(rounds.synced < rounds.written, "nothing is synced yet");
  await rounds.wait(rounds.written);
  assert.equal(rounds.synced, b);
});

test("answers are released under a steady load of seals and records (1a-N1)", async () => {
  const dir = tempDirSync("pardner-relay-");
  const seals = openSync(join(dir, "s"), "a+");
  const journal = openSync(join(dir, "j"), "a+");
  // Each sync takes 4 ms (F_FULLFSYNC's median, design 3.6); a handler writes a seal and the
  // record that follows it every 2 ms, so a write always arrives mid-round.
  const { rounds } = fakeSeam({
    sync: () => new Promise<void>((resolve) => setTimeout(resolve, 4)),
  });
  let answered = 0;
  const timer = setInterval(() => {
    rounds.write("seals", seals, bytes(4));
    void rounds.wait(rounds.write("journal", journal, bytes(4))).then(() => answered++);
  }, 2);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  clearInterval(timer);
  assert.ok(answered > 0, `no answer was released in one second (synced ${rounds.synced})`);
  await rounds.wait(rounds.written);
  rounds.close(seals);
  rounds.close(journal);
});

test("the round closes a descriptor only after it has synced it (1a-CR1)", async () => {
  const dir = tempDirSync("pardner-relay-");
  const fd = openSync(join(dir, "f"), "a+");
  let release: () => void = () => {};
  const { rounds } = fakeSeam({ sync: () => new Promise<void>((resolve) => (release = resolve)) });
  const ticket = rounds.write("journal", fd, bytes(1));
  await tick();
  rounds.close(fd);
  assert.doesNotThrow(() => fstatSync(fd), "still open while its sync is in flight");
  assert.throws(() => rounds.write("journal", fd, bytes(1)), RangeError);
  release();
  await rounds.wait(ticket);
  assert.throws(() => fstatSync(fd), /EBADF/);
});

test("a descriptor closed at once after a write never fails a real sync (1a-CR1)", async () => {
  const dir = tempDirSync("pardner-relay-");
  const stops: number[] = [];
  const { rounds } = bare({
    sync: nodeSeam.sync,
    write: nodeSeam.write,
    stop: (code) => {
      stops.push(code);
    },
  });
  const fd = openSync(join(dir, "f"), "a+");
  const ticket = rounds.write("journal", fd, bytes(4));
  rounds.close(fd);
  await rounds.wait(ticket);
  assert.deepEqual(stops, []);
  assert.equal(rounds.failed, false);
  assert.throws(() => fstatSync(fd), /EBADF/);
  const idle = openSync(join(dir, "g"), "a+");
  rounds.close(idle);
  assert.throws(() => fstatSync(idle), /EBADF/, "an idle descriptor closes at once");
});

test("a descriptor closed while queued behind another file's sync is synced, then closed", async () => {
  const dir = tempDirSync("pardner-relay-");
  const seals = openSync(join(dir, "s"), "a+");
  const journal = openSync(join(dir, "j"), "a+");
  let release: () => void = () => {};
  const { rounds, stops } = fakeSeam({
    sync: async (fd) => {
      if (fd === seals) await new Promise<void>((resolve) => (release = resolve));
      return nodeSeam.sync(fd);
    },
  });
  rounds.write("seals", seals, bytes(1));
  const ticket = rounds.write("journal", journal, bytes(1));
  await tick();
  rounds.close(journal);
  assert.doesNotThrow(() => fstatSync(journal), "still open while queued in the running round");
  release();
  await rounds.wait(ticket);
  assert.deepEqual(stops, []);
  assert.equal(rounds.synced, ticket);
  assert.throws(() => fstatSync(journal), /EBADF/);
  rounds.close(seals);
});

test("write refuses the blob-data role: a blob's write error is not fatal (1a-C3)", () => {
  const { rounds, stops } = bare({});
  assert.throws(() => rounds.write("blob-data" as never, 3, bytes(1)), RangeError);
  assert.deepEqual(stops, []);
});

test("a short write logs both counts (1a-C6)", () => {
  const { rounds, lines } = bare({ write: () => 3 });
  assert.throws(() => rounds.write("journal", 3, bytes(10)), StorageFailed);
  assert.match(lines.join("\n"), /short write of journal: 3 of 10 bytes/);
});

test("a log line reads as the daemon's does (1a-CR7)", () => {
  const lines: string[] = [];
  createLog(
    (l) => lines.push(l),
    () => 1_700_000_000_123,
  ).warning("hello");
  assert.match(lines[0] as string, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,123 WARNING relay: hello$/);
});
