/**
 * Design 3.8: the sticky Time Machine exclusion of the relay's directory. `tmutil addexclusion`
 * with no `-p` needs no root; the attribute follows the directory when it is renamed or copied.
 */
import { execFile } from "node:child_process";
import { errorFields } from "./log.ts";

/** Runs a program: replaced by a test, so that none calls `tmutil`. */
export type Exec = (file: string, args: string[]) => void | Promise<void>;

// `tmutil addexclusion` took 11 s on the Mac mini (macOS 27.2.1, measured 2026-11-19): it waits on Spotlight.
export const EXEC_TIMEOUT_MS = 60_000;

/** `execFile` with a timeout: the event loop is free while `tmutil` runs. */
export const execWithTimeout = (timeout: number): Exec & { timeout: number } =>
  Object.assign<Exec, { timeout: number }>(
    (file, args) =>
      new Promise((resolve, reject) =>
        execFile(file, args, { timeout }, (error) => (error ? reject(error) : resolve())),
      ),
    { timeout },
  );
export const nodeExec = execWithTimeout(EXEC_TIMEOUT_MS);

/** The exclusion could not be set: the relay does not serve without it (design 3.8). */
export class ExclusionFailed extends Error {}

/** Excludes `path` from Time Machine backups on macOS; a no-op elsewhere. */
export async function excludeFromBackup(
  path: string,
  exec: Exec = nodeExec,
  os: string = process.platform as string,
): Promise<void> {
  if (os !== "darwin") return;
  try {
    await exec("/usr/bin/tmutil", ["addexclusion", path]);
  } catch (error) {
    // The message of an `execFile` error holds the command line, and so the path: only the status is told.
    const { code, killed } = error as { code?: unknown; killed?: boolean };
    const cause =
      typeof code === "number" ? `exit status ${code}` : killed ? "timed out" : errorFields(error);
    throw new ExclusionFailed(`the Time Machine exclusion could not be set (${cause})`, {
      cause: error,
    });
  }
}
