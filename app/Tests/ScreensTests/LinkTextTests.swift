// The text view that draws a piece holding a kept link (#73, step B2, design 2.4): what it converts to, what a click hands over, the
// pointing hand, and the height it lays out at against the SwiftUI `Text` it replaces.
import AppKit
import DesignSystem
import Foundation
@testable import Screens
import SwiftUI
import XCTest

private struct NotAParagraph: Error {}

@MainActor
final class LinkTextTests: XCTestCase {
    private func piece(_ markdown: String) throws -> AttributedString {
        PardnerFonts.register()
        guard case .read(let pieces, _) = MarkdownBlocks.read(markdown), case .paragraph(let text) = pieces[0].body
        else {
            XCTFail("not a paragraph: \(markdown)")
            throw NotAParagraph()
        }
        return text
    }

    private func fontOf(_ converted: NSAttributedString, at index: Int) throws -> NSFont {
        try XCTUnwrap(converted.attribute(.font, at: index, effectiveRange: nil) as? NSFont)
    }

    func testTheConversionKeepsTextLinksAndFonts() throws {
        let markdown = "plain **strong** *emph* `code` ~~gone~~ [link](https://example.com/x)"
        let converted = LinkText.attributed(try piece(markdown), size: 14, weight: .regular)
        XCTAssertEqual(converted.string, "plain strong emph code gone link")
        let text = converted.string as NSString
        func font(_ word: String) throws -> NSFont { try fontOf(converted, at: text.range(of: word).location) }
        XCTAssertEqual(try font("plain"), PardnerFont.uiCT(size: 14, weight: .regular) as NSFont)
        XCTAssertEqual(try font("strong"), PardnerFont.uiCT(size: 14, weight: .semibold) as NSFont)
        XCTAssertEqual(try font("emph"), PardnerFont.uiCT(size: 14, weight: .regular, italic: true) as NSFont)
        XCTAssertEqual(try font("code"), PardnerFont.monoCT(size: 12.5, weight: .regular) as NSFont)
        XCTAssertNotNil(converted.attribute(.backgroundColor, at: text.range(of: "code").location, effectiveRange: nil))
        XCTAssertEqual(converted.attribute(.strikethroughStyle, at: text.range(of: "gone").location, effectiveRange: nil) as? Int, 1)
        let link = text.range(of: "link", options: .backwards).location
        XCTAssertEqual(converted.attribute(.link, at: link, effectiveRange: nil) as? URL, URL(string: "pardner-link:0"))
        XCTAssertNil(converted.attribute(.link, at: 0, effectiveRange: nil))
    }

    func testAHeaderCellTakesTheHeadersColourAndItsCodeSpanTheHeadersSize() throws {
        let converted = LinkText.attributed(try piece("`code` [l](https://example.com/)"), size: 12, weight: .semibold, color: PardnerColor.muted, codeSize: 12)
        let muted = NSColor(PardnerColor.muted)
        XCTAssertEqual(converted.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor, muted)
        XCTAssertEqual(converted.attribute(.foregroundColor, at: converted.length - 1, effectiveRange: nil) as? NSColor, muted)
        XCTAssertEqual(try fontOf(converted, at: 0), PardnerFont.monoCT(size: 12, weight: .regular) as NSFont)
    }

    func testAHeadingStrongRunGoesBold() throws {
        let converted = LinkText.attributed(try piece("**ab** [l](https://example.com/)"), size: 18, weight: .semibold)
        XCTAssertEqual(try fontOf(converted, at: 0), PardnerFont.uiCT(size: 18, weight: .bold) as NSFont)
    }

    func testTheTextColourAndLineSpacingFollowTheDesign() throws {
        let converted = LinkText.attributed(try piece("a [l](https://example.com/)"), size: 14, weight: .regular)
        let colour = try XCTUnwrap(converted.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor)
        func resolved(_ name: NSAppearance.Name) -> NSColor {
            var out = NSColor.clear
            NSAppearance(named: name)!.performAsCurrentDrawingAppearance { out = colour.usingColorSpace(.sRGB)! }
            return out
        }
        XCTAssertNotEqual(resolved(.aqua), resolved(.darkAqua), "a dynamic colour: Light and Dark differ")
        let style = try XCTUnwrap(converted.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)
        XCTAssertEqual(style.lineSpacing, MessageRow.lineSpacing)
    }

    func testTheViewShowsThePointingHandAndNothingElseOpensALink() {
        let view = LinkText.makeTextView()
        XCTAssertEqual(view.linkTextAttributes?[.cursor] as? NSCursor, NSCursor.pointingHand)
        XCTAssertFalse(view.isEditable)
        XCTAssertTrue(view.isSelectable)
        XCTAssertFalse(view.isAutomaticLinkDetectionEnabled)
        XCTAssertFalse(view.isAutomaticDataDetectionEnabled)
        XCTAssertFalse(view.displaysLinkToolTips)
    }

    func testAClickOnALinkReachesTheConfirmationAndOpensNothingElse() throws {
        let links = [try XCTUnwrap(URL(string: "https://a.example/x"))]
        var confirmations: [LinkConfirmation?] = []
        let coordinator = LinkText.Coordinator(open: { confirmations.append(LinkConfirmation($0, links: links)) }, copy: nil)
        let view = LinkText.makeTextView()
        XCTAssertTrue(coordinator.textView(view, clickedOnLink: try XCTUnwrap(URL(string: "pardner-link:0")), at: 0))
        XCTAssertTrue(coordinator.textView(view, clickedOnLink: "pardner-link:0", at: 0))
        XCTAssertEqual(confirmations.compactMap { $0?.url }, [links[0], links[0]])
        XCTAssertTrue(coordinator.textView(view, clickedOnLink: try XCTUnwrap(URL(string: "https://a.example/x")), at: 0))
        XCTAssertNil(confirmations[2], "a real address is no link of the text")
    }

