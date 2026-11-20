# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- The app's Devices screen, a sheet over the main window opened by Devices… in the sidebar or Shift-Command-D once this Mac
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
  paired the window says so; `swift run screens-snapshot <dir>` renders it over a synthetic conversation.

### Changed

- The platform's recovery call is split in two, so the recovery sheet can name the person id, which is the id of the
  device log's entry 0 and exists only after the recovery keys are made. `createRecovery` makes the secret, keeps it in
  the platform's memory under the name (a `SecretBuffer` in the app, a `Uint8Array` on Node, zeroed when wiped) and
  returns the two public keys, showing nothing. The new `showRecovery(name, context)` shows the held secret with the
  sheet's public text, erases it whatever the answer and is `bad-input` for a decline, a `context` that is not a string
  or a name with no held secret; `deleteKey` and the end of the host erase a secret never shown. A name that a key or an
  unshown secret holds is refused by `createRecovery` and `enterRecovery`. The secret still never enters JavaScript.
  `RecoveryPerson.show` takes the context and answers `true` only when the person confirmed. The package gains
  `showRecoveryKey` (`recovery.ts`), and the `recovery.json` behaviour vector runs the new sequence on both engines.

### Fixed

- A relay connection whose store write failed delivered the next incarnation without `changed`, and the next first
  rest without `first`, so what resets on them (the bot's reader, outbox and profile writer) did not: `Link` now
  reads those flags from the incarnation its store confirmed and from the rests it delivered, not from the reading,
  which moves before the write.

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
