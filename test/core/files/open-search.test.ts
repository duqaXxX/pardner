/**
 * What `/open` is answered from, without a chat: the files changed in a session (the repositories
 * of its folder, each counted from where its own HEAD was when the thread began, newest first),
 * the files a name matches, and the bytes of the file a path names. A chat module composes these
 * three calls (`Listings.repositories`, `changedIn` and `newestFirst`; `Listings.search`;
 * `regularFiles` and `readOpenable`); `changedNow` below is that composition for the first.
 * The memory chat hands the folder and the words to such a module, which
 * `test/core/flows/messages-words.test.ts` and `open.test.ts` read.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, symlinkSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { changedIn } from "../../../src/core/files/changed.ts";
import {
  type Found,
  type Listing,
  Listings,
  REPOSITORIES_TTL,
  type RepositoryLookup,
} from "../../../src/core/files/listing.ts";
import {
  NotAFile,
  newestFirst,
  readOpenable,
  regularFiles,
  TooLarge,
} from "../../../src/core/files/read.ts";
import { FakeClock } from "../../support/fake-clock.ts";
import { commitAll, POSIX, scratch, T0, write } from "../../support/files.ts";
import { commitAt, committed, gitInit } from "../../support/git-layouts.ts";
import { repositoryAt } from "../../support/repositories.ts";

const tmp = scratch();

/** The thread began at `T0`: a commit at `T0 - 1000` is older than it, one at `T0 + 500` is the session's. */
const BEFORE = T0 - 1000;
const DURING = T0 + 500;
const LIMIT = 1 << 20;

/** A repository whose first commit, `README`, is older than the thread. */
function madeBefore(path: string): string {
  gitInit(path);
  commitAt(path, "README", BEFORE);
  return path;
}

/** What `/open` with no words offers: the files changed since the thread began, newest first. */
async function changedNow(
  listings: Listings,
  folder: string,
  startedAt: number | null = T0,
): Promise<string[]> {
  const repositories = await listings.repositories(folder);
  return newestFirst(folder, await changedIn(folder, repositories, startedAt));
}

function listings(): Listings {
  return new Listings(repositoryAt, { clock: new FakeClock() });
}

/** A listing that ran out of time with `found` in hand, as a folder too large for the budget gives. */
class CutListings extends Listings {
  readonly #found: readonly string[];

  constructor(found: readonly string[]) {
    super(repositoryAt, { clock: new FakeClock() });
    this.#found = found;
  }

