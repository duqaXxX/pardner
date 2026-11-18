import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  changed,
  failedClosed,
  HeldElsewhere,
  inspect,
  lockDirectory,
  writeMark,
} from "../../src/relay/directory.ts";
import { fileHeader, Journal } from "../../src/relay/journal.ts";
import { tempDirSync } from "../support/temp.ts";
import { fakeSeam, item, makeRelayDir, openAppending, platform, tick, track } from "./support.ts";

const DARWIN = {
  skip: process.platform === "darwin" ? false : "the directory lock is the macOS mechanism",
};
const DIRECTORY = new URL("../../src/relay/directory.ts", import.meta.url).href;

test("a path that is missing, empty, or holds only dot names is none", () => {
  const root = tempDirSync("pardner-relay-");
  const { log } = fakeSeam();
  assert.deepEqual(inspect(platform, join(root, "missing"), log), { state: "none" });
  mkdirSync(join(root, "empty"));
  assert.deepEqual(inspect(platform, join(root, "empty"), log), { state: "none" });
  mkdirSync(join(root, "finder"));
  writeFileSync(join(root, "finder", ".DS_Store"), "x");
  assert.deepEqual(inspect(platform, join(root, "finder"), log), { state: "none" });
});

test("a directory with its key, journal, seals and blobs is whole, and names the key's id", () => {
  const dir = tempDirSync("pardner-relay-");
  const relay = makeRelayDir(dir);
  const { log, lines } = fakeSeam();
  writeFileSync(join(dir, ".DS_Store"), "x");
  const found = inspect(platform, dir, log);
  assert.equal(found.state, "whole");
  assert.deepEqual(found.state === "whole" ? Array.from(found.relay) : [], Array.from(relay));
  assert.equal(lines.length, 0, "a dot name is ignored silently");
});

test("a file the relay does not know is ignored and logged once", () => {
  const dir = tempDirSync("pardner-relay-");
  makeRelayDir(dir);
  writeFileSync(join(dir, "notes.txt"), "x");
  const { log, lines } = fakeSeam();
  assert.equal(inspect(platform, dir, log).state, "whole");
  assert.equal(inspect(platform, dir, log).state, "whole");
  assert.equal(lines.filter((l) => l.includes("unknown file")).length, 1);
});

test("anything else is not whole, and says which file by its role", () => {
  const { log } = fakeSeam();
  const cases: [string, (dir: string, relay: Uint8Array) => void][] = [
    ["key", (d) => rmSync(join(d, "key.pem"))],
    ["journal", (d) => rmSync(join(d, "journal"))],
    ["seals", (d) => rmSync(join(d, "seals"))],
    ["blobs", (d) => rmSync(join(d, "blobs"), { recursive: true })],
    [
      "blobs",
      (d) => {
        rmSync(join(d, "blobs"), { recursive: true });
        writeFileSync(join(d, "blobs"), "a file");
      },
    ],
    [
      "journal",
      (d) => writeFileSync(join(d, "journal"), fileHeader("journal", new Uint8Array(32))),
    ],
    ["seals", (d) => writeFileSync(join(d, "seals"), fileHeader("seals", new Uint8Array(32)))],
    ["key", (d) => writeFileSync(join(d, "key.pem"), "not a key")],
    ["journal", (d) => writeFileSync(join(d, "journal"), "short")],
  ];
  for (const [role, damage] of cases) {
    const dir = tempDirSync("pardner-relay-");
    const relay = makeRelayDir(dir);
    damage(dir, relay);
    const found = inspect(platform, dir, log);
    assert.equal(found.state, "not whole");
    assert.match(found.state === "not whole" ? found.why : "", new RegExp(role));
    assert.doesNotMatch(found.state === "not whole" ? found.why : "", /pardner-relay-/);
  }
});

