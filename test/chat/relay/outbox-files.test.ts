/**
 * What the bot sends with a file (design G 3.5) against a real relay in a child process: one seal and
 * one upload, the blob files and the order of their writes, and the puts before a submit.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket, connect as tcp } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { BlobFiles, type BlobOps } from "../../../src/chat/relay/blob-files.ts";
import { botPlatform, loadPairing, pair } from "../../../src/chat/relay/pairing.ts";
import { identityOf, Store, storePath } from "../../../src/chat/relay/store.ts";
import { texts } from "../../../src/core/port.ts";
import { DARWIN } from "../../relay/process-support.ts";
import { tempDirSync } from "../../support/temp.ts";
import { botOn, hex, rig } from "./relay-rig.ts";

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) % 251);
const draft = (content = "{}", name = "notes.txt", n = 100) => ({
  kind: 1,
  content,
  files: [{ bytes: bytes(n), type: "text/plain", name }],
});
const blobsOf = (dir: string) => {
  const folder = join(dir, "blobs");
  return existsSync(folder) ? readdirSync(folder) : [];
};
const idOf = (item: { files: { id: Uint8Array }[] } | undefined) =>
  hex(item?.files[0]?.id as Uint8Array);
/** A put that says accepted and sends nothing: the relay never gets the blob. */
const pretend = () => async () => 0;

