import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { relayChat } from "../../../src/chat/relay/module.ts";
import { loadPairing, pair } from "../../../src/chat/relay/pairing.ts";
import { identityOf, resetStore, Store } from "../../../src/chat/relay/store.ts";
import { DEFAULT_INSTANCE } from "../../../src/core/instance.ts";
import type { ChatContext } from "../../../src/core/port.ts";
import { ConfigError } from "../../../src/core/port.ts";
import { createNodePlatform } from "../../../src/platform-node/platform.ts";
import { BotReader } from "../../../src/protocol/bot-reader.ts";
import { Run } from "../../../src/protocol/outbox.ts";
import { tempDirSync } from "../../support/temp.ts";

const platform = createNodePlatform();
const person = platform.random(32);
const relayA = new Uint8Array(65).fill(7);
const relayB = new Uint8Array(65).fill(8);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** A paired directory and the identity its store belongs to. */
async function paired(relay = relayA, dir = tempDirSync("pardner-store-")) {
  await pair(dir, person, relay);
  const pairing = loadPairing(dir);
  return { dir, pairing, who: identityOf(platform, pairing.device, pairing.relay) };
}

const channel = hex(new Uint8Array(32).fill(1));

test("what is kept survives a restart: bytes, maps and sets come back as they were", async () => {
  const { dir, who } = await paired();
  const store = Store.open(dir, who);
  await store.change((s) => {
    s.decided.set("ref-1", "done");
    s.kept.ids.push(new Uint8Array(32).fill(9));
    s.kept.putBack = true;
    s.incarnation = new Uint8Array(16).fill(4);
    s.faults.add(channel);
    s.clocks.set(channel, { epoch: new Uint8Array(32).fill(5), since: 1234 });
    s.outboxes.set(channel, [
      {
        name: new Uint8Array(16).fill(2),
        kind: 1,
        content: "x",
        files: [],
        built: { signed: new Uint8Array([1, 2]), signature: new Uint8Array([3]) },
      },
    ]);
  });
  const again = Store.open(dir, who).saved;
  assert.equal(again.decided.get("ref-1"), "done");
  assert.equal(hex(again.kept.ids[0] as Uint8Array), "09".repeat(32));
  assert.equal(again.kept.putBack, true);
  assert.equal(hex(again.incarnation as Uint8Array), "04".repeat(16));
  assert.ok(again.faults.has(channel));
  assert.deepEqual(again.clocks.get(channel), { epoch: new Uint8Array(32).fill(5), since: 1234 });
  assert.deepEqual(again.outboxes.get(channel)?.[0]?.built?.signed, new Uint8Array([1, 2]));
});

test("no private key is in the store", async () => {
  const { dir, who } = await paired();
  await Store.open(dir, who).change((s) => s.decided.set("k", "cut"));
  const keys = JSON.parse(readFileSync(join(dir, "keys.json"), "utf8")) as Record<
    string,
    { sk: string }
  >;
  const text = readFileSync(join(dir, "store.json"), "utf8");
  for (const { sk } of Object.values(keys)) assert.ok(!text.includes(sk));
});

// C15: an unreadable store fails closed.
test("C15: a store that does not parse, or has the wrong shape, stops the start and the error names the file", async () => {
  const { dir, who } = await paired();
  const path = join(dir, "store.json");
  for (const text of ["{ not json", "{}", '{"device":{"$hex":"00"}}']) {
    writeFileSync(path, text);
    assert.throws(
      () => Store.open(dir, who),
      (e) => e instanceof ConfigError && e.message.startsWith(path) && !e.message.includes(text),
      text,
    );
  }
});

test("C15: the module's start refuses an unreadable store, and does not start on an empty one in its place", async () => {
  const { dir, pairing } = await paired();
  const path = join(dir, "store.json");
  writeFileSync(path, "garbage");
  const variables = {
    RELAY_ADDRESS: "127.0.0.1:4433",
    RELAY_KEY: hex(pairing.relay),
    RELAY_OWNER: hex(pairing.person),
  };
  await assert.rejects(
    relayChat().build({ variables, configDir: dir } as unknown as ChatContext),
    (e) => e instanceof ConfigError && e.message.startsWith(path),
  );
  assert.equal(readFileSync(path, "utf8"), "garbage");
});

test("a store that is a directory does not read: the start refuses it", async () => {
  const { dir, who } = await paired();
  writeFileSync(join(dir, "store.json"), "x");
  const path = join(dir, "store.json");
  // Replace the file with a directory of the same name.
  rmSync(path);
  mkdirSync(path);
  assert.throws(() => Store.open(dir, who), ConfigError);
});