test(
  "a second process meets EAGAIN on a held directory, and the kernel frees it with the holder",
  DARWIN,
  () => {
    const dir = tempDirSync("pardner-relay-");
    const fd = lockDirectory(dir);
    const script = `import { lockDirectory } from ${JSON.stringify(DIRECTORY)};
try { lockDirectory(${JSON.stringify(dir)}); console.log("locked"); } catch (e) { console.log(e.constructor.name + " " + e.cause?.code); }`;
    const run = () =>
      spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.match(run().stdout, /HeldElsewhere EAGAIN/);
    assert.throws(() => lockDirectory(dir), HeldElsewhere);
    closeSync(fd);
    assert.match(run().stdout, /locked/);
  },
);

test("a holder killed with SIGKILL leaves the directory free", DARWIN, () => {
  const dir = tempDirSync("pardner-relay-");
  const holder = `import { lockDirectory } from ${JSON.stringify(DIRECTORY)};
lockDirectory(${JSON.stringify(dir)}); process.kill(process.pid, "SIGKILL");`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", holder], {
    encoding: "utf8",
  });
  assert.equal(child.signal, "SIGKILL");
  closeSync(lockDirectory(dir));
});

async function running() {
  const dir = tempDirSync("pardner-relay-");
  const relay = makeRelayDir(dir);
  const s = fakeSeam();
  const lock = lockDirectory(dir);
  const fd = openAppending(join(dir, "journal"));
  const { journal } = await Journal.open(platform, s.rounds, fd, relay);
  for (const i of [0, 1]) journal.append(item(i));
  return { dir, relay, s, lock, fd, journal };
}

test("rule 11: a directory that has not changed passes", DARWIN, async () => {
  const r = await running();
  assert.equal(changed(r.dir, r.lock, r.journal), null);
});

test("rule 11: a directory renamed away and another put at its path is seen", DARWIN, async () => {
  const r = await running();
  renameSync(r.dir, `${r.dir}-old`);
  makeRelayDir(r.dir);
  assert.equal(changed(r.dir, r.lock, r.journal), "directory");
  rmSync(`${r.dir}-old`, { recursive: true });
});

test("rule 11: a journal replaced by a rename is seen", DARWIN, async () => {
  const r = await running();
  const copy = readFileSync(join(r.dir, "journal"));
  writeFileSync(join(r.dir, "journal.new"), copy);
  renameSync(join(r.dir, "journal.new"), join(r.dir, "journal"));
  assert.equal(changed(r.dir, r.lock, r.journal), "journal");
});

test("rule 11: a journal that grew or shrank in place is seen", DARWIN, async () => {
  const r = await running();
  writeFileSync(
    join(r.dir, "journal"),
    Buffer.concat([readFileSync(join(r.dir, "journal")), Buffer.from("x")]),
  );
  assert.equal(changed(r.dir, r.lock, r.journal), "size");
});

test(
  "rule 11: a copy of the same size written over the file in place is seen",
  DARWIN,
  async () => {
    const r = await running();
    const file = readFileSync(join(r.dir, "journal"));
    file[file.length - 3] = (file[file.length - 3] as number) ^ 1;
    writeFileSync(join(r.dir, "journal"), file);
    assert.equal(changed(r.dir, r.lock, r.journal), "tail");
  },
);

test("rule 11: a copy identical to what the relay wrote changes nothing", DARWIN, async () => {
  const r = await running();
  writeFileSync(join(r.dir, "journal"), readFileSync(join(r.dir, "journal")));
  assert.equal(changed(r.dir, r.lock, r.journal), null);
});

test("off macOS the lock is refused, never an unlocked descriptor (1b-CR2)", {
  skip: process.platform === "darwin" ? "macOS has the lock" : false,
}, () => {
  assert.throws(() => lockDirectory(tempDirSync("pardner-relay-")), /macOS/);
});

