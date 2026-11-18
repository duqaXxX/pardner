/**
 * The terminal prompts of `pardner setup` on fake TTY streams: what each returns for a typed
 * line, a pick, Ctrl-C and Ctrl-D, and that a secret is never echoed and leaves raw mode as it
 * found it. The real terminal is checked by hand (`docs/CHANGELOG.md`, 3.4 of the cleanup plan).
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { askTerminal, chooseTerminal, readLine, type Terminal } from "../../src/host/prompter.ts";

interface Fake {
  io: Terminal;
  /** Everything written to the output. */
  shown: () => string;
  /** Types `text` on the input, as one chunk. */
  type: (text: string) => void;
  /** The raw mode the stream was left in, and every mode it was set to. */
  raw: { now: boolean; calls: boolean[] };
}

function fakeTerminal(isTty = true, columns = 80): Fake {
  const input = Object.assign(new PassThrough(), {
    isTTY: isTty,
    isRaw: false,
    setRawMode(mode: boolean) {
      raw.now = mode;
      raw.calls.push(mode);
      this.isRaw = mode;
      return this;
    },
  });
  const raw = { now: false, calls: [] as boolean[] };
  const output = Object.assign(new PassThrough(), { isTTY: isTty, columns });
  let written = "";
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString();
  });
  return {
    io: { input, output },
    shown: () => written,
    type: (text) => void input.write(text),
    raw,
  };
}

