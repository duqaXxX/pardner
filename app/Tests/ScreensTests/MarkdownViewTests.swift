// The view of a bot's text (#73, step B2, design 2.1 and 2.4): a text still being written is read, what the link alert says, and a sample with
// every block drawn offscreen in both themes.
import AppKit
@testable import Conversation
import DesignSystem
import Foundation
@testable import Screens
import SwiftUI
import XCTest

@MainActor
final class MarkdownViewTests: XCTestCase {
    func testASegmentOfAnAnswerNotDoneIsDrawnAsMarkdownByTheThreadRow() {
        // The call site's own view, `AnswerRow`: a segment whose answer has not landed must lay out as the one that has.
        let text = "# Plan\n\n- one\n- **two**"
        func height(done: Bool) -> CGFloat {
            var segment = AnswerGroup(ref: MessageRef(device: Data([3]), name: Data([4])), position: 1, time: Date(), markdown: text, done: done)
            segment.last = false
            let hosting = NSHostingView(rootView: AnswerRow(model: ReadingModel(), icons: [:], answer: segment, whole: text).frame(width: 600))
            hosting.layoutSubtreeIfNeeded()
            return hosting.fittingSize.height
        }
        let raw = NSHostingView(rootView: Text(text).frame(width: 600))
        raw.layoutSubtreeIfNeeded()
        XCTAssertEqual(height(done: false), height(done: true))
        XCTAssertNotEqual(height(done: false), raw.fittingSize.height, "drawn as written, not read")
    }

    func testAFenceNotClosedYetIsOneCodeBlockToTheEnd() {
        let open = "```swift\nlet x = 1\nlet y = 2"
        guard case .read(let pieces, _) = MarkdownBlocks.read(open) else { return XCTFail("read") }
        XCTAssertEqual(pieces.count, 1)
        for height in heights(open) { XCTAssertGreaterThan(height, 30) }
    }

    func testTheAlertNamesTheRealAddressAndItsLowercasedHost() throws {
        let links = [try XCTUnwrap(URL(string: "https://Example.COM/a?b=1")), try XCTUnwrap(URL(string: "https://b.example/"))]
        let first = try XCTUnwrap(LinkConfirmation(try XCTUnwrap(URL(string: "pardner-link:0")), links: links))
        XCTAssertEqual(first.url, links[0])
        XCTAssertEqual(first.message, "https://Example.COM/a?b=1\nHost: example.com")
        XCTAssertEqual(LinkConfirmation(try XCTUnwrap(URL(string: "pardner-link:1")), links: links)?.url, links[1])
    }

    func testAnyOtherUrlOpensNothing() throws {
        let links = [try XCTUnwrap(URL(string: "https://a.example/"))]
        for url in ["pardner-link:1", "pardner-link:-1", "pardner-link:x", "pardner-link:", "https://a.example/", "file:///etc/hosts"] {
            XCTAssertNil(LinkConfirmation(try XCTUnwrap(URL(string: url)), links: links), url)
        }
    }

    func testOnlyATextBodyIsRead() {
        XCTAssertTrue(MarkdownView.reads(.text(markdown: "x", say: "say")))
        XCTAssertFalse(MarkdownView.reads(.request(title: "t", type: nil, json: "{}")))
        XCTAssertFalse(MarkdownView.reads(.answer(markdown: "x")))
    }

    /// The height `text` lays out at in each theme, 600 points wide.
    private func heights(_ text: String) -> [CGFloat] {
        [NSAppearance.Name.aqua, .darkAqua].map { name in
            let hosting = NSHostingView(rootView: MarkdownView(text: text).frame(width: 600))
            hosting.appearance = NSAppearance(named: name)
            hosting.layoutSubtreeIfNeeded()
            return hosting.fittingSize.height
        }
    }

    func testACodeBlockAndATableEachLayOutInBothThemes() {
        for text in ["```swift\nlet x = 1\n```", "| a | b |\n|---|---|\n| 1 | 2 |"] {
            guard case .read = MarkdownBlocks.read(text) else { return XCTFail("read: \(text)") }
            for height in heights(text) { XCTAssertGreaterThan(height, 30, text) }
        }
    }

