# The relay chat provider

How the relay chat draws the chat seam, for someone changing the code. It is the daemon's chat
and it is in development: it is registered as `relay` (variables in [setup.md](setup.md)), and no
app reads its messages yet. What differs from the terminal is in the
section "Limits of the relay chat" of [limits.md](limits.md). The core, the seams and the registry
are in [architecture.md](architecture.md).

## What a start builds

`relayChat().build` checks the `.env` against the pairing (`RELAY_OWNER` and `RELAY_KEY` must be the
ones the bot was paired with), opens the store, and builds one `Run` that the reading of the owner's
messages (`BotReader`, in `inbound.ts`) and the outbox (`outbox.ts`) share, so that a start read back
is of this run. The connection dials when the daemon starts the provider and ends in `stop`, before the
sessions close; `close` erases the keys held in memory.

## A reply

`openReply(onOpenMessage, prompt)` takes the owner's message the reply is for; the core passes it for
every turn of an owner's prompt, `!!command` included, and nothing for a report turn. The reply
writes text only. While that prompt has no answer, each `text` call becomes parts (kind 4), each at
most 64 KiB of UTF-8 and cut between characters, each naming by `re` the answer the prompt will get;
the text is added to that answer. Text written after the prompt's answer, or by a reply with no
prompt, goes out as texts of the thread (kind 1, "say"), also split at 64 KiB. `task`, `finish`,
`rest` and `showFooter` draw nothing (`showFooter` answers false, so the footer stays owed).

`closeOut` answers at once: true when every part is already read back, false while one is not, and
the core then waits in the background with `waitLanded`, as the seam splits them. `waitLanded` resolves true once every part is read back, false when a part was refused or dropped
(it never landed), when their `AbortSignal` aborts, and once the provider is stopped. A wait made
after the stop ends false at once, and `settle` is a last look that answers at once whether the reply has landed, so closing the sessions never waits for a read-back that cannot come.

## One answer per prompt

Every prompt the bot started must get exactly one answer (kind 5, `re` the prompt, the whole text of
its replies or empty). With none, a restart shows the prompt cut although it ran; one written early
shows it answered although a crash cut it. `ChatInbound.message` is no signal: measured on 2026-11-17
with the memory chat and the plain agent, it resolves when the prompt reaches the agent, with the turn
still held, and at once for a prompt sent during a turn and for a `!word`. The seam therefore has
`InboundMessage.handled?()`, which the core calls once when it no longer works on the message: when the
turn that took it ends (`Turn.done`), or, for a word, a drop or a refusal, when its flow ends. The core calls it after `replyOnFailure`, so a failure's text is in the thread before the prompt closes.
The memory chat does not set it. The relay's inbound sets it and writes the answer and the decision in one store write. A prompt whose work in the core ends after the provider was stopped is not answered, so the next
start reads it as cut.

## A start that cannot dial

A put-back or a fault the store holds is final: the bot would never dial. The start refuses with
`the relay must be recreated: it was put back from an older copy or is at fault, and the bot dials it
no more; once it is, move the instance's .env away, then run setup again`. A `RELAY_ADDRESS` that
is not `host:port` stops the start too, with the setup's own wording.
