/**
 * A background subagent's message while it runs (#135, recordings `subagent-message-bypass` and
 * `subagent-message-auto`, SDK 0.3.316): a line in the reply the message's turn opens, with no
 * post of its own and no mention that notifies. The subagent's hand-back draws none.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Item, memoryHarnessFor, sdkMessages, splitTurns } from "../../../support/sessions.ts";
import { replyCount } from "./helpers.ts";

/** The recording's turns with the mid-run message's body made `body`. */
function turns(name: string, body: string): Item[][] {
  return splitTurns(sdkMessages(name)).map((turn) =>
    turn.map((item): Item => {
      if (!("record" in item)) return item;
      const origin = item.record.origin;
      if (typeof origin !== "object" || origin === null || Array.isArray(origin)) return item;
      if (origin.body !== "halfway there") return item;
      return { record: { ...item.record, origin: { ...origin, body } } };
    }),
  );
}

type Made = ReturnType<ReturnType<typeof memoryHarnessFor>>;

function written(h: Made): string {
  return h.replies().join("\n");
}

/** How many notices of their own the daemon has written. */
function notices(h: Made): number {
  return h.room.written(h.channel).filter((message) => message.kind === "notice").length;
}

for (const mode of ["bypass", "auto"]) {
  test(`${mode}: the message is a line of the reply it opens, without a post of its own`, async (t) => {
    const [first, message] = turns(`subagent-message-${mode}`, "halfway there") as [Item[], Item[]];
    const h = memoryHarnessFor(t)({ turns: [first] });
    const session = h.session();
    await (await session.submit("go")).done.wait();
    const posted = notices(h);
    h.clients[0]?.inject(message);
    // The turn answers under the task, in the reply that started it: no stream of its own.
    await h.until(() => written(h).includes("Message from"));
    assert.ok(written(h).includes("Message from general-purpose:\n> halfway there"), written(h));
    assert.equal(notices(h), posted);
    assert.equal(replyCount(h), 1);
  });
}