    /// The colour at (x, y) of `text` drawn 400 points wide in the appearance `name`, as sRGB bytes.
    private func pixel(of text: String, _ name: NSAppearance.Name, x: Int, y: Int) -> [Int] {
        _ = NSApplication.shared
        PardnerFonts.register()
        let hosting = NSHostingView(rootView: MarkdownView(text: text).frame(width: 400, height: 200, alignment: .topLeading))
        hosting.appearance = NSAppearance(named: name)
        hosting.frame = NSRect(x: 0, y: 0, width: 400, height: 200)
        hosting.layoutSubtreeIfNeeded()
        let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds)!
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB)
        return [color?.redComponent, color?.greenComponent, color?.blueComponent].map { Int(round(($0 ?? 0) * 255)) }
    }

    func testATableCardIsAContainerWithItsHeaderOnAFaintGroundAcrossTheCard() {
        let table = "| File | Lines |\n|---|---|\n| a.ts | 1,204 |\n| b.ts | 88 |"
        for (name, theme) in [(NSAppearance.Name.aqua, \TokenPair.light), (.darkAqua, \TokenPair.dark)] {
            func hex(_ token: String) -> [Int] {
                let v = Tokens.pairs[token]![keyPath: theme]
                return [v.red, v.green, v.blue].map { Int(round($0 * 255)) }
            }
            XCTAssertEqual(pixel(of: table, name, x: 3, y: 16), hex("table-head"), "the header's ground reaches the card's edge (\(name.rawValue))")
            XCTAssertEqual(pixel(of: table, name, x: 60, y: 5), hex("table-head"), "and runs behind the cells")
            XCTAssertEqual(pixel(of: table, name, x: 3, y: 50), hex("container"), "a body row stands on the container ground")
        }
    }

    func testAWideTablesPreviewKeepsItsHeaderGroundAsOneBandAcrossTheGapsOfItsColumns() {
        let wide = "| Identifier | Description | Owner | Reviewer | Status | Estimate | Component | Branch |\n|---|---|---|---|---|---|---|---|\n"
            + "| relay-journal-flush | wait-for-the-journal-flush | alice-example | bob-example | merged | 3 | relay-store-layer | fix/relay-journal-flush |"
        for (name, theme) in [(NSAppearance.Name.aqua, \TokenPair.light), (.darkAqua, \TokenPair.dark)] {
            let v = Tokens.pairs["table-head"]![keyPath: theme]
            let head = [v.red, v.green, v.blue].map { Int(round($0 * 255)) }
            // Row 0 is 32 points high and its text sits in the middle, so y 4 is ground alone; every x of the visible width, clear of the card's rounded corners and of the fade at its right edge (24 points), is on it.
            for x in stride(from: 12, to: 352, by: 3) { XCTAssertEqual(pixel(of: wide, name, x: x, y: 4), head, "x \(x) (\(name.rawValue))") }
        }
    }

    func testAHeadingIsSemiboldLevelOneIs16On24AndTheOthersAre14On22() {
        XCTAssertEqual(MarkdownView.heading(1).size, 16)
        XCTAssertEqual(MarkdownView.heading(1).line, 24)
        for level in 2...6 {
            XCTAssertEqual(MarkdownView.heading(level).size, 14, "level \(level)")
            XCTAssertEqual(MarkdownView.heading(level).line, 22, "level \(level)")
        }
        XCTAssertEqual(MessageRow.lineSpacing, MessageRow.spacing(size: 14, line: 22))
    }

    @MainActor
    func testTheCellsOfANumericColumnSetTheirDigitsAtOneWidth() {
        PardnerFonts.register()
        let figures = MarkdownFonts.styled(AttributedString("1,204"), size: 13, weight: .regular, tabular: true)
        XCTAssertEqual(figures.runs.first?.font, PardnerFont.ui(size: 13, weight: .regular, tabular: true))
        let words = MarkdownFonts.styled(AttributedString("1,204"), size: 13, weight: .regular)
        XCTAssertEqual(words.runs.first?.font, PardnerFont.ui(size: 13, weight: .regular), "a column of words keeps the proportional digits")
        func width(_ text: String, tabular: Bool) -> CGFloat {
            let hosting = NSHostingView(rootView: Text(MarkdownFonts.styled(AttributedString(text), size: 13, weight: .regular, tabular: tabular)).fixedSize())
            hosting.layoutSubtreeIfNeeded()
            return hosting.fittingSize.width
        }
        XCTAssertEqual(width("1111", tabular: true), width("8888", tabular: true), accuracy: 0.5, "drawn, a column's figures are as wide as each other")
        XCTAssertLessThan(width("1111", tabular: false), width("8888", tabular: false) - 1)
    }

    // MARK: a code block with no language draws no empty strip (#168)

    @MainActor
    private func size(of view: some View, width: CGFloat) -> CGSize {
        _ = NSApplication.shared
        PardnerFonts.register()
        let hosting = NSHostingView(rootView: view.frame(width: width))
        hosting.layoutSubtreeIfNeeded()
        return hosting.fittingSize
    }

    @MainActor
    func testACodeBlockWithNoLanguageHasNoStripAndKeepsItsCopyButtonInTheCorner() {
        let code = "127.0.0.1 localhost"
        let text = size(of: Text(verbatim: code).font(PardnerFont.code), width: 300).height
        XCTAssertEqual(size(of: CodeBlock(language: nil, code: code), width: 300).height, text + 24, accuracy: 1, "12 points above and below the text, no header")
        XCTAssertEqual(size(of: CodeBlock(language: "", code: code), width: 300).height, text + 24, accuracy: 1, "an empty language is none")
        XCTAssertEqual(size(of: CodeBlock(language: "swift", code: code), width: 300).height, text + 28 + 2 + 12, accuracy: 1, "a named block keeps its 28 point header")
        var copied: String?
        CodeBlock(language: nil, code: code, copy: { copied = $0 }).copyCode()
        XCTAssertEqual(copied, code, "the copy action stays")
    }

    @MainActor
    func testTheCopyButtonOfAnUnnamedBlockStandsInItsTopRightCorner() {
        _ = NSApplication.shared
        PardnerFonts.register()
        let hosting = NSHostingView(rootView: CodeBlock(language: nil, code: "x").frame(width: 200, height: 60, alignment: .topLeading))
        hosting.appearance = NSAppearance(named: .aqua)
        hosting.frame = NSRect(x: 0, y: 0, width: 200, height: 60)
        hosting.layoutSubtreeIfNeeded()
        let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds)!
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        let ground = rep.colorAt(x: 100, y: 5)!.usingColorSpace(.sRGB)!
        var inked = 0
        for y in 4..<26 { for x in 166..<196 {
            let c = rep.colorAt(x: x, y: y)!.usingColorSpace(.sRGB)!
            if abs(c.redComponent - ground.redComponent) > 0.15 { inked += 1 }
        } }
        XCTAssertGreaterThan(inked, 8, "the copy icon is drawn at the top right, over the text's first line")
    }

    func testAListMarkerOfThreeDigitsKeepsItsWidthAndAGap() {
        func width(_ text: String) -> CGFloat {
            let hosting = NSHostingView(rootView: MarkdownView(text: text))
            hosting.layoutSubtreeIfNeeded()
            return hosting.fittingSize.width
        }
        // The 100th item carries `100.`. A clipped marker would give the row the width of `9.`. (Foundation keeps a list's own start:
        // `100. a` then `101. b` gives the ordinals 100 and 101.)
        func list(_ count: Int) -> String { (1...count).map { "\($0). a" }.joined(separator: "\n") }
        XCTAssertGreaterThan(width(list(100)), width(list(9)) + 5)
    }

    func testASampleWithEveryBlockLaysOutInBothThemes() {
        let text = """
        # Title

        Some *emphasis*, `code` and a [link](https://example.com/x).

        - one
          - nested
        > quoted

        ```swift
        let x = 1
        ```

        | a | b |
        |---|---|
        | 1 | 2 |

        ---
        """
        guard case .read = MarkdownBlocks.read(text) else { return XCTFail("the sample is read") }
        for height in heights(text) { XCTAssertGreaterThan(height, 150) }
    }

    // MARK: inline fonts (Inter is a variable font: SwiftUI derives no bold or italic from it)

    private func fit(_ view: some View) -> CGFloat { NSHostingView(rootView: view.fixedSize()).fittingSize.width }

    private func styled(_ markdown: String, size: CGFloat = 14, weight: InterWeight = .regular) throws -> AttributedString {
        guard case .read(let pieces, _) = MarkdownBlocks.read(markdown), case .paragraph(let text) = pieces[0].body
        else { throw XCTSkip("not a paragraph") }
        return MarkdownFonts.styled(text, size: size, weight: weight)
    }

    func testStrongRunIsDrawnHeavierThanPlain() throws {
        PardnerFonts.register()
        let plain = try styled("Medio Oriente Medio Oriente")
        let strong = try styled("**Medio Oriente Medio Oriente**")
        XCTAssertGreaterThan(fit(Text(strong)), fit(Text(plain)) + 2)
    }

    func testEmphasizedRunUsesTheItalicFace() throws {
        PardnerFonts.register()
        let plain = try styled("Medio Oriente Medio Oriente")
        let italic = try styled("*Medio Oriente Medio Oriente*")
        XCTAssertNotEqual(fit(Text(italic)), fit(Text(plain)))
        XCTAssertNotEqual(italic.runs.first?.font, plain.runs.first?.font)
    }

    func testStrongAndEmphasisCombineAndStrikethroughIsKept() throws {
        PardnerFonts.register()
        let both = try styled("***ab***")
        XCTAssertEqual(both.runs.first?.font, PardnerFont.ui(size: 14, weight: .semibold, italic: true))
        let struck = try styled("~~ab~~")
        XCTAssertEqual(struck.runs.first?.strikethroughStyle, .single)
    }

    func testAHeadingRunKeepsItsSizeAndStrongGoesBold() throws {
        PardnerFonts.register()
        let heading = try styled("**ab**", size: 18, weight: .semibold)
        XCTAssertEqual(heading.runs.first?.font, PardnerFont.ui(size: 18, weight: .bold))
    }

    func testACodeSpanKeepsItsFont() throws {
        PardnerFonts.register()
        let code = try styled("`ab`")
        XCTAssertEqual(code.runs.first?.font, PardnerFont.mono(size: 12.5, weight: .regular))
    }

    func testTheTableHeaderRowIsDrawnSmallerAndHeavierThanABodyRow() throws {
        PardnerFonts.register()
        let word = "Medio Oriente Medio Oriente"
        // The header's 12 point semibold words are narrower than the body's 13 point regular ones, so at a width between the two only a body cell wraps.
        let header = fit(Text(try styled(word, size: 12, weight: .semibold))), body = fit(Text(try styled(word, size: 13)))
        XCTAssertGreaterThan(body, header + 2)
        func height(_ table: String) -> CGFloat {
            // The cell's padding of 12 on each side.
            let hosting = NSHostingView(rootView: MarkdownView(text: table).frame(width: ((header + body) / 2).rounded() + 24))
            hosting.layoutSubtreeIfNeeded()
            return hosting.fittingSize.height
        }
        XCTAssertGreaterThan(height("| x |\n| --- |\n| \(word) |"), height("| \(word) |\n| --- |\n| x |") + 10)
    }

    // MARK: the gaps between an answer's blocks (#73, step F, design FA 3.4; the reading pass)

    private func piece(_ body: MarkdownBlocks.Body = .paragraph(AttributedString("p")), depth: Int = 0, bars: Int = 0, marker: String? = nil) -> MarkdownBlocks.Piece {
        MarkdownBlocks.Piece(depth: depth, bars: bars, marker: marker, body: body)
    }

    private var heading: MarkdownBlocks.Body { .heading(level: 2, AttributedString("h")) }
    private var code: MarkdownBlocks.Body { .code(language: nil, text: "x") }
    private var table: MarkdownBlocks.Body { .table(MarkdownBlocks.Table(columns: 1, rows: [[AttributedString("a")], [AttributedString("b")]])) }

    func testTheGapBeforeAHeadingIs16AndTheOneAfterIt6() {
        XCTAssertEqual(MarkdownView.gap(from: piece(), to: piece(heading)), 16)
        XCTAssertEqual(MarkdownView.gap(from: piece(heading), to: piece(heading)), 16, "a heading after a heading: the first rule wins")
        XCTAssertEqual(MarkdownView.gap(from: piece(heading), to: piece()), 6)
        XCTAssertEqual(MarkdownView.gap(from: piece(heading), to: piece(depth: 1, marker: "•")), 6, "a list under a heading")
    }

    func testListItemsStand4ApartAndEveryOtherPairOfPieces10() {
        let item = piece(depth: 1, marker: "•")
        XCTAssertEqual(MarkdownView.gap(from: item, to: piece(depth: 1, marker: "•")), 4)
        XCTAssertEqual(MarkdownView.gap(from: item, to: piece(depth: 2, marker: "•")), 4, "a nested item")
        XCTAssertEqual(MarkdownView.gap(from: piece(depth: 2, marker: "•"), to: piece(depth: 1, marker: "•")), 4)
        XCTAssertEqual(MarkdownView.gap(from: piece(), to: piece()), 10, "two paragraphs")
        XCTAssertEqual(MarkdownView.gap(from: piece(), to: item), 10, "a list after a paragraph")
        XCTAssertEqual(MarkdownView.gap(from: item, to: piece()), 10, "a paragraph after a list")
        XCTAssertEqual(MarkdownView.gap(from: item, to: piece(depth: 1)), 10, "the second paragraph of an item has no marker")
        XCTAssertEqual(MarkdownView.gap(from: piece(), to: piece(.rule)), 10)
        XCTAssertEqual(MarkdownView.gap(from: piece(.rule), to: piece()), 10)
    }

    func testTheGapsAreTheTokens() {
        XCTAssertEqual([PardnerMetrics.paragraphGap, PardnerMetrics.blockGap, PardnerMetrics.itemGap], [10, 12, 4])
        XCTAssertEqual([PardnerMetrics.headingBefore, PardnerMetrics.headingAfter], [16, 6])
    }

    func testACodeBlockATableAndAQuoteStand12FromWhatIsBeforeAndAfterThem() {
        for block in [code, table] {
            XCTAssertEqual(MarkdownView.gap(from: piece(), to: piece(block)), 12, "before")
            XCTAssertEqual(MarkdownView.gap(from: piece(block), to: piece()), 12, "after")
            XCTAssertEqual(MarkdownView.gap(from: piece(block), to: piece(block)), 12, "two blocks")
        }
        XCTAssertEqual(MarkdownView.gap(from: piece(), to: piece(depth: 1, bars: 1)), 12, "a quote starts")
        XCTAssertEqual(MarkdownView.gap(from: piece(depth: 1, bars: 1), to: piece()), 12, "a quote ends")
        XCTAssertEqual(MarkdownView.gap(from: piece(depth: 1, bars: 1), to: piece(depth: 2, bars: 2)), 12, "a quote inside a quote")
        XCTAssertEqual(MarkdownView.gap(from: piece(heading), to: piece(code)), 6, "a heading's own gap wins")
    }

    func testACodeBlockOrATableInAnItemStands12FromItsNeighbours() {
        let item = piece(depth: 1, marker: "•")
        XCTAssertEqual(MarkdownView.gap(from: item, to: piece(code, depth: 1, marker: "•")), 12, "an item that starts with a code block")
        XCTAssertEqual(MarkdownView.gap(from: item, to: piece(table, depth: 1)), 12)
        XCTAssertEqual(MarkdownView.gap(from: piece(code, depth: 1, marker: "•"), to: piece(depth: 1, marker: "•")), 12, "the next item after a code block")
        XCTAssertEqual(MarkdownView.gap(from: piece(table, depth: 1, marker: "•"), to: piece(depth: 1, marker: "•")), 12)
    }

    func testAQuotesParagraphsAreTenApartAndItsBarRunsThroughTheGap() {
        let quoted = piece(depth: 1, bars: 1)
        XCTAssertEqual(MarkdownView.gap(from: quoted, to: quoted), 10)
        let shared = MarkdownView.gaps(from: quoted, to: quoted)
        XCTAssertEqual(shared.content, 10)
        XCTAssertEqual(shared.bars, [0], "the bar both pieces have is not pushed down: it runs through the gap")
        let item = piece(depth: 2, bars: 1, marker: "•")
        XCTAssertEqual(MarkdownView.gap(from: item, to: piece(depth: 2, bars: 1, marker: "•")), 4, "a list inside a quote")
    }

    func testAQuoteThatStartsAfterAParagraphLeavesItsBarAtTheTopOfItsText() {
        let started = MarkdownView.gaps(from: piece(), to: piece(depth: 1, bars: 1))
        XCTAssertEqual(started.content, 12)
        XCTAssertEqual(started.bars, [12], "the bar starts where the quote's text does")
        let deeper = MarkdownView.gaps(from: piece(depth: 1, bars: 1), to: piece(depth: 2, bars: 2))
        XCTAssertEqual(deeper.bars, [0, 12], "the outer bar runs on, the new inner one starts at the text")
        let first = MarkdownView.gaps(from: nil, to: piece(depth: 1, bars: 1))
        XCTAssertEqual(first.content, 0, "the first piece has no gap")
        XCTAssertEqual(first.bars, [0])
    }

    func testAListIsIndented20WithAHangingBulletAndAQuoteHasA2PointBarAnd12OfPadding() {
        XCTAssertEqual([MarkdownView.listStep, MarkdownView.barWidth, MarkdownView.barGap], [20, 2, 12])
    }

    // MARK: a table takes the column's width, or shows a preview (design FA 3.3, wide-table preview)

    func testBoundsAFractionNarrowerThanTheNaturalWidthsKeepThem() {
        XCTAssertEqual(TableFit.widths(natural: [100, 80], floors: [90, 80], in: 195.6), [100, 80], "0.4 point under the natural sum and the gap")
        XCTAssertNotEqual(TableFit.widths(natural: [100, 80], floors: [90, 80], in: 190), [100, 80], "5 points under it is shared")
    }

    func testAColumnKeepsItsNaturalWidthWhenTheTableFits() {
        XCTAssertEqual(TableFit.widths(natural: [100, 80], floors: [90, 80], in: 300), [100, 80])
        XCTAssertEqual(TableFit.widths(natural: [100, 80], floors: [90, 80], in: 196), [100, 80], "exactly the natural widths and the gap")
    }

    func testTheIdealWidthIsTheFloors() {
        XCTAssertEqual(TableFit.widths(natural: [300, 50], floors: [90, 50], in: nil), [90, 50])
        XCTAssertEqual(TableFit.extent(of: [90, 50]), 156, "the floors and one gap of 16")
    }

    func testNarrowerColumnsShareTheWidthByTheirNaturalWidth() {
        XCTAssertEqual(TableFit.widths(natural: [200, 200], floors: [90, 90], in: 316), [150, 150])
        let uneven = TableFit.widths(natural: [300, 100], floors: [90, 90], in: 316)
        XCTAssertEqual(uneven, [210, 90], "100 of 400 of the 300 left is 75, under its floor of 90: held there, the first takes the rest")
    }

    func testAColumnThatWouldFallUnderItsFloorIsHeldThereAndTheRestSharedAgain() {
        // 368 left: shared by 300:100:100 gives 220.8, 73.6, 73.6; the two small ones are held at 90, the first takes the 188 left.
        XCTAssertEqual(TableFit.widths(natural: [300, 100, 100], floors: [90, 90, 90], in: 400), [188, 90, 90])
        // A floor is never above the natural width: a column of 40 is held at 40, not 90.
        XCTAssertEqual(TableFit.widths(natural: [40, 400], floors: [40, 90], in: 316), [40, 260])
    }

    func testTheFloorsThatDoNotFitNeverGiveANegativeWidth() {
        for width in [CGFloat(0), 40, 100] {
            for column in TableFit.widths(natural: [300, 300, 300], floors: [90, 90, 90], in: width) { XCTAssertGreaterThanOrEqual(column, 0) }
        }
    }

    /// The height of `text` laid out `width` wide.
    private func height(of text: String, width: CGFloat) -> CGFloat {
        let hosting = NSHostingView(rootView: MarkdownView(text: text).frame(width: width))
        hosting.layoutSubtreeIfNeeded()
        return hosting.fittingSize.height
    }

    private func grid(columns: Int, cell: String, rows: Int = 3) -> String {
        func row(_ cells: [String]) -> String { "| " + cells.joined(separator: " | ") + " |" }
        let header = row((0..<columns).map { "h\($0)" })
        let rule = row(Array(repeating: "---", count: columns))
        let body = (0..<rows - 1).map { _ in row(Array(repeating: cell, count: columns)) }
        return ([header, rule] + body).joined(separator: "\n")
    }

    func testATableThatNeedsToWrapIsFittedToTheColumn() {
        PardnerFonts.register()
        let wide = grid(columns: 3, cell: "the quick brown fox jumps over the lazy dog")
        let oneLine = height(of: wide, width: 4000)
        let fitted = height(of: wide, width: 400)
        XCTAssertGreaterThan(fitted, oneLine + 20, "its cells wrap in the 400 points")
    }

    // MARK: a code block

    func testALongCodeLineWrapsInsideTheBox() {
        PardnerFonts.register()
        let text = "```\n" + String(repeating: "abcdefghij", count: 20) + "\n```"
        XCTAssertGreaterThan(height(of: text, width: 300), height(of: text, width: 900) + 20, "200 characters do not fit one line in 300 points")
    }

    func testABlockWithNoLanguageDrawsNoHeaderStrip() {
        PardnerFonts.register()
        let plain = height(of: "```\nlet x = 1\n```", width: 400), named = height(of: "```swift\nlet x = 1\n```", width: 400)
        XCTAssertGreaterThanOrEqual(named - plain, 16, "the 28 point header of a named block is not drawn on a block with none (its text also starts 10 points higher)")
    }

    func testTheCopyButtonCopiesTheCodeAsDrawn() throws {
        let text = "```ts\na\u{200B}b\n```"
        guard case .read(let pieces, _) = MarkdownBlocks.read(text), case .code(let language, let code) = pieces[0].body
        else { return XCTFail("a code block") }
        XCTAssertEqual(language, "ts")
        XCTAssertTrue(code.contains("[U+200B]"), "what is drawn names the invisible character")
        var copied: [String] = []
        CodeBlock(language: language, code: code, copy: { copied.append($0) }).copyCode()
        XCTAssertEqual(copied, ["a[U+200B]b"], "the copy is the text as drawn, as a selection of it")
    }

    // MARK: the answer's width

    func testABotsAnswerIsNeverWiderThan680() {
        PardnerFonts.register()
        let text = (0..<60).map { "word\($0)" }.joined(separator: " ")
        func height(_ width: CGFloat) -> CGFloat {
            var segment = AnswerGroup(ref: MessageRef(device: Data([3]), name: Data([4])), position: 1, time: Date(), markdown: text, done: true)
            segment.last = false
            let hosting = NSHostingView(rootView: AnswerRow(model: ReadingModel(), icons: [:], answer: segment, whole: text).frame(width: width))
            hosting.layoutSubtreeIfNeeded()
            return hosting.fittingSize.height
        }
        XCTAssertGreaterThan(height(500), height(800), "narrower than the cap: the text wraps at the column")
        XCTAssertEqual(height(800), height(1400), "wider than the cap: the text keeps its 680")
    }
}