/** Lets the prompt under test read what was typed. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

test("askTerminal returns the line typed", async () => {
  const fake = fakeTerminal();
  const answer = askTerminal("Address?", false, fake.io);
  fake.type("127.0.0.1:47311\r");
  assert.equal(await answer, "127.0.0.1:47311");
  assert.match(fake.shown(), /Address\?/);
});

test("askTerminal returns null on Ctrl-C, on Ctrl-D and at the end of the input", async () => {
  for (const ending of ["\x03", "\x04"]) {
    const fake = fakeTerminal();
    const answer = askTerminal("Address?", false, fake.io);
    await settle();
    fake.type(ending);
    assert.equal(await answer, null, JSON.stringify(ending));
  }
  const piped = fakeTerminal(false);
  const answer = askTerminal("Address?", false, piped.io);
  (piped.io.input as PassThrough).end();
  assert.equal(await answer, null);
});

test("a secret answer is read with nothing echoed and raw mode restored on Enter", async () => {
  const fake = fakeTerminal();
  const answer = askTerminal("Token?", true, fake.io);
  await settle();
  assert.equal(fake.raw.now, true);
  fake.type("ab");
  fake.type("x\x7fc\r");
  assert.equal(await answer, "abc");
  assert.equal(fake.raw.now, false);
  assert.ok(!/[abc]/.test(fake.shown().replace("Token?", "")), JSON.stringify(fake.shown()));
});

test("a secret answer ends with null on Ctrl-C, and on Ctrl-D only on an empty line, raw mode restored", async () => {
  for (const typed of ["ab\x03", "\x04"]) {
    const fake = fakeTerminal();
    const answer = askTerminal("Token?", true, fake.io);
    await settle();
    fake.type(typed);
    assert.equal(await answer, null, JSON.stringify(typed));
    assert.equal(fake.raw.now, false);
    assert.ok(!/[ab]/.test(fake.shown().replace("Token?", "")));
  }
  const fake = fakeTerminal();
  const answer = askTerminal("Token?", true, fake.io);
  await settle();
  fake.type("ab\x04");
  await settle();
  assert.equal(fake.raw.now, true, "Ctrl-D after text does not end the prompt");
  fake.type("\r");
  assert.equal(await answer, "ab");
});

test("a secret shows one star per character typed and takes one away on backspace", async () => {
  const fake = fakeTerminal();
  const answer = askTerminal("Token?", true, fake.io);
  await settle();
  fake.type("ab");
  fake.type("\x7f");
  fake.type("c\r");
  assert.equal(await answer, "ac");
  assert.ok(fake.shown().includes("Token? **\b \b*\n"), JSON.stringify(fake.shown()));
});

test("a question is followed by a space before the answer, on both paths", async () => {
  for (const secret of [false, true]) {
    const fake = fakeTerminal();
    const answer = askTerminal("Address:", secret, fake.io);
    await settle();
    fake.type("a\r");
    await answer;
    assert.ok(fake.shown().includes("Address: "), JSON.stringify(fake.shown()));
    assert.ok(!fake.shown().includes("Address:a"));
  }
});

test("a secret answer restores the raw mode the stream had before", async () => {
  const fake = fakeTerminal();
  (fake.io.input as unknown as { isRaw: boolean }).isRaw = true;
  const answer = askTerminal("Token?", true, fake.io);
  await settle();
  fake.type("a\r");
  await answer;
  assert.equal(fake.raw.now, true);
});

test("a secret answer ends with null when the input ends, raw mode restored", async () => {
  const fake = fakeTerminal();
  const answer = askTerminal("Token?", true, fake.io);
  await settle();
  (fake.io.input as PassThrough).end();
  assert.equal(await answer, null);
  assert.equal(fake.raw.now, false);
});

test("a secret answer on a stream that is no terminal is read as a line", async () => {
  const piped = fakeTerminal(false);
  const answer = askTerminal("Token?", true, piped.io);
  piped.type("abc\n");
  assert.equal(await answer, "abc");
});

test("chooseTerminal lists the names, preselected first, and takes the number typed", async () => {
  const fake = fakeTerminal();
  const answer = chooseTerminal("Agent?", ["claude", "codex", "other"], "codex", fake.io);
  fake.type("3\r");
  assert.equal(await answer, "other");
  assert.match(fake.shown(), /1\) codex[\s\S]*2\) claude[\s\S]*3\) other/);
});

test("chooseTerminal takes the preselected name on Enter", async () => {
  const fake = fakeTerminal();
  const answer = chooseTerminal("Agent?", ["claude", "codex"], "codex", fake.io);
  fake.type("\r");
  assert.equal(await answer, "codex");
});

test("chooseTerminal asks again on a number out of range or on a word", async () => {
  const fake = fakeTerminal();
  const answer = chooseTerminal("Agent?", ["claude", "codex"], "claude", fake.io);
  fake.type("0\r");
  await settle();
  fake.type("3\r");
  await settle();
  fake.type("two\r");
  await settle();
  fake.type("1.5\r");
  await settle();
  fake.type("2\r");
  assert.equal(await answer, "codex");
  assert.equal(fake.shown().match(/Enter a number from 1 to 2/g)?.length, 4);
});

test("chooseTerminal returns null on Ctrl-C and on Ctrl-D", async () => {
  for (const ending of ["\x03", "\x04"]) {
    const fake = fakeTerminal();
    const answer = chooseTerminal("Agent?", ["claude", "codex"], "claude", fake.io);
    await settle();
    fake.type(ending);
    assert.equal(await answer, null, JSON.stringify(ending));
  }
});

test("readLine rejects when the owner ends the input, as the update's question does", async () => {
  const fake = fakeTerminal();
  const answer = readLine("Go on? ", fake.io);
  await settle();
  fake.type("\x04");
  await assert.rejects(answer, { name: "AbortError" });
});

/** What erases `rows` rows above the cursor: up, to column 1, clear below. */
const erase = (rows: number): string => `\x1b[${rows}A\x1b[1G\x1b[0J`;

test("askTerminal erases the question and the answer once read", async () => {
  const fake = fakeTerminal();
  const answer = askTerminal("Address?", false, fake.io);
  fake.type("abc\r");
  await answer;
  assert.ok(fake.shown().endsWith(erase(1)), JSON.stringify(fake.shown()));
});

