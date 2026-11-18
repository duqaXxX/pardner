/**
 * Reads the answers of `pardner setup` from the terminal with `node:readline` alone: a line with
 * `readline/promises` `question`, a secret with the terminal's echo off, a pick from a numbered
 * list. Each ends without an answer (null) on Ctrl-C, on Ctrl-D at an empty line (readline's own
 * binding, which deletes otherwise) and at the end of the input. Keys typed after Enter in the same
 * chunk are not kept: setup asks one question at a time and checks each answer.
 *
 * An answered prompt erases what it drew with `readline.moveCursor`, `cursorTo` and
 * `clearScreenDown`, on a terminal only, so the wizard's own answer line is all that stays. The
 * rows of a line the owner typed are readline's own measure, `rl.getCursorPos()` (public since
 * v13.5, so wide characters, a pasted line and a line that fills the width exactly are counted as
 * readline drew them) plus the row of the newline; a secret counts the rows it drew itself.
 *
 * Read in the Node 26 docs, 2026-11-18: `readline.emitKeypressEvents(stream)` makes a stream emit
 * 'keypress' and, on a TTY, needs it in raw mode; `ReadStream.setRawMode(mode)` sets it and
 * `ReadStream.isRaw` reports it; `rl.getCursorPos()` gives the row and column of the cursor in the
 * prompt. The docs do not say what `rl.question` does when its interface closes: Node 26.5.1
 * rejects it with an `AbortError` on a terminal and leaves it pending on a pipe, so every prompt
 * races the interface's `close` event and never depends on either.
 */

import { clearScreenDown, cursorTo, emitKeypressEvents, moveCursor } from "node:readline";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

/** The two streams a prompt reads and writes: the process's own unless a test gives others. */
export interface Terminal {
  input: Readable;
  output: Writable;
}

const PROCESS_TERMINAL = (): Terminal => ({ input: process.stdin, output: process.stdout });

/** The part of a TTY's input a secret read uses; a pipe has neither member. */
interface RawInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

/**
 * The rows a prompt has drawn on a terminal, so that the answered prompt can clear itself and leave
 * the wizard's own answer line alone on the screen. Text the prompt wrote itself is counted by
 * the output's columns (a longer row counts as the rows it wraps to; tabs and wide characters as
 * one column), a typed line by readline. Nothing is erased on an output that is no terminal.
 */
class Screen {
  private rows = 0;
  private readonly output: Writable & { isTTY?: boolean; columns?: number };

  constructor(output: Writable) {
    this.output = output;
  }

  /** Counts `rows` rows already measured. */
  add(rows: number): void {
    this.rows += rows;
  }

  /** Counts `text`, written up to the end of its last row (the cursor is then at the next row). */
  drew(text: string): void {
    // A pty that reports no size has columns 0 (seen under `script`), and 80 stands for it.
    const columns = this.output.columns || 80;
    for (const row of text.split("\n")) this.rows += Math.max(1, Math.ceil(row.length / columns));
  }

  /** Moves back over every row counted and clears from there down. */
  erase(): void {
    if (this.output.isTTY !== true || this.rows === 0) return;
    moveCursor(this.output, 0, -this.rows);
    cursorTo(this.output, 0);
    clearScreenDown(this.output);
    this.rows = 0;
  }
}

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

/**
 * Runs `use` with one readline interface on `io`, closed when it ends. `ask` rejects with an
 * `AbortError` when the input ends while a question waits. With a `screen`, each answered
 * question adds the rows it took, measured before Enter, plus the newline's.
 */
async function withLines<T>(
  io: Terminal,
  screen: Screen | null,
  use: (ask: (query: string) => Promise<string>) => Promise<T>,
): Promise<T> {
  const lines = createInterface({ input: io.input, output: io.output });
  const closed = new Promise<never>((_, reject) => {
    lines.once("close", () => reject(new DOMException("The input ended", "AbortError")));
  });
  closed.catch(() => {}); // a close after the last answer is no one's error
  const ask = (query: string): Promise<string> => {
    const answered = lines.question(query);
    let at = lines.getCursorPos();
    // Readline's own key handler ran first; the Enter that ends the line moves the cursor on.
    const onKey = (_text: unknown, key: { name?: string } | undefined): void => {
      if (key?.name !== "return" && key?.name !== "enter") at = lines.getCursorPos();
    };
    io.input.on("keypress", onKey);
    return Promise.race([answered, closed])
      .then((answer) => {
        // A line that ends exactly at the width puts readline's cursor at column 0 of a row the
        // terminal has drawn only if readline redrew the line (keys typed one by one), not for a
        // paste written straight through. That row is never counted: a typed line of exactly the
        // width leaves one stale row, while counting it would erase the wizard's line above a paste.
        screen?.add(at.rows + (at.cols === 0 ? 0 : 1));
        return answer;
      })
      .finally(() => io.input.off("keypress", onKey));
  };
  try {
    return await use(ask);
  } finally {
    lines.close();
  }
}

