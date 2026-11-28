/**
 * The relay's transport over real TLS on 127.0.0.1 (design 9.2, test 6), in this process with short
 * limits where the figure is ten seconds, and in a child process in `process-transport.test.ts`.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { type Socket, connect as tcp } from "node:net";
import { mock, test } from "node:test";
import { TLSSocket, Server as TlsServer, connect as tls } from "node:tls";
import { decodeFrame, encodeFrame, type Frame } from "../../src/protocol/frames.ts";
import { makeCertificate } from "../../src/relay/certificate.ts";
import { PartialBytes } from "../../src/relay/frames-in.ts";
import { FIGURES, Limits } from "../../src/relay/limits.ts";
import { createLog } from "../../src/relay/log.ts";
import { Outbox } from "../../src/relay/outbox.ts";
import { createServer, type Peer, type ServerDeps } from "../../src/relay/server.ts";
import { platform } from "./support.ts";

const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" });

async function relay(
  over: {
    figures?: Partial<typeof FIGURES>;
    handshakeMs?: number;
    frameMs?: number;
    session?: ServerDeps["session"];
  } = {},
) {
  const lines: string[] = [];
  const budget = new PartialBytes();
  const limits = new Limits(Date.now, { ...FIGURES, ...over.figures });
  const server = createServer({
    // The session of the first version of the transport: no frame is answered, every one closes.
    session:
      over.session ??
      ((peer) => ({
        frame: () => {
          peer.close();
          return false;
        },
        closed: () => {},
      })),
    key: pem,
    cert: makeCertificate(pem, platform.random(16)),
    limits,
    budget,
    log: createLog((l) => lines.push(l)),
    random: platform.random,
    handshakeMs: over.handshakeMs,
    frameMs: over.frameMs,
  });
  const port = await server.listen("127.0.0.1", 0);
  return { port, server, lines, budget, limits };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A TLS client that collects what the relay sends, and says when and how the connection ended. */
function client(port: number, options: { maxVersion?: "TLSv1.2" } = {}) {
  const socket = tls({ host: "127.0.0.1", port, rejectUnauthorized: false, ...options });
  const chunks: Buffer[] = [];
  let error: NodeJS.ErrnoException | undefined;
  socket.on("data", (c: Buffer) => chunks.push(c));
  socket.on("error", (e) => {
    error = e as NodeJS.ErrnoException;
  });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const received = () => Buffer.concat(chunks);
  return { socket, closed, received, error: () => error };
}

/** The frames the relay sent, decoded as a device would. */
function framesOf(bytes: Buffer): Frame[] {
  const out: Frame[] = [];
  for (let at = 0; at < bytes.length; ) {
    const end = at + 4 + bytes.readUInt32BE(at);
    const frame = decodeFrame(bytes.subarray(at, end), false, "device");
    assert.ok(frame.ok);
    out.push(frame.value);
    at = end;
  }
  return out;
}

const within = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), wait(ms).then(() => false)]);

test("TLS 1.3 alone: a client limited to 1.2 is refused, a default one gets 1.3 and the relay's nonce and nothing else (4.1)", async (t) => {
  const { port, server } = await relay();
  t.after(() => server.close());
  const old = client(port, { maxVersion: "TLSv1.2" });
  await old.closed;
  assert.equal(old.error()?.code, "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION");
  const ok = client(port);
  await new Promise((resolve) => ok.socket.once("secureConnect", resolve));
  assert.equal(ok.socket.getProtocol(), "TLSv1.3");
  await wait(150);
  const [hello, ...rest] = framesOf(ok.received());
  assert.equal(hello?.type, "hello");
  assert.equal(hello?.type === "hello" && hello.relayNonce.length, 32);
  assert.deepEqual(rest, []);
  // The key a device pins is the one the certificate carries.
  const seen = ok.socket.getPeerX509Certificate();
  assert.deepEqual(
    seen?.publicKey.export({ type: "spki", format: "der" }),
    pair.publicKey.export({ type: "spki", format: "der" }),
  );
  ok.socket.destroy();
});

