// The thread's finished calls folded into one line (#27): the words of a fold, what breaks a run and what keeps its own row, the fold's
// identity across a rebuild, the spacing round a call, and the inline code's style. Synthetic content.
import Conversation
import DesignSystem
import Foundation
import ProtocolHost
@testable import Screens
import SwiftUI
import XCTest

private let bot = Data(repeating: 3, count: 32)
private let alice = Data(repeating: 2, count: 32)
private let read = ["Read {n} file", "Read {n} files"]
private let ran = ["Ran {n} shell command", "Ran {n} shell commands"]
private let listed = ["Listed {n} directory", "Listed {n} directories"]

/// A session of the bot opened by a prompt of alice's; each message is one second after the one before.
private struct Session {
    var model = ReadingModel()
    var position = 1
    let channel = Data(repeating: 1, count: 32)
    var prompt: MessageRef!

    init() {
        prompt = put(2, alice, ["text": "go"], to: bot)
        put(3, bot, [:], re: prompt)
    }

    @discardableResult
    mutating func put(_ kind: Int, _ sender: Data, _ body: [String: Any]?, to: Data? = nil, re: MessageRef? = nil, files: [HostValue] = []) -> MessageRef {
        let at = position
        position += 1
        let name = Data(repeating: UInt8(at), count: 16)
        model.take(view: .object([
            "do": .string("message"), "position": .number(Double(at)), "channel": .bytes(channel), "sender": .bytes(sender),
            "name": .bytes(name), "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(1_700_000_000_000 + Double(at) * 1000),
            "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null, "blobs": .array([]), "files": .array(files),
            "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null,
            "text": body.map { .string(String(decoding: try! JSONSerialization.data(withJSONObject: $0), as: UTF8.self)) } ?? .null, "again": .bool(false),
        ]))
        return MessageRef(device: sender, name: name)
    }

    /// A call's line as the daemon writes it, with its fold words unless `fold` is nil.
    @discardableResult
    mutating func call(_ title: String = "Bash: ls", status: String = "complete", fold: [String]? = ran, task: Bool = false, message: Bool = false,
                       agent: String? = nil, preview: [String: Any]? = nil) -> MessageRef {
        var fields: [String: Any] = ["title": title, "status": status, "details": NSNull(), "output": NSNull(), "task": task, "message": message, "calls": 0,
                                     "preview": preview as Any? ?? NSNull(), "startedAt": NSNull()]
        if let fold { fields["fold"] = fold }
        if let agent { fields["agent"] = agent }
        return put(1, bot, ["thread": prompt.hex, "say": "task", "task": fields], re: prompt)
    }

    /// The image a call's result held, as the daemon sends it: a text of the bot's naming the line, with the file.
    mutating func image(of line: MessageRef) {
        let file = HostValue.object(["blob": .bytes(Data(repeating: 7, count: 32)), "size": .number(10), "type": .string("image/png"), "name": .string("image-1.png")])
        put(1, bot, ["thread": prompt.hex, "say": "image", "line": line.name.map { String(format: "%02x", $0) }.joined()], files: [file])
    }

    mutating func text(_ markdown: String) { put(1, bot, ["thread": prompt.hex, "markdown": markdown]) }
    mutating func footer() { put(1, bot, ["thread": prompt.hex, "say": "footer", "markdown": "4s"]) }

    var thread: MessageThread { model.channels[channel]!.threads[prompt.hex]! }
    var rows: [ThreadRow] { ThreadRows.build(thread, isSystem: { _ in false }) }
}

/// What a row is, in one word, so that a run's shape reads at a glance.
private func shape(_ rows: [ThreadRow]) -> [String] {
    rows.map {
        switch $0.content {
        case .fold(let f): "fold(\(f.lines.count)) \(f.words)"
        case .line(let l): "line \(l.fields.title)"
        case .message: "message"
        case .segment: "segment"
        case .body: "body"
        case .unreadable: "unreadable"
        }
    }
}

final class CallFoldTests: XCTestCase {
    // MARK: the words

    func testOneGroupIsItsSentenceFilledWithTheCount() {
        var s = Session()
        s.call(fold: read)
        s.call(fold: read)
        s.call(fold: read)
        XCTAssertEqual(shape(s.rows), ["fold(3) Read 3 files"])
    }

    func testOneCallReadsInTheSingular() {
        var s = Session()
        s.call(fold: ran)
        XCTAssertEqual(shape(s.rows), ["fold(1) Ran 1 shell command"], "a run of one folds too")
    }

