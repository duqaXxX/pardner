/**
 * Which files the owner may open, and the core's answer to a click (`ChatInbound.openFile`) and to
 * `/open <path>` typed in a chat that has no picker: a file inside the session's folder, or one
 * the agent says a call of the session named (`AgentBackend.touched`). The click is answered from
 * `state.json` alone, so a restart changes nothing.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ThreadRef } from "../../../src/chat/seam.ts";
import { sizeText } from "../../../src/core/guide.ts";
import * as texts from "../../../src/core/texts.ts";
import { fill } from "../../../src/core/texts.ts";
import { PlainAgent } from "../../support/plain-agent.ts";
import { MessagesWorld } from "./messages-world.ts";

const LIMIT = 100;

/** A world, a thread with a session, a folder of its own outside the session's, and the agent's record. */
async function opening(t: Parameters<typeof MessagesWorld.make>[0]) {
  const agent = new PlainAgent();
  const asked: string[] = [];
  agent.touched = async (folder, session, path) => {
    asked.push(`${folder} ${session} ${path}`);
    return path === "";
  };
  const world = await MessagesWorld.make(t, { agent, diff: true, fileLimit: LIMIT });
  const ref = await world.opened();
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "pardner-elsewhere-")));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  return { world, agent, asked, ref, elsewhere };
}

const refused = (answer: unknown): string | null =>
  typeof answer === "object" && answer !== null && "refusal" in answer
    ? String(answer.refusal)
    : null;

test("a file inside the folder opens, by a relative path or an absolute one, with its change time", async (t) => {
  const { world, ref } = await opening(t);
  mkdirSync(join(world.folder, "docs"));
  writeFileSync(join(world.folder, "docs", "a.md"), "# a\n");
  for (const path of ["docs/a.md", "./docs/../docs/a.md", join(world.folder, "docs", "a.md")]) {
    const opened = await world.inbound.openFile?.(ref, path);
    assert.ok(opened && refused(opened) === null, path);
    if (refused(opened) !== null || !("content" in opened)) continue;
    assert.equal(opened.name, "a.md");
    assert.equal(opened.title, "docs/a.md");
    assert.equal(opened.content.toString(), "# a\n");
    assert.ok(Math.abs(opened.modified - Date.now()) < 60_000);
  }
});

test("a file outside the folder opens when a call of the session named it, and not otherwise", async (t) => {
  const { world, agent, asked, ref, elsewhere } = await opening(t);
  const file = join(elsewhere, "notes.txt");
  writeFileSync(file, "notes");
  const before = await world.inbound.openFile?.(ref, file);
  assert.equal(refused(before), fill(texts.OPEN_NOT_OPENABLE, { path: file }));
  assert.equal(asked.length, 1);
  const sessionId = world.state.thread(ref.channel, ref.thread)?.sessionId;
  assert.equal(asked[0], `${world.folder} ${sessionId} ${file}`);

  agent.touched = async (_folder, _session, asking) => asking === file;
  const opened = await world.inbound.openFile?.(ref, file);
  assert.ok(opened && "content" in opened);
  assert.equal(opened.title, file);
  assert.equal(opened.content.toString(), "notes");
});

test("a relative path outside the folder is asked as the session's folder resolves it", async (t) => {
  const { world, asked, ref } = await opening(t);
  await world.inbound.openFile?.(ref, "../outside.txt");
  assert.deepEqual(asked, [
    `${world.folder} ${world.state.thread(ref.channel, ref.thread)?.sessionId} ${join(world.folder, "..", "outside.txt")}`,
  ]);
});

test("a link inside the folder to a file outside it is refused unless that file was named", async (t) => {
  const { world, ref, elsewhere } = await opening(t);
  writeFileSync(join(elsewhere, "secret.txt"), "s");
  symlinkSync(join(elsewhere, "secret.txt"), join(world.folder, "link.txt"));
  // `touched` is asked for the link's own text, which no call named: refused.
  assert.equal(
    refused(await world.inbound.openFile?.(ref, "link.txt")),
    fill(texts.OPEN_NOT_OPENABLE, { path: "link.txt" }),
  );
});