@MainActor
final class MentionLabelTests: XCTestCase {
    /// The pixels of the mention's ground (`mention-bg`, light) in a rendering of `view`, as the points of their columns and rows, and the size the view takes at that width.
    private func gold(_ view: some View, _ size: CGSize) throws -> (columns: [CGFloat], rows: [CGFloat], fitting: CGSize) {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let hosting = NSHostingView(rootView: view.frame(width: size.width, height: size.height, alignment: .topLeading))
        hosting.appearance = NSAppearance(named: .aqua)
        hosting.frame = NSRect(origin: .zero, size: size)
        hosting.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        let scale = CGFloat(rep.pixelsWide) / size.width
        var columns = Set<Int>(), rows = Set<Int>()
        for y in 0..<rep.pixelsHigh {
            for x in 0..<rep.pixelsWide {
                guard let p = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                if abs(p.redComponent - 0xFB / 255) + abs(p.greenComponent - 0xEF / 255) + abs(p.blueComponent - 0xD9 / 255) < 0.03 {
                    columns.insert(x)
                    rows.insert(y)
                }
            }
        }
        let natural = NSHostingView(rootView: view.frame(width: size.width, alignment: .topLeading)).fittingSize
        return (columns.sorted().map { CGFloat($0) / scale }, rows.sorted().map { CGFloat($0) / scale }, natural)
    }