// C14, the store half.
test("C14: a new pairing resets the store and keeps only what was decided", async () => {
  const { dir, who } = await paired(relayA);
  await Store.open(dir, who).change((s) => {
    s.decided.set("ref-1", "done");
    s.faults.add(channel);
    s.kept.putBack = true;
    s.outboxes.set(channel, [{ name: new Uint8Array(16), kind: 1, content: "x", files: [] }]);
  });
  const next = await paired(relayB, dir);
  const saved = Store.open(dir, next.who).saved;
  assert.equal(saved.decided.get("ref-1"), "done");
  assert.equal(hex(saved.relay), hex(relayB));
  assert.equal(saved.faults.size, 0);
  assert.equal(saved.outboxes.size, 0);
  assert.equal(saved.kept.putBack, false);
  assert.equal(saved.kept.ids.length, 0);
});

test("C14: a crash between the pairing files and the store finishes the reset at the next start, keeping decided", async () => {
  const { dir, who } = await paired(relayA);
  await Store.open(dir, who).change((s) => {
    s.decided.set("ref-1", "cut");
    s.faults.add(channel);
    s.outboxes.set(channel, [{ name: new Uint8Array(16), kind: 1, content: "old", files: [] }]);
  });
  await assert.rejects(
    pair(dir, person, relayB, {
      stored: () => {
        throw new Error("crash");
      },
    }),
    /crash/,
  );
  // The pairing files are the new ones; the store is still the old pairing's.
  const pairing = loadPairing(dir);
  assert.equal(hex(pairing.relay), hex(relayB));
  assert.ok(readFileSync(join(dir, "store.json"), "utf8").includes("old"));
  const saved = Store.open(dir, identityOf(platform, pairing.device, pairing.relay)).saved;
  assert.equal(saved.decided.get("ref-1"), "cut");
  assert.equal(saved.faults.size, 0);
  assert.equal(saved.outboxes.size, 0);
  assert.equal(hex(saved.relay), hex(relayB));
  // The reset is on disk: a second start finds a store of this pairing.
  assert.equal(
    hex(Store.open(dir, identityOf(platform, pairing.device, pairing.relay)).saved.relay),
    hex(relayB),
  );
});

test("a crash after the new keys and before the pairing file leaves the old store alone", async () => {
  const { dir, who } = await paired(relayA);
  await Store.open(dir, who).change((s) => s.decided.set("ref-1", "done"));
  await assert.rejects(
    pair(dir, person, relayB, {
      between: () => {
        throw new Error("crash");
      },
    }),
    /crash/,
  );
  assert.ok(readFileSync(join(dir, "store.json"), "utf8").includes("ref-1"));
  assert.throws(() => loadPairing(dir), ConfigError);
});

test("a pairing resets a store that does not read, which has nothing to keep", async () => {
  const { dir } = await paired(relayA);
  writeFileSync(join(dir, "store.json"), "garbage");
  const next = await paired(relayB, dir);
  assert.equal(Store.open(dir, next.who).saved.decided.size, 0);
});

// M1: one writer.
test("M1: two concurrent changes are both on disk, and the writes are one at a time", async () => {
  const { dir, who } = await paired();
  const store = Store.open(dir, who);
  const first = store.change((s) => s.decided.set("a", "done"));
  const second = store.change((s) => s.decided.set("b", "cut"));
  const third = store.change((s) => s.faults.add(channel));
  await Promise.all([first, second, third]);
  const saved = Store.open(dir, who).saved;
  assert.equal(saved.decided.get("a"), "done");
  assert.equal(saved.decided.get("b"), "cut");
  assert.ok(saved.faults.has(channel));
  // No temporary file is left, and a change that arrives during a write is in the next one.
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.endsWith(".tmp")),
    [],
  );
  const during = store.change((s) => s.decided.set("c", "done"));
  const after = store.change((s) => s.decided.set("d", "done"));
  await Promise.all([during, after]);
  assert.deepEqual([...Store.open(dir, who).saved.decided.keys()].sort(), ["a", "b", "c", "d"]);
});

test("M1: a failed write rejects its changes and the next change writes again", async () => {
  const { dir, who } = await paired();
  const store = Store.open(dir, who);
  const moved = `${dir}-gone`;
  renameSync(dir, moved);
  await assert.rejects(store.change((s) => s.decided.set("a", "done")));
  renameSync(moved, dir);
  await store.change((s) => s.decided.set("b", "done"));
  const saved = Store.open(dir, who).saved;
  assert.equal(saved.decided.get("a"), "done"); // kept in memory, written with the next change
  assert.equal(saved.decided.get("b"), "done");
  rmSync(dir, { recursive: true, force: true });
});

