// The composer's rich text and its Markdown (#129): every construct of the subset goes from Markdown to the field's text and back to the same Markdown,
// and from the field's text to Markdown and back to the same text; a plain run is written as typed.
import AppKit
import DesignSystem
import Foundation
@testable import Screens
import XCTest

final class ComposerMarkdownTests: XCTestCase {
    override func setUp() { _ = PardnerFonts.register() }

    /// The marks of a text, paragraph by paragraph, as a string that compares: the block, then each run's text and what it carries.
    static func shape(_ text: NSAttributedString) -> [String] {
        let ns = text.string as NSString
        return ComposerMarkdown.paragraphs(of: ns).map { range in
            var runs: [String] = []
            text.enumerateAttributes(in: range) { attributes, run, _ in
                var marks: [String] = []
                if attributes[.composerStrong] != nil { marks.append("strong") }
                if attributes[.composerEmphasis] != nil { marks.append("emphasis") }
                if attributes[.composerCode] != nil { marks.append("code") }
                if (attributes[.strikethroughStyle] as? Int ?? 0) != 0 { marks.append("strike") }
                if let url = attributes[.link] as? URL { marks.append("link:\(url.absoluteString)") }
                runs.append("\(ns.substring(with: run))[\(marks.joined(separator: ","))]")
            }
            return "\(ComposerMarkdown.block(in: text, at: range.location)?.rawValue ?? "plain"): \(runs.joined())"
        }
    }

    private func roundTrip(_ markdown: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(ComposerMarkdown.markdown(from: ComposerMarkdown.attributed(from: markdown)), markdown, file: file, line: line)
    }

    /// The text a field would hold: `parts` are `(text, marks)`, one paragraph each when `block` is given, joined by line ends.
    private func field(_ paragraphs: [(ComposerMarkdown.Block?, [(String, [NSAttributedString.Key: Any])])]) -> NSAttributedString {
        let out = NSMutableAttributedString()
        for (index, paragraph) in paragraphs.enumerated() {
            let block: [NSAttributedString.Key: Any] = paragraph.0.map { [.composerBlock: $0.rawValue] } ?? [:]
            for (text, marks) in paragraph.1 { out.append(NSAttributedString(string: text, attributes: marks.merging(block) { $1 })) }
            if index < paragraphs.count - 1 { out.append(NSAttributedString(string: "\n", attributes: block)) }
        }
        ComposerMarkdown.style(out, firstLineIndent: 0)
        return out
    }

    private let strong: [NSAttributedString.Key: Any] = [.composerStrong: true]
    private let emphasis: [NSAttributedString.Key: Any] = [.composerEmphasis: true]
    private let strike: [NSAttributedString.Key: Any] = [.strikethroughStyle: NSUnderlineStyle.single.rawValue]
    private let code: [NSAttributedString.Key: Any] = [.composerCode: true]

    // MARK: Markdown, the field, Markdown

    func testEveryConstructOfTheSubsetKeepsItsMarkdown() {
        for markdown in [
            "**bold**", "*italic*", "~~gone~~", "`code`", "***both***", "[text](https://example.com/a)",
            "# One", "## Two", "### Three", "- a\n- b", "1. a\n2. b\n3. c", "> quoted", "```\nlet x = 1\n\nlet y = 2\n```",
            "plain\nsecond line", "a **b *c* d** e", "- **b** item", "# **x** heading", "- one\n\ntext after", "> q\n\ntext after",
            "# T\n\ntext\n\n- a\n- b\n\n> q\n\n```\ncode\n```",
        ] { roundTrip(markdown) }
    }

    func testAMarkdownReadsAsTheFieldsAttributes() {
        XCTAssertEqual(Self.shape(ComposerMarkdown.attributed(from: "a **b *c*** ~~d~~ `e` [f](https://example.com)")), [
            "plain: a []b [strong]c[strong,emphasis] []d[strike] []e[code] []f[link:https://example.com]",
        ])
        XCTAssertEqual(Self.shape(ComposerMarkdown.attributed(from: "# H\n\n- a\n- b\n\n1. c\n\n> q\n\n```\nx\ny\n```")), [
            "h1: H[]", "bullet: a[]", "bullet: b[]", "number: c[]", "quote: q[]", "code: x[]", "code: y[]",
        ])
    }

    func testAHeadingDeeperThanThreeReadsAsTheThird() {
        XCTAssertEqual(Self.shape(ComposerMarkdown.attributed(from: "###### Deep")), ["h3: Deep[]"])
    }

