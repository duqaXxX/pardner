// The rule for a long block (long block rule, 2026-11-27): up to 30 lines whole, past it 24 lines and a footer, the open state kept by the block's
// identity, `Open file` only where the call's head links to its file. Over views shaped as the link delivers them; synthetic content.
@testable import Conversation
import DesignSystem
import Foundation
import ProtocolHost
@testable import Relay
@testable import Screens
import SwiftUI
import XCTest

@MainActor
final class LongBlockTests: XCTestCase {
    private func lines(_ n: Int) -> String { (1...n).map { "+line \($0)" }.joined(separator: "\n") }

    private func line(_ body: String, path: String? = "/work/a.txt", status: String = "complete") throws -> WorkLine {
        var task: [String: Any] = ["title": "Update(a.txt)", "status": status,
                                   "preview": ["title": "Update(a.txt)", "summary": "Added", "body": body, "language": "diff", "plain": false, "record": false] as [String: Any]]
        if let path { task["path"] = path }
        let fields = try XCTUnwrap(LineFields(task))
        return WorkLine(ref: MessageRef(device: Data(repeating: 2, count: 32), name: Data(repeating: 5, count: 16)), position: 5,
                        time: Date(timeIntervalSince1970: 1_700_000_000), prompt: nil, fields: fields)
    }

    private func height(of view: some View, width: CGFloat = 400) -> CGFloat {
        _ = NSApplication.shared
        PardnerFonts.register()
        let hosting = NSHostingView(rootView: view.frame(width: width))
        hosting.layoutSubtreeIfNeeded()
        return hosting.fittingSize.height
    }

    // MARK: the decision

    func testABlockOf30LinesIsWholeAndOneOf31ShowsTheFirst24WithItsCount() {
        XCTAssertEqual(LongBlock.wholeLines, 30)
        XCTAssertEqual(LongBlock.shownLines, 24)
        XCTAssertNil(LongBlock.footer(total: 30, open: false))
        XCTAssertNil(LongBlock.footer(total: 30, open: true))
        XCTAssertEqual(LongBlock.footer(total: 31, open: false), "Show all 31 lines")
        XCTAssertEqual(LongBlock.footer(total: 31, open: true), "Show less")
        XCTAssertEqual(LongBlock.head(of: lines(31)), lines(24))
        XCTAssertEqual(LongBlock.count(of: lines(31)), 31)
        XCTAssertEqual(LongBlock.count(of: lines(31) + "\n"), 31, "a final line end opens no line")
        XCTAssertEqual(LongBlock.count(of: ""), 1)
    }

    func testAPreviewCountsItsLinesAcrossItsRows() throws {
        XCTAssertEqual(LongBlock.count(of: try XCTUnwrap(line(lines(430)).fields.preview)), 430, "three rows of 200, 200 and 30")
        XCTAssertEqual(LongBlock.count(of: try XCTUnwrap(line(lines(30)).fields.preview)), 30)
        XCTAssertEqual(LongBlock.count(of: try XCTUnwrap(line(lines(200) + "\n").fields.preview)), 200, "a final line end opens no line, whatever the row it falls on")
        XCTAssertEqual(LongBlock.count(of: try XCTUnwrap(line(lines(400) + "\n").fields.preview)), 400)
    }

    func testAClosedLongBodyHasItsFirstRowAloneAndAnOpenOneAllOfThem() throws {
        let preview = try XCTUnwrap(line(lines(430)).fields.preview)
        XCTAssertEqual(LongBlock.rowsDrawn(of: preview, open: false), 1)
        XCTAssertEqual(LongBlock.rowsDrawn(of: preview, open: true), 3)
        XCTAssertEqual(LongBlock.rowsDrawn(of: try XCTUnwrap(line(lines(30)).fields.preview), open: false), 1, "a whole body is its rows")
        XCTAssertEqual(LongBlock.rowsDrawn(of: try XCTUnwrap(line(lines(250)).fields.preview), open: false), 1)
        XCTAssertEqual(LongBlock.rowsDrawn(of: try XCTUnwrap(line(lines(250)).fields.preview), open: true), 2)
    }

