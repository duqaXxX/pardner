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

    func testAWideTableKeepsItsHeaderGroundAsOneBandAcrossTheGapsOfItsColumns() {
        let wide = "| Identifier | Description | Owner | Reviewer | Status | Estimate | Component | Branch |\n|---|---|---|---|---|---|---|---|\n"
            + "| relay-journal-flush | wait-for-the-journal-flush | alice-example | bob-example | merged | 3 | relay-store-layer | fix/relay-journal-flush |"
        for (name, theme) in [(NSAppearance.Name.aqua, \TokenPair.light), (.darkAqua, \TokenPair.dark)] {
            let v = Tokens.pairs["table-head"]![keyPath: theme]
            let head = [v.red, v.green, v.blue].map { Int(round($0 * 255)) }
            // Row 0 is 32 points high and its text sits in the middle, so y 4 is ground alone; every x of the visible width, clear of the card's rounded corners, is on it.
            for x in stride(from: 12, to: 388, by: 3) { XCTAssertEqual(pixel(of: wide, name, x: x, y: 4), head, "x \(x) (\(name.rawValue))") }
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

    // MARK: a table takes the column's width, or scrolls (design FA 3.3)

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

    func testATableWhoseColumnsWouldBeUnderTheirFloorsScrollsSideways() {
        PardnerFonts.register()
        // 20 characters is more than the 90 point floor: a table that stayed fitted would wrap them.
        let wide = grid(columns: 20, cell: "abcdefghijklmnopqrst")
        XCTAssertEqual(height(of: wide, width: 400), height(of: wide, width: 4000), accuracy: 0.5, "no cell wraps: the table scrolls")
    }

    func testTheScrollingTableKeepsTheSameRowRuleAsTheFittedOne() {
        PardnerFonts.register()
        // Cells of 29 points, taller than the 32 point row less its padding: a row is the cell and 6 points above and under, in both layouts.
        func height(_ text: String, width: CGFloat) -> CGFloat {
            let hosting = NSHostingView(rootView: MarkdownView(text: text, size: 30).frame(width: width))
            hosting.layoutSubtreeIfNeeded()
            return hosting.fittingSize.height
        }
        let scrolling = height(grid(columns: 20, cell: "abcdefghijklmnopqrst"), width: 400)
        let fitted = height(grid(columns: 1, cell: "abcdefghijklmnopqrst"), width: 400)
        XCTAssertEqual(scrolling, fitted, accuracy: 0.5, "the same three rows, with or without the sideways scroll")
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

    /// The gold ground is drawn behind the label, reaching the side padding left of the text's column and ending before the text. It is
    /// rendered as the app renders a prompt: `designLines` and selectable text.
    func testTheGroundIsPaddedAndEndsBeforeTheText() throws {
        let view = mentioned("@mini", "hello").designLines().textSelection(.enabled).padding(.leading, 20)
        let ground = try gold(view, CGSize(width: 300, height: 60))
        let first = try XCTUnwrap(ground.columns.first), last = try XCTUnwrap(ground.columns.last)
        XCTAssertEqual(first, 14, accuracy: 1.5, "the ground starts 6 points left of the column at 20")
        XCTAssertGreaterThan(last - first, 40, "the ground covers the label and its padding")
        XCTAssertLessThan(last, 100, "the ground ends before the text")
    }

    /// A text that starts with the mention and wraps: the ground stays on the first line, where the mention is.
    func testTheGroundStaysOnTheFirstLineOfAWrappedText() throws {
        let text = "hello there this prompt wraps onto a second line and then a third one"
        let view = mentioned("@mini", text).designLines().textSelection(.enabled).padding(.leading, 20)
        let ground = try gold(view, CGSize(width: 160, height: 120))
        XCTAssertGreaterThan(ground.fitting.height, 2 * PardnerFont.textLine + MessageRow.lineSpacing, "the text wraps onto more than one line")
        let top = try XCTUnwrap(ground.rows.first), bottom = try XCTUnwrap(ground.rows.last)
        XCTAssertLessThan(top, MessageRow.lineSpacing / 2 + PardnerFont.textLine, "the ground begins on the first line")
        XCTAssertLessThan(bottom - top, PardnerFont.textLine, "the ground is one line high: nothing is drawn behind the second line")
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