    func testWhatIsOutsideTheSubsetReadsAsPlainText() {
        let table = ComposerMarkdown.attributed(from: "| a | b |\n|---|---|\n| 1 | 2 |")
        XCTAssertFalse(table.string.isEmpty)
        XCTAssertTrue(Self.shape(table).allSatisfy { $0.hasPrefix("plain:") })
    }

    // MARK: the field, Markdown, the field

    func testEveryConstructOfTheFieldKeepsItsText() {
        let texts: [[(ComposerMarkdown.Block?, [(String, [NSAttributedString.Key: Any])])]] = [
            [(nil, [("a ", [:]), ("bold", strong), (" b", [:])])],
            [(nil, [("both", strong.merging(emphasis) { $1 })])],
            [(nil, [("x", strike), ("y", code)])],
            [(nil, [("one", [:])]), (nil, [("two", [:])])],
            [(.h2, [("Head", [:])]), (nil, [("body", [:])])],
            [(.bullet, [("a", [:])]), (.bullet, [("b", emphasis)]), (.number, [("c", [:])])],
            [(.quote, [("q", [:])]), (.code, [("one", [:])]), (.code, [("two", [:])])],
            [(nil, [("see ", [:]), ("site", [.link: URL(string: "https://example.com/a?b=1")!])])],
        ]
        for paragraphs in texts {
            let text = field(paragraphs)
            let markdown = ComposerMarkdown.markdown(from: text)
            XCTAssertEqual(Self.shape(ComposerMarkdown.attributed(from: markdown)), Self.shape(text), markdown)
        }
    }

    // MARK: what the Markdown is

    func testAPlainRunIsWrittenAsTypedNeverEscaped() {
        for typed in ["__init__.py", "2*3*4", "a_b_c", "# not a heading is still typed", "[x](y)"] {
            XCTAssertEqual(ComposerMarkdown.markdown(from: field([(nil, [(typed, [:])])])), typed)
        }
    }

    func testTheBlanksAtTheEndsOfARunStayOutsideItsMarks() {
        XCTAssertEqual(ComposerMarkdown.markdown(from: field([(nil, [("hello ", strong), ("world", [:])])])), "**hello** world")
        XCTAssertEqual(ComposerMarkdown.markdown(from: field([(nil, [(" a b ", emphasis)])])), " *a b* ")
    }

    func testRunsThatShareAMarkShareItsDelimiters() {
        XCTAssertEqual(ComposerMarkdown.markdown(from: field([(nil, [("a", strong), ("b", strong.merging(emphasis) { $1 }), ("c", strong)])])), "**a*b*c**")
    }

    func testACodeSpanHoldingBackticksOpensWithMoreOfThem() {
        XCTAssertEqual(ComposerMarkdown.markdown(from: field([(nil, [("a`b", code)])])), "`` a`b ``")
        roundTrip("`` a`b ``")
        XCTAssertEqual(ComposerMarkdown.markdown(from: field([(.code, [("```", [:])])])), "````\n```\n````")
    }

    func testABlankOfAnyKindAtTheEndsOfARunStaysAsItIs() {
        for typed in ["\u{3000}テスト", "\u{A0}abc", "abc\u{3000}", "\t\u{A0}x \u{3000}"] {
            XCTAssertEqual(ComposerMarkdown.markdown(from: field([(nil, [(typed, [:])])])), typed)
        }
        XCTAssertEqual(ComposerMarkdown.markdown(from: field([(nil, [("\u{A0}abc\u{3000}", strong)])])), "\u{A0}**abc**\u{3000}")
    }

    func testADelimiterNextToPunctuationAndALetterMovesOffThePunctuation() {
        // `**foo.**bar` and `a**,**b` stay literal text when read: a closer after punctuation and before a letter is no closer, an opener the mirror.
        XCTAssertEqual(ComposerMarkdown.markdown(from: field([(nil, [("foo.", strong), ("bar", [:])])])), "**foo**.bar")
        XCTAssertEqual(ComposerMarkdown.markdown(from: field([(nil, [("foo", [:]), (".bar", strong)])])), "foo.**bar**")
        XCTAssertEqual(ComposerMarkdown.markdown(from: field([(nil, [("a", [:]), (",", strong), ("b", [:])])])), "a,b")
        XCTAssertEqual(ComposerMarkdown.markdown(from: field([(nil, [("..", strong), ("init", [:])])])), "**.**.init")
        XCTAssertEqual(ComposerMarkdown.markdown(from: field([(nil, [("__", [:]), ("init", strong), ("__.py", [:])])])), "__**init**__.py")
        XCTAssertEqual(ComposerMarkdown.markdown(from: field([(nil, [("foo.", strong), (" bar", [:])])])), "**foo.** bar", "next to a blank it is a closer as it is")
    }