    // MARK: the state

    func testShowAllOpensABlockAndShowLessClosesIt() throws {
        let blocks = OpenBlocks()
        let key = LongBlock.key(of: try line(lines(40)))
        XCTAssertFalse(blocks.isOpen(key), "a block is drawn closed")
        blocks.toggle(key)
        XCTAssertTrue(blocks.isOpen(key))
        blocks.toggle(key)
        XCTAssertFalse(blocks.isOpen(key))
        XCTAssertFalse(OpenBlocks().isOpen(key), "a restart draws it closed")
    }

    func testAnOpenBlockStaysOpenWhenItsCallIsWrittenAgainWithMoreLines() throws {
        let blocks = OpenBlocks()
        let before = try line(lines(40)), after = try line(lines(80))
        blocks.toggle(LongBlock.key(of: before))
        XCTAssertEqual(LongBlock.key(of: before), LongBlock.key(of: after), "the key is the call's reference alone")
        XCTAssertTrue(blocks.isOpen(LongBlock.key(of: after)))
        let other = WorkLine(ref: MessageRef(device: before.ref.device, name: Data(repeating: 6, count: 16)), position: 6, time: before.time, prompt: nil, fields: before.fields)
        XCTAssertFalse(blocks.isOpen(LongBlock.key(of: other)), "another call's block is its own")
        XCTAssertNotEqual(LongBlock.key(message: "m", block: 0), LongBlock.key(message: "m", block: 1))
    }

    func testAnOpenBodyIsDrawnOpenWhenItsCallGrowsAndAClosedOneStaysClosed() throws {
        let blocks = OpenBlocks()
        let before = try line(lines(40)), after = try line(lines(80))
        let closed = height(of: LineBodyRow(line: after, index: 0, indent: 0, blocks: OpenBlocks()))
        let stillClosed = height(of: LineBodyRow(line: after, index: 0, indent: 0, blocks: blocks))
        XCTAssertEqual(stillClosed, closed, "a call nobody opened stays closed as it grows")
        blocks.toggle(LongBlock.key(of: before))
        let open = height(of: LineBodyRow(line: after, index: 0, indent: 0, blocks: blocks))
        XCTAssertGreaterThan(open, closed + 40 * 10, "the grown call is drawn open: its 80 lines, not 24")
        XCTAssertGreaterThan(open, height(of: LineBodyRow(line: before, index: 0, indent: 0, blocks: blocks)), "and it is longer than it was")
    }

    func testTheKeyOfAnAnswerSegmentIsItsOwnAndStableWhileItIsWritten() {
        let ref = MessageRef(device: Data(repeating: 2, count: 32), name: Data(repeating: 5, count: 16))
        let t = Date(timeIntervalSince1970: 1_700_000_000)
        let first = AnswerGroup(ref: ref, position: 4, time: t, markdown: "a", done: false)
        let second = AnswerGroup(ref: ref, position: 9, time: t, markdown: "b", done: false)
        var grown = first
        grown.markdown = "a longer text"
        XCTAssertNotEqual(LongBlock.key(of: first), LongBlock.key(of: second), "the segments of one answer share a ref and not a key")
        XCTAssertEqual(LongBlock.key(of: first), LongBlock.key(of: grown))
    }

    func testOpeningALongFenceOfOneSegmentLeavesTheSameBlockOfAnotherSegmentClosed() {
        let ref = MessageRef(device: Data(repeating: 2, count: 32), name: Data(repeating: 5, count: 16))
        let t = Date(timeIntervalSince1970: 1_700_000_000)
        let fence = "```\n" + (1...40).map { "line \($0)" }.joined(separator: "\n") + "\n```"
        let first = AnswerGroup(ref: ref, position: 4, time: t, markdown: fence, done: false)
        let second = AnswerGroup(ref: ref, position: 9, time: t, markdown: fence, done: false)
        let blocks = OpenBlocks()
        let closed = height(of: MarkdownView(text: first.shown, foldKey: LongBlock.key(of: first), blocks: blocks))
        blocks.toggle(LongBlock.key(message: LongBlock.key(of: first), block: 0))
        XCTAssertGreaterThan(height(of: MarkdownView(text: first.shown, foldKey: LongBlock.key(of: first), blocks: blocks)), closed, "the first segment's fence is open")
        XCTAssertEqual(height(of: MarkdownView(text: second.shown, foldKey: LongBlock.key(of: second), blocks: blocks)), closed, "the second segment's fence is closed still")
    }

