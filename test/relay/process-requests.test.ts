/**
 * Process-level tests 1 (its requests), 3, 4, 5 and 8 of design 9.2, and 9.3 over TLS:
 * `node src/relay/main.ts` in child processes, spoken to by a scripted device over real TLS on
 * 127.0.0.1. The Time Machine exclusion is not run (`tmutil` is replaced, as in the other process
 * tests). The restarts, the copies of the directory and the kills are the ones a person would make.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect as tcp } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { Frame } from "../../src/protocol/frames.ts";
import { relayKeyId } from "../../src/protocol/ids.ts";
import { checkHead, type RelayHead } from "../../src/protocol/proofs.ts";
import { failedClosed } from "../../src/relay/directory.ts";
import { dial, type Link } from "../support/scripted-device/link.ts";
import { tempDirSync } from "../support/temp.ts";
import { spawnNode } from "./child.ts";
import { DARWIN, init, MAIN, portOf, run, wait, watch } from "./process-support.ts";
import { platform } from "./support.ts";
import { addBody, fill, type Keyed, keyed, person } from "./world.ts";

type Alice = ReturnType<typeof person>;
type Head = Extract<Frame, { type: "head" }>;

const serve = (dir: string) => watch(run(["serve", "--dir", dir, "--listen", "127.0.0.1:0"]));
const stop = async (c: ReturnType<typeof serve>) => {
  c.child.kill("SIGTERM");
  assert.equal(await c.exit, 0, c.err());
};

/** `prove active` of `by` (alice's first device unless given) on `c`; the relay's answer. */
const prove = (c: Link, alice: Alice, by = alice.first) => c.proveActive(alice.id, by.id, by.sign);

/** A scripted device: one served connection and the log it keeps of alice's entries. */
async function device(
  port: number,
  key: Uint8Array,
  alice: Alice,
  opts: { secret?: Uint8Array; by?: Keyed; log?: { id: Uint8Array }[] } = {},
) {
  const c = await dial(platform, port, key);
  if (opts.secret) c.enrol(opts.secret, alice.genesis);
  assert.equal((await prove(c, alice, opts.by)).type, "served");
  const log = opts.log ?? [{ id: alice.id }];
  return {
    c,
    log,
    /** A `submit` of kind `kind`; the answer's code. */
    async submit(kind: 1 | 2 | 3 | 4, e: { signed: Uint8Array; sig: Uint8Array }) {
      const answer = await c.submit(kind, e);
      assert.equal(answer.type, "result");
      return (answer as Extract<Frame, { type: "result" }>).code;
    },
    /** Adds `other` to alice's log; the code. */
    async add(other: Keyed) {
      const e = alice.entry(log as never, addBody(alice, other));
      const code = await this.submit(1, e);
      if (code === 0) log.push({ id: platform.sha256(e.signed) });
      return code;
    },
    /** A `read` from `from` up to its head. */
    async read(from = 0) {
      const pass = await c.read(from);
      assert.equal(pass.type, "pass");
      const { items, head, problems } = pass as Extract<typeof pass, { type: "pass" }>;
      assert.deepEqual(problems, [], "the read broke a rule of 6.2");
      return { items, head };
    },
  };
}

const headOf = (key: Uint8Array, h: Head): RelayHead => ({
  relay: relayKeyId(platform, key),
  n: h.n,
  chain: h.chain,
});

test(
  "requests: a device submits and reads; after a restart the same head stands at the same length (9.2 #1)",
  DARWIN,
  async () => {
    const dir = join(tempDirSync("pardner-relay-"), "relay");
    const { key, secret } = await init(dir);
    const alice = person();
    let relay = serve(dir);
    try {
      const d = await device(await portOf(relay), key, alice, { secret });
      assert.equal(await d.add(keyed()), 0, "a submit is answered after its round");
      const first = await d.read();
      assert.equal(first.items.length, 2, "the genesis and the entry");
      assert.ok(checkHead(platform, key, headOf(key, first.head), first.head.sig));
      d.c.close();
      await stop(relay);
      relay = serve(dir);
      const again = await (await device(await portOf(relay), key, alice)).read();
      assert.equal(again.head.n, first.head.n);
      assert.deepEqual(again.head.chain, first.head.chain, "the same head at the same length");
      assert.deepEqual(again.items, first.items);
    } finally {
      await stop(relay);
    }
  },
);

