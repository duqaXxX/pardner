/**
 * Whether a call of a session named a file (`touched`), over synthetic transcripts of the shape
 * Claude Code writes (an `assistant` entry's `tool_use` block, a `user` entry's `tool_result`
 * block matched by `tool_use_id`; read from a real transcript, SDK 0.3.330 on 2026-11-24, and the
 * path recorded absolute for `Read`, `Edit` and `Write`).
 */
import assert from "node:assert/strict";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeBackend } from "../../../src/agent/claude/backend.ts";
import { projectKey } from "../../../src/agent/claude/listing.ts";
import { TOOLS } from "../../../src/agent/claude/tools.ts";
import { touched } from "../../../src/agent/claude/touched.ts";
import { tempDir } from "../../support/temp.ts";

const LIMIT = { timeout: 10_000 };
const SESSION = "11111111-2222-3333-4444-555555555555";
const FILE = "/somewhere/else/notes.md";

const call = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
const result = (id: string, error?: boolean) =>
  JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: "x",
          ...(error === undefined ? {} : { is_error: error }),
        },
      ],
    },
  });
const blob = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: "api-request-blob",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });

async function workspace() {
  const root = await realpath(await tempDir("pardner-touched-"));
  const folder = join(root, "folder");
  await mkdir(folder);
  const projects = join(root, "projects");
  const project = join(projects, await projectKey(folder));
  await mkdir(project, { recursive: true });
  const write = (lines: string[], ...at: string[]) =>
    writeFile(join(project, ...at), `${lines.join("\n")}\n`);
  return { folder, projects, project, write };
}

const ask = (w: { projects: string; folder: string }, path = FILE) =>
  touched(w.projects, TOOLS.files, w.folder, SESSION, path);

test("a call that ended well counts, whichever tool of the vocabulary made it", LIMIT, async () => {
  const w = await workspace();
  await w.write(
    [
      call("a", "Read", { file_path: FILE }),
      result("a", false),
      call("b", "NotebookEdit", { notebook_path: "/n.ipynb", new_source: "x" }),
      result("b"),
    ],
    `${SESSION}.jsonl`,
  );
  assert.equal(await ask(w), true);
  assert.equal(await ask(w, "/n.ipynb"), true);
});

test("a denied call does not count, nor one with no result yet", LIMIT, async () => {
  const w = await workspace();
  await w.write(
    [
      call("a", "Write", { file_path: FILE }),
      result("a", true),
      call("b", "Read", { file_path: "/b" }),
    ],
    `${SESSION}.jsonl`,
  );
  assert.equal(await ask(w), false);
  assert.equal(await ask(w, "/b"), false);
});

test("a result before its call, or for another call, does not count", LIMIT, async () => {
  const w = await workspace();
  await w.write(
    [result("a"), call("a", "Read", { file_path: FILE }), result("other")],
    `${SESSION}.jsonl`,
  );
  assert.equal(await ask(w), false);
});

test(
  "another tool's input key, or another key of the same tool, does not count",
  LIMIT,
  async () => {
    const w = await workspace();
    await w.write(
      [
        call("a", "Bash", { file_path: FILE, command: "cat" }),
        result("a"),
        call("b", "Read", { path: FILE }),
        result("b"),
        call("c", "Grep", { file_path: FILE }),
        result("c"),
      ],
      `${SESSION}.jsonl`,
    );
    assert.equal(await ask(w), false);
  },
);

test("a call in a subagent's transcript counts", LIMIT, async () => {
  const w = await workspace();
  await w.write([call("z", "Bash", { command: "ls" })], `${SESSION}.jsonl`);
  await mkdir(join(w.project, SESSION, "subagents"), { recursive: true });
  await w.write(
    [call("s", "Edit", { file_path: FILE }), result("s")],
    SESSION,
    "subagents",
    "agent-1.jsonl",
  );
  assert.equal(await ask(w), true);
});

test("an api-request-blob record is skipped, and so is a line that is no JSON", LIMIT, async () => {
  const w = await workspace();
  await w.write(
    [
      blob("a", "Read", { file_path: FILE }),
      "{not json",
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "a" }] },
      }),
    ],
    `${SESSION}.jsonl`,
  );
  assert.equal(await ask(w), false);
});

test(
  "a missing transcript, or a folder the agent has no project for, answers false",
  LIMIT,
  async () => {
    const w = await workspace();
    assert.equal(await ask(w), false);
    assert.equal(
      await touched(w.projects, TOOLS.files, join(w.folder, "other"), SESSION, FILE),
      false,
    );
  },
);

test("the back end answers through its projects directory and the vocabulary", LIMIT, async () => {
  const w = await workspace();
  await w.write([call("a", "Read", { file_path: FILE }), result("a")], `${SESSION}.jsonl`);
  const backend = new ClaudeBackend({ projects: w.projects });
  assert.equal(await backend.touched(w.folder, SESSION, FILE), true);
  assert.equal(await backend.touched(w.folder, SESSION, "/other"), false);
});

test(
  "a transcript's path is compared with its repeated separators and dots folded",
  LIMIT,
  async () => {
    const w = await workspace();
    await w.write(
      [call("a", "Read", { file_path: "/somewhere//else/./notes.md" }), result("a")],
      `${SESSION}.jsonl`,
    );
    assert.equal(await ask(w), true);
    await w.write(
      [call("b", "Read", { file_path: "else/notes.md" }), result("b")],
      `${SESSION}.jsonl`,
    );
    assert.equal(await ask(w), false);
  },
);

test(
  "a path with `..` names what the tool opened after following links, never its folded form",
  LIMIT,
  async () => {
    const w = await workspace();
    // The tool read `out/link/../secret`, which is `elsewhere/secret` when `link` leads there; the
    // folded text `out/secret` is another file that no call read.
    await w.write(
      [call("a", "Read", { file_path: "/r/out/link/../secret" }), result("a")],
      `${SESSION}.jsonl`,
    );
    assert.equal(await ask(w, "/r/out/secret"), false);
    // The same text is refused too: a `..` is an accepted refusal (a link it follows is no folded form).
    assert.equal(await ask(w, "/r/out/link/../secret"), false);
  },
);

test("only a missing record answers false: any other read error rejects", LIMIT, async () => {
  const w = await workspace();
  // A directory where the transcript should be: reading it fails with EISDIR.
  await mkdir(join(w.project, `${SESSION}.jsonl`));
  await assert.rejects(ask(w));
});

test("an answer given before the end of a long transcript leaves no descriptor open", {
  ...LIMIT,
  skip: process.platform === "win32" && "no /dev/fd on Windows",
}, async () => {
  const w = await workspace();
  const lines = [call("a", "Read", { file_path: FILE }), result("a")];
  // A tail well over one stream chunk, so the stream is still reading when the answer is known.
  for (let i = 0; i < 5000; i++) {
    lines.push(JSON.stringify({ type: "user", message: { content: "y".repeat(100) } }));
  }
  await w.write(lines, `${SESSION}.jsonl`);
  const open = async () => (await readdir("/dev/fd")).length;
  const before = await open();
  for (let i = 0; i < 50; i++) assert.equal(await ask(w), true);
  await new Promise((done) => setTimeout(done, 100));
  assert.ok((await open()) - before < 5, "the descriptors stayed open");
});
