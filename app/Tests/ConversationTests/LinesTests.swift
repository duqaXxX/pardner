// A turn's tool-call lines in the reading model (turn work design 2.2 to 2.4, 2.6 and 2.9): a line is a text of kind 1 with
// `say` "task" and a later edit of kind 11, each holding a `TaskUpdate` (src/chat/seam.ts) without `id`, `name` and `folded`,
// with `startedAt` in wall-clock milliseconds. Synthetic content, the shape of test/golden/reply/edit-write.json.
import Conversation
import Foundation
import ProtocolHost
import XCTest

/// The body of a line's text or edit: a `TaskUpdate` as the bot writes it.
private func update(_ title: String, status: String = "in_progress", details: String? = nil, output: String? = nil, preview: [String: Any]? = nil,
                    startedAt: Double? = nil, task: Bool = false, message: Bool = false, calls: Int = 0) -> [String: Any] {
    ["title": title, "status": status, "details": details.map { $0 as Any } ?? NSNull(), "output": output.map { $0 as Any } ?? NSNull(),
     "task": task, "message": message, "calls": calls, "preview": preview.map { $0 as Any } ?? NSNull(),
     "startedAt": startedAt.map { $0 as Any } ?? NSNull()]
}

private func diffPreview(body: String = "+🟩 1 new\n-🟥 1 old") -> [String: Any] {
    ["title": "Update(notes.txt)", "summary": "Added 1 line, removed 1 line", "body": body, "language": "diff", "plain": false, "record": false]
}

/// A running session of alice's bot with one prompt, and what it needs to write lines under it.
private struct Turn {
    var w = World()
    let prompt: MessageRef
    var thread: String { prompt.hex }

    init() {
        prompt = w.deliver(kind: 2, from: w.alice, json: ["text": "fix the tests"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: prompt)
    }

    @discardableResult
    mutating func line(_ u: [String: Any], from sender: Data? = nil, re: MessageRef? = nil) -> MessageRef {
        w.deliver(kind: 1, from: sender ?? w.bot, json: ["thread": thread, "say": "task", "task": u], re: re ?? prompt)
    }

    mutating func edit(_ line: MessageRef, _ u: [String: Any], from sender: Data? = nil) {
        w.deliver(kind: 11, from: sender ?? w.bot, json: ["thread": thread, "task": u], re: line)
    }

    var t: MessageThread { w.c.threads[thread]! }
    var lines: [WorkLine] { t.items.compactMap { if case .line(let l) = $0 { l } else { nil } } }
    var segments: [AnswerGroup] { t.items.compactMap { if case .answer(let a) = $0 { a } else { nil } } }
    var answerName: Data { Data(repeating: 0xAA, count: 16) }
    var parts: MessageRef { MessageRef(device: w.bot, name: answerName) }

    mutating func part(_ markdown: String) { w.deliver(kind: 4, from: w.bot, json: ["thread": thread, "markdown": markdown], re: parts) }
    mutating func answer(_ markdown: String) {
        w.deliver(kind: 5, from: w.bot, json: ["thread": thread, "markdown": markdown], re: prompt, name: answerName)
    }
}

final class LinesTests: XCTestCase {
    func testALineOpensUnderItsPromptAndItsEditsFollowItsStatusOutputAndPreview() throws {
        var turn = Turn()
        let ref = turn.line(update("Run: make test", startedAt: 1_700_000_100_000))
        XCTAssertEqual(turn.lines.count, 1)
        XCTAssertEqual(turn.lines[0].fields.title, "Run: make test")
        XCTAssertEqual(turn.lines[0].fields.status, .inProgress)
        XCTAssertEqual(turn.lines[0].prompt, turn.prompt)
        XCTAssertEqual(turn.lines[0].fields.startedAt, Date(timeIntervalSince1970: 1_700_000_100))
        turn.edit(ref, update("Run: make test", status: "error", startedAt: 1_700_000_100_000))
        XCTAssertEqual(turn.lines[0].fields.status, .error)
        XCTAssertNil(turn.lines[0].fields.output)
        turn.edit(ref, update("Run: make test", status: "error", output: "1 test failed", startedAt: 1_700_000_100_000))
        XCTAssertEqual(turn.lines[0].fields.output, "1 test failed")
        turn.edit(ref, update("Edit: notes.txt", status: "complete", preview: diffPreview()))
        let preview = try XCTUnwrap(turn.lines[0].fields.preview)
        XCTAssertEqual(preview.summary, "Added 1 line, removed 1 line")
        XCTAssertEqual(preview.language, "diff")
        XCTAssertEqual(turn.lines.count, 1, "an edit is no new entry")
        XCTAssertEqual(turn.t.items.count, 1)
        XCTAssertEqual(turn.t.settlement, .session, "a line is a sign of a session")
    }

