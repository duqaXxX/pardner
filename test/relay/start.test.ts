import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  fstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { idKey } from "../../src/protocol/device-log.ts";
import { encodeHistorySeal } from "../../src/protocol/epochs.ts";
import { lockDirectory } from "../../src/relay/directory.ts";
import { ExclusionFailed, type Exec } from "../../src/relay/exclusion.ts";
import { fileHeader } from "../../src/relay/journal.ts";
import { StorageFailed } from "../../src/relay/round.ts";
import { SealsFile } from "../../src/relay/seals-file.ts";
import { start } from "../../src/relay/start.ts";
import { tempDirSync } from "../support/temp.ts";
import { fakeSeam, makeRelayDir, openAppending, platform, track } from "./support.ts";
import { channelled, fill, keyed, person, signedBy } from "./world.ts";

const DARWIN = {
  skip: process.platform === "darwin" ? false : "the directory lock is the macOS mechanism",
};
const noExec: Exec = () => {};

function deps(over: Parameters<typeof fakeSeam>[0] = {}, exec: Exec = noExec) {
  const s = fakeSeam(over);
  return { s, deps: { seam: s.seam, log: s.log, exec, platform, os: "darwin" } };
}

/** A whole directory whose journal holds `count` real device entries: alice's genesis, then adds. */
async function whole(count: number) {
  const dir = tempDirSync("pardner-relay-");
  const relay = makeRelayDir(dir);
  if (count > 0) {
    const { Journal } = await import("../../src/relay/journal.ts");
    const { openAppending } = await import("./support.ts");
    const s = fakeSeam();
    const fd = openAppending(join(dir, "journal"));
    const { journal } = await Journal.open(platform, s.rounds, fd, relay);
    const alice = person();
    const log = [{ id: platform.sha256(alice.genesis.signed) }];
    journal.append({ kind: 1, ...alice.genesis });
    for (let i = 1; i < count; i++) {
      const added = alice.add(log as never, keyed());
      journal.append({ kind: 1, ...added });
      log.push({ id: platform.sha256(added.signed) });
    }
    await s.rounds.wait(s.rounds.written);
    closeSync(fd);
  }
  return { dir, relay };
}

test("a path that is none or not whole waits: no lock, nothing written", async () => {
  const root = tempDirSync("pardner-relay-");
  const { s, deps: d } = deps();
  const missing = await start(join(root, "missing"), d);
  assert.equal(missing.state, "waiting");
  const broken = join(root, "broken");
  const relay = makeRelayDir(broken);
  rmSync(join(broken, "seals"));
  const before = readdirSync(broken);
  const found = await start(broken, d);
  assert.equal(found.state, "waiting");
  assert.match(found.state === "waiting" ? found.why : "", /seals/);
  assert.deepEqual(readdirSync(broken), before);
  assert.equal(s.stops.length, 0);
  void relay;
});

test(
  "a whole directory is served: the journal read, the start synced, a fresh incarnation",
  DARWIN,
  async () => {
    const { dir } = await whole(3);
    const a = deps();
    const first = await start(dir, a.deps);
    assert.equal(first.state, "serving");
    if (first.state !== "serving") return;
    track(first.lock);
    assert.equal(first.journal.placed.length, 3);
    assert.equal(first.journal.durable, 3);
    assert.equal(first.incarnation.length, 16);
    assert.ok(a.s.syncs.length >= 4, "journal, seals, blobs and the directory");
    assert.ok(a.s.syncs.includes(first.lock), "the directory's descriptor is synced");
    closeSync(first.lock);
    const second = await start(dir, deps().deps);
    assert.equal(second.state, "serving");
    if (second.state === "serving") {
      track(second.lock);
      assert.notDeepEqual(Array.from(second.incarnation), Array.from(first.incarnation));
    }
  },
);

test("the exclusion is asked of the directory itself", DARWIN, async () => {
  const { dir } = await whole(0);
  const calls: string[] = [];
  const { deps: d } = deps({}, (_f, args) => void calls.push(args[1] as string));
  const found = await start(dir, d);
  if (found.state === "serving") track(found.lock);
  assert.deepEqual(calls, [dir]);
});

test(
  "a torn tail is dropped, logged by its count, and the records before it are served",
  DARWIN,
  async () => {
    const { dir } = await whole(2);
    const size = statSync(join(dir, "journal")).size;
    const fs = await import("node:fs");
    fs.appendFileSync(join(dir, "journal"), Buffer.from([0, 0, 1, 0, 9, 9, 9]));
    const a = deps();
    const found = await start(dir, a.deps);
    assert.equal(found.state, "serving");
    if (found.state === "serving") track(found.lock);
    assert.equal(statSync(join(dir, "journal")).size, size);
    assert.match(a.s.lines.join("\n"), /dropped 7 bytes/);
  },
);