    func testTwoGroupsKeepTheirFirstAppearanceAndTheRestStartsLowercase() {
        var s = Session()
        s.call(fold: ran)
        s.call(fold: read)
        s.call(fold: ran)
        s.call(fold: read)
        s.call(fold: ran)
        XCTAssertEqual(shape(s.rows), ["fold(5) Ran 3 shell commands, read 2 files"])
        var t = Session()
        t.call(fold: read)
        t.call(fold: read)
        t.call(fold: ran)
        t.call(fold: ran)
        t.call(fold: ran)
        t.call(fold: listed)
        XCTAssertEqual(shape(t.rows), ["fold(6) Read 2 files, ran 3 shell commands, listed 1 directory"])
    }

    // MARK: what breaks a run and what keeps its own row

    func testATextBreaksTheRunIntoTwoFolds() {
        var s = Session()
        s.call(fold: read)
        s.call(fold: read)
        s.text("Now the shell.")
        s.call(fold: ran)
        XCTAssertEqual(shape(s.rows), ["fold(2) Read 2 files", "message", "fold(1) Ran 1 shell command"])
    }

    func testARunningACallThatWaitsAFailedAndABackgroundCallKeepTheirOwnRows() {
        var s = Session()
        s.call("Bash: a")
        s.call("Bash: running", status: "in_progress")
        s.call("Bash: b")
        s.call("Bash: waiting", status: "pending")
        s.call("Bash: c")
        s.call("Bash: failed", status: "error")
        s.call("Bash: d")
        s.call("Bash: sleep", task: true)
        s.call("Bash: e")
        XCTAssertEqual(shape(s.rows), [
            "fold(1) Ran 1 shell command", "line Bash: running", "fold(1) Ran 1 shell command", "line Bash: waiting", "fold(1) Ran 1 shell command",
            "line Bash: failed", "fold(1) Ran 1 shell command", "line Bash: sleep", "fold(1) Ran 1 shell command",
        ])
    }

    func testAnAgentAMessageCardAndAPreviewKeepTheirOwnRows() {
        var s = Session()
        s.call("Read: a", fold: read)
        s.call("Agent(look)", fold: nil, agent: "look")
        s.call("Read: b", fold: read)
        s.call("Agent replied", fold: read, message: true, agent: "look")
        s.call("Read: c", fold: read)
        s.call("Edit: f", fold: read, preview: ["title": "Update(f)", "summary": "", "body": "", "language": "diff", "plain": false, "record": false])
        s.call("Read: d", fold: read)
        XCTAssertEqual(shape(s.rows), [
            "fold(1) Read 1 file", "line Agent(look)", "fold(1) Read 1 file", "line Agent replied", "fold(1) Read 1 file", "line Edit: f", "fold(1) Read 1 file",
        ])
    }

    func testACallThatReturnedAnImageKeepsItsRowSoThatTheThumbnailShows() {
        var s = Session()
        s.call("Read: a", fold: read)
        let shot = s.call("Read: shot.png", fold: read)
        s.call("Read: b", fold: read)
        XCTAssertEqual(shape(s.rows), ["fold(3) Read 3 files"], "no image yet: it folds")
        s.image(of: shot)
        XCTAssertEqual(shape(s.rows), ["fold(1) Read 1 file", "line Read: shot.png", "fold(1) Read 1 file"], "the thumbnail is drawn under its call, so the call keeps its row")
    }

    func testACallWithNoFoldWordsKeepsItsRow() {
        var s = Session()
        s.call("Read: a", fold: read)
        s.call("WebFetch: x", fold: nil)
        s.call("Read: b", fold: read)
        XCTAssertEqual(shape(s.rows), ["fold(1) Read 1 file", "line WebFetch: x", "fold(1) Read 1 file"], "a daemon from before the fold writes none: rows as today")
    }

    func testAWorksEndBreaksTheRun() {
        var s = Session()
        s.call(fold: ran)
        s.footer()
        s.call(fold: ran)
        XCTAssertEqual(shape(s.rows), ["fold(1) Ran 1 shell command", "fold(1) Ran 1 shell command"], "two turns, two folds")
    }

