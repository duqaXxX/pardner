import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { connect as tcp } from "node:net";
import { join } from "node:path";
import { mock, test } from "node:test";
import { lockDirectory, relayPublicKey } from "../../src/relay/directory.ts";
import { FIGURES } from "../../src/relay/limits.ts";
import { run } from "../../src/relay/main.ts";
import { nodeSeam } from "../../src/relay/round.ts";
import { tempDirSync } from "../support/temp.ts";
import { relayChild as child } from "./child.ts";
import { makeRelayDir } from "./support.ts";

const DARWIN = {
  skip: process.platform === "darwin" ? false : "the directory lock is the macOS mechanism",
};
const POSIX = {
  skip: process.platform === "win32" ? "a signal kills the child on Windows" : false,
};

function finish(proc: ReturnType<typeof child>, signal?: NodeJS.Signals, after = 0) {
  let out = "";
  let err = "";
  proc.stdout?.on("data", (d) => (out += d));
  proc.stderr?.on("data", (d) => (err += d));
  const guard = setTimeout(() => proc.kill("SIGKILL"), 20_000);
  if (signal) setTimeout(() => proc.kill(signal), after);
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) =>
    proc.on("close", (code) => {
      clearTimeout(guard);
      resolve({ code, out, err });
    }),
  );
}

test("a relative --dir is refused for being relative, and nothing is made (2-C7)", async () => {
  const lines: string[] = [];
  const before = readdirSync(process.cwd());
  const quiet = { exec: () => {}, out: () => {}, err: (l: string) => void lines.push(l) };
  assert.equal(await run(["init", "--dir", "relative-relay-dir"], quiet), 1);
  assert.match(lines.join("\n"), /absolute/);
  assert.deepEqual(readdirSync(process.cwd()), before);
});

test("a command with a missing or wrong argument fails with 1 and says what is wrong", async () => {
  const quiet = { exec: () => {}, out: () => {}, err: () => {} };
  assert.equal(await run([], quiet), 1);
  assert.equal(await run(["nothing"], quiet), 1);
  assert.equal(await run(["init"], quiet), 1);
  assert.equal(await run(["serve", "--dir", tempDirSync("pardner-relay-")], quiet), 1);
  assert.equal(await run(["serve", "--dir", "/x", "--listen", "nowhere"], quiet), 1);
  assert.equal(await run(["serve", "--dir", "/x", "--listen", "host:99999"], quiet), 1);
  assert.equal(await run(["init", "--dir", "/x", "--listen", "a:1"], quiet), 1);
});

test("init prints the key and the secret and exits 0", async () => {
  const dir = join(tempDirSync("pardner-relay-"), "relay");
  const done = await finish(child(["init", "--dir", dir]));
  assert.equal(done.code, 0, done.err);
  const publicHex = Buffer.from(relayPublicKey(readFileSync(join(dir, "key.pem")))).toString("hex");
  assert.ok(done.out.includes(publicHex));
  assert.match(done.out.replace(publicHex, ""), /[0-9a-f]{64}/);
  const again = await finish(child(["init", "--dir", dir]));
  assert.equal(again.code, 1);
  assert.doesNotMatch(again.out, /[0-9a-f]{64}/);
});

test("serve on a missing directory waits, and SIGTERM ends it with 0", POSIX, async () => {
  const dir = join(tempDirSync("pardner-relay-"), "relay");
  const done = await finish(
    child(["serve", "--dir", dir, "--listen", "127.0.0.1:0"]),
    "SIGTERM",
    1500,
  );
  assert.equal(done.code, 0, done.err);
  assert.match(done.err, /waiting/);
  assert.deepEqual(readdirSync(join(dir, "..")), []);
});

test("serve picks up a directory that init makes while it waits", DARWIN, async () => {
  const root = tempDirSync("pardner-relay-");
  const dir = join(root, "relay");
  const serving = finish(
    child(["serve", "--dir", dir, "--listen", "127.0.0.1:0"]),
    "SIGTERM",
    5000,
  );
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal((await finish(child(["init", "--dir", dir]))).code, 0);
  const done = await serving;
  assert.equal(done.code, 0, done.err);
  assert.match(done.err, /waiting/);
  assert.match(done.err, /serving/);
});

