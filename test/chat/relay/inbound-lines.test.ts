/**
 * The bot's own lines read back (turn work C2, 3.4): a line a dead process left open is closed at each rest of
 * the reading; a line read closed, or written by this process, is left alone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "../../../src/chat/relay/hex.ts";
import { fill } from "../../protocol/sequence.ts";
import { E1, inc, rig } from "./inbound-rig.ts";

type Rig = ReturnType<typeof rig>;

const line = (status: string, over: object = {}) => ({
  title: "Run the tests",
  status,
  details: "npm test",
  output: null,
  task: true,
  startedAt: 1,
  ...over,
});

/** The bot's own text of a line (`name`), or an edit of it, read back from the journal. */
async function wrote(r: Rig, name: number, task: object, edit = false) {
  const lineName = fill(name, 16);
  r.bot.say(
    edit
      ? {
          kind: 11,
          re: { device: r.bot.id, name: lineName },
          content: JSON.stringify({ thread: "t", task }),
        }
      : { kind: 1, name: lineName, content: JSON.stringify({ thread: "t", say: "task", task }) },
  );
  r.bot.flush(r.seq, E1, inc);
  await r.feed();
}

const rest = (r: Rig) => r.inbound.take({ do: "rest", first: false });
const closes = (r: Rig) => r.queued.filter((q) => q.draft.kind === 11);

test("a line the journal holds open is closed at the rest, as last read", async () => {
  const r = rig();
  await wrote(r, 1, line("pending", { title: "old" }));
  await wrote(r, 1, line("in_progress", { title: "newest" }), true);
  assert.deepEqual(closes(r), [], "nothing before the rest");
  rest(r);
  await new Promise((done) => setTimeout(done, 20));
  const [close] = closes(r);
  assert.equal(closes(r).length, 1);
  assert.deepEqual(close?.draft.re, { device: r.bot.id, name: fill(1, 16) });
  assert.deepEqual(JSON.parse(close?.draft.content ?? "null"), {
    thread: "t",
    task: line("error", { title: "newest", output: "Stopped: the bot restarted", details: null }),
  });
  rest(r);
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(closes(r).length, 1, "closed once: the line left the map when queued");
});

test("a line read closed is left alone, whenever its end came", async () => {
  const r = rig();
  await wrote(r, 2, line("in_progress"));
  await wrote(r, 2, line("complete"), true);
  await wrote(r, 3, line("pending"));
  await wrote(r, 3, line("error", { output: "boom" }), true);
  rest(r);
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(closes(r), []);
});

test("a line this process wrote is never closed", async () => {
  const r = rig();
  r.inbound.mine.add(toHex(fill(4, 16)));
  await wrote(r, 4, line("in_progress"));
  rest(r);
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(closes(r), []);
});

test("a text that is no line, and an edit of a request, are not lines", async () => {
  const r = rig();
  r.bot.say({ kind: 1, content: JSON.stringify({ thread: "t", say: "say", markdown: "hi" }) });
  r.bot.flush(r.seq, E1, inc);
  await r.feed();
  rest(r);
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(closes(r), []);
});

test("a close the outbox refuses stays for the next rest", async () => {
  const r = rig();
  await wrote(r, 1, line("in_progress"));
  r.refusing.on = true;
  rest(r);
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(closes(r), [], "refused");
  r.refusing.on = false;
  rest(r);
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(closes(r).length, 1, "closed at the next rest");
});

test("the close is cut to the room a line write keeps, and a line that cannot fit stays", async () => {
  const r = rig();
  await wrote(r, 1, line("in_progress", { details: "d".repeat(2_000_000) }));
  await wrote(r, 2, line("in_progress", { title: "t".repeat(2_000_000) }));
  rest(r);
  await new Promise((done) => setTimeout(done, 20));
  const [close, ...others] = closes(r);
  assert.equal(others.length, 0, "the line no cut can fit is not written");
  assert.ok(Buffer.byteLength(close?.draft.content ?? "") <= 1_048_576 - 4096);
  assert.equal(
    JSON.parse(close?.draft.content ?? "null").task.output,
    "Stopped: the bot restarted",
  );
});
