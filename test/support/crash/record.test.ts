/** The recorder (design 2.2) against the relay's own children: its record rebuilds the real directory. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { spawnNode } from "../../relay/child.ts";
import { DARWIN, enrolAndProve, portOf, watch } from "../../relay/process-support.ts";
import { person } from "../../relay/world.ts";
import { tempDirSync } from "../temp.ts";
import { loadBase } from "./folder.ts";
import { enumerate } from "./images.ts";
import { MODELLED, READ_ONLY, recordedBody } from "./record.ts";
import { digest, emptyBase, M, parse, replay } from "./replay.ts";

const SRC = new URL("../../../src/relay/", import.meta.url);

test("every name `src/relay/` imports from `node:fs` is modelled or read-only, in every form of the import", () => {
  const known = new Set<string>([...MODELLED, ...READ_ONLY]);
  for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(new URL(file, SRC), "utf8");
    assert.doesNotMatch(text, /require\(/, file);
    for (const m of text.matchAll(/import\s+([^;]*?)\s+from\s+["'](?:node:)?fs(\/\w+)?["']/gs)) {
      const [clause, sub] = [m[1] ?? "", m[2]];
      assert.ok(
        !sub && /^(type\s+)?\{[^}]*\}$/.test(clause),
        `${file}: ${m[0]} is a form the recorder does not read`,
      );
      for (const name of clause
        .replace(/[{}]/g, "")
        .split(",")
        .map((n) => n.trim().replace(/^type /, ""))
        .filter(Boolean))
        assert.ok(known.has(name), `${file} imports ${name}, which the recorder does not model`);
    }
  }
});

/** A recorded child: runs `args` under the recorder and returns the watch. */
const recorded = (root: string, file: string, args: string[]) =>
  watch(spawnNode(recordedBody(root, file, args)));

test(
  "a recorded `init` and a recorded start that enrols a device rebuild to the real directory",
  DARWIN,
  async (t) => {
    const root = tempDirSync("pardner-crash-");
    const file = join(tempDirSync("pardner-crash-record-"), "record");
    const dir = join(root, "relay");
    const init = recorded(root, file, ["init", "--dir", dir]);
    assert.equal(await init.exit, 0, init.err());
    const afterInit = parse(readFileSync(file, "utf8"));
    assert.equal(digest(replay(afterInit, emptyBase())), digest(loadBase(root)), "init");
    assert.equal(afterInit.filter((r) => r.op === "print").length, 2, "the two prints of init");
    const key = Buffer.from(/relay public key: ([0-9a-f]+)/.exec(init.out())?.[1] ?? "", "hex");
    const secret = Buffer.from(/enrolment secret: ([0-9a-f]+)/.exec(init.out())?.[1] ?? "", "hex");
    const serve = recorded(root, file, ["serve", "--dir", dir, "--listen", "127.0.0.1:0"]);
    const answer = await enrolAndProve(await portOf(serve), key, person(), secret);
    assert.equal(answer.type, "served");
    serve.child.kill("SIGTERM");
    assert.equal(await serve.exit, 0, serve.err());
    const recs = parse(readFileSync(file, "utf8"));
    assert.equal(digest(replay(recs, emptyBase())), digest(loadBase(root)), "init, then a start");
    for (const [name, r] of [
      ["init", afterInit],
      ["init and a start", recs],
    ] as const) {
      const { images, window, fallback } = enumerate(r, emptyBase(), M);
      t.diagnostic(
        `${name}: ${r.length} records, ${images.length} images under M, largest window ${window}`,
      );
      assert.equal(fallback, false);
    }
  },
);

test("a call the recorder does not model fails the recording", DARWIN, async () => {
  const root = tempDirSync("pardner-crash-");
  const file = join(tempDirSync("pardner-crash-record-"), "record");
  const body = `import { install } from ${JSON.stringify(new URL("./record.ts", import.meta.url).href)};
install(${JSON.stringify(root)}, ${JSON.stringify(file)});
const fs = await import("node:fs");
fs.writeFileSync(${JSON.stringify(join(root, "x"))}, "1");
try { fs.unlinkSync(${JSON.stringify(join(root, "x"))}); } catch (e) { console.log(e.message); }`;
  const child = watch(spawnNode(body));
  await child.exit;
  assert.match(child.out(), /unlinkSync is not modelled/);
  assert.throws(() => parse(readFileSync(file, "utf8")), /unmodelled call: unlinkSync/);
});

test(
  "the guard and the descriptor table: what is unmodelled fails, what moves is followed",
  DARWIN,
  async () => {
    const root = tempDirSync("pardner-crash-");
    const outside = join(tempDirSync("pardner-crash-outside-"), "o");
    const file = join(tempDirSync("pardner-crash-record-"), "record");
    const at = (p: string) => JSON.stringify(join(root, p));
    const body = `import { install } from ${JSON.stringify(new URL("./record.ts", import.meta.url).href)};
install(${JSON.stringify(root)}, ${JSON.stringify(file)});
const fs = await import("node:fs");
const t = (name, f) => { try { f(); console.log(name, "ok"); } catch (e) { console.log(name, e.message); } };
const fd = fs.openSync(${at("y")}, "w");
t("promises", () => fs.promises.writeFile(${at("y")}, "1"));
t("fd", () => fs.writevSync(fd, [Buffer.from("a")]));
t("options", () => fs.writeSync(fd, Buffer.from("a"), { offset: 0 }));
t("across", () => fs.renameSync(${at("y")}, ${JSON.stringify(outside)}));
t("into", () => fs.rename(${JSON.stringify(outside)}, ${at("w")}, () => {}));
t("data", () => fs.appendFileSync(${JSON.stringify(outside)}, ${at("y")}));
t("fchmod", () => fs.fchmod(fd, 0o600, () => {}));
await new Promise((r) => fs.close(fd, r));
const o = fs.openSync(${JSON.stringify(outside)}, "w");
fs.writeSync(o, "outside");
fs.mkdirSync(${at("d")});
const g = fs.openSync(${at("d/f")}, "w");
fs.renameSync(${at("d")}, ${at("e")});
fs.writeSync(g, "moved");
const old = fs.openSync(${at("x")}, "w");
fs.writeFileSync(${at("z")}, "z");
fs.renameSync(${at("z")}, ${at("x")});
t("replaced", () => fs.fsyncSync(old));`;
    const child = watch(spawnNode(body));
    await child.exit;
    const out = child.out();
    for (const name of ["promises", "fd", "options", "across", "into", "fchmod", "replaced"])
      assert.match(out, new RegExp(`${name} .*(not modelled)`), `${name} is refused`);
    assert.match(out, /data ok/, "a root path given as data is no path");
    const recs = parse(
      readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !l.includes("unmodelled"))
        .join("\n"),
    );
    const writes = recs.flatMap((r) => (r.op === "write" ? [r.path] : []));
    assert.deepEqual(
      writes,
      ["e/f"],
      "a write outside the root is not recorded; one under a renamed folder follows it",
    );
    assert.match(readFileSync(file, "utf8"), /"mode":/, "the mode a file got is recorded");
  },
);