    func testALineReadsEveryFieldOfTheTaskUpdate() throws {
        var turn = Turn()
        turn.line(update("Agent: look", details: "3 calls", output: "done", task: true, message: true, calls: 3))
        let fields = turn.lines[0].fields
        XCTAssertEqual([fields.details, fields.output], ["3 calls", "done"])
        XCTAssertTrue(fields.task)
        XCTAssertTrue(fields.message)
        XCTAssertEqual(fields.calls, 3)
        XCTAssertNil(fields.startedAt)
        XCTAssertNil(fields.preview)
    }

    func testATaskUpdateThatDoesNotReadIsAnUnreadableMessage() throws {
        var turn = Turn()
        turn.line(["title": "no status"])
        turn.line(update("bad status", status: "weird"))
        XCTAssertTrue(turn.lines.isEmpty)
        guard case .unreadable(let count, _)? = turn.t.entries.first, turn.t.entries.count == 1 else { return XCTFail("one counted row") }
        XCTAssertEqual(count, 2)
    }

    func testALineIsOpenOnlyWhileItsPromptRuns() throws {
        var turn = Turn()
        let started = Date(timeIntervalSince1970: 1_700_000_100)
        turn.line(update("a", startedAt: 1_700_000_100_000))
        turn.line(update("b"))
        turn.line(update("c", status: "pending"))
        turn.line(update("d", status: "complete"))
        let l = turn.lines
        XCTAssertEqual(turn.t.state(of: l[0]), .running(since: started))
        XCTAssertEqual(turn.t.state(of: l[1]), .running(since: nil))
        XCTAssertEqual(turn.t.state(of: l[2]), .waiting)
        XCTAssertEqual(turn.t.state(of: l[3]), .written)
        turn.answer("Done.")
        let answered = turn.lines
        XCTAssertEqual(turn.t.state(of: answered[0]), .written, "closed by finish as running in background: as written, no timer")
        XCTAssertEqual(turn.t.state(of: answered[2]), .written)
        XCTAssertEqual(turn.t.state(of: answered[3]), .written)
    }

    func testALineOfACutOrUnreadPromptIsInterrupted() throws {
        var cut = Turn()
        cut.line(update("a"))
        cut.line(update("b", status: "pending"))
        cut.line(update("c", status: "error"))
        cut.w.deliver(kind: 6, from: cut.w.bot, json: [:], re: cut.prompt)
        let lines = cut.lines
        XCTAssertEqual(cut.t.state(of: lines[0]), .interrupted)
        XCTAssertEqual(cut.t.state(of: lines[1]), .interrupted)
        XCTAssertEqual(cut.t.state(of: lines[2]), .written, "a closed line stays as written")
        var unread = Turn()
        unread.line(update("a"))
        unread.w.deliver(kind: 7, from: unread.w.bot, json: [:], re: unread.prompt)
        XCTAssertEqual(unread.t.state(of: unread.lines[0]), .interrupted)
        var elsewhere = Turn()
        elsewhere.line(update("a"), re: MessageRef(device: elsewhere.w.bot, name: Data(repeating: 0x77, count: 16)))
        XCTAssertEqual(elsewhere.t.state(of: elsewhere.lines[0]), .interrupted, "its prompt is not one of this thread")
    }

