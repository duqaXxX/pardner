import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Journal } from "../../src/relay/journal.ts";
import { tempDirSync } from "../support/temp.ts";
import { fakeSeam, makeJournalDir, openAppending, platform } from "./support.ts";

const src = (name: string) => new URL(`../../src/relay/${name}`, import.meta.url).href;

// Design 9.3, at the storage level: the process exits with 75 on an `fsync` error, and a second
// process on the same directory reads what the files hold. The `sync` seam fails on its second call
// (the first is the start's), the real `stop` exits.
const CHILD = (dir: string, relayHex: string) => `
import { openSync } from "node:fs";
import { createNodePlatform } from ${JSON.stringify(new URL("../../src/platform-node/platform.ts", import.meta.url).href)};
import { Journal } from ${JSON.stringify(src("journal.ts"))};
import { createLog } from ${JSON.stringify(src("log.ts"))};
import { nodeSeam, Rounds } from ${JSON.stringify(src("round.ts"))};
let calls = 0;
const seam = { ...nodeSeam, sync: async (fd) => {
  if (++calls === 2) throw Object.assign(new Error("EIO"), { code: "EIO", syscall: "fsync" });
  return nodeSeam.sync(fd);
} };
const rounds = new Rounds(seam, createLog());
const fd = openSync(${JSON.stringify(join(dir, "journal"))}, "a+");
const { journal } = await Journal.open(createNodePlatform(), rounds, fd, Buffer.from(${JSON.stringify(relayHex)}, "hex"));
const item = (i) => ({ kind: 1, signed: Buffer.from("signed " + i), sig: new Uint8Array(64).fill(i) });
journal.append(item(1));
await new Promise((resolve) => setTimeout(resolve, 200));
console.log("not reached");
`;

test("an fsync error exits 75 with nothing answered, and a new process reads the directory", async () => {
  const dir = tempDirSync("pardner-relay-");
  const relay = makeJournalDir(dir);
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", CHILD(dir, Buffer.from(relay).toString("hex"))],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 75);
  assert.doesNotMatch(run.stdout, /not reached/);
  assert.match(run.stderr, /EIO/);
  assert.equal(run.stderr.includes(dir), false);
  // The record was written and not synced: a start reads what the file holds and serves it.
  const s = fakeSeam();
  const fd = openAppending(join(dir, "journal"));
  const { journal, dropped } = await Journal.open(platform, s.rounds, fd, relay);
  assert.equal(dropped, 0);
  assert.equal(journal.placed.length, 1);
  closeSync(fd);
});
