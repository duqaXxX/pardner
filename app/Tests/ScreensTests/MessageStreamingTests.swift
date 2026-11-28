// A message that grows in its text view (#194, unit 3c, design 10.5): the source compared, the first changed piece found by comparing pieces, the storage replaced from
// that piece's start, and the selection kept above it and cut at it. Rendered offscreen on macOS 27 (this Mac): the selection and the hosted cards are AppKit's own, so
// each assertion that reads them depends on how that system behaves; CI's macOS 15 and 26.7 answer for theirs.
import AppKit
import DesignSystem
import Foundation
@testable import Screens
import SwiftUI
import XCTest

@MainActor
final class MessageStreamingTests: XCTestCase {
    private struct Row: View {
        let text: String
        var mention: String?
        var size: CGFloat = 14
        var foldKey: String?
        var blocks = OpenBlocks()
        var body: some View { MessageText(text: text, mention: mention, size: size, foldKey: foldKey, blocks: blocks, open: { _ in }).designLines().frame(width: 400) }
    }

    /// A list, a table, a paragraph, and the piece that grows.
    private let above = "- one\n- two\n\n| Name | Size |\n|---|---|\n| a.txt | 12 |\n\nFirst paragraph above.\n\n"

    private func textView(in view: NSView) -> MessageTextView? { (view as? MessageTextView) ?? view.subviews.lazy.compactMap(textView).first }

    private func card(in view: NSView) -> NSView? {
        view.subviews.lazy.compactMap { String(describing: type(of: $0)).contains("NSHostingView") ? $0 : self.card(in: $0) }.first
    }