test("two connections are sent two nonces (4.2)", async (t) => {
  const { port, server } = await relay();
  t.after(() => server.close());
  const [a, b] = [client(port), client(port)];
  await wait(300);
  const nonce = (c: ReturnType<typeof client>) => {
    const frame = framesOf(c.received())[0];
    return frame?.type === "hello" ? Buffer.from(frame.relayNonce).toString("hex") : "";
  };
  assert.notEqual(nonce(a), nonce(b));
  assert.equal(nonce(a).length, 64);
  a.socket.destroy();
  b.socket.destroy();
});

test("a client silent after TCP, or half a ClientHello, is closed at the handshake timeout (4.1; measured on Node 26 only, not on Node 22)", async (t) => {
  const { port, server } = await relay({ handshakeMs: 300 });
  t.after(() => server.close());
  const silent = tcp(port, "127.0.0.1");
  const half = tcp(port, "127.0.0.1");
  half.write(Buffer.from([0x16, 0x03, 0x01, 0x02]));
  const ended = (s: Socket) => new Promise<void>((resolve) => s.once("close", () => resolve()));
  const t0 = Date.now();
  assert.equal(await within(Promise.all([ended(silent), ended(half)]), 3000), true);
  assert.ok(Date.now() - t0 >= 250, "not before the timeout");
});

/** Sends `bytes` after `hello` and returns what came back and whether the relay closed. */
async function afterHello(port: number, bytes: Buffer) {
  const c = client(port);
  await new Promise((resolve) => c.socket.once("secureConnect", resolve));
  while (c.received().length < 37) await wait(5); // the hello (4 + 1 + 32 bytes) is read first
  c.socket.write(bytes);
  const closed = await within(c.closed, 2000);
  return { closed, frames: framesOf(c.received()) };
}

test("a length over 4,096 before a proof closes; a frame that is no proof closes with nothing sent but hello (4.3, never allowed 11)", async (t) => {
  const { port, server } = await relay();
  t.after(() => server.close());
  const long = await afterHello(port, Buffer.from([0, 0, 0x10, 1, 0x0d]));
  assert.equal(long.closed, true);
  assert.deepEqual(
    long.frames.map((f) => f.type),
    ["hello"],
  );
  const request = await afterHello(port, Buffer.from(encodeFrame({ type: "read", from: 0 }, true)));
  assert.equal(request.closed, true);
  assert.deepEqual(
    request.frames.map((f) => f.type),
    ["hello"],
  );
  const junk = await afterHello(port, Buffer.from([0, 0, 0, 2, 0x0d, 1]));
  assert.equal(junk.closed, true);
  assert.deepEqual(
    junk.frames.map((f) => f.type),
    ["hello"],
  );
});

test("a well-formed first frame is closed with no answer in this version (the proofs answer it later)", async (t) => {
  const { port, server } = await relay();
  t.after(() => server.close());
  const enrol: Frame = {
    type: "enrol",
    secret: new Uint8Array(32),
    signed: new Uint8Array(8),
    sig: new Uint8Array(64),
  };
  const sent = await afterHello(port, Buffer.from(encodeFrame(enrol, false)));
  assert.equal(sent.closed, true);
  assert.deepEqual(
    sent.frames.map((f) => f.type),
    ["hello"],
  );
});

