import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { tempDirSync } from "../support/temp.ts";
import { MAIN, relayChild } from "./child.ts";

const DARWIN = {
  skip: process.platform === "darwin" ? false : "the directory lock is the macOS mechanism",
};
const CHILD = new URL("./child.ts", import.meta.url).href;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test(
  "a relay a test spawned ends when its test process is killed (no child left behind a timeout)",
  DARWIN,
  async () => {
    const dir = join(tempDirSync("pardner-relay-"), "relay");
    const init = relayChild(["init", "--dir", dir]);
    assert.equal(await new Promise((resolve) => init.on("close", resolve)), 0);
    const parent = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { spawnNode } from ${JSON.stringify(CHILD)};
const child = spawnNode(\`import { run } from ${JSON.stringify(MAIN)};
process.exitCode = await run(["serve", "--dir", ${JSON.stringify(dir)}, "--listen", "127.0.0.1:0"], { exec: () => {} });\`);
child.stderr.on("data", (d) => /listening on port/.test(d) && console.log("pid " + child.pid));
setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let pid = 0;
    try {
      pid = await new Promise<number>((resolve, reject) => {
        let out = "";
        parent.stdout.on("data", (d) => {
          out += d;
          const m = /pid (\d+)/.exec(out);
          if (m) resolve(Number(m[1]));
        });
        parent.once("close", () => reject(new Error(`no relay started: ${out}`)));
      });
      assert.ok(alive(pid));
      parent.kill("SIGKILL");
      for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(alive(pid), false, "the relay outlived its test process");
    } finally {
      if (pid !== 0 && alive(pid)) process.kill(pid, "SIGKILL");
    }
  },
);
