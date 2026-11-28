// A table in the message's text view (#194, unit 3b): the shared `TableCard` hosted by the table's attachment, as high as the block path draws it in the same row,
// highlighted when the selection covers it, and opening the table's window from its preview. Rendered offscreen on macOS 27 (this Mac); what an offscreen window
// cannot show (the pointing hand over the preview, a real mouse over the hosted card) is the hand test's.
import AppKit
import Combine
@testable import Conversation
import DesignSystem
import Foundation
@testable import Screens
import SwiftUI
import XCTest

@MainActor
final class MessageTableTests: XCTestCase {
    /// A table of `columns` columns of `cell`, a header and `rows - 1` body rows.
    private func grid(columns: Int, cell: String, rows: Int = 3) -> String {
        func row(_ cells: [String]) -> String { "| " + cells.joined(separator: " | ") + " |" }
        let header = row((0..<columns).map { "h\($0)" })
        let rule = row(Array(repeating: "---", count: columns))
        let body = (0..<rows - 1).map { _ in row(Array(repeating: cell, count: columns)) }
        return ([header, rule] + body).joined(separator: "\n")
    }

    /// Its cells wrap at 400 points and wrap more at 260, so the card's height depends on the width it is given.
    private lazy var wrapping = grid(columns: 3, cell: "the quick brown fox jumps over the lazy dog")
    private let small = "| Name | Size |\n|---|---|\n| a.txt | 12 |"

    private func textView(in view: NSView) -> MessageTextView? { (view as? MessageTextView) ?? view.subviews.lazy.compactMap(textView).first }

    /// The hosting view of the table's card inside the text view.
    private func card(in view: NSView) -> NSView? {
        view.subviews.lazy.compactMap { String(describing: type(of: $0)).contains("NSHostingView") ? $0 : self.card(in: $0) }.first
    }

    /// A window that is key when told so: an offscreen window of a test process is never key (the application is not active), so the key state is set and
    /// the notifications the system would post are posted.
    private final class KeyWindow: NSWindow {
        var key = false { didSet { NotificationCenter.default.post(name: key ? NSWindow.didBecomeKeyNotification : NSWindow.didResignKeyNotification, object: self) } }
        override var isKeyWindow: Bool { key }
    }