    func testACallThatEndsLeavesItsRowAndJoinsTheFoldAboveIt() {
        var s = Session()
        s.call("Bash: a")
        let running = s.call("Bash: b", status: "in_progress")
        XCTAssertEqual(shape(s.rows), ["fold(1) Ran 1 shell command", "line Bash: b"])
        s.put(11, bot, ["thread": s.prompt.hex, "task": ["title": "Bash: b", "status": "complete", "details": NSNull(), "output": NSNull(), "task": false, "message": false,
                                                         "calls": 0, "preview": NSNull(), "startedAt": NSNull(), "fold": ran] as [String: Any]], re: running)
        XCTAssertEqual(shape(s.rows), ["fold(2) Ran 2 shell commands"])
    }

    // MARK: the fold's identity

    func testAFoldKeepsTheIdOfItsFirstLineWhenACallJoinsIt() {
        var s = Session()
        s.call()
        s.call()
        let before = s.rows
        s.call()
        let after = s.rows
        XCTAssertEqual(before.count, 1)
        XCTAssertEqual(after.count, 1)
        XCTAssertEqual(before[0].id, after[0].id, "the open state is keyed by it")
        XCTAssertEqual(after[0].id, ThreadRows.id(of: { if case .line(let l) = s.thread.items[0] { l } else { fatalError("a line") } }()))
        guard case .fold(let fold) = after[0].content else { return XCTFail("a fold") }
        XCTAssertEqual(fold.lines.count, 3)
    }

    /// The ids a view's `opened` set holds after the owner clicks the fold of `rows[index]`.
    private func click(_ rows: [ThreadRow], _ index: Int, in opened: Set<String>) -> Set<String> {
        guard case .fold(let fold) = rows[index].content else { fatalError("a fold") }
        return fold.toggled(opened)
    }

    private func isOpen(_ rows: [ThreadRow], _ index: Int, in opened: Set<String>) -> Bool {
        guard case .fold(let fold) = rows[index].content else { fatalError("a fold") }
        return fold.isOpen(in: opened)
    }

    func testAnOpenFoldStaysOpenWhenAnEarlierCallOfItsRunFinishesLast() {
        var s = Session()
        // Two calls started together: the first is still running, so the run starts at the second.
        let first = s.call("Bash: slow", status: "in_progress")
        s.call("Bash: fast")
        s.call("Bash: next")
        var opened = click(s.rows, 1, in: [])
        XCTAssertTrue(isOpen(s.rows, 1, in: opened))
        s.put(11, bot, ["thread": s.prompt.hex, "task": ["title": "Bash: slow", "status": "complete", "details": NSNull(), "output": NSNull(), "task": false, "message": false,
                                                          "calls": 0, "preview": NSNull(), "startedAt": NSNull(), "fold": ran] as [String: Any]], re: first)
        XCTAssertEqual(shape(s.rows), ["fold(3) Ran 3 shell commands"])
        XCTAssertTrue(isOpen(s.rows, 0, in: opened), "the run's first line is another one now; the fold is the owner's still")
        opened = click(s.rows, 0, in: opened)
        XCTAssertFalse(isOpen(s.rows, 0, in: opened), "a second click closes it, whichever line the open state was recorded for")
        XCTAssertEqual(opened, [])
    }

    func testAnOpenFoldStaysOpenWhenACallInTheMiddleFinishes() {
        var s = Session()
        s.call("Bash: a")
        let middle = s.call("Bash: b", status: "in_progress")
        s.call("Bash: c")
        XCTAssertEqual(shape(s.rows), ["fold(1) Ran 1 shell command", "line Bash: b", "fold(1) Ran 1 shell command"])
        let opened = click(s.rows, 0, in: [])
        s.put(11, bot, ["thread": s.prompt.hex, "task": ["title": "Bash: b", "status": "complete", "details": NSNull(), "output": NSNull(), "task": false, "message": false,
                                                          "calls": 0, "preview": NSNull(), "startedAt": NSNull(), "fold": ran] as [String: Any]], re: middle)
        XCTAssertEqual(shape(s.rows), ["fold(3) Ran 3 shell commands"])
        XCTAssertTrue(isOpen(s.rows, 0, in: opened))
    }

    func testAFoldTheOwnerDidNotOpenStaysClosedAndTwoFoldsAreIndependent() {
        var s = Session()
        s.call("Bash: a")
        s.text("Then.")
        s.call("Bash: b")
        let rows = s.rows
        XCTAssertEqual(shape(rows), ["fold(1) Ran 1 shell command", "message", "fold(1) Ran 1 shell command"])
        let opened = click(rows, 0, in: [])
        XCTAssertTrue(isOpen(rows, 0, in: opened))
        XCTAssertFalse(isOpen(rows, 2, in: opened))
    }