// C9, the store half: an older copy put back.
test("C9: an older copy put back opens as it was, and what it lacks is not claimed", async () => {
  const { dir, who } = await paired();
  const store = Store.open(dir, who);
  await store.change((s) => s.decided.set("ref-1", "started"));
  copyFileSync(join(dir, "store.json"), join(dir, "old-copy"));
  await store.change((s) => {
    s.decided.set("ref-1", "done");
    s.decided.set("ref-2", "done");
  });
  copyFileSync(join(dir, "old-copy"), join(dir, "store.json"));
  const saved = Store.open(dir, who).saved;
  assert.equal(saved.decided.get("ref-1"), "started");
  assert.equal(saved.decided.has("ref-2"), false);
  // The reader turns a start it cannot know the end of into a cut, whatever the copy says.
  const reader = new BotReader(
    platform,
    who.device,
    new Uint8Array(16),
    new Run(platform),
    saved.decided,
  );
  assert.equal(reader.decided.get("ref-1"), "cut");
});

test("C9: a copy of an earlier pairing put back is reset, and keeps only what it decided", async () => {
  const { dir, who } = await paired(relayA);
  await Store.open(dir, who).change((s) => s.decided.set("ref-1", "done"));
  copyFileSync(join(dir, "store.json"), join(dir, "old-copy"));
  const next = await paired(relayB, dir);
  copyFileSync(join(dir, "old-copy"), join(dir, "store.json"));
  const saved = Store.open(dir, next.who).saved;
  assert.equal(hex(saved.relay), hex(relayB));
  assert.equal(saved.decided.get("ref-1"), "done");
});

test("a Node Buffer in what is kept comes back as bytes", async () => {
  const { dir, who } = await paired();
  await Store.open(dir, who).change((s) => {
    s.kept.head = {
      head: { relay: new Uint8Array(32), n: 1, chain: new Uint8Array(32) },
      sig: Buffer.alloc(64, 1),
    };
  });
  const sig = Store.open(dir, who).saved.kept.head?.sig;
  assert.equal(Object.prototype.toString.call(sig), "[object Uint8Array]");
  assert.equal(sig?.length, 64);
});

test("C15: a file that parses with an inner field of the wrong type stops the start", async () => {
  const { dir, who } = await paired();
  const path = join(dir, "store.json");
  const good = JSON.parse(readFileSync(join(dir, "store.json"), "utf8")) as Record<string, unknown>;
  Store.open(dir, who);
  const bytes = { $hex: "00" };
  const cases: Record<string, unknown> = {
    "no version": { ...good, version: undefined },
    "an old version": { ...good, version: 0 },
    "a decision": { ...good, decided: { $map: [["a", "whatever"]] } },
    ids: { ...good, kept: { ids: [5, "x"], putBack: false } },
    "a head": { ...good, kept: { ids: [], head: 3, putBack: false } },
    "an outbox": { ...good, outboxes: { $map: [["c", 7]] } },
    "an outbox item with a file": {
      ...good,
      outboxes: {
        $map: [["c", [{ name: bytes, kind: 1, content: "x", files: [{ key: bytes }] }]]],
      },
    },
    "a clock": { ...good, clocks: { $map: [["c", null]] } },
    "a fault": { ...good, faults: { $set: [1] } },
    hex: { ...good, relay: { $hex: "zz" } },
  };
  for (const [name, content] of Object.entries(cases)) {
    writeFileSync(path, JSON.stringify(content));
    assert.throws(
      () => Store.open(dir, who),
      (e) => e instanceof ConfigError && e.message.startsWith(path),
      name,
    );
  }
});

test("an outbox item that carries a file is refused: the store never holds a file's key", async () => {
  const { dir, who } = await paired();
  const store = Store.open(dir, who);
  const file = { key: new Uint8Array(32), blob: new Uint8Array(4), size: 4, type: "t", name: "n" };
  await assert.rejects(
    store.change((s) =>
      s.outboxes.set(channel, [
        { name: new Uint8Array(16), kind: 1, content: "x", files: [file as never] },
      ]),
    ),
    ConfigError,
  );
  assert.ok(!readFileSync(join(dir, "store.json"), "utf8").includes(hex(file.key)));
});

test("an edit that throws, or that the check refuses, changes nothing and blocks no later write", async () => {
  const { dir, who } = await paired();
  const store = Store.open(dir, who);
  await assert.rejects(
    store.change((s) => {
      s.decided.set("a", "started");
      throw new Error("boom");
    }),
    /boom/,
  );
  const file = { key: new Uint8Array(32), blob: new Uint8Array(4), size: 4, type: "t", name: "n" };
  await assert.rejects(
    store.change((s) =>
      s.outboxes.set(channel, [
        { name: new Uint8Array(16), kind: 1, content: "x", files: [file as never] },
      ]),
    ),
    ConfigError,
  );
  assert.equal(store.saved.decided.has("a"), false);
  assert.equal(store.saved.outboxes.size, 0);
  await store.change((s) => s.decided.set("b", "done"));
  assert.deepEqual([...Store.open(dir, who).saved.decided.keys()], ["b"]);
});

