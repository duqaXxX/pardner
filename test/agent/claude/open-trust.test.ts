/**
 * `!open` below a folder the owner trusted: the repositories inside it are the owner's to trust
 * one by one, and git runs only in those. The lookup is Claude Code's own record of trust
 * (`trustedRepository`); the listings and the changed files are the core's. A repository inside
 * the folder carries a `clean` filter in its config, which git runs when it reads a changed
 * file: the marker the filter leaves says whether git ran there.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { trustedRepository } from "../../../src/agent/claude/trust.ts";
import { changedIn } from "../../../src/core/files/changed.ts";
import { Listings } from "../../../src/core/files/listing.ts";
import { newestFirst } from "../../../src/core/files/read.ts";
import { FakeClock } from "../../support/fake-clock.ts";
import { scratch, T0, write } from "../../support/files.ts";
import { commitAt, committed, git, gitInit, trust } from "../../support/git-layouts.ts";

const tmp = scratch();

/**
 * A folder trusted in Claude Code that holds a repository the owner did not trust, whose config
 * names a `clean` filter; `command` is run once in it as the control, so that the marker the
 * filter leaves is proved to come from git.
 */
function plantedBelow(...command: string[]): {
  folder: string;
  nested: string;
  marker: string;
  home: string;
  listings: Listings;
} {
  const folder = join(tmp.dir, "app");
  const nested = realpathSync.native(committed(join(folder, "workspace")));
  const marker = join(tmp.dir, "filter-ran");
  git(nested, "config", "filter.planted.clean", `sh -c 'touch "${marker}"; cat'`);
  write(nested, ".git/info/attributes", "* filter=planted\n");
  // A tracked file of the size it was committed with: `status` reads it to tell it changed.
  write(nested, "README", "two\n");
  git(nested, ...command);
  assert.ok(existsSync(marker), "the control: git left to itself runs the planted filter");
  rmSync(marker);
  const home = join(tmp.dir, "home");
  mkdirSync(home);
  trust(home, [realpathSync.native(folder)]);
  const listings = new Listings((directory) => trustedRepository(directory, home), {
    clock: new FakeClock(),
  });
  return { folder, nested, marker, home, listings };
}

test("open alone runs no git in a nested repository the owner did not trust", async () => {
  // The changed files come from `git status`, which reads a changed file through the `clean`
  // filter the repository's config names. One request would run it in every repository below the
  // folder, also where the agent never went.
  const { folder, marker, home } = plantedBelow("status", "--porcelain");
  // The control on the view: a repository the owner did trust is listed beside it.
  const trusted = gitInit(join(folder, "elsewhere"));
  commitAt(trusted, "base.py", T0 - 1000);
  commitAt(trusted, "made.py", T0 + 500);
  trust(home, [realpathSync.native(folder), realpathSync.native(trusted)]);
  const trusting = new Listings((directory) => trustedRepository(directory, home), {
    clock: new FakeClock(),
  });
  const repositories = await trusting.repositories(folder);
  const changed = await newestFirst(folder, await changedIn(folder, repositories, T0));
  assert.deepEqual(changed, ["elsewhere/made.py"]);
  assert.ok(!existsSync(marker));
});

test("a search runs no git in a nested repository the owner did not trust, and walks its disk", async () => {
  // The folder is trusted, the repository inside it is not: git would read the repository's own
  // config. Its files come from the walk of the disk, the ones its `.gitignore` names too.
  const { nested, folder, marker, listings } = plantedBelow("diff-files", "--shortstat");
  write(nested, ".gitignore", ".venv/\n");
  write(nested, "docs/guide.md");
  write(nested, ".venv/lib/guide_tools.py");
  const found = await listings.search(folder, "guide");
  assert.deepEqual(found.paths.toSorted(), [
    "workspace/.venv/lib/guide_tools.py",
    "workspace/docs/guide.md",
  ]);
  assert.ok(!existsSync(marker));
});

test("a repository the owner did trust is read by git", async () => {
  const { folder, nested, marker, home } = plantedBelow("status", "--porcelain");
  trust(home, [realpathSync.native(folder), nested]);
  const trusting = new Listings((directory) => trustedRepository(directory, home), {
    clock: new FakeClock(),
  });
  const repositories = await trusting.repositories(folder);
  assert.deepEqual(
    repositories.map((found) => found.root),
    [nested],
  );
  const changed = await changedIn(folder, repositories, T0);
  assert.ok(changed.includes("workspace/README"), "git lists the file the config's filter reads");
  assert.ok(existsSync(marker));
});
