import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { relayKeyId } from "../../src/protocol/ids.ts";
import { inspect, relayPublicKey } from "../../src/relay/directory.ts";
import { ExclusionFailed, type Exec } from "../../src/relay/exclusion.ts";
import { InitFailed, init } from "../../src/relay/init.ts";
import { fileHeader } from "../../src/relay/journal.ts";
import { tempDirSync } from "../support/temp.ts";
import { fakeSeam, platform } from "./support.ts";

const noExec: Exec = () => {};
const POSIX = { skip: process.platform === "win32" ? "POSIX file modes" : false };

async function run(
  dir: string,
  over: Partial<{ exec: Exec; out: (t: string) => void; sync: (p: string) => void }> = {},
) {
  const printed: string[] = [];
  await init(dir, {
    exec: noExec,
    out: (t) => printed.push(t),
    sync: () => {},
    os: "darwin",
    ...over,
  });
  return printed.join("");
}

test("init makes a whole directory and prints the public key and the secret once", async () => {
  const dir = join(tempDirSync("pardner-relay-"), "relay");
  const text = await run(dir);
  const { log } = fakeSeam();
  assert.equal(inspect(platform, dir, log).state, "whole");
  const pem = readFileSync(join(dir, "key.pem"));
  const publicHex = Buffer.from(relayPublicKey(pem)).toString("hex");
  const secret = /([0-9a-f]{64})\b/.exec(text.replace(publicHex, ""))?.[1] as string;
  assert.ok(text.includes(publicHex), "the public key, 65 bytes in hex");
  assert.equal(publicHex.length, 130);
  assert.ok(secret, "the secret, 32 bytes in hex");
  assert.deepEqual(
    Array.from(readFileSync(join(dir, "enrol"))),
    Array.from(createHash("sha256").update(Buffer.from(secret, "hex")).digest()),
  );
  const relay = relayKeyId(platform, relayPublicKey(pem));
  assert.deepEqual(
    Array.from(readFileSync(join(dir, "journal"))),
    Array.from(fileHeader("journal", relay)),
  );
  assert.deepEqual(
    Array.from(readFileSync(join(dir, "seals"))),
    Array.from(fileHeader("seals", relay)),
  );
  assert.ok(statSync(join(dir, "blobs")).isDirectory());
  assert.equal(readdirSync(dir).includes("failed-closed"), false);
  assert.deepEqual(
    readdirSync(join(dir, "..")).filter((n) => n.includes(".init-")),
    [],
  );
});

test("the directory is private to its owner, and so is the key", POSIX, async () => {
  const dir = join(tempDirSync("pardner-relay-"), "relay");
  await run(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "key.pem")).mode & 0o777, 0o600);
});

test("two inits print two different secrets and keys", async () => {
  const root = tempDirSync("pardner-relay-");
  assert.notEqual(await run(join(root, "a")), await run(join(root, "b")));
});

test("the files, the folders and then the parent are synced, in that order (2-C5)", async () => {
  const root = tempDirSync("pardner-relay-");
  const dir = join(root, "relay");
  const synced: string[] = [];
  await run(dir, { sync: (p) => void synced.push(p) });
  const rel = synced.map((p) => (p.startsWith(root) ? p.slice(root.length + 1) : p));
  const names = rel.map((p) => p.replace(/^relay\.init-[0-9a-f]{16}/, "TMP"));
  assert.deepEqual(names.slice(0, 4).sort(), [
    "TMP/enrol",
    "TMP/journal",
    "TMP/key.pem",
    "TMP/seals",
  ]);
  assert.deepEqual(
    rel.slice(4).map((p) => p.replace(/^relay\.init-[0-9a-f]{16}/, "TMP")),
    ["TMP/blobs", "TMP", ""],
  );
});

test("the exclusion is set on the temporary folder, before the rename", async () => {
  const root = tempDirSync("pardner-relay-");
  const dir = join(root, "relay");
  const seen: string[] = [];
  const exec: Exec = (_file, args) => {
    seen.push(args[1] as string);
    assert.ok(existsSync(args[1] as string));
  };
  await run(dir, { exec });
  assert.equal(seen.length, 1);
  assert.match(seen[0] as string, /\.init-[0-9a-f]{16}$/);
  assert.equal(existsSync(seen[0] as string), false, "it moved to its name");
});

test("a failed exclusion fails init and leaves neither the directory nor a sibling", async () => {
  const root = tempDirSync("pardner-relay-");
  const dir = join(root, "relay");
  const exec: Exec = async () => {
    throw new Error("tmutil failed");
  };
  const out: string[] = [];
  await assert.rejects(run(dir, { exec, out: (t) => out.push(t) }), ExclusionFailed);
  assert.equal(existsSync(dir), false);
  assert.deepEqual(readdirSync(root), []);
  assert.deepEqual(out, [], "nothing was printed");
});

test("the values are printed before the rename, when the directory does not exist yet", async () => {
  const root = tempDirSync("pardner-relay-");
  const dir = join(root, "relay");
  let atPrint: string[] = [];
  let existedAtPrint = true;
  let first = true;
  await run(dir, {
    out: () => {
      if (!first) return;
      first = false;
      existedAtPrint = existsSync(dir);
      atPrint = readdirSync(root);
    },
  });
  assert.equal(existedAtPrint, false);
  assert.equal(atPrint.length, 1);
  assert.match(atPrint[0] as string, /^relay\.init-/);
});