    /// The marks of each UTF-16 unit of a text, as strings that compare.
    private static func marksPerUnit(_ text: NSAttributedString) -> [String] {
        (0..<text.length).map { index in
            let attributes = text.attributes(at: index, effectiveRange: nil)
            return [attributes[.composerStrong] != nil ? "strong" : "", attributes[.composerEmphasis] != nil ? "emphasis" : "",
                    attributes[.composerCode] != nil ? "code" : "", (attributes[.strikethroughStyle] as? Int ?? 0) != 0 ? "strike" : ""].joined(separator: ",")
        }
    }

    /// Foundation's own reader is the oracle: what it returns for what the writer wrote is the field's text with the field's marks, character by character. The
    /// texts are built from a piece of each class the reader tells apart (a letter, ASCII punctuation, Unicode punctuation, a symbol it counts as a letter, an
    /// emoji, a blank of each kind, U+2028 which is no blank to it), each run bold, italic, struck through, code or none: all of two runs, a seeded sample of
    /// three. The text always comes back with no delimiter left in it. A letter keeps its marks; a blank, and punctuation next to a letter, may take its
    /// neighbours' (a delimiter around it would not read as one). A text that starts or ends with a blank (the reader drops it) or that the reader does not
    /// return as it is with no mark is no case of the writer's.
    func testTheMarksTheWriterEmitsAreTheMarksTheReaderReturns() {
        let pieces = ["a", "ab", "7", ".", "(", "!", "$", "+", "«", "—", "。", "€", "→", "©", "😀", "👨‍👩‍👧", " ", "\t", "\u{A0}", "\u{3000}", "\u{2028}"]
        let marks: [[NSAttributedString.Key: Any]] = [[:], strong, emphasis, strike, code]
        func blank(_ s: String) -> Bool { s.unicodeScalars.allSatisfy { $0 == " " || $0 == "\t" || $0.properties.generalCategory == .spaceSeparator } }
        func letter(_ scalar: Unicode.Scalar) -> Bool {
            CharacterSet.alphanumerics.contains(scalar) || (!scalar.isASCII && CharacterSet.symbols.contains(scalar)) || scalar == "\u{2028}"
        }
        var (checked, failures) = (0, [String]())
        func check(_ runs: [(String, [NSAttributedString.Key: Any])]) {
            let string = runs.map(\.0).joined()
            guard let first = string.first, let last = string.last, !blank(String(first)), !blank(String(last)) else { return }
            let plain = ComposerMarkdown.attributed(from: ComposerMarkdown.markdown(from: field([(nil, [(string, [:])])])))
            guard plain.string == string else { return }
            let text = field([(nil, runs)])
            let markdown = ComposerMarkdown.markdown(from: text)
            let read = ComposerMarkdown.attributed(from: markdown)
            checked += 1
            let (got, want) = (Self.marksPerUnit(read), Self.marksPerUnit(text))
            if read.string != text.string { failures.append("STRING \(markdown.debugDescription) for \(Self.shape(text))"); return }
            let scalars = Array(text.string.unicodeScalars)
            var unit = 0
            for (index, scalar) in scalars.enumerated() {
                defer { unit += scalar.utf16.count }
                if got[unit] == want[unit] || CharacterSet.whitespaces.contains(scalar) { continue }
                // Punctuation next to a letter is written outside the marks that end there: a delimiter after it would not read as one.
                let beside = (index > 0 && letter(scalars[index - 1])) || (index + 1 < scalars.count && letter(scalars[index + 1]))
                if letter(scalar) || !beside { failures.append("MARKS \(markdown.debugDescription) for \(Self.shape(text))"); return }
            }
        }
        for a in pieces { for b in pieces { for m in marks { for n in marks { check([(a, m), (b, n)]) } } } }
        var seed: UInt64 = 20_261_127
        func next(_ count: Int) -> Int {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Int((seed >> 33) % UInt64(count))
        }
        for _ in 0..<40_000 { check((0..<3).map { _ in (pieces[next(pieces.count)], marks[next(marks.count)]) }) }
        XCTAssertGreaterThan(checked, 30000, "the guards left the oracle too few texts to judge")
        XCTAssertEqual(failures.count, 0, "\(failures.count) of \(checked):\n" + failures.prefix(25).joined(separator: "\n"))
    }