/** Prints `question` and returns the line the owner types; rejects with an `AbortError` when they end the input. */
export function readLine(question: string, io: Terminal = PROCESS_TERMINAL()): Promise<string> {
  return withLines(io, null, (ask) => ask(question));
}

/** The line typed with nothing echoed, or null on Ctrl-C, Ctrl-D or the end of the input. */
function readSecret(message: string, io: Terminal): Promise<string | null> {
  const input = io.input as Readable & RawInput;
  const wasRaw = input.isRaw === true;
  return new Promise((resolve, reject) => {
    let typed = "";
    const finish = (settle: () => void): void => {
      input.off("keypress", onKey);
      input.off("end", onEnd);
      input.off("error", onError);
      // Every exit path comes here, so the terminal is never left in raw mode.
      input.setRawMode?.(wasRaw);
      input.pause();
      settle();
    };
    const onKey = (
      text: string | undefined,
      key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined,
    ): void => {
      if (key?.ctrl === true && (key.name === "c" || (key.name === "d" && typed === ""))) {
        io.output.write("\n");
        finish(() => resolve(null));
      } else if (key?.name === "return" || key?.name === "enter") {
        io.output.write("\n");
        finish(() => resolve(typed));
      } else if (key?.name === "backspace") {
        if (typed !== "") io.output.write("\b \b");
        typed = typed.slice(0, -1);
      } else if (text !== undefined && key?.ctrl !== true && key?.meta !== true) {
        typed += text;
        io.output.write("*".repeat(text.length));
      }
    };
    const onEnd = (): void => finish(() => resolve(null));
    const onError = (error: Error): void => finish(() => reject(error));
    io.output.write(message);
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.on("keypress", onKey);
    input.once("end", onEnd);
    input.once("error", onError);
    input.resume();
  });
}

/** The line typed after `message` (hidden when `secret`), or null when the owner ended the wizard; an answer clears its question from the screen. */
export async function askTerminal(
  message: string,
  secret: boolean,
  io: Terminal = PROCESS_TERMINAL(),
): Promise<string | null> {
  const screen = new Screen(io.output);
  const question = `${message} `;
  try {
    // A pipe echoes nothing, so a secret on one is an ordinary line.
    if (secret && (io.input as RawInput).isTTY === true) {
      const answer = await readSecret(question, io);
      // One star was shown for each character typed.
      if (answer !== null) screen.drew(question + "*".repeat(answer.length));
      screen.erase();
      return answer;
    }
    const answer = await withLines(io, screen, (ask) => ask(question));
    screen.erase();
    return answer;
  } catch (error) {
    if (isAbort(error)) return null;
    throw error;
  }
}

/** The name the owner picks from `names` by its number, Enter taking `preselected`, listed first; null when they ended the wizard. The list and the tries clear from the screen. */
export async function chooseTerminal(
  message: string,
  names: readonly string[],
  preselected: string,
  io: Terminal = PROCESS_TERMINAL(),
): Promise<string | null> {
  const choices = [preselected, ...names.filter((name) => name !== preselected)];
  const list = choices.map((name, index) => `  ${index + 1}) ${name}`).join("\n");
  const screen = new Screen(io.output);
  try {
    const picked = await withLines(io, screen, async (ask) => {
      io.output.write(`${message}\n${list}\n`);
      screen.drew(`${message}\n${list}`);
      for (;;) {
        const answer = await ask("Number (Enter for 1): ");
        const typed = answer.trim();
        if (typed === "") return preselected;
        const number = Number(typed);
        if (/^\d+$/.test(typed) && number >= 1 && number <= choices.length) {
          return choices[number - 1] as string;
        }
        const retry = `Enter a number from 1 to ${choices.length}.`;
        io.output.write(`${retry}\n`);
        screen.drew(retry);
      }
    });
    screen.erase();
    return picked;
  } catch (error) {
    if (isAbort(error)) return null;
    throw error;
  }
}
