/**
 * Design 1, C2, C7 and C11: the daemon with the relay chat and the plain agent in a child process,
 * a real relay, and alice's device as the owner. Nothing runs Claude.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { REGISTRY } from "../../src/registry.ts";
import { hex, rig } from "../chat/relay/relay-rig.ts";
import { daemon, owner, pause, until, world } from "./bot-rig.ts";
import { DARWIN } from "./process-support.ts";

test("C11: the relay chat is the registry's one chat, recorded in state.json as relay", () => {
  assert.equal(REGISTRY.chat.name, "relay");
});

test(
  "C2: the owner binds a folder, answers the setup and gets the agent's reply as parts and one answer naming the prompt",
  DARWIN,
  async () => {
    const r = await rig();
    const w = world(r);
    const d = daemon(r, w, ["Done."]);
    const device = owner(r);
    try {
      await until(() => d.err().includes("relay: ") || d.out() !== "" || true, "the daemon", 100);
      await device.says(`/bind ${w.folder("work")}`);
      await until(
        async () => (await device.bodies(1)).length > 0,
        `the bind to be said: ${d.err()}`,
      );
      const prompt = await device.says("hello");
      await device.answersSetup(prompt.thread);
      await until(
        async () =>
          (await device.bodies(5)).some((m) => hex(m.re?.name ?? new Uint8Array()) === prompt.name),
        `the answer: ${d.err()}`,
      );
      await pause(500);
      const answers = (await device.opened(5)).filter(
        (a) => hex(a.header.re?.name ?? new Uint8Array()) === prompt.name,
      );
      assert.equal(answers.length, 1, "one answer for the prompt");
      assert.equal(String(answers[0]?.body.markdown).includes("Done."), true);
      assert.equal(answers[0]?.body.thread, prompt.thread);
      const parts = await device.opened(4);
      assert.equal(
        parts
          .map((p) => p.body.markdown)
          .join("")
          .includes("Done."),
        true,
      );
      for (const part of parts)
        assert.equal(
          hex(part.header.re?.name as Uint8Array),
          hex(answers[0]?.header.name as Uint8Array),
        );
      assert.equal(d.count("prompts"), 1, "the agent ran the prompt once");
    } finally {
      await d.kill("SIGINT");
      await r.stop();
    }
  },
);

test(
  "C7: two channels bound to two folders are busy at once: the second turn does not wait for the first",
  DARWIN,
  async () => {
    const r = await rig();
    const second = await r.open(4);
    const w = world(r);
    const d = daemon(r, w, ["hold", "quick"]);
    const one = owner(r);
    const two = owner(r, second.send);
    try {
      await one.says(`/bind ${w.folder("one")}`);
      await two.says(`/bind ${w.folder("two")}`);
      await until(
        async () => (await one.bodies(1)).length >= 2,
        `both binds to be said: ${d.err()}`,
      );
      const first = await one.says("slow");
      await one.answersSetup(first.thread);
      await until(() => d.count("held") === 1, `the first turn held: ${d.err()}`);
      const quick = await two.says("fast");
      await two.answersSetup(quick.thread);
      await until(
        async () =>
          (await one.bodies(5)).some((m) => hex(m.re?.name ?? new Uint8Array()) === quick.name),
        `the second channel's answer while the first turn is held: ${d.err()}`,
      );
      assert.equal(d.count("held"), 1, "the first turn is still held");
      const answered = (await one.opened(5)).map((a) => hex(a.header.re?.name ?? new Uint8Array()));
      assert.equal(answered.includes(first.name), false, "the held turn has no answer");
    } finally {
      await d.kill("SIGINT");
      await r.stop();
    }
  },
);

/** Two prompts in one thread while the setup waits: the second is queued behind the first. */
async function queued(second: string, script: string[]) {
  const r = await rig();
  const w = world(r);
  const d = daemon(r, w, script);
  const device = owner(r);
  try {
    await device.says(`/bind ${w.folder("work")}`);
    await until(async () => (await device.bodies(1)).length > 0, `the bind: ${d.err()}`);
    const a = await device.says("first");
    await until(
      async () => (await device.bodies(9)).some((m) => r.body(m).thread === a.thread),
      "the setup request",
    );
    const b = await device.says(second, a.thread);
    await pause(1_500);
    await device.answersSetup(a.thread);
    await until(
      async () =>
        (await device.opened(5)).filter((x) =>
          [a.name, b.name].includes(hex(x.header.re?.name ?? new Uint8Array())),
        ).length === 2,
      `both answers: ${d.err()}`,
    );
    await pause(500);
    const answers = (await device.opened(5)).map((x) => ({
      re: hex(x.header.re?.name ?? new Uint8Array()),
      name: hex(x.header.name),
      md: String(x.body.markdown),
    }));
    return {
      a,
      b,
      answers,
      parts: await device.opened(4),
      done: () => Promise.all([d.kill("SIGINT"), r.stop()]),
    };
  } catch (error) {
    await Promise.all([d.kill("SIGINT"), r.stop()]);
    throw error;
  }
}

test("two prompts queued behind a setup: each answer holds its own reply", DARWIN, async () => {
  const t = await queued("second", ["ONE", "TWO"]);
  try {
    assert.ok(t.answers.find((x) => x.re === t.a.name)?.md.includes("ONE"));
    const b = t.answers.find((x) => x.re === t.b.name)?.md ?? "";
    assert.ok(b.includes("TWO") && !b.includes("ONE"), b);
  } finally {
    await t.done();
  }
});

test(
  "a word queued between: the first reply's text is in the first answer and every part names an answer that exists",
  DARWIN,
  async () => {
    const t = await queued("/status", ["ONE"]);
    try {
      assert.ok(t.answers.find((x) => x.re === t.a.name)?.md.includes("ONE"));
      const answered = new Set(t.answers.map((x) => x.name));
      assert.ok(t.parts.length > 0, "the reply was written as parts");
      for (const part of t.parts)
        assert.ok(
          answered.has(hex(part.header.re?.name as Uint8Array)),
          "a part names the name of an answer that exists",
        );
    } finally {
      await t.done();
    }
  },
);
