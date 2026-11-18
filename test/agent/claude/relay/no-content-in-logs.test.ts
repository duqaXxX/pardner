/**
 * Invariant 3, "no message content in logs", end to end over the relay: from alice's device through
 * the relay, the bot's reading and the core, to the reply written back. A mutation run of
 * 2026-10-11 showed it necessary: a listener that logged `message.text` failed no test, and the
 * claim rested on a reading of the logging calls.
 *
 * Every line the daemon writes is captured at the lowest level: the logger at `DEBUG`, the lines
 * the connection, the outbox and the reading pass to their own writer, and every write to standard
 * output or error and every `console` call (`teeOutput`), and checked again once the sessions have
 * closed and the provider has stopped. Every writer of the daemon is one of these, while the markers
 * below travel the paths below, and none may hold a marker. The markers are strings no code of the
 * daemon produces.
 *
 * Covered: a prompt at top level, its reply (the agent's text, streamed and final), a prompt in
 * the thread, `/bind` with a path, `/help` with a filter, and the free text of a question's
 * answer and the note text of a question. A message from a device that is not the owner's is
 * played in `test/chat/relay/inbound.test.ts`. Not covered: the text of a file or a clip the owner
 * attaches (the relay chat carries files from step 6), a search box of the chat (the relay has
 * none), `/resume`, `/open`, and a failure's own wording (a line that quotes an error message is
 * the error's, which `errorName` keeps out of the log by design).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { setLevel, setWriter } from "../../../../src/log.ts";
import { DARWIN } from "../../../relay/process-support.ts";
import { canUseToolCall, harnessFor, sdkMessages } from "../../../support/sessions.ts";
import {
  FIRST,
  firstOptions,
  recordedQuestion,
  relayWorld,
  shownAs,
  teeOutput,
  turnSaying,
} from "./relay-session.ts";

const PROMPT = "mk-prompt-7f3a91";
const ANSWER = "mk-reply-c42e08";
const IN_THREAD = "mk-thread-90d1b6";
const FOLDER = "mk-folder-31ab84";
const FILTER = "mk-filter-a8c0f2";
const OTHER = "mk-other-62de19";
const NOTE = "mk-note-19ce4d";
const MARKERS = [PROMPT, ANSWER, IN_THREAD, FOLDER, FILTER, OTHER, NOTE];

test(
  "no log line at any level holds a prompt, a reply or an owner's word, over the relay",
  DARWIN,
  async (t) => {
    const recorded = recordedQuestion();
    const w = await relayWorld(t);
    const h = harnessFor(
      t,
      {},
      w.setup,
    )({
      turns: [
        [canUseToolCall(recorded.toolName, recorded.input), ...turnSaying(ANSWER)],
        sdkMessages("tools"),
      ],
    });
    // `harnessFor` silenced the writer for the test's duration and restores it itself.
    const lines: string[] = [];
    setWriter((line) => lines.push(line));
    teeOutput(t, lines);
    setLevel("DEBUG");
    t.after(() => setLevel("INFO"));
    await w.attach(h);
    await w.connect();

    await w.begin(`please read ${PROMPT}`);
    await w.until((read) => read.requests.length > 0);
    const [asked] = (await w.read()).requests;
    const shown = shownAs((asked as NonNullable<typeof asked>).body);
    const answers = firstOptions(shown, [OTHER]);
    const notes = Object.fromEntries(shown.questions.map((q) => [q.text, NOTE]));
    await w.answer(String(asked?.name), { type: "question", answers, notes });
    await w.until((read) => read.answers.some((a) => a.re === FIRST));
    // The text really travelled: the agent was sent the prompt and alice reads the reply.
    assert.deepEqual(h.clients[0]?.queries, [`please read ${PROMPT}`]);
    const read = await w.read();
    assert.ok(
      read.answers
        .find((a) => a.re === FIRST)
        ?.body.markdown?.toString()
        .includes(ANSWER),
    );
    assert.ok(read.parts.some((p) => String(p.body.markdown).includes(ANSWER)));

    const inThread = await w.prompt(`and then ${IN_THREAD}`, w.thread);
    const bound = await w.prompt(`/bind ${join(h.tmpPath, FOLDER)}`, null);
    const help = await w.prompt(`/help ${FILTER}`, null);
    await w.until((r) =>
      [inThread, bound, help].every((name) => r.answers.some((a) => a.re === name)),
    );
    assert.ok(h.clients[0]?.queries.includes(`and then ${IN_THREAD}`));

    // The capture works: the daemon logs the requests it showed and the starts it wrote.
    assert.ok(lines.length > 0);
    assert.ok(w.lines.length > 0);
    const clean = () => {
      for (const line of [...lines, ...w.lines]) {
        for (const marker of MARKERS)
          assert.ok(!line.includes(marker), `a log line holds ${marker}: ${line}`);
      }
    };
    clean();
    // What the sessions and the provider write as they close is a line of the daemon's too.
    await h.manager.closeAll();
    await w.cleanUp();
    clean();
  },
);
