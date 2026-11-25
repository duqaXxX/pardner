// The file window's states, the link on a call's line, the click's prompt and how a file's bytes are drawn (file-content design, 3.3 and 3.7).
@testable import Conversation
import Foundation
import ProtocolHost
@testable import Relay
@testable import Screens
import XCTest

/// Holds a send until the test opens it.
@MainActor
private final class Gate {
    private var waiter: CheckedContinuation<Void, Never>?
    private var opened = false
    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func open() {
        opened = true
        waiter?.resume()
        waiter = nil
    }
}

/// What a `@Sendable` fetch stand-in counts and hands out.
private final class Script: @unchecked Sendable {
    private let lock = NSLock()
    private var outcomes: [FetchOutcome]
    private let delay: Duration
    private(set) var calls = 0
    init(_ outcomes: [FetchOutcome], delay: Duration = .zero) { (self.outcomes, self.delay) = (outcomes, delay) }
    private func take() -> FetchOutcome {
        lock.lock(); defer { lock.unlock() }
        calls += 1
        return outcomes.isEmpty ? .gone : outcomes.removeFirst()
    }

    func next() async -> FetchOutcome {
        let outcome = take()
        if delay > .zero { try? await Task.sleep(for: delay) }
        return outcome
    }
}

@MainActor
final class FileOpenerTests: XCTestCase {
    private static func id(_ byte: UInt8) -> Data { Data(repeating: byte, count: 32) }
    private let channel = id(0x3F), app = id(1), mini = id(2), removed = id(4), bobs = id(9)
    private var sent: [(Data, OutboxDraft)] = []

    private let content = FileWindowContent(channel: id(0x3F), thread: "t", bot: id(2), source: .path("/work/notes.md"))
    private let info = FileInfo(blob: Data(repeating: 7, count: 32), size: 2048, type: "application/octet-stream", name: "notes.md")
    private let readAt = Date(timeIntervalSince1970: 1_700_000_000)

    private func devices() -> DevicesModel {
        var s = DevicesState()
        func row(_ b: UInt8, _ kind: DeviceKind, _ active: Bool) -> DeviceRow {
            DeviceRow(id: Self.id(b), kind: kind, label: nil, shortForm: "", adder: .none, position: Int(b), active: active, isThisMac: kind == .app, seenAt: nil,
                      onlyHolderEpochs: 0, addedWhileRemoving: false)
        }
        s.rows = [row(1, .app, true), row(2, .bot, true), row(4, .bot, false)]
        return DevicesModel(state: s)
    }

    private func opener(outcome: SendOutcome = .queued(name: Data(repeating: 0xE1, count: 16)), reading: ReadingModel = ReadingModel()) -> FileOpener {
        FileOpener(conversation: ConversationModel(reading: reading), devices: devices(), send: { [self] channel, draft in
            sent.append((channel, draft))
            return outcome
        }, fetch: { _, _ in .gone })
    }

    private func line(_ status: LineStatus, path: String? = "/work/notes.md") throws -> WorkLine {
        var t: [String: Any] = ["title": "Read(notes.md)", "status": status.rawValue]
        if let path { t["path"] = path }
        let fields = try XCTUnwrap(LineFields(t))
        return WorkLine(ref: MessageRef(device: mini, name: Data(repeating: 5, count: 16)), position: 5, time: readAt, prompt: nil, fields: fields)
    }

    func testTheLinkIsOnACompleteLineOfTheViewersOwnBotAlone() throws {
        XCTAssertEqual(FileStates.path(of: try line(.complete), ownBot: true), "/work/notes.md")
        XCTAssertNil(FileStates.path(of: try line(.complete), ownBot: false), "another person's bot: text")
        for status in [LineStatus.inProgress, .pending, .error] { XCTAssertNil(FileStates.path(of: try line(status), ownBot: true), "\(status)") }
        XCTAssertNil(FileStates.path(of: try line(.complete, path: nil), ownBot: true), "no file")
        let o = opener()
        XCTAssertEqual(o.link(for: try line(.complete)), "/work/notes.md", "the line's bot is one of the person's devices")
        XCTAssertTrue(o.isOwnBot(mini))
        XCTAssertFalse(o.isOwnBot(removed), "a removed bot cannot answer")
        XCTAssertFalse(o.isOwnBot(bobs))
    }

