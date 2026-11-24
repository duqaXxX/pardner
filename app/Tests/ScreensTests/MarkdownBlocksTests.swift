// A bot's text read as Markdown (#73, step B2, design 2.2 to 2.6): the bounds, the flat pieces, the link filter, the marks.
import DesignSystem
import Foundation
@testable import Screens
import XCTest

@MainActor
final class MarkdownBlocksTests: XCTestCase {
    private func read(_ text: String) -> (pieces: [MarkdownBlocks.Piece], links: [URL])? {
        guard case .read(let pieces, let links) = MarkdownBlocks.parse(text) else { return nil }
        return (pieces, links)
    }

    /// The text of a paragraph or heading piece.
    private func text(_ piece: MarkdownBlocks.Piece) -> String {
        switch piece.body {
        case .paragraph(let s), .heading(_, let s): String(s.characters)
        case .code(_, let s): s
        default: ""
        }
    }

    private func table(_ piece: MarkdownBlocks.Piece) -> MarkdownBlocks.Table? {
        if case .table(let table) = piece.body { return table }
        return nil
    }

    // MARK: bounds

    func testATextOverTheCapIsRefused() {
        XCTAssertEqual(MarkdownBlocks.parse(String(repeating: "a", count: CodeSpans.most + 1)), .refused)
        XCTAssertNotNil(read(String(repeating: "a", count: CodeSpans.most)))
    }

    func testAWideDelimiterRowIsRefusedWhereverItStands() {
        let wide = "|" + String(repeating: " - |", count: 21)
        let ok = "|" + String(repeating: " - |", count: 20)
        XCTAssertEqual(MarkdownBlocks.parse("a\n\(wide)\nb"), .refused)
        XCTAssertEqual(MarkdownBlocks.parse("> \(wide)"), .refused)
        XCTAssertEqual(MarkdownBlocks.parse(">>\t> \(wide)"), .refused)
        XCTAssertEqual(MarkdownBlocks.parse("a\r\(wide)\rb"), .refused)
        XCTAssertEqual(MarkdownBlocks.parse("a\r\n\(wide)\r\nb"), .refused)
        XCTAssertNotNil(read("a\n\(ok)\nb"))
    }

    func testAFormFeedAndAVerticalTabAreSpacesOfADelimiterRow() {
        let wide = "|" + String(repeating: " - |", count: 21)
        XCTAssertEqual(MarkdownBlocks.parse(wide + "\u{0C}"), .refused)
        XCTAssertEqual(MarkdownBlocks.parse("\u{0B}" + wide + "\u{0B}"), .refused)
        XCTAssertEqual(MarkdownBlocks.parse("|" + String(repeating: "-\u{0B}|", count: 21)), .refused)
        XCTAssertEqual(MarkdownBlocks.parse("|" + String(repeating: "-|", count: 999) + "\u{0C}"), .refused)
    }

    func testCellsAreCountedAsGFMCountsThem() {
        // Without outer pipes the cells are the pieces between pipes: 21 of them.
        XCTAssertEqual(MarkdownBlocks.parse(Array(repeating: "-", count: 21).joined(separator: "|")), .refused)
        XCTAssertNotNil(read(Array(repeating: "-", count: 20).joined(separator: "|")))
        // A line with no `-` or no `|` is no delimiter row.
        XCTAssertNotNil(read(String(repeating: "|", count: 40)))
        XCTAssertNotNil(read(String(repeating: "-", count: 40)))
    }

    func testMoreThanAThousandPiecesAreRefused() {
        XCTAssertEqual(MarkdownBlocks.parse(String(repeating: "a\n\n", count: 1_001)), .refused)
        XCTAssertEqual(read(String(repeating: "a\n\n", count: 1_000))?.pieces.count, 1_000)
    }

    func testATableCountsTheCellsItsGridDraws() {
        let header = "|" + String(repeating: " a |", count: 20) + "\n|" + String(repeating: "-|", count: 20) + "\n"
        let empties = String(repeating: "||\n", count: 60)
        XCTAssertEqual(MarkdownBlocks.parse(header + empties + "|x|"), .refused)
        XCTAssertNotNil(read(header + "|x|"))
    }

    func testDeepQuotesAreOnePieceAtDepthEightOpenedByAnEllipsis() throws {
        let (pieces, _) = try XCTUnwrap(read(String(repeating: ">", count: 4_000) + "x"))
        XCTAssertEqual(pieces.count, 1)
        XCTAssertEqual(pieces[0].depth, 8)
        XCTAssertEqual(pieces[0].bars, 8)
        XCTAssertEqual(text(pieces[0]), "…x")
        let (shallow, _) = try XCTUnwrap(read(">>>> x"))
        XCTAssertEqual(shallow[0].bars, 4)
        XCTAssertEqual(text(shallow[0]), "x")
    }

