/**
 * The model's sequences, replayed (design 3, 8.1 S5): each script of `test/fixtures/replay/` was
 * recorded from a run of the protocol model, with the relay's answers the model gave, and plays here
 * against a relay in a child process of its own. A script that no longer gets its outcomes means the
 * relay, the package or the interpreter changed what the model's rules say.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { RelayProcess } from "../support/scripted-device/relay-process.ts";
import { parse, run } from "../support/scripted-device/script.ts";
import { DARWIN } from "./process-support.ts";

const FIXTURES = new URL("../fixtures/replay/", import.meta.url);

for (const name of readdirSync(FIXTURES).filter((n) => n.endsWith(".jsonl"))) {
  test(`replay ${name}`, { ...DARWIN, timeout: 120_000 }, async () => {
    const relay = new RelayProcess();
    try {
      await run(
        parse(readFileSync(new URL(name, FIXTURES), "utf8")),
        await relay.open(),
        undefined,
        relay,
      );
    } finally {
      await relay.close();
      rmSync(dirname(relay.dir), { recursive: true, force: true });
    }
  });
}