    func testTheFoldedCallsAreReadFromTheDaemonsFieldAndATornPairIsNone() {
        var s = Session()
        s.call(fold: ["only one"])
        s.call(fold: ["a", "b", "c"])
        XCTAssertEqual(shape(s.rows), ["line Bash: ls", "line Bash: ls"], "a fold that is not a pair reads as none")
    }

    // MARK: the spacing

    func testACallRowStandsEightPointsFromWhatIsAboveAndBelowIt() {
        XCTAssertEqual(PardnerMetrics.callGap, 8)
        var s = Session()
        s.text("Reading.")
        s.call(fold: read)
        s.text("Then listing.")
        s.call("Bash: running", status: "in_progress")
        s.text("Done.")
        let rows = s.rows
        XCTAssertEqual(shape(rows), ["message", "fold(1) Read 1 file", "message", "line Bash: running", "message"])
        XCTAssertEqual(rows.map(\.gapAbove), [PardnerMetrics.messageGap, 8, 8, 8, 8], "the head, then a fold, a text under a call, a call and a text under it")
        XCTAssertEqual(rows.map { ThreadRow.stack + $0.offset }, rows.map(\.gapAbove), "each row corrects the stack's spacing to its own gap")
    }

    func testACallThatOpensTheRepliesHeadKeepsTheMessageGapAboveAndEightBelow() {
        var s = Session()
        s.call(fold: read)
        s.text("After.")
        let rows = s.rows
        XCTAssertTrue(rows[0].showsHead)
        XCTAssertEqual(rows.map(\.gapAbove), [PardnerMetrics.messageGap, 8])
    }

    func testAHeadlessRowUnderACallStandsEightPointsToo() {
        var s = Session()
        s.call(fold: read)
        s.text("The daemon's own line.")
        s.call("Bash: running", status: "in_progress")
        s.text("Another.")
        let rows = ThreadRows.build(s.thread, isSystem: { _ in true })
        XCTAssertEqual(shape(rows), ["fold(1) Read 1 file", "message", "line Bash: running", "message"])
        XCTAssertEqual(rows.map(\.showsHead), [true, false, false, false])
        XCTAssertEqual(rows.map(\.gapAbove), [PardnerMetrics.messageGap, 8, 8, 8], "a system event under a call, as a text is")
        let plain = ThreadRows.build(s.thread, isSystem: { _ in false })
        XCTAssertEqual(plain.map(\.gapAbove)[1], 8)
        var t = Session()
        t.text("One.")
        let card = ThreadRows.build(t.thread, isSystem: { _ in true })
        XCTAssertEqual(card.map(\.gapAbove), [PardnerMetrics.cardGap], "under no call a head-less row keeps the card gap")
    }

    func testTwoTextsWithNoCallBetweenKeepTheGroupGap() {
        var s = Session()
        s.text("One.")
        s.text("Two.")
        XCTAssertEqual(s.rows.map(\.gapAbove), [PardnerMetrics.messageGap, PardnerMetrics.groupGap], "no call, no change")
    }

    // MARK: the fold row

    func testTheFoldRowIsInter12AndAHalfWithACheckAndAChevronThatTurns() {
        XCTAssertEqual(FoldLook.fontSize, 12.5)
        XCTAssertEqual(FoldLook.chevron, "chevron.right")
        XCTAssertEqual([FoldLook.rotation(open: true), FoldLook.rotation(open: false)], [90, 0])
        XCTAssertEqual(FoldLook.mark, "\u{2713}")
        XCTAssertEqual([FoldLook.listIndent, FoldLook.listPadding, FoldLook.ruleWidth], [16, 10, 1], "details 16 in with a 1 point guide")
    }

    // MARK: inline code

    func testInlineCodeHasARadiusAndFourPointsOfPaddingAndNoBorder() {
        XCTAssertEqual(PardnerMetrics.codeRadius, 4)
        XCTAssertEqual(PardnerMetrics.codePad, 4)
        XCTAssertEqual(InlineCodeText.edge, 1, "the ground reaches a point above and below the text")
        XCTAssertEqual(InlineCodeText.inset, 5, "the padding and the edge: the ground's size is what it was with a border")
    }

    func testAnInlineCodeSpanStandsOnItsOwnGround() {
        let runs = CodeSpans.styled("Run `ls` now.").runs.compactMap(\.backgroundColor)
        XCTAssertEqual(runs, [PardnerColor.codeInline])
    }