    // MARK: blocks

    func testParagraphsHeadingsAndRules() throws {
        let (pieces, _) = try XCTUnwrap(read("# One\n\nbody *it* **bo** ~~st~~\n\n---\n\n###### Six"))
        XCTAssertEqual(pieces.count, 4)
        guard case .heading(let level, _) = pieces[0].body else { return XCTFail("not a heading") }
        XCTAssertEqual(level, 1)
        XCTAssertEqual(text(pieces[1]), "body it bo st")
        XCTAssertEqual(pieces[2].body, .rule)
        guard case .heading(let six, _) = pieces[3].body else { return XCTFail("not a heading") }
        XCTAssertEqual(six, 6)
        guard case .paragraph(let body) = pieces[1].body else { return XCTFail("not a paragraph") }
        let intents = body.runs.compactMap(\.inlinePresentationIntent)
        XCTAssertEqual(intents, [.emphasized, .stronglyEmphasized, .strikethrough])
    }

    func testAListItemHasItsMarkerOnItsFirstPieceOnly() throws {
        let (pieces, _) = try XCTUnwrap(read("1. x\n\n   y\n2. z\n\n- a\n  - b"))
        XCTAssertEqual(pieces.map(\.marker), ["1.", nil, "2.", "•", "•"])
        XCTAssertEqual(pieces.map { $0.depth }, [1, 1, 1, 1, 2])
    }

    func testAnOuterItemThatOpensWithANestedListIsNotMarkedAgain() throws {
        let (pieces, _) = try XCTUnwrap(read("1. - b\n\n   c\n2. d"))
        XCTAssertEqual(pieces.map(text), ["b", "c", "d"])
        XCTAssertEqual(pieces.map(\.marker), ["•", nil, "2."])
    }

    func testAnOrderedListKeepsItsStartNumber() throws {
        let (pieces, _) = try XCTUnwrap(read("3. a\n4. b"))
        XCTAssertEqual(pieces.map(\.marker), ["3.", "4."])
    }

    func testATaskListKeepsItsBracketsAsText() throws {
        let (pieces, _) = try XCTUnwrap(read("- [ ] a\n- [x] b"))
        XCTAssertEqual(pieces.map(text), ["[ ] a", "[x] b"])
    }

    func testASoftBreakAndAHardBreakAreLineBreaks() throws {
        let (pieces, _) = try XCTUnwrap(read("a\nb  \nc"))
        XCTAssertEqual(text(pieces[0]), "a\nb\nc")
    }

    func testBlockHTMLIsAParagraphAndInlineHTMLIsText() throws {
        let (block, _) = try XCTUnwrap(read("<div>hi</div>"))
        XCTAssertEqual(block.map(text), ["<div>hi</div>"])
        let (inline, _) = try XCTUnwrap(read("x <b>y</b>"))
        XCTAssertEqual(inline.map(text), ["x <b>y</b>"])
    }

    func testAnImageIsItsAltAndItsAddress() throws {
        let (pieces, links) = try XCTUnwrap(read("see ![the *alt*](http://i.example/x.png) now ![](http://i.example/y.png)"))
        XCTAssertEqual(text(pieces[0]), "see the alt (http://i.example/x.png) now  (http://i.example/y.png)")
        XCTAssertEqual(links, [])
    }

    // MARK: code

    func testACodeBlockHasItsLanguageAndNoFinalLineEnd() throws {
        let (pieces, _) = try XCTUnwrap(read("```swift extra\nlet a = 1\n\nlet b\n```"))
        XCTAssertEqual(pieces[0].body, .code(language: "swift", text: "let a = 1\n\nlet b"))
        let (bare, _) = try XCTUnwrap(read("```\nx\n```"))
        XCTAssertEqual(bare[0].body, .code(language: nil, text: "x"))
    }

    func testAnUnclosedFenceIsACodeBlockToTheEnd() throws {
        let (pieces, _) = try XCTUnwrap(read("a\n\n```\nx\ny"))
        XCTAssertEqual(pieces.count, 2)
        XCTAssertEqual(pieces[1].body, .code(language: nil, text: "x\ny"))
    }

    func testMarksInACodeBlockAndInASpan() throws {
        let (block, _) = try XCTUnwrap(read("```\na\u{1}b\u{7F}c\u{FFF9}d\u{202E}e\u{200B}f\tg\n```"))
        XCTAssertEqual(block[0].body, .code(
            language: nil, text: "a[U+0001]b[U+007F]c[U+FFF9]d[U+202E]e[U+200B]f\tg"))
        let (span, _) = try XCTUnwrap(read("`a\u{1}b\u{FFF9}c\u{202E}d`"))
        XCTAssertEqual(text(span[0]), "a[U+0001]b[U+FFF9]c[U+202E]d")
    }

