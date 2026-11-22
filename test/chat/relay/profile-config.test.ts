/**
 * The bot's name and icon as the relay module reads them at start (bot-profile design 4.1): the
 * host's name by default, the configured values checked, and what stops the start.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { configuredProfile } from "../../../src/chat/relay/module.ts";
import { ConfigError } from "../../../src/core/port.ts";
import { tempDirSync } from "../../support/temp.ts";

const BRAND = ["Acme Agent"]; // a stand-in for the agent's `AgentWords.brand`
const of = (variables: Record<string, string>, instance?: string, host = "mini.local") =>
  configuredProfile({ variables, brand: BRAND, ...(instance && { instance }) }, host);
const refused = (variables: Record<string, string>, says: RegExp) =>
  assert.throws(
    () => of(variables),
    (e: Error) => e instanceof ConfigError && says.test(e.message),
  );

/** A PNG of `w` by `h` pixels: the signature, IHDR and IEND, which is all the profile reads. */
function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "ascii");
    const n = Buffer.alloc(4);
    n.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([n, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IEND", Buffer.alloc(0))]);
}

test("by default the name is the host's up to its first dot, then the instance's", () => {
  assert.deepEqual(of({}), { name: "mini" });
  assert.deepEqual(of({}, "dev"), { name: "mini-dev" });
  assert.deepEqual(
    of({}, undefined, "mac@home"),
    { name: "machome" },
    "what a profile refuses is left out",
  );
  assert.deepEqual(of({}, undefined, "x".repeat(40)), { name: "x".repeat(32) }, "cut to 32");
  assert.deepEqual(of({}, undefined, "@@@"), { name: "bot" }, "nothing left");
  assert.deepEqual(of({}, undefined, "acme-agent.local"), { name: "bot" }, "the agent's brand");
});

test("a configured name is taken as written, and one a profile refuses stops the start, naming the variable", () => {
  assert.deepEqual(of({ PARDNER_BOT_NAME: "Studio Mac" }), { name: "Studio Mac" });
  refused({ PARDNER_BOT_NAME: "a@b" }, /^PARDNER_BOT_NAME: write 1 to 32 characters/);
  refused({ PARDNER_BOT_NAME: " mini" }, /^PARDNER_BOT_NAME/);
  refused({ PARDNER_BOT_NAME: "x".repeat(33) }, /^PARDNER_BOT_NAME/);
  refused({ PARDNER_BOT_NAME: "" }, /^PARDNER_BOT_NAME/);
});

test("a configured name is stricter than a reader: NFC, no format character, no brand of the agent's", () => {
  refused({ PARDNER_BOT_NAME: "Café" }, /NFC/);
  refused({ PARDNER_BOT_NAME: "mi​ni" }, /format character/);
  refused({ PARDNER_BOT_NAME: "mi‮ni" }, /format character/);
  refused({ PARDNER_BOT_NAME: "mi\u{fe0f}ni" }, /^PARDNER_BOT_NAME: write 1 to 32 characters/);
  refused({ PARDNER_BOT_NAME: "my ACME_agent" }, /may not hold "Acme Agent"/);
  refused({ PARDNER_BOT_NAME: "acme.agent-2" }, /may not hold/);
  assert.deepEqual(of({ PARDNER_BOT_NAME: "Café" }), { name: "Café" });
});

test("an icon is read from its absolute path, and one a profile refuses stops the start", () => {
  const dir = tempDirSync("pardner-icon-");
  const good = join(dir, "icon.png");
  writeFileSync(good, png(64, 64));
  const wide = join(dir, "wide.png");
  writeFileSync(wide, png(64, 32));
  assert.deepEqual(of({ PARDNER_BOT_ICON: good }).icon, new Uint8Array(png(64, 64)));
  refused({ PARDNER_BOT_ICON: wide }, /^PARDNER_BOT_ICON: the icon is a square PNG or JPEG/);
  refused({ PARDNER_BOT_ICON: "icon.png" }, /absolute path/);
  refused({ PARDNER_BOT_ICON: join(dir, "missing.png") }, /cannot be read/);
});
