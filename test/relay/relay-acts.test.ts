/**
 * The acts on the relay's process (design 5.2): each script in `scripts/relay/` plays them against a
 * child relay of its own and reads what the relay serves afterwards.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RelayProcess } from "../support/scripted-device/relay-process.ts";
import { Defect, Failure, parse, run } from "../support/scripted-device/script.ts";
import { DARWIN } from "./process-support.ts";

const SCRIPTS = new URL("../support/scripted-device/scripts/relay/", import.meta.url);

for (const name of readdirSync(SCRIPTS).filter((n) => n.endsWith(".jsonl"))) {
  test(`relay script ${name}`, DARWIN, async () => {
    const relay = new RelayProcess();
    try {
      await run(
        parse(readFileSync(new URL(name, SCRIPTS), "utf8")),
        await relay.open(),
        undefined,
        relay,
      );
    } finally {
      await relay.close();
    }
  });
}

test(
  "a put-back under the running relay keeps the journal's inode, and a put-back stopped does not",
  DARWIN,
  async () => {
    const kept: boolean[] = [];
    for (const act of ["put-back-under", "put-back"]) {
      const relay = new RelayProcess();
      try {
        const target = await relay.open();
        const journal = join(relay.dir, "journal");
        const before = statSync(journal).ino;
        const script = [
          '{"op":"prove","device":"app1","enrol":"sheet1","expect":"served"}',
          '{"op":"relay","act":"copy","as":"k1"}',
          '{"op":"submit","entry":"add","device":"app2","expect":"result 0"}',
          '{"op":"put-blob","as":"b1","expect":"result 0"}',
          `{"op":"relay","act":"${act}","copy":"k1"}`,
        ];
        await run(parse(script.join("\n")), target, undefined, relay);
        kept.push(statSync(journal).ino === before);
        assert.deepEqual(
          readdirSync(join(relay.dir, "blobs")),
          [],
          `${act}: the copy held no blob`,
        );
      } finally {
        await relay.close();
      }
    }
    assert.deepEqual(kept, [true, false]);
  },
);

test("an act with no relay process is a defect of the script", async () => {
  await assert.rejects(
    run(parse('{"op":"relay","act":"kill"}'), { port: 1, relay: new Uint8Array() }),
    /line 1: no relay process to act on/,
  );
});

const ENROL = '{"op":"prove","device":"app1","enrol":"sheet1","as":"g","expect":"served"}';
const act = (name: string, more = "") => `{"op":"relay","act":"${name}"${more}}`;

/** Plays `lines` against a relay of its own; `after` runs on the relay once the script has ended, whatever the outcome. */
async function play(lines: string[], after?: (r: RelayProcess) => Promise<void>) {
  const relay = new RelayProcess();
  try {
    await run(parse([ENROL, ...lines].join("\n")), await relay.open(), undefined, relay);
  } finally {
    await after?.(relay);
    await relay.close();
  }
}

test(
  "a put-back under the running relay over an equal journal never trips rule 11, while a blobs/ round completes",
  DARWIN,
  () => {
    const lines = [act("copy", ',"as":"k1"')];
    for (let i = 0; i < 40; i++) {
      lines.push(
        `{"op":"put-blob","as":"b${i}","expect":"result 0"}`,
        act("put-back-under", ',"copy":"k1"'),
      );
      lines.push('{"op":"read","from":0,"expect":{"items":["g"],"n":1}}');
    }
    return play(lines);
  },
);

test(
  "a name for an incarnation is bound to one value: two names for one relay's incarnation fail",
  DARWIN,
  async () => {
    const read = (inc: string) =>
      `{"op":"read","from":0,"expect":{"items":["g"],"n":1,"inc":"${inc}"}}`;
    await assert.rejects(play([read("I1"), read("I2")]), (e) => e instanceof Failure);
  },
);

test(
  "a copy name is used once, and an unknown or unknown act is a defect before anything runs",
  DARWIN,
  async () => {
    const defect = (re: RegExp) => (e: unknown) => e instanceof Defect && re.test(e.message);
    const copy = act("copy", ',"as":"k1"');
    await assert.rejects(play([copy, copy]), defect(/^line 3: .*k1/));
    await assert.rejects(
      play([act("put-back", ',"copy":"nope"')], async (r) => {
        const journal = join(r.dir, "journal");
        assert.ok(statSync(journal).size > 0, "the relay's directory is untouched");
      }),
      defect(/^line 2: .*nope/),
    );
    await assert.rejects(play([act("explode")]), defect(/^line 2: .*explode/));
  },
);

test(
  "acts that end the process refuse while a failing fsync is armed, and serve refuses over a live child",
  DARWIN,
  async () => {
    const defect = (re: RegExp) => (e: unknown) => e instanceof Defect && re.test(e.message);
    await assert.rejects(play([act("disk-fails"), act("kill")]), defect(/armed/));
    await assert.rejects(
      play([act("disk-fails"), act("copy", ',"as":"k1"')]),
      defect(/^line 3: .*armed/),
    );
    await assert.rejects(play([act("serve")]), defect(/live/));
  },
);

test("nothing serving means port 1, and a serve that waits for init fails when its child exits", {
  timeout: 20_000,
}, async () => {
  const relay = new RelayProcess();
  try {
    await relay.open();
    assert.equal((await relay.act("kill", { op: "relay", line: 1 })).target.port, 1);
    rmSync(relay.dir, { recursive: true });
    const serving = relay.serve();
    (relay as unknown as { serving: { child: { kill(s: string): void } } }).serving.child.kill(
      "SIGKILL",
    );
    await assert.rejects(serving, /exited/);
  } finally {
    await relay.close();
  }
});

test("a put-back after a recreate restores the copy's key, which the next proof pins", DARWIN, () =>
  play([
    act("copy", ',"as":"k1"'),
    act("recreate"),
    ENROL,
    act("put-back", ',"copy":"k1"'),
    '{"op":"prove","device":"app1","expect":"served"}',
  ]),
);

test(
  "observe lists the blobs the directory holds, and a `tmp-` file is not one",
  DARWIN,
  async () => {
    await play(
      [
        '{"op":"put-blob","as":"b1","expect":"result 0"}',
        act("copy", ',"as":"k1"'),
        '{"op":"put-blob","as":"b2","expect":"result 0"}',
      ],
      async (r) => {
        assert.deepEqual(
          r.observe().blobs.map((n) => n.length),
          [64, 64],
        );
        writeFileSync(join(r.dir, "blobs", "tmp-0a"), "x");
        writeFileSync(join(r.dir, "blobs", "stray"), "x");
        assert.equal(r.observe().blobs.length, 2, "a tmp- file and a stray name are not held");
        await r.act("put-back", { op: "relay", line: 1, copy: "k1" });
        assert.equal(r.observe().blobs.length, 1, "the copy held one blob");
        rmSync(join(r.dir, "blobs"), { recursive: true });
        assert.deepEqual(r.observe(), { blobs: [] }, "no directory is no blob");
      },
    );
  },
);

test(
  "a put-back under the running relay after a recreate restores the copy's key for the restart",
  DARWIN,
  () =>
    play([
      '{"op":"submit","entry":"add","device":"app2","as":"a2","expect":"result 0"}',
      act("copy", ',"as":"k1"'),
      act("recreate"),
      ENROL,
      act("put-back-under", ',"copy":"k1"'),
      act("probe"),
      '{"op":"prove","device":"app1","expect":"served"}',
      '{"op":"read","from":0,"expect":{"items":["g","a2"],"n":2}}',
    ]),
);
