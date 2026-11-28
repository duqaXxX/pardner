// One text view for a whole message (#194, unit 1): the attributed string a message becomes, what a copy of its selection holds, that the view stays
// on TextKit 2, and the height it takes against today's block path. The view is built and tested here, not yet used by a row.
import AppKit
@testable import Conversation
import DesignSystem
import Foundation
@testable import Screens
import SwiftUI
import XCTest

@MainActor
final class MessageTextTests: XCTestCase {
    /// Two paragraphs, a list, a quote of two paragraphs, a named code block and a last paragraph.
    private let mixed = """
    First paragraph with `code` and a [link](https://example.com/x).

    Second paragraph.

    - item one
    - item two

    > quoted one
    >
    > quoted two

    ```swift
    let x = 1
    let y = 2
    ```

    Last words.
    """

    private func pieces(_ text: String) throws -> [MarkdownBlocks.Piece] {
        PardnerFonts.register()
        guard case .read(let pieces, _) = MarkdownBlocks.read(text) else { throw XCTSkip("refused: \(text)") }
        return pieces
    }

    private func textViews(in view: NSView) -> [MessageTextView] {
        (view as? MessageTextView).map { [$0] } ?? view.subviews.flatMap(textViews)
    }

    /// The message in a window, laid out at `width`, and the view that draws it.
    private func shown(_ text: String, width: CGFloat = 400, mention: String? = nil, foldKey: String? = nil, blocks: OpenBlocks = OpenBlocks()) throws -> (MessageTextView, NSWindow) {
        PardnerFonts.register()
        let root = MessageText(text: text, mention: mention, foldKey: foldKey, blocks: blocks, open: { _ in }).frame(width: width)
        let host = NSHostingView(rootView: root)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 800), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        return (try XCTUnwrap(textViews(in: host).first), window)
    }

    /// What `view` writes for its selection: the plain string, and the text read back from the RTF.
    private func copied(_ view: MessageTextView) throws -> (string: String, rtf: String, raw: String) {
        let board = NSPasteboard(name: NSPasteboard.Name("pardner-test-copy-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        board.clearContents()
        XCTAssertTrue(view.writeSelection(to: board, types: [.rtfd, .rtf, .string]))
        let rtf = try XCTUnwrap(board.data(forType: .rtf))
        return (try XCTUnwrap(board.string(forType: .string)), try NSAttributedString(data: rtf, options: [:], documentAttributes: nil).string, String(decoding: rtf, as: UTF8.self))
    }

    func testSelectAllAndCopyGivesTheMessageAsDrawnWithBlankLinesWhereTheBlockPathLeavesAGap() throws {
        let (view, _) = try shown(mixed)
        view.selectAll(nil)
        let expected = "First paragraph with code and a link.\n\nSecond paragraph.\n\n•\titem one\n•\titem two\n\nquoted one\n\nquoted two\n\nlet x = 1\nlet y = 2\n\nLast words."
        let copy = try copied(view)
        XCTAssertEqual(copy.string, expected)
        XCTAssertEqual(copy.rtf, expected, "the RTF holds the same text as the plain string")
        XCTAssertFalse(copy.rtf.contains("swift"), "the code header is not copied as RTF either")
        XCTAssertFalse(copy.raw.contains("pardner-link"), "a link would paste as its placeholder")
        XCTAssertFalse(copy.raw.contains("\\cf1"), "a colour of the theme would paste as white text in the dark theme")
    }

    func testAPartialSelectionFromAParagraphIntoACodeBlockCopiesAcrossAndLeavesTheHeaderOut() throws {
        let (view, _) = try shown(mixed)
        let text = view.string as NSString
        let from = text.range(of: "paragraph.\n").location, to = text.range(of: "let x").upperBound
        view.setSelectedRange(NSRange(location: from, length: to - from))
        XCTAssertEqual(try copied(view).string, "paragraph.\n\n•\titem one\n•\titem two\n\nquoted one\n\nquoted two\n\nlet x")
    }

    func testTheFoldFooterIsNotCopiedClosedOrOpen() throws {
        let code = (1...31).map { "line \($0)" }.joined(separator: "\n")
        let message = "```\n\(code)\n```"
        let blocks = OpenBlocks()
        let (closed, _) = try shown(message, foldKey: "m", blocks: blocks)
        XCTAssertTrue(closed.string.contains("Show all 31 lines"), "the footer is drawn")
        closed.selectAll(nil)
        XCTAssertEqual(try copied(closed).string, (1...24).map { "line \($0)" }.joined(separator: "\n"))
        blocks.toggle(LongBlock.key(message: "m", block: 0))
        let (open, _) = try shown(message, foldKey: "m", blocks: blocks)
        XCTAssertTrue(open.string.contains("Show less"))
        open.selectAll(nil)
        XCTAssertEqual(try copied(open).string, code)
    }

    func testTheCopyActionWritesTheSelectionNotTheStoredText() throws {
        let (view, window) = try shown(mixed)
        window.makeFirstResponder(view)
        view.selectAll(nil)
        let board = NSPasteboard.general
        let saved = board.pasteboardItems?.map { item in item.types.reduce(into: [NSPasteboard.PasteboardType: Data]()) { $0[$1] = item.data(forType: $1) } } ?? []
        defer {
            board.clearContents()
            board.writeObjects(saved.map { held in
                let item = NSPasteboardItem()
                for (type, data) in held { item.setData(data, forType: type) }
                return item
            })
        }
        board.clearContents()
        view.copy(nil)
        XCTAssertTrue(try XCTUnwrap(board.string(forType: .string)).contains("quoted two\n\nlet x = 1"))
        XCTAssertFalse(try XCTUnwrap(board.string(forType: .string)).contains("swift"))
    }

    func testEachPieceOwnsItsTrailingLineEndAndTheLastHasNone() throws {
        let read = try pieces(mixed)
        let built = MessageString.build(read, mention: nil, size: 14, foldKey: nil, blocks: OpenBlocks())
        let string = built.string.string as NSString
        XCTAssertEqual(built.starts.count, read.count)
        XCTAssertEqual(built.starts.first, 0)
        for i in 1..<read.count {
            XCTAssertEqual(string.substring(with: NSRange(location: built.starts[i] - 1, length: 1)), "\n", "piece \(i - 1) ends with its line end")
            let style = built.string.attribute(.paragraphStyle, at: built.starts[i] - 1, effectiveRange: nil) as? NSParagraphStyle
            let own = built.string.attribute(.paragraphStyle, at: max(built.starts[i] - 2, built.starts[i - 1]), effectiveRange: nil) as? NSParagraphStyle
            XCTAssertEqual(style?.paragraphSpacing, own?.paragraphSpacing, "the line end has its piece's paragraph")
        }
        XCTAssertFalse(built.string.string.hasSuffix("\n"))
        XCTAssertEqual(string.substring(from: built.starts.last!), "Last words.")
    }

    func testTheViewStaysOnTextKit2() throws {
        var switched = 0
        let token = NotificationCenter.default.addObserver(forName: NSTextView.willSwitchToNSLayoutManagerNotification, object: nil, queue: nil) { _ in switched += 1 }
        defer { NotificationCenter.default.removeObserver(token) }
        let (view, window) = try shown(mixed + "\n\n| a | b |\n|---|---|\n| 1 | 2 |")
        view.selectAll(nil)
        window.makeFirstResponder(view)
        view.display()
        XCTAssertEqual(switched, 0)
        XCTAssertNotNil(view.textLayoutManager)
    }

    func testAMentionOpensTheFirstParagraphOrHasALineOfItsOwn() throws {
        let joined = MessageString.build(try pieces("hello"), mention: "@bot", size: 14, foldKey: nil, blocks: OpenBlocks())
        XCTAssertEqual(joined.string.string, "@bot hello")
        XCTAssertNotNil(joined.string.attribute(MessageString.mentionRun, at: 0, effectiveRange: nil))
        XCTAssertNil(joined.string.attribute(MessageString.mentionRun, at: 6, effectiveRange: nil))
        let alone = MessageString.build(try pieces("# Title"), mention: "@bot", size: 14, foldKey: nil, blocks: OpenBlocks())
        XCTAssertEqual(alone.string.string, "@bot\nTitle")
        XCTAssertEqual(alone.starts, [5])
    }

    func testAClickOnALinkReachesTheConfirmationAndOpensNothingElse() throws {
        let links = [try XCTUnwrap(URL(string: "https://a.example/x"))]
        var confirmations: [LinkConfirmation?] = []
        let coordinator = MessageText.Coordinator(open: { confirmations.append(LinkConfirmation($0, links: links)) })
        let (view, _) = try shown(mixed)
        XCTAssertTrue(view.delegate is MessageText.Coordinator, "makeNSView sets the delegate, or a click on a link opens nothing")
        let link = (view.string as NSString).range(of: "link.").location
        XCTAssertEqual(view.textStorage?.attribute(.link, at: link, effectiveRange: nil) as? URL, URL(string: "pardner-link:0"))
        XCTAssertTrue(coordinator.textView(view, clickedOnLink: try XCTUnwrap(URL(string: "pardner-link:0")), at: link))
        XCTAssertEqual(confirmations.compactMap { $0?.url }, [links[0]])
        XCTAssertTrue(coordinator.textView(view, clickedOnLink: try XCTUnwrap(URL(string: "https://a.example/x")), at: 0))
        XCTAssertNil(confirmations[1], "a real address is no link of the text")
        XCTAssertEqual(view.linkTextAttributes?[.cursor] as? NSCursor, NSCursor.pointingHand)
    }

    func testTheViewTakesTheNaturalWidthOfAShortTextAndNoMoreThanTheProposedOneOfALongText() throws {
        let (short, _) = try shown("short")
        let one = try XCTUnwrap(short.fit(width: nil))
        XCTAssertLessThan(one.width, 60, "as wide as its line, as LinkText.measure answers")
        XCTAssertEqual(try XCTUnwrap(short.fit(width: 400)).width, one.width, "a wider proposal changes nothing")
        let (long, _) = try shown(String(repeating: "alpha beta gamma delta ", count: 20))
        let wrapped = try XCTUnwrap(long.fit(width: 400))
        XCTAssertLessThanOrEqual(wrapped.width, 400)
        XCTAssertGreaterThan(wrapped.width, 350, "as wide as its longest line")
        XCTAssertGreaterThan(wrapped.height, one.height * 3)
        let (code, _) = try shown("```\nx\n```")
        XCTAssertEqual(try XCTUnwrap(code.fit(width: 400)).width, 400, "a code card takes the width it is given")
    }

    func testAMessageThatLosesFocusClearsItsSelection() throws {
        let (view, window) = try shown(mixed)
        XCTAssertTrue(window.makeFirstResponder(view))
        view.selectAll(nil)
        XCTAssertGreaterThan(view.selectedRange().length, 0)
        XCTAssertTrue(window.makeFirstResponder(nil))
        XCTAssertEqual(view.selectedRange().length, 0)
    }

    func testATextTheBoundsRefuseIsOneRunOfText() throws {
        let long = String(repeating: "word ", count: CodeSpans.most / 5 + 10)
        let (view, _) = try shown(long)
        XCTAssertEqual(view.string, long)
    }

    /// Where the first character of `word` in `view`'s text is drawn, from the left.
    private func x(of word: String, in view: MessageTextView) throws -> CGFloat {
        let layout = try XCTUnwrap(view.textLayoutManager)
        let range = (view.string as NSString).range(of: word)
        let start = try XCTUnwrap(layout.location(layout.documentRange.location, offsetBy: range.location))
        let end = try XCTUnwrap(layout.location(start, offsetBy: 1))
        var found: CGFloat?
        layout.enumerateTextSegments(in: try XCTUnwrap(NSTextRange(location: start, end: end)), type: .standard, options: []) { _, frame, _, _ in
            found = frame.minX
            return false
        }
        return try XCTUnwrap(found, word)
    }

    func testAnItemsMarkerHangsOneStepBeforeItsTextAndAQuoteAndACodeBlockAreIndented() throws {
        let (view, _) = try shown("- one\n  - inner\n\n> quoted\n\n```swift\ncoded\n```\n\n```\nbare\n```")
        XCTAssertEqual(try x(of: "•\tone", in: view), 0, accuracy: 0.5)
        XCTAssertEqual(try x(of: "one", in: view), MarkdownView.listStep, accuracy: 0.5)
        XCTAssertEqual(try x(of: "inner", in: view), 2 * MarkdownView.listStep, accuracy: 0.5)
        XCTAssertEqual(try x(of: "quoted", in: view), MarkdownView.barWidth + MarkdownView.barGap, accuracy: 0.5)
        XCTAssertEqual(try x(of: "coded", in: view), 12, accuracy: 0.5)
        XCTAssertEqual(try x(of: "bare", in: view), 12, accuracy: 0.5)
    }

    func testCodeWrapsShortOfTheCardsEdgeAndTheCornerButtonsRoom() throws {
        let line = String(repeating: "word ", count: 40)
        for (fence, room) in [("```swift", 12), ("```", 34)] as [(String, CGFloat)] {
            let (view, _) = try shown("\(fence)\n\(line)\n```", width: 300)
            let layout = try XCTUnwrap(view.textLayoutManager)
            var right: CGFloat = 0
            layout.enumerateTextLayoutFragments(from: layout.documentRange.location, options: [.ensuresLayout]) { fragment in
                for line in fragment.textLineFragments { right = max(right, line.typographicBounds.maxX) }
                return true
            }
            XCTAssertLessThanOrEqual(right, 300 - room + 0.5, fence)
            XCTAssertGreaterThan(right, 300 - room - 50, fence)
        }
    }

    func testTheContainerFollowsTheFrameInALazyStackWhenTheWindowChangesWidth() throws {
        PardnerFonts.register()
        let text = String(repeating: "alpha beta gamma delta epsilon zeta eta theta ", count: 8) + "\n\n- one\n- two"
        let host = NSHostingView(rootView: ScrollView { LazyVStack(alignment: .leading) { MessageText(text: text, open: { _ in }).designLines() } })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host
        var heights: [CGFloat] = []
        for width in [400, 700, 400] as [CGFloat] {
            window.setContentSize(NSSize(width: width, height: 600))
            host.layoutSubtreeIfNeeded()
            let view = try XCTUnwrap(textViews(in: host).first, "width \(width)")
            let container = try XCTUnwrap(view.textContainer)
            XCTAssertEqual(container.size.width, view.frame.width, accuracy: 1, "width \(width)")
            XCTAssertLessThanOrEqual(view.frame.width, width)
            let layout = try XCTUnwrap(view.textLayoutManager)
            XCTAssertEqual(view.frame.height, ceil(layout.usageBoundsForTextContainer.height), accuracy: 1, "width \(width)")
            heights.append(view.frame.height)
        }
        XCTAssertEqual(heights[0], heights[2], "back at the first width, the first height")
        XCTAssertGreaterThan(heights[0], heights[1] + 10, "narrower wraps to more lines")
    }

    // MARK: the review's fixes (#194, unit 1, round 1)

    private func lines(_ view: MessageTextView) -> Int {
        var count = 0
        view.textLayoutManager?.enumerateTextLayoutFragments(from: view.textLayoutManager?.documentRange.location, options: [.ensuresLayout]) { fragment in
            count += fragment.textLineFragments.count
            return true
        }
        return count
    }

    /// A view with `string` as its text, not in a window, as a streamed update changes it.
    private func bare(_ string: NSAttributedString, _ built: MessageString.Built) -> MessageTextView {
        let view = MessageTextView(usingTextLayoutManager: true)
        LinkText.configure(view)
        view.room = (built.top, built.bottom)
        view.textStorage?.setAttributedString(string)
        return view
    }

    /// K1: a piece's characters and attributes are its own, whether it is the last or not, so that a streamed append changes nothing before the
    /// previous piece's line end, and the string the update leaves is the string a fresh build gives.
    func testAPiecesStringDoesNotDependOnBeingTheLastAndAStreamedAppendIsAsHighAsAFreshBuild() throws {
        for text in [mixed, "```swift\nlet x = 1\n```\n\nafter", "```\nlet x = 1\n```\n\nafter", "para\n\n```\nlet x = 1\n```\n\nafter", "- a\n- b\n\n> q\n\nafter\n\n---\n\nz"] {
            let all = try pieces(text)
            let full = MessageString.build(all, mention: nil, size: 14, foldKey: nil, blocks: OpenBlocks())
            for k in 1..<all.count {
                let old = MessageString.build(Array(all[0..<k]), mention: nil, size: 14, foldKey: nil, blocks: OpenBlocks())
                let prefix = full.string.attributedSubstring(from: NSRange(location: 0, length: full.starts[k] - 1))
                XCTAssertTrue(prefix.isEqual(to: old.string), "the first \(k) pieces: \(text.prefix(20))")
                let streamed = bare(old.string, full)
                streamed.textStorage?.replaceCharacters(in: NSRange(location: old.string.length, length: 0),
                                                        with: full.string.attributedSubstring(from: NSRange(location: full.starts[k] - 1, length: full.string.length - full.starts[k] + 1)))
                XCTAssertTrue(try XCTUnwrap(streamed.textStorage).isEqual(to: full.string), "the streamed string is the built one: \(text.prefix(20))")
                XCTAssertEqual(try XCTUnwrap(streamed.fit(width: 400)).height, try XCTUnwrap(bare(full.string, full).fit(width: 400)).height, "k=\(k): \(text.prefix(20))")
            }
        }
    }

    /// A1: a soft break ends a paragraph of the text storage, and only the piece's first paragraph has the hanging or the mention's indent.
    func testASoftBreakInAListItemOrAfterTheMentionTakesNoFirstLineIndent() throws {
        let (item, _) = try shown("- first line\n  second line\n\n- other")
        XCTAssertEqual(try x(of: "first", in: item), MarkdownView.listStep, accuracy: 0.5)
        XCTAssertEqual(try x(of: "second", in: item), MarkdownView.listStep, accuracy: 0.5, "the block path puts the item's later lines under its text")
        let (quote, _) = try shown("> one\n> two")
        XCTAssertEqual(try x(of: "two", in: quote), try x(of: "one", in: quote), accuracy: 0.5)
        let (mentioned, _) = try shown("hello\nsecond line", mention: "@bot")
        XCTAssertEqual(try x(of: "@bot", in: mentioned), MentionedText.side, accuracy: 0.5)
        XCTAssertEqual(try x(of: "second", in: mentioned), 0, accuracy: 0.5, "the block path starts a later line at the column")
    }

    /// A3: a probe at no width, at none and at an infinite one leaves the container as the frame says when the frame is then set to what it was.
    func testAProbeAtNoWidthZeroOrInfiniteLeavesTheContainerAtTheFramesWidthAndTheTextWrapped() throws {
        let long = String(repeating: "alpha beta gamma delta epsilon zeta eta theta ", count: 8)
        let (view, window) = try shown(long)
        let frame = view.frame, wrapped = lines(view)
        XCTAssertGreaterThan(wrapped, 3)
        for probe in [nil, 0, .infinity] as [CGFloat?] {
            _ = view.fit(width: probe)
            XCTAssertNotEqual(try XCTUnwrap(view.textContainer).size.width, frame.width, "the probe moved the container: \(String(describing: probe))")
            view.frame = frame
            window.contentView?.layoutSubtreeIfNeeded()
            XCTAssertEqual(try XCTUnwrap(view.textContainer).size.width, frame.width, accuracy: 1, "after a probe at \(String(describing: probe))")
            XCTAssertEqual(lines(view), wrapped, "after a probe at \(String(describing: probe))")
        }
    }

    /// A4: the copy of a selection of several ranges is each range's, one line end between two, as AppKit's own copy joins them.
    func testACopyOfTwoRangesJoinsThemWithALineEnd() throws {
        let (view, _) = try shown(mixed)
        let text = view.string as NSString
        view.setSelectedRanges([NSValue(range: text.range(of: "Second paragraph.")), NSValue(range: text.range(of: "Last words."))], affinity: .downstream, stillSelecting: false)
        XCTAssertEqual(view.selectedRanges.count, 2)
        XCTAssertEqual(try copied(view).string, "Second paragraph.\nLast words.")
    }

    /// A5: the text the bounds refuse has the mention at the column, as the paragraph of the block path has it.
    func testTheMentionOfATextTheBoundsRefuseStandsOneSideInAndItsLaterLinesDoNot() throws {
        let long = String(repeating: "word ", count: CodeSpans.most / 5 + 10) + "\nsecond line"
        let (view, _) = try shown(long, mention: "@bot")
        XCTAssertEqual(try x(of: "@bot", in: view), MentionedText.side, accuracy: 0.5)
        XCTAssertEqual(try x(of: "second", in: view), 0, accuracy: 0.5)
        let style = try XCTUnwrap(view.textStorage?.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)
        XCTAssertEqual(style.firstLineHeadIndent, MentionedText.side)
        XCTAssertEqual(style.lineSpacing, MessageRow.lineSpacing)
    }

    /// K2: a rule is one blank line from its neighbours at most: the gap from `a` to it and from it to `b` is one gap, and its own line end is not copied.
    func testARuleCopiesAsOneBlankLineBetweenItsNeighbours() throws {
        let (view, _) = try shown("a\n\n---\n\nb")
        view.selectAll(nil)
        XCTAssertEqual(try copied(view).string, "a\n\nb")
        let (first, _) = try shown("---\n\nb")
        first.selectAll(nil)
        XCTAssertEqual(try copied(first).string, "b")
    }

    /// K3: a selection of what a copy leaves out writes nothing, so the clipboard keeps what it held.
    func testASelectionOfOnlyTheHeaderOrTheFooterLeavesTheClipboardAsItWas() throws {
        let code = (1...31).map { "line \($0)" }.joined(separator: "\n")
        for (message, selected, key) in [("```swift\nlet x = 1\n```", "swift", nil), ("```\n\(code)\n```", "Show all 31 lines", "m")] as [(String, String, String?)] {
            let (view, _) = try shown(message, foldKey: key)
            view.setSelectedRange((view.string as NSString).range(of: selected))
            XCTAssertGreaterThan(view.selectedRange().length, 0)
            let board = NSPasteboard(name: NSPasteboard.Name("pardner-test-copy-\(UUID().uuidString)"))
            defer { board.releaseGlobally() }
            board.clearContents()
            board.setString("what the owner copied before", forType: .string)
            XCTAssertFalse(view.writeSelection(to: board, types: [.rtfd, .rtf, .string]), selected)
            XCTAssertEqual(board.string(forType: .string), "what the owner copied before", selected)
        }
    }

    /// K4: a triple-click selects a paragraph with its line end, and the copy has that line end and no blank line after it.
    func testASelectionEndingOnAParagraphsLineEndCopiesNoBlankLineAfterIt() throws {
        let (view, _) = try shown("one\n\ntwo")
        view.setSelectedRange(NSRange(location: 0, length: 4))
        XCTAssertEqual(try copied(view).string, "one\n")
        view.selectAll(nil)
        XCTAssertEqual(try copied(view).string, "one\n\ntwo")
    }

    /// A7: a message drawn first with no fold key and then with one is another source: the footer is part of what is built.
    func testTheFoldKeyIsPartOfTheSourceTheViewWasSetFrom() throws {
        PardnerFonts.register()
        let message = "```\n" + (1...31).map { "line \($0)" }.joined(separator: "\n") + "\n```"
        let coordinator = MessageText.Coordinator(open: { _ in })
        let view = MessageTextView(usingTextLayoutManager: true)
        MessageText(text: message, foldKey: nil, blocks: OpenBlocks(), open: { _ in }).apply(to: view, coordinator: coordinator)
        XCTAssertFalse(view.string.contains("Show all"))
        MessageText(text: message, foldKey: "m", blocks: OpenBlocks(), open: { _ in }).apply(to: view, coordinator: coordinator)
        XCTAssertTrue(view.string.contains("Show all 31 lines"))
    }

    /// A6: an empty code block is one empty line with its room, as high as a block of one line; a body that ends in a blank line is as high as the same body
    /// with a letter on that line, whether the block is last or not, and the block path draws the latter as high.
    func testACodeBlockWithNoLinesOrWithABlankLastLineIsAsHighAsOneWithTheLinesFilled() {
        for fence in ["```", "```swift"] {
            for (around, width) in [("%@", 180), ("before\n\n%@\n\nafter", 180), ("before\n\n%@", 600)] as [(String, CGFloat)] {
                func message(_ body: String) -> String { String(format: around, "\(fence)\n\(body)```") }
                func high(_ body: String) -> CGFloat { height(MessageText(text: message(body), open: { _ in }), width: width) }
                let label = "\(fence) in \(around.debugDescription) at \(width)"
                XCTAssertEqual(high("\n"), high("x\n"), accuracy: 1, "an empty block is one line: \(label)")
                XCTAssertEqual(high("x\n\n"), high("x\ny\n"), accuracy: 1, "a blank last line is a line: \(label)")
                XCTAssertEqual(high("\n\n"), high("x\ny\n"), accuracy: 1, "two blank lines are two lines: \(label)")
                XCTAssertEqual(high("x\n\n"), height(MarkdownView(text: message("x\n\n")), width: width), accuracy: 1, "as the block path draws it: \(label)")
            }
        }
    }

    // MARK: heights against the block path

    /// The height `view` takes at `width`, in a row's design lines, as the thread lays it out.
    private func height(_ view: some View, width: CGFloat) -> CGFloat {
        PardnerFonts.register()
        let host = NSHostingView(rootView: view.designLines().frame(width: width, alignment: .topLeading).fixedSize(horizontal: false, vertical: true))
        host.layoutSubtreeIfNeeded()
        return host.fittingSize.height
    }

    func testAParagraphIsAsHighAsTheBlockPathDrawsIt() {
        let text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega"
        for width in [140, 260, 600] as [CGFloat] {
            XCTAssertEqual(height(MessageText(text: text, open: { _ in }), width: width), height(MarkdownView(text: text), width: width), accuracy: 1, "width \(width)")
        }
    }

    /// Two items in a row are 4 points apart on the block path; here they are one line spacing apart at least (TextKit 2 puts the line spacing
    /// above every line but the text's first), so each pair of neighbouring items stands that much further apart (the two heights are whole points, hence 1.5 where there is a pair). Measured, 2026-11-28.
    func testAMixedMessageIsAsHighAsTheBlockPathDrawsItButForTheSpaceBetweenItems() {
        let nested = "1. first\n2. second\n   - inner one\n   - inner two\n\n   continued"
        let unnamed = "```\nplain one\nplain two\n```"
        let words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron"
        let cases: [(text: String, itemBoundaries: Int)] = [
            (mixed, 1), (nested, 3), (unnamed, 0), ("# Title\n\n\(words)\n\n## Sub\n\n\(words)", 0),
            ("> \(words) \(words)\n>\n> \(words)\n\n---\n\nlast", 0), ("text\n\n```\nplain\n```", 0), ("```swift\nlet x = 1\n```\n\n```\nplain\n```", 0),
        ]
        for (text, boundaries) in cases {
            for width in [180, 600] as [CGFloat] {
                XCTAssertEqual(height(MessageText(text: text, open: { _ in }), width: width),
                               height(MarkdownView(text: text), width: width) + CGFloat(boundaries) * (MessageRow.lineSpacing - PardnerMetrics.itemGap), accuracy: boundaries > 0 ? 1.5 : 1,
                               "width \(width): \(text.prefix(30))")
            }
        }
    }

    // MARK: fix round 1 of unit 2's review

    /// G1: the copy keeps no `kern`, which is the room round an inline code span and after the mention: pasted into another app it would widen the gaps (RTF `\expnd`).
    func testACopyOfInlineCodeAndAMentionCarriesNoKern() throws {
        let (view, _) = try shown("run `npm test` now", mention: "@mini")
        var kerns = 0
        view.textStorage?.enumerateAttribute(.kern, in: NSRange(location: 0, length: view.string.count)) { value, _, _ in if value != nil { kerns += 1 } }
        XCTAssertGreaterThan(kerns, 0, "the string has its kerns")
        view.selectAll(nil)
        let copy = try copied(view)
        XCTAssertEqual(copy.string, "@mini run npm test now")
        XCTAssertFalse(copy.raw.contains("\\expnd"), "the RTF has no expansion: \(copy.raw)")
    }

    /// G4: the space after the mention of a text the bounds refuse, as `build` makes it: its kern holds the inline code's room when the text opens with a span.
    func testThePlainTextsMentionSpaceHoldsTheCodeInsetWhenTheTextOpensWithASpan() throws {
        PardnerFonts.register()
        func space(_ string: NSAttributedString) -> CGFloat? { string.attribute(.kern, at: "@mini".count, effectiveRange: nil) as? CGFloat }
        for (text, kern) in [("`npm test` fails", MentionedText.side + InlineCodeText.inset), ("npm `test` fails", MentionedText.side)] {
            let built = MessageString.build(try pieces(text), mention: "@mini", size: 14, foldKey: nil, blocks: OpenBlocks()).string
            XCTAssertEqual(space(built), kern, "build: \(text)")
            XCTAssertEqual(space(MessageString.plain(text, mention: "@mini", size: 14)), kern, "plain: \(text)")
        }
    }
}