test("a print that throws leaves no temporary folder with the key in it (2-C4)", async () => {
  const root = tempDirSync("pardner-relay-");
  const dir = join(root, "relay");
  await assert.rejects(
    run(dir, {
      out: () => {
        throw Object.assign(new Error("EPIPE"), { code: "EPIPE" });
      },
    }),
    /EPIPE/,
  );
  assert.deepEqual(readdirSync(root), []);
});

test("a rename that fails says the values are void and leaves no sibling (M3)", async () => {
  const root = tempDirSync("pardner-relay-");
  const dir = join(root, "relay");
  mkdirSync(dir);
  let first = true;
  await assert.rejects(
    run(dir, {
      out: () => {
        if (!first) return;
        first = false;
        writeFileSync(join(dir, "appeared"), "a file put between the print and the rename");
      },
    }),
    (error) => error instanceof InitFailed && /void/.test(error.message),
  );
  assert.deepEqual(readdirSync(root), ["relay"]);
  assert.deepEqual(readdirSync(dir), ["appeared"]);
});

test("init refuses a directory that is not empty, and changes nothing", async () => {
  const root = tempDirSync("pardner-relay-");
  for (const name of ["notes.txt", "key.pem"]) {
    const dir = join(root, name.replace(".", "-"));
    mkdirSync(dir);
    writeFileSync(join(dir, name), "x");
    const out: string[] = [];
    await assert.rejects(run(dir, { out: (t) => out.push(t) }), InitFailed);
    assert.deepEqual(readdirSync(dir), [name]);
    assert.deepEqual(out, []);
  }
  const file = join(root, "afile");
  writeFileSync(file, "x");
  await assert.rejects(run(file), InitFailed);
});

test("init takes an empty directory, and one that holds only what Finder writes", async () => {
  const root = tempDirSync("pardner-relay-");
  const empty = join(root, "empty");
  mkdirSync(empty);
  await run(empty);
  assert.ok(existsSync(join(empty, "key.pem")));
  const finder = join(root, "finder");
  mkdirSync(finder);
  writeFileSync(join(finder, ".DS_Store"), "x");
  await run(finder);
  assert.ok(existsSync(join(finder, "key.pem")));
  assert.equal(existsSync(join(finder, ".DS_Store")), false);
});

test("any other hidden entry makes the directory not empty, and is never deleted (2-C1)", async () => {
  const root = tempDirSync("pardner-relay-");
  for (const hidden of [".git", ".secrets", ".Trashes"]) {
    const dir = join(root, hidden.slice(1));
    mkdirSync(join(dir, hidden), { recursive: true });
    writeFileSync(join(dir, hidden, "precious"), "x");
    await assert.rejects(run(dir), InitFailed);
    assert.ok(existsSync(join(dir, hidden, "precious")), hidden);
  }
  const mixed = join(root, "mixed");
  mkdirSync(mixed);
  writeFileSync(join(mixed, ".DS_Store"), "x");
  writeFileSync(join(mixed, ".env"), "x");
  await assert.rejects(run(mixed), InitFailed);
  assert.ok(existsSync(join(mixed, ".DS_Store")), "nothing is removed from a directory refused");
});

test("the next init removes the siblings a killed one left, and only those (2-C2)", async () => {
  const root = tempDirSync("pardner-relay-");
  const dir = join(root, "relay");
  const stale = `${dir}.init-0123456789abcdef`;
  mkdirSync(stale);
  writeFileSync(join(stale, "key.pem"), "old");
  const kept = [
    "relayother.init-0123456789abcdef",
    "relay.init-notmine",
    "relay.init-0123456789abcde",
    "relay.init-0123456789abcdef0",
    "relay.init-0123456789abcdeg",
    "relay.init-",
  ];
  for (const name of kept) mkdirSync(join(root, name));
  await run(dir);
  assert.equal(existsSync(stale), false);
  for (const name of kept) assert.ok(existsSync(join(root, name)), name);
});

test("a failure after the rename says the relay is in place and the values hold (2-R2-1)", async () => {
  const root = tempDirSync("pardner-relay-");
  const dir = join(root, "relay");
  const printed: string[] = [];
  await assert.rejects(
    init(dir, {
      exec: noExec,
      os: "darwin",
      out: (t) => printed.push(t),
      sync: (p) => {
        if (p === root) throw Object.assign(new Error("EIO"), { code: "EIO", syscall: "fsync" });
      },
    }),
    (error) =>
      error instanceof InitFailed && !/void/.test(error.message) && /in place/.test(error.message),
  );
  const { log } = fakeSeam();
  assert.equal(
    inspect(platform, dir, log).state,
    "whole",
    "the directory is there with the values",
  );
  assert.match(printed.join(""), /enrolment secret/);
  assert.equal(printed.join("").includes("the relay is made"), false);
});

test("a failure of the rmdir still says the values are void (2-R2-1)", async () => {
  const root = tempDirSync("pardner-relay-");
  const dir = join(root, "relay");
  mkdirSync(dir);
  writeFileSync(join(dir, ".DS_Store"), "x");
  let first = true;
  await assert.rejects(
    run(dir, {
      out: () => {
        if (!first) return;
        first = false;
        mkdirSync(join(dir, "appeared"));
      },
    }),
    (error) => error instanceof InitFailed && /void/.test(error.message),
  );
});