test(
  "the mark is written whole, synced, renamed, and the directory synced after it (1b-CR3)",
  DARWIN,
  async () => {
    const dir = tempDirSync("pardner-relay-");
    makeRelayDir(dir);
    const lock = track(lockDirectory(dir));
    const s = fakeSeam();
    assert.equal(failedClosed(dir), false);
    const done = writeMark(s.rounds, s.seam, dir, lock, 4);
    assert.equal(failedClosed(dir), false, "no mark under its name before its bytes are on disk");
    await done;
    assert.equal(failedClosed(dir), true);
    assert.equal(readFileSync(join(dir, "failed-closed")).length, 16);
    assert.equal(existsSync(join(dir, "tmp-failed-closed")), false);
    assert.equal(s.syncs.length, 2);
    assert.equal(s.syncs[1], lock, "the directory is synced after the mark");
    assert.throws(
      () => fstatSync(s.syncs[0] as number),
      /EBADF/,
      "the mark's descriptor is closed",
    );
  },
);

test("a mark whose write failed leaves no mark (1b-CR3)", DARWIN, async () => {
  const dir = tempDirSync("pardner-relay-");
  makeRelayDir(dir);
  const lock = track(lockDirectory(dir));
  const s = fakeSeam({
    write: () => {
      throw Object.assign(new Error("x"), { code: "ENOSPC", syscall: "write" });
    },
  });
  await assert.rejects(writeMark(s.rounds, s.seam, dir, lock, 4));
  assert.deepEqual(s.stops, [75]);
  assert.equal(failedClosed(dir), false);
});

test("a short mark write leaves no mark either (1b-CR3)", DARWIN, async () => {
  const dir = tempDirSync("pardner-relay-");
  makeRelayDir(dir);
  const lock = track(lockDirectory(dir));
  const s = fakeSeam({ write: () => 5 });
  await assert.rejects(writeMark(s.rounds, s.seam, dir, lock, 4));
  assert.equal(failedClosed(dir), false);
});

test("a second writeMark joins the first and writes nothing more (1b-CR4)", DARWIN, async () => {
  const dir = tempDirSync("pardner-relay-");
  makeRelayDir(dir);
  const lock = track(lockDirectory(dir));
  const s = fakeSeam();
  const first = writeMark(s.rounds, s.seam, dir, lock, 4);
  const second = writeMark(s.rounds, s.seam, dir, lock, 9);
  await Promise.all([first, second]);
  await writeMark(s.rounds, s.seam, dir, lock, 9);
  assert.deepEqual(s.stops, []);
  assert.equal(s.syncs.length, 2);
  assert.equal(readFileSync(join(dir, "failed-closed")).readBigUInt64BE(8), 4n);
});

test("a tmp file left by a killed start does not block the mark (1b-C5)", DARWIN, async () => {
  const dir = tempDirSync("pardner-relay-");
  makeRelayDir(dir);
  writeFileSync(join(dir, "tmp-failed-closed"), "left over, longer than the mark itself");
  const lock = track(lockDirectory(dir));
  const s = fakeSeam();
  await writeMark(s.rounds, s.seam, dir, lock, 4);
  assert.equal(readFileSync(join(dir, "failed-closed")).length, 16);
});

test("any file named failed-closed is the mark, whatever its length (1b-CR3)", () => {
  const dir = tempDirSync("pardner-relay-");
  writeFileSync(join(dir, "failed-closed"), "");
  assert.equal(failedClosed(dir), true);
});

test("writeMark resolves only after the directory's sync completes (N1)", DARWIN, async () => {
  const dir = tempDirSync("pardner-relay-");
  makeRelayDir(dir);
  const lock = track(lockDirectory(dir));
  let release = () => {};
  const s = fakeSeam({
    sync: (fd) => (fd === lock ? new Promise<void>((r) => (release = r)) : Promise.resolve()),
  });
  let settled = false;
  const done = writeMark(s.rounds, s.seam, dir, lock, 4).then(() => {
    settled = true;
  });
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(failedClosed(dir), true, "renamed once the data's round is done");
  assert.equal(settled, false, "it waits for the directory's sync");
  release();
  await done;
  assert.equal(settled, true);
});

test("the temporary mark name is a known file, not logged as unknown (N3)", () => {
  const dir = tempDirSync("pardner-relay-");
  makeRelayDir(dir);
  writeFileSync(join(dir, "tmp-failed-closed"), "half");
  const { log, lines } = fakeSeam();
  assert.equal(inspect(platform, dir, log).state, "whole");
  assert.deepEqual(lines, []);
});
