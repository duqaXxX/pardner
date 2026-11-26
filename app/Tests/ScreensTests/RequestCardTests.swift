// The cards of the bot's requests and Stop (requests design 2 and 4): the answer each card's controls build, checked field by field against the
// bodies of test/chat/relay/app-answers.json (which the bot's inbound path takes in app-answers.test.ts), one reply per card, Return and
// Escape, what a refusal does to a card, Stop and the mode menu. Over fixed states and a stand-in sender; no controller runs.
import Conversation
import Foundation
import ProtocolHost
@testable import Relay
@testable import Screens
import SwiftUI
import XCTest

@MainActor
final class RequestCardTests: XCTestCase {
    private static func id(_ byte: UInt8) -> Data { Data(repeating: byte, count: 32) }
    private let channel = id(0x3F), alice = id(1), mini = id(2), gone = id(4)
    private var sent: [(Data, OutboxDraft)] = []
    private var outcome: SendOutcome = .queued(name: Data(repeating: 0xE1, count: 16))
    private var conversation = ConversationModel()
    /// The composers made, held for the test: a card keeps its composer weakly (`Composers` holds them in the app).
    private var composers: [ComposerModel] = []

    private func devices(botActive: Bool = true) -> DevicesModel {
        var s = DevicesState()
        func row(_ b: UInt8, _ kind: DeviceKind, _ active: Bool) -> DeviceRow {
            DeviceRow(id: Self.id(b), kind: kind, label: nil, shortForm: "", adder: .none, position: Int(b), active: active, isThisMac: kind == .app, seenAt: nil,
                      onlyHolderEpochs: 0, addedWhileRemoving: false)
        }
        s.rows = [row(1, .app, true), row(2, .bot, botActive)]
        return DevicesModel(state: s)
    }

    private func view(_ kind: Int, _ sender: Data, _ json: [String: Any], at: Int, to: Data? = nil, re: MessageRef? = nil) -> HostValue {
        .object([
            "do": .string("message"), "position": .number(Double(at)), "channel": .bytes(channel), "sender": .bytes(sender),
            "name": .bytes(Data(repeating: UInt8(at), count: 16)), "epoch": .bytes(Data(repeating: 9, count: 32)),
            "time": .number(1_700_000_000_000 + Double(at) * 1000), "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null,
            "blobs": .array([]), "files": .array([]), "again": .bool(false),
            "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null,
            "text": .string(String(decoding: try! JSONSerialization.data(withJSONObject: json), as: UTF8.self)),
        ])
    }

    @discardableResult
    private func deliver(_ kind: Int, _ sender: Data, _ json: [String: Any], at: Int, to: Data? = nil, re: MessageRef? = nil) -> MessageRef {
        conversation.apply(.delivered(view(kind, sender, json, at: at, to: to, re: re)))
        return MessageRef(device: sender, name: Data(repeating: UInt8(at), count: 16))
    }

    /// A session of alice's with `mini`, started, and a request of the bot's in it (position 3).
    private func session(_ request: [String: Any], title: String = "Allow Edit?") -> (thread: String, root: MessageRef, request: MessageRef) {
        conversation = ConversationModel()
        let root = deliver(2, alice, ["text": "go"], at: 1, to: mini)
        deliver(3, mini, [:], at: 2, re: root)
        let asked = deliver(9, mini, ["thread": root.hex, "request": request, "title": title], at: 3, re: root)
        return (root.hex, root, asked)
    }

    private func composer(_ thread: String, devices d: DevicesModel? = nil) -> ComposerModel {
        let made = ComposerModel(channel: channel, thread: thread, conversation: conversation, devices: d ?? devices()) { [self] channel, draft in
            sent.append((channel, draft))
            return outcome
        }
        composers.append(made)
        return made
    }

    private func makeCard(_ request: [String: Any], title: String = "Allow Edit?") -> (RequestCardModel, ComposerModel, (thread: String, root: MessageRef, request: MessageRef)) {
        let s = session(request, title: title)
        let c = composer(s.thread)
        let message = conversation.reading.channels[channel]!.messages.last!
        return (c.card(for: message), c, s)
    }

    /// Lets the sends the keys started run: a key press hands its task to no one.
    private func settle() async { for _ in 0..<20 { await Task.yield() } }

