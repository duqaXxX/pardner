# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- Background work after the turn, the bot's half (issue #73, step C2). The relay chat writes a line's text and edits for as long as its reply lives: `task` and `finish` no longer stop at the prompt's answer or at `finish`, so a task that ends after the turn closes its line, and a reply with no prompt writes lines with no `re`. The name of every line the process writes is kept (`Inbound.mine`) from before its text is queued. An agent that ends outside the turn gets its card where it ended and no end text, as it does inside the turn. At each rest of the reading the bot closes the lines a dead process left open (its own kind 1 texts with `say` `task` and kind 11 edits with a `task`, read back, minus the names in `mine`): an edit with `status` `error`, `output` `Stopped: the bot restarted` and `details` null, queued once; nothing is stored. The first start of a bot with this change closes every line the journal still holds open. No protocol change. `docs/limits.md`, `docs/features.md` and `docs/relay-provider.md` describe it.
- The relay chat writes a reply's text as it is written (issue #73, step B1). The chat declares `nativeStreaming`, so the core hands the reply each text delta, and the reply holds them and writes what it holds as one part (kind 4) or, outside a prompt's answer, one text (kind 1): 5 seconds after the first held character while the prompt has no answer and the turn has not finished, 1 second after the last held text, and at once before a call's line, `finish`, `closeOut`, `settle`, `waitLanded` and any text that is not a plain piece (a notice, an ending, a text with answers). The joined parts still equal the answer. Every write of a reply goes through one chain, so a flush the timer asks for lands after the call in progress, and a request's card or a notice written into the thread waits for the open reply's held text. The provider and the `Connection` share one `Clock`. The reply takes the connection's `Clock` (`wait` with a signal) for its timer; no protocol change and no app change. A turn with no text starts no timer; the daemon's exit can wait up to 5 seconds for one. `docs/limits.md` and `docs/relay-provider.md` describe the pace.
- The bot writes a turn's tool calls as lines in the thread (issue #73, step A, the bot's half). For a reply opened for a prompt, while the prompt has no answer, the relay chat writes each call's line as a kind 1 text (`re` the prompt, content `{"thread", "say": "task", "task": <line>}`) when the core first hands it over, and a kind 11 edit (`re` the line's text, content `{"thread", "task": <line>}`) when its status, output or preview differs from what was last written; at the turn's end an edit for each line it closes that differs in any field, so a call the owner's `/stop` cut ends as an error reading `Stopped` (in the stream, at the close and for a task the core ended, never the agent's own rejection text; a move to the terminal and a task the agent stopped itself read `Stopped` as complete) and a task that runs on `Running in background`. `<line>` is the core's `TaskUpdate` without `id`, `name`, `folded`, with `startedAt` in wall-clock milliseconds. Nothing is written for a report turn, after the answer or after the turn's end. A content past the room of a message has its longest field cut at a line end with `… +N lines` (the preview's body, then the details, then the output), a single over-long line between characters with `…`; a line is not part of what a reply waits to land. The bot's reading of its own edits keeps no key for an edit of a line. `docs/limits.md` replaces the row that said the relay chat writes no tool lines.
- A call that waits for the owner's approval reads as waiting in the thread (issue #73, step A2). Its line is written `pending` with no `startedAt`, before the request's card, so the card stands below it; when the owner allows the call its line turns `in_progress` before the agent has the decision, with `startedAt` set then for a call the terminal times (any other call keeps it null), and a call the owner denies ends as an error that never had a timer. A request that names no call, a call the renderer holds (a question, a call that starts an agent, a call shown by its preview such as an Edit or a Write) and a call inside a subagent mark no line. The agent seam says a request names a call only once that call's start is on the events, and the Claude back end passes `callId` null for a call no record named. A call that asks costs up to two more messages (`pending`, then `in_progress`). `docs/limits.md` drops the row that said such a call reads `Running`.
- The app reads and draws a turn's lines in the thread (issue #73, step A, the app's half). A kind 1 text whose content has `say` `task` is a line of the turn and a kind 11 edit whose content has `task` is the line `re` names, each with the content's `task` as the core's `TaskUpdate` without `id`, `name` and `folded` and with `startedAt` in milliseconds; only the session's bot writes them, and an edit of a line the app does not hold changes nothing. A line is open while its status is `pending` or `in_progress` and the prompt it names runs (`Running`, with the time since `startedAt` when it is timed); once that prompt is cut or not read it reads `Interrupted`, and once it is answered it reads as written. A line is drawn by its fields: a preview with a body (the body in the monospace font, a diff's added and removed lines tinted by their first character, in rows of at most 200 lines), a record (the words in one block), or one line of title and details (an error with its output, a message with its output opened on a click). Text, a line and more text keep the order the bot wrote them in; the answer replaces the pieces of text when they do not add up to it. The thread panel is a lazy stack. A message that does not open and whose `re` names a message of a thread belongs to that thread, and consecutive ones are one row, `N messages cannot be read on this device.` Nothing the owner sees changes until the bot writes lines.
- The thread panel shows the session's activity above its composer while the session runs or waits (issue #73, step A): the bot's avatar and name, `Working…` while it runs or `Waiting for you` while it waits (the word pulses, 2.4 s a round), and Stop. Stop is a red square in the thread header, in the Sessions tab's rows (blinking) and in this row, a few points after the words; it sends `/stop` as the text button did and shows only where the panel has a composer. With Reduce Motion on, nothing pulses or blinks.
- The app does not draw the prompts its own controls send. Stop (`/stop`) and the session menu (`/bypass on|off`, `/plan on|off`) send their word as a prompt whose encrypted content has `"control": true`, a field the bot does not read. A reader honours the flag only as a JSON boolean, beside one of those five words, from one of the person's own devices or one the thread's bot started; any other prompt with the flag is drawn as usual. Every device hides the prompt and its pending row while it is on its way, and shows a failure like any prompt's. The bot's start, parts, text and answer to `/stop` are hidden too (`Stopped.`); the answer to a mode word is drawn with no prompt above it. A request or a line the bot writes naming a control prompt is drawn as usual. A `/word` typed in the composer carries no flag and stays visible. The shape is the vector `test/protocol/content-vectors/control-content.json`.
- The app's composer, in a channel and in a thread, has the reference composer's row (#112): attach, formatting, emoji, mention, video, audio and Commands, then the hint and Send. The emoji button opens the system's emoji palette on the field and the mention button the bot list (a channel's composer only); formatting shows its row of tools. The tools that need what the app does not have yet are drawn off, with the reason as their help: attachments (#41), audio (#42), video, the formatting tools and the list of commands. The empty field names the channel, or the bot a thread's reply goes to.
- The app shows code spans (text between backticks) of a bot's text and answers in a monospace font; people's messages stay as written (the rest of a bot's Markdown is read in the next entry). A message the device cannot read carries a lock, and in the thread panel a bot's name carries `Bot` and the time, with the count of replies under the opening message.
- The app reads a bot's text as Markdown, an answer still being written included (issue #73, step B2): headings, emphasis, lists, quotes, code blocks, tables, rules and code spans, drawn as flat rows; a link is blue, shows the pointing hand and opens only after an `Open this link?` alert with its address and host, for `http` and `https` with a domain name; invisible code points in code and in a preview's body show as `[U+XXXX]`. A text over 16,000 characters, a table over 20 columns or over 1,000 drawn blocks (a table counts its cells) is drawn as written but for its code spans. A segment of an answer is formatted at each part that reaches it, so a structure half written is drawn half written until the next part.
- The app's channel panel (issue #69). `Channel Settings…`, in a channel's header menu and its sidebar row's menu, opens a window with the channel's bot, folder and the folder's state (`Usable`, `Not trusted in Claude Code: …`, `The folder is missing`, `The folder cannot be read`), read from the `bind` field of the bot's latest `/bind` answer, with the answer's text under it and `Change Folder…`; with no field yet it says `Not known yet.` A `/bind` prompt whose answer from its bot carries the field is no longer drawn in the conversation, nor is the answer; a prompt with no such answer is drawn as before.
- The bot's reply to `/bind <folder>`, and to a pick from the list of folders, carries the channel's folder. `ChannelChat.notice` takes a third argument, `bind: { folder, state }`, with `state` one of `usable`, `untrusted`, `missing` and `unreadable`; the relay chat writes it as `bind` in the content of the first piece of the kind 1 text, beside `say` and `markdown`, and the memory chat records it (`calls("bind")`). `folder` is the folder the channel has stored when the reply is queued, read after the bind's own checks with nothing awaited before the reply, so of two binds in flight the last reply names the stored folder; `state` is the bind's own check when the stored folder is the bind's, else a fresh check. The text is unchanged, a refusal in a channel with no stored folder and a bare `/bind` carry no field, and a reader that does not know the field draws the text. The content is pinned by `test/protocol/content-vectors/bind-content.json`. Part of #69.
- The app's main window has no title bar: the sidebar runs the window's full height with the traffic lights over its top, and its own `Pardner` header is the name on screen (`windowStyle(.hiddenTitleBar)`). The conversation's and the thread panel's headers start at the window's top edge too, and their empty part moves the window. Esc closes the open thread panel unless something nearer takes it: a focused request card's second button, the Other field (Esc leaves the field) and the composer's `@` list take it first; the card runs before the key travels up the window's responders and the panel's handler (`onExitCommand`) after them.
- Sidebar sections, the arrangement message (protocol part, first unit). Kind 17, the arrangement, joins the table: sent by an app into the person's space with no `to` and no `re` (the relay refuses it in a conversation channel and from a bot). `readArrangement` and `encodeArrangement` read and write its content: a `base` (the sender and message name of the arrangement it was built over, or `null`) and up to 64 sections, each with a 32-hex id, a name under a device name's rule and up to 1,024 channel ids in the whole content, each id once. A field a reader does not know is carried (up to 8,192 bytes as written, a field named `__proto__` included), nesting past 32 levels and a content over 131,072 bytes do not read, and no input makes `readArrangement` throw. `send` refuses a draft of kind 17: its one writer comes in a later unit. A kind that was outside the table (17) moves to 18 in the vectors. Nothing the owner sees changes yet.
- Sidebar sections, writing the arrangement (protocol part, second unit, first half). `AppLink.arrange(act)` takes one of five acts (`section-new`, `section-rename`, `section-move`, `section-remove`, `channel-move`), builds the whole tree from the one the device shows, drops the channel ids the sequence does not hold, and keeps it as one pending kind 17 entry under a fresh message name, in the outbox file as a name is kept; it answers `not-ready`, `bad-input`, `too-many` (the result passes 64 sections or 1,024 channels) or `queued`. The acts are vectors, `arrangement-act`, on Node and in JavaScriptCore. It answers `not-ready` until the reading has reached rest on the connection (a pushed message keeps that; a drop, a rewind, a connection the link ends itself and a refusal of the reading clear it) and while a first copy of a kind 17 waits for its key. An entry not yet signed is replaced by the next act, which takes the earliest one's base; a signed one stays, goes out first, and the next is built over it. A kind 17 the relay refuses stays pending under a mark of its own for the connection and holds back no name. The items go out in the order the entries were made. The effect and the "not applied" line come in the next unit. Nothing the owner sees changes yet.
- Sidebar sections, the arrangement told (protocol part, second unit, second half). `AppLink` tells an `arrangement` effect, `{ sections, current, behind, notApplied }`, when any of them differs from the last told: the tree shown (this device's pending tree first, else the standing one, `null` when none), whether an act may be made, whether a first copy of a kind 17 waits for its key, and the "not applied" line. At rest, the line rises when an own tree that took no part at its turn was read back in this run (not while it or a first copy placed before it waits for its key), and when a pending entry built over an own tree that took no part is dropped, whatever run that tree was read back in (not while any first copy of a kind 17 waits for its key), with its item when the item is not built; the next act clears it. After a new relay incarnation the tree told stands until the new pass reaches rest, where it is checked again. Nothing the owner sees changes yet.
- Sidebar sections, the app's model (no screens yet). The `arrangement` effect reaches the app as a reading event and `ReadingModel` holds the tree it shows, with `current`, `behind` and `notApplied`; `PairingController.arrange` and `RelayConnection.arrange` make one of the five acts and answer `queued`, `refused` (`not-ready`, `bad-input`, `too-many`), not saved or ended. `SectionsModel` draws each section with only the channels this device holds, then the "Channels" group, turns Move Up and Move Down into the act's `before` and refuses every act while the device is not current. The folded sections are kept in this Mac's defaults and never sent. A channel made from a section is moved there once it shows and the device is current, and stays under "Channels" if the app quits first or the section is gone. Nothing the owner sees changes yet.
- The app's sidebar sections (issue #87, the screens). The sidebar draws each section of the shown arrangement with its held channels, an empty one with `No channels`, then `Channels` with the rest; with no arrangement it is the list as before. A section's header folds and unfolds on a click and shows the count of its sessions waiting for you while folded; its context menu and the `…` button under the pointer offer `New Channel…` (the new channel form, the channel moved into the section once it shows), `Rename…`, `Move Up` and `Move Down` (only where possible) and `Remove Section`. The `Channels` header's menu offers `New Section…`. A channel's menu gains `Move to Section` (each section, `Channels`, `New Section…`) and, inside a section, `Move Up` and `Move Down`. `New Section…` and `Rename…` open a name field in the sidebar: Return sends, Esc sends nothing, a refused name shows the rule's sentence. While the device has not read everything every section command is off and a line under the header says `Reading your sections…` or, when a copy of a kind 17 waits for its key, `Your sections from your other devices are still being read.`; `A change to your sections was not applied: another device changed them first.` shows when the device's change took no part. A channel can be dragged onto a section's header (last in it), between two rows of a section (there, by the half of the row the pointer is in, with an insertion line) or onto `Channels` (out of its section), and a section's header onto another header or onto `Channels` (reorders); a drop where the item already is, or while the device is not current, makes nothing. The drag is of a type private to the app (`io.github.duqaxxx.pardner.sidebar-item`, declared in `app/Shell/Info.plist`) and stays in the window.
- The app's Settings panel. A window of its own with a row of pane buttons at the top: General holds Appearance, Light or Dark, the setting the View menu's picker writes too (`Theme` moves into the screens module); Devices is the Devices screen as a pane, where `Back` on the add and remove pages stays in the pane and a half-filled form stays while another pane shows; Bots lists each active bot with its mark, name and account, or its label and `Not seen yet` until a channel carries its profile (`Reading your devices…` until the device list is read, `No bots yet. Add one in Devices.` after). Settings… in the app menu (Command-Comma), the gear at the foot of the sidebar and Devices… (Shift-Command-D, which opens the panel on Devices) open it; all three, and Command-N, are off until this Mac is paired. This Mac's Rename… opens the name form beside the open window. The panel and Devices are reset when the pairing ends. The Bots list leaves the sidebar; the pane and the empty window's hint read the bots through one function (`MainWindow.listedBots`, formerly `sidebarBots`).
- Recovery, dates in the list of history that stays unreadable. The step `I no longer have this key` names each conversation that stays unreadable with the days of its first and last message, as `#a1b2c3d4, from 16 Nov 2026 to 21 Nov 2026` (the system's abbreviated date), `on <date>` when both are one day, `dates unknown` when no time of its messages is plausible and `no messages` when it holds none. Consecutive unreadable epochs of a conversation make one range; an epoch between them that is not unreadable for the same key splits it. The person's space and its spares are left out of the list. The dates are the senders' signed message times, held unopened in memory (`AppLink.epochs` adds `unopened` to an epoch not open); a time more than a day ahead of the clock or before 2026-11-14 is left out. They never decide when the recovery is done. No wire, relay, store or bot change.
- The personal space, in the app's link. An app that reads to rest and finds no space of its person makes it, as a channel is made but with the space's own nonce and no prompt, and the keeper opens its first epoch; a second device that placed it first is not an error. A fault an older app stored on the space, or on a spare, is dropped at the first rest (`channel-fault-dropped`, which the app takes to withdraw its note), and a spare's stored items are dropped as not delivered: `send` refuses a spare and nothing is built or sent into one. The owner sees no difference: the space has no sidebar entry and no composer.
- Names of channels, persons and devices, protocol part. Three message kinds join the table: 14, the name of a channel, sent by an app into a conversation
  channel; 15, the name of a person, and 16, the name of a device, sent by an app into the person's space (the relay refuses each outside its class, and a
  bot's). `readName` and `encodeName` read and write their content, `{ "name": ... }`: a channel name is `a-z 0-9 - _`, 1 to 80 characters; a person or a
  device name is 1 to 64 code points under the one name rule, with no space at either end, and a person's name has no `@`. `Names` gives the name a device
  shows: the latest place of the first copy of a name wins, the first copy is placed from its signed header even when the body cannot be opened, a body with
  files or that does not read is no name, and kinds 15 and 16 count in the person's space alone. `AppLink` tells a changed name as a `names` effect. A kind
  that was outside the table (14) moves to 17 in the vectors. Nothing the owner sees changes yet.
- Names in the app, the pending names (step N2, first unit). The app keeps the names the person sets, a channel's, the person's and its own device's, in its outbox file until it reads back a message of its own under the message name chosen when the name was set (never by the name's value). `AppLink.setName` sets one; at rest the link writes each into its channel, or into the person's space once its first epoch is open, once per connection. A relay that refuses a name (an older one) holds every name for that connection and the next connection or relay start sends them again; a setup name is dropped once the sequence holds another kind 15 of the person; an app with no kind 16 of its own takes the name its pairing string gave it, else the Mac's. Nothing the owner sees changes yet.
- Names in the app, setup and channel names (step N2, third unit). The first device's form asks for the person's name, filled with the Mac user's full name; it is kept in the pairing file (version 3) through setup and written as the person's name once the space is open, unless the person was named elsewhere first. A new channel's form asks for a name, which follows the folder's last component until one is typed. A channel's name is typed under Slack's rule, strictly ASCII: uppercase becomes lowercase, spaces become one `-`, an accented letter its base letter, any other character is left out with a line saying what is allowed, and a paste is cut at 80; the rename form follows the same rule. The forms warn when another of the person's channels has the name. `AppLink.createChannel` takes the name and keeps it in the one write that holds entry 0 and the bind. Closes the names work of the app (#71).
- Names in the app, the screens (step N2, second unit). The names the link shows replace the short ids: a channel's name in the sidebar and its header (`#docs`), the person's name at the foot of the sidebar and on the person's own messages, a device's name in the Devices list in place of the pairing string's label. A name that does not show leaves what showed before. The person renames the channel from its menu (Rename…), themselves from the foot of the sidebar and this Mac from its row in Devices; the form says in plain words what a name may hold. A Mac that joined keeps the name typed at the join in its pairing file, so a restart before the device's name is written still sends it. `RelayConnection.setName` and `PairingController.setName` carry the three renames to the link. The name at the first device's setup and the channel-name field's typing rules come in the next unit.
- Names, review round 1: a name refused with result 1 by a relay older than kinds 13 to 16 drops its item and faults no channel; `send` queues a kind 14 to 16 only in its own class, with a content `readName` accepts and no file; a name whose message opens when its epoch key arrives later is told then; first copies are kept by kind, channel, sender and name; the app's relay connection ignores the `names` effect until the app shows names.
- Recovery with the recovery key, in the app. The first screen offers Recover with your recovery key (and the two dead ends, This Mac was removed and This Mac's keys are missing, offer it beside Pair again): paste what Copy gave for the recovery key's public part or type the person id, relay address and relay key, then type the recovery key into a field that refuses a wrong check symbol. The app reads the device log with the key and asks Could someone else have one of your devices? (No keeps every active device, Yes this Mac alone) and Make a new recovery key?; the recovery is stored before it is sent and goes on after a restart (the key is typed again). The past is opened with the key typed and any earlier recovery key, and the recovery is done only when every epoch an earlier key opens is read and the relay shows a seal to the current key; a key that was lost can be given up with I no longer have this key, which leaves its conversations unreadable on this Mac. At the end the app names the recovery keys that can be destroyed. A relay address with an IPv6 host is written with brackets wherever it is copied.
- Recovery, the link's part. `Link` takes a `recover` option (and `AppLink.recover`, before `start`): without a reset it proves with the recovery key on a
  recovery connection, reads the whole device log, checks it from entry 0 and stops, and `AppLink` tells it as a `recovery-log` effect with the devices the
  log names; with one, every connection tries `prove-active` first, a refusal that is not a removal sends the reset on a recovery connection of its own (this
  device and the trusted devices still active in the log read, rebuilt without asking when the log moved), and the first `served` ends the recovery with a
  `recovered` effect. `AppLink.holdRecovery`, `epochs` and `currentRecovery` give the app what opening the past and "done" need, and `enterRecoveryKey` and
  `buildReset` are exported to the app. `AppLink.recoveries` and the `recovery-log` effect name every recovery key the person's log named, to tell them from other
  recipients of a seal. The link stops after an outcome retrying cannot change (a refusal 2 or 3, a fault), marks put-back on a refusal 6 and asks again only after
  `ask` on a refusal 5. Nothing the owner sees changes yet.
- Recovery, protocol part. `buildReset` builds and signs a reset with a recovery key the caller names, with the new recovery key's public keys optional. The
  reading takes a list of recovery identities (a recovery key's id and the name its receiving key is held under) and opens an epoch by a seal to this device or,
  failing that, a seal to any of them, in the epoch's entry or in a history seal; `Reading.hold` adds one after the read and `Reading.epochStates` says which
  epochs are open and who each is sealed to. Nothing the owner sees changes yet.
- The app has an icon: the Pardner mark on a rounded tile, from an asset catalog in the app target (`app/Shell/Assets.xcassets`). `icon-render` draws it again from the code.
- The app's main window has resizable columns. Drag the divider between the sidebar and the conversation (200 to 360 points) or between the conversation and the
  thread panel (from 320 points, until the conversation is at its least width of 420, never taking width from the sidebar); a double click on a divider restores its first-launch width (248 and 380). The widths are kept across launches, no column collapses, and
  the window's least width follows from the columns (942 points with a thread open, 621 without; the pairing screens' least width goes from 1050 to 680).
- The app answers the bot's requests and stops a session. A request in a thread is a card with the controls of its type: setup (a model picker, an effort
  picker and a bypass switch, preset from the request; Start), a tool's approval (the tool, its description and input as indented JSON, or the plan, cut at
  4,000 characters until Show all; Allow, Deny), questions (a choice or several, an Other field, Answer, Skip), a shell command (Run, Don't run), a
  same-folder hold (Send anyway, Don't send) and a terminal request (Go, Cancel). A reply is sent once per card and the card says `Sending…`, `Not sent.`
  with its reason or `Not delivered.`; the bot's reason for a reply it did not take shows in red with the controls back. With a card focused by a click or
  Tab, Return is its first button and Escape its second; a card never takes the focus on its own. A request the bot took reads `Answered`, whatever order
  the bot wrote its withdrawal and its verdict in. The thread's header has Stop (while the session runs or waits; the Sessions tab has it too) and a menu
  with Bypass on/off and Plan mode on/off, each sent as `/stop`, `/bypass on|off` or `/plan on|off` in the thread.
- The reading model keeps the bot's verdict on a reply of the owner's apart from the thread: a kind 5, 6 or 7 that names a reply (`re`), from the bot the reply went to,
  is that request's verdict and not a prompt's answer or state; an empty kind 5 makes the request `answered` unless the bot rewrote it.
- The app's composer. The channel's Conversation tab and each thread's panel have a field under them: Return sends, Shift-Return starts a new
  line, and a return that commits an input method's marked text sends nothing. Typing `@` first in the channel's field lists your active bots
  and the pick becomes a label, so the message is a prompt to that bot; with no label the message is a text for the people of the channel. In a
  session's thread of your own bot a message is a prompt to that bot (a removed bot disables the field); in any other thread it is a text. A text
  that starts with `/` or `!` needs a bot to read it and is not sent otherwise. A message shows in place as `Sending…`, `Not sent.` with its
  reason, or `Not delivered.`, until the reading holds it; drafts stay per channel and thread while the app runs. A prompt sent while an
  earlier prompt of its session runs says `Queued`. A message that was not sent comes back into an empty field, and a failed or refused row has a close control. A pasted or dropped file or image says `Files cannot be sent yet.`
- The `outbox` effect of `AppLink` carries each item's `content`, so a screen can draw a message that waits after a restart.
- The app's screen for a new channel. The sidebar's Channels header has a `+` (New channel), enabled once the log is read. Its form asks for a folder
  and, with two or more active bots, the bot; Create makes the channel through the link, which queues the `/bind` prompt. The channel shows
  in the sidebar as `Creating…` and then by its short id. A refused creation says `The relay refused the new channel (code N).` in the sidebar
  until the next creation; a write that failed keeps the form open with `Pardner could not save the new channel. Try again.`, and a
  creation already running says `Another channel is being created.` A channel's header menu has Bind to a folder…, which sends a new
  `/bind` prompt (disabled for a faulted channel); a faulted channel's header says `Pardner stopped sending in this channel: the relay answered what it should not.`
- The app's link makes a channel and sends messages, in the protocol only (no screen yet). `AppLink.createChannel({ bot, folder },
  now)` makes and signs entry 0 and queues a `/bind <folder>` prompt to the bot in the new channel's outbox; it answers
  `not-ready`, `busy` (one creation at a time) or `bad-input`. `AppLink.send(channel, draft, now)` queues a message of any
  kind an app may send (not files) and answers `bad-input`, `not-member`, `fault` or `not-ready`. Both keep their state in the
  app outbox: the pending entry 0 (submitted again as the same bytes until it is read back), each channel's items with their
  built bytes, and the channels stopped on a fault. It reaches the store as one `write` effect that never shares a list with
  `persist`, answered with the new call `written(ok)`; a failed write stops creating and sending and delivers `store-failed`.
  An item is built once in the open epoch whose key the app holds, its bytes are written before it is submitted, and it stays
  until its device reads it back by name. Results 3 and 4 build it again in the next epoch, 5 and 8 drop it, and a 1 the
  package's own checks do not explain is a channel fault, stored. A build that meets the counter limit makes the keeper start
  the next epoch once. New effects: `outbox` (a channel's items as `waiting`, `sent` or `refused`), `channel-refused`,
  `channel-fault`, and `creating` (the channel being created with its bot and folder, or `channel: null` once it is read back or
  refused; told at `start` for a stored one). `start` tells the stored outbox's channels as `outbox` effects and each stored fault as `channel-fault`. `AppLinkOptions.outbox` takes the stored app outbox at launch. `startOf` and `starts` take an optional
  rollover predicate.
- The app's side of a new channel, without a screen yet. `LinkStore` keeps the app outbox in `outbox.json` beside `link.json`
  (written whole under a temporary name, flushed and renamed, bytes in base64, erased with the link's files, read as empty when
  it does not read) and `RelayConnection` loads it at start, performs the link's `write` effect and answers `written`. The
  connection and `PairingController` gain `createChannel(bot:folder:)` and `send(channel:draft:)`, and the controller publishes
  `channels` (the channel being created, each channel's outbox with its item states, the last refused creation and the faulted
  channels) on `channelStates`. A failed write ends the connection with a retryable fault: `Pardner could not save what it is
  sending (the disk may be full). Nothing was lost on the relay.` `createChannel` and `send` answer after their write and say `notSaved` when it failed.
- The app's Devices screen, a window opened by Devices… in the sidebar or Shift-Command-D once this Mac
  is paired. It lists the active devices newest first: the name in quotes or the kind, the short form, "This Mac", who added
  it, its position, when this Mac first read the add (with one line when it read several in one go) and Remove for each other
  device. Add a device gives the three values to copy (relay address, key and person id, as `pardner setup` asks them), takes
  the pairing string, refuses it in place or shows the kind, the name and the short form to check, and the list says "Adding
  ..." until the log shows it. Remove opens one confirmation listing every active device but this Mac, the clicked one chosen,
  with a warning for a device that alone holds keys, and the list shows "Removing... N left" until the act ends, also after a
  restart. A name another device gave is drawn in a line of its own between its quotes, cut in the middle when long, so that
  it cannot pass for part of the app's sentence. The first screen has Join as a new device: a form for the three values and
  this Mac's name (read from the computer when the form opens), then the pairing string with Copy, this Mac's name, the short
  form and "Waiting for your other device to add this one", with Cancel; a join whose log does not hold this Mac offers Pair
  again.
- The devices of a person in the app's pairing controller, with no screen yet. `PairingController` publishes `deviceList`
  (every device the log names, newest first, with its name from the pairing string, short form, who added it or "added by a
  removed device", position, whether it is active and whether it is this Mac, the time this Mac first read its add, how many
  epochs it alone holds and whether it joined a removal in progress, and `pendingAddName`, the name of the device a pending
  add names) and `handoffValues()` (the relay's address and key and the
  person id, to copy to a new device). `inspect(pairingString:)` runs the checks before the confirmation and refuses with a
  sentence for each reason; `confirmAdd` checks the name again, signs the entry once, writes it pending with the device's name
  (flushed) and sends it. The joining name, this Mac's own, is carried in `JoiningInfo`.
  At every rest and launch a pending entry the log holds is dropped, one it does not hold is sent again with the same bytes, one
  whose position is taken is rebuilt, a refused one is dropped with a message that names the device by its name, else by its kind and short form, and an answer of removed ends this Mac. Joining as
  a new device (`join`) writes `keys-made`, makes the keys and signs the proof once, shows the pairing string and short form
  and waits for the other device's add, which makes it paired only when the served log holds this device; Cancel erases the keys
  first and the store last, and a store at `joining` resumes at launch with the same string. A removal (`removalChoices`,
  `confirmRemoval`) is the person's choice from every active device but this Mac: it is stored with the log's length, runs the
  clicked device first and the rest newest first, one pending entry at a time, takes in devices added meanwhile, resumes after a
  restart and ends only on a log read back that shows none of its devices active; confirming it drops a pending add not yet read
  back. All of it takes turns on one queue. The joined script exports `inspectPairingString`, `makePairingProof`,
  `pairingString`, `checkPairingName` and `readDeviceEntry`, and `AppLink.checkPairing` says what an add
  would refuse before it signs. Each device of the `devices` effect carries its short form, and the app shows that one.
- The app's first-device screens, which drive the pairing controller. With no pairing the window shows what Pardner needs
  (a relay of your own) and Set up a new relay; the form takes the relay's address, its public key and the enrolment
  secret and shows each refusal beside its field. The recovery sheet shows the person id and the relay's address and key
  with Copy and Print, draws the recovery key glyph by glyph from buffers it wipes when the sheet closes (never as text,
  and not exposed to accessibility), takes the key typed back through a view that turns secure event input on only while it
  has focus in the key window of the active app, and enables Confirm only for a match; Cancel and closing the sheet decline.
  Further screens cover the enrolment (the status, the enrolment secret asked again after a refusal, and Cancel with the
  controller's rules), a removed device, missing keys, keys with no pairing, a relay put back and a transient fault with
  Retry. A link fault and a pairing file that does not read offer Pair again with the controller's advice or warning, and a
  pairing file from a newer version asks to update Pardner and offers no action. The app has one window; closing it leaves the app running and the Dock icon opens it again.
- The app's pairing store and the first device's tools, with no screen yet. `pairing/pairing.json` under the app's
  data folder keeps how far this Mac has got (`keys-made`, `enrolling`, `joining`, `paired`), the relay, the person, entry
  0 or the proof while they wait, the device entry not yet read back, the names and first-read times of devices and a
  removal in progress. It holds no secret, is written like the link's store, and a file that does not read is a fault
  the app names. The pairing and link folders are excluded from backup. The recovery secret has a text form (the 32
  bytes as 52 Crockford base32 digits and a check symbol, in groups of four) that is made and read in buffers the caller
  wipes, never a `String`. The joined script exports `buildGenesis`, which the app calls through
  `ProtocolHost.callExported`, and `RelayConnection.enrol` gives a running link its enrolment again and dials at once, until the link has told `enrolled`.
- The app's pairing controller, with no screen yet (`PairingController`, in the app's relay module). At launch it reads the
  pairing store and the keys and decides the state: the first screen, a setup that stopped before the sheet (the keys, then the
  store, are erased, and the person is told that a sheet written for it opens nothing), a resume of enrolling with the proof alone,
  paired, a store whose keys are gone, keys with no store, or a store that does not read. Setting up a new relay checks the form
  of the address, the relay's key and the enrolment secret, makes the keys, the recovery key and entry 0, hands the recovery sheet to
  the view as a request it answers, and only then writes `enrolling` and connects. A relay that refuses the secret is asked
  for it once; a cancel is allowed at once after that refusal, waits while the relay can answer, and needs a second confirmation
  with a warning while it answers nothing, which means a dial ended without reaching the relay and no connection has since.
  A refusal stands until the person types the secret again or a new attempt starts; a dial does not clear it. A device the relay removed is shown as removed and erases nothing
  until Pair again, which is offered only for a removed device, missing keys, keys with no pairing and a store at joining; a
  transient fault offers a retry from the store; a put-back relay offers pair again (set up a new relay with `pardner relay init` under a new `--instance`, or after moving the old relay's folder away); a fault of the link offers pair again too (the relay sent something that fails Pardner's checks; set up a new relay, then pair this Mac again) and refuses a retry. A pairing file that does not read offers pair again with the warning that this Mac becomes a new device; one written by a newer version of the app erases nothing and tells the person to update Pardner. The address takes `host:port` or `[IPv6]:port`.
  The enrolment secret stays in memory. The joined script exports `createRecoveryKey` and `showRecoveryKey`.
- The bot's outbox takes its epoch decision from the keeper and gives the history seals it owes
  (`Connection.giveSeal`), one at a time, computing again after each answer what is owed, so a removal read meanwhile
  stops the seals to that device. A seal that cannot be made is logged once.
- The keeper: one function in the protocol package (`src/protocol/keeper.ts`) that finds what a device owes its person's
  channels at a rest. It names the channels that need a new epoch (no epoch, closed, no key, 30 days old) and the
  history seals the device owes: for each epoch, the current one included, whose key it holds, a seal to each active
  device of the person and to the current recovery key that has no counting seal, a seal counting only while its maker
  is not removed. `Link.giveSeal` sends a `give-seal` frame at rest as `submit` sends an item. `AppLink` runs the keeper
  at each rest: it starts the epoch of each channel that needs one (whatever the reason) and gives its seals through
  `Link`, at most 16 in flight, never one twice while its answer is pending. The `devices` effect carries, for each
  active device, the epochs (channel and epoch id) for which it is the only active device sealed the key, whatever the
  state of the seal's maker. Served history seals count only once their signature is checked. The app's clock of an
  epoch's age is kept in memory, so an epoch ages by it only after 30 days of one run.
- The app's link enrols a first device and keeps the device log. `AppLinkOptions.enrol` (the enrolment secret and entry 0;
  a value that cannot be framed throws a `RangeError`) makes the link send the `enrol` frame before the proof on every
  connection until the first `served`, then never again within that process: the link tells the app once with an
  `enrolled` effect, and the app stops passing the secret, so after a restart the link connects with the proof alone.
  A refusal 2 on a connection that carried `enrol` drops the secret (sent again on the back-off it would earn the
  relay's ban) and delivers an `enrol-refused` effect; `AppLink.enrol(secret, signed, sig)` hands the link a retyped
  one, and answers `bad-input` to a value that cannot be framed. A link given none sends the proof alone as before. At
  the first rest, and at each later rest after the log changed, `AppLink` delivers a `devices` effect with the log's
  length and last id, this device's id and every device the log names, removed ones included, each with its kind,
  whether it is active, the device that added it (`null` for entry 0's device and for a device a reset named) and its
  entry's position. `AppLink.addDevice` checks a pairing's proof for the person and refuses a device the log already
  names, and `AppLink.removeDevice` refuses this device; both answer `busy` while the log is not at rest, and
  `addDevice` answers `bad-input` to a pairing of the wrong shape. Each builds and signs the entry against the log
  the link holds and returns it without sending it, for the app to keep and `submit`. The Swift `RelayConnection`
  passes `devices`, `enrolled` and `enrolRefused` to its owner, takes an optional `enrol` and does not keep the secret
  once the link holds it.
- The pairing string carries the device's name, and the device-log entry builders exist. `encodePairingString`,
  `decodePairingString`, `checkPairingName`, `shortForm` and `checkPairingProof` (`src/protocol/pairing-string.ts`) write
  and read the string (the device, its proof of possession and a name of 1 to 64 bytes of UTF-8 with no control, format
  or line-separator character), give the short form of a device id (`3f3f-a1b2-c3d4-e5f6`) and check the proof for a
  person id. `buildGenesis`, `buildAdd` and `buildRemove` (`src/protocol/device-builders.ts`) sign an entry once and
  check it against the log before returning it; `buildRemove` refuses to remove the device that signs. `pardner setup`
  prints the bot's name and short form under the string, to compare with what the approving device shows, and refuses
  a name past 64 bytes at its question.
- A bot's profile in the protocol package: message kind 13, sent by a bot alone, with no recipient and no `re`. Its
  content is UTF-8 JSON with the bot's `name`, an optional `account` and an optional `icon` (a square PNG or JPEG of 16
  to 256 pixels, 65,536 bytes at most, its size read from the image's own header). `readProfile` and `encodeProfile`
  (`src/protocol/profile.ts`) read and write it; a field they do not know is ignored. `Profiles` gives the profile a
  device shows for each bot: the one at the latest place in the relay's sequence, in any channel and whatever order
  the messages were opened in. A relay or a device of an earlier version refuses kind 13. The vectors are in
  `test/protocol/vectors/profile.json`.
- The reading's `message` output carries the message's `position` in the relay's sequence.
- The bot writes its profile: `PARDNER_BOT_NAME` (the host's name by default, then `-<instance>`) and
  `PARDNER_BOT_ICON` are read at start and stop it when they do not fit; the profile, with the account of the agent's
  login in a channel whose one member is the owner, goes into each channel at the start, in every new epoch and once
  the account is known. A relay that refuses it is not at fault: the bot logs it and writes none until its next
  start. `ChatProvider.agentAccount`, `ChatContext.instance`, `ChatContext.brand` and `AgentWords.brand` carry what
  it needs across the seams.
- The app's link (`src/protocol/index.ts`) hands each store write to its driver, as the daemon's `Link` does, and
  takes the stored state back at construction; every write carries `kept`, with only the ids after those the
  store confirmed. A message view carries its position, header fields and files (without their keys), opened with its own
  epoch's key; one whose key arrives later, through a history seal, is delivered again once it opens. The link tells
  its driver the profile shown for each bot when it changes. `Reading.key` gives the key of any epoch the device
  holds.
- The app keeps its link's state between launches (`LinkStore`, in `app/Sources/Relay/`): the ids it read, the
  relay's newest head, the incarnation, a put-back and a fault, in `link` beside the key store's folder (mode 0700), with no key
  and no content. The ids are appended to one file and the rest is written whole under a temporary name; a lock held
  for the life of the process keeps a second copy of the app from writing, and that copy does not connect.
- The app's reading model (`Conversation`, in `app/Sources/Conversation/`): the link's deliveries folded into
  channels, threads and sessions for the screens. A prompt that names a bot opens a session; an answer is drawn from
  its parts as they are written and replaced by the whole answer once it lands; a session runs from its start, waits
  while a question or an approval is open, and the Sessions tab orders sessions by the bot's last reply. A body that
  did not open or does not read is shown in its place as unreadable, and moves to its thread when it opens.
- The app's main window (`Screens`, in `app/Sources/Screens/`): the sidebar of channels and bots, the channel as a
  conversation with a thread's summary under the message that opened it and a Sessions tab, and the thread panel,
  in Light or Dark (View > Appearance). The radii and the base gap are tokens beside the colours. Until a device is
  paired the window says so; once it is, the window draws what the link delivers, in the link's order, and an erase
  of the pairing empties it. `swift run screens-snapshot <dir>` renders it over a synthetic conversation.
- A person's space in the protocol and the relay: a channel whose entry 0 carries a nonce derived from the person (the label
  `blind-relay/1 personal-space`), so its members are that person's own devices and its epochs are sealed to them and the
  recovery key alone. A device reads the first such channel placed as the person's space (`reading.space()`) and leaves a
  later one (a spare, which only an older relay places) out of `reading.channels()`. The relay answers a second space of one
  person with result 2, refuses any member entry after entry 0 of a space, and keeps a history seal of a space epoch only
  between devices and recovery keys of that person's log; none of these is applied when the relay starts. A profile (kind 13)
  is accepted in a space only, and every other kind in a conversation channel only (`messageChecker` takes the channel's
  class; refusal rule `class`). The vectors for the nonce, the class and the check are in `space.json`.
- The bot writes its profile into its person's space alone, in every profile the account included, and makes the space at a rest
  that finds none. A refusal in the space (a message, an epoch entry) stops no channel, and a fault stored on it is dropped at
  the first rest that names it. A bot of an earlier version still writes into every channel, and an updated relay refuses
  those profiles (the bot logs `relay: the relay refused the bot's profile`).

### Changed

- A task started in the background keeps its call's line in the thread (issue #73, step C1, in the turn that started it; #139). The chat seam's `TaskUpdate` has a new field, `agent`: the task an agent of the session was given (its description) on the line of a subagent's work and on the card of its reply, null on any other line. A background agent's call is no longer dropped for a launch text: its line is written when the task starts, with `task` true, `details` `Running in background`, `agent` and the call's start as `startedAt`, and the call's result adds the model to its title. A background command's call becomes the task's line at its result, and the line keeps no output, since the result names a path of the bot's machine. A task's end closes its line in place; the in-turn `✓ Agent "..." finished` text is no longer written for a task that has a line, and what a subagent said back is a card with `agent` set. A subagent that ends while a task of its own still runs stays running, with `Agent "..." is waiting on its own background work` written as before. The relay module writes an edit when a line's `task` changes. `ToolVocabulary.plainAgentType`, `Previews.launched`, `Previews.launchedTogether` and the launch texts (`TASK_LAUNCHED`, `TASKS_LAUNCHED`) are removed: one line per task, none for several in one message.
- The app's Settings window is 760 by 560 points: a column at the left lists General, Profile, Devices and Bots with their symbols, and the chosen pane at the right has its title, a line under it and its own button (`Add a device` moves from the foot of the Devices list to its header; `Back` takes its place on the add and remove pages). The device list is one card with a thin line between its rows, each with a mark (a laptop for an app, the bot's mark for a bot), and under it the line that says where a bot's pairing string comes from (`pardner setup`).
- The app's Profile pane. The Settings window lists General, Profile, Devices and Bots; a click on the person's name at the foot of the sidebar opens it on Profile, the gear and Settings… on General. Profile holds the person's name, the same on every device, with its own Save (kind 15, as before); the field shows the name the device read, or the one just saved until it is read back, and an edit goes when the window closes. The person's name form window is gone; the picture comes with issue #96.
- The app's panels are windows. Settings, the new channel form, the name forms, Channel Settings and Change Folder open in two windows of their own (`Window` scenes) that the red button, Command-W and Esc close, so the `Done` and `Cancel` buttons are gone; `Create`, `Bind` and `Save` stay. The recovery key sheet and the pairing screens' sheet stay sheets. Settings and a form can be open together, and with the main window closed. A request for a form while another is open brings the open one forward unchanged. `Rename…` on this Mac's row in Devices opens the name form beside Settings, and `Change Folder…` replaces the panel with the bind form in the same window. Esc on a Devices page other than its list goes back. A click on the Dock icon shows the main window while it is not on screen, even with Settings open.
- The app's start and sidebar. While the app first reads the relay, the Pardner logo covers the whole window until the device list and the sections are read, or for 30 seconds at most; it never comes back on a reconnection, so the sidebar no longer jumps as the sections arrive. The `Channels` header has one `+` button whose menu offers `New Channel…` and `New Section…`; the header's `…` button and context menu are gone. A channel dragged onto an empty section's `No channels` row goes into that section, as on its header. A channel's row writes `#` against its name (`#notes`), and the sidebar leaves more room under the `Pardner` header.
- The app's window reads as the boards (one pull request, six parts). The app's message block. A message's mark is 36 points: a circle for a person, a rounded square for a bot. A prompt's `@name` opens its text in the bot's colour, semibold, in place of a label after the sender's name. A thread's summary sits inside its message's block, as wide as its content: the bot's mark, `N replies`, `Last reply HH:mm`, and `Running` or `Waiting for you` only while the session runs or waits. The block of the thread the panel shows is tinted, and the panel's header writes the same two state words only. The app's channel header. The channel's name is in the display font; at the right, before the `…` menu, the channel's bot shows as its mark and name in a bordered chip (not a button). Conversation and Sessions are two underlined tabs in a row under the title, the chosen one in the text colour over a 2 point rule in the brand colour; Sessions carries the count of the channel's sessions in a pill while it has any. The app's sidebar. A channel's row shows `#` and its name without the `#` in it, the chosen row on a raised ground and semibold, a row under the pointer on that ground at half strength, and at the right the count of the channel's threads that wait for you in a pill. The foot shows your mark at 28 points and your name over a rule, and an icon button for Devices… in place of the filled button. The Bots list stays. The app's keys and context menus. `New Channel…` (Command-N) is in the File menu and opens the sheet `+` opens; it is on when this Mac is paired and the channels are ready. `New Channel…` and `Devices…` are off while the Devices sheet, the channel sheet or the name sheet is open. A channel's row has a context menu with `Rename…` and `Bind to a folder…`, on and off as the header's menu; a message has `Copy`, which puts the text it shows on the pasteboard, as does a bot's answer. The app's composer. The field is two lines high at rest, grows to eight and sets its text in Inter 14. Under it, inside the same box and above a rule, an `@` button starts the bot list as typing `@` does (a channel's composer with nothing typed, no bot named and a bot to choose) and the send button, an arrow on the brand colour, does what Return does and is off exactly when Return sends nothing (an empty field, a composer that is not ready, the bot list open, text an input method has not committed); `Return to send, Shift-Return for a new line` shows beside it while the box is wide enough. There is no attach button: a file is refused (`Files cannot be sent yet.`). The app's days and scroll. The conversation and the thread panel draw a centred day word between two rules before the first message and at each change of calendar day: `Today`, `Yesterday`, else the date. A message's time shows its date and time in a tooltip. The conversation opens at its newest message, follows a new one while it is at the bottom, and a short conversation sits at the bottom; a short thread starts under its header; the Sessions tab starts at the top.
- Recovery with the recovery key, this Mac's earlier keys. The app stores its own device id in the pairing file (version 4, which builds up to version 3 read as newer and leave untouched) when a pairing completes, and a Mac paired before stores it at its first read of the device list. After `This Mac's keys are not here` the recovery carries the earlier id: `No` adds `Your earlier keys on this Mac (<short form>) stay active until you remove them in Devices.` when that device is active in the log, and `Your earlier keys on this Mac may still be active; remove them in Devices if so.` when the app holds no id. Devices marks the device `This Mac's earlier keys` while it is active. A cancel keeps the file that holds the id for the next attempt.
- Recovery with the recovery key: where the relay answers that the key is no longer current or no longer knows the person, the refusal screen offers `Quit recovery and keep this Mac as it is`. It pauses the recovery and erases nothing (the keys, the stored reset and the stage stay); Retry then asks for the recovery key again, as a later launch does, and the way out today is to quit Pardner. There is still no Stop once the reset is sent.
- The first device's "Your name" field reads `Your name, the same on all your devices.`, so the name is not taken for a profile of this Mac.
- `@anthropic-ai/claude-agent-sdk` is pinned to 0.3.330, which bundles Claude Code 2.1.330. The release probe
  certified it; the three tools and the three stream paths it adds (`begun_message_ids` on a result,
  `served_by_anthropic` on the init record), which the Claude back end does not read, are accepted in
  `probe/accepted-shapes.json`.
- The platform's recovery call is split in two, so the recovery sheet can name the person id, which is the id of the
  device log's entry 0 and exists only after the recovery keys are made. `createRecovery` makes the secret, keeps it in
  the platform's memory under the name (a `SecretBuffer` in the app, a `Uint8Array` on Node, zeroed when wiped) and
  returns the two public keys, showing nothing. The new `showRecovery(name, context)` shows the held secret with the
  sheet's public text, erases it whatever the answer and is `bad-input` for a decline, a `context` that is not a string
  or a name with no held secret; `deleteKey` and the end of the host erase a secret never shown. A name that a key or an
  unshown secret holds is refused by `createRecovery` and `enterRecovery`. The secret still never enters JavaScript.
  `RecoveryPerson.show` takes the context and answers `true` only when the person confirmed. The package gains
  `showRecoveryKey` (`recovery.ts`), and the `recovery.json` behaviour vector runs the new sequence on both engines.
- A bot's profile name follows the rule of a device's name: a zero width character, a directional mark such as U+202E, a filler, a variation selector or a tag character is refused, as are the controls it already refused. A profile whose name holds one is not read (`bad-input`), and `PARDNER_BOT_NAME` holding one stops the start. A profile that a bot wrote earlier with such a name no longer reads, so a device shows the bot's last profile that does, else its id. When `PARDNER_BOT_NAME` is absent and the host name holds one, the start stops too: set `PARDNER_BOT_NAME`. The account's name and plan follow the same rule. The rule is one function, `hiddenInName` in `src/protocol/name-rule.ts`.

### Fixed

- The thread panel no longer shows nothing after a message is sent in a long thread. The panel is a lazy stack, and rows added at its end moved the view over rows that were never built, so it drew nothing until the next part or answer arrived. The panel now keeps its scroll position on an end row (`scrollPosition(id:anchor:)` with `scrollTargetLayout()`), so the view follows the end of the thread while it is there and stays where the owner reads when he has scrolled up. `ThreadScrollTests` and `ChannelScrollTests` draw a long thread and a long conversation in a window and check that the visible area holds drawn rows after a message is added; the conversation list did not need the change.
- In the app, an `@` typed over the text a failed send gave back opens the bot list, as in an empty field; before, the list stayed closed and the message went to the channel as text (#107).
- Dragging the divider between the conversation and the thread panel resizes the panel. The columns took the window's size from their own widths, so the drag shrank the window and the panel kept its width (#98).
- A word typed at the top of a channel (`/bind demo`, `/stop`, `/bypass on`) or a prompt the bot refused before its session opened is no
  longer drawn by the app as a session that never ran (#68). The bot tells whether the prompt's thread holds a session
  (`InboundMessage.handled(session)`; the relay writes `"session": false` in that prompt's answer) and writes its lines that answer a
  top-level prompt as texts with `re` the prompt (`ChannelChat.notice` and `say` take the prompt's id). The reading model settles a
  top-level prompt by the first sign of its bot: a setup request, a part, a text in its thread other than a `tell` or an answer without `"session": false`
  make a session; a text of the bot with `re` the prompt or an answer with `"session": false` make a message, drawn with the bot's
  lines under it and never in Sessions; a not-read before any sign reads `Not run`. A cut settles nothing: the prompt reads
  `Interrupted` and a later sign decides. A prompt the bot started and has shown no sign for yet says `Started`, and keeps the summary
  that opens its thread, so it is listed in Sessions until its answer. A refusal after the session opened (a folder Claude Code does
  not trust, a start blocked) stays a session: the bot holds its entry, and a reply runs the setup again.

- Every error the app shows is a sentence: what failed, the reason in words, and the next step (`Setup could not finish: the disk
  could not be read or written. Check the relay's values and try again.`). A case name, a raw description or a bridged system
  message alone is never shown; an error that only one step fixes gives that step (a build with no protocol script says to install
  Pardner again). `Problem.reason` and `Problem.sentence` word every error on its way to a screen, and a test fails on a screen or
  controller line that puts a raw error into a text. Setup showed `Setup failed: scriptUnavailable`.
- The app's `@` list filters as the person types: a leading `@` opens it, what follows narrows it (case-insensitive, the names that
  start with it first, then the names that contain it), the arrows move, Return or Tab picks and Escape closes it until the `@` goes.
  A bot's whole name typed after the `@` and followed by a space becomes the label, the rest staying as the text; a name that is no
  bot's, or that two bots share, stays text. The list showed every bot only for an `@` typed alone, and a typed `@name` was text.
  A bot known only by its pairing string's label is drawn in quotes in the `@` list and the New channel sheet, as in the sidebar.
- An answered request's card says what was answered: `Allowed` or `Denied`, the chosen options and the Other text after `Answered:`,
  `Skipped`, `Ran` or `Not run`, `Sent anyway` or `Not sent`, `Sent here` or `Not sent`, from the owner's reply the bot took (and
  from the reply on its way before that). A setup keeps the bot's own `Set: …`; a request the bot settled with no reply of the
  owner's says `Answered`. The reading model keeps that reply's body per request (`MessageThread.answers`).
- The app's sidebar lists every active bot from the device list: by its profile's name and account once a channel carries the
  profile, until then by the label its pairing string gave (in quotes) or its short id, with `Not seen yet`. It listed only bots
  whose profile a channel carried, so a bot just added did not show. The New channel sheet and the `@` list name and order the
  bots the same way, by name as Finder sorts.
- The app's empty window says what to do next: `Make one with + beside Channels: it binds a folder on your bot's machine.`, or,
  with no bot, to add one from Devices. It said channels came with a later version.
- The app's first screen names its two ways in by the person's situation, `This is my first device` and `I already use Pardner on
  another device`, each with a line on what it does and what it needs; the forms are titled `Your first device` and `Add this Mac to
  your devices`. Devices… in the sidebar is a button with an icon, and every button, menu and clickable row shows the pointing hand.
- The built app holds its protocol script: a build phase of the Xcode project joins `src/protocol/` into
  `Contents/Resources/protocol.js` on every build, with the Node on the build's `PATH` or the one `NODE_BINARY` names. Without it
  the app's first screen failed with `scriptUnavailable` and paired nothing. CI fails when the built app lacks the file.
- A relay connection whose store write failed delivered the next incarnation without `changed`, and the next first
  rest without `first`, so what resets on them (the bot's reader, outbox and profile writer) did not: `Link` now
  reads those flags from the incarnation its store confirmed and from the rests it delivered, not from the reading,
  which moves before the write.
- Reading a file to share allocates a buffer the size of the file (one byte more, and no more than the limit) and no longer the whole limit for every file (#3).
- `/bind` alone, `/resume` alone and `/pardner update` with a newer version no longer answer nothing on the relay chat: the chat seam has a capability `channelLists`, and `ChannelChat.offer` is present only with it. Without it each word answers the prompt with a line that says what it needs, `/resume` with a name that matches nothing no longer sends you to a list, and the update notice and status line name `pardner update` in a terminal in place of `/pardner update` (#81).
- The start's cleanup no longer logs `could not read channel <id>: no answer` for each bound channel on the relay chat. The relay chat has no lookup and no date for a thread, so its cleanup now asks nothing and forgets and prunes nothing (`state.json` keeps what it holds); the chat seam has a capability `lookups`, and `ChatProvider.channelState` and `threadState` are present only with it (#78).

## [0.17.0] - 2026-11-19

### Added

- `Requests` (`src/protocol/requests.ts`): the requests a device has in flight on its connection, each with its own id
  and its own deadline. `Link` uses it.
- `Upload` (`src/protocol/upload.ts`): the give-back upload connection as a pure state machine. After `hello` it
  sends `prove upload` and `upload done` together; `result` for request 1 or `refused` ends it with an outcome that
  names the code or the reason and whether the next dial waits `ask`. `Link` uses it.
- `FrameCutter` (`src/protocol/frames.ts`): cuts a byte stream into whole frames, applying the length limit of the
  state the caller names, and refuses a bad length before the body is read.
- The protocol package's connection policy (`src/protocol/link.ts`): the device's connection to the relay as a pure
  state machine, taking events with the time (opened, received, closed, tick, networkUp, submit, stop, persisted) and
  returning effects (dial, send, close, wake, persist, deliver, answer). Several requests may be in flight, each with
  its own id and deadline (`Requests`), and a `close` names the deadline that passed in its `why`. Its effect and state
  types are in `src/protocol/link-types.ts`. The daemon's relay client uses it.
- `app/`: the Swift package of the macOS app (macOS 15 or later). `Platform` is the protocol package's platform
  interface on CryptoKit; `ProtocolHost` runs the joined protocol script in JavaScriptCore on a thread of its own and
  returns a JavaScript fault as a Swift error. `swift test` in `app/` runs the vector files inside JavaScriptCore. The
  Xcode project `app/Pardner.xcodeproj` builds an empty macOS window, signed ad hoc, and the macOS CI job builds it.
- `app/`: the `Relay` library of the Swift package and `RelayConnection`, the app's connection to the relay: TLS 1.3
  on Network.framework with the relay's key pinned, the exporter binding, TCP keepalive, one timer on `ContinuousClock`,
  and the path monitor and the Mac's wake as `networkUp`. The policy is the protocol package's `Link`, run inside
  JavaScriptCore through `AppLink` (`src/protocol/index.ts`), which hands Swift each message as a view without key
  material. `ProtocolHost` gains `call`, which returns a value (`HostValue`, bytes as `Uint8Array`), and `construct`.
  `test/protocol/app-relay.test.ts` runs the Swift tests against a real relay on macOS.
- `app/`: the `DesignSystem` library of the Swift package. `PardnerColor` has one SwiftUI `Color` per token of the app's
  design (25 tokens), each taking its light or dark value from the appearance it is drawn in; the values are the one
  copy in `app/Sources/DesignSystem/tokens.json`. The module sets no theme.
- `app/`: the `DesignSystem` library bundles the app's three font families, each from its project's own release and under
  the SIL Open Font License 1.1 (licence texts beside the files): Inter (rsms/inter 4.1), Space Grotesk
  (floriankarsten/space-grotesk 2.0.0) and JetBrains Mono (JetBrains/JetBrainsMono 2.304). `PardnerFonts.register()`
  registers them for the process; `PardnerFont.ui`, `.display` and `.mono` return a SwiftUI `Font` with the weight set
  on the font's `wght` axis.

- `app/`: `SecureEnclaveKeyStore`, the app's made keys in the Secure Enclave, one blob file per key in
  `Application Support/<bundle identifier>/keys/`, usable after the first login since the Mac started. A key of one use
  never serves the other, and an error of the enclave or of a blob is a fault, never an answer about a remote party's
  seal. The recovery secret, its HKDF outputs and its candidate scalars live in `SecretBuffer`s that are wiped on every
  path; `RecoveryPerson`'s `show` answers whether the person saw the secret and `enter` the bytes given, or `nil` for a
  decline.
- `pardner relay init [--instance <name>]` and `pardner relay serve --listen <host>:<port> [--instance <name>]` run the
  relay's own entry file as a child process and return its exit code; the relay stays a program of its own, which
  nothing outside `src/relay/` imports. The parent ignores `SIGINT` (the terminal already sends it to the child),
  forwards `SIGTERM`, and returns 128 plus the signal's number for a child a signal ended. The relay's folder is
  `~/.local/share/pardner-relay[-<name>]`; `PARDNER_INSTANCE` does not apply. `docs/setup.md` has a part on it.
- `pardner relay service install --listen <host>:<port> [--instance <name>]`, `uninstall` and `list` run the relay as
  a user LaunchAgent, `local.pardner-relay[.<name>]`, with `KeepAlive`; its log is
  `~/Library/Logs/pardner/pardner.relay[.<name>].log`. Install refuses a folder `init` did not make, a folder a running
  relay holds and a loaded job with the label, and prints where the log is; whether the relay serves is read in the log.
  The daemon's `service list` never shows a relay job, and `relay service list` never a daemon. `uninstall` leaves the
  relay's folder.

### Changed

- `pardner update` and the update from the chat restart the relay services (`local.pardner-relay[.<name>]`) whose
  entry is in the updated copy, by `SIGTERM`, at once; `launchd` starts them again. The terminal's "It restarts:" line
  names them and each of its failure lines starts with the service's name; the chat's offer names one that was not
  restarted, with the reason the service manager gave.
- The relay's Time Machine exclusion (`tmutil addexclusion`) gets 60 seconds instead of 10: it took 11 seconds on a
  Mac mini (macOS 27.2.1, 2026-11-19), so `init` failed and a served relay could never start there.
- The daemon's relay client (`src/chat/relay/connection.ts`) is driven by `Link`: it keeps the TLS socket, the pin, the
  timer and the store writes, and `Link` holds the framing, the back-off, the refusals, the give-back and the requests.
  Several `submit`s stay in flight at once, each answered by its own result. What changed is in the log: a connection
  closed for a deadline says which one (`relay: no frame for 30 s, connection dropped`, `relay: no answer to a request
  for 30 s, connection dropped`, `relay: no hello for 30 s, connection dropped`, `relay: no answer to the give-back
  for 30 s, connection dropped`; a request or a hello that went unanswered logged nothing before), and `relay: give-back
  answered with <type>` is gone.
- `test/protocol/jsc.test.ts` runs `swift test` in `app/` and keeps the cross-engine seal check on Node; the Swift
  harness that was in `test/protocol/jsc/` is now in `app/`.

### Fixed

- `pardner service install` that fails because `plutil` refuses the plist or launchd does not load it leaves the plist
  as it was: none, so `service status` and `service list` no longer show a stopped service that was never installed,
  or the plist `service stop` left, with its text and its stop, so the next login does not start the service.

## [0.16.0] - 2026-11-18

### Added

- A release workflow (`.github/workflows/release.yml`): a `v*` tag the owner pushes publishes the package to npm
  through npm's trusted publishing, once the tag names the version, its commit is on `main` and CI has passed there.

### Changed

- Commands are typed as in the terminal. A pardner word starts with `/` (`/status`, `/bind <folder>`,
  `/stop`), where it started with `!`. Any other `/name args` is still a command of the agent, and in a
  chat that suggests commands `/` alone lists them. A shell command starts with `!` (`!ls` or `! ls`),
  where it started with `!!`. A `/` followed by a space is plain text, and so is a message with
  anything but a space before the prefix (`\/goal`, `\!ls`). `!` alone is refused as a shell command
  with nothing after it.
- `@anthropic-ai/claude-agent-sdk` is pinned to 0.3.327, which bundles Claude Code 2.1.327. The release probe
  certified it; six stream paths it adds, which the Claude back end does not read, are accepted in
  `probe/accepted-shapes.json`, and claim P33 accepts a goal its evaluator judged not met before it was achieved.

## [0.15.0] - 2026-11-18

The first version published on npm as `pardner`.

### Added

- The seam tells a chat when the core is done with an owner's message and which message a reply is for:
  `InboundMessage.handled?()` is called once when the core no longer works on the message (its turn ended, its word
  was answered, it was dropped; after the failure's reply, if any), and `ThreadChat.openReply(onOpenMessage, prompt?)`
  takes the owner's message the turn is for (`!!command` included; a report turn passes none). `ChatInbound.message`
  resolves earlier, when the prompt reaches the agent (measured on the memory chat and the plain agent). Slack and the
  memory chat ignore both; nothing under `src/chat/slack/` changes.
- The relay chat is in the registry as `relay` (`ALLABOARD_CHAT=relay`, with `RELAY_ADDRESS`, `RELAY_KEY` and
  `RELAY_OWNER`). A start builds the store, the connection, the outbox, the reading of the owner's messages and the
  provider, which dials when the daemon starts it. A reply is written as parts of at most 64 KiB (kind 4) naming the
  answer of the prompt it is for, and each prompt the bot started gets one answer (kind 5) when the core is done with
  it; text only. Later text, and a report turn's, goes out as texts of the thread. `closeOut` answers at once and
  `Outbox.landed` resolves once a reply's messages are read back, false when one was dropped or the bot stops. A stored
  put-back or fault, or a `RELAY_ADDRESS` that is not `host:port`, refuses the start.
- The node platform keeps its private keys in an optional key file (`src/platform-node/key-file.ts`; mode 0600,
  written atomically before `makeKeyPair` returns, loaded and validated at the start). `deleteKey` now returns a
  `Result`, and `PlatformError` gains `io-failed` for a write that failed. `erase()` zeroes a platform's keys.
- The bot can be paired with a relay (`src/chat/relay/`: `pair`, `loadPairing` and the setup questions of a
  `relayChat` entry). `ModuleSetup.finish` runs after the wizard wrote `.env`, with the instance lock the wizard
  holds from before the file exists; the pairing removes the old keys and pairing file, makes new keys for the
  person id and writes the pairing file last. `ChatContext.configDir` gives a module the instance's configuration
  directory. The entry is not in the registry yet and does not connect.
- The bot has a store (`src/chat/relay/store.ts`): one JSON file beside the pairing file with what it keeps
  between runs (decisions, the reading's ids, head, put-back mark and fault, the incarnation it last read
  under, the outboxes, the channels with a stored fault, each epoch's first read), written whole by one serialized writer. It holds no key. A store that does not
  read stops the start and the error names the file. A new pairing resets it keeping only the decisions, and a
  start finishes a reset a crash cut when the store's device id or relay key differs from the pairing's.
- The bot sends (`src/chat/relay/outbox.ts`, `Connection.submit`): each message waits in its channel's stored
  outbox and is built once, only in an open epoch whose key the bot holds, stored with its built bytes and then
  sent; a restart sends the same bytes again until the bot reads the message back, and the run and its counters
  live in memory alone. Result 3 or 4 builds it again in the next epoch; result 1 is "not delivered" when the
  package's checks of its kind, recipient and reference refuse it and otherwise a relay fault stored for that channel until a new
  pairing; result 8 (or a frame the protocol cannot encode) and result 9 drop it so that no channel blocks; a draft with a file is refused until step 6. A message is sent only after a write of the store holds its built bytes, and a submit with no answer in 30 s drops the connection. The bot starts the next epoch of a channel
  when, at each rest, it is closed, has no epoch it holds the key of, runs out of counters or is 30 days old (counted
  from the first read, kept in the store). Starts left in an outbox are dropped at a restart and at a new
  incarnation. Not in the registry yet; parts split at 64 KiB come with the replies.
- `BotReader` acts on the owner's replies (kind 10): the conditions of a prompt, no incarnation rule, and `re` a
  request of the bot's own read earlier.
  `Prompt.answers` names the request.
- The bot takes the owner's prompts and answers in (`src/chat/relay/inbound.ts`, `provider.ts`): each message of
  the reading goes through `BotReader`, and a prompt reaches `ChatInbound.message` once, after the bot's start is
  read back and its decision stored (a prompt started and not handed on is answered "The bot did not run this prompt.", a reply the bot could not hand on, "The bot could not take this answer.", "The bot could not read this answer." or "The bot is no longer waiting for this answer."); a prompt with a file is said "not read" (files come with step 6). The owner's
  reply (kind 10) to a request of the bot's own reaches `ChatInbound.answer` when it has the request's type and every field of the answer has the seam's type, every key of its answers is the text of one of the request's questions (the bot keeps the texts, and after a restart reads them from its own request), at least one is named, and a note is for an answered question (a malformed one leaves the request waiting), and the
  bot then writes an answer (kind 5) naming the reply. The relay provider has every capability
  false and writes texts; `Out`'s `incarnation` carries `changed`, which the outbox and `Inbound` read; requests and replies out refuse until their step. Not in the registry yet.
- The bot asks the owner (`src/chat/relay/provider.ts`, `inbound.ts`): `ThreadChat.ask` writes a request (kind 9,
  `{thread, request, title}`) naming the owner's latest prompt in the thread, or the one that opened it, and records the
  request before it is written so that a reply cannot arrive first; `withdraw` and `rewrite` write an edit (kind 11,
  `{thread, withdrawn}` or `{thread, markdown}`) and end the wait. After a restart `Inbound` rebuilds each request still
  in the sequence from the bot's own kind 9 read back, so a reply to it reaches `ChatInbound.answer`, which answers false
  for an id it does not know, and a core that says false gets the owner's reply answered (kind 5). The body leaves out
  the core's request id and the agent's call id; a request that cannot fit a frame is refused (`relay_too_large`);
  `keepAnswers` writes a kind 11 `{thread, answered: true}`. Replies out (`openReply`) still refuse until R9. Not in the registry yet.
- The bot connects to the relay (`src/chat/relay/connection.ts`): TLS 1.3 with the relay's key pinned from the
  pairing file (compared as DER, so any kind of certificate key is another key), the exporter binding, `prove
  active`, then the package's `Reading` to rest, keeping its ids, head and incarnation in the store. It dials again
  after a drop, 1 s doubling to 60 s and back to 1 s at rest; a refused bot asks again every 10 minutes; a bot at
  rest sends a read 10 minutes after the last frame it sent, and drops a connection that stays silent for 30 s
  before rest or after a read. Any error is a drop; a relay that must be recreated, and a fault of the sequence
  (stored until a new pairing), stop it for good. `Reading` takes the stored incarnation and fault. The entry is
  not in the registry yet and sends no message. When the relay is behind or refuses the bot while it holds a head,
  the bot gives the head back on a connection of its own (`prove upload`, `upload done`); `Reading.gaveBack`
  takes the result code or the reason of the refusal that answered.
- The protocol package builds an epoch entry for a device (`src/protocol/epochs.ts`: `buildEpoch`
  at the logs the device holds, its key sealed to every active device and recovery key, never
  returned) and says when a device starts one (`whyStart`: no epoch, a closed channel, no key, a
  rollover, or 30 days from its first read of the entry, kept in `EpochClock`). The test helper
  that built entries for the relay's tests now calls it. Nothing in the daemon uses it yet.
- The protocol package's device reading (`src/protocol/reading.ts`): a device's record of the
  relay's sequence, its head and the give-back of relay continuity design 4, the follow's pushes,
  and the device's logs, channels and epoch keys folded as items arrive, with each message handed
  on at its place for `BotReader`. Pure: the caller sends and stores. Nothing in the daemon uses it
  yet.
- The relay takes a history seal only when its maker is a device, and its recipient a device or
  a recovery key, that a person's log the relay holds ever named, and its epoch is placed in its
  own channel; any other is refused and nothing is stored. A start cuts the seals file at the
  first seal whose maker, recipient or epoch the relay does not name or place.
- The protocol package's platform interface (`src/protocol/`) and its implementation on Node
  (`src/platform-node/`). One joined script runs the platform vectors in a bare `vm` context and,
  on macOS, inside JavaScriptCore with CryptoKit (`test/protocol/jsc/`). Nothing in the daemon uses
  them yet.
- HPKE (RFC 9180) on Node (`src/platform-node/`), composed from `node:crypto` and checked against
  the RFC's test vector for DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM. Nothing in the
  daemon uses it yet.
- The protocol package's byte encoding (`src/protocol/bytes.ts`), its labels (`labels.ts`) and the
  ids of devices, recovery keys and the relay key (`ids.ts`), the device log's entries with their
  checks and the proof of possession a new device signs (`device-log.ts`), the member log's (`member-log.ts`) and the epoch log's (`epochs.ts`) with the epoch key's seals and the history seals, the recovery key's derivation (`recovery.ts`) and the file blob (`files.ts`) and the message with its sealing and the check of a received one (`messages.ts`), the proofs of the connection to the relay, its signed head and its running hash (`proofs.ts`) and the frames of that connection (`frames.ts`, among them the enrolment frame a first device sends before any proof) with vectors run on Node, in a bare
  `vm` context and in JavaScriptCore, and the outbox with a sender's run and its counters
  (`outbox.ts`), what every device does with the messages it accepts (`device-reader.ts`: the
  seen-set, how a prompt is shown, which edit is honoured) and what a bot acts on (`bot-reader.ts`,
  security design 5.8), tested on Node without vectors. Nothing in the daemon uses them yet.
- The relay's write rounds (`src/relay/`): the `fsync` round that answers only what is on disk,
  with a seam for the write, the sync, the free space and the clock, and the log of the relay. A
  short write, a write error or a failed `fsync` stops the process with 75. Only `src/relay/` uses
  it; the daemon does not.
- The relay's journal (`src/relay/`): the journal of the one sequence with its running hash and a
  check on each record, and the start's read that drops a torn tail. Only `src/relay/` uses
  it; the daemon does not.
- The relay's directory (`src/relay/`): the lock, the three conditions, the mark of failing closed
  and rule 11's check. Only `src/relay/`
  uses it; the daemon does not.
- The relay's `init` and start (`src/relay/`): `init` builds a whole directory in a temporary folder
  and renames it into place, printing the public key and the enrolment secret once, before the
  rename; the start takes the lock, sets the Time Machine exclusion, honours the mark, reads the
  journal and syncs it, and draws an incarnation. `main.ts` runs the two commands, which
  `node src/relay/main.ts` starts.
- The relay's device entries and reads (`src/relay/sequence.ts`): the device logs as the relay
  indexes them, the evaluation of a device entry in the model's order with the package's checks
  (the devices a removal takes out are returned, so that their connections close first), the
  placing of the first genesis, and the head over what is on disk. `Sequence.open` builds the
  indexes in the pass that reads the journal.
  The device log gains `currentRecovery`. The give-back is in `giveback.ts`. Only `src/relay/` uses it;
  the daemon does not.
- The relay's channels (`src/relay/sequence.ts`): member entries, epoch entries and messages in the
  model's order with the package's checks, the closing and opening of a channel's epoch, the slots
  and the message checker, and the index of which blobs the sequence wants (a replaced build's is
  not), with a hook for the blobs held on disk. The memory cost of the message index is not
  measured yet (design 11.5). Only `src/relay/` uses it; the daemon does not.
- The relay's history seals (`src/relay/seals-file.ts`, `seals.ts`): the seals file read at start
  with the journal's rule for a bad entry, one seal kept for each epoch, recipient and maker, taken
  only from an active device that made it, and served only once its round completed. Only
  `src/relay/` uses it; the daemon does not.
- The relay's blobs (`src/relay/blobs.ts`): a put goes to a `tmp-` file whose data a round syncs
  before it is renamed to its id, and it is held and answered once the next round has synced
  `blobs/`, so no message can name a blob before both of its names are on disk; a write error refuses that put and the relay
  serves on; the free space, the largest blob and the bytes no message names are bounded; a blob the
  sequence no longer wants, and a removed device's unnamed blobs, are removed. Only `src/relay/`
  uses it; the daemon does not.
- The relay's certificate, frame reader and connection limits (`src/relay/certificate.ts`,
  `frames-in.ts`, `limits.ts`): a self-signed certificate over the relay's key made at each start,
  frames read whole under a size limit, a deadline and a budget of partial bytes, and the counts,
  pools, eviction, ban and idle limits of the connections. Only `src/relay/` uses it; the daemon
  does not.
- The relay serves (`src/relay/server.ts`): `serve` opens the directory through the sequence, loads
  the seals and the blobs, and listens with TLS 1.3 alone; each connection gets `hello`. Only
  `src/relay/` uses it; the daemon does not.
- The relay's proofs and enrolment (`src/relay/proofs.ts`): a proof of an active device or of the
  recovery key is checked in the design's order, bound to the connection's nonce and TLS binding,
  and answered `served` or `refused`; an enrolment with the secret places the first genesis and is
  never answered; a device holds four served connections; a relay that started failed closed
  answers every proof `refused 6`. Only `src/relay/` uses it; the daemon does not.
- The relay's give-back (`src/relay/giveback.ts`, `proofs.ts`): a proof of upload is checked, and a
  head given back on it, or on a served connection, is decided on the head alone: accepted,
  refused, or the relay fails closed with its mark, answers `result 11`, refuses every other
  connection with `refused 6` and every later proof the same. Only `src/relay/` uses it; the
  daemon does not.
- The relay's outbox (`src/relay/outbox.ts`, `server.ts`): everything a served connection is sent
  goes through one queue that builds an answer, or takes a stream's next step, only while the
  socket has room. A write the socket queued in memory stops the connection's reading until
  `drain`, the rest of the chunk waiting for it, so a peer that does not read holds one frame and
  not what it asked for. A frame half read has no deadline while the relay's own writes hold the
  connection, and its 30 seconds start again at the `drain`. After `end` nothing is written. Only
  `src/relay/` uses it; the daemon does not.
- The relay's requests (`src/relay/requests.ts`): a served connection's `submit`, `read` and
  `give seal` are evaluated in the model's order and answered once their round is on disk, after
  the directory was checked again (rule 11); a `submit` whose `item` frame would pass 1 MiB is
  answered 8 and placed nowhere; a `read` stays open, and each round that completes tells the
  devices it removed `refused 1`, then pushes its seals and items to the followers that have
  something new, through the connection's outbox, so a peer that does not read holds one frame; a
  connection with more than 64 answers waiting is paused until 32; a recovery connection submits
  its one reset; a second proof closes the connection; an error nothing expected stops the relay
  with 75 and a log line. Blob requests and the recovery log come in the next pull requests. Only
  `src/relay/` uses it; the daemon does not.
- The relay's blob requests (`src/relay/requests.ts`): `put blob` is answered once the data's round
  is on disk, and `get blob` gives the chunks of a held, wanted blob from its offset, one stream per
  connection through its outbox, from a state a restart keeps. A refusal that rests on the state in
  memory is sent once what is written is on disk. Each round that completes removes the blobs a
  build it covers made unwanted, those a message it covers names that are unwanted as they are
  placed, and the unnamed blobs only a removed device put; the unnamed blobs past their time go
  once an hour, under rule 11's check and never while the relay decides to fail closed or has.
  Only `src/relay/` uses it; the daemon does not.
- The relay's recovery log and counts (`src/relay/requests.ts`, `limits.ts`, `main.ts`): a connection
  after `prove recovery` can ask once for the person's device log up to what is on disk, answered
  as signed in as many `log` frames as it takes, read a frame at a time, closed by a `result` with
  code 0; a connection whose recovery key a reset on disk replaced, its own reset apart, is refused
  3 and closed, and a second ask closes it. Once a minute, and only when not zero, the relay logs
  how many proofs it refused, whatever the reason and enrolments apart, and how many connections
  its limits dropped (a length or the partial frames' bound, not a frame that does not decode),
  with no address. Only `src/relay/` uses it; the daemon does not.
- Claude can share a file of the session's folder into the thread by itself, with the tool
  `mcp__pardner__share_file` of an in-process MCP server the session is started with (#93). The
  core allows it when the chat can upload a file (`DaemonActions.share`,
  `Capabilities.daemonActions`), and the file goes through the upload `!open` uses. In a mode that
  asks for every tool call, each call asks in the thread; pardner adds no allow rule. `zod` is a
  direct dependency now (4.6.7), since the SDK's `tool` takes a zod shape. Probe claim P49 checks
  the tool is offered, deferred, asked about in `default` mode and run.

### Changed

- The package, the command and the daemon's own names are `pardner`, which was `allaboard`:
  `npm install -g pardner`, `pardner setup`, `pardner service`, `pardner update`; the variables `PARDNER_AGENT`, `PARDNER_INSTANCE`
  and `PARDNER_SHELL`; the configuration folder `~/.config/pardner` (`~/.config/pardner-<name>` for a named instance),
  with `~/.config/pardner_identities` and `~/.config/pardner_update`; the LaunchAgent `local.pardner` and its log under
  `~/Library/Logs/pardner/`; the word `!pardner`; the session's tool `mcp__pardner__share_file`; the log's module names (`pardner.core.…`); and
  `PARDNER_LINUX_IMAGE` for `npm run test:linux`. Nothing of an `allaboard` install is read: its folders, variables
  and LaunchAgent stay where they are. The relay chat module moves from `src/chat/pardner/` to `src/chat/relay/`, its
  name in the registry, and `test/vocabulary.test.ts` lets `src/protocol/` and `src/relay/` name `relay` alone.
- The minimum Node is 26.5.1 (`engines.node` and `node-version.MINIMUM_NODE`) in place of 22.19: the Node the local runs
  of the suite use. Node 22 ends on 2027-04-30. CI, the release watch and `npm run test:linux` run the latest Node 26,
  and `@types/node` moves to 26 with the floor.
- `pardner setup` asks its questions with `node:readline` alone. A pick from a list is a numbered list (type a
  number, Enter takes the first, an answer out of range asks again) in place of the arrow keys, and an answered
  question still clears itself from the screen. Ctrl-C, and Ctrl-D on an empty line, still end the wizard with nothing written; at the question of `pardner update` they now print `Not updated.` and exit 0 where Ctrl-C raised an uncaught error. `@inquirer/input`,
  `@inquirer/password` and `@inquirer/select` are gone from `package.json`.
- `!open` shares a file of up to 30 MB, and `!diff` a diff of up to 30 MB, where both stopped at
  1 MB, Slack's limit for a snippet. A file shared with no snippet type is no snippet: a PNG of
  32.7 MB, a JPEG of 27.7 MB, a PDF of 7 MB and a text file of 2.1 MB were taken (measured
  2026-11-11; `read.SHARE_LIMIT`, #93). A `.ts` over `read.SNIPPET_LIMIT` is shared with no
  snippet type, and Slack typed one of 1.8 MB as TypeScript by itself. The upload of a shared
  file's bytes waits 90 seconds (`clients.UPLOAD_TIMEOUT_MS`) where every Slack call waits 30, so
  that a file of 30 MB uploads in time from about 2.8 Mbit/s.
- `@anthropic-ai/claude-agent-sdk` is pinned to 0.3.323, which bundles Claude Code 2.1.323. The
  release probe certified it on 2026-11-13 against 0.3.322: the SDK surface table holds and no
  claim changed. Twelve stream shapes the fixtures do not hold were accepted, most from the first
  run of the `share_file` scene, none read by the source. Of two runs, the second was not offered
  `/send-to-project` and `/ultrareview` while the first was, so the recorded commands stay as they
  are (#286).
- `@anthropic-ai/claude-agent-sdk` is pinned to 0.3.322, which bundles Claude Code 2.1.322. The
  release probe certified it on 2026-11-11 against 0.3.321: the SDK surface table holds, no claim
  changed, the session is offered the same commands and the run produced no new stream shape
  (#271).
- `@anthropic-ai/claude-agent-sdk` is pinned to 0.3.321, which bundles Claude Code 2.1.321. The
  release probe certified it on 2026-11-10 against 0.3.319: the SDK surface table holds, no claim
  changed, the session is offered the same commands, and the one new stream field,
  `first_request_cache_read_input_tokens` on a turn's result, is left unread (#256).
- `node probe/main.ts --scene <name>` runs the named probe scenes alone, with the scenes they need
  (`scenesFor`), and prints their claims' outcomes without storing or certifying anything (#258).
- A channel `!stop` now drops the goal of a session whose message sent before the stop still runs, once
  that turn has ended (#251). Until then no message reaches the agent, so none runs with the goal.
  The stop answers at once for such a session.
- A message sent while a turn runs goes to the agent at once (#185), as in the terminal, for an
  agent that declares `promptDuringTurn` (Claude Code): it takes the message into the running turn,
  which ends with the taken note, or runs it as the next turn. Several messages can be announced
  before one turn (`ThreadSession.announced` is a list). A `!!command` waits until nothing runs
  and nothing is sent, and the message that names a `!fork` copy waits for every message sent
  before it. A restart that drops a session lists a message the agent took in as taken, not as
  not sent. `!stop` with messages sent and no turn yet still interrupts and leaves the root on
  `✅` once the turn it cut ends; a message that interrupt reached before the agent took it in is
  listed as not sent. A command of the agent waits like a `!!command`. An agent without the
  capability keeps one message at a time.
- A message the stop's cut took with it (#252) is listed as not sent when an agent that declares
  `declaredState` says `idle`, not at a 30-second mark; a message written after the `!stop` is never
  listed. The agent seam states the order as a contract (`idle` only when no message it was sent
  will still run, after the turn's end), the plain agent and probe claim P48 check it. An agent
  that does not say its state keeps the 30-second wait.
- The end line of a background task that ended while a message waited is no longer lost when a
  second `!stop` in the gap cuts that message and the wait drops it (#266): it is written where
  the task started, or on the `was not sent` note when that reply is finished.
- A reply whose stream is still open when it ends, with a message of yours below it (one the agent
  took into the turn), stays where it is, and its end (the words after its last call, the note and
  the footer) is posted as a new message below your message, as the end of a reply past 280 seconds
  is (`ThreadPlaces.anyBelow`). A reply with no end to move (no words after its last call, or an
  answer that is text alone, and no line on how it was cut short) stays whole above your message. The taken note reads `Claude Code took your message into this
  turn.` (`took N messages`).

### Removed

- The Slack chat module (`src/chat/slack/`), its tests, its documents (`docs/slack-provider.md`, the Slack parts of the
  setup guide, the features table, the limits and the architecture) and its app manifest, the two Slack dependencies
  (`@slack/bolt` and `@slack/web-api`), and the choice of chat by name: `ALLABOARD_CHAT` is no longer read, asked or
  written. The daemon runs the relay chat alone, and `pardner setup` asks for the agent and the relay's values.
- The conversion of an older `state.json`. A file written before the relay chat (version 1, version 2, or no version) is
  refused at the start, with a message that says to move it aside, and is never converted, deleted or rewritten. With it
  go the version 1 migration, the upgrade notice and the channel's `notice_pending` key, the version 2 write of a store
  with no names, and the reading of a status stored as a reaction name. `bypass_off` stays: it is the only record of an
  explicit `!bypass off`. `StateStoreOptions.modules` is required.
- The Release workflow (`.github/workflows/release.yml`), its script `.github/scripts/release.mjs` and their test.
  Nothing in CI publishes a package now. CI runs the tests on macOS alone; lint and types stay on Linux, and the
  Windows job is gone.

### Fixed

- A scheduled run that arrives while a message of yours waits no longer takes that message: the
  message gets its own turn and reply after the run, where it was marked answered by the run, and
  after a second `!stop` it is not told `was not sent because you stopped it`. The run's words
  show in the reply first opened for the message. Claude Code marks the start of such a run with
  `wakeup_source` on its `command_lifecycle` record, which `sdk.d.ts` does not declare (measured
  2026-11-13); the translator reports the run's end as the agent's (#270).
- `!diff` lists an untracked text file over 1 MB with its lines and a **Diff** button, where it
  showed it as `binary`: its lines are counted a chunk at a time (`read.scanOpenable`) and its
  diff is read up to the chat's file limit, 30 MB in Slack, as a tracked file's is. An untracked
  text file over that limit is listed as `too large`, with no button (#282).
- In a thread, the text sent from the field of a suggestion for a mistyped `!word` now carries
  the table or the card pasted under the word, read back from Slack when the field is sent; it
  carried the field's text alone (#275).
- A message with a pasted table or card is read from the words the owner typed, rebuilt from the
  composer's block with their code, bold, italic and strikethrough marks. Slack's text for such a
  message ends with `, with interactive elements` and moves a code span's trailing space outside
  its backticks (measured 2026-11-12): a `!word` in inline code was sent to the session as a
  prompt, a plain one showed those words in the suggestion's field, and every such prompt
  reached the session with them. Words that hold a link, an emoji, a mention or a run in two
  styles are still read from Slack's text.
- After a switch of the Claude Code login, a thread's footer no longer shows the old account's
  email beside the new account's limits. With limits, the footer and `!status` name the account
  the limits were read for. The usage probe starts and closes a session for each read, and takes
  the account from that session: the SDK reports the account a process started on, never a later
  login (#276).
- A `!word` the agent does not offer, sent as text, now carries the message's whole content:
  a table or a card pasted with it reaches the agent, as it does for any other message (#273).
- A table or a card pasted from a reply into a message now reaches Claude Code: Slack sends
  them as blocks and leaves the table's cells and the card's details out of the message's text,
  so they are appended after it, the table in markdown (#120).
- After a `!stop` between a message's send and its turn, a message the cut may have taken no
  longer counts as owed to the agent until a replay shows it runs (#252): a refusal or a turn the
  agent starts in the wait opens nothing on its account, and it is always told `was not sent
  because you stopped it` if it never runs. Before, a refusal in the wait opened a turn no result
  ended, and the thread stayed working.
- After a second `!stop` in the gap, a scheduled run that fails before its first step no longer
  takes the message in doubt (#265): the turn's end names the messages it answered
  (`turn_ended.answers`, which the Claude back end reads from the result's `user_message_uuids`),
  and only a turn that names it is put on its account. Before, the message was told not sent on
  the run's reply.

## Before pardner

Versions 0.1.0 to 0.14.0 were published on npm as `allaboard`, a daemon driven from Slack. Their changelog is not
carried here.

[0.17.0]: https://github.com/duqaXxX/pardner/tree/v0.17.0
[0.16.0]: https://github.com/duqaXxX/pardner/tree/v0.16.0
[0.15.0]: https://github.com/duqaXxX/pardner/tree/v0.15.0
