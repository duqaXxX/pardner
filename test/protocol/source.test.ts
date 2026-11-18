/**
 * What the protocol package's sources may not contain (protocol-package design, 2.4). The compiler
 * settings of `src/protocol/tsconfig.json` keep out the globals of Node and of a browser; this
 * reads what the language's own library has and the rules forbid.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { blank } from "../support/source-scan.ts";

const PACKAGE = join(import.meta.dirname, "..", "..", "src", "protocol");

const FORBIDDEN: readonly [RegExp, string][] = [
  [/\brequire\s*\(/, "require("],
  [/\bimport\s*\(/, "a dynamic import("],
  [/\beval\b/, "eval"],
  [/\bFunction\b/, "Function"],
  [/\bMath\s*\.\s*random\b/, "Math.random"],
  [/\bDate\b/, "Date"],
  [/\binstanceof\b/, "instanceof"],
  [/\bglobalThis\b/, "globalThis"],
  [/\b(?:async|await|Promise)\b/, "async, await or Promise"],
];

// A static import or re-export; the dynamic forms are in FORBIDDEN.
const IMPORT = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']/g;

/** Whether a string or an identifier of `source` holds the product's name, old or new. */
function naming(source: string): boolean {
  return /allaboard|pardner/i.test(blank(source, { keepText: true }));
}

/** What `source`, a file of the package, contains that the rules forbid. */
export function violations(source: string): string[] {
  const found: string[] = [];
  const code = blank(source);
  for (const [pattern, name] of FORBIDDEN) if (pattern.test(code)) found.push(name);
  for (const match of blank(source, { keepText: true }).matchAll(IMPORT)) {
    const specifier = match[1] as string;
    if (!/^\.\/[\w-]+\.ts$/.test(specifier)) found.push(`the import of ${specifier}`);
  }
  if (/allaboard|pardner/i.test(blank(source, { keepText: true })))
    found.push("the product's name");
  return found;
}

test("the scan finds each thing the package may not contain", () => {
  const names = [
    'import { a } from "node:crypto";',
    'import { b } from "../core/state.ts";',
    'const c = require("./x.ts");',
    'const d = await import("./x.ts");',
    'const e = eval("1");',
    "const f = new Function();",
    "const g = Math.random();",
    "const h = Date.now();",
    "const i = x instanceof Y;",
    "const j = globalThis;",
    "async function k() {}",
    "const l = Promise.resolve();",
    'const m = "Allaboard";',
    "const pardnerKey = 1;",
  ];
  for (const line of names) assert.notDeepEqual(violations(line), [], line);
  assert.deepEqual(
    violations(
      'import type { A } from "./platform.ts";\n// Date, async and allaboard in a comment\n',
    ),
    [],
  );
});

test("the package holds no subfolder", () => {
  const folders = readdirSync(PACKAGE, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.deepEqual(folders, []);
});

test("every file of the package keeps the rules", () => {
  const files = readdirSync(PACKAGE).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0);
  const broken = files.flatMap((name) =>
    violations(readFileSync(join(PACKAGE, name), "utf8")).map((why) => `${name}: ${why}`),
  );
  assert.deepEqual(broken, []);
});

test("the platform on Node names no product either", () => {
  const folder = join(PACKAGE, "..", "platform-node");
  const files = readdirSync(folder).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0);
  const named = files.filter((name) => naming(readFileSync(join(folder, name), "utf8")));
  assert.deepEqual(named, []);
  assert.equal(naming('const m = "Pardner";'), true);
  assert.equal(naming("// allaboard in a comment"), false);
});