test("a directory, a missing file and an agent with no record are refused; a file over the limit says so", async (t) => {
  const { world, ref, elsewhere } = await opening(t);
  writeFileSync(join(world.folder, "big.txt"), "x".repeat(LIMIT + 1));
  writeFileSync(join(world.folder, "empty.txt"), "");
  assert.equal(
    refused(await world.inbound.openFile?.(ref, "big.txt")),
    fill(texts.SHARE_TOO_LARGE, { path: "big.txt", size: sizeText(LIMIT) }),
  );
  assert.equal(
    refused(await world.inbound.openFile?.(ref, "empty.txt")),
    fill(texts.SHARE_EMPTY, { path: "empty.txt" }),
  );
  for (const path of [".", "missing.txt", elsewhere]) {
    assert.equal(
      refused(await world.inbound.openFile?.(ref, path)),
      fill(texts.OPEN_NOT_OPENABLE, { path }),
      path,
    );
  }
});

test("a record the agent cannot read keeps the file refused", async (t) => {
  const { world, agent, ref, elsewhere } = await opening(t);
  agent.touched = async () => {
    throw new Error("unreadable");
  };
  writeFileSync(join(elsewhere, "a.txt"), "a");
  const path = join(elsewhere, "a.txt");
  assert.equal(
    refused(await world.inbound.openFile?.(ref, path)),
    fill(texts.OPEN_NOT_OPENABLE, { path }),
  );
});

test("the click is answered from state.json after a restart, with no session live", async (t) => {
  const first = await opening(t);
  writeFileSync(join(first.world.folder, "a.txt"), "after");
  const again = await MessagesWorld.make(t, {
    agent: first.agent,
    diff: true,
    fileLimit: LIMIT,
    restartOf: first.world,
  });
  assert.equal(again.sessions.held(first.ref.channel, first.ref.thread), false);
  const opened = await again.inbound.openFile?.(first.ref, "a.txt");
  assert.ok(opened && "content" in opened);
  assert.equal(opened.content.toString(), "after");
});

test("a thread with no session is answered as a top-level /open is", async (t) => {
  const { world } = await opening(t);
  const outside: ThreadRef = world.chat.openThread(world.channel);
  assert.equal(refused(await world.inbound.openFile?.(outside, "a.txt")), texts.OPEN_TOP_LEVEL);
});

test("/open with no path, in a chat with no picker, says how it is used", async (t) => {
  const { world, ref } = await opening(t);
  await world.says("/open", ref.thread);
  await world.settle();
  assert.ok(world.shown(ref).includes(texts.OPEN_NEEDS_PATH), world.shown(ref).join("\n"));
  assert.deepEqual(world.chat.shared(), []);
});

test("/open <path> in a chat with no picker shares a file a call named, outside the folder", async (t) => {
  const { world, ref, elsewhere } = await opening(t);
  const path = join(elsewhere, "named.txt");
  writeFileSync(path, "named");
  writeFileSync(join(elsewhere, "other.txt"), "other");
  const agent = world.agent as PlainAgent;
  agent.touched = async (_folder, _session, asking) => asking === path;
  await world.says(`/open ${path}`, ref.thread);
  await world.settle();
  assert.deepEqual(
    world.chat.shared().map((file) => [file.title, file.content]),
    [[path, "named"]],
  );
  // One that no call named is refused, and nothing is shared.
  await world.says(`/open ${join(elsewhere, "other.txt")}`, ref.thread);
  await world.settle();
  assert.equal(world.chat.shared().length, 1);
});

test("a path that equals a touched file only as text reads the touched file, never another one through a link", async (t) => {
  const { world, agent, ref, elsewhere } = await opening(t);
  mkdirSync(join(world.folder, "node_modules"));
  mkdirSync(join(elsewhere, "dev", "pkg"), { recursive: true });
  writeFileSync(join(world.folder, "package.json"), "inside, touched");
  writeFileSync(join(elsewhere, "package.json"), "SECRET");
  symlinkSync(join(elsewhere, "dev", "pkg"), join(world.folder, "node_modules", "pkg"));
  const named = join(world.folder, "package.json");
  agent.touched = async (_folder, _session, asking) => asking === named;
  const crafted = `${join(world.folder, "node_modules", "pkg")}/../../package.json`;
  const opened = await world.inbound.openFile?.(ref, crafted);
  if (opened !== undefined && "content" in opened) {
    assert.equal(opened.content.toString(), "inside, touched");
  }
});

test("typed /open that fails the rule answers as the click does", async (t) => {
  const { world, ref, elsewhere } = await opening(t);
  writeFileSync(join(elsewhere, "x.txt"), "x");
  await world.says(`/open ${join(elsewhere, "x.txt")}`, ref.thread);
  await world.settle();
  const path = join(elsewhere, "x.txt");
  assert.ok(
    world.shown(ref).includes(fill(texts.OPEN_NOT_OPENABLE, { path })),
    world.shown(ref).join("\n"),
  );
});
