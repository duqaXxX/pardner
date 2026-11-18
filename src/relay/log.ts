import { writeSync } from "node:fs";

/** The relay's log: lines on standard error (design 2.5, section 7). */
export interface Log {
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

const two = (value: number) => String(value).padStart(2, "0");

/** `2026-10-10 09:05:03,042`, local time, as `src/log.ts` writes it. */
function timestamp(at: Date): string {
  const day = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
  const time = `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
  return `${day} ${time},${String(at.getMilliseconds()).padStart(3, "0")}`;
}

// A synchronous write: the line before a `process.exit` (design 2.4, code 75) is never dropped on a pipe.
const toStderr = (line: string) => {
  try {
    writeSync(2, `${line}\n`);
  } catch {}
};

/** Lines shaped `<time> <LEVEL> relay: <message>`, written by `write`, timed by `now` (milliseconds). */
export function createLog(
  write: (line: string) => void = toStderr,
  now: () => number = Date.now,
): Log {
  const line = (level: string) => (message: string) =>
    write(`${timestamp(new Date(now()))} ${level} relay: ${message}`);
  return { info: line("INFO"), warning: line("WARNING"), error: line("ERROR") };
}

/** The `code` and `syscall` of a file system error and nothing else: its message and path name files. */
export function errorFields(error: unknown): string {
  const fields =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const word = (value: unknown, shape: RegExp) =>
    typeof value === "string" && shape.test(value) ? value : "unknown";
  return `code=${word(fields.code, /^[A-Z0-9_]+$/)} syscall=${word(fields.syscall, /^[a-z0-9_]+$/)}`;
}