    // MARK: the preview's rows

    func testTheClosedBodyShowsTwentyFourLinesAndTheFooterAndTheOpenBodyAllOfThem() throws {
        let blocks = OpenBlocks()
        let long = try line(lines(40))
        let h24 = height(of: LineBodyRow(line: try line(lines(24)), index: 0, indent: 0, blocks: blocks))
        let h30 = height(of: LineBodyRow(line: try line(lines(30)), index: 0, indent: 0, blocks: blocks))
        let closed = height(of: LineBodyRow(line: long, index: 0, indent: 0, blocks: blocks))
        blocks.toggle(LongBlock.key(of: long))
        let open = height(of: LineBodyRow(line: long, index: 0, indent: 0, blocks: blocks))
        let footer = closed - h24
        XCTAssertGreaterThan(footer, 10, "a footer row under the 24 lines")
        XCTAssertLessThan(footer, 40)
        let lineHeight = (h30 - h24) / 6
        XCTAssertEqual(open, h30 + 10 * lineHeight + footer, accuracy: 2, "the open body is its 40 lines and the footer")
    }

    func testALaterRowOfAClosedLongBodyDrawsNothing() throws {
        let long = try line(lines(250))
        XCTAssertEqual(height(of: LineBodyRow(line: long, index: 1, indent: 0, blocks: OpenBlocks())), 0)
    }

    func testOpenFileIsOfferedWhereTheHeadLinksToItsFileAlone() throws {
        let o = FileOpener(conversation: ConversationModel(), devices: ownBot(), send: { _, _ in .ended }, fetch: { _, _ in .gone })
        let place = FilePlace(channel: Data(repeating: 1, count: 32), thread: "t")
        XCTAssertEqual(LongBlock.file(of: try line(lines(40)), place: place, opener: o), "/work/a.txt")
        XCTAssertNil(LongBlock.file(of: try line(lines(40)), place: nil, opener: o), "no pairing, no link")
        XCTAssertNil(LongBlock.file(of: try line(lines(40)), place: place, opener: nil))
        XCTAssertNil(LongBlock.file(of: try line(lines(40), path: nil), place: place, opener: o), "a call with no path")
        XCTAssertNil(LongBlock.file(of: try line(lines(40), status: "error"), place: place, opener: o), "a failed call")
    }

    func testALongBodyOffersOpenFileInItsFooterAndALongCodeBlockDoesNot() throws {
        let o = FileOpener(conversation: ConversationModel(), devices: ownBot(), send: { _, _ in .ended }, fetch: { _, _ in .gone })
        let place = FilePlace(channel: Data(repeating: 1, count: 32), thread: "t")
        let long = try line(lines(40))
        let size = CGSize(width: 400, height: 500)
        // `Open file` is the one thing a footer with a place and an opener draws more: the same row with no place is another picture.
        let withFile = pixels(LineBodyRow(line: long, index: 0, indent: 0, place: place, blocks: OpenBlocks()).environment(o), size: size)
        let noPlace = pixels(LineBodyRow(line: long, index: 0, indent: 0, blocks: OpenBlocks()).environment(o), size: size)
        let noOpener = pixels(LineBodyRow(line: long, index: 0, indent: 0, place: place, blocks: OpenBlocks()), size: size)
        XCTAssertNotEqual(withFile, noPlace, "a call that links to its file offers Open file")
        XCTAssertEqual(noPlace, noOpener, "with no place or no opener the footer is the fold control alone")
        let code = (1...40).map { "line \($0)" }.joined(separator: "\n")
        XCTAssertEqual(pixels(CodeBlock(language: "swift", code: code, key: "m#0", blocks: OpenBlocks()).environment(o), size: size),
                       pixels(CodeBlock(language: "swift", code: code, key: "m#0", blocks: OpenBlocks()), size: size), "a code block has no Open file, an opener or not")
    }