test("a connection with no proof is closed at its time from hello, and a frame trickled past its time closes too (4.3, 4.6)", async (t) => {
  const quick = await relay({ figures: { unprovenMs: 300 } });
  t.after(() => quick.server.close());
  const idle = client(quick.port);
  const t0 = Date.now();
  await idle.closed;
  assert.ok(Date.now() - t0 >= 250);
  assert.equal(idle.socket.destroyed, true);

  const slow = await relay({ frameMs: 300, figures: { unprovenMs: 60_000 } });
  t.after(() => slow.server.close());
  const trickle = client(slow.port);
  await new Promise((resolve) => trickle.socket.once("secureConnect", resolve));
  trickle.socket.write(Buffer.from([0, 0, 0x0f, 0, 0x0d]));
  await wait(100);
  trickle.socket.write(Buffer.from([1]));
  assert.equal(
    await within(trickle.closed, 2000),
    true,
    "closed by the frame's clock, not the connection's",
  );
});

test("the 31st new connection of a minute is closed before TLS (4.4)", async (t) => {
  const { port, server } = await relay({ handshakeMs: 10_000 });
  t.after(() => server.close());
  const ended = (s: Socket) => new Promise<void>((resolve) => s.once("close", () => resolve()));
  for (let i = 0; i < FIGURES.rate.fine; i++) {
    const s = tcp(port, "127.0.0.1");
    await new Promise((resolve) => s.once("connect", resolve));
    s.destroy();
    await ended(s);
    await wait(5);
  }
  const control = tcp(port, "127.0.0.1");
  const waiting = await within(ended(control), 400);
  assert.equal(waiting, true, "the 31st never reached TLS: nobody waits ten seconds on it");
  // The earlier ones were admitted: a silent one of them would still be waiting for its handshake.
});

test("a 5th connection without a proof from one address is closed at once, and the first four stay (4.4)", async (t) => {
  const { port, server } = await relay({ handshakeMs: 10_000 });
  t.after(() => server.close());
  const ended = (s: Socket) => new Promise<void>((resolve) => s.once("close", () => resolve()));
  const held = Array.from({ length: 4 }, () => tcp(port, "127.0.0.1"));
  await wait(100);
  const fifth = tcp(port, "127.0.0.1");
  assert.equal(await within(ended(fifth), 500), true);
  assert.equal(
    held.every((s) => !s.destroyed),
    true,
  );
  for (const s of held) s.destroy();
});

test("the oldest connection without a proof is evicted when the pool is full (4.4, I6)", async (t) => {
  const { port, server } = await relay({
    handshakeMs: 10_000,
    figures: { unproven: { fine: 10, coarse: 10, all: 3 } },
  });
  t.after(() => server.close());
  const ended = (s: Socket) => new Promise<void>((resolve) => s.once("close", () => resolve()));
  const held: Socket[] = [];
  for (let i = 0; i < 3; i++) {
    held.push(tcp(port, "127.0.0.1"));
    await wait(30);
  }
  const fourth = tcp(port, "127.0.0.1");
  assert.equal(await within(ended(held[0] as Socket), 500), true, "the oldest is cut");
  assert.equal(held[1]?.destroyed, false);
  assert.equal(held[2]?.destroyed, false);
  assert.equal(fourth.destroyed, false, "the newcomer is kept");
  for (const s of [...held, fourth]) s.destroy();
});

test("closing the server destroys every connection (2.4)", async () => {
  const { port, server } = await relay();
  const c = client(port);
  await new Promise((resolve) => c.socket.once("secureConnect", resolve));
  await server.close();
  assert.equal(await within(c.closed, 1000), true);
});

test("six connections one after another from one address are each told hello: a close gives its place back (4.4, 2-CR3)", async (t) => {
  const { port, server } = await relay();
  t.after(() => server.close());
  for (let i = 0; i < 6; i++) {
    const c = client(port);
    assert.equal(await within(new Promise((r) => c.socket.once("secureConnect", r)), 2000), true);
    for (let n = 0; n < 400 && c.received().length < 37; n++) await wait(5);
    assert.equal(framesOf(c.received())[0]?.type, "hello", `connection ${i}`);
    c.socket.destroy();
    await c.closed;
    await wait(30);
  }
});