    func testOnlyTheSessionsBotWritesLinesAndEdits() throws {
        var turn = Turn()
        let other = Data(repeating: 7, count: 32)
        turn.line(update("not mine"), from: other)
        XCTAssertTrue(turn.lines.isEmpty)
        let ref = turn.line(update("mine"))
        turn.edit(ref, update("hijacked", status: "complete"), from: other)
        XCTAssertEqual(turn.lines[0].fields.title, "mine")
        XCTAssertEqual(turn.lines[0].fields.status, .inProgress)
        turn.edit(ref, update("mine", status: "complete", output: "ok"), from: turn.w.alice)
        XCTAssertEqual(turn.lines[0].fields.status, .inProgress, "the owner's edit is no line's edit either")
    }

    func testAnEditOfALineTheAppDoesNotHoldChangesNothing() throws {
        var turn = Turn()
        let before = turn.t
        turn.edit(MessageRef(device: turn.w.bot, name: Data(repeating: 0x55, count: 16)), update("ghost", status: "complete"))
        XCTAssertEqual(turn.t.items, before.items)
        XCTAssertTrue(turn.lines.isEmpty)
    }

    func testTextALineAndMoreTextKeepTheOrderTheyWereWrittenIn() throws {
        var turn = Turn()
        turn.part("Looking at ")
        turn.part("the test. ")
        turn.line(update("Read: a.ts", status: "complete"))
        turn.part("It reads a file. ")
        turn.line(update("Run: make", status: "complete"))
        turn.line(update("Run: make test", status: "complete"))
        turn.part("Done.")
        let shape = turn.t.items.map { item -> String in
            switch item {
            case .answer(let a): "text:" + a.markdown
            case .line(let l): "line:" + l.fields.title
            case .message: "message"
            }
        }
        XCTAssertEqual(shape, ["text:Looking at the test. ", "line:Read: a.ts", "text:It reads a file. ", "line:Run: make", "line:Run: make test", "text:Done."])
        let segments = turn.segments
        XCTAssertEqual(segments.map(\.continues), [false, true, true])
        XCTAssertEqual(segments.map(\.last), [false, false, true], "Writing stands on the last segment alone")
        XCTAssertTrue(segments.allSatisfy { !$0.done })
    }

    func testASegmentDrawsNoLineEndsAtItsEdges() throws {
        // The core opens a block that follows a line with a blank line, for a reply drawn as one text: a segment drawn on its own
        // shows none of it, and Copy keeps the answer as written.
        var turn = Turn()
        turn.part("Looking.")
        turn.line(update("Run: sleep 60", status: "complete"))
        turn.part("\n\nBash(Sleep)\n  Running in background\n\n")
        turn.line(update("Run: ls", status: "complete"))
        turn.part("\n\nDone.\n")
        // A blank line inside a segment stays: only its edges lose their line ends.
        XCTAssertEqual(turn.segments.map(\.shown), ["Looking.", "Bash(Sleep)\n  Running in background", "Done."])
        XCTAssertEqual(turn.segments.map(\.markdown), ["Looking.", "\n\nBash(Sleep)\n  Running in background\n\n", "\n\nDone.\n"])
    }

    func testTheAnswerMarksEverySegmentDoneAndKeepsThemWhenTheyAddUpToIt() throws {
        var turn = Turn()
        turn.part("One. ")
        turn.line(update("Read: a.ts", status: "complete"))
        turn.part("Two.")
        turn.answer("One. Two.")
        XCTAssertEqual(turn.t.items.count, 3)
        XCTAssertEqual(turn.segments.map(\.markdown), ["One. ", "Two."])
        XCTAssertTrue(turn.segments.allSatisfy(\.done))
        XCTAssertEqual(turn.t.prompts[turn.prompt], .answered)
    }

