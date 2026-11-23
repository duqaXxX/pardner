// A turn's lines as the thread panel draws them (turn work design 2.6, 2.7 and 2.9): the rows of its lazy stack, the diff's tint,
// the words the app owns. Over views shaped as the link delivers them; synthetic content.
import Conversation
import Foundation
import ProtocolHost
@testable import Screens
import XCTest

private struct Session {
    let channel = Data(repeating: 1, count: 32)
    let alice = Data(repeating: 2, count: 32)
    let bot = Data(repeating: 3, count: 32)
    var position = 1
    var model = ReadingModel()
    var prompt: MessageRef!

    init() {
        prompt = put(2, alice, ["text": "go"], to: bot)
        put(3, bot, [:], re: prompt)
    }

    @discardableResult
    mutating func put(_ kind: Int, _ sender: Data, _ body: [String: Any]?, to: Data? = nil, re: MessageRef? = nil) -> MessageRef {
        let at = position
        position += 1
        let name = Data(repeating: UInt8(at), count: 16)
        model.take(view: .object([
            "do": .string("message"), "position": .number(Double(at)), "channel": .bytes(channel), "sender": .bytes(sender),
            "name": .bytes(name), "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(1_700_000_000_000 + Double(at) * 1000),
            "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null, "blobs": .array([]), "files": .array([]),
            "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null,
            "text": body.map { .string(String(decoding: try! JSONSerialization.data(withJSONObject: $0), as: UTF8.self)) } ?? .null, "again": .bool(false),
        ]))
        return MessageRef(device: sender, name: name)
    }

    mutating func line(_ title: String, status: String = "complete", preview: [String: Any]? = nil) {
        put(1, bot, ["thread": prompt.hex, "say": "task", "task": ["title": title, "status": status, "details": NSNull(), "output": NSNull(), "task": false,
                                                                    "message": false, "calls": 0, "preview": preview as Any? ?? NSNull(), "startedAt": NSNull()] as [String: Any]], re: prompt)
    }

    var thread: MessageThread { model.channels[channel]!.threads[prompt.hex]! }
}