test("what a connection held for a half-read frame is given back when it closes (4.3, 2-CR3)", async (t) => {
  const { port, server, budget } = await relay();
  t.after(() => server.close());
  const c = client(port);
  await new Promise((resolve) => c.socket.once("secureConnect", resolve));
  while (c.received().length < 37) await wait(5);
  c.socket.write(Buffer.from([0, 0, 0x10, 0x00]));
  while (budget.held === 0) await wait(5);
  assert.equal(budget.held, 4100);
  c.socket.destroy();
  await c.closed;
  await wait(100);
  assert.equal(budget.held, 0);
});

test("an error the server emits after listening is logged and the relay goes on serving (4.4, 2-C2)", async (t) => {
  let net: TlsServer | undefined;
  const original = TlsServer.prototype.listen;
  const listen = mock.method(
    TlsServer.prototype,
    "listen",
    function (this: TlsServer, ...a: Parameters<typeof original>) {
      net = this;
      return original.apply(this, a);
    },
  );
  const { port, server, lines } = await relay();
  listen.mock.restore();
  t.after(() => server.close());
  assert.ok(net);
  assert.doesNotThrow(() =>
    net?.emit("error", Object.assign(new Error("accept"), { code: "EMFILE" })),
  );
  assert.match(lines.join("\n"), /server error \(code=EMFILE syscall=unknown\)/);
  const ok = client(port);
  await new Promise((resolve) => ok.socket.once("secureConnect", resolve));
  while (ok.received().length < 37) await wait(5);
  assert.equal(framesOf(ok.received())[0]?.type, "hello");
  ok.socket.destroy();
});

test("a session that returns false is handed no frame after it, in the chunk or in a later one (C2)", async (t) => {
  const seen: string[] = [];
  const { port, server } = await relay({
    // The session ends the connection in its own way: it does not close the socket.
    session: () => ({
      frame: (f) => {
        seen.push(f.type);
        return false;
      },
      closed: () => {},
    }),
  });
  t.after(() => server.close());
  const enrol: Frame = {
    type: "enrol",
    secret: new Uint8Array(32),
    signed: new Uint8Array(8),
    sig: new Uint8Array(64),
  };
  const c = client(port);
  await new Promise((resolve) => c.socket.once("secureConnect", resolve));
  c.socket.write(Buffer.concat([encodeFrame(enrol, false), encodeFrame(enrol, false)]));
  await wait(100);
  c.socket.write(encodeFrame(enrol, false));
  await wait(100);
  assert.deepEqual(seen, ["enrol"], "one frame reached the session, none after it said false");
  c.socket.destroy();
});

test("the TLS exporter is asked once, and only when a session reads the binding (C8)", async (t) => {
  const asked = mock.method(TLSSocket.prototype, "exportKeyingMaterial");
  t.after(() => asked.mock.restore());
  let binding: Uint8Array | undefined;
  const { port, server } = await relay({
    session: (peer) => ({
      frame: () => {
        binding = peer.binding;
        assert.equal(peer.binding, binding);
        return false;
      },
      closed: () => {},
    }),
  });
  t.after(() => server.close());
  const idle = client(port);
  await new Promise((resolve) => idle.socket.once("secureConnect", resolve));
  await wait(100);
  assert.equal(asked.mock.callCount(), 0, "a connection that sends nothing needs no binding");
  const enrol: Frame = {
    type: "enrol",
    secret: new Uint8Array(32),
    signed: new Uint8Array(8),
    sig: new Uint8Array(64),
  };
  idle.socket.write(encodeFrame(enrol, false));
  await wait(100);
  assert.equal(asked.mock.callCount(), 1, "read twice, computed once");
  idle.socket.destroy();
});

const BIG: Frame = {
  type: "blob",
  request: 1,
  size: 1 << 20,
  offset: 0,
  chunk: new Uint8Array(1_000_000),
};
const enrolOf = (length: number): Frame => ({
  type: "enrol",
  secret: new Uint8Array(32),
  signed: new Uint8Array(length),
  sig: new Uint8Array(64),
});

