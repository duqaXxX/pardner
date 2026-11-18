/** A TLS server that says what a test scripts, around a key of its own: for what a real relay never does. */
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type TLSSocket } from "node:tls";
import { encodeFrame, type Frame } from "../../../src/protocol/frames.ts";
import { relayKeyId } from "../../../src/protocol/ids.ts";
import type { Bytes, Platform } from "../../../src/protocol/platform.ts";
import { encodeHead } from "../../../src/protocol/proofs.ts";
import { makeCertificate } from "../../../src/relay/certificate.ts";

/** `onData` runs for each chunk the device sends; `send` writes frames as a proven relay does. `hello: false` opens with `served`. */
export async function fakeRelay(
  platform: Platform,
  onData: (reply: (...frames: (Frame | Bytes)[]) => void, count: number) => void,
  opts: { hello?: boolean } = {},
) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const key = Buffer.concat([
    Buffer.of(4),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]);
  const cert = makeCertificate(
    privateKey.export({ type: "pkcs8", format: "pem" }),
    platform.random(16),
  );
  const sockets = new Set<TLSSocket>();
  const server = createServer(
    { key: privateKey.export({ type: "pkcs8", format: "pem" }), cert, minVersion: "TLSv1.3" },
    (socket: TLSSocket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      const hello: Frame =
        opts.hello === false
          ? { type: "served", incarnation: new Uint8Array(16) }
          : { type: "hello", relayNonce: platform.random(32) };
      socket.write(encodeFrame(hello, hello.type === "served"));
      let count = 0;
      socket.on("data", () =>
        onData((...frames) => {
          for (const f of frames) socket.write(f instanceof Uint8Array ? f : encodeFrame(f, true));
        }, ++count),
      );
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  /** A `head` frame at `n` with `chain`, signed by the relay's key as a relay signs it. */
  const head = (n: number, chain: Bytes): Frame => {
    const signed = encodeHead({ relay: relayKeyId(platform, key), n, chain });
    return {
      type: "head",
      n,
      chain,
      sig: sign("sha256", signed, { key: privateKey, dsaEncoding: "ieee-p1363" }),
    };
  };
  return {
    port,
    key,
    head,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