    func testAClickSendsAnOpenPromptToTheBotInTheThread() async throws {
        let o = opener()
        await o.open(content).value
        let (to, draft) = try XCTUnwrap(sent.first)
        XCTAssertEqual(to, channel)
        XCTAssertEqual(draft.kind, 2)
        XCTAssertEqual(draft.to, mini)
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(draft.content.utf8)) as? [String: Any])
        XCTAssertEqual(fields["text"] as? String, "/open /work/notes.md")
        XCTAssertEqual(fields["thread"] as? String, "t")
        XCTAssertEqual(fields["open"] as? Bool, true)
        let showing = try XCTUnwrap(o.showing(of: content))
        o.close(content, showing: showing + 1)
        XCTAssertNotNil(o.showing(of: content), "a close of another showing ends nothing")
        o.close(content, showing: showing)
        XCTAssertNil(o.showing(of: content))
    }

    func testAClickThatCouldNotBeSentSaysSo() async {
        let o = opener(outcome: .refused("fault"))
        await o.open(content).value
        guard case .message(let words) = o.state(of: content) else { return XCTFail("no message") }
        XCTAssertEqual(words, FileWords.notSent)
    }

    func testEachStateOfTheTableReadsAsItsWords() {
        func state(_ answer: OpenAnswer?, fetch: FileFetch = .idle, lineEnd: Date? = nil) -> FileState {
            FileStates.state(content, answer: answer, fetch: fetch, bot: "Mini", lineEnd: lineEnd, notSent: false)
        }
        guard case .waiting("Mini") = state(nil), case .waiting = state(.sent), case .waiting = state(.started) else { return XCTFail("waiting") }
        guard case .message("Mini restarted before sending the file. Click the path again.") = state(.cut) else { return XCTFail("cut") }
        guard case .message("That file is empty.") = state(.refused("That file is empty.")) else { return XCTFail("refusal") }
        let file = OpenAnswer.file(info, modified: readAt, at: readAt, position: 9)
        guard case .opening("notes.md") = state(file), case .opening = state(file, fetch: .loading(stamp: 9)) else { return XCTFail("opening") }
        guard case .opening = state(file, fetch: .done(stamp: 4, .other)) else { return XCTFail("an older answer's bytes are not this one's") }
        guard case .unreadable = state(file, fetch: .failed(stamp: 9)) else { return XCTFail("failed") }
        guard case .file(let shown) = state(file, fetch: .done(stamp: 9, .text("A"))) else { return XCTFail("file") }
        XCTAssertEqual([shown.title, shown.name, shown.type], ["/work/notes.md", "notes.md", "application/octet-stream"])
        XCTAssertEqual(shown.size, 2048)
        XCTAssertEqual(shown.readAt, readAt)
        XCTAssertNil(shown.changed, "no line end known")
    }

    func testTheChangeNoteComesOnlyWhenTheFileChangedAfterTheLineEnded() {
        func changed(modified: Date, lineEnd: Date?) -> Date? {
            let answer = OpenAnswer.file(info, modified: modified, at: readAt, position: 9)
            guard case .file(let shown) = FileStates.state(content, answer: answer, fetch: .done(stamp: 9, .other), bot: "Mini", lineEnd: lineEnd, notSent: false) else { return nil }
            return shown.changed
        }
        let end = Date(timeIntervalSince1970: 1_700_000_100)
        XCTAssertEqual(changed(modified: end.addingTimeInterval(60), lineEnd: end), end.addingTimeInterval(60))
        XCTAssertNil(changed(modified: end.addingTimeInterval(-60), lineEnd: end))
        XCTAssertNil(changed(modified: end, lineEnd: end))
    }

    func testAFileRowOpensOnItsOwnBlobWithNoPrompt() async {
        let row = FileWindowContent(channel: channel, thread: "t", bot: mini, source: .sent(blob: info.blob, name: "notes.md", size: 2048, type: "x", at: readAt))
        let o = opener()
        await o.open(row).value
        XCTAssertTrue(sent.isEmpty)
        guard case .opening("notes.md") = o.state(of: row) else { return XCTFail("opening") }
        await o.fetchWanted(row)
        guard case .unreadable = o.state(of: row) else { return XCTFail("a blob the relay lacks") }
    }

    func testALateCloseOfAnEarlierShowingEndsNothingAfterAReClick() async throws {
        let o = opener()
        await o.open(content).value
        let old = try XCTUnwrap(o.showing(of: content))
        await o.open(content).value
        o.close(content, showing: old)
        XCTAssertNotNil(o.showing(of: content), "the earlier window's late close does not end the new showing")
    }

    func testAFileRowReClickedWhileItLoadsStartsNoSecondDownload() async {
        let row = FileWindowContent(channel: channel, thread: "t", bot: mini, source: .sent(blob: info.blob, name: "a.md", size: 1, type: "x", at: readAt))
        let script = Script([.file(Data("x".utf8))], delay: .milliseconds(300))
        let o = FileOpener(conversation: ConversationModel(), devices: devices(), send: { _, _ in .ended }, fetch: { _, _ in await script.next() })
        await o.open(row).value
        let first = Task { await o.fetchWanted(row) }
        try? await Task.sleep(for: .milliseconds(50))
        await o.open(row).value
        let second = Task { await o.fetchWanted(row) }
        await first.value
        await second.value
        XCTAssertEqual(script.calls, 1)
        guard case .file = o.state(of: row) else { return XCTFail("the first download lands") }
    }

    func testTheLatestClicksSendIsTheOneThatCounts() async throws {
        let first = Data(repeating: 0xA1, count: 16), second = Data(repeating: 0xB2, count: 16)
        let gate = Gate()
        let started = expectation(description: "the first send is in flight")
        var calls = 0
        let o = FileOpener(conversation: ConversationModel(), devices: devices(), send: { _, _ in
            calls += 1
            guard calls == 1 else { return .queued(name: second) }
            started.fulfill()
            await gate.wait() // the first click's send answers only when the test says so
            return .queued(name: first)
        }, fetch: { _, _ in .gone })
        let slow = o.open(content)
        await fulfillment(of: [started], timeout: 5)
        await o.open(content).value
        XCTAssertEqual(o.promptName(of: content), second)
        gate.open()
        await slow.value
        XCTAssertEqual(o.promptName(of: content), second, "the first click's late answer does not replace the second's")
    }

    func testTheRefusedNamesAreKeptOnlyWhileASendIsInFlight() async {
        let row = OutboxItemRow(name: Data(repeating: 0xE9, count: 16), kind: 1, to: nil, re: nil, content: "{}", state: .refused)
        let gate = Gate()
        let started = expectation(description: "a send is in flight")
        let o = FileOpener(conversation: ConversationModel(), devices: devices(), send: { _, _ in
            started.fulfill()
            await gate.wait()
            return .queued(name: Data(repeating: 0xE1, count: 16))
        }, fetch: { _, _ in .gone })
        o.take(undelivered: [channel: [row]])
        XCTAssertEqual(o.refusedKept, 0, "no send in flight: nothing to match it with")
        let click = o.open(content)
        await fulfillment(of: [started], timeout: 5)
        o.take(undelivered: [channel: [row]])
        XCTAssertEqual(o.refusedKept, 1)
        gate.open()
        await click.value
        XCTAssertEqual(o.refusedKept, 0, "dropped once its send has checked it")
    }

    func testAnAnswerReadAtANewPositionStartsOneMoreFetchAtMostAndTheOldOneIsNeverWrittenOver() async throws {
        var m = ReadingModel()
        m.setOwnDevices([app])
        let root = MessageRef(device: app, name: Data(repeating: 1, count: 16)), click = MessageRef(device: app, name: Data(repeating: 3, count: 16))
        let file: HostValue = .object(["blob": .bytes(info.blob), "size": .number(3), "type": .string("x"), "name": .string("notes.txt")])
        func view(_ kind: Int, _ sender: Data, _ json: [String: Any], at: Int, to: Data? = nil, re: MessageRef? = nil, files: [HostValue] = []) -> HostValue {
            .object([
                "do": .string("message"), "position": .number(Double(at)), "channel": .bytes(channel), "sender": .bytes(sender),
                "name": .bytes(Data(repeating: UInt8(at), count: 16)), "epoch": .bytes(Data(repeating: 9, count: 32)),
                "time": .number(1_700_000_000_000 + Double(at) * 1000), "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null,
                "blobs": .array([]), "files": .array(files), "again": .bool(false),
                "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null,
                "text": .string(String(decoding: try! JSONSerialization.data(withJSONObject: json), as: UTF8.self)),
            ])
        }
        m.take(views: [view(2, app, ["text": "go"], at: 1, to: mini), view(3, mini, [:], at: 2, re: root),
                       view(2, app, ["thread": root.hex, "text": "/open /a.txt", "open": true], at: 3, to: mini),
                       view(5, mini, ["thread": root.hex, "markdown": ""], at: 4, re: click, files: [file])])
        let model = ConversationModel(reading: m)
        let script = Script([.file(Data("old".utf8)), .file(Data("new".utf8))], delay: .milliseconds(120))
        let o = FileOpener(conversation: model, devices: devices(), send: { _, _ in .queued(name: click.name) }, fetch: { _, _ in await script.next() })
        let content = FileWindowContent(channel: channel, thread: root.hex, bot: mini, source: .path("/a.txt"))
        await o.open(content).value
        let first = Task { await o.fetchWanted(content) }
        try await Task.sleep(for: .milliseconds(30))
        model.apply(.delivered(view(5, mini, ["thread": root.hex, "markdown": ""], at: 6, re: click, files: [file]))) // the history read again: the answer at a new place
        let second = Task { await o.fetchWanted(content) }
        await first.value
        await second.value
        XCTAssertEqual(script.calls, 2, "one more fetch, not a third")
        guard case .file(let shown) = o.state(of: content) else { return XCTFail("file") }
        XCTAssertEqual(shown.content, .text("new"), "the older download did not write over the newer")
    }

    func testAClickTheRelayRefusedSaysSoWhetherItIsToldBeforeOrAfterItsName() async throws {
        let name = Data(repeating: 0xE1, count: 16)
        let row = OutboxItemRow(name: name, kind: 2, to: mini, re: nil, content: "{}", state: .refused)
        let after = opener()
        await after.open(content).value
        after.take(undelivered: [channel: [row]])
        guard case .message(let words) = after.state(of: content) else { return XCTFail("after") }
        XCTAssertEqual(words, FileWords.notSent)
        let gate = Gate()
        let started = expectation(description: "the send is in flight")
        let before = FileOpener(conversation: ConversationModel(), devices: devices(), send: { _, _ in
            started.fulfill()
            await gate.wait()
            return .queued(name: name)
        }, fetch: { _, _ in .gone })
        let click = before.open(content)
        await fulfillment(of: [started], timeout: 5)
        before.take(undelivered: [channel: [row]]) // told before the send returns its name
        gate.open()
        await click.value
        guard case .message = before.state(of: content) else { return XCTFail("before") }
    }

    func testAFetchTheConnectionCouldNotMakeIsAskedAgainAndOnlyGoneIsUnreadable() async {
        let row = FileWindowContent(channel: channel, thread: "t", bot: mini, source: .sent(blob: info.blob, name: "notes.md", size: 3, type: "x", at: readAt))
        let script = Script([.ended, .ended, .file(Data("# hi".utf8))])
        let o = FileOpener(conversation: ConversationModel(), devices: devices(), send: { _, _ in .ended }, fetch: { _, _ in await script.next() })
        o.retryAfter = .milliseconds(1)
        await o.open(row).value
        await o.fetchWanted(row)
        guard case .file(let shown) = o.state(of: row) else { return XCTFail("after two ended fetches") }
        XCTAssertEqual(shown.content, .markdown("# hi"))
        let lost = FileOpener(conversation: ConversationModel(), devices: devices(), send: { _, _ in .ended }, fetch: { _, _ in .gone })
        await lost.open(row).value
        await lost.fetchWanted(row)
        guard case .unreadable = lost.state(of: row) else { return XCTFail("gone") }
        await lost.open(row).value // a re-click asks again
        guard case .opening = lost.state(of: row) else { return XCTFail("a failed file row is asked again on a re-click") }
    }

    func testNothingIsFetchedForASessionThatNoLongerExists() async {
        let script = Script([])
        let o = FileOpener(conversation: ConversationModel(), devices: devices(), send: { _, _ in .ended }, fetch: { _, _ in await script.next() })
        let row = FileWindowContent(channel: channel, thread: "t", bot: mini, source: .sent(blob: info.blob, name: "a", size: 1, type: "x", at: readAt))
        await o.fetchWanted(row)
        XCTAssertEqual(script.calls, 0)
    }

    func testTheClicksLineEndComparesWithTheFilesChangeTime() async throws {
        // A thread of the person's session (the app is one of her devices), a click on a call, and the bot's answer with the file.
        var m = ReadingModel()
        m.setOwnDevices([app])
        func put(_ kind: Int, _ sender: Data, _ json: [String: Any], at: Int, to: Data? = nil, re: MessageRef? = nil, files: [HostValue] = []) -> MessageRef {
            let n = Data(repeating: UInt8(at), count: 16)
            m.take(view: .object([
                "do": .string("message"), "position": .number(Double(at)), "channel": .bytes(channel), "sender": .bytes(sender), "name": .bytes(n),
                "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(1_700_000_000_000 + Double(at) * 1000), "kind": .number(Double(kind)),
                "to": to.map { .bytes($0) } ?? .null, "blobs": .array([]), "files": .array(files), "again": .bool(false),
                "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null,
                "text": .string(String(decoding: try! JSONSerialization.data(withJSONObject: json), as: UTF8.self)),
            ]))
            return MessageRef(device: sender, name: n)
        }
        let root = put(2, app, ["text": "go"], at: 1, to: mini)
        put(3, mini, [:], at: 2, re: root)
        let click = put(2, app, ["thread": root.hex, "text": "/open /work/notes.md", "open": true], at: 3, to: mini)
        let file: HostValue = .object(["blob": .bytes(info.blob), "size": .number(3), "type": .string("x"), "name": .string("notes.md")])
        put(5, mini, ["thread": root.hex, "markdown": "", "modified": 1_700_000_200_000], at: 4, re: click, files: [file])
        let content = FileWindowContent(channel: channel, thread: root.hex, bot: mini, source: .path("/work/notes.md"))
        let o = FileOpener(conversation: ConversationModel(reading: m), devices: devices(), send: { _, _ in .queued(name: click.name) }, fetch: { _, _ in .file(Data("x".utf8)) })
        await o.open(content, lineEnd: Date(timeIntervalSince1970: 1_700_000_100)).value
        await o.fetchWanted(content)
        guard case .file(let shown) = o.state(of: content) else { return XCTFail("file") }
        XCTAssertEqual(shown.changed, Date(timeIntervalSince1970: 1_700_000_200), "changed after the clicked line ended")
        XCTAssertEqual(shown.content, .markdown("x"))
        await o.open(content, lineEnd: Date(timeIntervalSince1970: 1_700_000_300)).value
        await o.fetchWanted(content)
        guard case .file(let again) = o.state(of: content) else { return XCTFail("file again") }
        XCTAssertNil(again.changed, "the latest click's line ended after the change")
    }

    func testTheContentIsMarkdownTextOrOtherByNameAndBytes() {
        XCTAssertEqual(FileContent(name: "README.md", data: Data("# hi".utf8)), .markdown("# hi"))
        XCTAssertEqual(FileContent(name: "a.MARKDOWN", data: Data("x".utf8)), .markdown("x"))
        let long = String(repeating: "a ", count: CodeSpans.most)
        XCTAssertEqual(FileContent(name: "long.md", data: Data(long.utf8)), .text(long), "over what MarkdownView reads: drawn as text")
        XCTAssertEqual(FileContent(name: "main.swift", data: Data("let x = 1".utf8)), .text("let x = 1"))
        XCTAssertEqual(FileContent(name: "notes", data: Data("é".utf8)), .text("é"))
        XCTAssertEqual(FileContent(name: "a.bin", data: Data([0xFF, 0xFE, 0x41])), .other, "not UTF-8")
        XCTAssertEqual(FileContent(name: "a.md", data: Data([0x41, 0x00, 0x42])), .other, "a NUL is no text")
        XCTAssertEqual(FileContent(name: "a.png", data: Data([0x89, 0x50, 0x4E, 0x47])), .other)
    }
}
