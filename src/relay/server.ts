/**
 * The relay's TLS server (design 4.1, 4.3, 4.4): TLS 1.3 alone, the relay's nonce sent as `hello`, and
 * every connection held to its limits. What a frame means is the session's: the server reads frames
 * and hands each, whole, to the session of its connection.
 */
import type { AddressInfo, Socket } from "node:net";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { encodeFrame, type Frame } from "../protocol/frames.ts";
import { EXPORTER_LABEL } from "../protocol/labels.ts";
import type { Bytes } from "../protocol/platform.ts";
import { FrameReader, type PartialBytes } from "./frames-in.ts";
import type { Held, Limits } from "./limits.ts";
import { errorFields, type Log } from "./log.ts";

/** The time to finish a TLS handshake (design 4.4). */
export const HANDSHAKE_MS = 10_000;

/** One connection as its session sees it. */
export interface Peer {
  readonly remote: string | undefined;
  readonly held: Held;
  /** The relay nonce sent as `hello`, and the TLS session's exported binding (design 4.2). */
  readonly nonce: Bytes;
  readonly binding: Bytes;
  /** After a proof: frames are read as a proven connection's, at most `cap` bytes each when given. */
  allow(cap?: number): void;
  /**
   * False when the socket queued the write in memory, or the connection ended or closed: the sender
   * writes no more until `drain`, and the connection is not read meanwhile (design 4.5).
   */
  send(frame: Frame): boolean;
  /** Sends `frame`, then closes; nothing is sent after it. */
  end(frame: Frame): void;
  close(): void;
  /** Stops reading: what the peer sends meanwhile waits in TCP (design 4.5, 6.5). */
  pause(): void;
  /** Reads again, unless a write is still queued. */
  resume(): void;
  /** Calls `fn` once when the socket's queue is empty again. */
  drain(fn: () => void): void;
}

/** What a connection's frames do. `frame` returns false when the connection is over and the rest of the chunk is dropped. */
export interface Session {
  frame(frame: Frame): boolean;
  closed(): void;
}

/** Node's types ask for a context; an empty one is none in TLS 1.3 (RFC 8446, 7.5). */
const NO_CONTEXT = Buffer.alloc(0);

export interface ServerDeps {
  session: (peer: Peer) => Session;
  /** The relay key, PKCS#8 PEM, and the certificate made around it at this start. */
  key: string | Buffer;
  cert: string;
  limits: Limits;
  budget: PartialBytes;
  log: Log;
  /** The platform's random bytes: the relay nonce of `hello` (crypto.md 6). */
  random: (length: number) => Uint8Array;
  now?: () => number;
  handshakeMs?: number;
  /** A frame is whole within this long of its first byte (design 4.3); a test shortens it. */
  frameMs?: number;
}

export interface RelayServer {
  /** Listens and returns the port, which is the system's choice for port 0. */
  listen(host: string, port: number): Promise<number>;
  /** Stops listening and destroys every connection. */
  close(): Promise<void>;
}

