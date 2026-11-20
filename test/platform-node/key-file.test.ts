import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import { tempDirSync } from "../support/temp.ts";

const message = new Uint8Array([1, 2, 3]);

function folder(): { dir: string; keyFile: string } {
  const dir = tempDirSync("keyfile-");
  return { dir, keyFile: join(dir, "keys.json") };
}

test("a key made with a key file is on disk before makeKeyPair returns, readable by its user only", () => {
  const { keyFile } = folder();
  const platform = createNodePlatform(undefined, { keyFile });
  const made = platform.makeKeyPair("bot.s", "sign");
  assert.ok(made.ok);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const text = readFileSync(keyFile, "utf8");
  assert.ok(text.length > 0);
});

test("a later platform loads the keys by name and signs as the first did", () => {
  const { keyFile } = folder();
  const first = createNodePlatform(undefined, { keyFile });
  const signing = first.makeKeyPair("bot.s", "sign");
  const receiving = first.makeKeyPair("bot.r", "receive");
  assert.ok(signing.ok && receiving.ok);
  const second = createNodePlatform(undefined, { keyFile });
  const pk = second.publicKey("bot.s");
  assert.ok(pk.ok && Buffer.compare(pk.value, signing.value) === 0);
  const signed = second.sign("bot.s", message);
  assert.ok(signed.ok && second.verify(signing.value, message, signed.value));
  const other = second.publicKey("bot.r");
  assert.ok(other.ok && Buffer.compare(other.value, receiving.value) === 0);
  // The name is taken by the loaded key.
  assert.deepEqual(second.makeKeyPair("bot.s", "sign"), { ok: false, error: "key-exists" });
});

test("deleteKey removes the key from the file, and no temporary file is left", () => {
  const { dir, keyFile } = folder();
  const platform = createNodePlatform(undefined, { keyFile });
  platform.makeKeyPair("bot.s", "sign");
  platform.deleteKey("bot.s");
  assert.deepEqual(createNodePlatform(undefined, { keyFile }).publicKey("bot.s"), {
    ok: false,
    error: "no-such-key",
  });
  assert.deepEqual(readdirSync(dir), ["keys.json"]);
});

test("a key file that another user could read, or that does not parse, is refused", () => {
  const { keyFile } = folder();
  createNodePlatform(undefined, { keyFile }).makeKeyPair("bot.s", "sign");
  chmodSync(keyFile, 0o644);
  assert.throws(() => createNodePlatform(undefined, { keyFile }), /readable by other users/);
  chmodSync(keyFile, 0o600);
  writeFileSync(keyFile, "not json", { mode: 0o600 });
  assert.throws(() => createNodePlatform(undefined, { keyFile }), /key file/);
});

test("the platform with no key file keeps keys in memory only", () => {
  const { dir } = folder();
  createNodePlatform().makeKeyPair("bot.s", "sign");
  assert.deepEqual(readdirSync(dir), []);
});

test("a recovery key held by enterRecovery never reaches the key file", () => {
  const { keyFile } = folder();
  const secret = new Uint8Array(32).fill(5);
  const platform = createNodePlatform(
    { show: () => true, enter: () => Uint8Array.from(secret) },
    { keyFile },
  );
  const info = (text: string) => new TextEncoder().encode(text);
  assert.ok(platform.enterRecovery("recovery", info("a"), info("b")).ok);
  platform.makeKeyPair("device.s", "sign");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(keyFile, "utf8"))), ["device.s"]);
  platform.deleteKey("device.s");
  assert.deepEqual(JSON.parse(readFileSync(keyFile, "utf8")), {});
});

test("a write that fails is a value from makeKeyPair, and deleteKey keeps the key it could not remove", () => {
  const { dir, keyFile } = folder();
  const platform = createNodePlatform(undefined, { keyFile });
  assert.ok(platform.makeKeyPair("bot.s", "sign").ok);
  // A directory where the temporary file goes makes every write fail.
  mkdirSync(`${keyFile}.tmp`);
  assert.deepEqual(platform.makeKeyPair("bot.r", "receive"), { ok: false, error: "io-failed" });
  assert.deepEqual(platform.importKey("x", "sign", new Uint8Array(32).fill(1)), {
    ok: false,
    error: "io-failed",
  });
  assert.ok(platform.publicKey("bot.r").ok === false);
  assert.deepEqual(platform.deleteKey("bot.s"), { ok: false, error: "io-failed" });
  assert.ok(platform.publicKey("bot.s").ok);
  assert.ok(Object.keys(JSON.parse(readFileSync(keyFile, "utf8"))).includes("bot.s"));
  assert.ok(dir.length > 0);
});

test("erase zeroes the held keys and leaves the file", () => {
  const { keyFile } = folder();
  const platform = createNodePlatform(undefined, { keyFile });
  platform.makeKeyPair("bot.s", "sign");
  platform.erase();
  assert.equal(platform.publicKey("bot.s").ok, false);
  assert.ok(createNodePlatform(undefined, { keyFile }).publicKey("bot.s").ok);
});

test("a platform used after erase() refuses to make keys and leaves the file as it was", () => {
  const { keyFile } = folder();
  const platform = createNodePlatform(undefined, { keyFile });
  platform.makeKeyPair("bot.s", "sign");
  platform.erase();
  assert.equal(platform.makeKeyPair("other", "sign").ok, false);
  assert.equal(platform.importKey("x", "sign", new Uint8Array(32).fill(1)).ok, false);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(keyFile, "utf8"))), ["bot.s"]);
});

test("a key file with a key that cannot be read is refused whole", () => {
  const { keyFile } = folder();
  const good = "11".repeat(32);
  for (const bad of [
    { use: "sign", sk: "01" },
    { use: "other", sk: good },
    { use: "sign", sk: "00".repeat(32) },
    null,
  ]) {
    writeFileSync(keyFile, JSON.stringify({ a: { use: "sign", sk: good }, b: bad }), {
      mode: 0o600,
    });
    assert.throws(() => createNodePlatform(undefined, { keyFile }), /cannot be read/);
  }
});

// A write cut short (a full disk, a size limit) must fail and leave the old file: RLIMIT_FSIZE makes write(2) return fewer bytes than asked.
test("writeFileAtomic fails on a write cut short and leaves the old file", () => {
  const { dir } = folder();
  const target = join(dir, "kept.json");
  const code = `
    const { writeFileAtomic } = await import(${JSON.stringify(new URL("../../src/platform-node/key-file.ts", import.meta.url).href)});
    writeFileAtomic(${JSON.stringify(target)}, "old");
    try { writeFileAtomic(${JSON.stringify(target)}, "y".repeat(200000)); console.log("resolved"); }
    catch { console.log("failed"); }`;
  const out = spawnSync(
    "sh",
    ["-c", `ulimit -f 100; exec "$0" --input-type=module -e "$1"`, process.execPath, code],
    {
      encoding: "utf8",
    },
  );
  assert.equal(out.stdout.trim(), "failed", out.stderr);
  assert.equal(readFileSync(target, "utf8"), "old");
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.endsWith(".tmp")),
    [],
  );
});