test(
  "a file is sealed once, put once, kept as a blob file and out of store.json, and goes when its message is read back",
  DARWIN,
  async () => {
    const r = await rig();
    const puts: string[] = [];
    const b = botOn(r, {
      put: (real) => async (id, data) => {
        puts.push(hex(id));
        return real(id, data);
      },
    });
    try {
      b.connection.start();
      await b.rested();
      assert.equal(await b.outbox.queueFile(r.channel, draft()), "queued");
      const [item] = b.queued();
      assert.ok(item);
      assert.equal(blobsOf(r.dir).length, 1);
      const stored = readFileSync(storePath(r.dir), "utf8");
      assert.ok(!stored.includes('"put"'), "the put flag never reaches store.json");
      assert.ok(!stored.includes('"blob"'), "no blob bytes in store.json");
      assert.ok(stored.includes('"name":"notes.txt"'));
      await b.until(() => b.queued().length === 0);
      assert.deepEqual(puts, [idOf(item)], "put once, not again before the submit");
      assert.deepEqual(blobsOf(r.dir), [], "the blob file goes when its message is read back");
      assert.equal((await r.held()).messages.length, 1);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "the blob file is written, renamed and its folder synced before the store write that names the item",
  DARWIN,
  async () => {
    const r = await rig();
    const steps: string[] = [];
    const ops: BlobOps = {
      write: (path, data) => {
        writeFileSync(path, data);
        steps.push("write");
      },
      rename: (from, to) => {
        renameSync(from, to);
        steps.push("rename");
      },
      syncDirectory: () => steps.push("sync directory"),
    };
    mkdirSync(join(r.dir, "blobs"), { recursive: true });
    const b = botOn(r, { put: pretend, blobs: new BlobFiles(join(r.dir, "blobs"), ops) });
    const change = b.store.change.bind(b.store);
    b.store.change = (edit) => {
      steps.push("store");
      return change(edit);
    };
    try {
      assert.equal(await b.outbox.queueFile(r.channel, draft()), "queued");
      assert.deepEqual(steps.slice(0, 4), ["write", "rename", "sync directory", "store"]);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "an item loaded at a start is put before it is submitted, from its blob file",
  DARWIN,
  async () => {
    const r = await rig();
    const first = botOn(r, { put: pretend });
    assert.equal(await first.outbox.queueFile(r.channel, draft("{}", "a.txt", 3000)), "queued");
    await first.stop();
    const calls: Uint8Array[] = [];
    const b = botOn(r, {
      put: (real) => async (id, data) => {
        calls.push(data);
        return real(id, data);
      },
    });
    try {
      assert.equal(b.queued().length, 1);
      b.connection.start();
      await b.until(() => b.queued().length === 0);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.length, 3000 + 16, "the sealed bytes, read from the blob file");
      assert.equal(
        (await r.held()).messages.length,
        1,
        "the relay held the blob the message names",
      );
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test("a submit answered missing puts the blob again, then submits", DARWIN, async () => {
  const r = await rig();
  let calls = 0;
  const b = botOn(r, {
    // The first put is pretended: the relay lacks the blob and answers 7 to the message.
    put: (real) => async (id, data) => (++calls === 1 ? 0 : real(id, data)),
  });
  try {
    b.connection.start();
    await b.rested();
    assert.equal(await b.outbox.queueFile(r.channel, draft()), "queued");
    await b.until(() => b.queued().length === 0);
    assert.equal(calls, 2);
    assert.equal((await r.held()).messages.length, 1);
  } finally {
    await b.stop();
    await r.stop();
  }
});

test(
  "a blob lost at a restart becomes FILE_LOST under the message's name, a file row a tell, and an unnamed blob file goes",
  DARWIN,
  async () => {
    const r = await rig();
    const first = botOn(r, { put: pretend });
    const row = JSON.stringify({ thread: "t", say: "file", markdown: "" });
    const answer = JSON.stringify({ thread: "t", markdown: "" });
    assert.equal(await first.outbox.queueFile(r.channel, draft(row, "a.txt")), "queued");
    assert.equal(await first.outbox.queueFile(r.channel, draft(answer, "b.txt")), "queued");
    assert.equal(await first.outbox.queueFile(r.channel, draft("{}", "kept.txt")), "queued");
    const before = first.queued();
    await first.stop();
    const files = new BlobFiles(join(r.dir, "blobs"));
    for (const i of before.slice(0, 2)) files.remove(i.files[0]?.id as Uint8Array);
    writeFileSync(join(r.dir, "blobs", "ab".repeat(32)), "x");
    const b = botOn(r, { put: pretend });
    try {
      const now = b.queued();
      assert.deepEqual(
        now.map((i) => hex(i.name)),
        before.map((i) => hex(i.name)),
        "each message keeps its name",
      );
      assert.deepEqual(now[0]?.files, []);
      assert.deepEqual(JSON.parse(now[0]?.content as string), {
        thread: "t",
        say: "tell",
        markdown: texts.FILE_LOST.replace("{name}", "a.txt"),
      });
      assert.deepEqual(JSON.parse(now[1]?.content as string), {
        thread: "t",
        markdown: texts.FILE_LOST.replace("{name}", "b.txt"),
      });
      assert.equal(now[2]?.files.length, 1, "a message whose blob file is there keeps its file");
      assert.deepEqual(blobsOf(r.dir), [idOf(before[2])]);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "a put the relay refuses or finds too large fails the send and keeps no blob file",
  DARWIN,
  async () => {
    const r = await rig();
    const answers = [8, 1];
    const b = botOn(r, { put: () => async () => answers.shift() });
    try {
      assert.equal(await b.outbox.queueFile(r.channel, draft()), "too-large");
      assert.equal(await b.outbox.queueFile(r.channel, draft()), "refused");
      assert.deepEqual(blobsOf(r.dir), []);
      assert.equal(b.queued().length, 0);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "a chunk written out while a persist is held is queued behind it, never thrown",
  DARWIN,
  async () => {
    const r = await rig();
    // A hop that can stop reading the bot: the write of a chunk is then reported late, as a slow uplink does.
    const clients: Socket[] = [];
    const hop = createServer((client) => {
      clients.push(client);
      const up = tcp(r.port, "127.0.0.1");
      for (const sock of [client, up]) sock.on("error", () => {});
      client.on("data", (d) => up.write(d));
      up.on("data", (d) => client.write(d));
      client.on("close", () => up.destroy());
      up.on("close", () => client.destroy());
    });
    await new Promise<void>((resolve) => hop.listen(0, "127.0.0.1", () => resolve()));
    const b = botOn(r, { port: (hop.address() as { port: number }).port });
    let held = 0; // the persists the store is holding while the hop is stopped
    const change = b.store.change.bind(b.store);
    b.store.change = async (edit) => {
      if (clients.some((c) => c.isPaused())) {
        held += 1;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return change(edit);
    };
    try {
      b.connection.start();
      await b.rested();
      for (const c of clients) c.pause();
      const sending = b.outbox.queueFile(r.channel, draft("{}", "big.bin", 6_000_000));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await r.send({ kind: 1 }, { text: "a push the bot reads while a chunk is unwritten" });
      await b.until(() => held > 0);
      for (const c of clients) c.resume(); // the chunk is written out while the persist is held
      assert.equal(await sending, "queued");
      assert.ok(!b.lines.some((l) => l.includes("connection error")), b.lines.join(" | "));
    } finally {
      await b.stop();
      hop.close();
      await r.stop();
    }
  },
);

test(
  "a loaded item whose re-put is refused or too large goes without its file, saying so",
  DARWIN,
  async () => {
    const r = await rig();
    const first = botOn(r, { put: pretend });
    const row = JSON.stringify({ thread: "t", say: "file", markdown: "" });
    assert.equal(await first.outbox.queueFile(r.channel, draft(row, "a.txt")), "queued");
    await first.stop();
    const b = botOn(r, { put: () => async () => 8 });
    try {
      b.connection.start();
      await b.until(() => b.queued().length === 0);
      const [message] = (await r.held()).messages;
      assert.deepEqual(r.body(message as { signed: Uint8Array }), {
        thread: "t",
        say: "tell",
        markdown: texts.SHARE_REFUSED.replace("{path}", "a.txt").replace(
          "{error}",
          "it is too large for the relay",
        ),
      });
      assert.deepEqual(blobsOf(r.dir), []);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test("a second missing for the same item waits for the next rest", DARWIN, async () => {
  const r = await rig();
  let puts = 0;
  const b = botOn(r, {
    put: (real) => async (id, data) => (puts++, real(id, data)),
    submit: (real) => async (kind, signed, sig) =>
      kind === 4 && b.queued().some((i) => i.files.length) ? 7 : real(kind, signed, sig),
  });
  try {
    b.connection.start();
    await b.rested();
    assert.equal(await b.outbox.queueFile(r.channel, draft()), "queued");
    await b.until(() => puts === 2);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(puts, 2, "one put again, then it waits");
    b.outbox.take({ do: "rest", first: false });
    await b.until(() => puts === 3);
  } finally {
    await b.stop();
    await r.stop();
  }
});

test("an answer to a put of an item read back meanwhile is not acted on", DARWIN, async () => {
  const r = await rig();
  const first = botOn(r, { put: pretend });
  assert.equal(await first.outbox.queueFile(r.channel, draft()), "queued");
  const [item] = first.queued();
  await first.stop();
  let answered = false;
  const b = botOn(r, {
    put: () => async () => {
      b.store.change((s) => s.outboxes.set(hex(r.channel), [])); // read back while the blob is put
      answered = true;
      return 1;
    },
  });
  try {
    b.connection.start();
    await b.until(() => answered);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(b.outbox.holds([item?.name as Uint8Array]), true, "not dropped: it landed");
    assert.ok(!b.lines.some((l) => l.includes("did not take a file")));
  } finally {
    await b.stop();
    await r.stop();
  }
});

test("an append that fails removes the blob files and answers not-queued", DARWIN, async () => {
  const r = await rig();
  const b = botOn(r, { put: pretend });
  b.store.change = () => Promise.reject(new Error("disk full"));
  try {
    assert.equal(await b.outbox.queueFile(r.channel, draft()), "not-queued");
    assert.deepEqual(blobsOf(r.dir), []);
    assert.ok(b.lines.some((l) => l.includes("disk full")));
  } finally {
    await b.stop();
    await r.stop();
  }
});

test(
  "an append whose disk write fails but whose change is in memory is queued, with its blob file kept",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r, { put: pretend });
    mkdirSync(join(r.dir, "blobs"), { recursive: true });
    chmodSync(r.dir, 0o500); // the store's own write fails; blobs/ stays writable
    let sent: string;
    try {
      sent = await b.outbox.queueFile(r.channel, draft());
    } finally {
      chmodSync(r.dir, 0o700);
    }
    try {
      assert.equal(sent, "queued", "the item is in memory and will be sent");
      assert.equal(b.queued().length, 1);
      assert.equal(blobsOf(r.dir).length, 1, "its blob file stays");
      await b.store.change(() => {}); // the next good write stores what memory holds
      await b.stop();
      const again = botOn(r, { put: pretend });
      assert.equal(again.queued()[0]?.files.length, 1, "no FILE_LOST after a restart");
      await again.stop();
    } finally {
      await r.stop();
    }
  },
);

test(
  "a message with no file whose disk write fails but whose change is in memory is queued",
  DARWIN,
  async () => {
    const r = await rig();
    const b = botOn(r, { put: pretend });
    chmodSync(r.dir, 0o500); // the store's own write fails
    let queued: boolean;
    try {
      queued = await b.outbox.queue(r.channel, { kind: 1, content: "{}" });
    } finally {
      chmodSync(r.dir, 0o700);
    }
    try {
      assert.equal(queued, true, "the item is in memory and will be sent");
      assert.equal(b.queued().length, 1);
      assert.ok(
        b.lines.some((l) => l.startsWith("relay: the store did not write:")),
        "and the failure is logged",
      );
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test("a sweep goes on past an entry it does not take", async () => {
  const dir = tempDirSync("pardner-blobs-");
  mkdirSync(join(dir, "aa"));
  writeFileSync(join(dir, "bb".repeat(32)), "x");
  new BlobFiles(dir).sweep(new Set());
  assert.deepEqual(readdirSync(dir), ["aa"]);
});

test("the store refuses a file whose key or id is not 32 bytes, or whose size is negative", async () => {
  const dir = tempDirSync("pardner-store-");
  await pair(dir, new Uint8Array(32).fill(3), new Uint8Array(65).fill(7), "alice");
  const pairing = loadPairing(dir);
  const store = Store.open(dir, identityOf(botPlatform(dir), pairing.device, pairing.relay));
  const file = (over: object) => ({
    key: new Uint8Array(32),
    id: new Uint8Array(32),
    blob: new Uint8Array(0),
    size: 1,
    type: "t",
    name: "n",
    ...over,
  });
  const add = (f: object) =>
    store.change((s) =>
      s.outboxes.set("c", [
        { name: new Uint8Array(16), kind: 1, content: "{}", files: [f as never] },
      ]),
    );
  await add(file({}));
  for (const bad of [{ key: new Uint8Array(3) }, { id: new Uint8Array(3) }, { size: -1 }])
    await assert.rejects(add(file(bad)));
});