test(
  "a head given back: the relay a copy was put back under fails closed; a genuine head and a head under another key change nothing (9.2 #3)",
  DARWIN,
  async () => {
    const dir = join(tempDirSync("pardner-relay-"), "relay");
    const copy = `${dir}-copy`;
    const { key, secret } = await init(dir);
    const alice = person();
    let relay = serve(dir);
    const d1 = await device(await portOf(relay), key, alice, { secret });
    const genuine = (await d1.read()).head;
    d1.c.close();
    await stop(relay);
    cpSync(dir, copy, { recursive: true });
    relay = serve(dir);
    const d2 = await device(await portOf(relay), key, alice);
    assert.equal(await d2.add(keyed()), 0);
    const ahead = (await d2.read()).head;
    d2.c.close();
    await stop(relay);
    rmSync(dir, { recursive: true });
    cpSync(copy, dir, { recursive: true });
    relay = serve(dir);
    try {
      const port = await portOf(relay);
      const give = async (head: Head, sig: Uint8Array) => {
        const d = await device(port, key, alice);
        return d.c.uploadDone(headOf(key, head), sig);
      };
      assert.deepEqual(await give(genuine, genuine.sig), { type: "result", request: 1, code: 0 });
      assert.deepEqual(await give(ahead, fill(9, 64)), { type: "result", request: 1, code: 1 });
      assert.equal(failedClosed(dir), false, "neither changed anything");
      assert.deepEqual(await give(ahead, ahead.sig), { type: "result", request: 1, code: 11 });
      assert.equal(failedClosed(dir), true, "the mark is on disk");
      const refused = await dial(platform, port, key);
      assert.deepEqual(await prove(refused, alice), { type: "refused", reason: 6 });
    } finally {
      await stop(relay);
    }
    relay = serve(dir);
    try {
      const c = await dial(platform, await portOf(relay), key);
      assert.deepEqual(
        await prove(c, alice),
        { type: "refused", reason: 6 },
        "after a start again too",
      );
    } finally {
      await stop(relay);
    }
  },
);

test(
  "a crash with a torn record: the relay killed after it answered, half a record appended, the start drops it and serves the records before under the same head (9.2 #4)",
  DARWIN,
  async () => {
    const dir = join(tempDirSync("pardner-relay-"), "relay");
    const { key, secret } = await init(dir);
    const alice = person();
    let relay = serve(dir);
    const d = await device(await portOf(relay), key, alice, { secret });
    assert.equal(await d.add(keyed()), 0);
    const before = await d.read();
    relay.child.kill("SIGKILL");
    await relay.exit;
    // A crash between `write` and its `fsync` cannot be produced on demand: the torn bytes are written by hand.
    appendFileSync(join(dir, "journal"), Buffer.from([0, 0, 1, 0, 1, 2, 3, 4, 5]));
    relay = serve(dir);
    try {
      const after = await (await device(await portOf(relay), key, alice)).read();
      assert.match(relay.err(), /start: 2 items, dropped 9 bytes/);
      assert.deepEqual(after.items, before.items);
      assert.deepEqual(after.head.chain, before.head.chain);
    } finally {
      await stop(relay);
    }
  },
);

