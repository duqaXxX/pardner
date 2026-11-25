/**
 * The bot's profile (bot-profile design 3.2, 4.3) against a real relay in a child process: when the
 * bot writes it, what it holds, what a restart, an account and a new epoch change, and a relay that
 * refuses it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { relayChat } from "../../../src/chat/relay/module.ts";
import type { ChatInbound } from "../../../src/chat/seam.ts";
import type { ChatContext } from "../../../src/core/port.ts";
import { decodeMessage, KIND_PROFILE } from "../../../src/protocol/messages.ts";
import { DARWIN } from "../../relay/process-support.ts";
import { botOn, rig, waiting } from "./relay-rig.ts";

const ACCOUNT = { name: "alice@example.com", plan: "Max" };

/** The profiles the relay holds, in its order, each with its epoch and the content a device opens. */
async function profiles(r: Awaited<ReturnType<typeof rig>>) {
  const held = await r.held();
  return held.messages
    .filter((m) => m.kind === KIND_PROFILE)
    .map((m) => ({ epoch: Buffer.from(m.epoch).toString("hex"), body: r.body(m), run: m.run }));
}

test(
  "a bot writes its profile at its first rest, again once it learns its account, and no more; a restart with the same configuration writes none",
  DARWIN,
  async () => {
    const r = await rig({ space: true });
    let b = botOn(r, { profile: { name: "mini" } });
    try {
      b.connection.start();
      await b.rested();
      await b.until(async () => (await profiles(r)).length === 1);
      assert.deepEqual((await profiles(r))[0]?.body, { name: "mini" }, "no account known yet");
      b.profile?.account(ACCOUNT);
      await b.until(async () => (await profiles(r)).length === 2);
      assert.deepEqual((await profiles(r))[1]?.body, { name: "mini", account: ACCOUNT });
      b.profile?.account({ name: "bob@example.com", plan: null }); // a third in this run: none
      await r.send({ kind: 1 }, { text: "a push the bot reads to rest" });
      await waiting();
      assert.equal(
        (await profiles(r)).length,
        2,
        "one per epoch and run, and one more for the account",
      );
      await b.stop();

      b = botOn(r, { profile: { name: "mini" } });
      b.connection.start();
      await b.rested();
      await waiting();
      assert.equal((await profiles(r)).length, 2, "the same profile, nothing to write");
      b.profile?.account(ACCOUNT);
      await waiting();
      assert.equal((await profiles(r)).length, 2, "the account it showed before");
      await b.stop();

      b = botOn(r, { profile: { name: "studio" } }); // a change of configuration takes a restart
      b.connection.start();
      await b.until(async () => (await profiles(r)).length === 3);
      assert.deepEqual(
        (await profiles(r))[2]?.body,
        { name: "studio", account: ACCOUNT },
        "the account of its newest profile, while this run does not know it",
      );
      assert.deepEqual(
        b.lines.filter((l) => /another|refused/.test(l)),
        [],
        "one process, one bot of that name",
      );
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "a new epoch gets the bot's profile; a relay that refuses a profile is no fault and gets no second one in the run",
  DARWIN,
  async () => {
    const r = await rig({ space: true });
    let refuse = false;
    const b = botOn(r, {
      profile: { name: "mini" },
      submit: (real) => async (k, s, g) => {
        const d = decodeMessage(s);
        return refuse && d.ok && d.value.header.kind === KIND_PROFILE ? 1 : real(k, s, g);
      },
    });
    try {
      b.connection.start();
      b.profile?.account(null);
      await b.until(async () => (await profiles(r)).length === 1);
      await r.epoch();
      await b.until(async () => (await profiles(r)).length === 2);
      const [first, second] = await profiles(r);
      assert.notEqual(first?.epoch, second?.epoch);
      assert.deepEqual(second?.body, { name: "mini" }, "an agent that reports no account");

      refuse = true;
      await r.epoch();
      await b.until(() => b.lines.includes("relay: the relay refused the bot's profile"));
      assert.equal(b.outbox.profileDropped, true);
      assert.deepEqual(b.queued(), []);
      assert.equal(b.store.saved.faults.size, 0, "the channel goes on");
      await b.outbox.queue(r.talk.channel, { kind: 8, content: "{}" });
      await b.until(async () => (await r.held()).messages.some((m) => m.kind === 8));
      await waiting();
      assert.equal(
        b.lines.filter((l) => l === "relay: the relay refused the bot's profile").length,
        1,
        "no other profile after the refusal",
      );
      assert.equal((await profiles(r)).length, 2);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "a profile still in the outbox at a restart is the one sent: the next run writes no second",
  DARWIN,
  async () => {
    const r = await rig({ space: true });
    const unanswered = botOn(r, {
      profile: { name: "mini" },
      submit: (real) => async (k, s, g) => {
        const d = decodeMessage(s);
        return d.ok && d.value.header.kind === KIND_PROFILE ? undefined : real(k, s, g);
      },
    });
    let b = unanswered;
    try {
      unanswered.connection.start();
      await unanswered.until(() => unanswered.queued().some((i) => i.kind === KIND_PROFILE));
      await unanswered.stop();
      b = botOn(r, { profile: { name: "mini" } });
      b.connection.start();
      await b.until(async () => (await profiles(r)).length === 1);
      await b.until(() => b.queued().length === 0);
      await r.send({ kind: 1 }, { text: "a push the bot reads to rest" });
      await waiting();
      assert.equal((await profiles(r)).length, 1);
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "two processes with one bot key and two names write one profile each, and one of them says so",
  DARWIN,
  async () => {
    const r = await rig({ space: true });
    const a = botOn(r, { profile: { name: "mini" } });
    const b = botOn(r, { profile: { name: "mini-copy" } });
    try {
      a.connection.start();
      await a.until(async () => (await profiles(r)).length === 1);
      b.connection.start();
      await b.until(async () => (await profiles(r)).length === 2);
      await r.send({ kind: 1 }, { text: "a push both read to rest" });
      await a.until(() => a.lines.includes("relay: another process is writing as this bot"));
      await waiting();
      const held = await profiles(r);
      assert.deepEqual(
        held.map((p) => p.body.name),
        ["mini", "mini-copy"],
        "no answer to each other: one per run and epoch (condition 3)",
      );
    } finally {
      await a.stop();
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "a bot that reads another bot of its owner's under its own name says so once, and still writes its own",
  DARWIN,
  async () => {
    const r = await rig({ space: true });
    const second = await r.addBot();
    await r.epoch(); // sealed to both bots
    const other = botOn(r, { dir: second.dir, profile: { name: "mini" } });
    let b = other;
    try {
      other.connection.start();
      await other.until(async () => (await profiles(r)).length === 1);
      await other.stop();
      b = botOn(r, { profile: { name: "mini" } });
      b.connection.start();
      await b.until(async () => (await profiles(r)).length === 2); // the line comes at its first rest, before it
      assert.deepEqual(
        b.lines.filter((l) => l.includes("also named")),
        ["relay: another bot of this owner is also named mini"],
      );
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "a store whose write fails is logged, never a rejection: the profile it kept in memory lands once",
  DARWIN,
  async () => {
    const r = await rig({ space: true });
    const b = botOn(r, { profile: { name: "mini" } });
    try {
      b.connection.start();
      await b.until(async () => (await profiles(r)).length === 1);
      const write = b.store.change.bind(b.store);
      // As the real store fails: the edit applied in memory, then the write rejects.
      b.store.change = (edit) =>
        write(edit).then(() => Promise.reject(new Error("the disk is full")));
      b.profile?.account(ACCOUNT); // the second write of the run
      await b.until(() => b.lines.includes("relay: the store did not write: the disk is full"));
      b.store.change = write;
      await r.send({ kind: 1 }, { text: "a push the bot reads to rest" });
      await b.until(async () => (await profiles(r)).length === 2);
      await waiting();
      assert.deepEqual(
        (await profiles(r)).map((p) => p.body),
        [{ name: "mini" }, { name: "mini", account: ACCOUNT }],
        "once, not twice",
      );
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "a profile queued but not built at a restart is dropped: the next run writes its own configuration",
  DARWIN,
  async () => {
    const r = await rig({ space: true });
    const stuck = botOn(r, {
      profile: { name: "mini" },
      // A state message the relay never answers holds the profile behind it, not built.
      submit: (real) => async (k, s, g) => {
        const d = decodeMessage(s);
        return d.ok && d.value.header.kind === 8 ? undefined : real(k, s, g);
      },
    });
    let b = stuck;
    try {
      await stuck.outbox.queue(r.channel, { kind: 8, content: "{}" }); // never reaches the relay: the wrapper holds it
      stuck.connection.start();
      await stuck.until(() => stuck.queued().some((i) => i.kind === KIND_PROFILE && !i.built));
      await stuck.stop();
      b = botOn(r, { profile: { name: "studio" } });
      b.connection.start();
      await b.until(async () => (await profiles(r)).length === 1);
      await b.until(() => b.queued().length === 0);
      await r.send({ kind: 1 }, { text: "a push the bot reads to rest" });
      await waiting();
      assert.deepEqual(
        (await profiles(r)).map((p) => p.body),
        [{ name: "studio" }],
        "the earlier run's name never lands",
      );
    } finally {
      await b.stop();
      await r.stop();
    }
  },
);

test(
  "the relay module wires the writer: a provider built from the entry writes its profile, and its account",
  DARWIN,
  async () => {
    const r = await rig({ space: true });
    const context = {
      variables: {
        RELAY_ADDRESS: `127.0.0.1:${r.port}`,
        RELAY_KEY: Buffer.from(r.relayKey).toString("hex"),
        RELAY_OWNER: Buffer.from(r.alice.id).toString("hex"),
        PARDNER_BOT_NAME: "wired",
      },
      configDir: r.dir,
    } as unknown as ChatContext;
    const provider = await relayChat().build(context);
    try {
      await provider.start({} as ChatInbound);
      await waitFor(async () => (await profiles(r)).length === 1);
      assert.deepEqual((await profiles(r))[0]?.body, { name: "wired" });
      provider.agentAccount?.(ACCOUNT);
      await waitFor(async () => (await profiles(r)).length === 2);
      assert.deepEqual((await profiles(r))[1]?.body, { name: "wired", account: ACCOUNT });
    } finally {
      await provider.stop();
      await provider.close();
      await r.stop();
    }
  },
);

async function waitFor(done: () => Promise<boolean>) {
  for (
    const end = Date.now() + 20_000;
    !(await done());
    await new Promise((s) => setTimeout(s, 25))
  )
    assert.ok(Date.now() < end, "waited for what never came");
}