final class LineViewsTests: XCTestCase {
    func testADiffOf20000LinesIsOneHeadAndRowsOf200Lines() {
        var s = Session()
        let body = (1...20_000).map { "+🟩 \($0) line" }.joined(separator: "\n")
        s.line("Edit", preview: ["title": "Update(a.txt)", "summary": "Added 20000 lines", "body": body, "language": "diff", "plain": false, "record": false])
        let rows = ThreadRows.build(s.thread)
        XCTAssertEqual(rows.count, 1 + 100)
        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count, "each row has an identity of its own")
        guard case .line = rows[0].content, case .body(_, let last) = rows[100].content else { return XCTFail("a head, then body rows") }
        XCTAssertEqual(last, 99)
        XCTAssertTrue(rows.dropFirst().allSatisfy { $0.time == nil }, "the body rows open no day")
    }

    func testARecordAndALineWithNoPreviewAreOneRow() {
        var s = Session()
        s.line("Run: ls")
        s.line("Asked", preview: ["title": "Asked", "summary": "", "body": "a\nb", "language": "", "plain": true, "record": true])
        XCTAssertEqual(ThreadRows.build(s.thread).count, 2)
    }

    func testTheRowsKeepTheOrderOfTheEntries() {
        var s = Session()
        s.put(4, s.bot, ["thread": s.prompt.hex, "markdown": "Before. "], re: MessageRef(device: s.bot, name: Data(repeating: 0xAA, count: 16)))
        s.line("Run: ls")
        s.put(4, s.bot, ["thread": s.prompt.hex, "markdown": "After."], re: MessageRef(device: s.bot, name: Data(repeating: 0xAA, count: 16)))
        let kinds = ThreadRows.build(s.thread).map { row -> String in
            switch row.content {
            case .segment: "segment"
            case .line: "line"
            default: "other"
            }
        }
        XCTAssertEqual(kinds, ["segment", "line", "segment"])
    }

    func testAnUnreadableRunIsOneRowWithItsCount() {
        var s = Session()
        s.line("Run: ls", status: "in_progress")
        let line = s.thread.items[0]
        guard case .line(let l) = line else { return XCTFail() }
        for _ in 0..<12 { s.put(11, s.bot, nil, re: l.ref) }
        let rows = ThreadRows.build(s.thread)
        XCTAssertEqual(rows.count, 2)
        guard case .unreadable(let count, _) = rows[1].content else { return XCTFail("one counted row") }
        XCTAssertEqual(count, 12)
        XCTAssertEqual(Naming.unreadable(12), "12 messages cannot be read on this device.")
        XCTAssertEqual(Naming.unreadable(1), "This message cannot be read on this device.")
    }

    func testALineIsNoReplyAndTheSegmentsOfOneAnswerAreOne() {
        var s = Session()
        let parts = MessageRef(device: s.bot, name: Data(repeating: 0xAA, count: 16))
        s.put(4, s.bot, ["thread": s.prompt.hex, "markdown": "a"], re: parts)
        s.line("Run: ls")
        s.line("Run: ls")
        s.put(4, s.bot, ["thread": s.prompt.hex, "markdown": "b"], re: parts)
        XCTAssertEqual(s.thread.replies, 1)
    }

    func testAnAddedLineAndARemovedLineAreTintedByTheirFirstCharacter() {
        XCTAssertEqual(DiffTint("+🟩 1 new"), .added)
        XCTAssertEqual(DiffTint("-🟥 1 old"), .removed)
        XCTAssertEqual(DiffTint(" 3 same"), .plain)
        XCTAssertEqual(DiffTint("..."), .plain)
        XCTAssertEqual(DiffTint(""), .plain)
        let text = DiffTint.text("+🟩 1 new\n-🟥 1 old\n 2 same", diff: true)
        XCTAssertEqual(String(text.characters), "+🟩 1 new\n-🟥 1 old\n 2 same")
        let tints = text.runs.map { $0.backgroundColor != nil }
        XCTAssertEqual(tints, [true, true, false])
        XCTAssertTrue(DiffTint.text("+not a diff", diff: false).runs.allSatisfy { $0.backgroundColor == nil })
    }

    func testTheTimeALineHasRunIsCountedLikeTheTerminal() {
        XCTAssertEqual(Naming.elapsed(-3), "0s")
        XCTAssertEqual(Naming.elapsed(12.9), "12s")
        XCTAssertEqual(Naming.elapsed(65), "1m 05s")
        XCTAssertEqual(Naming.elapsed(3725), "1h 02m")
    }

    func testACarriageReturnBeforeTheLineEndKeepsEachLineTinted() {
        let text = DiffTint.text("+a\r\n-b\r\n c", diff: true)
        XCTAssertEqual(text.runs.map { $0.backgroundColor != nil }, [true, true, false])
    }

    func testAnUnreadableRunCountsAsOneReply() {
        var s = Session()
        s.line("Run: ls", status: "in_progress")
        guard case .line(let l) = s.thread.items[0] else { return XCTFail() }
        for _ in 0..<12 { s.put(11, s.bot, nil, re: l.ref) }
        XCTAssertEqual(s.thread.replies, 1)
        XCTAssertNil(Naming.dividerWords(0), "20 lines and no text: the divider carries no count")
        XCTAssertEqual(Naming.dividerWords(1), "1 reply")
    }

    func testALongOutputIsCutAtALineEndWithItsCount() {
        let output = (1...50).map { "e\($0)" }.joined(separator: "\n")
        let cut = LineRow.bounded(output)
        XCTAssertEqual(cut.split(separator: "\n").count, LineRow.outputLines + 1)
        XCTAssertTrue(cut.hasSuffix("… +\(50 - LineRow.outputLines) lines"))
        XCTAssertEqual(LineRow.bounded("short"), "short")
        XCTAssertTrue(LineRow.bounded(String(repeating: "x", count: 100_000)).hasSuffix("…"))
        XCTAssertLessThan(LineRow.bounded(String(repeating: "x", count: 100_000)).count, 10_000)
    }

    func testAMessageBodyIsDrawnWholeInRowsOf200Lines() throws {
        let output = (1...450).map { "m\($0)" }.joined(separator: "\n")
        var s = Session()
        s.put(1, s.bot, ["thread": s.prompt.hex, "say": "task", "task": ["title": "Agent replied", "status": "complete", "details": NSNull(), "output": output, "task": false,
                                                                         "message": true, "calls": 0, "preview": NSNull(), "startedAt": NSNull()] as [String: Any]], re: s.prompt)
        guard case .line(let line) = s.thread.items[0] else { return XCTFail() }
        let rows = LineRow.messageRows(of: line.fields)
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows.joined(separator: "\n"), output, "every line reaches a row")
        s.put(1, s.bot, ["thread": s.prompt.hex, "say": "task", "task": ["title": "Run", "status": "error", "details": NSNull(), "output": "x", "task": false,
                                                                         "message": false, "calls": 0, "preview": NSNull(), "startedAt": NSNull()] as [String: Any]], re: s.prompt)
        guard case .line(let call) = s.thread.items[1] else { return XCTFail() }
        XCTAssertEqual(LineRow.messageRows(of: call.fields), [], "a call's output is no message body")
    }

    func testAFinalLineEndIsNoHiddenLine() {
        let forty = (1...LineRow.outputLines).map { "e\($0)" }.joined(separator: "\n")
        XCTAssertEqual(LineRow.bounded(forty + "\n"), forty)
        XCTAssertTrue(LineRow.bounded(forty + "\nmore\n").hasSuffix("… +1 lines"))
    }
}
