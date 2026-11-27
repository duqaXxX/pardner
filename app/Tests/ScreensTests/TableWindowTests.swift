// A table that does not fit its column (wide-table preview, 2026-11-27): the pane shows the columns that fit and a footer, never a sideways
// scroll view, and the table window holds the whole table.
import AppKit
@testable import Conversation
import DesignSystem
import Foundation
@testable import Screens
import SwiftUI
import XCTest

@MainActor
final class TableWindowTests: XCTestCase {
    /// A table of `columns` columns of `cell`, a header and `rows - 1` body rows.
    private func grid(columns: Int, cell: String, rows: Int = 3) -> String {
        func row(_ cells: [String]) -> String { "| " + cells.joined(separator: " | ") + " |" }
        let header = row((0..<columns).map { "h\($0)" })
        let rule = row(Array(repeating: "---", count: columns))
        let body = (0..<rows - 1).map { _ in row(Array(repeating: cell, count: columns)) }
        return ([header, rule] + body).joined(separator: "\n")
    }

    /// The ideal size of `root` laid out `width` wide (nil: unconstrained) in an offscreen window, and how many of its scroll views have a horizontal scroller.
    private func measure<V: View>(_ root: V, width: CGFloat? = nil) -> (size: CGSize, scrollers: Int) {
        _ = NSApplication.shared
        PardnerFonts.register()
        let hosting = ScrollHost.host(root.frame(width: width))
        defer { hosting.window?.orderOut(nil) }
        hosting.layoutSubtreeIfNeeded()
        return (hosting.fittingSize, horizontalScrollers(in: hosting))
    }

    private func horizontalScrollers(in view: NSView) -> Int {
        let own = (view as? NSScrollView).map { $0.hasHorizontalScroller ? 1 : 0 } ?? 0
        return own + view.subviews.reduce(0) { $0 + horizontalScrollers(in: $1) }
    }

    // MARK: which columns are drawn

    func testTheColumnsThatFitWholeAreDrawnFromTheLeft() {
        XCTAssertEqual(TableFit.drawn(natural: [100, 80, 60], in: 400), 3)
        XCTAssertEqual(TableFit.drawn(natural: [100, 80, 60], in: 196), 2, "100, a gap of 16 and 80")
        XCTAssertEqual(TableFit.drawn(natural: [100, 80, 60], in: 195), 1, "a column is never drawn part way")
        XCTAssertEqual(TableFit.drawn(natural: [100, 80, 60], in: 200, reserve: 10), 1, "the room kept for the fade is not used")
    }

    func testTheFirstColumnIsDrawnEvenWhenItIsWiderThanTheTable() {
        XCTAssertEqual(TableFit.drawn(natural: [900, 80], in: 300), 1)
        XCTAssertEqual(TableFit.drawn(natural: [900, 80], in: 0), 1)
    }

    func testAColumnAfterOneThatDoesNotFitIsNotDrawnEvenIfItWould() {
        XCTAssertEqual(TableFit.drawn(natural: [100, 300, 20], in: 250), 1)
    }

    func testTheFooterCountsTheColumnsNotDrawn() {
        XCTAssertEqual(TableFit.footer(hidden: 5), "+5 columns \u{00B7} Open table")
        XCTAssertEqual(TableFit.footer(hidden: 1), "+1 column \u{00B7} Open table")
        XCTAssertEqual(TableFit.footer(hidden: 0), "Open table", "a single column cut by the fade")
    }

    // MARK: the pane

    func testATableThatFitsIsDrawnWholeWithNoFooter() {
        // Three rows of 32 points and two rules of 1: nothing under them.
        let fits = "| File | Lines |\n|---|---|\n| a.ts | 1,204 |\n| b.ts | 88 |"
        XCTAssertEqual(measure(MarkdownView(text: fits), width: 400).size.height, 98, accuracy: 0.5)
    }

    func testATableThatDoesNotFitHasNoSideScrollAndStandsOnItsRowsAndAFooter() {
        let wide = grid(columns: 20, cell: "abcdefghijklmnopqrst")
        let (size, scrollers) = measure(MarkdownView(text: wide), width: 400)
        XCTAssertEqual(scrollers, 0, "no sideways scroll view, so no bar")
        let height = size.height
        XCTAssertGreaterThan(height, 98 + 12, "the rows and a footer under them")
        XCTAssertLessThan(height, 98 + 60, "the rows are not wrapped: every row is one line")
    }

    func testAPreviewShowsEveryRowOfATallTable() {
        let tall = grid(columns: 20, cell: "abcdefghijklmnopqrst", rows: 30)
        let few = grid(columns: 20, cell: "abcdefghijklmnopqrst", rows: 3)
        let gain = measure(MarkdownView(text: tall), width: 400).size.height - measure(MarkdownView(text: few), width: 400).size.height
        XCTAssertEqual(gain, 27 * 33, accuracy: 0.5, "27 more rows of 32 points and a rule each")
    }

    func testThePreviewKeepsTheRowRuleOfTheFittedTable() {
        // Cells of 29 points, taller than the 32 point row less its padding: a row is the cell and 6 points above and under, in both layouts.
        func height(_ text: String) -> CGFloat { measure(MarkdownView(text: text, size: 30), width: 400).size.height }
        let preview = height(grid(columns: 20, cell: "abcdefghijklmnopqrst"))
        let fitted = height(grid(columns: 1, cell: "abcdefghijklmnopqrst"))
        XCTAssertGreaterThan(preview - fitted, 12, "the same three rows and a footer")
        XCTAssertLessThan(preview - fitted, 60)
    }

    // MARK: the window

    func testOpeningPassesTheWholeTable() throws {
        let text = "Intro\n\n" + grid(columns: 20, cell: "abcdefghijklmnopqrst", rows: 4)
        let content = TableContent(text: text, piece: 1)
        let table = try XCTUnwrap(content.table)
        XCTAssertEqual(table.columns, 20)
        XCTAssertEqual(table.rows.count, 4)
        XCTAssertNil(TableContent(text: text, piece: 0).table, "a paragraph is no table")
        XCTAssertNil(TableContent(text: text, piece: 7).table)
    }

    func testTheWindowIsTitledByTheFirstHeadersAndCopiesTheTableAsMarkdown() throws {
        let content = TableContent(text: "| File | Lines | Owner | Extra |\n|---|---|---|---|\n| a\\|b | 1 | x | y |", piece: 0)
        XCTAssertEqual(content.title, "File, Lines, Owner")
        XCTAssertEqual(content.markdown, "| File | Lines | Owner | Extra |\n|---|---|---|---|\n| a\\|b | 1 | x | y |")
        XCTAssertEqual(TableContent(text: "text", piece: 0).title, "Table")
    }

    func testTheWindowIsAsWideAsTheTableWithinTheScreenAndScrollsPastIt() {
        let wide = grid(columns: 20, cell: "abcdefghijklmnopqrst")
        let window = measure(TableWindow(content: TableContent(text: wide, piece: 0)))
        let screen = NSScreen.main?.visibleFrame.size ?? CGSize(width: 1440, height: 900)
        XCTAssertGreaterThan(window.size.width, 600, "wider than a pane")
        XCTAssertLessThanOrEqual(window.size.width, screen.width, "within the screen")
        // No cell wraps: the three rows are one line each.
        XCTAssertLessThan(window.size.height, 98 + 80)
        XCTAssertGreaterThan(window.scrollers, 0, "past the screen it scrolls with the system's bars (and this count sees a horizontal scroller)")
        XCTAssertGreaterThan(measure(MarkdownView(text: wide, only: 0)).size.width, 400, "the table is not fitted to the width it is offered")
    }
}
