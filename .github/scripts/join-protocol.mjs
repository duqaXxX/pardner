// Joins the protocol package into one script that an engine with no module loader can run
// (JavaScriptCore in the app, a bare `vm` context on Node). No bundler: `tsc` compiles
// `src/protocol/` to CommonJS, and the modules the entry reaches are wrapped with a `require` of
// a few lines.
//
//   node .github/scripts/join-protocol.mjs <out file> [entry, default index.js]
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [target, entry = "index.js"] = process.argv.slice(2);
if (!target) {
  console.error("usage: join-protocol.mjs <out file> [entry]");
  process.exit(2);
}

const emitted = mkdtempSync(join(tmpdir(), "protocol-join-"));
try {
  const tsc = join(root, "node_modules/typescript/bin/tsc");
  const compiled = spawnSync(
    process.execPath,
    [tsc, "-p", join(root, "src/protocol/tsconfig.json"), "--outDir", emitted, "--removeComments"],
    { encoding: "utf8" },
  );
  if (compiled.status !== 0) throw new Error(`tsc failed:\n${compiled.stdout}${compiled.stderr}`);

  const files = readdirSync(emitted, { withFileTypes: true });
  if (files.some((file) => file.isDirectory())) throw new Error("the package holds a subfolder");
  const sources = new Map(
    files.map((file) => [file.name, readFileSync(join(emitted, file.name), "utf8")]),
  );

  // The modules reachable from the entry, keyed by their emitted names (`./bytes.js`).
  const reached = new Set();
  const visit = (name) => {
    if (reached.has(name)) return;
    const source = sources.get(name);
    if (source === undefined) throw new Error(`no module ${name}`);
    reached.add(name);
    for (const call of source.matchAll(/\brequire\(\s*(["'])(.*?)\1\s*\)/g)) {
      const match = /^\.\/([\w-]+\.js)$/.exec(call[2]);
      if (!match) throw new Error(`${name} requires ${call[2]}: only ./<name>.js is allowed`);
      visit(match[1]);
    }
  };
  visit(entry);

  const modules = [...reached].sort().map(
    (name) =>
      `${JSON.stringify(`./${name}`)}: function (module, exports, require) {\n${sources.get(name)}\n}`,
  );
  writeFileSync(
    target,
    `var protocol = (function () {
  var modules = {\n${modules.join(",\n")}\n  };
  var loaded = {};
  function require(name) {
    if (loaded[name]) return loaded[name].exports;
    if (!modules[name]) throw new Error('no module ' + name);
    var module = (loaded[name] = { exports: {} });
    modules[name](module, module.exports, require);
    return module.exports;
  }
  return require(${JSON.stringify(`./${entry}`)});
})();
`,
  );
  console.log(`joined ${reached.size} modules into ${target}`);
} finally {
  rmSync(emitted, { recursive: true, force: true });
}
