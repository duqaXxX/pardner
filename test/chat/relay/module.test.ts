import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pairingName, relayChat } from "../../../src/chat/relay/module.ts";
import { loadPairing } from "../../../src/chat/relay/pairing.ts";
import { configDirOf, DEFAULT_INSTANCE } from "../../../src/core/instance.ts";
import type { ChatContext, ChatEntry } from "../../../src/core/port.ts";
import { ConfigError, singleInstance } from "../../../src/core/port.ts";
import { answerWizard } from "../../../src/core/wizard.ts";
import type { ModuleSetup } from "../../../src/module-setup.ts";
import { createNodePlatform } from "../../../src/platform-node/platform.ts";
import { decodePairingString, shortForm } from "../../../src/protocol/pairing-string.ts";
import { tempDirSync } from "../../support/temp.ts";

const RELAY = `04${"ab".repeat(64)}`;
// A point of P-256: the generator.
const GENERATOR =
  "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";
const OWNER = "cd".repeat(32);

/** Runs the wizard for the relay chat, answering `answers` in order; null ends it. */
async function wizard(
  home: string,
  answers: (string | null)[],
  entry: ChatEntry = relayChat(),
  brand?: readonly string[],
) {
  const out: string[] = [];
  let next = 0;
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    {
      chat: entry,
      agents: { plain: brand ? { brand } : {} },
      defaults: { agent: "plain" },
    },
    { out: (text) => out.push(text), err: (text) => out.push(text) },
    {
      home,
      interactive: true,
      installService: null,
      prompter: {
        ask: async () => answers[next++] ?? null,
        choose: async (_message, names) => names[0] ?? null,
      },
    },
  );
  return { code, text: out.join("") };
}
const full = (home: string) => ["127.0.0.1:4433", GENERATOR, OWNER, "", "", home]; // the bot's name and icon skipped

test("the wizard pairs the bot after it wrote .env, and prints the string last", async () => {
  const home = tempDirSync("pardner-home-");
  const { code, text } = await wizard(home, full(home));
  const dir = configDirOf(DEFAULT_INSTANCE, home);
  assert.equal(code, 0, text);
  assert.ok(existsSync(join(dir, ".env")));
  assert.equal(Buffer.from(loadPairing(dir).person).toString("hex"), OWNER);
  assert.match(
    text,
    /Wrote .*\.env[\s\S]*Paired\. Add this device on your side with:\n[0-9a-f]{200,}\nName: .+\nDevice: [0-9a-f]{4}(-[0-9a-f]{4}){3}\n/,
  );
});

test("setup prints the name and the short form that the string carries", async () => {
  const home = tempDirSync("pardner-home-");
  const answers = ["127.0.0.1:4433", GENERATOR, OWNER, "Studio Mac", "", home];
  const { code, text } = await wizard(home, answers);
  assert.equal(code, 0, text);
  const string = /with:\n([0-9a-f]+)\n/.exec(text)?.[1] as string;
  const decoded = decodePairingString(createNodePlatform(), string);
  assert.ok(decoded.ok);
  assert.equal(decoded.value.name, "Studio Mac");
  const short = shortForm(createNodePlatform(), decoded.value.device);
  assert.ok(text.includes("Name: Studio Mac\n"));
  assert.ok(text.includes(`Device: ${short}\n`));
});

test("a bot name past 64 bytes is refused at the question, not at the end", async () => {
  const home = tempDirSync("pardner-home-");
  const long = "é".repeat(32); // 32 characters, 64 bytes: the limit
  const tooLong = "漢".repeat(32); // 32 characters, 96 bytes
  const { code, text } = await wizard(home, [
    "127.0.0.1:4433",
    GENERATOR,
    OWNER,
    tooLong,
    long,
    "",
    home,
  ]);
  assert.equal(code, 0, text);
  assert.match(text, /64 bytes/);
  assert.ok(text.includes(`Name: ${long}\n`));
});

test("a bot name holding the agent's brand is refused at the question, as the start refuses it", async () => {
  const home = tempDirSync("pardner-home-");
  const answers = ["127.0.0.1:4433", GENERATOR, OWNER, "Acme Agent Mac", "Studio Mac", "", home];
  const { code, text } = await wizard(home, answers, relayChat(), ["Acme Agent"]);
  assert.equal(code, 0, text);
  assert.match(text, /may not hold "Acme Agent"/);
  assert.ok(text.includes("Name: Studio Mac\n"));
  assert.ok(!text.includes("Name: Acme Agent Mac"));
});

test("a wizard ended before .env is written leaves no keys and no pairing", async () => {
  const home = tempDirSync("pardner-home-");
  const { code, text } = await wizard(home, ["127.0.0.1:4433", GENERATOR, OWNER, null]);
  const dir = configDirOf(DEFAULT_INSTANCE, home);
  assert.equal(code, 130);
  assert.match(text, /nothing was written/);
  assert.ok(!existsSync(dir) || readdirSync(dir).length === 0, "files left behind");
});

test("C14: setup is refused while the instance lock is held, before .env or any key exists", async () => {
  const home = tempDirSync("pardner-home-");
  const dir = configDirOf(DEFAULT_INSTANCE, home);
  mkdirSync(dir, { recursive: true });
  const held = await singleInstance(dir);
  try {
    const { code, text } = await wizard(home, full(home));
    assert.equal(code, 1);
    assert.match(
      text,
      /this instance is running, or another setup is: stop it, then run setup again/,
    );
    assert.ok(!/[0-9a-f]{200,}/.test(text));
    // What the held lock leaves in the directory is per platform (src/core/lock.ts header): nothing
    // for the flock of macOS and the named pipe of Windows, the `lock.sock` socket on Linux.
    assert.deepEqual(readdirSync(dir), process.platform === "linux" ? ["lock.sock"] : []);
  } finally {
    await held.release();
  }
});