test("a second serve on one directory exits 1, naming the other relay", DARWIN, async () => {
  const dir = join(tempDirSync("pardner-relay-"), "relay");
  assert.equal((await finish(child(["init", "--dir", dir]))).code, 0);
  const first = finish(child(["serve", "--dir", dir, "--listen", "127.0.0.1:0"]), "SIGTERM", 3000);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const second = await finish(child(["serve", "--dir", dir, "--listen", "127.0.0.1:0"]));
  assert.equal(second.code, 1);
  assert.match(second.err, /another relay/);
  assert.equal((await first).code, 0);
});

test("a trailing slash in --dir is the same directory (2-CR4)", async () => {
  const root = tempDirSync("pardner-relay-");
  const quiet = { exec: () => {}, out: () => {}, err: () => {} };
  assert.equal(await run(["init", "--dir", `${join(root, "relay")}/`], quiet), 0);
  assert.ok(readdirSync(join(root, "relay")).includes("key.pem"));
});

test("a rename that fails through main exits 1 and says the values are void (9.2 #7)", async () => {
  const root = tempDirSync("pardner-relay-");
  const dir = join(root, "relay");
  mkdirSync(dir);
  const lines: string[] = [];
  let first = true;
  const code = await run(["init", "--dir", dir], {
    exec: () => {},
    err: (l) => lines.push(l),
    out: () => {
      if (!first) return;
      first = false;
      writeFileSync(join(dir, "appeared"), "x");
    },
  });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /void/);
  assert.deepEqual(readdirSync(root), ["relay"]);
});

/** `serve` in this process, with a seam that never exits, to read the code it returns (design 2.4). */
function serveWith(dir: string, over: Parameters<typeof run>[1]) {
  const lines: string[] = [];
  const seam = { ...nodeSeam, stop: () => {} };
  const args = ["serve", "--dir", dir, "--listen", "127.0.0.1:0"];
  return { lines, code: run(args, { seam, err: (l) => void lines.push(l), ...over }) };
}

test(
  "exit codes: SIGTERM 0, a held directory 1, an exclusion failure 1, an fsync error 75",
  DARWIN,
  async () => {
    let signal = () => {};
    const waiting = serveWith(join(tempDirSync("pardner-relay-"), "none"), {
      exec: () => {},
      signals: (handler) => {
        signal = handler;
        return () => {};
      },
    });
    setTimeout(() => signal(), 100);
    assert.equal(await waiting.code, 0);

    const dir = tempDirSync("pardner-relay-");
    makeRelayDir(dir);
    const held = lockDirectory(dir);
    assert.equal(await serveWith(dir, { exec: () => {} }).code, 1);
    closeSync(held);

    const failing = serveWith(dir, {
      exec: async () => {
        throw Object.assign(new Error("x"), { code: 1 });
      },
    });
    assert.equal(await failing.code, 1);
    assert.match(failing.lines.join("\n"), /exit status 1/);

    const broken = serveWith(dir, {
      exec: () => {},
      seam: {
        ...nodeSeam,
        stop: () => {},
        sync: async () => {
          throw Object.assign(new Error("x"), { code: "EIO", syscall: "fsync" });
        },
      },
    });
    assert.equal(await broken.code, 75);
  },
);

test(
  "serve whose certificate cannot be made exits 1 with a log line, no stack, no path (2.4, 2-C5)",
  DARWIN,
  async (t) => {
    // The directory accepts only a P-256 key, which always signs: the failure is made at the signature.
    const failing = mock.method(crypto, "sign", () => {
      throw Object.assign(new Error("boom at a real path"), { code: "ERR_BOOM" });
    });
    syncBuiltinESMExports();
    t.after(() => {
      failing.mock.restore();
      syncBuiltinESMExports();
    });
    for (const marked of [false, true]) {
      const dir = join(tempDirSync("pardner-relay-"), "relay");
      makeRelayDir(dir);
      if (marked) writeFileSync(join(dir, "failed-closed"), "x");
      const lines: string[] = [];
      const code = await run(["serve", "--dir", dir, "--listen", "127.0.0.1:0"], {
        exec: () => {},
        err: (l) => void lines.push(l),
      });
      const log = lines.join("\n");
      assert.equal(code, 1, log);
      assert.match(
        log,
        /ERROR relay: the relay key cannot serve \(code=ERR_BOOM syscall=unknown\)/,
      );
      assert.doesNotMatch(log, /\n\s+at |node_modules|\.ts:\d|pardner-relay-|real path/);
    }
  },
);