test("4.5 a write the socket queued stops the reading until 'drain': the frames after it, in its chunk and later, wait and then arrive in order (S3, M4)", async (t) => {
  const seen: number[] = [];
  let writes = 0;
  const { port, server } = await relay({
    session: (peer) => ({
      frame: (f) => {
        if (f.type !== "enrol") return false;
        seen.push(f.signed.length);
        // The first frame fills the socket: 40 MB that the peer below does not read.
        if (f.signed.length === 8) for (let i = 0; i < 40; i++) if (!peer.send(BIG)) writes++;
        return true;
      },
      closed: () => {},
    }),
  });
  t.after(() => server.close());
  const c = client(port);
  c.socket.pause();
  await new Promise((resolve) => c.socket.once("secureConnect", resolve));
  c.socket.write(Buffer.concat([encodeFrame(enrolOf(8), false), encodeFrame(enrolOf(9), false)]));
  await wait(150);
  c.socket.write(encodeFrame(enrolOf(10), false));
  await wait(150);
  assert.deepEqual(seen, [8], "the frames after the one that filled the socket wait");
  assert.ok(writes > 0, "the socket said it was full");
  c.socket.resume();
  while (seen.length < 3) await wait(10);
  assert.deepEqual(seen, [8, 9, 10]);
  c.socket.destroy();
});

test("4.5 after `end` a send writes nothing and says there is no room (C5)", async (t) => {
  let sent: boolean | undefined;
  const { port, server } = await relay({
    session: (peer) => ({
      frame: () => {
        peer.end({ type: "refused", reason: 1 });
        sent = peer.send({ type: "refused", reason: 6 });
        return false;
      },
      closed: () => {},
    }),
  });
  t.after(() => server.close());
  const c = client(port);
  await new Promise((resolve) => c.socket.once("secureConnect", resolve));
  c.socket.write(encodeFrame(enrolOf(8), false));
  await c.closed;
  assert.equal(sent, false);
  assert.deepEqual(
    framesOf(c.received()).map((f) => f.type),
    ["hello", "refused"],
  );
  assert.equal(c.error(), undefined, "no write after end");
});

test("4.3 4.5 a frame half read when the relay's own writes fill the socket keeps no deadline while it waits, and has its 30 s again at the drain (F2)", async (t) => {
  const seen: number[] = [];
  let held: Peer | undefined;
  const { port, server } = await relay({
    frameMs: 400,
    figures: { unprovenMs: 60_000 },
    session: (peer) => {
      held = peer;
      return {
        frame: (f) => {
          if (f.type === "enrol") seen.push(f.signed.length);
          return true;
        },
        closed: () => {},
      };
    },
  });
  t.after(() => server.close());
  const c = client(port);
  c.socket.pause();
  await new Promise((resolve) => c.socket.once("secureConnect", resolve));
  const frame = encodeFrame(enrolOf(100), false);
  c.socket.write(frame.subarray(0, 60));
  await wait(50);
  for (let i = 0; i < 40; i++) held?.send(BIG);
  await wait(900);
  assert.equal(c.socket.destroyed, false, "the peer was not slow: the relay's writes held it");
  c.socket.resume();
  await wait(200);
  c.socket.write(frame.subarray(60));
  await wait(300);
  assert.deepEqual(seen, [100]);
  c.socket.destroy();
});

test("section 7: a length past the limit is a dropped connection, a frame that does not decode is not (C9)", async (t) => {
  const { port, server, limits } = await relay();
  t.after(() => server.close());
  const long = client(port);
  await new Promise((resolve) => long.socket.once("secureConnect", resolve));
  long.socket.write(Buffer.from([0, 0, 0x10, 1, 0x0c]));
  await long.closed;
  assert.deepEqual(limits.take(), { refused: 0, dropped: 1 });
  const garbage = client(port);
  await new Promise((resolve) => garbage.socket.once("secureConnect", resolve));
  garbage.socket.write(Buffer.from([0, 0, 0, 2, 0x7f, 0]));
  await garbage.closed;
  assert.deepEqual(limits.take(), { refused: 0, dropped: 0 });
});