test("a clock that is not a finite time is refused when it is written", async () => {
  const { dir, who } = await paired();
  const store = Store.open(dir, who);
  for (const since of [Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      store.change((s) => s.clocks.set(channel, { epoch: new Uint8Array(32), since })),
      ConfigError,
    );
  }
  Store.open(dir, who);
});

test("a failed write that nobody awaited ends no process", async () => {
  const { dir, who } = await paired();
  const store = Store.open(dir, who);
  const moved = `${dir}-gone`;
  renameSync(dir, moved);
  void store.change((s) => s.decided.set("a", "done")); // dropped: its rejection must stay handled
  await new Promise((resolve) => setTimeout(resolve, 50));
  renameSync(moved, dir);
});

test("a pairing returns its string when the store's reset fails: the start finishes it", async () => {
  const { dir } = await paired(relayA);
  rmSync(join(dir, "store.json"));
  mkdirSync(join(dir, "store.json")); // cannot be read: a failure that is not a parse
  const string = await pair(dir, person, relayB);
  assert.match(string, /^[0-9a-f]+$/);
  assert.equal(hex(loadPairing(dir).relay), hex(relayB));
});

test("a reset does not drop decided on a read error that is not a parse", async () => {
  const { dir, who } = await paired(relayA);
  await Store.open(dir, who).change((s) => s.decided.set("ref-1", "done"));
  const path = join(dir, "store.json");
  const text = readFileSync(path);
  rmSync(path);
  mkdirSync(path);
  assert.throws(() => resetStore(dir, who), ConfigError);
  rmSync(path, { recursive: true });
  writeFileSync(path, text);
  assert.equal(Store.open(dir, who).saved.decided.get("ref-1"), "done");
});

test("F2: a pairing whose store cannot be reset says so, and the start then names the file", async () => {
  const { dir, pairing } = await paired(relayA);
  const path = join(dir, "store.json");
  rmSync(path);
  mkdirSync(path);
  const lines = await relayChat()
    .setup?.(DEFAULT_INSTANCE)
    .finish?.(dir, {
      RELAY_OWNER: hex(person),
      RELAY_KEY: hex(relayB),
    });
  assert.equal(
    lines?.at(-1),
    `The store at ${path} could not be reset. Remove it, then start the bot.`,
  );
  const variables = {
    RELAY_ADDRESS: "127.0.0.1:4433",
    RELAY_KEY: hex(relayB),
    RELAY_OWNER: hex(person),
  };
  const start = () => relayChat().build({ variables, configDir: dir } as unknown as ChatContext);
  await assert.rejects(start(), (e) => e instanceof ConfigError && e.message.startsWith(path));
  rmSync(path, { recursive: true });
  const provider = await start(); // the store reads: the start builds the provider, which dials once it is started
  assert.equal(provider.name, "relay");
  await provider.close();
  assert.ok(pairing);
});

test("a start refuses a stored put-back or fault, and an address that is not host:port", async () => {
  const { dir, who } = await paired(relayA);
  const variables = {
    RELAY_ADDRESS: "127.0.0.1:4433",
    RELAY_KEY: hex(relayA),
    RELAY_OWNER: hex(person),
  };
  const start = (over: Record<string, string> = {}) =>
    relayChat().build({
      variables: { ...variables, ...over },
      configDir: dir,
    } as unknown as ChatContext);
  // A store of another pairing: opening it would reset it.
  resetStore(dir, { ...who, relay: relayB });
  const before = existsSync(join(dir, "store.json")) ? readFileSync(join(dir, "store.json")) : null;
  await assert.rejects(
    start({ RELAY_ADDRESS: "no-port" }),
    (e) => e instanceof ConfigError && e.message.startsWith("RELAY_ADDRESS: "),
  );
  const kept = () =>
    existsSync(join(dir, "store.json")) ? readFileSync(join(dir, "store.json")) : null;
  assert.deepEqual(
    kept(),
    before,
    "a bad address is refused before the store opens, and leaves it as it was",
  );
  const store = Store.open(dir, who);
  await store.change((s) => {
    s.kept.putBack = true;
  });
  await assert.rejects(
    start(),
    (e) =>
      e instanceof ConfigError &&
      /the relay must be recreated: .* no more; once it is, /.test(e.message),
  );
  await store.change((s) => {
    s.kept.putBack = false;
    s.fault = true;
  });
  await assert.rejects(
    start(),
    (e) => e instanceof ConfigError && /must be recreated/.test(e.message),
  );
});
