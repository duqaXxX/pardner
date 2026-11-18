import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** A private key as the file holds it: its use and its scalar in hex. */
export interface StoredKey {
  readonly use: "sign" | "receive";
  readonly sk: string;
}

/** The keys of `path`, none when the file does not exist; refuses a file others can read or parse. */
export function readKeyFile(path: string): Record<string, StoredKey> {
  let text: string;
  try {
    if ((statSync(path).mode & 0o077) !== 0) {
      throw new Error("the key file is readable by other users: remove it or set its mode to 0600");
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    return JSON.parse(text) as Record<string, StoredKey>;
  } catch {
    throw new Error("the key file does not parse; its content is not shown");
  }
}

/** The new file is in place; only the flush of its directory failed. */
export class RenamedOnly extends Error {}

/**
 * Replaces `path` with `text`: a temporary file created exclusively with mode 0600 (a leftover is
 * removed first, so its mode is never inherited), flushed, renamed over `path`, then the directory
 * flushed. A failure before the rename removes the temporary file and leaves `path` as it was;
 * one after it throws `RenamedOnly`, and `path` holds `text`.
 */
export function writeFileAtomic(path: string, text: string): void {
  const temporary = `${path}.tmp`;
  rmSync(temporary, { force: true });
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      // `writeSync` may write less than asked (a full disk, a size limit): write the rest, or fail.
      // The bytes may be a slice of Node's shared pool: zeroed once written.
      const bytes = Buffer.from(text);
      try {
        for (let done = 0; done < bytes.length; ) {
          const written = writeSync(fd, bytes, done);
          if (written === 0) throw new Error("the write made no progress");
          done += written;
        }
      } finally {
        bytes.fill(0);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  try {
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch {
    throw new RenamedOnly();
  }
}
