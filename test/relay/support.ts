import { generateKeyPairSync } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { after } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import { relayKeyId } from "../../src/protocol/ids.ts";
import { relayPublicKey } from "../../src/relay/directory.ts";
import { fileHeader, type Item } from "../../src/relay/journal.ts";
import { createLog } from "../../src/relay/log.ts";
import { Rounds, type Seam } from "../../src/relay/round.ts";

export const platform = createNodePlatform();

/** A seam over the real `writeSync`, with every effect recorded and each one replaceable. */
export function fakeSeam(over: Partial<Seam> = {}) {
  const stops: number[] = [];
  const syncs: number[] = [];
  const lines: string[] = [];
  const seam: Seam = {
    sync: async (fd) => {
      syncs.push(fd);
    },
    write: (fd, bytes) => writeSync(fd, bytes),
    free: () => 1e12,
    stop: (code) => {
      stops.push(code);
    },
    now: () => 1_700_000_000_000,
    ...over,
  };
  const log = createLog((line) => lines.push(line), seam.now);
  return { seam, stops, syncs, lines, log, rounds: new Rounds(seam, log) };
}

/** Makes `dir` hold a journal with only its header, under a fixed relay id; returns the id. */
export function makeJournalDir(dir: string) {
  mkdirSync(dir, { recursive: true });
  const relay = new Uint8Array(32).fill(5);
  writeFileSync(join(dir, "journal"), fileHeader("journal", relay));
  return relay;
}

/** Makes `dir` hold a whole relay directory with an empty journal; returns the relay key's id. */
export function makeRelayDir(dir: string) {
  mkdirSync(join(dir, "blobs"), { recursive: true, mode: 0o700 });
  const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  writeFileSync(join(dir, "key.pem"), pem, { mode: 0o600 });
  const relay = relayKeyId(platform, relayPublicKey(pem));
  writeFileSync(join(dir, "journal"), fileHeader("journal", relay));
  writeFileSync(join(dir, "seals"), fileHeader("seals", relay));
  return relay;
}

const opened = new Set<number>();
// Windows cannot remove a folder that holds an open file: every descriptor a test took is closed at the end.
after(() => {
  for (const fd of opened) {
    try {
      closeSync(fd);
    } catch {}
  }
});

/** Remembers `fd` so the end of the run closes it. */
export function track(fd: number): number {
  opened.add(fd);
  return fd;
}

export function openAppending(path: string): number {
  return track(openSync(path, "a+"));
}

/** The i-th item of a test sequence. */
export function item(i: number): Item {
  return {
    kind: (i % 3) + 1,
    signed: new TextEncoder().encode(`signed item ${i}`),
    sig: new Uint8Array(64).fill(i + 1),
  };
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