  override async of(): Promise<Listing> {
    return { files: this.#found, complete: false, fresh: true };
  }
}

// --- the files changed in the session ---

test("open alone lists the files changed in the session, newest first", async () => {
  const repo = madeBefore(join(tmp.dir, "app"));
  const guide = write(repo, "docs/guide.md");
  commitAll(repo, "docs");
  const older = write(repo, "notes.txt");
  utimesSync(guide, 1_790_000_100, 1_790_000_100);
  utimesSync(older, 1_790_000_000, 1_790_000_000);
  assert.deepEqual(await changedNow(listings(), repo), ["docs/guide.md", "notes.txt"]);
  utimesSync(guide, 1_790_000_000, 1_790_000_000);
  utimesSync(older, 1_790_000_100, 1_790_000_100);
  assert.deepEqual(await changedNow(listings(), repo), ["notes.txt", "docs/guide.md"]);
});

test("a session that changed nothing has no changed file", async () => {
  const repo = madeBefore(join(tmp.dir, "app"));
  assert.deepEqual(await changedNow(listings(), repo), []);
  write(repo, "new.py");
  assert.deepEqual(await changedNow(listings(), repo), ["new.py"]);
});

test("the changes are counted from where head was when the thread started", async () => {
  // Nothing is remembered: HEAD's log says where the repository stood at the thread's time, so a
  // daemon restarted since gives the same answer.
  const repo = gitInit(join(tmp.dir, "app", "workspace"));
  commitAt(repo, "base.py", BEFORE);
  commitAt(repo, "before.py", BEFORE + 500); // moved HEAD before the thread began
  commitAt(repo, "made_by_claude.py", DURING);
  write(repo, "uncommitted.py");
  const folder = join(tmp.dir, "app");
  assert.deepEqual((await changedNow(listings(), folder)).toSorted(), [
    "workspace/made_by_claude.py",
    "workspace/uncommitted.py",
  ]);
});

test("a repository made after the thread began lists every file as changed", async () => {
  const repo = committed(join(tmp.dir, "app")); // committed now: long after T0
  write(repo, "new.py");
  assert.deepEqual((await changedNow(listings(), repo)).toSorted(), ["README", "new.py"]);
});

test("a folder that is not a repository has no changed files", async () => {
  const folder = join(tmp.dir, "app");
  write(folder, "plain.txt");
  assert.deepEqual(await changedNow(listings(), folder), []);
});

test("the changes of a repository inside the folder are listed, the folder's own files are not", async () => {
  const folder = join(tmp.dir, "plain");
  const nested = madeBefore(join(folder, "workspace"));
  write(nested, "docs/new.md");
  write(folder, "notes.txt"); // outside any repository: not a change
  assert.deepEqual(await changedNow(listings(), folder), ["workspace/docs/new.md"]);
});

test("the repositories of a folder are looked up once for a short while", async () => {
  // Kept for REPOSITORIES_TTL seconds of a clock that does not move, so that a slow machine
  // cannot make the second request come too late.
  const clock = new FakeClock();
  const asked: string[] = [];
  const lookup: RepositoryLookup = (directory) => {
    asked.push(directory);
    return repositoryAt(directory);
  };
  const kept = new Listings(lookup, { clock });
  const folder = join(tmp.dir, "app");
  madeBefore(join(folder, "workspace"));
  await kept.repositories(folder);
  const first = asked.length;
  assert.ok(first > 0);
  await kept.repositories(folder);
  assert.equal(asked.length, first, "the second request found them kept");
  clock.advance(REPOSITORIES_TTL + 1);
  await kept.repositories(folder);
  assert.ok(asked.length > first, "after the time they are looked up again");
});

// --- the files a name matches ---

test("a name that matches several files lists the file names first, then the folder's file", async () => {
  const repo = madeBefore(join(tmp.dir, "app"));
  for (const name of ["docs/setup.md", "src/setup.py", "setup/a.md"]) write(repo, name);
  const found = await listings().search(repo, "setup");
  assert.deepEqual(found.paths, ["src/setup.py", "docs/setup.md", "setup/a.md"]);
  assert.equal(found.count, 3);
  assert.equal(found.complete, true);
});

test("a name that matches nothing finds nothing, and the listing is complete", async () => {
  const repo = madeBefore(join(tmp.dir, "app"));
  assert.deepEqual(await listings().search(repo, "zzz"), { paths: [], count: 0, complete: true });
});

test("the matches of a plain folder are what its disk holds", async () => {
  const folder = join(tmp.dir, "app");
  for (const name of ["a/setup.md", "b/setup.py"]) write(folder, name);
  const found = await listings().search(folder, "setup");
  assert.deepEqual(found.paths.toSorted(), ["a/setup.md", "b/setup.py"]);
});

test("a name is looked up in a folder with no repository", async () => {
  const folder = join(tmp.dir, "app");
  write(folder, "docs/Guide.md");
  write(folder, "other.txt");
  assert.deepEqual((await listings().search(folder, "guide")).paths, ["docs/Guide.md"]);
});

test("a path is an exact name even when git ignores the file, a search leaves it out", async () => {
  const repo = madeBefore(join(tmp.dir, "app"));
  write(repo, ".gitignore", "*.log\n");
  write(repo, "trace.log", "line\n");
  assert.deepEqual(await regularFiles(repo, ["trace.log"]), ["trace.log"]);
  assert.deepEqual((await listings().search(repo, "trace")).paths, []);
});

test("a search finds what git does not ignore, whatever the case of the words", async () => {
  const repo = madeBefore(join(tmp.dir, "app"));
  write(repo, "src/parser.py");
  write(repo, "src/lexer.py");
  write(repo, ".gitignore", "*.log\n");
  write(repo, "trace.log");
  const found = await listings().search(repo, "PARS");
  assert.deepEqual(found.paths, ["src/parser.py"]);
  assert.equal(found.count, 1);
});

test("the count of a search is exact even when a tracked match is gone from the disk", async () => {
  // `git ls-files` still names a tracked file deleted from the work tree.
  const repo = madeBefore(join(tmp.dir, "app"));
  for (const name of ["keep-a.py", "keep-b.py", "gone.py"]) write(repo, name);
  commitAll(repo, "three");
  unlinkSync(join(repo, "gone.py"));
  const found = await listings().search(repo, ".py");
  assert.deepEqual(found.paths.toSorted(), ["keep-a.py", "keep-b.py"]);
  assert.equal(found.count, 2);
});

test("a search in a folder of repositories leaves out what each git ignores, and keeps the folder's own files", async () => {
  const folder = join(tmp.dir, "app");
  const nested = committed(join(folder, "workspace"));
  write(nested, ".gitignore", ".venv/\n");
  write(nested, "docs/setup.md");
  write(nested, ".venv/lib/setup_tools.py");
  write(folder, "setup-notes.txt");
  const found = await listings().search(folder, "setup");
  assert.deepEqual(found.paths.toSorted(), ["setup-notes.txt", "workspace/docs/setup.md"]);
});

test("a name that matches one file of a complete listing is the one match", async () => {
  const repo = madeBefore(join(tmp.dir, "app"));
  write(repo, "src/Parser.py");
  write(repo, "src/lexer.py");
  const found = await listings().search(repo, "PARS");
  assert.deepEqual(found, { paths: ["src/Parser.py"], count: 1, complete: true });
});

test("a file made after a name matched nothing is found by the next search", async () => {
  // A kept listing is never the reason for "no match": it is made again first.
  const repo = madeBefore(join(tmp.dir, "app"));
  const kept = listings();
  assert.deepEqual((await kept.search(repo, "zzz")).paths, []);
  write(repo, "src/zzz-made-since.py");
  assert.deepEqual((await kept.search(repo, "zzz")).paths, ["src/zzz-made-since.py"]);
  assert.deepEqual((await kept.search(repo, "qqq")).paths, []);
  write(repo, "qqq-made-since.py");
  assert.deepEqual((await kept.search(repo, "qqq-")).paths, ["qqq-made-since.py"]);
});

test("a search over a listing that was cut says so, with a match or without", async () => {
  const cut = new CutListings(["a/one.py", "a/other.py"]);
  const folder = join(tmp.dir, "app");
  write(folder, "a/one.py");
  const none: Found = await cut.search(folder, "nothing-like-it");
  assert.deepEqual(none, { paths: [], count: 0, complete: false });
  const one = await cut.search(folder, "one");
  assert.deepEqual(one, { paths: ["a/one.py"], count: 1, complete: false });
  // A match of the cut listing that is no longer on the disk is dropped, never listed.
  assert.deepEqual((await cut.search(folder, "other")).paths, []);
});

// --- the file a path names ---

test("a path names a file with no git, inside a folder with none", async () => {
  const folder = join(tmp.dir, "app");
  write(folder, "plain.txt");
  assert.deepEqual(await regularFiles(folder, ["plain.txt"]), ["plain.txt"]);
  assert.deepEqual(await regularFiles(folder, ["nothing.txt"]), []);
});

test("a path's bytes are what the file holds, read once", async () => {
  const repo = madeBefore(join(tmp.dir, "app"));
  write(repo, "docs/guide.md", "# Guide\n");
  assert.deepEqual(await readOpenable(repo, "docs/guide.md", LIMIT), Buffer.from("# Guide\n"));
  assert.deepEqual(
    await readOpenable(repo, "./docs/../docs/guide.md", LIMIT),
    Buffer.from("# Guide\n"),
  );
});

test("a file the daemon may not read is no file, and the cause carries the code and never the path", {
  skip: process.platform === "win32" || process.getuid?.() === 0 ? "no closed file" : false,
}, async (t) => {
  const folder = join(tmp.dir, "app");
  const file = write(folder, "notes.md");
  chmodSync(file, 0o000);
  t.after(() => existsSync(file) && chmodSync(file, 0o600));
  const refused = await readOpenable(folder, "notes.md", LIMIT).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(refused instanceof NotAFile);
  assert.equal((refused.cause as NodeJS.ErrnoException).code, "EACCES");
  assert.ok(!String(refused.message).includes("notes.md"));
});

test("a value that leaves the folder is no file, and has no cause to log", POSIX, async () => {
  const folder = join(tmp.dir, "app");
  write(folder, "inside.txt");
  write(tmp.dir, "outside.txt");
  mkdirSync(join(folder, "docs"));
  symlinkSync(join(tmp.dir, "outside.txt"), join(folder, "link.txt"));
  for (const value of ["../outside.txt", "link.txt", "/etc/hosts", "docs"]) {
    const refused = await readOpenable(folder, value, LIMIT).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(refused instanceof NotAFile, value);
    assert.equal(refused.cause, undefined, value);
  }
  assert.equal((await readOpenable(folder, "inside.txt", LIMIT)).length, 2);
});

test("a file over the limit is too large before a byte is read, and an empty one reads as no bytes", async () => {
  const folder = join(tmp.dir, "app");
  write(folder, "big.txt", "x".repeat(11));
  write(folder, "empty.txt", "");
  await assert.rejects(readOpenable(folder, "big.txt", 10), TooLarge);
  assert.equal((await readOpenable(folder, "empty.txt", 10)).length, 0);
  assert.equal((await readOpenable(folder, "big.txt", 11)).length, 11);
});
