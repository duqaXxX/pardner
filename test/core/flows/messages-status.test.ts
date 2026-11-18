/**
 * `!status`, typed in the channel: its folder, then one line per live session. And the
 * thread's own `!status`, which is the session's.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ago, STATUS_ROWS } from "../../../src/core/flows/status.ts";
import * as texts from "../../../src/core/texts.ts";
import { fill } from "../../../src/core/texts.ts";
import { shellQuote } from "../../../src/text.ts";
import { OWNER } from "../../support/memory-chat.ts";
import { call, die, hold, PlainAgent } from "../../support/plain-agent.ts";
import {
  linksOn,
  MessagesWorld,
  PLAIN_NAMES,
  WithBypass,
  WithDatedSessions,
  WithFolderTrust,
  WithPlan,
} from "./messages-world.ts";

const header = (directory: string): string => fill(texts.STATUS_CHANNEL_HEADER, { directory });
const linkTo = (thread: string): string =>
  fill(texts.STATUS_CHANNEL_LINK_FALLBACK, { thread_ts: thread });

for (const [seconds, shown] of [
  [59, "just now"],
  [60, "1m ago"],
  [3_599, "59m ago"],
  [3_600, "1h ago"],
  [86_399, "23h ago"],
  [86_400, "1d ago"],
  [30 * 86_400, "30d ago"],
  [-30, "just now"],
] as const) {
  test(`how long ago reads in one unit [${seconds}-${shown}]`, () => {
    assert.equal(ago(seconds), shown);
  });
}

test("a channel bound to no folder says where sessions start", async (t) => {
  const world = await MessagesWorld.make(t);
  const free = world.chat.openChannel("free");
  await world.send({
    ref: { channel: free, thread: "root-1" },
    id: "root-1",
    topLevel: true,
    text: "!status",
  });
  assert.deepEqual(world.chat.texts(free), [fill(texts.UNBOUND_ANY, { root: world.folder })]);
});

test("a channel with no live session says so after its folder", async (t) => {
  const world = await MessagesWorld.make(t);
  await world.says("!status");
  assert.equal(
    world.inChannel().at(-1),
    [header(world.folder), texts.STATUS_CHANNEL_EMPTY].join("\n"),
  );
});

test("an idle session is named by its title and the time of its last message", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("Fix the footer");
  const [stored] = (world.agent as PlainAgent).store.list(world.folder);
  assert.ok(stored);
  world.now = stored.lastModified / 1000 + 7_200;
  await world.says("!status");
  const row = fill(texts.STATUS_CHANNEL_ROW, {
    link: linkTo(ref.thread),
    activity: `${texts.STATUS_CHANNEL_IDLE}${fill(texts.STATUS_CHANNEL_SINCE, { ago: "2h ago" })}`,
  });
  assert.equal(world.inChannel().at(-1), [header(world.folder), row].join("\n"));
});

test("a chat that marks roots leads each row with the mark in place of the word", async (t) => {
  const world = await MessagesWorld.make(t, { reactions: true });
  const done = await world.opened("one");
  // A process that dies leaves ❌ on its root: `ended` says error.
  (world.agent as PlainAgent).next(die());
  const failed = await world.opened("two");
  const busy = await world.opened("three");
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", busy.thread);
  await world.settle();
  await world.says("!status");
  const rows = (world.inChannel().at(-1)?.split("\n") ?? []).slice(1);
  const rowOf = (thread: string) => rows.find((row) => row.includes(linkTo(thread))) ?? "";
  assert.ok(rowOf(done.thread).startsWith(`<done> ${linkTo(done.thread)}`), rowOf(done.thread));
  assert.ok(
    rowOf(failed.thread).startsWith(`<error> ${linkTo(failed.thread)}`),
    rowOf(failed.thread),
  );
  assert.equal(rowOf(busy.thread), `<working> ${linkTo(busy.thread)}`);
  for (const row of rows) assert.ok(!row.includes(texts.STATUS_CHANNEL_IDLE), row);
});

test("a busy session and one that waits for the owner are told apart", async (t) => {
  const world = await MessagesWorld.make(t);
  const busy = await world.opened("one");
  const waiting = await world.opened("two");
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", busy.thread);
  (world.agent as PlainAgent).next(call("Bash", { command: "ls" }, { permission: true }));
  // Beside a busy session of the folder, the owner is asked first.
  const sending = world.says("run it", waiting.thread);
  const asked = await world.asked("hold", waiting);
  await world.chat.as(OWNER).answers(asked.requestId, { type: "hold", send: true });
  await sending;
  await world.asked("permission", waiting);
  await world.says("!status");
  const lines = world.inChannel().at(-1)?.split("\n") ?? [];
  assert.equal(lines[0], header(world.folder));
  const rows = lines.slice(1).toSorted();
  assert.deepEqual(
    rows,
    [
      fill(texts.STATUS_CHANNEL_ROW, {
        link: linkTo(busy.thread),
        activity: texts.STATUS_CHANNEL_BUSY,
      }),
      fill(texts.STATUS_CHANNEL_ROW, {
        link: linkTo(waiting.thread),
        activity: texts.STATUS_CHANNEL_WAITING,
      }),
    ].toSorted(),
  );
});

test("a row says bypass, and the folder of a thread the channel left behind", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithBypass() });
  const ref = await world.opened("one");
  await world.says("!bypass on", ref.thread);
  const docs = join(world.folder, "docs");
  mkdirSync(docs);
  world.state.bind(world.channel, docs);
  await world.says("!status");
  const lines = world.inChannel().at(-1)?.split("\n") ?? [];
  assert.equal(lines[0], header(docs));
  const idle = `${texts.STATUS_CHANNEL_IDLE}${fill(texts.STATUS_CHANNEL_SINCE, { ago: "just now" })}`;
  assert.equal(
    lines[1],
    fill(texts.STATUS_CHANNEL_ROW, { link: linkTo(ref.thread), activity: idle }) +
      texts.STATUS_CHANNEL_BYPASS +
      fill(texts.STATUS_CHANNEL_FOLDER, { directory: world.folder }),
  );
});

test("a row says plan in place of bypass while the session plans", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithPlan() });
  const ref = await world.opened("one");
  await world.says("!bypass on", ref.thread);
  await world.says("!plan", ref.thread);
  await world.says("!status");
  const row = world.inChannel().at(-1)?.split("\n")[1] ?? "";
  assert.ok(row.includes(texts.STATUS_CHANNEL_PLAN), row);
  assert.ok(!row.includes(texts.STATUS_CHANNEL_BYPASS), row);
});

test("a title the agent cannot list leaves the row with no time", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("one");
  t.mock.method(world.sessions, "sessionsIn", async () => {
    throw new Error("unreadable");
  });
  await world.says("!status");
  assert.equal(
    world.inChannel().at(-1),
    [
      header(world.folder),
      fill(texts.STATUS_CHANNEL_ROW, {
        link: linkTo(ref.thread),
        activity: texts.STATUS_CHANNEL_IDLE,
      }),
    ].join("\n"),
  );
});

test("a stop that waits for a thread is named in a notice of its own", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("one");
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", ref.thread);
  await world.settle();
  const cut = new AbortController();
  const drain = world.sessions.drain(cut.signal);
  await world.settle();
  await world.says("!status");
  const notice = world.inChannel().at(-1) ?? "";
  assert.ok(notice.startsWith(texts.RESTART_WAITS_HEADER), notice);
  assert.ok(notice.includes(linkTo(ref.thread)));
  assert.ok(notice.includes(texts.RESTART_HOLD_TURN));
  cut.abort();
  await drain;
});

test("!status in a thread is the session's own, for the owner alone", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("one");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  await world.says("!status", ref.thread);
  assert.equal(world.shown(ref).at(-1), await session.status());
});

test("a thread's !status names the repositories below its folder that still need trust", async (t) => {
  // the footer of such a thread shows no git changes for them.
  const agent = new WithFolderTrust();
  const world = await MessagesWorld.make(t, { agent });
  mkdirSync(join(world.folder, "lib", ".git"), { recursive: true });
  const ref = await world.opened("one");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  const status = await session.status();
  const lines = status.split("\n");
  const at = lines.indexOf(texts.named(texts.UNTRUSTED_REPOSITORIES, PLAIN_NAMES));
  assert.ok(at > 0, status);
  assert.equal(lines[at + 1], `\`cd ${shellQuote(join(world.folder, "lib"))} && plain\``);
  agent.trusted.add(join(world.folder, "lib"));
  assert.ok(!(await session.status()).includes(lines[at] ?? ""), "trusted since: not named");
});

test("the footer and !status say git is not trusted for a repository the agent does not cover", async (t) => {
  const agent = new WithFolderTrust();
  const world = await MessagesWorld.make(t, { agent });
  mkdirSync(join(world.folder, ".git"), { recursive: true });
  const ref = await world.opened("one");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  assert.ok(world.shown(ref).join("\n").includes("git not trusted"), "the footer says so");
  assert.ok((await session.status()).includes("Git: `not trusted`"));
  agent.trusted.add(world.folder);
  assert.ok(!(await session.status()).includes("not trusted"), "trusted since: normal again");
});

test("!status names the repository that makes the mark, with the line that asks for the trust", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithFolderTrust() });
  mkdirSync(join(world.folder, ".git"), { recursive: true });
  const ref = await world.opened("one");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  const lines = (await session.status()).split("\n");
  const at = lines.indexOf(texts.named(texts.UNTRUSTED_REPOSITORIES, PLAIN_NAMES));
  assert.ok(at > 0, lines.join("\n"));
  assert.equal(lines[at + 1], `\`cd ${shellQuote(world.folder)} && plain\``);
});

test("a trust lookup that fails leaves the footer and !status fields, with no mark", async (t) => {
  const agent = new WithFolderTrust();
  agent.untrustedRepository = async () => {
    throw new Error("lookup failed");
  };
  const world = await MessagesWorld.make(t, { agent });
  mkdirSync(join(world.folder, ".git"), { recursive: true });
  const ref = await world.opened("one");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  const status = await session.status();
  assert.ok(
    status.includes("Context:") || status.includes("Effort:") || status.includes("Model:"),
    status,
  );
  assert.ok(!status.includes("not trusted"));
  assert.ok(
    world
      .shown(ref)
      .join("\n")
      .includes(world.folder.split("/").at(-1) ?? "?"),
  );
});

test("!status names no repository from an earlier footer when this call read none", async (t) => {
  const agent = new WithFolderTrust();
  const world = await MessagesWorld.make(t, { agent });
  mkdirSync(join(world.folder, ".git"), { recursive: true });
  const ref = await world.opened("one");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  const line = `\`cd ${shellQuote(world.folder)} && plain\``;
  assert.ok((await session.status()).includes(line), "the mark's repository is named");
  agent.next(die());
  await world.says("again", ref.thread);
  await world.settle();
  agent.trusted.add(world.folder);
  agent.failNextStart(new Error("boom"));
  const last = await session.status();
  assert.ok(!last.includes(line), "trusted since, and no reading this time");
});

test("a trusted-repository lookup that fails leaves the footer fields, with no mark", async (t) => {
  const agent = new WithFolderTrust();
  agent.trustedRepository = async () => {
    throw new Error("lookup failed");
  };
  const world = await MessagesWorld.make(t, { agent });
  const ref = await world.opened("one");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  const status = await session.status();
  assert.ok(status.includes("Effort:"), status);
  assert.ok(!status.includes("not trusted"));
  assert.ok(
    world
      .shown(ref)
      .join("\n")
      .includes(world.folder.split("/").at(-1) ?? "?"),
  );
});

test("a folder that is no repository, and an agent with no record of trust, show no git mark", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithFolderTrust() });
  const ref = await world.opened("one");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  assert.ok(!(await session.status()).includes("not trusted"));
  assert.ok(!world.shown(ref).join("\n").includes("git not trusted"));
  // A plain agent keeps no record of trust, even where a `.git` entry stands.
  const plain = await MessagesWorld.make(t, {});
  mkdirSync(join(plain.folder, ".git"), { recursive: true });
  const other = await plain.opened("one");
  assert.ok(!plain.shown(other).join("\n").includes("git not trusted"));
});

test("a restart leaves every thread with a session listed, by how its last turn ended", async (t) => {
  const first = await MessagesWorld.make(t, { reactions: true });
  const done = await first.opened("one");
  // A process that dies leaves ❌ on its root: `ended` says error.
  (first.agent as PlainAgent).next(die());
  const failed = await first.opened("two");
  await first.sessions.closeAll();
  // The daemon again, on the same state and chat: no session is live any more.
  const world = await MessagesWorld.make(t, {
    reactions: true,
    agent: first.agent,
    restartOf: first,
  });
  assert.deepEqual(world.sessions.sessionsOf(world.channel), []);
  await world.says("!status");
  const lines = world.inChannel().at(-1)?.split("\n") ?? [];
  assert.equal(lines[0], header(world.folder));
  const rowOf = (thread: string) => lines.find((line) => line.includes(linkTo(thread))) ?? "";
  assert.ok(rowOf(done.thread).startsWith(`<done> ${linkTo(done.thread)}`), rowOf(done.thread));
  assert.ok(
    rowOf(failed.thread).startsWith(`<error> ${linkTo(failed.thread)}`),
    rowOf(failed.thread),
  );
  assert.ok(!lines.includes(texts.STATUS_CHANNEL_EMPTY));
});

test("past ten threads the answer lists the newest and counts the others", async (t) => {
  const world = await MessagesWorld.make(t, { reactions: true });
  const opened = [];
  for (let n = 0; n < STATUS_ROWS + 2; n += 1) {
    opened.push(await world.opened(`job ${n}`));
    world.now += 60; // each a minute after the one before
  }
  await world.says("!status");
  const lines = world.inChannel().at(-1)?.split("\n") ?? [];
  assert.equal(lines.length, 1 + STATUS_ROWS + 1);
  assert.equal(lines.at(-1), fill(texts.STATUS_CHANNEL_MORE, { count: 2 }));
  // The two left out are the oldest.
  for (const ref of opened.slice(0, 2)) {
    assert.ok(!lines.some((line) => line.includes(linkTo(ref.thread))), ref.thread);
  }
});

test("a thread's !status gives the line that continues the session in a terminal", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("one");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  const status = await session.status();
  assert.ok(status.includes(`plain --resume`), status);
});

test("for an agent with no terminal the thread's !status shows no such line", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new PlainAgent({ noTerminal: true }) });
  const ref = await world.opened("one");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  const status = await session.status();
  assert.ok(!status.includes("--resume"), status);
  assert.ok(
    status.startsWith(fill(texts.STATUS, { directory: world.folder, session: "plain-session-1" })),
    status,
  );
});

test("!terminal for an agent with no terminal says there is none", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new PlainAgent({ noTerminal: true }) });
  const ref = await world.opened("one");
  await world.says("!terminal", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.named(texts.TERMINAL_UNAVAILABLE, PLAIN_NAMES));
});

// --- What a row says of a session

test("an idle session is dated by its last message, not by its file, and only the sessions shown are dated", async (t) => {
  const agent = new WithDatedSessions();
  const world = await MessagesWorld.make(t, { agent });
  const links = linksOn(world, t);
  const ref = await world.opened("Fix the footer");
  const id = world.state.thread(ref.channel, ref.thread)?.sessionId;
  assert.ok(typeof id === "string");
  // Another session of the folder, with no thread of the channel: no row shows it.
  agent.store.remember(world.folder, "other-session", "Another session of the folder", 1);
  const [file] = agent.store.list(world.folder).filter((session) => session.id === id);
  assert.ok(file);
  // The file was just written to, as a connect writes entries with no time; the last message is older.
  world.now = file.lastModified / 1000;
  agent.lastMessage = (world.now - 16 * 60) * 1000;
  agent.dated.length = 0;
  await world.says("!status");
  const idle = `${texts.STATUS_CHANNEL_IDLE}${fill(texts.STATUS_CHANNEL_SINCE, { ago: "16m ago" })}`;
  assert.deepEqual(world.inChannel().at(-1)?.split("\n"), [
    header(world.folder),
    fill(texts.STATUS_CHANNEL_ROW, {
      link: `<https://chat.test/${ref.thread}|Fix the footer>`,
      activity: idle,
    }),
  ]);
  assert.deepEqual(agent.dated, [[world.folder, [id]]]);
  assert.deepEqual(links, [[ref, "Fix the footer", "notice"]]);
});

test("a row's link carries the title as written, brackets and marks included", async (t) => {
  const title = "fix [urgent](x) *now*";
  const world = await MessagesWorld.make(t);
  const links = linksOn(world, t);
  const ref = await world.opened(title);
  const escaped = t.mock.method(world.provider, "escape");
  await world.says("!status");
  assert.deepEqual(links, [[ref, title, "notice"]]);
  // The label is written for a notice: the title is read as the chat's notice markup says.
  const marks = escaped.mock.calls
    .filter((call) => call.arguments[0] === title)
    .map((call) => call.arguments[1]);
  assert.deepEqual(marks, ["notice"]);
  assert.ok(world.inChannel().at(-1)?.includes(`<https://chat.test/${ref.thread}|${title}>`));
});

test("a session whose titles cannot be listed is linked as a session, with no time", async (t) => {
  const world = await MessagesWorld.make(t);
  const links = linksOn(world, t);
  const ref = await world.opened("Fix the footer");
  t.mock.method(world.sessions, "sessionsIn", async () => {
    throw new Error("unreadable");
  });
  await world.says("!status");
  assert.deepEqual(links, [[ref, texts.STATUS_CHANNEL_SESSION, "notice"]]);
  assert.equal(
    world.inChannel().at(-1)?.split("\n")[1],
    fill(texts.STATUS_CHANNEL_ROW, {
      link: `<https://chat.test/${ref.thread}|${texts.STATUS_CHANNEL_SESSION}>`,
      activity: texts.STATUS_CHANNEL_IDLE,
    }),
  );
});

test("a session with only a background task running is working, not idle", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("start it");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  // The turn is over (`busy` is false) and a task it started still runs: the sessions' own tests
  // drive the agent that makes `runningKinds` say so.
  assert.equal(session.busy, false);
  t.mock.getter(session, "runningKinds", () => "1 task");
  await world.says("!status");
  const row = world.inChannel().at(-1)?.split("\n")[1] ?? "";
  assert.ok(row.startsWith(linkTo(ref.thread)), row);
  assert.ok(row.includes(texts.STATUS_CHANNEL_BUSY), row);
  assert.ok(!row.includes(texts.STATUS_CHANNEL_IDLE), row);
});

test("a channel status with no stop under way says nothing of a restart", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("one");
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", ref.thread);
  await world.settle();
  await world.says("!status");
  // The status itself was answered: its header and the row of the working thread.
  assert.ok(world.inChannel().some((text) => text.startsWith(header(world.folder))));
  assert.ok(world.inChannel().some((text) => text.includes(linkTo(ref.thread))));
  assert.equal(
    world.inChannel().filter((text) => text.includes(texts.RESTART_WAITS_FOR)).length,
    0,
  );
  assert.ok(!world.inChannel().some((text) => text.startsWith(texts.RESTART_WAITS_HEADER)));
});
