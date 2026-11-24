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

    func testTheTableHeaderRowIsDrawnHeavierThanABodyRow() {
        PardnerFonts.register()
        func width(_ table: String) -> CGFloat {
            let hosting = NSHostingView(rootView: MarkdownView(text: table))
            hosting.layoutSubtreeIfNeeded()
            return hosting.fittingSize.width
        }
        let word = "Medio Oriente Medio Oriente"
        let headed = width("| \(word) |\n| --- |\n| x |")
        let bodied = width("| x |\n| --- |\n| \(word) |")
        XCTAssertGreaterThan(headed, bodied + 2)
    }
}