test("askTerminal erases a question and answer that wrapped, by the output's columns", async () => {
  const fake = fakeTerminal(true, 10);
  const answer = askTerminal("0123456789ab", false, fake.io);
  fake.type("xy\r");
  await answer;
  assert.ok(fake.shown().endsWith(erase(2)), JSON.stringify(fake.shown()));
});

test("a secret's line is erased, and a cancelled answer erases nothing", async () => {
  const fake = fakeTerminal();
  const answer = askTerminal("Token?", true, fake.io);
  await settle();
  fake.type("abc\r");
  await answer;
  assert.ok(fake.shown().endsWith(erase(1)), JSON.stringify(fake.shown()));
  const cancelled = fakeTerminal();
  const none = askTerminal("Token?", true, cancelled.io);
  await settle();
  cancelled.type("\x03");
  await none;
  assert.ok(!cancelled.shown().includes("\x1b[0J"));
});

test("chooseTerminal erases the list, every try and every retry once a name is taken", async () => {
  const fake = fakeTerminal();
  const answer = chooseTerminal("Agent?", ["claude", "codex"], "claude", fake.io);
  fake.type("9\r");
  await settle();
  fake.type("2\r");
  await answer;
  // Agent?, two list rows, "Number" with 9, the retry line, "Number" with 2.
  assert.ok(fake.shown().endsWith(erase(6)), JSON.stringify(fake.shown()));
});

test("nothing is erased, and nothing extra printed, on an output that is no terminal", async () => {
  const piped = fakeTerminal(false);
  const answer = askTerminal("Address?", false, piped.io);
  piped.type("abc\n");
  await answer;
  assert.ok(!piped.shown().includes("\x1b"));
});

test("an output that reports no width (columns 0) is taken as 80 wide", async () => {
  const fake = fakeTerminal(true, 0);
  const answer = askTerminal("Address?", false, fake.io);
  fake.type("abc\r");
  await answer;
  assert.ok(fake.shown().endsWith(erase(1)), JSON.stringify(fake.shown()));
});

test("a typed line that fills the width exactly never erases more than its own row", async () => {
  const fake = fakeTerminal(true, 10);
  const answer = askTerminal("Q:", false, fake.io);
  await settle();
  for (const key of "1234567") fake.type(key); // "Q: " and 7 keys fill the 10 columns
  fake.type("\r");
  await answer;
  // Readline's forced wrap may leave one stale row here: the safe direction (see the next test).
  assert.ok(fake.shown().endsWith(erase(1)), JSON.stringify(fake.shown()));
});

test("a pasted line that fills the width exactly keeps the line above the question", async () => {
  const fake = fakeTerminal(true, 10);
  const answer = askTerminal("Q:", false, fake.io);
  await settle();
  fake.type("1234567\r"); // one chunk: readline writes it straight through and draws one row
  await answer;
  assert.ok(fake.shown().endsWith(erase(1)), JSON.stringify(fake.shown()));
});

test("a pasted line that wraps is erased by the rows it took", async () => {
  const fake = fakeTerminal(true, 10);
  const answer = askTerminal("Q:", false, fake.io);
  await settle();
  fake.type("0123456789abcdef\r");
  await answer;
  assert.ok(fake.shown().endsWith(erase(2)), JSON.stringify(fake.shown()));
});

test("a secret that fills the width exactly is erased by the rows it drew", async () => {
  const fake = fakeTerminal(true, 10);
  const answer = askTerminal("Q:", true, fake.io);
  await settle();
  fake.type("1234567\r");
  await answer;
  assert.ok(fake.shown().endsWith(erase(1)), JSON.stringify(fake.shown()));
});

test("readLine settles when a piped input ends, whatever Node does at close", async () => {
  const piped = fakeTerminal(false);
  const answer = readLine("Go on? ", piped.io);
  (piped.io.input as PassThrough).end();
  await assert.rejects(answer, { name: "AbortError" });
});