test(
  "a journal that vanished after the check waits, and is not made again (2-CR6)",
  DARWIN,
  async () => {
    const { dir } = await whole(0);
    const exec: Exec = () => rmSync(join(dir, "journal"));
    const found = await start(dir, deps({}, exec).deps);
    assert.equal(found.state, "waiting");
    assert.equal(existsSync(join(dir, "journal")), false, "opened without O_CREAT");
    closeSync(lockDirectory(dir));
  },
);

test(
  "a start that fails after opening its files closes them and the lock (2-CR6)",
  DARWIN,
  async () => {
    const { dir } = await whole(1);
    const a = deps({
      sync: async (fd) => {
        a.s.syncs.push(fd);
        throw Object.assign(new Error("x"), { code: "EIO", syscall: "fsync" });
      },
    });
    await assert.rejects(start(dir, a.deps), StorageFailed);
    assert.equal(a.s.stops.length, 1);
    assert.equal(a.s.syncs.length, 1);
    assert.throws(() => fstatSync(a.s.syncs[0] as number), /EBADF/);
    closeSync(lockDirectory(dir));
  },
);

test("the exclusion is set on a failed-closed start too (2-C9)", DARWIN, async () => {
  const { dir } = await whole(0);
  writeFileSync(join(dir, "failed-closed"), "x");
  const calls: string[] = [];
  const found = await start(dir, deps({}, (_f, args) => void calls.push(args[1] as string)).deps);
  assert.equal(found.state, "failed closed");
  if (found.state === "failed closed") track(found.lock);
  assert.deepEqual(calls, [dir]);
});

test(
  "a mark of any length is failed closed: the journal is not read, the lock is held",
  DARWIN,
  async () => {
    for (const content of ["", "x", "a mark longer than sixteen bytes in all"]) {
      const { dir } = await whole(1);
      const fs = await import("node:fs");
      fs.appendFileSync(join(dir, "journal"), Buffer.from([1, 2, 3]));
      const size = statSync(join(dir, "journal")).size;
      writeFileSync(join(dir, "failed-closed"), content);
      const found = await start(dir, deps().deps);
      assert.equal(found.state, "failed closed");
      assert.equal(statSync(join(dir, "journal")).size, size, "not read, so nothing dropped");
      if (found.state === "failed closed") {
        assert.throws(() => lockDirectory(dir), /another relay/, "the lock is held");
        closeSync(found.lock);
      }
    }
  },
);

test("a stale tmp-failed-closed is removed, with or without a mark", DARWIN, async () => {
  for (const mark of [false, true]) {
    const { dir } = await whole(0);
    writeFileSync(join(dir, "tmp-failed-closed"), "half");
    if (mark) writeFileSync(join(dir, "failed-closed"), "x");
    const found = await start(dir, deps().deps);
    if (found.state === "serving" || found.state === "failed closed") track(found.lock);
    assert.equal(existsSync(join(dir, "tmp-failed-closed")), false);
  }
});

test(
  "a leftover enrol goes once the journal holds a device entry, and stays before",
  DARWIN,
  async () => {
    const cases: [number, boolean][] = [
      [0, true],
      [1, false],
      [3, false],
    ];
    for (const [count, kept] of cases) {
      const { dir } = await whole(count);
      writeFileSync(join(dir, "enrol"), new Uint8Array(32));
      const found = await start(dir, deps().deps);
      if (found.state === "serving") track(found.lock);
      assert.equal(existsSync(join(dir, "enrol")), kept, String(count));
    }
  },
);

test(
  "another process holding the directory is HeldElsewhere, and nothing was written",
  DARWIN,
  async () => {
    const { dir } = await whole(0);
    const held = track(lockDirectory(dir));
    const before = readdirSync(dir);
    await assert.rejects(start(dir, deps().deps), /another relay/);
    assert.deepEqual(readdirSync(dir), before);
    closeSync(held);
  },
);

test("a failed exclusion exits the start, writes nothing and frees the lock", DARWIN, async () => {
  const { dir } = await whole(1);
  const fs = await import("node:fs");
  fs.appendFileSync(join(dir, "journal"), Buffer.from([1, 2, 3]));
  const size = statSync(join(dir, "journal")).size;
  const exec: Exec = () => {
    throw new Error("tmutil failed");
  };
  await assert.rejects(start(dir, deps({}, exec).deps), ExclusionFailed);
  assert.equal(statSync(join(dir, "journal")).size, size);
  closeSync(lockDirectory(dir));
});