    func testACodeSpanIsStyledAsCodeSpansStylesIt() throws {
        let (pieces, _) = try XCTUnwrap(read("run `npm test` now"))
        guard case .paragraph(let body) = pieces[0].body else { return XCTFail("not a paragraph") }
        let code = try XCTUnwrap(body.runs.first { $0.backgroundColor != nil })
        XCTAssertEqual(String(body[code.range].characters), "npm test")
        XCTAssertEqual(code.backgroundColor, PardnerColor.raised)
        XCTAssertEqual(code.font, PardnerFont.mono(size: 12.5, weight: .regular))
    }

    func testCodeSpansShowAControlAndAFormatCodePoint() {
        XCTAssertEqual(CodeSpans.pieces("`a\u{1}b\u{FFF9}c`"), [.code("a[U+0001]b[U+FFF9]c")])
        XCTAssertEqual(CodeSpans.pieces("`a\tb`"), [.code("a\tb")])
    }

    // MARK: tables

    func testATablePlacesCellsAndRowsByIndex() throws {
        let (pieces, _) = try XCTUnwrap(read("| a | b |\n|---|---|\n| 1 |  |\n|  | |\n| x | y |"))
        let table = try XCTUnwrap(table(pieces[0]))
        XCTAssertEqual(table.columns, 2)
        XCTAssertEqual(table.rows.map { $0.map { String($0.characters) } }, [["a", "b"], ["1", ""], ["", ""], ["x", "y"]])
    }

    // MARK: links (2.4)

    private func kept(_ url: String) -> Bool {
        guard let (_, links) = read("[t](\(url))") else { return false }
        return !links.isEmpty
    }

    func testALinkKeepsItsTextAndItsAddressIsAPlaceholder() throws {
        let (pieces, links) = try XCTUnwrap(read("[https://a.example](https://b.example/p) and [again](https://b.example/p) and [c](http://c.example)"))
        XCTAssertEqual(links.map(\.absoluteString), ["https://b.example/p", "http://c.example"])
        guard case .paragraph(let body) = pieces[0].body else { return XCTFail("not a paragraph") }
        XCTAssertEqual(String(body.characters), "https://a.example and again and c")
        XCTAssertEqual(body.runs.compactMap(\.link).map(\.absoluteString), ["pardner-link:0", "pardner-link:0", "pardner-link:1"])
    }

    func testARefusedLinkIsItsTextWithNoLink() throws {
        let (pieces, links) = try XCTUnwrap(read("[a](javascript:alert(1)) [b](file:///etc/passwd)"))
        XCTAssertEqual(links, [])
        guard case .paragraph(let body) = pieces[0].body else { return XCTFail("not a paragraph") }
        XCTAssertEqual(String(body.characters), "a b")
        XCTAssertTrue(body.runs.allSatisfy { $0.link == nil })
    }

    func testHostsThatAreNotDomainNamesAreRefused() {
        let refused = [
            "http://127.0.0.1/", "http://0x7f.0x1/", "http://1.0xa/", "http://127.0.0.0x1/", "http://0x7f.1/",
            "http://3232235521/", "http://foo.localhost/", "http://localhost/", "http://example.com./", "http://u@example.com/",
            "http://u:p@example.com/", "http://127。0。0。1/", "http://１２７.０.０.１/", "http://𝟏𝟐𝟕.0.0.1/",
            "http://%30x1.0x1/", "http://0x1%2E/", "http://[::1]/", "http://example/", "http://a..com/", "http://example.c/",
            "ftp://example.com/", "mailto:a@example.com",
        ]
        for url in refused { XCTAssertFalse(kept(url), url) }
    }

    func testHostsThatAreDomainNamesAreKept() {
        let accepted = ["https://example.com", "HTTPS://Example.COM/a?b#c", "http://127.0.0.1%2Ecom/", "http://xn--bcher-kva.de/",
                        "http://a-b.example.org:8080/x", "http://bücher.de/"]
        for url in accepted { XCTAssertTrue(kept(url), url) }
    }

    // MARK: cache (2.6)

    func testTheCacheReturnsTheSameDecisionForTheSameText() {
        let text = "a **b** [c](https://c.example)"
        XCTAssertEqual(MarkdownBlocks.read(text), MarkdownBlocks.read(text))
        XCTAssertEqual(MarkdownBlocks.read(text), MarkdownBlocks.parse(text))
        // A refusal of step 2 is cached; a text over the cap is a count and is refused without the cache.
        let wide = "|" + String(repeating: " - |", count: 21)
        XCTAssertEqual(MarkdownBlocks.read(wide), .refused)
        XCTAssertEqual(MarkdownBlocks.read(wide), .refused)
        XCTAssertEqual(MarkdownBlocks.read(String(repeating: "a", count: CodeSpans.most + 1)), .refused)
    }
}
