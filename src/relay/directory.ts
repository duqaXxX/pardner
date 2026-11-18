/**
 * Design 3.1, 3.5 and 3.7: the relay's directory. One process holds it (a lock on the directory's
 * own descriptor), it is in one of three conditions at every start, it carries a mark once the
 * relay failed closed, and rule 11 checks it is still the one the relay read.
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { NodePlatform } from "../platform-node/platform.ts";
import { bytesEqual, Writer } from "../protocol/bytes.ts";
import { relayKeyId } from "../protocol/ids.ts";
import type { Platform } from "../protocol/platform.ts";
import { fileHeader, type Journal } from "./journal.ts";
import type { Log } from "./log.ts";
import type { Rounds, Seam } from "./round.ts";

// `O_EXLOCK` of macOS's `open(2)`, as `src/core/lock.ts` uses it; Node does not export it.
const O_EXLOCK = 0x20;
const MARK = "failed-closed";
const KNOWN = new Set(["key.pem", "enrol", "journal", "seals", "blobs", MARK, `tmp-${MARK}`]);
const told = new Set<string>();

/** Another process holds the directory. */
export class HeldElsewhere extends Error {}

export type Condition =
  | { state: "none" }
  | { state: "whole"; relay: Uint8Array }
  | { state: "not whole"; why: string };

/**
 * Locks `dir` for this process, on a descriptor that also serves its `fsync` and rule 11. Node
 * reports the lock held as `EAGAIN`, macOS's `EWOULDBLOCK` (design 2.3).
 */
export function lockDirectory(dir: string): number {
  // Linux has no `O_EXLOCK` and Windows ignores the flag: an unlocked descriptor would let two relays write (invariant 7).
  if (process.platform !== "darwin") throw new Error("the relay's lock exists on macOS only");
  try {
    return openSync(
      dir,
      constants.O_RDONLY | constants.O_DIRECTORY | O_EXLOCK | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK") {
      throw new HeldElsewhere("another relay holds the directory", { cause: error });
    }
    throw error;
  }
}

/** The 65-byte uncompressed public key of a PKCS#8 PEM private key. */
export function relayPublicKey(pem: string | Buffer): Uint8Array {
  const jwk = createPublicKey(createPrivateKey(pem)).export({ format: "jwk" });
  const coordinate = (value: string | undefined) => Buffer.from(value ?? "", "base64url");
  return Buffer.concat([Buffer.of(4), coordinate(jwk.x), coordinate(jwk.y)]);
}

function startsWith(path: string, expected: Uint8Array): boolean {
  const fd = openSync(path, "r");
  try {
    const got = Buffer.alloc(expected.length);
    return readSync(fd, got, 0, got.length, 0) === got.length && bytesEqual(got, expected);
  } finally {
    closeSync(fd);
  }
}

/** Which of the three conditions `dir` is in (design 3.1); never repairs or writes. */
export function inspect(platform: Platform, dir: string, log: Log): Condition {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { state: "none" };
    return { state: "not whole", why: "the directory cannot be read" };
  }
  if (names.length === 0) return { state: "none" };
  for (const name of names) {
    const key = join(dir, name);
    if (!KNOWN.has(name) && !told.has(key)) {
      told.add(key);
      log.warning("unknown file in the directory, ignored");
    }
  }
  let relay: Uint8Array;
  try {
    relay = relayKeyId(platform, relayPublicKey(readFileSync(join(dir, "key.pem"))));
  } catch {
    return { state: "not whole", why: "key.pem is missing or not a key" };
  }
  for (const file of ["journal", "seals"] as const) {
    let holds = false;
    try {
      holds = startsWith(join(dir, file), fileHeader(file, relay));
    } catch {}
    if (!holds) return { state: "not whole", why: `${file} is missing or names another key` };
  }
  try {
    if (!statSync(join(dir, "blobs")).isDirectory()) throw new Error();
  } catch {
    return { state: "not whole", why: "blobs is missing" };
  }
  return { state: "whole", relay };
}

/** Whether the mark of design 3.5 is there: the relay serves nothing, for good. */
export function failedClosed(dir: string): boolean {
  return existsSync(join(dir, MARK));
}

const marks = new WeakMap<Rounds, Promise<void>>();

/**
 * Writes the mark (the time in milliseconds, the first position where the record given back left
 * the sequence): whole in a `tmp-` file, synced, renamed to its name, then the directory synced
 * (design 3.5). Resolves when all of it is on disk. A failure before the rename leaves no mark
 * under its name; a failure after it (the directory's sync) leaves a whole mark, and the relay
 * then starts failed closed. Either way it stops the relay. A second call joins the first,
 * whatever its position.
 */
export function writeMark(
  rounds: Rounds,
  seam: Seam,
  dir: string,
  dirFd: number,
  firstPosition: number,
): Promise<void> {
  const first = marks.get(rounds);
  if (first !== undefined) return first;
  const done = (async () => {
    const tmp = join(dir, `tmp-${MARK}`);
    const fd = rounds.guard("mark", () => openSync(tmp, "w", 0o600));
    const bytes = new Writer().u64(seam.now()).u64(firstPosition).bytes();
    await rounds.wait(rounds.write("mark", fd, bytes));
    rounds.guard("mark", () => renameSync(tmp, join(dir, MARK)));
    rounds.close(fd);
    await rounds.wait(rounds.touch("directory", dirFd));
  })();
  marks.set(rounds, done);
  return done;
}

/**
 * Rule 11 (design 3.7): which check found the directory changed under the relay, or null. The
 * directory and the journal are the files the relay opened; the size and the last 64 bytes are
 * what it last wrote.
 */
export function changed(dir: string, lockFd: number, journal: Journal): string | null {
  const same = (path: string, fd: number) => {
    try {
      const a = statSync(path);
      const b = fstatSync(fd);
      return a.dev === b.dev && a.ino === b.ino;
    } catch {
      return false;
    }
  };
  if (!same(dir, lockFd)) return "directory";
  if (!same(join(dir, "journal"), journal.fd)) return "journal";
  const size = fstatSync(journal.fd).size;
  if (size !== journal.length) return "size";
  const tail = Buffer.alloc(journal.tail.length);
  readSync(journal.fd, tail, 0, tail.length, size - tail.length);
  return bytesEqual(tail, journal.tail) ? null : "tail";
}

/**
 * A signer over the relay key `pem`, which the platform holds under the name `relay-key` from now
 * on: the platform's own `sign`, so that the relay writes no signature code (design 3.3).
 */
export function relaySigner(platform: NodePlatform, pem: string | Buffer) {
  const d = createPrivateKey(pem).export({ format: "jwk" }).d;
  const imported = platform.importKey("relay-key", "sign", Buffer.from(d ?? "", "base64url"));
  if (!imported.ok) throw new Error("the relay key cannot be used to sign");
  return (message: Uint8Array): Uint8Array => {
    const signed = platform.sign("relay-key", message);
    if (!signed.ok) throw new Error("the relay key cannot sign");
    return signed.value;
  };
}