    /// A message in a window `width` wide, in the row `.designLines()` gives, and its text view.
    private func shown(_ text: String, width: CGFloat = 400, openTable: @escaping (Int) -> Void = { _ in }) throws -> (host: NSHostingView<AnyView>, view: MessageTextView, window: KeyWindow) {
        _ = NSApplication.shared
        PardnerFonts.register()
        let host = NSHostingView(rootView: AnyView(MessageText(text: text, open: { _ in }, openTable: openTable).designLines()))
        host.frame = NSRect(x: 0, y: 0, width: width, height: 800)
        let window = KeyWindow(contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        return (host, try XCTUnwrap(textView(in: host)), window)
    }

    /// The height of the row the block path draws `text` in, `width` wide, with or without the line spacing `.designLines()` sets.
    private func blockRow(_ text: String, width: CGFloat, spaced: Bool = true) -> CGFloat {
        PardnerFonts.register()
        let row = spaced ? AnyView(MarkdownView(text: text).designLines()) : AnyView(MarkdownView(text: text))
        let host = NSHostingView(rootView: row.frame(width: width))
        host.layoutSubtreeIfNeeded()
        return host.fittingSize.height
    }

    /// The hosted card as wide as the line and, in the same row, as high as the block path's card: a view's fitting size is rounded up, so the card's height
    /// is compared with the row's after the row's own padding is added.
    private func assertSize(_ card: NSView, width: CGFloat, text: String, _ message: String, line: UInt = #line) {
        XCTAssertEqual(card.frame.width, width, message, line: line)
        XCTAssertEqual(ceil(card.frame.height + MessageRow.lineSpacing), blockRow(text, width: width), message, line: line)
    }

    /// The view a click at `point` (in `view`'s coordinates) reaches: `hitTest` takes the point in the superview's coordinates, which the theme frame shares with the window.
    private func hit(_ point: NSPoint, in view: NSView, _ window: NSWindow) -> NSView? { window.contentView?.superview?.hitTest(view.convert(point, to: nil)) }

    private func tables(in view: MessageTextView) -> [TableAttachment] {
        var out: [TableAttachment] = []
        view.textStorage?.enumerateAttribute(.attachment, in: NSRange(location: 0, length: view.textStorage?.length ?? 0)) { value, _, _ in
            if let table = value as? TableAttachment { out.append(table) }
        }
        return out
    }

    // MARK: the card's size

    func testTheHostedCardIsTheBlockPathsCardInTheSameRowAtTwoWidths() throws {
        // The row's line spacing changes the card (N1): without it the block path's card is a different height.
        XCTAssertNotEqual(blockRow(wrapping, width: 400) - MessageRow.lineSpacing, blockRow(wrapping, width: 400, spaced: false), accuracy: 1)
        for width in [CGFloat(400), 260] {
            let (_, view, window) = try shown(wrapping, width: width)
            defer { withExtendedLifetime(window) {} }
            let hosted = try XCTUnwrap(card(in: view))
            assertSize(hosted, width: width, text: wrapping, "at \(width)")
        }
        XCTAssertNotEqual(blockRow(wrapping, width: 400), blockRow(wrapping, width: 260), "the two widths are told apart")
    }

    func testTheHostedCardFollowsOneLiveViewsWidth() throws {
        let (host, view, window) = try shown(wrapping, width: 400)
        defer { withExtendedLifetime(window) {} }
        for width in [CGFloat(260), 400, 330] {
            host.setFrameSize(NSSize(width: width, height: 800))
            host.layoutSubtreeIfNeeded()
            let hosted = try XCTUnwrap(card(in: view), "a card at \(width)")
            assertSize(hosted, width: width, text: wrapping, "after the width became \(width)")
            XCTAssertEqual(view.frame.height, hosted.frame.height, "the text view is as high as its card at \(width)")
        }
    }

    /// `text` with each line quoted, and as the second block of a list item.
    private func quoted(_ text: String) -> String { text.split(separator: "\n", omittingEmptySubsequences: false).map { "> " + $0 }.joined(separator: "\n") }
    private func listed(_ text: String) -> String { "- item\n\n" + text.split(separator: "\n", omittingEmptySubsequences: false).map { "  " + $0 }.joined(separator: "\n") }

    func testATableInAListItemOrAQuoteEndsAtTheTextViewsEdgeAndIsFittedAtThatWidth() throws {
        for (name, text) in [("list item", listed(wrapping)), ("quote", quoted(wrapping))] {
            let (_, view, window) = try shown(text, width: 400)
            defer { withExtendedLifetime(window) {} }
            let hosted = try XCTUnwrap(card(in: view), name)
            let inView = hosted.convert(hosted.bounds, to: view)
            XCTAssertGreaterThan(inView.minX, 0, "\(name) starts at the indent")
            XCTAssertEqual(inView.maxX, view.bounds.width, accuracy: 0.5, "\(name): the card's right edge is the text view's")
            // The card is fitted or previewed at the width it is drawn at: as high as the block path's card of that width.
            assertSize(hosted, width: hosted.frame.width, text: wrapping, name)
        }
    }

    func testAMessageWithATableAsksForItsOwnWidthNotTheUnboundedOne() throws {
        let (_, view, window) = try shown("Before.\n\n\(small)\n\nAfter.")
        defer { withExtendedLifetime(window) {} }
        let width = try XCTUnwrap(view.fit(width: nil)).width
        XCTAssertLessThan(width, 1000, "the table's natural width, not the text container's limit")
        XCTAssertGreaterThan(width, 50)
    }

    func testTheEmptyAreaRightOfANarrowCardIsNotTheHostedViews() throws {
        let (_, view, window) = try shown("A paragraph long enough to fill the line, over a table narrower than it is, and wrapping once more.\n\n\(small)", width: 400)
        defer { withExtendedLifetime(window) {} }
        let hosted = try XCTUnwrap(card(in: view))
        XCTAssertGreaterThan(view.frame.width, hosted.frame.width + 100, "the paragraph makes the text view wider than the card")
        XCTAssertLessThan(hosted.frame.width, 300, "a card of its own width, not the line's")
        let hit = try XCTUnwrap(hit(NSPoint(x: view.frame.width - 10, y: hosted.convert(hosted.bounds, to: view).midY), in: view, window))
        XCTAssertFalse(hit.isDescendant(of: hosted), "a press there is the text view's: it selects, and shows its I-beam")
    }

    // MARK: copy

    func testASelectionAcrossATableCopiesItsRowsOneLineEach() throws {
        let (_, view, window) = try shown("Before.\n\n\(small)\n\nAfter.")
        defer { withExtendedLifetime(window) {} }
        view.selectAll(nil)
        let board = NSPasteboard(name: NSPasteboard.Name("pardner-test-table-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        board.clearContents()
        XCTAssertTrue(view.writeSelection(to: board, types: [.rtfd, .rtf, .string]))
        XCTAssertEqual(board.string(forType: .string), "Before.\n\nName\tSize\na.txt\t12\n\nAfter.")
    }

    /// The selection as copied, written to RTF and read back as a rich text field would, with the font and the line height of each paragraph.
    private func pasted(_ text: String) throws -> [(text: String, size: CGFloat, height: CGFloat)] {
        let (_, view, window) = try shown(text)
        defer { withExtendedLifetime(window) {} }
        let storage = try XCTUnwrap(view.textStorage)
        let copy = MessageTextView.copyText(of: storage.attributedSubstring(from: NSRange(location: 0, length: storage.length)))
        let rtf = try XCTUnwrap(copy.rtf(from: NSRange(location: 0, length: copy.length), documentAttributes: [:]))
        let back = try NSAttributedString(data: rtf, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil)
        let field = NSTextView(frame: NSRect(x: 0, y: 0, width: 500, height: 500))
        field.textStorage?.setAttributedString(back)
        let layout = try XCTUnwrap(field.layoutManager)
        layout.ensureLayout(for: try XCTUnwrap(field.textContainer))
        var out: [(text: String, size: CGFloat, height: CGFloat)] = []
        layout.enumerateLineFragments(forGlyphRange: NSRange(location: 0, length: layout.numberOfGlyphs)) { rect, _, _, glyphs, _ in
            let range = layout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
            var size: CGFloat = 0
            back.enumerateAttribute(.font, in: range) { value, _, _ in size = max(size, (value as? NSFont)?.pointSize ?? 12) }
            out.append(((back.string as NSString).substring(with: range), size, rect.height))
        }
        return out
    }

    func testTheCopyOfATableCarriesTheMessagesFontAndLeavesAParagraphsLineAfterIt() throws {
        let lines = try pasted("Before.\n\n\(small)\n\nAfter.")
        XCTAssertEqual(lines.map(\.text), ["Before.\n", "\n", "Name\tSize\n", "a.txt\t12\n", "\n", "After."])
        XCTAssertEqual(lines.map(\.size), [14, 14, 14, 14, 14, 14], "the rows and the blank line under them are in the font of the text around")
        XCTAssertGreaterThan(lines[4].height, 10, "the blank line after the table is a line of the paragraph's, not 1 pt")
    }

    // MARK: the selection over a table

    func testATableIsSelectedWhenTheSelectionCoversItAndNotOtherwise() throws {
        let (_, view, window) = try shown("Before.\n\n\(small)\n\nAfter.")
        defer { withExtendedLifetime(window) {} }
        let table = try XCTUnwrap(tables(in: view).first)
        let text = view.string as NSString
        let at = text.range(of: "\u{FFFC}").location
        XCTAssertFalse(table.selection.selected)
        view.setSelectedRange(NSRange(location: 0, length: at - 1))
        XCTAssertFalse(table.selection.selected, "a selection that ends before it")
        view.setSelectedRange(NSRange(location: 2, length: text.length - 2))
        XCTAssertTrue(table.selection.selected, "a selection across it")
        view.setSelectedRange(NSRange(location: at + 1, length: text.length - at - 1))
        XCTAssertFalse(table.selection.selected, "a selection that starts after it")
        view.setSelectedRange(NSRange(location: at, length: 1))
        XCTAssertTrue(table.selection.selected, "the table alone")
        view.setSelectedRange(NSRange(location: at, length: 0))
        XCTAssertFalse(table.selection.selected, "a caret is no selection")
    }

    func testTheTableIsSelectedWhileTheSelectionIsStillBeingDragged() throws {
        let (_, view, window) = try shown("Before.\n\n\(small)\n\nAfter.")
        defer { withExtendedLifetime(window) {} }
        let table = try XCTUnwrap(tables(in: view).first)
        let length = (view.string as NSString).length
        view.setSelectedRanges([NSValue(range: NSRange(location: 2, length: length - 2))], affinity: .downstream, stillSelecting: true)
        XCTAssertTrue(table.selection.selected, "a drag that is not over yet")
        view.setSelectedRanges([NSValue(range: NSRange(location: 2, length: 3))], affinity: .downstream, stillSelecting: true)
        XCTAssertFalse(table.selection.selected, "the drag came back above the table")
    }

    func testASelectionThatChangesNothingPublishesNothingToTheCards() throws {
        let (_, view, window) = try shown("Before.\n\n\(small)\n\nAfter.")
        defer { withExtendedLifetime(window) {} }
        let table = try XCTUnwrap(tables(in: view).first)
        let length = (view.string as NSString).length
        view.setSelectedRange(NSRange(location: 2, length: length - 2))
        var published = 0
        let watch = table.selection.objectWillChange.sink { published += 1 }
        defer { watch.cancel() }
        view.setSelectedRange(NSRange(location: 3, length: length - 3))
        view.setSelectedRange(NSRange(location: 4, length: length - 4))
        view.markSelectedTables()
        XCTAssertEqual(published, 0, "the table stays selected, in the same colour")
    }

    /// What SwiftUI does after a state change, which takes a turn of the run loop.
    private func settle(_ view: NSView) {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        view.layoutSubtreeIfNeeded()
    }

    /// The colour of `view` left of its header row's words, as drawn.
    private func sample(_ view: NSView) throws -> NSColor {
        settle(view)
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        let scale = CGFloat(rep.pixelsWide) / view.bounds.width
        return try XCTUnwrap(rep.colorAt(x: Int(4 * scale), y: Int(14 * scale))?.usingColorSpace(.sRGB))
    }

    private func ground(of card: NSView) throws -> NSColor { try sample(card) }

    /// `system` (a selection colour of the system, which follows the accent colour) at half opacity over `ground`, drawn in the card's appearance by a swatch that
    /// has nothing of the table in it: what the overlay must come to.
    private func overlaid(_ system: NSColor, over ground: NSColor, like card: NSView) throws -> NSColor {
        let swatch = NSHostingView(rootView: Color(nsColor: ground).overlay(Color(nsColor: system).opacity(0.5)).frame(width: 40, height: 40))
        swatch.frame = NSRect(x: 0, y: 0, width: 40, height: 40)
        // In the card's own window: the system's selection colours resolve with the state of the window they are drawn in.
        let content = try XCTUnwrap(card.window?.contentView)
        content.addSubview(swatch)
        defer { swatch.removeFromSuperview() }
        swatch.layoutSubtreeIfNeeded()
        return try sample(swatch)
    }

    private func distance(_ a: NSColor, _ b: NSColor) -> CGFloat {
        max(abs(a.redComponent - b.redComponent), abs(a.greenComponent - b.greenComponent), abs(a.blueComponent - b.blueComponent))
    }

    /// The card's ground as drawn is `system` over `ground` and not `other` over it: closer to the swatch of the one than of the other. The card's pixel is a
    /// few levels off the swatch's (about 5 of 255, measured on macOS 27.2.1, cause not found), so no exact value is asserted.
    private func assertOverlay(_ drawn: NSColor, is system: NSColor, notThe other: NSColor, over ground: NSColor, like card: NSView, _ message: String, line: UInt = #line) throws {
        let right = distance(drawn, try overlaid(system, over: ground, like: card)), wrong = distance(drawn, try overlaid(other, over: ground, like: card))
        XCTAssertLessThan(right, wrong, message, line: line)
        XCTAssertLessThan(right, 0.05, message, line: line)
    }

    func testASelectedTableIsDrawnInTheSelectionColourThatTakesNoClick() throws {
        let (_, view, window) = try shown("Before.\n\n\(small)\n\nAfter.")
        defer { withExtendedLifetime(window) {} }
        window.key = true
        XCTAssertTrue(window.makeFirstResponder(view))
        let hosted = try XCTUnwrap(card(in: view))
        // A point on a cell's text: the view a click there reaches is the cell's, with or without the overlay over it.
        let cell = NSPoint(x: 20, y: hosted.bounds.height - 12)
        let before = (try ground(of: hosted), hit(cell, in: hosted, window))
        XCTAssertNotNil(before.1)
        XCTAssertFalse(before.1 === hosted, "the point is on a cell, not on the hosting view")
        view.selectAll(nil)
        let after = (try ground(of: hosted), hit(cell, in: hosted, window))
        try assertOverlay(after.0, is: .selectedTextBackgroundColor, notThe: .unemphasizedSelectedTextBackgroundColor, over: before.0, like: hosted, "the card's ground is under the selection colour")
        XCTAssertTrue(before.1 === after.1, "the overlay is no view a click reaches")
    }

    func testTheOverlayIsTheUnemphasizedColourOnceTheWindowResignsKey() throws {
        let (_, view, window) = try shown("Before.\n\n\(small)\n\nAfter.")
        defer { withExtendedLifetime(window) {} }
        window.key = true
        XCTAssertTrue(window.makeFirstResponder(view))
        let hosted = try XCTUnwrap(card(in: view))
        let plain = try ground(of: hosted)
        view.selectAll(nil)
        let table = try XCTUnwrap(tables(in: view).first)
        XCTAssertTrue(table.selection.emphasized, "key window, first responder")
        try assertOverlay(try ground(of: hosted), is: .selectedTextBackgroundColor, notThe: .unemphasizedSelectedTextBackgroundColor, over: plain, like: hosted, "key")
        window.key = false
        XCTAssertFalse(table.selection.emphasized, "a window that is not key")
        try assertOverlay(try ground(of: hosted), is: .unemphasizedSelectedTextBackgroundColor, notThe: .selectedTextBackgroundColor, over: plain, like: hosted, "resigned")
        window.key = true
        XCTAssertTrue(table.selection.emphasized)
    }

    // MARK: the preview

    private let wide = "Intro\n\n" + { (cells: [String]) in "| " + cells.joined(separator: " | ") + " |" }((0..<20).map { "h\($0)" }) + "\n|" + String(repeating: "---|", count: 20) + "\n| " + (0..<20).map { _ in "abcdefghijklmnopqrst" }.joined(separator: " | ") + " |"

    /// A click on the middle of the hosted card.
    private func click(_ hosted: NSView, in window: NSWindow) throws {
        settle(hosted)
        let point = hosted.convert(NSPoint(x: hosted.bounds.midX, y: hosted.bounds.midY), to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
            window.sendEvent(event)
            settle(hosted)
        }
    }

    func testTheWidePreviewsButtonOpensTheTablesWindowThroughTheClosure() throws {
        var opened: [Int] = []
        let (_, view, window) = try shown(wide, openTable: { opened.append($0) })
        defer { withExtendedLifetime(window) {} }
        window.key = true
        try click(try XCTUnwrap(card(in: view)), in: window)
        XCTAssertEqual(opened, [1], "the table is the second piece")
    }

    func testACardThatIsAlreadyShownOpensTheWindowThroughTheClosureTheRowHasNow() throws {
        var first: [Int] = [], second: [Int] = []
        let (host, view, window) = try shown(wide, openTable: { first.append($0) })
        defer { withExtendedLifetime(window) {} }
        window.key = true
        let hosted = try XCTUnwrap(card(in: view))
        // The row is drawn again with a new closure, as when the message's window changes.
        host.rootView = AnyView(MessageText(text: wide, open: { _ in }, openTable: { second.append($0) }).designLines())
        settle(host)
        XCTAssertTrue(card(in: view) === hosted, "the same card is kept")
        try click(hosted, in: window)
        XCTAssertEqual(second, [1])
        XCTAssertEqual(first, [], "not the closure of the row that loaded the card")
    }

    func testAChangedLineSpacingMeasuresTheCardAgain() throws {
        let (_, view, window) = try shown(wrapping, width: 400)
        defer { withExtendedLifetime(window) {} }
        let before = try XCTUnwrap(view.fit(width: 400)).height
        // What the row does when its line spacing changes, before SwiftUI asks the text view for its size.
        view.tableEnvironment.lineSpacing += 12
        XCTAssertGreaterThan(try XCTUnwrap(view.fit(width: 400)).height, before + 20, "the cells' lines are further apart")
    }
}