    func testTheAnswerReplacesTheSegmentsWhenTheyDifferFromIt() throws {
        var turn = Turn()
        turn.part("One. ")
        let ref = turn.line(update("Read: a.ts"))
        turn.part("Two.")
        turn.answer("One. A part never queued. Two.")
        XCTAssertEqual(turn.segments.map(\.markdown), ["One. A part never queued. Two."], "one block at the first segment's place")
        XCTAssertTrue(turn.segments[0].done)
        XCTAssertTrue(turn.segments[0].last)
        guard case .answer = turn.t.items[0], case .line = turn.t.items[1] else { return XCTFail("the block stands first, the line stays") }
        turn.edit(ref, update("Read: a.ts", status: "complete"))
        XCTAssertEqual(turn.lines[0].fields.status, .complete, "an edit still finds its line after the removal")
    }

    func testTheAnswerReplacesTheSegmentsWhenAPartDidNotOpenOnThisDevice() throws {
        var turn = Turn()
        turn.part("One. ")
        turn.w.deliver(kind: 4, from: turn.w.bot, json: nil, re: turn.parts) // a part of another epoch
        turn.line(update("Read: a.ts", status: "complete"))
        turn.part("Three.")
        XCTAssertEqual(turn.w.c.timeline.count, 2, "an unreadable part stays in the channel's list, beside the root")
        turn.answer("One. Two. Three.")
        XCTAssertEqual(turn.segments.map(\.markdown), ["One. Two. Three."])
    }

    func testAnEmptyAnswerKeepsTheSegments() throws {
        var turn = Turn()
        turn.part("One.")
        turn.line(update("a", status: "complete"))
        turn.part("Two.")
        turn.answer("")
        XCTAssertEqual(turn.segments.map(\.markdown), ["One.", "Two."])
        XCTAssertTrue(turn.segments.allSatisfy(\.done))
    }

    func testAnAnswerWithNoPartsIsOneDoneBlock() throws {
        var turn = Turn()
        turn.line(update("a", status: "complete"))
        turn.answer("Whole.")
        XCTAssertEqual(turn.segments.map(\.markdown), ["Whole."])
        XCTAssertTrue(turn.segments[0].done)
        XCTAssertFalse(turn.segments[0].continues)
    }

    func testAMessageThatDoesNotOpenBelongsToTheThreadItsReNames() throws {
        var turn = Turn()
        let ref = turn.line(update("a"))
        for _ in 0..<3 { turn.w.deliver(kind: 11, from: turn.w.bot, json: nil, re: ref) } // edits of an epoch this device cannot open
        turn.w.deliver(kind: 1, from: turn.w.bot, json: nil, re: turn.prompt) // a line of that epoch
        XCTAssertEqual(turn.w.c.timeline.count, 1, "none of them is a row of the channel")
        let entries = turn.t.entries
        XCTAssertEqual(entries.count, 2)
        guard case .item(.line) = entries[0], case .unreadable(let count, _) = entries[1] else { return XCTFail("a line, then one counted row") }
        XCTAssertEqual(count, 4)
        turn.line(update("b"))
        turn.w.deliver(kind: 11, from: turn.w.bot, json: nil, re: ref)
        guard case .unreadable(let again, _) = turn.t.entries.last else { return XCTFail("one row again") }
        XCTAssertEqual(again, 1, "the count restarts after a readable entry")
    }

    func testAMessageThatDoesNotOpenAndNamesNoThreadStaysInTheChannel() throws {
        var w = World()
        w.deliver(kind: 1, from: w.bot, json: nil)
        w.deliver(kind: 4, from: w.bot, json: nil, re: MessageRef(device: w.bot, name: Data(repeating: 1, count: 16)))
        XCTAssertEqual(w.c.timeline.count, 2)
    }

    func testPreviewBodyIsSplitInRowsOfAtMost200Lines() throws {
        XCTAssertEqual(LinePreview.rows(of: ""), [])
        XCTAssertEqual(LinePreview.rows(of: "a\nb"), ["a\nb"])
        let body = (1...450).map { "l\($0)" }.joined(separator: "\n")
        let rows = LinePreview.rows(of: body)
        XCTAssertEqual(rows.map { $0.split(separator: "\n", omittingEmptySubsequences: false).count }, [200, 200, 50])
        XCTAssertEqual(rows.joined(separator: "\n"), body)
        var turn = Turn()
        turn.line(update("Edit", status: "complete", preview: diffPreview(body: body)))
        XCTAssertEqual(turn.lines[0].fields.preview?.rows.count, 3)
    }