    func testACodeSpanLosesItsSquareGroundAndWidensItsNeighbours() {
        let pieces = InlineCodeText.pieces(CodeSpans.styled("Run `ls` now."))
        XCTAssertEqual(pieces.map { String($0.text.characters) }, ["Run ", "ls", " now."])
        XCTAssertEqual(pieces.map { $0.ground != nil }, [false, true, false])
        XCTAssertTrue(pieces[1].text.runs.allSatisfy { $0.backgroundColor == nil }, "the ground is drawn rounded, from the layout")
        XCTAssertEqual(pieces[0].text.runs.last?.kern, InlineCodeText.inset, "the space before the span is widened")
        XCTAssertEqual(pieces[1].text.runs.last?.kern, InlineCodeText.inset, "and the span's last character")
        XCTAssertNil(pieces[2].text.runs.last?.kern)
    }

    func testATextWithNoCodeIsOnePieceAndAKernIsAddedOnlyNextToCode() {
        XCTAssertEqual(InlineCodeText.pieces(AttributedString("plain")).count, 1)
        let first = InlineCodeText.pieces(CodeSpans.styled("`a` and `b`"))
        XCTAssertEqual(first.map { $0.ground != nil }, [true, false, true])
        XCTAssertEqual(first[0].text.runs.last?.kern, InlineCodeText.inset, "a span at the start has nothing before it to widen, only its own end")
        XCTAssertEqual(first[1].text.runs.last?.kern, InlineCodeText.inset, "the space before the second span is widened")
    }

    // MARK: where the code ground is drawn

    private func plain(_ minX: CGFloat, _ maxX: CGFloat) -> InlineCodeText.Fragment { .init(rect: CGRect(x: minX, y: 0, width: maxX - minX, height: 16), ground: nil) }
    private func code(_ minX: CGFloat, _ maxX: CGFloat) -> InlineCodeText.Fragment { .init(rect: CGRect(x: minX, y: 0, width: maxX - minX, height: 16), ground: .red) }

    func testASpanInsideALineTakesItsLeftRoomFromTheKernOfTheCharacterBeforeIt() {
        let boxes = InlineCodeText.boxes([[plain(0, 50), code(50, 80), plain(80, 120)]])
        XCTAssertEqual(boxes.map(\.rect), [CGRect(x: 45, y: -1, width: 35, height: 18)], "5 to the left; the right room is the span's own kern, already in its bounds")
    }

    func testASpanThatOpensItsLineStaysInsideTheText() {
        let boxes = InlineCodeText.boxes([[code(0, 30), plain(30, 90)]])
        XCTAssertEqual(boxes.map(\.rect), [CGRect(x: 0, y: -1, width: 30, height: 18)], "nothing is before it: the room would stand 5 points left of the text")
    }

    func testAWrappedSpanKeepsItsLeftRoomOnTheFirstLineAndGetsItsRightRoom() {
        let boxes = InlineCodeText.boxes([[plain(0, 40), code(40, 100)], [code(0, 20), plain(20, 60)]])
        XCTAssertEqual(boxes.map(\.rect), [CGRect(x: 35, y: -1, width: 70, height: 18), CGRect(x: 0, y: -1, width: 20, height: 18)],
                       "the first fragment: 5 to the left and 5 to the right, which no kern gives it; the second opens its line and holds the span's end")
    }

    func testASpanThatWrapsOverThreeLinesGivesTheMiddleOneItsRightRoomAndNoLeftRoom() {
        let boxes = InlineCodeText.boxes([[plain(0, 10), code(10, 100)], [code(0, 100)], [code(0, 30), plain(30, 60)]])
        XCTAssertEqual(boxes.map(\.rect.minX), [5, 0, 0])
        XCTAssertEqual(boxes.map(\.rect.width), [100, 105, 30])
    }

    func testTwoSpansOnALineAreTwoGroundsAndASpanEndingTheLineHasNoRightRoomToAdd() {
        let boxes = InlineCodeText.boxes([[plain(0, 10), code(10, 40), plain(40, 50), code(50, 90)], [plain(0, 30)]])
        XCTAssertEqual(boxes.map(\.rect.minX), [5, 45])
        XCTAssertEqual(boxes.map(\.rect.width), [35, 45], "the next line opens with no span: this one does not wrap on")
    }
}
