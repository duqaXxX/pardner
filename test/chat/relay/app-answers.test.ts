/**
 * The bodies the app's cards send (requests design 4): each case of `app-answers.json`, whose `answer` the Swift tests build with the
 * cards' controls (`app/Tests/ScreensTests/RequestCardTests.swift`), is fed to the bot's inbound path as the kind 10 it would be, for a
 * request of its type, and must reach the core as the answer the fixture names.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { questionsOf } from "../../../src/chat/relay/inbound.ts";
import type { OwnerAnswer } from "../../../src/chat/seam.ts";
import { fill } from "../../protocol/sequence.ts";
import { E1, inc, rig } from "./inbound-rig.ts";

type Case = {
  name: string;
  request: { type: OwnerAnswer["type"] } & Record<string, unknown>;
  answer: OwnerAnswer;
};
const { cases } = JSON.parse(
  readFileSync(new URL("./app-answers.json", import.meta.url), "utf8"),
) as { cases: Case[] };

for (const c of cases) {
  test(`the bot hands on the app's reply: ${c.name}`, async () => {
    const r = rig();
    const asked = r.bot.say({
      kind: 9,
      re: { device: r.app.id, name: fill(60, 16) },
      name: fill(1, 16),
      content: JSON.stringify({ thread: "t", request: c.request, title: "x" }),
    });
    r.bot.flush(r.seq, E1, inc);
    const questions = questionsOf(c.request);
    r.inbound.expect(
      asked.name,
      c.request.type === "question" && questions
        ? { requestId: "id1", ref: { channel: "c", thread: "t" }, type: "question", questions }
        : { requestId: "id1", ref: { channel: "c", thread: "t" }, type: c.request.type as never },
    );
    await r.feed();
    // The app's reply is exactly `{answer}`: no `thread`, since the card names the request by `re`.
    r.app.say({
      kind: 10,
      to: r.bot.id,
      re: { device: r.bot.id, name: asked.name },
      content: JSON.stringify({ answer: c.answer }),
    });
    r.app.flush(r.seq, E1, inc);
    await r.feed();
    await r.echo();
    assert.deepEqual(r.answers, [["id1", c.answer]]);
    assert.equal(r.inbound.waiting.size, 0, "the request is no longer waited on");
    const verdict = r.queued.find((q) => q.draft.kind === 5);
    assert.ok(verdict, "an accepted reply is answered");
    assert.equal(JSON.parse(verdict.draft.content).markdown, "", "with an empty kind 5");
  });
}

/**
 * The prompts the app's Stop and session menu send (`control-content.json`, whose `appBuilt` bodies the Swift tests rebuild and
 * compare field by field): the bot reads `text` and `thread` alone, so each reaches the core as the same prompt without the `control` field.
 */
type Prompt = { name: string; content: Record<string, unknown> };
const { cases: prompts } = JSON.parse(
  readFileSync(
    new URL("../../protocol/content-vectors/control-content.json", import.meta.url),
    "utf8",
  ),
) as { cases: Prompt[] };

async function reaches(content: Record<string, unknown>) {
  const r = rig();
  r.prompt({ text: "start" });
  await r.feed();
  await r.echo();
  const thread = r.messages[0]?.ref.thread;
  r.prompt({ ...content, thread });
  await r.feed();
  await r.echo();
  const m = r.messages[1];
  return [m?.text, m?.topLevel, m?.literal, m?.ref.thread === thread, await m?.content()];
}

for (const c of prompts) {
  test(`the bot reads the app's prompt as it reads the typed one: ${c.name}`, async () => {
    const { control: _flag, ...typed } = c.content;
    const [text] = await reaches(c.content);
    assert.equal(text, c.content.text);
    assert.deepEqual(await reaches(c.content), await reaches(typed));
  });
}
