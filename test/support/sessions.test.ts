/**
 * The scripted agent is useful only if it carries the recorded shapes: pin what the session
 * tests rely on, read at the agent seam, on the events the fake gives.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PermissionRequest,
  QuestionRequest,
  RequestHandler,
  SessionEvent,
  StartOptions,
} from "../../src/agent/seam.ts";
import { type JsonObject, sdkJson } from "./fixtures.ts";
import {
  canUseToolCall,
  END_OF_STREAM,
  FakeAgentBackend,
  type FakeAgentSession,
  hookRun,
  type Item,
  recordOf,
  type Script,
  sdkMessages,
  splitTurns,
} from "./sessions.ts";

const OPTIONS: StartOptions = {
  folder: "/project",
  resume: null,
  model: null,
  effort: null,
};

interface Asked {
  readonly requests: Array<PermissionRequest | QuestionRequest>;
  readonly handler: RequestHandler;
}

function asked(): Asked {
  const requests: Array<PermissionRequest | QuestionRequest> = [];
  return {
    requests,
    handler: {
      permission: async (request) => {
        requests.push(request);
        return { allow: true };
      },
      question: async (request) => {
        requests.push(request);
        return { answered: false, message: "skipped" };
      },
    },
  };
}

async function started(script: Script, handler = asked().handler): Promise<FakeAgentSession> {
  const backend = new FakeAgentBackend([script]);
  await backend.start(OPTIONS, handler);
  return backend.sessions[0] as FakeAgentSession;
}

const readers = new WeakMap<FakeAgentSession, AsyncIterator<SessionEvent>>();

/**
 * The next events of a session, until `turns` turns have ended or the stream ends. One reader
 * per session, as the core has: a second call goes on where the first stopped.
 */
async function read(session: FakeAgentSession, turns: number): Promise<SessionEvent[]> {
  const reader = readers.get(session) ?? session.events[Symbol.asyncIterator]();
  readers.set(session, reader);
  const events: SessionEvent[] = [];
  for (let ended = 0; ended < turns; ) {
    const next = await reader.next();
    if (next.done) break;
    events.push(next.value);
    if (next.value.type === "turn_ended") ended += 1;
    if (next.value.type === "process_lost") break;
  }
  return events;
}

// What the session tests rely on beyond the recordings: the scripted steps that are no record.

test("a prompt of plain text is replayed before its turns first words and a command is not", async () => {
  const [turn] = splitTurns(sdkMessages("tools")) as [Item[]];
  const session = await started({ turns: [turn, turn] });
  await session.send({ id: "p1", content: "list the files" });
  const first = await read(session, 1);
  const taken = first.findIndex((event) => event.type === "prompt_taken");
  assert.deepEqual(first[taken], { type: "prompt_taken", promptId: "p1" });
  const init = first.findIndex((event) => event.type === "session_started");
  assert.ok(init !== -1 && init < taken); // after the turn's `init`
  assert.equal(first[taken + 1]?.type, "message_started"); // before its first words
  await session.send({ id: "p2", content: "/usage" });
  const second = await read(session, 1);
  assert.equal(second.at(-1)?.type, "turn_ended");
  assert.ok(!second.some((event) => event.type === "prompt_taken"));
  assert.deepEqual(session.queries, ["list the files", "/usage"]);
});

// The scripted Claude stand-in names a call in a request as the Claude back end does (seam
// contract of `RequestHandler`): only a call a record named, whose start is on the events.

test("a request for a call no record named is a request for no call", async () => {
  const seen = asked();
  const session = await started({}, seen.handler);
  session.inject([canUseToolCall("Bash", { command: "ls" }), END_OF_STREAM]);
  await read(session, Number.POSITIVE_INFINITY);
  assert.deepEqual(
    seen.requests.map((request) => [request.type, request.callId]),
    [["permission", null]],
  );
});

test("a request for a call a record named carries its id, after the call's start", async () => {
  const [turn] = splitTurns(sdkMessages("tools")) as [Item[]];
  const first = turn.findIndex((item) => {
    const content = (recordOf(item)?.message as JsonObject | undefined)?.content;
    return (
      Array.isArray(content) && content.some((block) => (block as JsonObject).type === "tool_use")
    );
  });
  const message = recordOf(turn[first])?.message as JsonObject;
  const callId = (
    (message.content as JsonObject[]).find((block) => block.type === "tool_use") as JsonObject
  ).id as string;
  const seen = asked();
  const session = await started({}, seen.handler);
  session.inject([
    ...turn.slice(0, first + 1),
    canUseToolCall("Bash", { command: "ls" }, callId),
    END_OF_STREAM,
  ]);
  const events = await read(session, Number.POSITIVE_INFINITY);
  assert.deepEqual(
    seen.requests.map((request) => request.callId),
    [callId],
  );
  assert.ok(events.some((event) => event.type === "call_started" && event.callId === callId));
});

test("a request waits for the cores answer before the stream goes on", async () => {
  const seen = asked();
  const session = await started({}, seen.handler);
  const questions = (sdkJson("ask-can-use-tool") as JsonObject).input as JsonObject;
  session.inject([
    canUseToolCall("Bash", { command: "ls" }),
    canUseToolCall("AskUserQuestion", questions, "toolu_fake_2"),
    hookRun(sdkJson("stop-hook") as JsonObject),
    END_OF_STREAM,
  ]);
  const events = await read(session, Number.POSITIVE_INFINITY);
  assert.deepEqual(
    seen.requests.map((request) => [request.type, request.callId, request.toolName]),
    [
      // No record named either call, so neither request names one.
      ["permission", null, "Bash"],
      ["question", null, "AskUserQuestion"],
    ],
  );
  assert.deepEqual(session.permissionResults, [
    { allow: true },
    { answered: false, message: "skipped" },
  ]);
  // The Stop hook's input, as the back end reads it, then the end of the stream.
  assert.deepEqual(events, [
    { type: "effort_observed", level: "medium" },
    { type: "scheduled_jobs", jobs: [] },
    { type: "folder_changed", folder: "/home/dev/project" },
    { type: "process_lost", reason: "the Claude Code process exited" },
  ]);
});