test("C14: the wizard holds the instance lock from before .env through the pairing, and lets it go", async () => {
  const home = tempDirSync("pardner-home-");
  const dir = configDirOf(DEFAULT_INSTANCE, home);
  const inner = relayChat();
  const seen: string[] = [];
  const probe = async (when: string) => {
    await assert.rejects(singleInstance(dir), { name: "AlreadyRunning" });
    seen.push(when);
  };
  const entry = {
    ...inner,
    setup: (instance: typeof DEFAULT_INSTANCE) => {
      const setup = inner.setup?.(instance) as ModuleSetup;
      return {
        ...setup,
        finish: async (configDir: string, values: Readonly<Record<string, string>>) => {
          await probe("before");
          assert.ok(existsSync(join(configDir, ".env")));
          const lines = await (setup.finish as NonNullable<ModuleSetup["finish"]>)(
            configDir,
            values,
          );
          await probe("after");
          return lines;
        },
      };
    },
  };
  const { code } = await wizard(home, full(home), entry);
  assert.equal(code, 0);
  assert.deepEqual(seen, ["before", "after"]);
  await (await singleInstance(dir)).release();
});

test("a failed pairing step says what to do and prints no string", async () => {
  const home = tempDirSync("pardner-home-");
  const entry = relayChat();
  const failing = {
    ...entry,
    setup: (instance: typeof DEFAULT_INSTANCE) => ({
      ...(entry.setup?.(instance) as ModuleSetup),
      finish: async () => {
        throw new Error("the disk said no");
      },
    }),
  };
  const { code, text } = await wizard(home, full(home), failing);
  assert.equal(code, 1);
  assert.match(text, /the last step of the chat setup failed: the disk said no/);
  assert.match(text, /\.env is written\. Move it away, then run setup again\./);
});

test("setup refuses a wrong shape before anything is asked next", async () => {
  const setup = relayChat().setup?.(DEFAULT_INSTANCE);
  const check = (variable: string, answer: string) =>
    setup?.questions.find((q) => q.variable === variable)?.check(answer);
  for (const [variable, answer] of [
    ["RELAY_ADDRESS", "no-port"],
    ["RELAY_ADDRESS", "host:0"],
    ["RELAY_ADDRESS", "host:65536"],
    ["RELAY_KEY", "abcd"],
    ["RELAY_KEY", RELAY], // 130 digits that are not a point of the curve
    ["RELAY_KEY", `07${GENERATOR.slice(2)}`], // a hybrid-form point
    ["RELAY_OWNER", "xyz"],
  ] as const) {
    const checked = await check(variable, answer);
    assert.ok(checked && "refusal" in checked, `${variable} ${answer.slice(0, 12)}`);
  }
  for (const [variable, answer] of [
    ["RELAY_ADDRESS", "[::1]:4433"],
    ["RELAY_ADDRESS", "relay.example:443"],
    ["RELAY_KEY", GENERATOR],
  ] as const) {
    const checked = await check(variable, answer);
    assert.ok(checked && !("refusal" in checked), `${variable} ${answer.slice(0, 12)}`);
  }
});

test("build refuses a start without the configuration directory, and a variable that differs from the pairing", async () => {
  const home = tempDirSync("pardner-home-");
  await wizard(home, full(home));
  const entry = relayChat();
  const dir = configDirOf(DEFAULT_INSTANCE, home);
  const context = (variables: Record<string, string>, configDir?: string) =>
    ({ variables, ...(configDir ? { configDir } : {}) }) as unknown as ChatContext;
  const good = { RELAY_ADDRESS: "127.0.0.1:4433", RELAY_KEY: GENERATOR, RELAY_OWNER: OWNER };
  await assert.rejects(entry.build(context(good)), ConfigError);
  await assert.rejects(
    entry.build(context({ ...good, RELAY_OWNER: "ee".repeat(32) }, dir)),
    (e) =>
      e instanceof ConfigError && /RELAY_OWNER/.test(e.message) && /\.env away/.test(e.message),
  );
  await assert.rejects(
    entry.build(context({ ...good, RELAY_KEY: RELAY }, dir)),
    (e) => e instanceof ConfigError && /RELAY_KEY/.test(e.message),
  );
});

test("a configuration directory that cannot be made is reported as a write failure", async () => {
  const home = tempDirSync("pardner-home-");
  // A file where the ".config" folder should be.
  writeFileSync(join(home, ".config"), "");
  const { code, text } = await wizard(home, full(home));
  assert.equal(code, 1);
  assert.match(text, /could not write .*\.env: /);
});

test("a default name the pairing string cannot carry is refused, naming what to do", () => {
  assert.equal(pairingName({}, undefined, [], "studio.local"), "studio");
  assert.equal(pairingName({ PARDNER_BOT_NAME: "Studio Mac" }, undefined, [], "x"), "Studio Mac");
  assert.equal(pairingName({}, undefined, ["Acme Agent"], "acme-agent-mini.local"), "bot");
  for (const host of [`${"日".repeat(40)}.local`, "Mac\u200bmini.local"]) {
    assert.throws(
      () => pairingName({}, undefined, [], host),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /^PARDNER_BOT_NAME: .*type a name\.$/);
        return true;
      },
    );
  }
});