    /// The gold ground is drawn behind the label, starting at the text's column (the label stands its side padding inside it) and ending before the text. It is
    /// rendered as the app renders a prompt: `designLines` and selectable text.
    func testTheGroundIsPaddedAndEndsBeforeTheText() throws {
        let ground = try gold(person("hello"), CGSize(width: 300, height: 60))
        let first = try XCTUnwrap(ground.columns.first), last = try XCTUnwrap(ground.columns.last)
        XCTAssertEqual(first, 20, accuracy: 1.5, "the ground's left edge is the column at 20, where the author's name starts")
        XCTAssertGreaterThan(last - first, 40, "the ground covers the label and its padding")
        XCTAssertLessThan(last, 100, "the ground ends before the text")
    }

    /// The room between the mention's ground (`mention-bg`) and the ground of a code span (`code-inline`), light, in points, read on the mention's middle row of a
    /// rendering of `view`: the columns after the last gold one up to the first code-ground one. A ground drawn over the other leaves none.
    private func roomBetweenChipAndCode(_ view: some View, _ size: CGSize) throws -> CGFloat {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let hosting = NSHostingView(rootView: view.frame(width: size.width, height: size.height, alignment: .topLeading))
        hosting.appearance = NSAppearance(named: .aqua)
        hosting.frame = NSRect(origin: .zero, size: size)
        hosting.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        let scale = CGFloat(rep.pixelsWide) / size.width
        func near(_ p: NSColor, _ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> Bool {
            abs(p.redComponent - r / 255) + abs(p.greenComponent - g / 255) + abs(p.blueComponent - b / 255) < 0.03
        }
        var goldRows: [Int] = []
        for y in 0..<rep.pixelsHigh where (0..<rep.pixelsWide).contains(where: { x in rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB).map { near($0, 0xFB, 0xEF, 0xD9) } ?? false }) {
            goldRows.append(y)
        }
        let row = try XCTUnwrap(goldRows.isEmpty ? nil : goldRows[goldRows.count / 2], "the mention's ground")
        let pixels = (0..<rep.pixelsWide).map { rep.colorAt(x: $0, y: row)?.usingColorSpace(.sRGB) }
        let lastGold = try XCTUnwrap(pixels.lastIndex { $0.map { near($0, 0xFB, 0xEF, 0xD9) } ?? false })
        let code = try XCTUnwrap(pixels.indices.first { $0 > lastGold && (pixels[$0].map { near($0, 0xEE, 0xF1, 0xF5) } ?? false) }, "the code ground after the mention's")
        return CGFloat(code - lastGold - 1) / scale
    }

