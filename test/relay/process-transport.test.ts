/**
 * Process-level test 6 of design 9.2: `node src/relay/main.ts serve` over real TLS on 127.0.0.1 with an
 * ephemeral port. The limits that take ten seconds are the real ones here; `transport.test.ts` holds
 * the same checks with short ones.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type Socket, connect as tcp } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { connect as tls } from "node:tls";
import { relayPublicKey } from "../../src/relay/directory.ts";
import { dial } from "../support/scripted-device/link.ts";
import { tempDirSync } from "../support/temp.ts";
import { relayChild as run } from "./child.ts";
import { platform } from "./support.ts";

const DARWIN = {
  skip: process.platform === "darwin" ? false : "the directory lock is the macOS mechanism",
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Makes a relay directory with `init` and serves it; resolves once the log names the port. */
async function serving() {
  const dir = join(tempDirSync("pardner-relay-"), "relay");
  const init = run(["init", "--dir", dir]);
  assert.equal(await new Promise((resolve) => init.on("close", resolve)), 0);
  const child = run(["serve", "--dir", dir, "--listen", "127.0.0.1:0"]);
  let err = "";
  child.stderr?.on("data", (d) => {
    err += d;
  });
  const exit = new Promise<number | null>((resolve) => child.on("close", resolve));
  const guard = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let port = 0;
  for (let i = 0; i < 400 && port === 0; i++) {
    port = Number(/listening on port (\d+)/.exec(err)?.[1] ?? 0);
    if (port === 0) await wait(50);
  }
  assert.notEqual(port, 0, err);
  return {
    dir,
    port,
    log: () => err,
    stop: async () => {
      child.kill("SIGTERM");
      const code = await exit;
      clearTimeout(guard);
      return code;
    },
  };
}

const ended = (s: Socket) => new Promise<void>((resolve) => s.once("close", () => resolve()));
const within = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true), wait(ms).then(() => false)]);

test(
  "serve: TLS 1.3 alone, the pinned key, a hello, a closed connection for what is no proof, a silent client cut at 10 s, SIGTERM 0 (9.2 #6)",
  DARWIN,
  async () => {
    const relay = await serving();
    const connect = (options: { maxVersion?: "TLSv1.2" } = {}) => {
      const socket = tls({
        host: "127.0.0.1",
        port: relay.port,
        rejectUnauthorized: false,
        ...options,
      });
      const chunks: Buffer[] = [];
      let code: string | undefined;
      socket.on("data", (c: Buffer) => chunks.push(c));
      socket.on("error", (e) => {
        code = (e as NodeJS.ErrnoException).code;
      });
      return { socket, chunks, code: () => code, closed: ended(socket) };
    };
    try {
      const old = connect({ maxVersion: "TLSv1.2" });
      await old.closed;
      assert.equal(old.code(), "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION");

      // The link pins the relay's key as a device does, and returns once the hello has come.
      const pinned = relayPublicKey(readFileSync(join(relay.dir, "key.pem")));
      const ok = await dial(platform, relay.port, pinned);
      assert.equal(ok.socket.getProtocol(), "TLSv1.3");

      // A length over 4,096 before a proof closes the connection.
      ok.socket.write(Buffer.from([0, 0, 0x10, 1, 0x0d]));
      assert.equal((await ok.next(2000)).type, "closed");

      // A frame that is no proof closes it with nothing sent after hello.
      const other = await dial(platform, relay.port, pinned);
      other.socket.write(Buffer.from([0, 0, 0, 2, 0x03, 0]));
      assert.equal((await other.next(2000)).type, "closed", "closed with no frame before it");

      // A client silent after TCP is closed at the handshake timeout of 10 s (not measured on Node 22).
      const silent = tcp(relay.port, "127.0.0.1");
      const t0 = Date.now();
      await ended(silent);
      const waited = Date.now() - t0;
      assert.ok(waited >= 9_000 && waited < 20_000, `closed after ${waited} ms`);
    } finally {
      assert.equal(await relay.stop(), 0, relay.log());
    }
    assert.doesNotMatch(relay.log(), /127\.0\.0\.1:\d+/, "no peer address is logged");
  },
);

test(
  "serve: the 31st new connection of a minute from one address is closed before TLS (9.2 #6)",
  DARWIN,
  async () => {
    const relay = await serving();
    try {
      for (let i = 0; i < 30; i++) {
        const s = tcp(relay.port, "127.0.0.1");
        await new Promise((resolve) => s.once("connect", resolve));
        s.destroy();
        await ended(s);
        await wait(5);
      }
      const thirtyFirst = tcp(relay.port, "127.0.0.1");
      assert.equal(await within(ended(thirtyFirst), 500), true, "not left waiting for a handshake");
    } finally {
      assert.equal(await relay.stop(), 0, relay.log());
    }
  },
);