test(
  "the directory swapped under a running relay: the next request gets no answer, the connection closes and the process exits 75; the same with a copy written over the journal; started again, a device that read further makes it fail closed (9.2 #5)",
  DARWIN,
  async () => {
    const dir = join(tempDirSync("pardner-relay-"), "relay");
    const { key, secret } = await init(dir);
    const alice = person();
    let relay = serve(dir);
    const d0 = await device(await portOf(relay), key, alice, { secret });
    d0.c.close();
    await stop(relay);
    const older = `${dir}-older`;
    const genesisOnly = readFileSync(join(dir, "journal"));
    cpSync(dir, older, { recursive: true });

    // A directory renamed away, an older copy at its path.
    relay = serve(dir);
    let port = await portOf(relay);
    const d1 = await device(port, key, alice);
    assert.equal(await d1.add(keyed()), 0);
    const further = (await d1.read()).head;
    renameSync(dir, `${dir}-away`);
    cpSync(older, dir, { recursive: true });
    d1.c.send({ type: "read", from: 0 });
    assert.equal(await Promise.race([relay.exit, wait(5000).then(() => "alive")]), 75, relay.err());
    assert.match(relay.err(), /rule 11/);
    assert.equal((await d1.c.next()).type, "closed");

    // The copy written over the journal in place, which an open descriptor sees.
    rmSync(dir, { recursive: true });
    cpSync(`${dir}-away`, dir, { recursive: true });
    relay = serve(dir);
    port = await portOf(relay);
    const d2 = await device(port, key, alice);
    writeFileSync(join(dir, "journal"), genesisOnly);
    d2.c.send({ type: "read", from: 0 });
    assert.equal(await Promise.race([relay.exit, wait(5000).then(() => "alive")]), 75, relay.err());

    // Started again on the older journal, a device that read further gives its head back.
    relay = serve(dir);
    try {
      const d3 = await device(await portOf(relay), key, alice);
      assert.deepEqual(await d3.c.uploadDone(headOf(key, further), further.sig), {
        type: "result",
        request: 1,
        code: 11,
      });
    } finally {
      await stop(relay);
      rmSync(`${dir}-away`, { recursive: true, force: true });
      rmSync(older, { recursive: true, force: true });
    }
  },
);

/** The resident memory of `pid` in KiB, as `ps` reports it. */
const rssOf = (pid: number | undefined) =>
  new Promise<number>((resolve) => {
    const ps = spawn("ps", ["-o", "rss=", "-p", String(pid)]);
    let out = "";
    ps.stdout.on("data", (d) => {
      out += d;
    });
    ps.on("close", () => resolve(Number(out.trim())));
  });

test(
  "a removed device's bound: its served connection is closed at the removal's round, its upload connections are counted with the unproven ones and closed at 10 s, and memory stays under the bound (4.6, 9.2 #8)",
  DARWIN,
  async () => {
    const dir = join(tempDirSync("pardner-relay-"), "relay");
    const { key, secret } = await init(dir);
    const alice = person();
    const bob = keyed();
    const relay = serve(dir);
    try {
      const port = await portOf(relay);
      const a = await device(port, key, alice, { secret });
      assert.equal(await a.add(bob), 0);
      const b = await device(port, key, alice, { by: bob });
      const old = (await b.read()).head;
      assert.equal(await a.submit(1, alice.remove(a.log as never, bob)), 0);
      assert.deepEqual(await b.c.next(), { type: "refused", reason: 1 });
      assert.equal((await b.c.next()).type, "closed");
      const before = await rssOf(relay.child.pid);
      const uploads = [];
      // One address holds 4 connections with no proof, and a proof of upload keeps its slot (4.4).
      for (let i = 0; i < 4; i++) {
        const c = await dial(platform, port, key);
        void c.proveUpload(bob, headOf(key, old), old.sig);
        uploads.push(new Promise<void>((resolve) => c.socket.once("close", () => resolve())));
      }
      const at = Date.now();
      await Promise.all(uploads);
      assert.ok(Date.now() - at < 12_000, "each is closed within 10 s of its hello");
      const grown = ((await rssOf(relay.child.pid)) - before) / 1024;
      assert.ok(grown < 100, `the relay's resident memory grew ${grown.toFixed(1)} MiB`);
    } finally {
      await stop(relay);
    }
  },
);