test("an fsync error at start stops with 75 and serves nothing", DARWIN, async () => {
  const { dir } = await whole(1);
  const a = deps({
    sync: async () => {
      throw Object.assign(new Error("x"), { code: "EIO", syscall: "fsync" });
    },
  });
  await assert.rejects(start(dir, a.deps), StorageFailed);
  assert.deepEqual(a.s.stops, [75]);
  void fileHeader;
  void fstatSync;
});

test("a directory removed between the check and the lock waits (2-R2-3)", DARWIN, async () => {
  const { dir } = await whole(0);
  const a = deps();
  const lock = (path: string) => {
    rmSync(path, { recursive: true, force: true });
    return lockDirectory(path);
  };
  const found = await start(dir, { ...a.deps, lock });
  assert.equal(found.state, "waiting");
});

test(
  "a start reads the journal through the sequence and loads the seals file (3a-N1, 4a-CR4)",
  DARWIN,
  async () => {
    const w = await channelled();
    const epoch = w.open().id;
    const next = w.open().id;
    const second = keyed();
    w.join(second);
    const seal = (maker: ReturnType<typeof keyed>) =>
      signedBy(
        maker,
        encodeHistorySeal({
          channel: w.channel,
          epoch,
          recipient: second.id,
          enc: second.keys.receiving,
          sealed: fill(7, 48),
          maker: maker.id,
        }),
      );
    const kept = seal(w.alice.first);
    const { Seals } = await import("../../src/relay/seals.ts");
    const seals = await Seals.open(
      platform,
      w.s.rounds,
      w.seq,
      openAppending(join(w.dir, "seals")),
      w.relay,
    );
    assert.equal(seals.give(w.a, kept.signed, kept.sig).code, 0);
    await w.flush();
    // A seal whose maker no log names, as a power cut can leave it: the start cuts the file there.
    const { file } = await SealsFile.open(
      platform,
      w.s.rounds,
      openAppending(join(w.dir, "seals")),
      w.relay,
    );
    file.append(seal(keyed()));
    await w.flush();
    const a = deps();
    const started = await start(w.dir, a.deps);
    assert.equal(started.state, "serving");
    if (started.state !== "serving") return;
    track(started.lock);
    assert.ok(started.seq.devices.has(idKey(w.alice.id)), "the indexes are built at the start");
    assert.deepEqual(started.seals.list(w.a), [kept]);
    assert.equal(started.seals.dropped.seals, 1);
    // The file stays open for appending: a seal given now is written and served.
    const third = signedBy(
      w.alice.first,
      encodeHistorySeal({
        ...{
          channel: w.channel,
          epoch: next,
          recipient: second.id,
          enc: second.keys.receiving,
          sealed: fill(7, 48),
          maker: w.alice.first.id,
        },
      }),
    );
    assert.equal(started.seals.give(w.a, third.signed, third.sig).code, 0);
  },
);

test(
  "a start returns the relay key it read, serving or failed closed, as the file holds it (2-C9)",
  DARWIN,
  async () => {
    for (const marked of [false, true]) {
      const { dir } = await whole(0);
      if (marked) writeFileSync(join(dir, "failed-closed"), "x");
      const found = await start(dir, deps().deps);
      assert.equal(found.state, marked ? "failed closed" : "serving");
      track(found.lock);
      assert.deepEqual(found.key, readFileSync(join(dir, "key.pem")));
    }
  },
);

test("a blob file nothing wants is taken back at the start (3.11, 2-CR3)", DARWIN, async () => {
  const { dir } = await whole(0);
  const stray = join(dir, "blobs", "tmp-1");
  writeFileSync(stray, "half a blob");
  const found = await start(dir, deps().deps);
  if (found.state === "serving") track(found.lock);
  assert.equal(found.state, "serving");
  assert.equal(existsSync(stray), false);
});

test(
  "a start that fails at its last barrier leaves no descriptor open (2-C4)",
  DARWIN,
  async () => {
    const { dir } = await whole(1);
    let calls = 0;
    const a = deps({
      sync: async () => {
        calls += 1;
        if (calls >= 3) throw Object.assign(new Error("x"), { code: "EIO", syscall: "fsync" });
      },
    });
    const open = () =>
      new Set(
        readdirSync("/dev/fd")
          .map(Number)
          .filter((fd) => {
            try {
              fstatSync(fd);
              return true;
            } catch {
              return false;
            }
          }),
      );
    const before = open();
    await assert.rejects(start(dir, a.deps), StorageFailed);
    assert.ok(calls >= 3, "the barrier was reached");
    assert.deepEqual(
      [...open()].filter((fd) => !before.has(fd)),
      [],
    );
  },
);
