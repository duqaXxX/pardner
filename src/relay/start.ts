/**
 * Design 5.1 and 5.2, from a process start to serving: the directory read, the lock taken, the
 * mark looked for, the exclusion set, the journal read and the start's `fsync`s made, and the
 * incarnation drawn. The journal is read through the sequence, and the seals and the blobs are loaded
 * with it. Nothing listens here: `main.ts` does, once this serves.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createNodePlatform } from "../platform-node/platform.ts";
import type { Platform } from "../protocol/platform.ts";
import { Blobs } from "./blobs.ts";
import { failedClosed, inspect, lockDirectory, relaySigner } from "./directory.ts";
import { type Exec, excludeFromBackup } from "./exclusion.ts";
import type { Journal } from "./journal.ts";
import { NotWhole } from "./journal.ts";
import type { Log } from "./log.ts";
import { Rounds, type Seam } from "./round.ts";
import { Seals } from "./seals.ts";
import { Sequence } from "./sequence.ts";

/** What a start takes from the machine. */
export interface StartDeps {
  seam: Seam;
  log: Log;
  exec: Exec;
  platform: Platform;
  os?: string;
  /** Takes the directory's lock; a test removes the directory just before it. */
  lock?: (dir: string) => number;
}

/** Where a start ended; `lock` is the directory's descriptor, held until the process exits. */
export type Started =
  | { state: "waiting"; why: string }
  | { state: "failed closed"; lock: number; key: Buffer }
  | {
      state: "serving";
      lock: number;
      /** The relay key, PKCS#8 PEM, read once: the TLS key and the journal's signer are the same bytes. */
      key: Buffer;
      relay: Uint8Array;
      journal: Journal;
      seq: Sequence;
      seals: Seals;
      blobs: Blobs;
      rounds: Rounds;
      incarnation: Uint8Array;
    };

/**
 * Starts on `dir`. Throws `HeldElsewhere` when another process holds it, `ExclusionFailed` when the
 * exclusion cannot be set, `StorageFailed` after an `fsync` error; the lock is freed on any throw.
 */
export async function start(dir: string, deps: StartDeps): Promise<Started> {
  const found = inspect(deps.platform, dir, deps.log);
  if (found.state !== "whole") {
    return { state: "waiting", why: found.state === "none" ? "the directory is none" : found.why };
  }
  let lock: number;
  try {
    lock = (deps.lock ?? lockDirectory)(dir);
  } catch (error) {
    // The directory went between the check and the lock: it is not whole, which waits (design 5.2).
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    return { state: "waiting", why: "the directory changed while it was read" };
  }
  const opened: number[] = [];
  let blobs: Blobs | undefined;
  try {
    // A mark half made by a start that died is no mark (design 3.5): it is the temporary name.
    rmSync(join(dir, "tmp-failed-closed"), { force: true });
    // Every start sets it (design 3.8), a failed-closed one too: the directory is as exposed to a backup.
    await excludeFromBackup(dir, deps.exec, deps.os);
    const key = readFileSync(join(dir, "key.pem"));
    if (failedClosed(dir)) return { state: "failed closed", lock, key };
    const open = (name: string, flags: number) => {
      const fd = openSync(join(dir, name), flags);
      opened.push(fd);
      return fd;
    };
    // No O_CREAT: a journal that is not there is not made again.
    const journalFd = open("journal", constants.O_RDWR | constants.O_APPEND);
    const rounds = new Rounds(deps.seam, deps.log);
    blobs = new Blobs(deps.platform, rounds, deps.seam, join(dir, "blobs"));
    // The signer keeps the relay key in a platform of its own, so that a start again in one process can import it again.
    const sign = relaySigner(createNodePlatform(), key);
    const { seq, journal, dropped } = await Sequence.open(deps.platform, rounds, journalFd, {
      relay: found.relay,
      sign,
      held: blobs.held,
    });
    // "valid once" holds from the journal alone: the secret's hash goes with the first device entry (3.3).
    if (journal.placed.some((p) => p.kind === 1)) rmSync(join(dir, "enrol"), { force: true });
    blobs.start(seq);
    // Appended to for the run: the seals file stays open, as the journal does.
    const sealsFd = open("seals", constants.O_RDWR | constants.O_APPEND);
    const seals = await Seals.open(deps.platform, rounds, seq, sealsFd, found.relay, deps.log);
    const blobsFd = open("blobs", constants.O_RDONLY);
    await rounds.barrier([
      ["seals", sealsFd],
      ["blobs", blobsFd],
      ["directory", lock],
    ]);
    closeSync(blobsFd);
    opened.splice(opened.indexOf(blobsFd), 1);
    deps.log.info(`start: ${journal.placed.length} items, dropped ${dropped} bytes`);
    return {
      state: "serving",
      lock,
      key,
      relay: found.relay,
      journal,
      seq,
      seals,
      blobs,
      rounds,
      incarnation: randomBytes(16),
    };
  } catch (error) {
    for (const fd of opened) closeSync(fd);
    blobs?.close();
    closeSync(lock);
    // The directory changed between the check and the open: it is not whole, which waits (design 5.2).
    if (error instanceof NotWhole || (error as { code?: string }).code === "ENOENT") {
      return { state: "waiting", why: "the directory changed while it was read" };
    }
    throw error;
  }
}