/** A TLS 1.3 server that holds each connection to the relay's limits; nothing listens until `listen`. */
export function createServer(deps: ServerDeps): RelayServer {
  const now = deps.now ?? Date.now;
  const sockets = new Set<Socket>();
  // The pool's entry of a raw socket, found again when its TLS socket is secure: by the connection's
  // 4-tuple, which TCP makes unique at any one time (the remote endpoint alone is not, across local addresses).
  const entries = new Map<string, Held>();
  const endpoint = (s: Socket) =>
    `${s.remoteAddress}:${s.remotePort}>${s.localAddress}:${s.localPort}`;
  const server = createTlsServer({
    key: deps.key,
    cert: deps.cert,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    handshakeTimeout: deps.handshakeMs ?? HANDSHAKE_MS,
  });

  // Before TLS starts: a banned or too frequent address, or one holding its share, costs the relay
  // no handshake (design 4.4). `prependListener` runs this before the TLS server's own listener; a test
  // cannot tell it from `on`, as the TLS handshake waits for data in either order.
  server.prependListener("connection", (socket: Socket) => {
    socket.on("error", () => {});
    // Read now: a closed socket no longer has its addresses.
    const key = endpoint(socket);
    const held = deps.limits.admit(socket.remoteAddress)
      ? deps.limits.open(socket.remoteAddress, () => socket.destroy())
      : null;
    if (held === null) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    entries.set(key, held);
    socket.once("close", () => {
      deps.limits.close(held);
      sockets.delete(socket);
      entries.delete(key);
    });
  });

  // `handshakeTimeout` alone leaves the TCP connection open (Node 26.5.1, measured; not on Node 22).
  server.on("tlsClientError", (_error, socket: TLSSocket) => socket.destroy());

  server.on("secureConnection", (socket: TLSSocket) => {
    const held = entries.get(endpoint(socket));
    if (held === undefined) {
      socket.destroy();
      return;
    }
    const reader = new FrameReader(deps.budget, now, deps.frameMs);
    let timer: NodeJS.Timeout | undefined;
    // One timer, set for whichever limit comes first: the connection's own or the frame's. The frame's
    // waits while the relay's own writes hold the connection (4.3, 4.5): the peer is not the slow one.
    const arm = () => {
      clearTimeout(timer);
      const due = [deps.limits.deadline(held), stalled ? null : reader.deadline].filter(
        (t) => t !== null,
      );
      if (due.length > 0) {
        timer = setTimeout(
          () => {
            deps.limits.drop();
            socket.destroy();
          },
          Math.min(...due) - now(),
        );
      }
    };
    const nonce = Uint8Array.from(deps.random(32));
    // Computed at the first proof, not for every connection (a flood of unproven ones never needs it).
    let binding: Bytes | undefined;
    // Once the session said false, no later chunk reaches it.
    let over = false;
    let ended = false;
    // Why the connection is not read: the session asked (6.5, 4.5), or the socket holds a write in
    // memory until `drain` (4.5). What was read and not yet handed to the session waits in `unread`.
    let paused = false;
    let stalled = false;
    let feeding = false;
    const unread: Buffer[] = [];
    const feed = () => {
      if (feeding) return;
      feeding = true;
      try {
        while (!over && !paused && !stalled && unread.length > 0) {
          const taken = reader.push(unread.shift() as Buffer, (frame) => {
            over = !session.frame(frame);
            return !over && !paused && !stalled;
          });
          if ("closed" in taken) {
            // A frame that does not decode is no limit's cut (design 7).
            if (taken.closed !== "frame") deps.limits.drop();
            socket.destroy();
            return;
          }
          if (taken.rest && !over) unread.unshift(taken.rest);
        }
      } finally {
        feeding = false;
      }
      arm();
    };
    const flow = () => {
      if (paused || stalled) socket.pause();
      else {
        socket.resume();
        feed();
      }
    };
    const peer: Peer = {
      remote: socket.remoteAddress,
      held,
      nonce,
      get binding() {
        binding ??= Uint8Array.from(socket.exportKeyingMaterial(32, EXPORTER_LABEL, NO_CONTEXT));
        return binding;
      },
      allow: (cap) => {
        reader.proven = true;
        reader.cap = cap ?? null;
      },
      send: (frame) => {
        if (ended || socket.destroyed) return false;
        const room = socket.write(encodeFrame(frame, true));
        if (!room && !stalled) {
          stalled = true;
          socket.once("drain", () => {
            stalled = false;
            reader.restart();
            flow();
            arm();
          });
          flow();
          arm();
        }
        return room;
      },
      end: (frame) => {
        if (ended || socket.destroyed) return;
        const bytes = encodeFrame(frame, true);
        ended = true;
        socket.end(bytes, () => socket.destroy());
      },
      close: () => socket.destroy(),
      pause: () => {
        paused = true;
        flow();
      },
      resume: () => {
        paused = false;
        flow();
      },
      drain: (fn) => void socket.once("drain", fn),
    };
    const session = deps.session(peer);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(timer);
      reader.release();
      session.closed();
    });
    deps.limits.hello(held);
    socket.write(encodeFrame({ type: "hello", relayNonce: nonce }, false));
    arm();
    socket.on("data", (chunk: Buffer) => {
      if (over) return;
      deps.limits.touch(held);
      unread.push(chunk);
      feed();
    });
  });

  return {
    listen: (host, port) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          // An accept can fail later (EMFILE under a flood): the relay logs it and keeps serving.
          server.on("error", (error) => deps.log.error(`server error (${errorFields(error)})`));
          resolve((server.address() as AddressInfo).port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