test("4.5 a read and a submit sent while a blob streams are read and answered before its last chunk, over real TLS (#153, F1)", async (t) => {
  const CHUNK = 512 * 1024;
  const CHUNKS = 60;
  const reached: Record<string, number> = {};
  const errors: unknown[] = [];
  let sentChunks = 0;
  const { port, server } = await relay({
    // The session's outbox is the relay's own; no round is waited for, so no `fsync` decides the order.
    session: (peer) => {
      const out = new Outbox(
        peer,
        () => false,
        (e) => errors.push(e),
      );
      peer.allow();
      function* blob(): Generator<void> {
        for (let i = 0; i < CHUNKS; i++) {
          sentChunks++;
          out.send({
            type: "blob",
            request: 1,
            size: CHUNKS * CHUNK,
            offset: i * CHUNK,
            chunk: new Uint8Array(CHUNK),
          });
          yield;
        }
      }
      function* pass(): Generator<void> {
        out.send({ type: "position", from: 0, incarnation: new Uint8Array(16) });
        yield;
      }
      return {
        frame: (f) => {
          reached[f.type] = sentChunks;
          if (f.type === "get-blob") out.stream(blob());
          else if (f.type === "read") out.answer(() => out.follow(pass()));
          else if (f.type === "submit")
            out.answer(() => out.send({ type: "result", request: f.request, code: 0 }));
          return true;
        },
        closed: () => out.close(),
      };
    },
  });
  t.after(() => server.close());
  const c = client(port);
  await new Promise((resolve) => c.socket.once("secureConnect", resolve));
  const frame = (f: Frame) => Buffer.from(encodeFrame(f, true));
  c.socket.write(frame({ type: "get-blob", request: 1, blob: new Uint8Array(32), offset: 0 }));
  // The first chunk is on its way to the device: it asks for a pass and sends a message.
  while (c.received().length < CHUNK) await wait(1);
  c.socket.write(
    Buffer.concat([
      frame({ type: "read", from: 0 }),
      frame({
        type: "submit",
        request: 2,
        kind: 1,
        signed: new Uint8Array(8),
        sig: new Uint8Array(64),
      }),
    ]),
  );
  const seen = (): string[] => {
    const bytes = c.received();
    const types: string[] = [];
    for (let at = 0; at + 4 <= bytes.length; ) {
      const end = at + 4 + bytes.readUInt32BE(at);
      if (end > bytes.length) break;
      if (bytes[at + 4] === 0x46) types.push("blob");
      else {
        const body = bytes.subarray(at, end);
        const frame = decodeFrame(body, true, "device");
        const hello = frame.ok ? frame : decodeFrame(body, false, "device");
        assert.ok(hello.ok);
        types.push(hello.value.type);
      }
      at = end;
    }
    return types;
  };
  const started = Date.now();
  while (seen().filter((x) => x === "blob").length < CHUNKS && Date.now() - started < 20_000)
    await wait(20);
  c.socket.destroy();
  assert.deepEqual(errors, []);
  assert.equal(sentChunks, CHUNKS);
  assert.ok((reached.read ?? CHUNKS) < CHUNKS, `the read was read after chunk ${reached.read}`);
  assert.ok(
    (reached.submit ?? CHUNKS) < CHUNKS,
    `the submit was read after chunk ${reached.submit}`,
  );
  const order = seen();
  const last = order.lastIndexOf("blob");
  assert.ok(
    order.indexOf("position") !== -1 && order.indexOf("position") < last,
    "the position came before the last chunk",
  );
  assert.ok(
    order.indexOf("result") !== -1 && order.indexOf("result") < last,
    "the result came before the last chunk",
  );
});