    /// The leftmost dark pixel of each text line of `view` (text ink: darker than the white and the gold ground), in points, one entry per line of 22 points.
    private func inkStarts(_ view: some View, _ size: CGSize) throws -> [CGFloat] {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let hosting = NSHostingView(rootView: view.frame(width: size.width, height: size.height, alignment: .topLeading))
        hosting.appearance = NSAppearance(named: .aqua)
        hosting.frame = NSRect(origin: .zero, size: size)
        hosting.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        let scale = CGFloat(rep.pixelsWide) / size.width
        var starts: [Int: Int] = [:]
        for y in 0..<rep.pixelsHigh {
            for x in 0..<rep.pixelsWide {
                guard let p = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB), p.alphaComponent > 0.5, p.brightnessComponent < 0.6 else { continue }
                let line = Int(CGFloat(y) / scale / 22)
                starts[line] = min(starts[line] ?? .max, x)
            }
        }
        return starts.keys.sorted().map { CGFloat(starts[$0]!) / scale }
    }

    /// The mention's text moves in by the ground's side padding so that its ground lines up with the column; the lines under it stay at the column.
    func testTheMentionsTextStandsASidePaddingInAndTheOtherLinesStayAtTheColumn() throws {
        let text = "hello there this prompt wraps onto a second line and then a third one"
        let starts = try inkStarts(person(text), CGSize(width: 160, height: 120))
        XCTAssertGreaterThanOrEqual(starts.count, 3, "the text wraps onto at least three lines")
        XCTAssertEqual(starts[0], 20 + MentionedText.side, accuracy: 2, "the mention's text starts a side padding right of the column: \(starts)")
        for later in starts.dropFirst() { XCTAssertEqual(later, 20, accuracy: 2, "a later line starts at the column: \(starts)") }
    }

    /// A text that starts with the mention and wraps: the ground stays on the first line, where the mention is.
    func testTheGroundStaysOnTheFirstLineOfAWrappedText() throws {
        let text = "hello there this prompt wraps onto a second line and then a third one"
        let ground = try gold(person(text), CGSize(width: 160, height: 120))
        XCTAssertGreaterThan(ground.fitting.height, 2 * PardnerFont.textLine + MessageRow.lineSpacing, "the text wraps onto more than one line")
        let top = try XCTUnwrap(ground.rows.first), bottom = try XCTUnwrap(ground.rows.last)
        XCTAssertLessThan(top, MessageRow.lineSpacing / 2 + PardnerFont.textLine, "the ground begins on the first line")
        XCTAssertLessThan(bottom - top, PardnerFont.textLine, "the ground is one line high: nothing is drawn behind the second line")
    }

    // MARK: a person's message is read as a bot's is

    /// A person's message, as the rows draw it: `MarkdownView` with the bot's mention, in the column the rows put it in.
    private func person(_ text: String) -> some View {
        MarkdownView(text: text, mention: "@mini").designLines().textSelection(.enabled).padding(.leading, 20)
    }

    /// The same message drawn as typed: the chip and the whole text in one run, with no Markdown read.
    private func typed(_ text: String) -> some View {
        InlineCodeText(text: MarkdownFonts.styled(AttributedString(text), size: 14, weight: .regular), mention: "@mini").designLines().textSelection(.enabled).padding(.leading, 20)
    }

    /// The pixels of `view` rendered at `size`, to tell two drawings apart.
    private func rendering(_ view: some View, _ size: CGSize) throws -> Data {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let hosting = NSHostingView(rootView: view.frame(width: size.width, height: size.height, alignment: .topLeading))
        hosting.appearance = NSAppearance(named: .aqua)
        hosting.frame = NSRect(origin: .zero, size: size)
        hosting.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        return try XCTUnwrap(rep.tiffRepresentation)
    }

    private func fitting(_ view: some View, width: CGFloat) -> CGSize {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        return NSHostingView(rootView: view.frame(width: width, alignment: .topLeading)).fittingSize
    }

    /// What Cmd-C puts on the pasteboard when the owner selects all of `view`, as plain text and as the rich text (RTFD) of the same copy: the selectable text
    /// view SwiftUI puts under `.textSelection(.enabled)` (`AppKitTextInteractionView`, found as the hosting view's first subview), made the first responder
    /// of a window, receives `selectAll:` and `copy:`.
    private func copiedText(_ view: some View) throws -> (plain: String, rich: String) {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let size = CGSize(width: 300, height: 120)
        let hosting = NSHostingView(rootView: view.frame(width: size.width, height: size.height, alignment: .topLeading))
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = hosting
        window.makeKeyAndOrderFront(nil)
        hosting.layoutSubtreeIfNeeded()
        // The view is SwiftUI's own and private: a macOS that builds it otherwise (the macOS 15 runner) skips the test, it does not fail it.
        guard let selectable = hosting.subviews.first, selectable.acceptsFirstResponder, window.makeFirstResponder(selectable),
              selectable.tryToPerform(#selector(NSText.selectAll(_:)), with: nil)
        else { throw XCTSkip("the selectable text view is not found, or does not answer selectAll:") }
        // The general pasteboard is the machine's clipboard: what it held comes back when the test ends.
        let saved = (NSPasteboard.general.pasteboardItems ?? []).map { item in
            item.types.reduce(into: [NSPasteboard.PasteboardType: Data]()) { $0[$1] = item.data(forType: $1) }
        }
        defer {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.writeObjects(saved.map { held in
                let item = NSPasteboardItem()
                for (type, data) in held { item.setData(data, forType: type) }
                return item
            })
        }
        NSPasteboard.general.clearContents()
        guard selectable.tryToPerform(#selector(NSText.copy(_:)), with: nil) else { throw XCTSkip("the selectable text view does not answer copy:") }
        let rtfd = try XCTUnwrap(NSPasteboard.general.data(forType: .rtfd), "the rich flavour")
        let rich = try XCTUnwrap(NSAttributedString(rtfd: rtfd, documentAttributes: nil))
        return (try XCTUnwrap(NSPasteboard.general.string(forType: .string)), rich.string)
    }

    /// The clear image that stands the mention in by the ground's side padding is not part of a copied prompt: neither the plain string nor the string of the
    /// rich flavour holds anything but the mention and the message (measured on macOS 27.2.1; the plain flavour drops U+FFFC from any source, so the rich one is
    /// the stricter pin, and a character such as U+200B in the image's place fails both).
    func testACopiedPromptHoldsTheMentionAndTheMessageAndNothingElse() throws {
        let cases: [(AnyView, String)] = [
            (AnyView(person("hello there")), "@mini hello there"),
            (AnyView(person("run `ls -a` now")), "@mini run ls -a now"),
        ]
        for (view, expected) in cases {
            let copied = try copiedText(view)
            XCTAssertEqual(copied.plain, expected)
            XCTAssertEqual(copied.rich, expected)
        }
    }

    func testAPersonsHeadingListAndFenceAreReadAsBlocks() throws {
        let text = "# Plan\n\n- one\n- two\n\n```swift\nlet x = 1\n```"
        guard case .read(let pieces, _) = MarkdownBlocks.read(text) else { return XCTFail("read") }
        XCTAssertEqual(pieces.count, 4, "a heading, two items and a block")
        let read = fitting(person(text), width: 400).height
        let raw = fitting(typed(text), width: 400).height
        XCTAssertNotEqual(read, raw, "drawn as blocks, not as typed")
        XCTAssertGreaterThan(read, fitting(person("Plan"), width: 400).height + 2 * PardnerFont.textLine, "a heading, items and a block stand on lines of their own")
    }

    /// A message with no markup is one paragraph that looks as it did when it was drawn as typed: its lines start where they did, and it is as high.
    func testAPlainMessageLooksAsItDidBeforeTheMentionJoinedTheMarkdown() throws {
        let text = "hello there this prompt wraps onto a second line and then a third one"
        let size = CGSize(width: 160, height: 120)
        // The text as it was drawn before it was read as Markdown: the mention, its space widened by the side padding, then the words as typed.
        var space = AttributedString(" ")
        space.kern = MentionedText.side
        let old = Text(Image(nsImage: NSImage(size: NSSize(width: MentionedText.side, height: 1)))) + Text(mentionLabel("@mini")) + Text(space) + Text(verbatim: text)
        let before = try inkStarts(old.font(PardnerFont.ui(size: 14, weight: .regular)).foregroundStyle(PardnerColor.text).designLines().textSelection(.enabled).padding(.leading, 20), size)
        let after = try inkStarts(person(text), size)
        XCTAssertEqual(after.count, before.count)
        for (a, b) in zip(after, before) { XCTAssertEqual(a, b, accuracy: 2, "\(after) against \(before)") }
        XCTAssertEqual(after[0], 20 + MentionedText.side, accuracy: 2)
        XCTAssertEqual(fitting(person(text), width: 160).height, fitting(typed(text), width: 160).height, accuracy: 0.5)
    }

    /// A person's message that opens with a code span: the chip's ground and the span's ground stand a space apart, as a span stands from the text beside it
    /// elsewhere (the space's own width: the room of both grounds is a kern, outside it).
    func testTheCodeGroundAfterTheChipStandsASpaceAwayFromIt() throws {
        _ = PardnerFonts.register()
        let font = PardnerFont.uiCT(size: 14, weight: .regular)
        var character: UniChar = 0x20, glyph = CGGlyph()
        XCTAssertTrue(CTFontGetGlyphsForCharacters(font, &character, &glyph, 1))
        var advance = CGSize.zero
        CTFontGetAdvancesForGlyphs(font, .horizontal, &glyph, &advance, 1)
        let room = try roomBetweenChipAndCode(person("`npm test` fails"), CGSize(width: 300, height: 60))
        XCTAssertEqual(room, advance.width, accuracy: 1, "the grounds are a space (\(advance.width) points) apart; measured \(room)")
    }

    /// A text Markdown reads as no piece (a link reference definition: block HTML such as a comment is kept as a paragraph) is drawn as typed after the chip,
    /// not as the chip alone.
    func testATextMarkdownReadsAsNothingShowsAsTypedAfterTheChip() throws {
        let size = CGSize(width: 300, height: 60)
        let alone = try rendering(person(""), size)
        for text in ["[ref]: https://example.com", "[a]: https://example.com/a\n[b]: https://example.com/b"] {
            guard case .read(let pieces, _) = MarkdownBlocks.read(text) else { return XCTFail("read") }
            XCTAssertTrue(pieces.isEmpty, "Markdown reads \(text) as no piece")
            XCTAssertNotEqual(try rendering(person(text), size), alone, "the typed text is drawn beside the chip")
        }
    }

    func testTheChipStandsBeforeTheFirstParagraphsTextAndOnItsOwnLineBeforeAnythingElse() throws {
        let size = CGSize(width: 300, height: 200)
        let paragraph = try gold(person("hello\n\n- one\n- two"), size)
        XCTAssertLessThan(try XCTUnwrap(paragraph.rows.last), MessageRow.lineSpacing / 2 + PardnerFont.textLine, "the chip is on the first paragraph's line")
        let heading = try gold(person("# Plan\n\nhello"), size)
        let top = try XCTUnwrap(heading.rows.first), bottom = try XCTUnwrap(heading.rows.last)
        XCTAssertLessThan(bottom - top, PardnerFont.textLine, "the chip is one line high")
        XCTAssertLessThan(bottom, MessageRow.lineSpacing / 2 + PardnerFont.textLine, "the chip is above the heading")
        XCTAssertFalse(MarkdownView.opens(MarkdownBlocks.Piece(depth: 1, bars: 0, marker: "-", body: .paragraph(AttributedString("one")))), "an item is not a first line")
        guard case .read(let linked, _) = MarkdownBlocks.read("[a](https://example.com) b"), let first = linked.first else { return XCTFail("read") }
        XCTAssertFalse(MarkdownView.opens(first), "a link is drawn by AppKit, which a chip cannot join")
    }

    func testAMentionIsDarkSemiboldTextWithNoCharacterForPadding() {
        PardnerFonts.register()
        let label = mentionLabel("@mini")
        XCTAssertEqual(String(label.characters), "@mini", "no character stands in for padding: a copied prompt holds what was written")
        XCTAssertEqual(label.runs.count, 1)
        XCTAssertNil(label.runs.first?.backgroundColor, "the ground is drawn behind the run, rounded and padded, not as the run's square background")
        XCTAssertEqual(label.runs.first?.foregroundColor, PardnerColor.mentionText)
        XCTAssertEqual(label.runs.first?.font, PardnerFont.ui(size: 14, weight: .semibold))
    }
}
