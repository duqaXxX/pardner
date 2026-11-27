// A turn's lines as the thread panel draws them (turn work design 2.6, 2.7 and 2.9): the rows of its lazy stack, the diff's tint,
// the words the app owns. Over views shaped as the link delivers them; synthetic content.
import Conversation
import DesignSystem
import Foundation
import ProtocolHost
@testable import Screens
import SwiftUI
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
        let rows = ThreadRows.build(s.thread, isSystem: { _ in false })
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
        XCTAssertEqual(ThreadRows.build(s.thread, isSystem: { _ in false }).count, 2)
    }

    func testTheRowsKeepTheOrderOfTheEntries() {
        var s = Session()
        s.put(4, s.bot, ["thread": s.prompt.hex, "markdown": "Before. "], re: MessageRef(device: s.bot, name: Data(repeating: 0xAA, count: 16)))
        s.line("Run: ls")
        s.put(4, s.bot, ["thread": s.prompt.hex, "markdown": "After."], re: MessageRef(device: s.bot, name: Data(repeating: 0xAA, count: 16)))
        let kinds = ThreadRows.build(s.thread, isSystem: { _ in false }).map { row -> String in
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
        let rows = ThreadRows.build(s.thread, isSystem: { _ in false })
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
    }

    func testADiffLineLosesItsSquareAndKeepsItsNumberAndItsText() {
        XCTAssertEqual(DiffLine("+🟩  7 new text"), DiffLine(tint: .added, sign: "+", number: " 7", text: "new text"))
        XCTAssertEqual(DiffLine("-🟥 12 old"), DiffLine(tint: .removed, sign: "-", number: "12", text: "old"))
        XCTAssertEqual(DiffLine("    5   indented 7"), DiffLine(tint: .plain, sign: " ", number: "5", text: "  indented 7"), "a context line has two spaces where the square goes")
        XCTAssertEqual(DiffLine("+🟩 6 "), DiffLine(tint: .added, sign: "+", number: "6", text: ""), "an added empty line")
        XCTAssertEqual(DiffLine("+🟩 7 7").text, "7", "the text's own digits stay the text")
    }

    func testALineOfAnotherShapeKeepsAllItsWordsAndNoSign() {
        for row in ["...", "… +3 lines", "+a", "-b", "+🟩 no number", ""] {
            XCTAssertEqual(DiffLine(row).text, row)
            XCTAssertEqual(DiffLine(row).sign, "")
            XCTAssertEqual(DiffLine(row).number, "")
        }
        XCTAssertEqual(DiffLine("+a").tint, .added, "it is still tinted by its first character")
    }

    func testTheTimeALineHasRunIsCountedLikeTheTerminal() {
        XCTAssertEqual(Naming.elapsed(-3), "0s")
        XCTAssertEqual(Naming.elapsed(12.9), "12s")
        XCTAssertEqual(Naming.elapsed(65), "1m 05s")
        XCTAssertEqual(Naming.elapsed(3725), "1h 02m")
    }

    func testACarriageReturnBeforeTheLineEndKeepsEachLineTinted() {
        let lines = "+a\r\n-b\r\n c".components(separatedBy: "\n").map(DiffLine.init)
        XCTAssertEqual(lines.map(\.tint), [.added, .removed, .plain])
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

    func testAFinalLineEndIsNoHiddenLine() {
        let forty = (1...LineRow.outputLines).map { "e\($0)" }.joined(separator: "\n")
        XCTAssertEqual(LineRow.bounded(forty + "\n"), forty)
        XCTAssertTrue(LineRow.bounded(forty + "\nmore\n").hasSuffix("… +1 lines"))
    }

    private func fields(agent: String? = nil, message: Bool = false, status: String = "complete", calls: Int = 0, output: String? = nil, details: String? = nil) -> LineFields {
        var s = Session()
        s.put(1, s.bot, ["thread": s.prompt.hex, "say": "task", "task": ["title": "Agent(look)", "status": status, "details": details as Any? ?? NSNull(), "output": output as Any? ?? NSNull(), "task": true,
                                                                         "message": message, "calls": calls, "preview": NSNull(), "startedAt": NSNull(),
                                                                         "agent": agent as Any? ?? NSNull()] as [String: Any]], re: s.prompt)
        guard case .line(let line) = s.thread.items[0] else { fatalError("a line") }
        return line.fields
    }

    /// A background command's line opened in progress, then closed by an edit `seconds` after its start (`startedAt` is nil for a line with no start).
    private func closedTask(_ status: String, after seconds: Int?, output: String? = nil, agent: String? = nil, message: Bool = false, task: Bool = true) -> WorkLine {
        var s = Session()
        // The second message the session takes is the edit, written at its position's second: the line's end.
        let editTime = Double(1_700_000_000_000 + (s.position + 1) * 1000)
        func fields(_ status: String) -> [String: Any] {
            ["title": "Run: sleep 300", "status": status, "details": status == "in_progress" ? "Running in background" : NSNull(), "output": status == "in_progress" ? NSNull() : output as Any? ?? NSNull(),
             "task": task, "message": message, "calls": 0, "preview": NSNull(), "startedAt": seconds.map { editTime - Double($0) * 1000 } ?? NSNull(), "agent": agent as Any? ?? NSNull()]
        }
        let ref = s.put(1, s.bot, ["thread": s.prompt.hex, "say": "task", "task": fields("in_progress")], re: s.prompt)
        s.put(11, s.bot, ["thread": s.prompt.hex, "task": fields(status)], re: ref)
        guard case .line(let line) = s.thread.items[0] else { fatalError("a line") }
        return line
    }

    func testABackgroundCommandsClosedLineSaysDoneOrFailedWithTheTimeItTook() {
        XCTAssertEqual(LineRow.endWords(of: closedTask("complete", after: 300))?.text, "✓ Done · 5m 00s")
        XCTAssertEqual(LineRow.endWords(of: closedTask("complete", after: 300))?.failed, false)
        XCTAssertEqual(LineRow.endWords(of: closedTask("error", after: 12))?.text, "× Failed · 12s")
        XCTAssertEqual(LineRow.endWords(of: closedTask("error", after: 12))?.failed, true)
        XCTAssertEqual(LineRow.endWords(of: closedTask("complete", after: 3725))?.text, "✓ Done · 1h 02m")
    }

    func testAClosedLineWithNoStartSaysDoneOrFailedAlone() {
        XCTAssertEqual(LineRow.endWords(of: closedTask("complete", after: nil))?.text, "✓ Done")
        XCTAssertEqual(LineRow.endWords(of: closedTask("error", after: nil))?.text, "× Failed")
    }

    func testEveryOtherClosedLineSaysNothingAtItsEnd() {
        XCTAssertNil(LineRow.endWords(of: closedTask("complete", after: 5, task: false)), "a call is no task")
        XCTAssertNil(LineRow.endWords(of: closedTask("complete", after: 5, agent: "look")), "an agent's line shows its calls")
        XCTAssertNil(LineRow.endWords(of: closedTask("complete", after: 5, message: true)), "a card of words")
        XCTAssertNil(LineRow.endWords(of: closedTask("error", after: 5, output: LineRow.stopped)), "a stop is no failure")
        XCTAssertNil(LineRow.endWords(of: closedTask("complete", after: 5, output: LineRow.stopped)))
        XCTAssertNil(LineRow.endWords(of: closedTask("in_progress", after: 5)), "an open line has its running words")
    }

    func testALineTheRestartClosedSaysNoEndWords() {
        // The relay's restart sweep closes a running line `error` with `Stopped: the bot restarted` (`#closeLines` in src/chat/relay/inbound.ts): a stop, not a failure.
        XCTAssertNil(LineRow.endWords(of: closedTask("error", after: 300, output: "Stopped: the bot restarted")))
        XCTAssertEqual(LineRow.endWords(of: closedTask("error", after: 300, output: "Background command failed with exit code 1"))?.text, "× Failed · 5m 00s", "a failure whose summary says otherwise still reads Failed")
    }

    func testTheMarkAndTheEndWordsAgreeOnWhatIsAStop() {
        // The mark before a head (red triangle and "Failed", or the muted square and "Stopped") asks the same predicate as the end words.
        for output in [LineRow.stopped, "Stopped: the bot restarted"] {
            XCTAssertTrue(LineRow.isStop(output), output)
        }
        // An ordinary call's output that merely begins with the word is a failure like any other (a container, a lock).
        for output in [nil, "", "Background command failed with exit code 1", "The call Stopped early", "Stopped waiting for lock", "Stopped container abc"] as [String?] {
            XCTAssertFalse(LineRow.isStop(output), output ?? "nil")
        }
        XCTAssertTrue(LineRow.isStop("Stopped: x"))
    }

    func testTheMarkIsChosenByTheSamePredicateAsTheEndWords() {
        XCTAssertEqual(LineRow.mark(of: fields(status: "error", output: "Stopped: the bot restarted")), .stopped)
        XCTAssertEqual(LineRow.mark(of: fields(status: "error", output: LineRow.stopped)), .stopped)
        XCTAssertEqual(LineRow.mark(of: fields(status: "error", output: "Stopped waiting for lock")), .failed)
        XCTAssertEqual(LineRow.mark(of: fields(status: "error", output: "exit code 1")), .failed)
        XCTAssertEqual(LineRow.mark(of: fields(status: "error")), .failed)
        XCTAssertEqual(LineRow.mark(of: fields(status: "complete", output: LineRow.stopped)), .call, "a mark of a stop needs an error")
        XCTAssertEqual(LineRow.mark(of: fields(status: "in_progress")), .call)
    }

    func testTheFormOfALineIsChosenByItsFields() {
        XCTAssertEqual(LineForm(fields()), .call)
        XCTAssertEqual(LineForm(fields(agent: "look")), .agentAsked)
        XCTAssertEqual(LineForm(fields(agent: "look", message: true)), .agentReplied)
        XCTAssertEqual(LineForm(fields(message: true)), .message)
    }

    func testTheWordsOfAnAgentRowAreTheAppsOwn() {
        XCTAssertEqual(LineForm.agentAsked.words, "Asked an agent")
        XCTAssertEqual(LineForm.agentReplied.words, "Agent replied")
        XCTAssertNil(LineForm.call.words)
        XCTAssertNil(LineForm.message.words)
    }

    func testTheCallsOfAnAgentAreCountedOnceItIsClosed() {
        XCTAssertEqual(Naming.calls(1), "1 call")
        XCTAssertEqual(Naming.calls(4), "4 calls")
        XCTAssertEqual(LineRow.callCount(of: fields(agent: "look", status: "complete", calls: 3)), "3 calls")
        XCTAssertEqual(LineRow.callCount(of: fields(agent: "look", status: "error", calls: 1)), "1 call")
        XCTAssertNil(LineRow.callCount(of: fields(agent: "look", status: "in_progress", calls: 3)), "an open agent shows no count")
        XCTAssertNil(LineRow.callCount(of: fields(agent: "look", status: "complete", calls: 0)))
        XCTAssertNil(LineRow.callCount(of: fields(status: "complete", calls: 3)), "a call that is no agent")
    }

    func testTheReplyRowShowsTheFirstLineThatSaysSomething() {
        XCTAssertEqual(LineRow.firstSaid("\n  \n\n# Result\nmore"), "# Result")
        XCTAssertEqual(LineRow.firstSaid("---\n```\nThe tests pass."), "The tests pass.")
        XCTAssertEqual(LineRow.firstSaid("one line"), "one line")
        XCTAssertNil(LineRow.firstSaid(" \n\n"))
        XCTAssertNil(LineRow.firstSaid(nil))
    }

    func testTheReplyWindowHoldsTheWholeOutputAndItsTitle() {
        let output = "# Result\n" + String(repeating: "line\n", count: 400)
        let agent = ReplyContent(fields(agent: "look", message: true, output: output))
        XCTAssertEqual(agent?.title, "Agent replied")
        XCTAssertEqual(agent?.output, output, "Copy and the window take the output whole")
        XCTAssertEqual(ReplyContent(fields(message: true, output: "x"))?.title, "Agent(look)")
        XCTAssertNil(ReplyContent(fields(output: "x")), "a call opens no window")
        XCTAssertNil(ReplyContent(fields(agent: "look", message: true)), "no output, no window")
    }

    func testAnAgentsReplyPreviewIsFirstSaidWithoutItsMarkup() {
        let f = fields(agent: "look", message: true, output: "\n**Counts**: 3 files\nmore")
        XCTAssertEqual(LineRow.headWords(f, .agentReplied), "Counts: 3 files")
        XCTAssertEqual(LineRow.tooltip(f, .agentReplied, path: nil), "Agent replied\nCounts: 3 files")
    }

    func testAnAgentsTaskIsItsHeadAndItsDetailsStandApart() {
        let f = fields(agent: "Run ls", details: "Bash: ls -la\nRead: a.txt")
        XCTAssertEqual(LineRow.headWords(f, .agentAsked), "Run ls", "the child call lines never join the task")
        XCTAssertEqual(LineRow.agentDetails(f, .agentAsked), "Bash: ls -la\nRead: a.txt")
        XCTAssertNil(LineRow.agentDetails(f, .call), "a call draws its details in its head")
        XCTAssertNil(LineRow.agentDetails(fields(agent: "Run ls"), .agentAsked))
    }
    // MARK: a call's head on one line (step F design FB, 3.1)

    private func workLine(_ title: String, details: String? = nil, status: String = "complete", path: String? = nil, preview: [String: Any]? = nil) -> WorkLine {
        var s = Session()
        var task: [String: Any] = ["title": title, "status": status, "details": details as Any? ?? NSNull(), "output": NSNull(), "task": false, "message": false, "calls": 0,
                                   "preview": preview as Any? ?? NSNull(), "startedAt": NSNull()]
        if let path { task["path"] = path }
        s.put(1, s.bot, ["thread": s.prompt.hex, "say": "task", "task": task], re: s.prompt)
        guard case .line(let line) = s.thread.items[0] else { fatalError("a line") }
        return line
    }

    @MainActor
    private func headHeight(_ line: WorkLine, state: LineState, width: CGFloat) -> CGFloat {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let hosting = NSHostingView(rootView: LineRow(line: line, state: state, indent: 0).frame(width: width))
        hosting.layoutSubtreeIfNeeded()
        return hosting.fittingSize.height
    }

    @MainActor
    func testALongHeadStaysOnOneLineAt380() {
        let path = "/srv/example/project/app/Sources/Screens/AVeryLongFileNameForTheTest.swift"
        let line = workLine("Update(\(path))", details: "Added 12 lines, removed 3 lines in the middle of the file and some more words after them")
        let one = headHeight(workLine("Read", details: "a.txt"), state: .waiting, width: 380)
        XCTAssertLessThan(one, 20, "a short head is one line of 13 points")
        let running = headHeight(line, state: .running(since: Date(timeIntervalSinceNow: -193)), width: 380)
        XCTAssertEqual(running, one, accuracy: 1, "a head with a long title, long details and `Running · 3m 13s` is as high as a short one")
        XCTAssertEqual(headHeight(line, state: .waiting, width: 380), one, accuracy: 1)
        XCTAssertEqual(headHeight(line, state: .running(since: nil), width: 560), one, accuracy: 1)
    }

    @MainActor
    func testAFailedCallsHeadStaysOnOneLineToo() {
        let line = workLine("Bash", details: String(repeating: "word ", count: 60), status: "error")
        let one = headHeight(workLine("Read", details: "a.txt"), state: .waiting, width: 380)
        XCTAssertEqual(headHeight(line, state: .waiting, width: 380), one, accuracy: 2, "the warning sign adds no line")
    }

    func testEveryHeadsTooltipHoldsItsTitleAndItsDetailsInFull() {
        let f = workLine("Bash", details: "ls -la /srv/example/project && cat a.txt").fields
        XCTAssertEqual(LineRow.tooltip(f, .call, path: nil), "Bash\nls -la /srv/example/project && cat a.txt")
        XCTAssertEqual(LineRow.tooltip(workLine("Run: ls").fields, .call, path: nil), "Run: ls", "a head with no details has its title alone")
        XCTAssertEqual(LineRow.tooltip(f, .call, path: "/a/b/c.swift"), "/a/b/c.swift\nls -la /srv/example/project && cat a.txt", "a file link's tooltip is the path, then the details")
        let agent = fields(agent: "look at the tests")
        XCTAssertEqual(LineRow.tooltip(agent, .agentAsked, path: nil), "Asked an agent\nlook at the tests")
        let preview: [String: Any] = ["title": "Update(a.txt)", "summary": "Added 2 lines", "body": "+a\n+b", "language": "diff", "plain": false, "record": false]
        XCTAssertEqual(LineRow.tooltip(workLine("Edit", preview: preview).fields, .call, path: nil), "Update(a.txt)\nAdded 2 lines")
    }

    // MARK: the first row of a diff (step F design FB, 3.1)

    @MainActor
    private func stackHeight(spacing: CGFloat, line: WorkLine, index: Int, offset: CGFloat?) -> CGFloat {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let row = LineBodyRow(line: line, index: index, indent: 0, stack: offset == nil ? nil : spacing)
        let view = offset == nil ? AnyView(row) : AnyView(VStack(alignment: .leading, spacing: spacing) { Color.clear.frame(height: 10); row })
        let hosting = NSHostingView(rootView: view.frame(width: 400))
        hosting.layoutSubtreeIfNeeded()
        return hosting.fittingSize.height
    }

    @MainActor
    func testTheFirstRowOfADiffStandsTwoPointsUnderItsHeadAndTheLaterOnesRightUnderTheOneAboveInEveryStack() {
        let body = (1...250).map { "+line \($0)" }.joined(separator: "\n")
        let preview: [String: Any] = ["title": "Update(a.txt)", "summary": "Added 250 lines", "body": body, "language": "diff", "plain": false, "record": false]
        let line = workLine("Edit", preview: preview)
        for spacing in [ThreadRow.stack, PardnerMetrics.gap] {
            let top = LineBodyRow.top(underStackOf: spacing)
            XCTAssertEqual(top, 2 - spacing)
            let alone = stackHeight(spacing: spacing, line: line, index: 0, offset: nil)
            XCTAssertEqual(stackHeight(spacing: spacing, line: line, index: 0, offset: top) - alone, 10 + 2, accuracy: 0.5, "a head 10 points high, then 2 points, then the row (stack of \(spacing))")
            XCTAssertEqual(LineBodyRow.top(continuingStackOf: spacing), -spacing)
            let second = stackHeight(spacing: spacing, line: line, index: 1, offset: nil)
            XCTAssertEqual(stackHeight(spacing: spacing, line: line, index: 1, offset: top) - second, 10, accuracy: 0.5, "a later row stands right under the one above, with no gap (#142), stack of \(spacing)")
        }
    }

    func testADiffRowIsOneAttributedTextOfAllItsLines() {
        PardnerFonts.register()
        let lines = ["    5 node cli.js", "-\u{1F7E5} 6 old line", "+\u{1F7E9} 6 new line", "..."].map(DiffLine.init)
        let pieces = DiffRowText.pieces(lines)
        XCTAssertEqual(pieces.count, lines.count, "one piece per source line (the row tags each with its index, which the grounds tests read back)")
        var text = AttributedString()
        pieces.forEach { text += $0 }
        XCTAssertEqual(String(text.characters), "  5 node cli.js\n- 6 old line\n+ 6 new line\n...", "no square, one text for the whole row")
        let removed = text.runs.first { String(text.characters[$0.range]) == "old line" }
        XCTAssertEqual(removed?.foregroundColor, PardnerColor.delText)
        XCTAssertEqual(text.runs.first { String(text.characters[$0.range]) == " 6 " && $0.foregroundColor == PardnerColor.muted }?.foregroundColor, PardnerColor.muted, "the number is muted")
        XCTAssertTrue(text.runs.allSatisfy { $0.backgroundColor == nil }, "the grounds are drawn from the layout, not by the text")
    }

    /// The colour of the column at the right of a hosted diff row, per point from the top: `+` added ground, `-` removed, `.` none.
    @MainActor
    private func groundColumn(_ row: String, width: CGFloat) -> String {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let hosting = NSHostingView(rootView: DiffRowText(row: row).frame(width: width).environment(\.colorScheme, .light))
        hosting.appearance = NSAppearance(named: .aqua)
        hosting.layoutSubtreeIfNeeded()
        hosting.frame = NSRect(origin: .zero, size: hosting.fittingSize)
        hosting.layoutSubtreeIfNeeded()
        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { return "" }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        func close(_ a: NSColor, _ b: NSColor) -> Bool {
            guard let a = a.usingColorSpace(.sRGB), let b = b.usingColorSpace(.sRGB) else { return false }
            return abs(a.redComponent - b.redComponent) + abs(a.greenComponent - b.greenComponent) + abs(a.blueComponent - b.blueComponent) < 0.06
        }
        var added = NSColor(PardnerColor.addBg), removed = NSColor(PardnerColor.delBg)
        NSAppearance(named: .aqua)?.performAsCurrentDrawingAppearance { added = NSColor(PardnerColor.addBg).usingColorSpace(.sRGB) ?? added; removed = NSColor(PardnerColor.delBg).usingColorSpace(.sRGB) ?? removed }
        return (0..<rep.pixelsHigh).map { y in
            guard let pixel = rep.colorAt(x: rep.pixelsWide - 3, y: y), pixel.alphaComponent > 0.5 else { return "." }
            return close(pixel, added) ? "+" : close(pixel, removed) ? "-" : "?"
        }.joined()
    }

    @MainActor
    func testADiffRowsGroundsSpanTheColumnAndAWrappedLineKeepsOne() {
        let long = "+\u{1F7E9} 1 a long added line with an emoji \u{1F600} that wraps onto a second and a third line of this narrow column for sure"
        let column = groundColumn([long, "-\u{1F7E5} 2 old", "  3 plain"].joined(separator: "\n"), width: 240)
        let runs = column.reduce(into: [(Character, Int)]()) { if $0.last?.0 == $1 { $0[$0.count - 1].1 += 1 } else { $0.append(($1, 1)) } }
        XCTAssertEqual(runs.map(\.0), ["+", "-", "."], "added, then removed with no gap, then no ground: \(runs)")
        XCTAssertGreaterThan(Double(runs[0].1), Double(runs[1].1) * 2.4, "the wrapped line's ground covers all its pieces: \(runs)")
        let gap = groundColumn("+\u{1F7E9} 1 new\n\n-\u{1F7E5} 2 old", width: 240)
        XCTAssertEqual(gap.reduce(into: "") { if $0.last != $1 { $0.append($1) } }, "+.-", "an empty line between two keeps the ground of the one after it: \(gap)")
    }

    /// The ground of each layout line of a row at width 240, one character per line (`+` added, `-` removed, `.` none), from its column.
    @MainActor
    private func grounds(_ row: String, layoutLines: Int) -> String {
        let column = Array(groundColumn(row, width: 240))
        let pitch = Double(column.count) / Double(layoutLines)
        return String((0..<layoutLines).map { column[min(column.count - 1, Int((Double($0) + 0.5) * pitch))] })
    }

    @MainActor
    func testTheGroundsFollowTheSourceLinesWhateverTheTextHoldsOrReads() {
        let (add, del) = ("+\u{1F7E9}", "-\u{1F7E5}")
        // A lone CR or a paragraph separator breaks the layout line inside one source line; Hebrew starts a right-to-left run.
        XCTAssertEqual(grounds("\(add) 1 a\rb\n  2 ctx\n\(del) 3 old", layoutLines: 4), "++.-", "a CR inside the added line")
        XCTAssertEqual(grounds("\(add) 1 a\u{2029}b\n  2 ctx\n\(del) 3 old", layoutLines: 4), "++.-", "a paragraph separator inside the added line")
        XCTAssertEqual(grounds("  1 ctx\n\(add) 2 \u{5E9}\u{5DC}\u{5D5}\u{5DD} \u{5E2}\u{5D5}\u{5DC}\u{5DD}\n  3 ctx", layoutLines: 3), ".+.", "a line of Hebrew")
        XCTAssertEqual(grounds("  1 ctx\n\(add) 2 \u{5E9}\u{5DC}\u{5D5}\u{5DD}\n  3 ctx\n\(del) 4 old\n  5 ctx", layoutLines: 5), ".+.-.", "Hebrew, then a removed line")
    }

    /// The widest gap between two inked columns of a rendered head, in points, and the width it was drawn at.
    @MainActor
    private func widestGap(_ line: WorkLine, state: LineState, width: CGFloat) -> CGFloat {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let hosting = NSHostingView(rootView: LineRow(line: line, state: state, indent: 0).frame(width: width, height: 20, alignment: .topLeading))
        hosting.frame = NSRect(x: 0, y: 0, width: width, height: 20)
        hosting.layoutSubtreeIfNeeded()
        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { return .infinity }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        let scale = CGFloat(rep.pixelsWide) / width
        var inked = [Bool](repeating: false, count: rep.pixelsWide)
        for x in 0..<rep.pixelsWide { for y in 0..<rep.pixelsHigh where (rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.1 { inked[x] = true; break } }
        var widest = 0, run = 0, seen = false
        for column in inked {
            if column { widest = seen ? max(widest, run) : 0; run = 0; seen = true } else { run += 1 }
        }
        return CGFloat(widest) / scale
    }

    @MainActor
    func testTheDetailsTakeTheRoomUpToTheStateWords() {
        let details = String(repeating: "a long run of details that more than fills the room ", count: 4)
        let line = workLine("Bash", details: details)
        XCTAssertGreaterThan(widestGap(line, state: .interrupted, width: 380), 0)
        // The 8 points between the details and the state words, and what the cut leaves: under the width of the next character, which is at most the widest of the text's.
        let font = PardnerFont.uiCT(size: PardnerFont.toolSize, weight: .regular) as NSFont
        let widest = Set(details).map { (String($0) as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
        for width in [360, 380, 400] as [CGFloat] {
            let gap = widestGap(line, state: .interrupted, width: width)
            XCTAssertLessThanOrEqual(gap, 8 + widest, "width \(width): the cut details end 8 points and under a character from the state words, the spacer keeping no more")
        }
    }

    @MainActor
    func testTheRunningTimeKeepsItsWidthWhateverItsDigits() {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        func width(_ seconds: TimeInterval) -> CGFloat {
            let hosting = NSHostingView(rootView: LineRow(line: workLine("Bash"), state: .running(since: Date(timeIntervalSinceNow: -seconds)), indent: 0).fixedSize())
            hosting.layoutSubtreeIfNeeded()
            return hosting.fittingSize.width
        }
        // 1m 11s and 8m 08s: the same count of characters, the digits one and eight.
        XCTAssertEqual(width(71.5), width(488.5), accuracy: 0.01, "the time's digits are the same width, so the cut text does not move each second")
    }
}