    private func shown(_ row: Row) throws -> (host: NSHostingView<Row>, view: MessageTextView, window: NSWindow) {
        _ = NSApplication.shared
        PardnerFonts.register()
        let host = NSHostingView(rootView: row)
        host.frame = NSRect(x: 0, y: 0, width: 400, height: 800)
        let window = NSWindow(contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        return (host, try XCTUnwrap(textView(in: host)), window)
    }

    /// The row with a new source, laid out as SwiftUI does when the answer's text grows.
    private func update(_ host: NSHostingView<Row>, _ row: Row) {
        host.rootView = row
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        host.layoutSubtreeIfNeeded()
    }

    private func range(of word: String, in view: MessageTextView) -> NSRange { (view.string as NSString).range(of: word) }

    func testASelectionAboveTheGrowingPieceIsKeptAndItsTableKeepsItsCard() throws {
        let (host, view, window) = try shown(Row(text: above + "Growing"))
        defer { withExtendedLifetime(window) {} }
        let table = try XCTUnwrap(card(in: view), "the table's card is hosted")
        let from = range(of: "two", in: view).location, to = range(of: "above", in: view).upperBound
        view.setSelectedRange(NSRange(location: from, length: to - from))
        let epoch = view.textEpoch

        update(host, Row(text: above + "Growing paragraph with more words"))

        XCTAssertGreaterThan(view.textEpoch, epoch, "the text was replaced")
        XCTAssertTrue(view.string.hasSuffix("Growing paragraph with more words"))
        XCTAssertEqual(view.selectedRange(), NSRange(location: from, length: to - from), "the selection above the growing piece stays")
        XCTAssertTrue(try XCTUnwrap(card(in: view)) === table, "the table above the changed piece keeps its card: no second load")
    }

    func testATableRightBeforeTheGrowingPieceKeepsItsCardAtEveryPart() throws {
        let table = "| Name | Size |\n|---|---|\n| a.txt | 12 |\n\n"
        for (label, prefix) in [("directly", table), ("after a paragraph", "Intro.\n\n" + table)] {
            let (host, view, window) = try shown(Row(text: prefix + "G"))
            defer { withExtendedLifetime(window) {} }
            let hosted = try XCTUnwrap(card(in: view), "\(label): the table's card is hosted")
            for word in ["Gr", "Gro", "Grow", "Growing", "Growing more", "Growing more words"] {
                update(host, Row(text: prefix + word))
                XCTAssertTrue(try XCTUnwrap(card(in: view)) === hosted, "\(label): the table keeps its card at \(word.debugDescription)")
            }
        }
    }

    func testASelectionFromTheFirstParagraphIntoTheGrowingPieceIsCutAtItsStartAndOneInsideItIsCleared() throws {
        let text = "First paragraph.\n\nSecond paragraph.\n\nGrowing"
        let (host, view, window) = try shown(Row(text: text))
        defer { withExtendedLifetime(window) {} }
        let start = range(of: "Growing", in: view).location
        view.setSelectedRange(NSRange(location: 3, length: start + 4 - 3))
        update(host, Row(text: text + " paragraph"))
        XCTAssertEqual(view.selectedRange(), NSRange(location: 3, length: start - 3), "cut at the start of the piece that grew")

        view.setSelectedRange(NSRange(location: start + 2, length: 3))
        update(host, Row(text: text + " paragraph with more"))
        XCTAssertEqual(view.selectedRange().length, 0, "a selection wholly inside it is cleared")
    }

    func testANewPieceKeepsAnEarlierSelectionAndTheLineEndBeforeIt() throws {
        let (host, view, window) = try shown(Row(text: "First paragraph.\n\nSecond paragraph."))
        defer { withExtendedLifetime(window) {} }
        view.setSelectedRange(NSRange(location: 2, length: 20))
        update(host, Row(text: "First paragraph.\n\nSecond paragraph.\n\nThird."))
        XCTAssertEqual(view.string, "First paragraph.\nSecond paragraph.\nThird.")
        XCTAssertEqual(view.selectedRange(), NSRange(location: 2, length: 20))
    }

    func testASelectionThatEndsWithTheLineEndBeforeTheChangedPieceKeepsIt() throws {
        let (host, view, window) = try shown(Row(text: "First.\n\nSecond.\n\nGrowing"))
        defer { withExtendedLifetime(window) {} }
        let start = range(of: "Growing", in: view).location
        view.setSelectedRange(NSRange(location: 0, length: start))
        update(host, Row(text: "First.\n\nSecond.\n\nGrowing more"))
        XCTAssertEqual(view.selectedRange(), NSRange(location: 0, length: start), "the line end the replacement starts at is still selected")
    }

    func testTheSameSourceLeavesTheStorageAndTheSelectionAlone() throws {
        let (host, view, window) = try shown(Row(text: above + "Growing"))
        defer { withExtendedLifetime(window) {} }
        view.setSelectedRange(NSRange(location: 2, length: 30))
        let epoch = view.textEpoch, hosted = card(in: view)
        // A new value of the row, as a parent that evaluates again makes it.
        update(host, Row(text: above + "Growing"))
        XCTAssertEqual(view.textEpoch, epoch, "nothing was set")
        XCTAssertEqual(view.selectedRange(), NSRange(location: 2, length: 30))
        XCTAssertTrue(card(in: view) === hosted)
    }

    func testAStreamedMessageEndsAsAFreshBuildIsAndAsHigh() throws {
        let full = """
        First paragraph with `code` and a [link](https://example.com/x).

        - item one
        - item two

        > quoted

        ```swift
        let x = 1
        ```

        Last words arrive here.
        """
        let (host, view, window) = try shown(Row(text: String(full.prefix(30))))
        defer { withExtendedLifetime(window) {} }
        // Every length, as the parts of an answer arrive.
        for n in stride(from: 31, through: full.count, by: 7) { update(host, Row(text: String(full.prefix(n)))) }
        update(host, Row(text: full))
        let (_, fresh, other) = try shown(Row(text: full))
        defer { withExtendedLifetime(other) {} }
        XCTAssertEqual(view.string, fresh.string)
        XCTAssertEqual(try XCTUnwrap(view.fit(width: 400)).height, try XCTUnwrap(fresh.fit(width: 400)).height)
        XCTAssertEqual(view.room.top, fresh.room.top)
        XCTAssertEqual(view.room.bottom, fresh.room.bottom)
    }

    /// What a view holds and what a copy of all of it gives: the string, whether each character carries `separated`, and the plain copy.
    private func state(of view: MessageTextView) throws -> (string: String, separated: [Bool], copy: String) {
        let storage = try XCTUnwrap(view.textStorage)
        let separated = (0..<storage.length).map { storage.attribute(MessageString.separated, at: $0, effectiveRange: nil) != nil }
        let board = NSPasteboard(name: NSPasteboard.Name("pardner-test-stream-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        board.clearContents()
        view.selectAll(nil)
        XCTAssertTrue(view.writeSelection(to: board, types: [.rtf, .string]))
        return (storage.string, separated, try XCTUnwrap(board.string(forType: .string)))
    }

    /// C1: parts that arrive in chunks change the kind of the piece at `first` (a paragraph "1" becomes a list item), and the line end of the piece
    /// before it must follow, as a fresh build has it.
    func testAStreamedMessageWhosePieceChangesKindHasTheStringTheSeparatorsAndTheCopyOfAFreshBuild() throws {
        let sequences = [
            ["- a\n\n1", "- a\n\n1. b"],
            ["- a\n\n1", "- a\n\n1. b", "- a\n\n1. b\n2. c\n\nafter"],
            ["intro\n\nx", "intro\n\n- x"],
            ["intro\n\n-", "intro\n\n- x\n- y"],
            ["intro\n\n`", "intro\n\n```\ncode\n```\n\nafter"],
            ["> q\n\nintro\n\n``", "> q\n\nintro\n\n```\ncode"],
        ]
        for parts in sequences {
            let (host, view, window) = try shown(Row(text: parts[0]))
            defer { withExtendedLifetime(window) {} }
            for part in parts.dropFirst() { update(host, Row(text: part)) }
            let (_, fresh, other) = try shown(Row(text: parts[parts.count - 1]))
            defer { withExtendedLifetime(other) {} }
            let streamed = try state(of: view), built = try state(of: fresh)
            XCTAssertEqual(streamed.string, built.string, "\(parts)")
            XCTAssertEqual(streamed.separated, built.separated, "\(parts)")
            XCTAssertEqual(streamed.copy, built.copy, "\(parts)")
        }
    }

    func testAChangeOfMentionRebuildsFromTheFirstPiece() throws {
        let (host, view, window) = try shown(Row(text: "Hello there.", mention: "@old"))
        defer { withExtendedLifetime(window) {} }
        XCTAssertTrue(view.string.hasPrefix("@old "))
        update(host, Row(text: "Hello there.", mention: "@renamed"))
        XCTAssertTrue(view.string.hasPrefix("@renamed "), view.string)
        XCTAssertFalse(view.string.contains("@old"))
    }

    func testAChangeOfSizeRebuildsFromTheFirstPiece() throws {
        let (host, view, window) = try shown(Row(text: "Hello there.\n\nSecond."))
        defer { withExtendedLifetime(window) {} }
        let before = try XCTUnwrap(view.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont).pointSize
        update(host, Row(text: "Hello there.\n\nSecond.", size: 20))
        XCTAssertEqual(try XCTUnwrap(view.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont).pointSize, 20)
        XCTAssertNotEqual(before, 20)
    }

    func testOpeningACodeBlockChangesItsPieceThoughTheTextIsTheSame() throws {
        let code = (1...40).map { "line \($0)" }.joined(separator: "\n")
        let text = "Before.\n\n```\n\(code)\n```\n\nAfter."
        let blocks = OpenBlocks()
        let (host, view, window) = try shown(Row(text: text, foldKey: "m", blocks: blocks))
        defer { withExtendedLifetime(window) {} }
        XCTAssertFalse(view.string.contains("line 40"))
        blocks.toggle(LongBlock.key(message: "m", block: 1))
        update(host, Row(text: text, foldKey: "m", blocks: blocks))
        XCTAssertTrue(view.string.contains("line 40"), "the block is open")
        XCTAssertTrue(view.string.hasSuffix("After."))
        blocks.toggle(LongBlock.key(message: "m", block: 1))
        update(host, Row(text: text, foldKey: "m", blocks: blocks))
        XCTAssertFalse(view.string.contains("line 40"), "and closed again")
    }

    func testATextTheBoundsRefuseGrowsAsOneRunAndClearsTheSelection() throws {
        let long = String(repeating: "word ", count: 3_300)
        let (host, view, window) = try shown(Row(text: long))
        defer { withExtendedLifetime(window) {} }
        view.setSelectedRange(NSRange(location: 5, length: 10))
        update(host, Row(text: long + "more"))
        XCTAssertTrue(view.string.hasSuffix("more"))
        XCTAssertEqual(view.selectedRange().length, 0, "accepted: a reply over 16,000 characters replaces its whole text at each part")
    }
}