    func testACodeSpanKeepsASpaceAtBothEnds() {
        XCTAssertEqual(ComposerMarkdown.markdown(from: field([(nil, [(" x ", code)])])), "`  x  `")
        XCTAssertEqual(ComposerMarkdown.attributed(from: ComposerMarkdown.markdown(from: field([(nil, [(" x ", code)])]))).string, " x ")
        XCTAssertEqual(ComposerMarkdown.attributed(from: ComposerMarkdown.markdown(from: field([(nil, [("  ", code)])]))).string, "  ")
        XCTAssertEqual(ComposerMarkdown.attributed(from: ComposerMarkdown.markdown(from: field([(nil, [(" a`b ", code)])]))).string, " a`b ")
    }

    func testNumbersCountFromOneInEachRun() {
        XCTAssertEqual(ComposerMarkdown.markdown(from: field([(.number, [("a", [:])]), (.number, [("b", [:])]), (.bullet, [("c", [:])]), (.number, [("d", [:])])])),
                       "1. a\n2. b\n\n- c\n\n1. d")
    }

    func testALinkAddressHoldingAParenthesisIsEncoded() {
        let text = field([(nil, [("x", [.link: URL(string: "https://example.com/a(b)")!])])])
        XCTAssertEqual(ComposerMarkdown.markdown(from: text), "[x](https://example.com/a(b%29)")
    }

    // MARK: the style

    func testTheFontFollowsTheMarksAndTheBlock() {
        let text = ComposerMarkdown.attributed(from: "# Head\n\nplain **bold** `code`")
        func font(at index: Int) -> NSFont { text.attribute(.font, at: index, effectiveRange: nil) as! NSFont }
        let ns = text.string as NSString
        XCTAssertEqual(font(at: 0).pointSize, 16)
        XCTAssertEqual(font(at: ns.range(of: "plain").location).pointSize, 14)
        XCTAssertNotEqual(font(at: ns.range(of: "bold").location), font(at: ns.range(of: "plain").location))
        XCTAssertEqual(font(at: ns.range(of: "code").location).pointSize, 12.5)
    }

    func testOnlyTheFirstParagraphTakesTheFirstLineIndent() {
        let text = NSMutableAttributedString(attributedString: ComposerMarkdown.attributed(from: "one\ntwo"))
        ComposerMarkdown.style(text, firstLineIndent: 40)
        func indent(at index: Int) -> CGFloat { (text.attribute(.paragraphStyle, at: index, effectiveRange: nil) as! NSParagraphStyle).firstLineHeadIndent }
        XCTAssertEqual(indent(at: 0), 40)
        XCTAssertEqual(indent(at: 4), 0)
        ComposerMarkdown.style(text, firstLineIndent: 0)
        XCTAssertEqual(indent(at: 0), 0)
    }

    func testEveryRunCarriesTheTextColor() {
        let text = ComposerMarkdown.attributed(from: "a **b** `c` [d](https://example.com)")
        var colors: Set<NSColor> = []
        text.enumerateAttribute(.foregroundColor, in: NSRange(location: 0, length: text.length)) { value, _, _ in colors.insert(value as? NSColor ?? .clear) }
        XCTAssertEqual(colors, [NSColor(PardnerColor.text)])
    }

    func testAnAttributeTheFieldHasNoMarkForIsCleared() {
        let text = NSMutableAttributedString(string: "abc", attributes: [.underlineStyle: 1, .foregroundColor: NSColor.red, .strokeWidth: 3, .kern: 2, .link: URL(string: "https://example.com")!])
        ComposerMarkdown.style(text, firstLineIndent: 0)
        let attributes = text.attributes(at: 0, effectiveRange: nil)
        XCTAssertNil(attributes[.underlineStyle])
        XCTAssertNil(attributes[.strokeWidth])
        XCTAssertNil(attributes[.kern])
        XCTAssertEqual(attributes[.foregroundColor] as? NSColor, NSColor(PardnerColor.text))
        XCTAssertNotNil(attributes[.link], "a link is one of the field's marks")
    }

    func testAListItemHangsItsWrappedLinesAtItsText() {
        let text = ComposerMarkdown.attributed(from: "- a")
        let style = text.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as! NSParagraphStyle
        XCTAssertEqual(style.headIndent, ComposerMarkdown.Block.bullet.indent)
        XCTAssertGreaterThan(style.headIndent, 0)
    }
}