// Design 9.3 over TLS: the relay in its own process with a `sync` that fails once a flag file exists.
const FAILING = (dir: string, flag: string) => `
import { existsSync } from "node:fs";
import { run } from ${JSON.stringify(MAIN)};
import { nodeSeam } from ${JSON.stringify(new URL("../../src/relay/round.ts", import.meta.url).href)};
const seam = { ...nodeSeam, sync: async (fd) => {
  if (existsSync(${JSON.stringify(flag)})) throw Object.assign(new Error("EIO"), { code: "EIO", syscall: "fsync" });
  return nodeSeam.sync(fd);
} };
process.exitCode = await run(["serve", "--dir", ${JSON.stringify(dir)}, "--listen", "127.0.0.1:0"], { seam, exec: () => {} });
`;

test(
  "an fsync error over TLS: the submit whose round failed is never answered, every connection closes, the relay exits 75 and no item past the last good round was given; a relay with the real fsync serves what the directory holds (9.3)",
  DARWIN,
  async () => {
    const dir = join(tempDirSync("pardner-relay-"), "relay");
    const flag = join(tempDirSync("pardner-relay-"), "fail");
    const { key, secret } = await init(dir);
    const alice = person();
    let relay = watch(spawnNode(FAILING(dir, flag)));
    const d = await device(await portOf(relay), key, alice, { secret });
    assert.equal(await d.add(keyed()), 0);
    const good = await d.read();
    const other = await device(await portOf(relay), key, alice);
    await other.read();
    writeFileSync(flag, "");
    void d.c.submit(1, alice.entry(d.log as never, addBody(alice, keyed())));
    assert.equal(await relay.exit, 75, relay.err());
    assert.match(relay.err(), /fsync of journal \(code=EIO syscall=fsync\)/);
    assert.equal((await d.c.next(2000)).type, "closed");
    assert.equal((await other.c.next(2000)).type, "closed");
    rmSync(flag);
    relay = serve(dir);
    try {
      const after = await (await device(await portOf(relay), key, alice)).read();
      assert.deepEqual(
        after.items.slice(0, good.items.length),
        good.items,
        "the device reads on with no difference",
      );
    } finally {
      await stop(relay);
    }
  },
);

test(
  "section 7: the relay logs the counts of refused proofs and dropped connections, once a period and only when not zero, with no address",
  DARWIN,
  async () => {
    const dir = join(tempDirSync("pardner-relay-"), "relay");
    const { key } = await init(dir);
    const script = `
import { run } from ${JSON.stringify(MAIN)};
process.exitCode = await run(["serve", "--dir", ${JSON.stringify(dir)}, "--listen", "127.0.0.1:0"], { exec: () => {}, tallyMs: 300 });
`;
    const relay = watch(spawnNode(script));
    try {
      const port = await portOf(relay);
      await wait(700);
      assert.doesNotMatch(relay.err(), /limits:/, "nothing is logged while the counts are zero");
      // One address holds 4 connections with no proof: the fifth is cut before TLS (4.4).
      const held = [];
      for (let i = 0; i < 4; i++) held.push(await dial(platform, port, key));
      const fifth = tcp({ host: "127.0.0.1", port });
      fifth.on("error", () => {});
      await new Promise((resolve) => fifth.once("close", resolve));
      for (let i = 0; i < 40 && !/limits:/.test(relay.err()); i++) await wait(50);
      assert.match(relay.err(), /limits: 0 proofs refused, 1 connections dropped/);
      for (const c of held) c.close();
      assert.doesNotMatch(relay.err(), /127\.0\.0\.1:\d+/);
    } finally {
      await stop(relay);
    }
  },
);