    private func pixels(_ view: some View, size: CGSize) -> Data? {
        _ = NSApplication.shared
        PardnerFonts.register()
        let hosting = NSHostingView(rootView: view.frame(width: size.width, height: size.height, alignment: .topLeading).environment(\.colorScheme, .light))
        hosting.appearance = NSAppearance(named: .aqua)
        hosting.frame = NSRect(origin: .zero, size: size)
        hosting.layoutSubtreeIfNeeded()
        let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds)!
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        return rep.tiffRepresentation
    }

    private func ownBot() -> DevicesModel {
        var s = DevicesState()
        s.rows = [DeviceRow(id: Data(repeating: 2, count: 32), kind: .bot, label: nil, shortForm: "", adder: .none, position: 2, active: true, isThisMac: false, seenAt: nil,
                            onlyHolderEpochs: 0, addedWhileRemoving: false)]
        return DevicesModel(state: s)
    }

    // MARK: a code block

    func testACodeBlockOf30LinesIsWholeAndOneOf40ShowsItsFirst24WithAFooter() {
        let blocks = OpenBlocks()
        let l24 = (1...24).map { "line \($0)" }.joined(separator: "\n"), l30 = (1...30).map { "line \($0)" }.joined(separator: "\n"), l40 = (1...40).map { "line \($0)" }.joined(separator: "\n")
        let whole24 = height(of: CodeBlock(language: "swift", code: l24, key: "m#0", blocks: blocks))
        let whole30 = height(of: CodeBlock(language: "swift", code: l30, key: "m#0", blocks: blocks))
        let closed = height(of: CodeBlock(language: "swift", code: l40, key: "m#0", blocks: blocks))
        XCTAssertGreaterThan(closed, whole24 + 10, "the 24 lines and a footer")
        XCTAssertLessThan(closed, whole30, "a closed 40 is shorter than a whole 30 by more than the footer is high")
        blocks.toggle("m#0")
        let open = height(of: CodeBlock(language: "swift", code: l40, key: "m#0", blocks: blocks))
        XCTAssertGreaterThan(open, whole30, "open, all 40 lines")
        XCTAssertEqual(height(of: CodeBlock(language: "swift", code: l40, key: nil, blocks: OpenBlocks())), open - (closed - whole24), accuracy: 2, "no key, no fold: the 40 lines whole")
    }

    func testTheCopyButtonOfAClosedCodeBlockCopiesAllItsLines() {
        let code = (1...40).map { "line \($0)" }.joined(separator: "\n")
        var copied: String?
        let closed = CodeBlock(language: nil, code: code, copy: { copied = $0 }, key: "m#0", blocks: OpenBlocks())
        let whole = CodeBlock(language: nil, code: code, copy: { _ in }, key: nil, blocks: OpenBlocks())
        XCTAssertLessThan(height(of: closed), height(of: whole), "it draws the 24-line head: shorter than the 40 lines whole")
        closed.copyCode()
        XCTAssertEqual(copied, code, "and its copy is all 40 lines")
    }

    func testAMarkdownTextFoldsItsLongFenceByItsMessageAndBlockIndex() {
        let blocks = OpenBlocks()
        let fence = "```\n" + (1...40).map { "line \($0)" }.joined(separator: "\n") + "\n```"
        let closed = height(of: MarkdownView(text: fence, foldKey: "m", blocks: blocks))
        let whole = height(of: MarkdownView(text: fence, blocks: blocks))
        XCTAssertLessThan(closed, whole, "with a key the fence is closed; with none it is whole")
        blocks.toggle(LongBlock.key(message: "m", block: 1))
        XCTAssertEqual(height(of: MarkdownView(text: fence, foldKey: "m", blocks: blocks)), closed, "another block's state is not this one's")
        blocks.toggle(LongBlock.key(message: "m", block: 0))
        XCTAssertGreaterThan(height(of: MarkdownView(text: fence, foldKey: "m", blocks: blocks)), whole, "open: the whole fence and its footer")
    }
}