    func testARecordPreviewIsOneBlock() throws {
        var turn = Turn()
        var record = diffPreview(body: (1...450).map { "w\($0)" }.joined(separator: "\n"))
        record["language"] = ""
        record["plain"] = true
        record["record"] = true
        turn.line(update("Asked", status: "complete", preview: record))
        XCTAssertEqual(turn.lines[0].fields.preview?.record, true)
        XCTAssertEqual(turn.lines[0].fields.preview?.rows.count, 1, "the words stay one block")
    }

    func testAnEditFindsItsLineAmongHundredsByTheDictionary() throws {
        var turn = Turn()
        let refs = (0..<200).map { turn.line(update("call \($0)")) }
        turn.edit(refs[100], update("call 100", status: "complete", output: "ok"))
        turn.edit(refs[199], update("call 199", status: "error", output: "no"))
        XCTAssertEqual(turn.lines[100].fields.status, .complete)
        XCTAssertEqual(turn.lines[199].fields.output, "no")
        XCTAssertEqual(turn.lines[101].fields.status, .inProgress)
    }

    func testALineSurvivesARebuildInPositionOrder() throws {
        var turn = Turn()
        let ref = turn.line(update("a"))
        turn.edit(ref, update("a", status: "complete"))
        // A message delivered at a place already passed rebuilds the channel, edits included.
        turn.w.deliver(kind: 1, from: turn.w.alice, json: ["markdown": "earlier"], at: 9)
        XCTAssertEqual(turn.lines.first?.fields.status, .complete)
        XCTAssertEqual(turn.t.state(of: turn.lines[0]), .written)
    }

    func testABodyWhoseLinesEndInCarriageReturnIsCutAtEachLine() throws {
        let body = (1...450).map { "l\($0)" }.joined(separator: "\r\n")
        XCTAssertEqual(LinePreview.rows(of: body).count, 3)
        XCTAssertEqual(LinePreview.rows(of: "a\r\n\r\nb"), ["a\r\n\r\nb"])
        XCTAssertEqual(LinePreview.rows(of: body).joined(separator: "\n"), body)
    }

    func testAnUnreadableEditOfATopLevelMessageGivesItNoThread() throws {
        var w = World()
        let notice = w.deliver(kind: 1, from: w.bot, json: ["markdown": "Heads up."])
        w.deliver(kind: 11, from: w.bot, json: nil, re: notice) // a rewrite of the notice, in an epoch this device cannot open
        XCTAssertEqual(w.c.timeline.count, 2, "the edit stays in the channel's list")
        XCTAssertEqual(w.c.threads[notice.hex]?.items.count, 0, "no reply under the notice")
    }

    func testOnlyALinesTextAndItsEditAreRoutedByRe() throws {
        var turn = Turn()
        turn.w.deliver(kind: 5, from: turn.w.bot, json: nil, re: turn.prompt) // an answer that does not open
        turn.w.deliver(kind: 3, from: turn.w.bot, json: nil, re: turn.prompt)
        XCTAssertEqual(turn.w.c.timeline.count, 3, "the prompt and the two stay in the channel's list")
        XCTAssertTrue(turn.t.items.isEmpty)
    }

    func testCopyingAnAnswerGivesAllItsSegments() throws {
        var turn = Turn()
        turn.part("One. ")
        turn.line(update("a", status: "complete"))
        turn.part("Two.")
        let segments = turn.segments
        XCTAssertEqual(turn.t.text(of: segments[0]), "One. Two.")
        XCTAssertEqual(turn.t.text(of: segments[1]), "One. Two.")
        turn.answer("One. Two. Three.")
        XCTAssertEqual(turn.t.text(of: turn.segments[0]), "One. Two. Three.")
    }
}