test(
  "a serving relay removes the unnamed blobs past their time on its own timer (3.11)",
  DARWIN,
  async () => {
    const dir = tempDirSync("pardner-relay-");
    makeRelayDir(dir);
    const blob = join(dir, "blobs", "ab".repeat(32));
    writeFileSync(blob, "bytes nobody names");
    let signal = () => {};
    let skew = 0;
    const serving = serveWith(dir, {
      exec: () => {},
      expireMs: 20,
      seam: { ...nodeSeam, stop: () => {}, now: () => Date.now() + skew },
      signals: (handler) => {
        signal = handler;
        return () => {};
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(blob), true, "not before its time");
    skew = 25 * 3600 * 1000;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(blob), false, "after it");
    signal();
    assert.equal(await serving.code, 0);
  },
);

test(
  "a serving relay whose directory was replaced removes no blob on its timer and stops with 75 (3.7, 3.11)",
  DARWIN,
  async () => {
    const parent = tempDirSync("pardner-relay-");
    const dir = join(parent, "relay");
    makeRelayDir(dir);
    const blob = join(dir, "blobs", "ab".repeat(32));
    writeFileSync(blob, "bytes nobody names");
    let signal = () => {};
    let skew = 0;
    const stops: number[] = [];
    const serving = serveWith(dir, {
      exec: () => {},
      expireMs: 20,
      seam: { ...nodeSeam, stop: (code) => void stops.push(code), now: () => Date.now() + skew },
      signals: (handler) => {
        signal = handler;
        return () => {};
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Another directory put at the path: what is in it is not the relay's.
    renameSync(dir, join(parent, "away"));
    makeRelayDir(dir);
    writeFileSync(blob, "bytes of another directory");
    skew = 25 * 3600 * 1000;
    await new Promise((resolve) => setTimeout(resolve, 100));
    signal();
    await serving.code;
    assert.equal(existsSync(blob), true, "a directory that is not the relay's loses nothing");
    assert.deepEqual(stops, [75]);
  },
);

/** Serves a made directory with `figures`, opens `count` connections with no proof, and returns for each whether the relay closed it. */
async function closedOf(count: number, figures?: typeof FIGURES) {
  const dir = tempDirSync("pardner-relay-");
  makeRelayDir(dir);
  let signal = () => {};
  const serving = serveWith(dir, {
    exec: () => {},
    signals: (handler) => {
      signal = handler;
      return () => {};
    },
    ...(figures ? { figures } : {}),
  });
  let port = 0;
  for (let i = 0; i < 100 && port === 0; i++) {
    port = Number(/listening on port (\d+)/.exec(serving.lines.join("\n"))?.[1] ?? 0);
    if (port === 0) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const sockets = Array.from({ length: count }, () => {
    const socket = tcp(port, "127.0.0.1");
    socket.on("error", () => {});
    return socket;
  });
  // The relay admits in the order it accepts, so the first close that arrives is the first connection past the limit.
  await new Promise((resolve) => {
    for (const s of sockets) s.once("close", resolve);
  });
  const closed = sockets.map((s) => s.destroyed);
  for (const socket of sockets) socket.destroy();
  signal();
  assert.equal(await serving.code, 0);
  return closed;
}

test(
  "figures: with none given the production ones are in force; a given one replaces them (scripted device 5.4)",
  DARWIN,
  async () => {
    assert.equal(FIGURES.unproven.fine, 4);
    assert.deepEqual(await closedOf(5), [false, false, false, false, true]);
    const wider = { ...FIGURES, unproven: { ...FIGURES.unproven, fine: 6 } };
    assert.deepEqual(await closedOf(7, wider), [false, false, false, false, false, false, true]);
  },
);