    func testTheMenuIsTheRowsCopyAndNothingElse() throws {
        PardnerFonts.register()
        var copied = 0
        let link = LinkText(text: try piece("a [link](https://example.com/x) b"), size: 14, weight: .regular, open: { _ in }, copy: { copied += 1 })
        let coordinator = link.makeCoordinator()
        let view = LinkText.makeTextView()
        view.delegate = coordinator
        link.apply(to: view, coordinator: coordinator)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 100), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 30)
        view.layoutManager?.ensureLayout(for: view.textContainer!)
        let event = try XCTUnwrap(NSEvent.mouseEvent(
            with: .rightMouseDown, location: NSPoint(x: 15, y: 25), modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
            context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
        XCTAssertEqual(view.characterIndexForInsertion(at: view.convert(event.locationInWindow, from: nil)), 3, "the point is on the link")
        let items = try XCTUnwrap(view.menu(for: event)).items
        XCTAssertEqual(items.count, 1)
        let item = try XCTUnwrap(items.first)
        XCTAssertEqual(item.action, #selector(LinkText.Coordinator.copyAnswer(_:)))
        XCTAssertTrue(item.target === coordinator)
        XCTAssertTrue(NSApp.sendAction(try XCTUnwrap(item.action), to: item.target, from: item))
        XCTAssertEqual(copied, 1)
    }

    func testASecondApplyOfTheSameSourceKeepsTheSelection() throws {
        // An emoji makes AppKit fix the attributes of the stored text, so the stored text never equals a fresh conversion.
        let link = LinkText(text: try piece("a 😀 b [link](https://example.com/x) c"), size: 14, weight: .regular, open: { _ in })
        let coordinator = link.makeCoordinator()
        let view = LinkText.makeTextView()
        link.apply(to: view, coordinator: coordinator)
        view.setSelectedRange(NSRange(location: 2, length: 3))
        link.apply(to: view, coordinator: coordinator)
        XCTAssertEqual(view.selectedRange(), NSRange(location: 2, length: 3))
    }

    private func textViews(in view: NSView) -> [NSTextView] {
        (view as? NSTextView).map { [$0] } ?? view.subviews.flatMap(textViews)
    }

    func testTheContainerFollowsTheFrameInALazyStackWhenTheWindowChangesWidth() throws {
        PardnerFonts.register()
        let text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon [link](https://example.com/x) phi chi psi omega"
        let host = NSHostingView(rootView: ScrollView { LazyVStack(alignment: .leading) { MarkdownView(text: text).designLines() } })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host
        for width in [400, 700, 400] as [CGFloat] {
            window.setContentSize(NSSize(width: width, height: 600))
            host.layoutSubtreeIfNeeded()
            let view = try XCTUnwrap(textViews(in: host).first, "width \(width)")
            let container = try XCTUnwrap(view.textContainer)
            XCTAssertEqual(container.containerSize.width, view.frame.width, accuracy: 1, "width \(width)")
            let used = try XCTUnwrap(view.layoutManager).usedRect(for: container)
            XCTAssertGreaterThan(view.frame.height, 17 + MessageRow.lineSpacing, "width \(width): more than one line")
            XCTAssertEqual(view.frame.height, ceil(used.height), accuracy: 1, "width \(width)")
        }
    }

    func testTheHeightOfTwoLinesIsThatOfTheSwiftUITextForTheSameString() throws {
        let text = try piece("alpha beta gamma delta epsilon zeta [eta](https://example.com/x) theta iota")
        let styled = MarkdownFonts.styled(text, size: 14, weight: .regular)
        func height(_ view: some View, width: CGFloat) -> CGFloat {
            let hosting = NSHostingView(rootView: view.frame(width: width))
            hosting.layoutSubtreeIfNeeded()
            return hosting.fittingSize.height
        }
        func link(_ width: CGFloat) -> CGFloat { height(LinkText(text: text, size: 14, weight: .regular) { _ in }, width: width) }
        func swiftUI(_ width: CGFloat) -> CGFloat {
            height(Text(styled).lineSpacing(MessageRow.lineSpacing).fixedSize(horizontal: false, vertical: true), width: width)
        }
        XCTAssertGreaterThan(link(160), link(2000) + 10, "narrower wraps to more lines")
        for width in [160, 2000] as [CGFloat] { XCTAssertEqual(link(width), swiftUI(width), accuracy: 3, "width \(width)") }
    }

    func testAMarkdownViewWithALinkLaysOutInBothThemes() {
        let text = "# Title [a](https://example.com/a)\n\nSome text with a [link](https://example.com/b).\n\n| a | b |\n|---|---|\n| [c](https://example.com/c) | 2 |"
        for name in [NSAppearance.Name.aqua, .darkAqua] {
            let hosting = NSHostingView(rootView: MarkdownView(text: text).frame(width: 600))
            hosting.appearance = NSAppearance(named: name)
            hosting.layoutSubtreeIfNeeded()
            XCTAssertGreaterThan(hosting.fittingSize.height, 80)
        }
    }
}