    private func object(_ text: String) -> [String: Any] { try! JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any] }

    private var permission: [String: Any] { ["type": "permission", "toolName": "Edit", "input": ["file_path": "a.md"], "title": NSNull(), "description": NSNull(), "plan": NSNull()] }

    // MARK: the answers, against the fixtures the bot takes

    private func fixture(_ name: String) throws -> (request: [String: Any], answer: [String: Any]) {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        let file = try object(String(contentsOf: url.appendingPathComponent("test/chat/relay/app-answers.json"), encoding: .utf8))
        let found = (file["cases"] as! [[String: Any]]).first { $0["name"] as? String == name }
        return (try XCTUnwrap(found)["request"] as! [String: Any], found!["answer"] as! [String: Any])
    }

    /// Runs `controls` on the card of the fixture's request and checks the reply it queued: a kind 10 to the bot, naming the request, with the fixture's body.
    private func check(_ name: String, file: StaticString = #filePath, line: UInt = #line, _ controls: (RequestCardModel) -> Task<Void, Never>?) async throws {
        let f = try fixture(name)
        sent = []
        let (card, _, s) = makeCard(f.request)
        await controls(card)?.value
        let draft = try XCTUnwrap(sent.first?.1, "\(name): nothing sent", file: file, line: line)
        XCTAssertEqual(sent.count, 1, name, file: file, line: line)
        XCTAssertEqual(draft.kind, 10, name, file: file, line: line)
        XCTAssertEqual(draft.to, mini, file: file, line: line)
        XCTAssertEqual(draft.re, MessageReference(device: s.request.device, name: s.request.name), file: file, line: line)
        XCTAssertEqual(NSDictionary(dictionary: object(draft.content)), NSDictionary(dictionary: ["answer": f.answer]), name, file: file, line: line)
        XCTAssertEqual(Set(object(draft.content).keys), ["answer"], "no other field: the body is exactly `{answer}`", file: file, line: line)
    }

    func testSetupAnswersWhatTheControlsHold() async throws {
        try await check("setup untouched") { $0.primary() }
        try await check("setup chosen") {
            $0.setup?.choose(model: "opus")
            $0.setup?.effort = "high"
            $0.setup?.bypass = true
            return $0.primary()
        }
        try await check("setup with no model list") { $0.primary() }
    }

    func testPermissionShellHoldAndTerminalAnswerTheirTwoButtons() async throws {
        try await check("permission allow") { $0.primary() }
        try await check("permission deny") { $0.secondary() }
        try await check("shell run") { $0.primary() }
        try await check("shell do not run") { $0.secondary() }
        try await check("hold send") { $0.primary() }
        try await check("hold do not send") { $0.secondary() }
        try await check("terminal go") { $0.primary() }
        try await check("terminal cancel") { $0.secondary() }
    }

    func testAQuestionAnswersByItsTextAndSkips() async throws {
        try await check("question single") {
            $0.pick(question: 0, "b")
            $0.pick(question: 1, "x")
            return $0.primary()
        }
        try await check("question other and multi") {
            $0.setOther(question: 0, "something else")
            $0.pick(question: 1, "x")
            $0.pick(question: 1, "y")
            $0.setOther(question: 1, "and more")
            return $0.primary()
        }
        try await check("question skip") { $0.secondary() }
    }

    func testAQuestionIsAnsweredOnceEveryQuestionHasAnAnswer() throws {
        let (card, _, _) = makeCard(try fixture("question single").request)
        XCTAssertEqual(card.controls?.primary, RequestControl(title: "Answer", enabled: false))
        XCTAssertEqual(card.controls?.secondary, RequestControl(title: "Skip", enabled: true))
        card.pick(question: 0, "a")
        XCTAssertEqual(card.controls?.primary.enabled, false, "one of two")
        card.pick(question: 1, "x")
        XCTAssertEqual(card.controls?.primary.enabled, true)
        card.pick(question: 1, "x") // a single choice picked again stays picked
        XCTAssertEqual(card.controls?.primary.enabled, true)
        card.setOther(question: 1, "   ")
        XCTAssertEqual(card.controls?.primary.enabled, true, "blank text is no answer, and does not replace the choice")
        card.pick(question: 0, "b")
        card.setOther(question: 0, "own")
        card.pick(question: 0, "a")
        XCTAssertEqual(card.questions[0].other, "", "a choice made after Other's text replaces it")
    }

    func testTheControlsOfEachTypeAndTheirNames() throws {
        let titles: [(String, String, String?)] = [
            ("setup untouched", "Start", nil), ("permission allow", "Allow", "Deny"), ("question single", "Answer", "Skip"), ("shell run", "Run", "Don\u{2019}t run"),
            ("hold send", "Send anyway", "Don\u{2019}t send"), ("terminal go", "Go", "Cancel"),
        ]
        for (name, first, second) in titles {
            let (card, _, _) = makeCard(try fixture(name).request)
            XCTAssertEqual(card.controls?.primary.title, first, name)
            XCTAssertEqual(card.controls?.secondary?.title, second, name)
        }
    }

    // MARK: a command's permission (#137)

    /// A permission that asks to run a command draws the command, not the input's JSON; any other permission keeps its input.
    func testACommandsPermissionShowsTheCommandAndAnyOtherKeepsItsInput() {
        let bash: [String: Any] = ["type": "permission", "toolName": "Bash", "input": ["command": "rm logs/old.log", "description": "Delete old log"],
                                   "title": "Bash: rm logs/old.log", "description": "Delete old log", "plan": NSNull()]
        XCTAssertEqual(makeCard(bash).0.command, "rm logs/old.log")
        XCTAssertNil(makeCard(permission).0.command, "an edit has no command: its input is drawn as before")
        var planned = bash
        planned["plan"] = "1. delete the log"
        XCTAssertNil(makeCard(planned).0.command, "a plan is drawn in place of the input")
    }

    /// A command folds on two lines with Show full command past two lines or 140 characters; a short one is always whole.
    func testALongCommandFoldsAndAShortOneDoesNot() {
        XCTAssertFalse(RequestCardModel.folds("rm logs/old.log"))
        XCTAssertFalse(RequestCardModel.folds(String(repeating: "a", count: 140)))
        XCTAssertTrue(RequestCardModel.folds(String(repeating: "a", count: 141)))
        XCTAssertFalse(RequestCardModel.folds("one\ntwo"))
        XCTAssertTrue(RequestCardModel.folds("one\ntwo\nthree"))
        XCTAssertFalse(RequestCardModel.folds("one\r\ntwo"))
        XCTAssertTrue(RequestCardModel.folds("one\r\ntwo\r\nthree"), "a CRLF is one Character: lines are counted by isNewline")
    }

    /// A Bash permission; the request's `description` is its own field (the SDK's subtitle), given apart from the input's.
    private func bash(_ input: [String: Any], description: Any = NSNull(), plan: Any = NSNull()) -> [String: Any] {
        ["type": "permission", "toolName": "Bash", "input": input, "title": "Bash", "description": description, "plan": plan]
    }

    /// The input's other fields stay on the card: a sandbox escape or a host the owner allows is never unseen (#137, review row 1).
    func testACommandCardKeepsEveryOtherFieldOfTheInput() throws {
        let (escape, _, _) = makeCard(bash(["command": "ls", "description": "List", "dangerouslyDisableSandbox": true], description: "List"))
        let rest = try XCTUnwrap(escape.otherInput)
        XCTAssertEqual(object(rest.text) as NSDictionary, ["dangerouslyDisableSandbox": true] as NSDictionary)
        XCTAssertFalse(rest.cut)
        let (mcp, _, _) = makeCard(["type": "permission", "toolName": "mcp__x__run", "input": ["command": "ls", "host": "prod.example.com"],
                                    "title": NSNull(), "description": NSNull(), "plan": NSNull()])
        XCTAssertEqual(object(try XCTUnwrap(mcp.otherInput).text) as NSDictionary, ["host": "prod.example.com"] as NSDictionary)
        let (plain, _, _) = makeCard(bash(["command": "ls", "description": "List"], description: "List"))
        XCTAssertNil(plain.otherInput, "a command and the description the card draws: nothing left to draw")
        XCTAssertNil(makeCard(permission).0.otherInput, "an approval without a command draws its whole input as before")
    }

    /// The input's `description` leaves the rest only when it is the string the card draws as the request's description; any other stays, so the
    /// owner never allows what the card does not show (#137, review row 10).
    func testAnInputDescriptionIsDroppedOnlyWhenTheCardDrawsIt() throws {
        func rest(_ input: [String: Any], _ description: Any) throws -> NSDictionary? {
            try makeCard(bash(input, description: description)).0.otherInput.map { object($0.text) as NSDictionary }
        }
        XCTAssertEqual(try rest(["command": "deploy", "description": "SECRET-PAYLOAD"], NSNull()), ["description": "SECRET-PAYLOAD"] as NSDictionary,
                       "no request description: the card draws none")
        XCTAssertEqual(try rest(["command": "deploy", "description": ["target": "PROD-HOST"]], "Run a command"),
                       ["description": ["target": "PROD-HOST"]] as NSDictionary, "not a string")
        XCTAssertEqual(try rest(["command": "deploy", "description": "MODEL-WORDS"], "Claude will have access to ~/Downloads"),
                       ["description": "MODEL-WORDS"] as NSDictionary, "the card draws the request's description, not this one")
        XCTAssertNil(try rest(["command": "deploy", "description": "Deploy it"], "Deploy it"), "equal strings: the card draws it, nothing left")
        XCTAssertEqual(try rest(["command": "deploy", "description": "Deploy it", "host": "prod"], "Deploy it"), ["host": "prod"] as NSDictionary,
                       "equal strings: the rest does not repeat it")
    }

    /// The rest of the input is cut at `limit` until Show all, as any input is.
    func testTheRestOfAnInputIsCutAtTheLimit() throws {
        let (card, _, _) = makeCard(bash(["command": "ls", "stdin": String(repeating: "x", count: 5000)]))
        XCTAssertEqual(try XCTUnwrap(card.otherInput).text.count, RequestCardModel.limit)
        XCTAssertTrue(try XCTUnwrap(card.otherInput).cut)
        card.showAll = true
        XCTAssertGreaterThan(try XCTUnwrap(card.otherInput).text.count, 5000)
    }

    /// The card asks `Allow this command?` only while it asks; once ended it falls back to the title as before (review row 2).
    func testTheCommandHeadingIsForAnOpenCardOnly() {
        let (card, _, s) = makeCard(bash(["command": "ls"]))
        XCTAssertTrue(card.asksCommand)
        deliver(11, mini, ["thread": s.thread, "withdrawn": true], at: 6, re: s.request)
        XCTAssertEqual(card.phase, .ended(.withdrawn))
        XCTAssertFalse(card.asksCommand)
        XCTAssertFalse(makeCard(permission).0.asksCommand)
    }

    /// A folded command gives the view at most `limit` characters, whole after Show full command (review row 4).
    func testAFoldedCommandIsCutAtTheLimit() throws {
        let (card, _, _) = makeCard(bash(["command": String(repeating: "x", count: 10_000)]))
        XCTAssertEqual(card.shownCommand?.count, RequestCardModel.limit)
        XCTAssertTrue(card.commandFolds)
        card.showAll = true
        XCTAssertEqual(card.shownCommand?.count, 10_000)
        let (short, _, _) = makeCard(bash(["command": "ls"]))
        XCTAssertEqual(short.shownCommand, "ls")
        XCTAssertFalse(short.commandFolds)
    }

    /// An empty command is no command: the card draws the input as for any tool (review row 6).
    func testAnEmptyCommandIsNoCommand() {
        let (card, _, _) = makeCard(bash(["command": ""]))
        XCTAssertNil(card.command)
        XCTAssertFalse(card.asksCommand)
    }

    // MARK: one reply, the keys

    func testOneReplyPerCard() async throws {
        let (card, c, s) = makeCard(permission)
        let first = card.primary()
        XCTAssertNotNil(first)
        XCTAssertNil(card.primary(), "a second click does nothing while the first is on its way")
        XCTAssertNil(card.secondary())
        await first?.value
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(c.replyState(s.request), .sending, "bound to its outbox item")
        XCTAssertEqual(card.phase, .sending)
        XCTAssertNil(card.primary(), "still on its way")
        XCTAssertEqual(c.rows().count, 0, "the composer's rows draw prompts and texts, never a reply")
    }

    func testReturnAndEscapeAreTheFirstAndSecondButton() async throws {
        let (card, _, _) = makeCard(permission)
        XCTAssertTrue(card.escapePressed())
        await settle()
        let draft = try XCTUnwrap(sent.first?.1)
        XCTAssertEqual(object(draft.content)["answer"] as? NSDictionary, ["type": "permission", "allow": false])
        let (setup, _, _) = self.makeCard(try fixture("setup untouched").request)
        XCTAssertFalse(setup.escapePressed(), "setup has one button")
        XCTAssertEqual(sent.count, 1)
        let (question, _, _) = self.makeCard(try fixture("question single").request)
        XCTAssertFalse(question.returnPressed(), "Answer is not enabled yet")
        XCTAssertEqual(sent.count, 1)
        XCTAssertTrue(setup.returnPressed())
        XCTAssertFalse(setup.returnPressed(), "a card that sent its reply takes no more keys")
    }

    // MARK: after a reply

    private func reply(_ s: (thread: String, root: MessageRef, request: MessageRef), at: Int = 4) -> MessageRef {
        deliver(10, alice, ["answer": ["type": "permission", "allow": true]], at: at, to: mini, re: s.request)
    }

    func testTheBotsReasonIsDrawnAndTheControlsComeBack() async throws {
        outcome = .queued(name: Data(repeating: 4, count: 16)) // the outbox item is named as the message the reading gives back
        let (card, c, s) = makeCard(permission)
        await card.primary()?.value
        let r = reply(s)
        c.take(items: []) // the outbox lets the item go once it is read back
        XCTAssertEqual(card.phase, .ended(.replied), "read back, no verdict yet")
        deliver(5, mini, ["thread": "", "markdown": "The bot could not take this answer."], at: 5, re: r)
        XCTAssertEqual(card.phase, .asking(notes: ["The bot could not take this answer."]))
        XCTAssertEqual(card.controls?.primary.enabled, true)
        sent = []
        outcome = .queued(name: Data(repeating: 6, count: 16))
        await card.primary()?.value
        XCTAssertEqual(sent.count, 1, "the owner can answer again")
        XCTAssertEqual(card.phase, .sending, "and the old reason is not shown while the new reply is on its way")
    }

    func testAnEmptyVerdictAnswersTheCardAndTheStatusWinsOverAReason() async throws {
        let (card, _, s) = makeCard(permission)
        await card.primary()?.value
        let r = reply(s)
        deliver(5, mini, ["thread": "", "markdown": "No."], at: 5, re: r)
        deliver(11, mini, ["thread": s.thread, "withdrawn": true], at: 6, re: s.request)
        XCTAssertEqual(card.phase, .ended(.withdrawn), "a status other than open wins over a reason")
        deliver(5, mini, ["thread": "", "markdown": ""], at: 7, re: r)
        XCTAssertEqual(card.phase, .ended(.answered))
        XCTAssertNil(card.controls, "an ended card has no controls")
    }

    func testAnAnsweredCardSaysWhatWasAnswered() throws {
        // (fixture, words): the answers the bot takes, each read back as the owner's reply and taken with an empty kind 5.
        let cases: [(String, String)] = [
            ("permission allow", "Allowed"), ("permission deny", "Denied"), ("question single", "Answered: b; x"),
            ("question other and multi", "Answered: something else; x, y, and more"), ("question skip", "Skipped"), ("shell run", "Ran"),
            ("shell do not run", "Not run"), ("hold send", "Sent anyway"), ("hold do not send", "Not sent"), ("terminal go", "Sent here"),
            ("terminal cancel", "Not sent"), ("setup chosen", "Answered"),
        ]
        for (name, words) in cases {
            let f = try fixture(name)
            let (card, _, s) = makeCard(f.request)
            let r = deliver(10, alice, ["answer": f.answer], at: 4, to: mini, re: s.request)
            XCTAssertEqual(card.endedWords, words, "\(name): the reply on its way says it already")
            deliver(5, mini, ["thread": "", "markdown": ""], at: 5, re: r)
            XCTAssertEqual(card.phase, .ended(.answered), name)
            XCTAssertEqual(card.endedWords, words, name)
        }
    }

    func testAnEndedPermissionHasItsVerdictAndTheCommandItAsked() async throws {
        let bash: [String: Any] = ["type": "permission", "toolName": "Bash", "input": ["command": "mkdir deny-test"], "title": NSNull(), "description": NSNull(), "plan": NSNull()]
        for (allow, verdict) in [(true, true), (false, false)] {
            let (card, _, s) = makeCard(bash)
            XCTAssertNil(card.verdict, "a card that waits has none")
            XCTAssertEqual(card.subject, "mkdir deny-test")
            let r = deliver(10, alice, ["answer": ["type": "permission", "allow": allow]], at: 4, to: mini, re: s.request)
            deliver(5, mini, ["thread": "", "markdown": ""], at: 5, re: r)
            XCTAssertEqual(card.verdict, verdict)
        }
        let (edit, _, _) = makeCard(permission)
        XCTAssertEqual(edit.subject, "a.md", "the file when there is no command")
        let (terminal, _, _) = makeCard(["type": "terminal", "state": "open", "running": NSNull(), "command": "claude --resume 7f3a9c"])
        XCTAssertNil(terminal.verdict)
        XCTAssertNil(terminal.subject)
    }

    func testAPermissionsFileIsWrittenFromTheChannelsFolder() {
        let input = String(decoding: try! JSONSerialization.data(withJSONObject: ["file_path": "/srv/example/project/src/a.md"]), as: UTF8.self)
        XCTAssertEqual(RequestCardModel.subject(ofInput: input, folder: "/srv/example/project"), "src/a.md")
        XCTAssertEqual(RequestCardModel.subject(ofInput: input, folder: nil), "/srv/example/project/src/a.md")
        let command = String(decoding: try! JSONSerialization.data(withJSONObject: ["command": "ls /srv/example/project/src"]), as: UTF8.self)
        XCTAssertEqual(RequestCardModel.subject(ofInput: command, folder: "/srv/example/project"), "ls /srv/example/project/src", "a command is no path")
    }

    func testARefusedReplyIsNotTheAnswer() throws {
        let (card, _, s) = makeCard(permission)
        let r = deliver(10, alice, ["answer": ["type": "permission", "allow": true]], at: 4, to: mini, re: s.request)
        deliver(5, mini, ["thread": "", "markdown": "No."], at: 5, re: r)
        deliver(11, mini, ["thread": s.thread, "answered": true], at: 6, re: s.request)
        XCTAssertEqual(card.phase, .ended(.answered))
        XCTAssertEqual(card.endedWords, "Answered", "the bot took no reply of the owner's: its answer came from elsewhere")
    }

    func testARefusedReplyIsNotTheAnswerWhateverCameFirst() throws {
        let (card, _, s) = makeCard(permission)
        let r = deliver(10, alice, ["answer": ["type": "permission", "allow": true]], at: 4, to: mini, re: s.request)
        deliver(11, mini, ["thread": s.thread, "answered": true], at: 5, re: s.request)
        XCTAssertEqual(card.endedWords, "Answered", "answered elsewhere before the bot took the owner's reply")
        deliver(5, mini, ["thread": "", "markdown": "No."], at: 6, re: r)
        XCTAssertEqual(card.phase, .ended(.answered))
        XCTAssertEqual(card.endedWords, "Answered", "the refused reply is not what was answered")
    }

    func testNotSentAndNotDeliveredShowAndTheControlsComeBack() async throws {
        outcome = .ended
        let (card, c, s) = makeCard(permission)
        await card.primary()?.value
        XCTAssertEqual(card.phase, .asking(notes: ["Not sent.", "Pardner is not connected. Try again in a moment."]))
        XCTAssertEqual(card.controls?.primary.enabled, true)
        outcome = .queued(name: Data(repeating: 0xE2, count: 16))
        await card.primary()?.value
        XCTAssertEqual(card.phase, .sending, "the failed attempt's note goes with the next one")
        var state = ChannelsState()
        let content = "{\"answer\":{\"allow\":true,\"type\":\"permission\"}}"
        state.outboxes[channel] = [OutboxItemRow(name: Data(repeating: 0xE2, count: 16), kind: 10, to: mini, re: MessageReference(device: s.request.device, name: s.request.name),
                                                 content: content, state: .refused)]
        c.take(items: state.outboxes[channel]!)
        XCTAssertEqual(card.phase, .asking(notes: ["Not delivered."]))
        outcome = .queued(name: Data(repeating: 0xE3, count: 16))
        await card.primary()?.value
        XCTAssertEqual(card.phase, .sending)
    }

    func testAReplyInTheOutboxAfterARestartShowsSending() throws {
        let (card, c, s) = makeCard(permission)
        let item = OutboxItemRow(name: Data(repeating: 0xE4, count: 16), kind: 10, to: mini, re: MessageReference(device: s.request.device, name: s.request.name),
                                 content: "{\"answer\":{\"allow\":true,\"type\":\"permission\"}}", state: .waiting)
        c.take(items: [item])
        XCTAssertEqual(card.phase, .sending)
        XCTAssertNil(card.primary())
        XCTAssertEqual(c.rows().count, 0)
        c.take(items: []) // read back: the outbox lets it go
        XCTAssertEqual(card.phase, .asking(notes: []))
    }

    func testNoControlsWhenTheBotIsRemoved() throws {
        let s = session(permission)
        let c = composer(s.thread, devices: devices(botActive: false))
        let card = c.card(for: conversation.reading.channels[channel]!.messages.last!)
        XCTAssertNil(card.controls)
        XCTAssertNil(card.primary())
        XCTAssertFalse(card.returnPressed())
    }

    func testAnUnreadableRequestHasNoControls() {
        let (card, _, _) = makeCard(["type": "something new"])
        XCTAssertNil(card.owner)
        XCTAssertNil(card.controls)
    }

    // MARK: what a card draws

    func testAnInputPastFourThousandCharactersIsCutUntilShowAll() throws {
        let (card, _, _) = makeCard(["type": "permission", "toolName": "Write", "input": ["content": String(repeating: "x", count: 5000)], "title": NSNull(), "description": NSNull(), "plan": NSNull()])
        let cut = try XCTUnwrap(card.shownText)
        XCTAssertEqual(cut.text.count, 4000)
        XCTAssertTrue(cut.cut)
        card.showAll = true
        XCTAssertGreaterThan(card.shownText?.text.count ?? 0, 5000)
        XCTAssertEqual(card.shownText?.cut, false)
        let (short, _, _) = self.makeCard(permission)
        XCTAssertEqual(short.shownText?.cut, false)
        let (plan, _, _) = self.makeCard(["type": "permission", "toolName": "ExitPlanMode", "input": [:], "title": NSNull(), "description": NSNull(), "plan": "1. Do it"])
        XCTAssertEqual(plan.shownText?.text, "1. Do it", "a plan approval draws the plan in place of the input")
    }

    func testChoosingTheDefaultEntryKeepsDefaultAndAStalePresetEffortGoesBack() throws {
        var s = SetupChoice(try setup("setup untouched"))
        s.choose(model: "haiku")
        s.choose(model: "sonnet") // the entry that stands for the default
        XCTAssertEqual(s.model, "default")
        var stale = try fixture("setup untouched").request
        stale["selection"] = ["model": "haiku", "effort": "high", "bypass": false]
        let body = String(decoding: try JSONSerialization.data(withJSONObject: ["thread": "t", "request": stale, "title": "x"]), as: UTF8.self)
        guard case .setup(let request)? = OwnerRequest(json: body) else { return XCTFail("no setup") }
        XCTAssertEqual(SetupChoice(request).effort, "default", "an effort the preset model lacks is Default")
    }

    func testAKeyInAChildFieldIsNoKeyOfTheCard() async throws {
        let (card, _, _) = makeCard(permission)
        XCTAssertFalse(card.returnPressed(fieldFocused: true))
        XCTAssertFalse(card.escapePressed(fieldFocused: true))
        XCTAssertTrue(sent.isEmpty)
    }

    func testAReplyReadBackBeforeTheOutboxListedItStillLetsAReasonShow() async throws {
        outcome = .queued(name: Data(repeating: 4, count: 16))
        let (card, c, s) = makeCard(permission)
        await card.primary()?.value
        let r = reply(s) // no outbox listing between: the entry was never marked seen
        XCTAssertEqual(card.phase, .ended(.replied))
        deliver(5, mini, ["thread": "", "markdown": "The bot could not take this answer."], at: 5, re: r)
        XCTAssertEqual(card.phase, .asking(notes: ["The bot could not take this answer."]))
        XCTAssertNil(c.replyState(s.request))
    }

    func testSetupControlsFollowTheModelListAndTheEffortsItTakes() throws {
        var s = SetupChoice(try setup("setup untouched"))
        XCTAssertEqual(s.modelOptions.map(\.name), ["Sonnet", "Haiku"])
        XCTAssertEqual(s.shownModel, "sonnet", "`default` is the entry that stands for the default")
        XCTAssertEqual(s.effortOptions, ["default", "low", "high"])
        s.choose(model: "haiku")
        XCTAssertEqual(s.effortOptions, [], "a model without effort hides the control")
        s.choose(model: "sonnet")
        s.effort = "high"
        s.choose(model: "haiku")
        XCTAssertEqual(s.effort, "default", "an effort the new model lacks goes back to Default")
        let none = SetupChoice(try setup("setup with no model list"))
        XCTAssertTrue(none.modelOptions.isEmpty, "Model is hidden")
        XCTAssertEqual(none.effortOptions, ["default", "medium"], "the request's levels when no model is listed")
        var flat = try fixture("setup untouched").request
        flat["models"] = (flat["models"] as! [[String: Any]]).map { $0.merging(["isDefault": false]) { _, new in new } }
        let body = String(decoding: try JSONSerialization.data(withJSONObject: ["thread": "t", "request": flat, "title": "x"]), as: UTF8.self)
        guard case .setup(let unflagged)? = OwnerRequest(json: body) else { return XCTFail("no setup") }
        XCTAssertEqual(SetupChoice(unflagged).modelOptions.map(\.name), ["Default", "Sonnet", "Haiku"], "a leading Default when no entry stands for it")
    }

    private func setup(_ name: String) throws -> SetupRequest {
        let body: [String: Any] = ["thread": "t", "request": try fixture(name).request, "title": "x"]
        guard case .setup(let s)? = OwnerRequest(json: String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)) else { throw XCTSkip("no setup") }
        return s
    }

    // MARK: Stop and the mode menu

    func testStopSendsItsWordAsAPromptWithoutTouchingTheDraft() async throws {
        let s = session(permission)
        let c = composer(s.thread)
        c.edited("a draft in progress")
        let task = c.command("/stop")
        XCTAssertNotNil(task)
        XCTAssertEqual(c.text, "a draft in progress")
        await task?.value
        let draft = try XCTUnwrap(sent.first?.1)
        XCTAssertEqual([draft.kind, draft.to == mini ? 1 : 0], [2, 1])
        XCTAssertEqual(object(draft.content) as NSDictionary, ["text": "/stop", "thread": s.thread, "control": true])
        outcome = .ended
        await c.command("/plan on")?.value
        XCTAssertEqual(c.text, "a draft in progress", "a command that was not sent leaves the draft where it was")
        XCTAssertEqual(c.rows().last?.status, .notSent("Pardner is not connected. Try again in a moment."), "a control that failed shows its failure")
    }

    func testTheBodiesTheAppBuildsForItsControlsAreTheSharedFixturesBytes() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/protocol/content-vectors/control-content.json")
        let file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        for c in try XCTUnwrap(file["cases"] as? [[String: Any]]) where c["appBuilt"] as? Bool == true {
            let content = try XCTUnwrap(c["content"] as? [String: Any])
            let built = ComposerModel.body(prompt: true, text: try XCTUnwrap(content["text"] as? String), thread: content["thread"] as? String, control: true)
            XCTAssertEqual(object(built) as NSDictionary, content as NSDictionary, c["name"] as? String ?? "?")
        }
    }

    func testATypedSlashWordStaysAVisibleDraftWithoutTheFlag() async throws {
        let s = session(permission)
        let c = composer(s.thread)
        c.edited("/stop")
        let task = c.submit()
        await task?.value
        let draft = try XCTUnwrap(sent.first?.1)
        XCTAssertEqual(object(draft.content) as NSDictionary, ["text": "/stop", "thread": s.thread])
    }

    func testAControlThatIsOnItsWayShowsNoPendingRow() async {
        let s = session(permission)
        let c = composer(s.thread)
        let task = c.command("/stop")
        XCTAssertEqual(c.rows(), [], "while the call is in flight")
        await task?.value
        XCTAssertEqual(c.rows(), [], "while the relay holds it")
    }

    func testTheModeMenuSendsItsFourWords() async throws {
        let s = session(permission)
        let c = composer(s.thread)
        for word in ["/bypass on", "/bypass off", "/plan on", "/plan off"] { await c.command(word)?.value }
        XCTAssertEqual(sent.map { object($0.1.content)["text"] as? String }, ["/bypass on", "/bypass off", "/plan on", "/plan off"])
        XCTAssertEqual(Set(sent.map { object($0.1.content)["thread"] as? String }), [s.thread])
    }

    func testStopIsOfferedOnlyForASessionOfAnActiveBot() {
        let s = session(permission)
        XCTAssertTrue(composer(s.thread).canCommand)
        XCTAssertFalse(composer(s.thread, devices: devices(botActive: false)).canCommand)
        XCTAssertNil(composer(s.thread, devices: devices(botActive: false)).command("/stop"))
        let channelComposer = ComposerModel(channel: channel, thread: nil, conversation: conversation, devices: devices()) { _, _ in .ended }
        XCTAssertFalse(channelComposer.canCommand, "a command goes to a session's bot")
    }

    // MARK: The session's activity row

    func testTheActivityRowSaysWorkingWhileRunningAndWaitingForYouWhileWaitingAndNothingIdle() {
        XCTAssertEqual(Naming.activityWords(.running, tasks: 0), "Working…")
        XCTAssertEqual(Naming.activityWords(.waiting, tasks: 0), "Waiting for you")
        XCTAssertNil(Naming.activityWords(.idle, tasks: 0))
    }

    func testTheActivityRowCountsTheTasksThatRunAndWaitingForYouWinsOverTheCount() {
        XCTAssertEqual(Naming.activityWords(.running, tasks: 1), "Working · 1 task running")
        XCTAssertEqual(Naming.activityWords(.running, tasks: 3), "Working · 3 tasks running")
        XCTAssertEqual(Naming.activityWords(.waiting, tasks: 3), "Waiting for you")
    }

    @MainActor
    func testTheListOfTasksNamesEachByItsAgentTaskElseItsTitleOldestFirstAndDrawsOneRowEach() throws {
        let s = session(permission)
        func task(_ title: String, agent: String?, at: Int) {
            var body: [String: Any] = ["title": title, "status": "in_progress", "task": true, "startedAt": 1_700_000_000_000]
            body["agent"] = agent
            deliver(1, mini, ["thread": s.thread, "say": "task", "task": body], at: at, re: s.root)
        }
        task("Agent(look)", agent: "look at the tests", at: 4)
        task("Run: make test", agent: nil, at: 5)
        let thread = try XCTUnwrap(conversation.reading.channels[channel]?.sessions.first { $0.key == s.thread })
        let tasks = thread.openLines.filter(\.fields.task)
        XCTAssertEqual(tasks.map { Naming.taskName($0.fields) }, ["look at the tests", "Run: make test"])
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(Naming.runningWords(since: tasks[0].fields.startedAt, now: start.addingTimeInterval(65)), "Running · 1m 05s")
        XCTAssertEqual(Naming.runningWords(since: nil, now: start), "Running")
        let one = ImageRenderer(content: TaskList(tasks: Array(tasks.prefix(1))) { _ in }).nsImage?.size.height ?? 0
        let two = ImageRenderer(content: TaskList(tasks: tasks) { _ in }).nsImage?.size.height ?? 0
        XCTAssertGreaterThan(one, 20)
        XCTAssertGreaterThan(two, one * 1.5, "one row each")
    }

    @MainActor
    func testTheActivityRowIsDrawnOnlyWhileTheSessionIsNotIdle() throws {
        let s = session(permission)
        let thread = try XCTUnwrap(conversation.reading.channels[channel]?.sessions.first { $0.key == s.thread })
        XCTAssertEqual(thread.state, .waiting, "an open request makes the session wait")
        func height(_ state: SessionState) throws -> CGFloat {
            let row = ActivityRow(model: conversation.reading, icons: [:], bot: mini, state: state, tasks: [], composer: composer(s.thread)) { _ in }
            return ImageRenderer(content: row).nsImage?.size.height ?? 0
        }
        XCTAssertGreaterThan(try height(.running), 20)
        XCTAssertGreaterThan(try height(.waiting), 20)
        XCTAssertEqual(try height(.idle), 0)
    }
}
