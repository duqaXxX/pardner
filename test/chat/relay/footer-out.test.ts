/**
 * A work's end and a session's title as texts of the bot (D2 design 3.1, 3.2). The outbox is a record;
 * the content shape is the shared vector file the app's tests read too.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { footerContent, type Owner } from "../../../src/chat/relay/footer.ts";
import type { Inbound } from "../../../src/chat/relay/inbound.ts";
import type { Outbox } from "../../../src/chat/relay/outbox.ts";
import { RelayProvider } from "../../../src/chat/relay/provider.ts";
import {
  ChatError,
  type ChatProvider,
  type FooterFields,
  type Reply,
} from "../../../src/chat/seam.ts";
import { formatUntil } from "../../../src/core/footer.ts";
import type { LoggedMember } from "../../../src/protocol/member-log.ts";
import type { Draft } from "../../../src/protocol/outbox.ts";
import { platform } from "../../relay/support.ts";

const self = new Uint8Array(32).fill(7);
const person = new Uint8Array(32).fill(1);
const stranger = new Uint8Array(32).fill(2);
const prompt = "ab".repeat(32) + "cd".repeat(16);
const ref = { channel: "01".repeat(32), thread: prompt };

const fields = (over: Partial<FooterFields> = {}): FooterFields => ({
  bypass: false,
  planning: false,
  model: null,
  advisor: null,
  effort: null,
  effortObserved: null,
  folder: null,
  branch: null,
  gitUntrusted: false,
  changes: null,
  sessionTokens: null,
  contextPercent: null,
  sessionLimit: null,
  weekLimit: null,
  limitsReadAt: null,
  account: null,
  accountPlan: null,
  sessionCost: null,
  work: { durationMs: 12_000, doneAt: 1_763_999_820_000 },
  ...over,
});

type Window = { percent: number; resetsAt: number | null } | null;
const vectors = JSON.parse(
  readFileSync(
    new URL("../../protocol/content-vectors/session-text-content.json", import.meta.url),
    "utf8",
  ),
) as {
  texts: Array<{ name: string; content: Record<string, unknown> }>;
  usageLines: Array<{
    name: string;
    windows: { session: Window; week: Window } | null;
    now: number;
    text: string | null;
  }>;
};
const vector = (name: string) =>
  (vectors.texts.find((t) => t.name === name) as { content: Record<string, unknown> }).content;

const NOW = 1_764_000_000_000;
const full = fields({
  bypass: true,
  model: "Opus 5.5",
  advisor: "Opus",
  effort: "high",
  branch: "main",
  changes: [12, 3],
  contextPercent: 34,
  sessionTokens: 182_000,
  folder: "/Us" + "ers/x/demo/project",
  work: { durationMs: 252_000, doneAt: 1_763_999_820_000 },
  sessionLimit: { percent: 40, resetsAt: 1_764_007_500_000 },
  weekLimit: { percent: 24, resetsAt: null },
  limitsReadAt: null,
});

test("a work's end with every part is the content of the shared vector", () => {
  assert.deepEqual(footerContent(full, NOW, true), vector("work end with every part"));
});

test("without the owner alone the content is the vector without usage", () => {
  const plan = fields({
    planning: true,
    bypass: true,
    model: "Opus 5.5",
    work: { durationMs: 12_000, doneAt: 1 },
    sessionLimit: full.sessionLimit,
  });
  assert.deepEqual(
    footerContent(plan, NOW, false),
    vector("work end in a channel shared with another person: no usage"),
  );
});

test("one window known, and no length known", () => {
  const week = { percent: 21, resetsAt: 1_764_277_800_000 };
  const known = fields({
    work: { durationMs: 3_723_000, doneAt: 1_763_999_820_000 },
    weekLimit: week,
    limitsReadAt: null,
  });
  assert.deepEqual(footerContent(known, NOW, true), vector("work end with one window known"));
  const none = fields({ model: "Opus 5.5", work: null, sessionLimit: week });
  assert.deepEqual(footerContent(none, NOW, true), vector("work end with no length known"));
});

test("plan mode shows in place of bypass; a default effort carries what it ran at", () => {
  const plan = fields({ planning: true, bypass: true, effort: "auto", effortObserved: "medium" });
  assert.equal(footerContent(plan, NOW, false).session, "⏸ plan · effort auto (medium)");
});

test("a folder of one name, no branch, an untrusted folder and unknown values", () => {
  assert.equal(footerContent(fields({ folder: "/demo" }), NOW, false).session, "demo");
  assert.equal(footerContent(fields({ changes: [1, 2] }), NOW, false).session, "(+1,-2)");
  const untrusted = fields({ gitUntrusted: true, folder: "C:\\a\\b\\c" });
  assert.equal(footerContent(untrusted, NOW, false).session, "git not trusted · b/c");
  const bare = footerContent(fields(), NOW, true);
  assert.equal("session" in bare, false);
  assert.equal("usage" in bare, false, "nothing known: no usage");
});

test("the account's email and plan are never in the text", () => {
  const account = fields({ ...full, account: "a" + "@b.example", accountPlan: "Claude Max" });
  const text = JSON.stringify(footerContent(account, NOW, true));
  assert.equal(text.includes("a" + "@b.example"), false);
  assert.equal(text.includes("Claude Max"), false);
});

test("the account line's `↻` parts are the core's formatUntil of the reset", () => {
  for (const c of vectors.usageLines) {
    if (!c.windows || c.text === null) continue;
    for (const [label, window] of [
      ["5h", c.windows.session],
      ["7d", c.windows.week],
    ] as const) {
      if (!window) continue;
      const passed = window.resetsAt === null || window.resetsAt <= c.now;
      const part: string | undefined = c.text.split(" · ").find((p) => p.startsWith(`${label} `));
      const until = passed ? "" : ` ↻ ${formatUntil((window.resetsAt as number) - c.now)}`;
      assert.equal(part, `${label} ${window.percent}%${until}`, c.name);
    }
  }
});

test("a work's end writes the session's cost as the core gives it", () => {
  const known = fields({
    sessionCost: 1.84,
    work: { durationMs: 38_000, doneAt: 1_763_999_820_000 },
  });
  assert.deepEqual(
    footerContent(known, NOW, true),
    vector("work end of an account with no plan: the cost alone"),
  );
  const none = fields({ ...known, sessionCost: null });
  assert.equal("usage" in footerContent(none, NOW, true), false, "no cost and no window: no usage");
  const both = footerContent({ ...none, weekLimit: { percent: 5, resetsAt: null } }, NOW, true);
  assert.equal(JSON.stringify(both).includes("cost"), false);
});

test("the cost is written only in a channel of the owner's alone, and in no line", () => {
  const known = fields({ sessionCost: 1.84, model: "Opus 5.5" });
  const shared = footerContent(known, NOW, false);
  assert.equal(JSON.stringify(shared).includes("1.84"), false);
  assert.equal("usage" in shared, false);
  assert.equal(footerContent(known, NOW, true).session, "Opus 5.5");
});

const entry = (body: object, by: Uint8Array, seq: number) =>
  ({
    entry: { seq, signerPerson: by, signerDevice: by, ...body },
    id: new Uint8Array(32).fill(seq),
    changesMembers: true,
    space: false,
  }) as unknown as LoggedMember;
const alone = [entry({ kind: "create" }, person, 0)];
const shared = [
  ...alone,
  entry({ kind: "add", person: stranger, role: "member" }, person, 1),
  entry({ kind: "accept" }, stranger, 2),
];

const owner = (members: LoggedMember[] | undefined): Owner => ({
  person,
  reading: { channel: () => (members ? ({ members } as never) : undefined) },
});

/** A reply over an outbox that records its drafts; `answers` says what each queue gives, in turn. */
function setup(
  options: { owner?: Owner; answers?: Array<boolean | Error>; holds?: () => boolean } = {},
) {
  const queued: Draft[] = [];
  const answers = [...(options.answers ?? [])];
  const outbox = {
    queue: async (_: unknown, draft: Draft) => {
      const answer = answers.shift() ?? true;
      queued.push(draft);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    holds: options.holds ?? (() => true),
  } as unknown as Outbox;
  const inbound = {
    closed: () => false,
    mine: new Set<string>(),
    replyOf: () => ({ name: new Uint8Array(16), text: "" }),
  } as unknown as Inbound;
  const provider = new RelayProvider(
    self,
    outbox,
    inbound,
    platform,
    undefined,
    undefined,
    undefined,
    options.owner,
  );
  const reply: Reply = provider.thread(ref).openReply(() => {}, prompt);
  const body = (d: Draft | undefined) => JSON.parse(d?.content ?? "null");
  const texts = () => queued.filter((d) => d.kind === 1);
  return { provider, reply, queued, texts, body };
}

test("a footer is a text of its own: kind 1, no re, say footer, in the thread", async () => {
  const w = setup({ owner: owner(alone) });
  assert.equal(await w.reply.showFooter(full), true);
  const [draft] = w.texts();
  assert.equal(draft?.re, undefined);
  assert.deepEqual(w.body(draft), { thread: prompt, ...vector("work end with every part") });
});

test("usage: with the owner alone, none with a second member, none in a channel not read yet", async () => {
  const cases: Array<[Owner | undefined, boolean]> = [
    [owner(alone), true],
    [owner(shared), false],
    [owner(undefined), false],
    [undefined, false],
  ];
  for (const [who, usage] of cases) {
    const w = setup({ owner: who });
    await w.reply.showFooter(full);
    assert.equal("usage" in w.body(w.texts()[0]), usage);
  }
});

test("a second call writes nothing and says true; two overlapping calls write one", async () => {
  const w = setup({ owner: owner(alone) });
  assert.deepEqual(await Promise.all([w.reply.showFooter(full), w.reply.showFooter(full)]), [
    true,
    true,
  ]);
  assert.equal(await w.reply.showFooter(full), true);
  assert.equal(w.texts().length, 1);
});

test("a reply whose write was refused is lost: no footer, false", async () => {
  const w = setup({ answers: [false] });
  await w.reply.text("part", { notice: true });
  assert.equal(await w.reply.showFooter(full), false);
  assert.equal(w.queued.length, 1, "nothing queued for the footer");
});

test("a reply the outbox took and then dropped gets no footer: false", async () => {
  const w = setup({ holds: () => false });
  await w.reply.text("part", { notice: true });
  assert.equal(await w.reply.showFooter(full), false);
  assert.equal(w.texts().filter((d) => w.body(d).say === "footer").length, 0);
});

test("a refused footer leaves settle true and lets the next offer write it", async () => {
  const w = setup({ answers: [false] });
  assert.equal(await w.reply.showFooter(full), false);
  assert.equal(await w.reply.settle(), true, "the footer is no part of the reply");
  assert.equal(await w.reply.showFooter(full), true);
  assert.equal(w.texts().length, 2, "asked again, written once it was taken");
});

test("a store write that fails writes one footer in all: the flag stays", async () => {
  const w = setup({ answers: [new Error("disk")] });
  assert.equal(await w.reply.showFooter(full), false);
  assert.equal(await w.reply.showFooter(full), true);
  assert.equal(await w.reply.showFooter(full), true);
  assert.equal(w.texts().length, 1);
});

test("a footer lands after the text the reply still holds", async () => {
  const w = setup();
  await w.reply.text("held words");
  await w.reply.showFooter(full);
  assert.deepEqual(
    w.queued.map((d) => d.kind),
    [4, 1],
  );
  assert.equal(w.body(w.queued[0]).markdown, "held words");
});

test("the relay declares threadTitles and titleThread queues one text, never calling keep", async () => {
  const w = setup();
  assert.equal(w.provider.capabilities.threadTitles, true);
  let kept = 0;
  await (w.provider as ChatProvider).titleThread?.(ref, "Fix the footer", () => {
    kept += 1;
  });
  const [draft] = w.texts();
  assert.equal(draft?.re, undefined);
  assert.deepEqual(w.body(draft), { thread: prompt, ...vector("title") });
  assert.equal(kept, 0);
});

test("a refused title rejects, and the next ask writes it; the same words twice write one", async () => {
  const w = setup({ answers: [false] });
  await assert.rejects(
    () => w.provider.titleThread?.(ref, "Fix the footer") as Promise<void>,
    (e) => e instanceof ChatError && e.name === "relay_not_queued",
  );
  await w.provider.titleThread?.(ref, "Fix the footer");
  await w.provider.titleThread?.(ref, "Fix the footer");
  assert.equal(w.texts().length, 2, "the refused one and the one taken");
  await w.provider.titleThread?.(ref, "Another");
  assert.equal(w.texts().length, 3);
});

test("two overlapping calls with the same words write one; a failed store write writes one", async () => {
  const w = setup();
  await Promise.all([w.provider.titleThread?.(ref, "Same"), w.provider.titleThread?.(ref, "Same")]);
  assert.equal(w.texts().length, 1);
  const f = setup({ answers: [new Error("disk")] });
  await assert.rejects(() => f.provider.titleThread?.(ref, "T") as Promise<void>);
  await f.provider.titleThread?.(ref, "T");
  assert.equal(f.texts().length, 1, "the draft is held: the same words are not written again");
});

test("a work's end dates the limits by their read, and a cost alone by the work's end", () => {
  const read = fields({
    weekLimit: { percent: 41, resetsAt: null },
    limitsReadAt: 1_763_999_000_000,
  });
  assert.equal((footerContent(read, NOW, true).usage as { at: number }).at, 1_763_999_000_000);
  const cost = fields({ sessionCost: 1.84 });
  assert.equal((footerContent(cost, NOW, true).usage as { at: number }).at, 1_763_999_820_000);
});
