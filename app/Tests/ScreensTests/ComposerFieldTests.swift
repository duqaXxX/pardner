// The composer's field in a window (#129, #167): it holds the model's Markdown as rich text and tells the model Markdown back, and the first line of its
// text starts after the bot's chip while the lines after it start under the chip.
import AppKit
import Conversation
import DesignSystem
import Foundation
import ProtocolHost
@testable import Relay
@testable import Screens
import SwiftUI
import XCTest

@MainActor
final class ComposerFieldTests: XCTestCase {
    private let channel = Data(repeating: 0x3F, count: 32), mini = Data(repeating: 2, count: 32)
    private var outcome: SendOutcome = .queued(name: Data(repeating: 0xE1, count: 16))

    private func model(label: Bool = true, named: String? = nil) -> ComposerModel {
        var state = DevicesState()
        state.rows = [DeviceRow(id: mini, kind: .bot, label: named, shortForm: "", adder: .none, position: 2, active: true, isThisMac: false, seenAt: nil,
                                onlyHolderEpochs: 0, addedWhileRemoving: false)]
        let model = ComposerModel(channel: channel, thread: nil, conversation: ConversationModel(reading: ReadingModel()), devices: DevicesModel(state: state)) { [self] _, _ in outcome }
        if label {
            model.edited("@")
            model.pick(mini)
        }
        return model
    }

    /// The composer in a window, laid out, and its field.
    private func show(_ model: ComposerModel) throws -> (window: NSWindow, field: NSTextView) {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 240), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = NSHostingView(rootView: ComposerView(model: model).frame(width: 360, height: 240))
        settle(window)
        return (window, try XCTUnwrap(Self.field(in: window.contentView!)))
    }

    private func settle(_ window: NSWindow) {
        for _ in 0..<3 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            window.contentView?.layoutSubtreeIfNeeded()
        }
    }

    private static func field(in view: NSView) -> NSTextView? {
        if let field = view as? NSTextView { return field }
        return view.subviews.lazy.compactMap { field(in: $0) }.first
    }

    private func indent(_ field: NSTextView, at index: Int) -> CGFloat {
        (field.textStorage!.attribute(.paragraphStyle, at: index, effectiveRange: nil) as! NSParagraphStyle).firstLineHeadIndent
    }

    func testTheFirstLineStartsAfterTheChipAndTheNextLinesUnderIt() throws {
        let model = model()
        let (window, field) = try show(model)
        field.insertText("one two three four five six seven eight nine ten eleven twelve thirteen", replacementRange: NSRange(location: NSNotFound, length: 0))
        settle(window)
        let layout = try XCTUnwrap(field.layoutManager)
        var range = NSRange()
        let first = layout.lineFragmentUsedRect(forGlyphAt: 0, effectiveRange: &range)
        let last = layout.lineFragmentUsedRect(forGlyphAt: layout.numberOfGlyphs - 1, effectiveRange: nil)
        XCTAssertGreaterThan(first.minX, 20, "the text starts after the chip")
        XCTAssertLessThan(range.length, layout.numberOfGlyphs, "the text wraps")
        XCTAssertEqual(last.minX, 0, accuracy: 0.5, "and its next lines start under the chip")
        XCTAssertEqual(model.text, field.string)
    }

    func testAnEmptyFieldKeepsTheChipsRoomForTheCaret() throws {
        let (window, field) = try show(model())
        field.insertText("a", replacementRange: NSRange(location: NSNotFound, length: 0))
        field.setSelectedRange(NSRange(location: 0, length: 1))
        field.deleteBackward(nil)
        settle(window)
        XCTAssertEqual(field.string, "")
        XCTAssertGreaterThan((field.typingAttributes[.paragraphStyle] as! NSParagraphStyle).firstLineHeadIndent, 20)
    }

    func testAChipFreeFieldHasNoIndent() throws {
        let (window, field) = try show(model(label: false))
        field.insertText("a", replacementRange: NSRange(location: NSNotFound, length: 0))
        settle(window)
        XCTAssertEqual(indent(field, at: 0), 0)
    }

    func testOnlyTheFirstParagraphIsIndented() throws {
        let (window, field) = try show(model())
        field.insertText("one", replacementRange: NSRange(location: NSNotFound, length: 0))
        field.insertNewlineIgnoringFieldEditor(nil)
        field.insertText("two", replacementRange: NSRange(location: NSNotFound, length: 0))
        settle(window)
        XCTAssertGreaterThan(indent(field, at: 0), 20)
        XCTAssertEqual(indent(field, at: 4), 0)
    }

    /// Gives the model `markdown` as a failed send does: the text comes back to an empty field, which then reads it as Markdown.
    private func restore(_ markdown: String, in model: ComposerModel) {
        model.edited(markdown)
        outcome = .notSaved
        model.submit()
        let end = Date().addingTimeInterval(5)
        while model.text != markdown, Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
        outcome = .queued(name: Data(repeating: 0xE1, count: 16))
    }

    func testATextAFailedSendGivesBackReadsAsRichTextAndTheFieldDoesNotTurnItBack() throws {
        let model = model(label: false)
        let (window, field) = try show(model)
        restore("a **b**", in: model)
        settle(window)
        XCTAssertEqual(field.string, "a b")
        XCTAssertNotNil(field.textStorage!.attribute(.composerStrong, at: 2, effectiveRange: nil))
        XCTAssertEqual(model.text, "a **b**", "the model keeps the Markdown it was given until the person edits")
    }

    func testATextThatDoesNotReadBackAsItWasIsGivenBackAsTyped() throws {
        for typed in ["fix __init__.py", "a\n\nb", "  x", " /cmd", "* item", "3. third", "x &amp; y", "a\\_b"] {
            let model = model(label: false)
            let (window, field) = try show(model)
            restore(typed, in: model)
            settle(window)
            XCTAssertEqual(field.string, typed)
            XCTAssertNil(field.textStorage!.attribute(.composerStrong, at: 0, effectiveRange: nil), typed)
            XCTAssertNil(field.textStorage!.attribute(.composerBlock, at: 0, effectiveRange: nil), typed)
            XCTAssertEqual(model.text, typed)
            field.insertText("!", replacementRange: NSRange(location: (typed as NSString).length, length: 0))
            XCTAssertEqual(model.text, typed + "!", "the first edit sends what is there")
        }
    }

    func testAnyOtherTextTheModelSetsIsGivenAsTypedAndNeverRead() throws {
        // The bot's suggestion goes through `edited`, as a typed text does.
        let model = model(label: false)
        let (window, field) = try show(model)
        model.edited("use **bold** or __init__.py")
        settle(window)
        XCTAssertEqual(field.string, "use **bold** or __init__.py")
        XCTAssertNil(field.textStorage!.attribute(.composerStrong, at: 5, effectiveRange: nil))
        XCTAssertEqual(model.text, "use **bold** or __init__.py")
    }

    func testTheTextAfterAMentionKeepsItsFormattingWhenItReadsBackAsItWas() throws {
        for (markdown, shown, strong) in [("**hello**", "hello", true), ("__init__.py", "__init__.py", false)] {
            let model = model(label: false, named: "mini")
            let (window, field) = try field(markdown, in: model)
            // The text typed at the start of a bold text is bold unless the tool is turned off there.
            field.setSelectedRange(NSRange(location: 0, length: 0))
            field.typingAttributes = ComposerMarkdown.base(firstLineIndent: 0)
            field.insertText("@mini ", replacementRange: NSRange(location: NSNotFound, length: 0))
            settle(window)
            XCTAssertNotNil(model.label, markdown)
            XCTAssertEqual(field.string, shown)
            XCTAssertEqual(field.textStorage!.attribute(.composerStrong, at: 0, effectiveRange: nil) != nil, strong, markdown)
            XCTAssertEqual(model.text, markdown)
        }
    }

    func testTypedTextReachesTheModelAsMarkdown() throws {
        let model = model(label: false)
        let (window, field) = try show(model)
        field.insertText("__init__.py", replacementRange: NSRange(location: NSNotFound, length: 0))
        settle(window)
        XCTAssertEqual(model.text, "__init__.py")
        field.textStorage!.addAttribute(.composerStrong, value: true, range: NSRange(location: 2, length: 4))
        field.didChangeText()
        XCTAssertEqual(model.text, "__**init**__.py")
    }

    // MARK: what comes in from outside

    /// A drop of `board` at the start of the field.
    @MainActor private final class Drop: NSObject, @preconcurrency NSDraggingInfo {
        let draggingPasteboard: NSPasteboard
        let window: NSWindow?
        let draggingLocation: NSPoint
        init(_ board: NSPasteboard, in window: NSWindow?, at location: NSPoint = NSPoint(x: 1, y: 235)) { (draggingPasteboard, self.window, draggingLocation) = (board, window, location) }
        var draggingDestinationWindow: NSWindow? { window }
        var draggingSourceOperationMask: NSDragOperation { .copy }
        var draggedImageLocation: NSPoint { draggingLocation }
        var draggedImage: NSImage? { nil }
        var draggingSource: Any? { nil }
        var draggingSequenceNumber: Int { 1 }
        var draggingFormation: NSDraggingFormation = .default
        var animatesToDestination = false
        var numberOfValidItemsForDrop = 1
        var springLoadingHighlight: NSSpringLoadingHighlight { .none }
        func slideDraggedImage(to screenPoint: NSPoint) {}
        func enumerateDraggingItems(options enumOpts: NSDraggingItemEnumerationOptions, for view: NSView?, classes classArray: [AnyClass],
                                    searchOptions: [NSPasteboard.ReadingOptionKey: Any], using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
        func resetSpringLoading() {}
    }

    func testARichTextDropGivesPlainText() throws {
        let (window, field) = try show(model(label: false))
        let rich = NSAttributedString(string: "dropped", attributes: [.underlineStyle: 1, .foregroundColor: NSColor.red, .font: NSFont.boldSystemFont(ofSize: 20),
                                                                      .link: URL(string: "https://example.com")!])
        let board = NSPasteboard(name: NSPasteboard.Name("pardner-test-drop-\(UUID().uuidString)"))
        board.clearContents()
        board.setData(try rich.data(from: NSRange(location: 0, length: rich.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf]), forType: .rtf)
        board.setString("dropped", forType: .string)
        let drop = Drop(board, in: window)
        XCTAssertTrue(field.performDragOperation(drop))
        settle(window)
        XCTAssertEqual(field.string, "dropped")
        let attributes = field.textStorage!.attributes(at: 0, effectiveRange: nil)
        XCTAssertNil(attributes[.underlineStyle])
        XCTAssertNil(attributes[.link], "a link is the person's to make, with the tool")
        XCTAssertEqual(attributes[.foregroundColor] as? NSColor, NSColor(PardnerColor.text))
        XCTAssertEqual((attributes[.font] as? NSFont)?.pointSize, 14)
    }

    private func board(_ text: String) -> NSPasteboard {
        let board = NSPasteboard(name: NSPasteboard.Name("pardner-test-drop-\(UUID().uuidString)"))
        board.clearContents()
        board.setString(text, forType: .string)
        return board
    }

    func testATextDroppedInABlockTakesTheBlock() throws {
        // At the start of a list item, and inside a code line: what is dropped is a part of the block, as what is pasted is.
        for (markdown, character, dropped, expected) in [("- item", 0, "Hello", "- Helloitem"), ("```\nabcd\n```", 2, "x\ny", "```\nabx\nycd\n```"),
                                                          ("> quoted", 3, "x", "> quoxted"), ("# Title", 0, "A", "# ATitle")] {
            let model = model(label: false)
            let (window, field) = try field(markdown, in: model)
            let rect = field.layoutManager!.boundingRect(forGlyphRange: NSRange(location: character, length: 1), in: field.textContainer!)
            let origin = field.textContainerOrigin
            let at = field.convert(NSPoint(x: rect.minX + origin.x + 1, y: rect.midY + origin.y), to: nil)
            XCTAssertTrue(field.performDragOperation(Drop(board(dropped), in: window, at: at)))
            settle(window)
            XCTAssertEqual(model.text, expected, markdown)
        }
    }

    func testATextDroppedAtTheEndTakesTheLastParagraphsBlockNotTheCaretsOne() throws {
        // The caret in a list item, the drop after the last plain paragraph: the drop point decides, not the caret.
        let model = model(label: false)
        let (window, field) = try field("- item\n\nplain", in: model)
        field.setSelectedRange(NSRange(location: 2, length: 0))
        XCTAssertNotNil(field.typingAttributes[.composerBlock], "the caret is in the list item")
        let last = (field.string as NSString).length - 1
        let rect = field.layoutManager!.boundingRect(forGlyphRange: NSRange(location: last, length: 1), in: field.textContainer!)
        let origin = field.textContainerOrigin
        let at = field.convert(NSPoint(x: rect.maxX + origin.x + 20, y: rect.midY + origin.y), to: nil)
        XCTAssertEqual(field.characterIndexForInsertion(at: field.convert(at, from: nil)), (field.string as NSString).length, "the drop is at the end")
        XCTAssertTrue(field.performDragOperation(Drop(board("x\ny"), in: window, at: at)))
        settle(window)
        XCTAssertEqual(model.text, "- item\n\nplainx\ny")
    }

    func testTheContextMenuOffersNoFontItems() throws {
        let (window, field) = try show(model(label: false))
        field.insertText("hello", replacementRange: NSRange(location: NSNotFound, length: 0))
        field.setSelectedRange(NSRange(location: 0, length: 3))
        let event = try XCTUnwrap(NSEvent.mouseEvent(with: .rightMouseDown, location: NSPoint(x: 10, y: 10), modifierFlags: [], timestamp: 0,
                                                     windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
        func actions(_ menu: NSMenu) -> [Selector] { menu.items.flatMap { [$0.action].compactMap { $0 } + ($0.submenu.map(actions) ?? []) } }
        let all = actions(try XCTUnwrap(field.menu(for: event)))
        XCTAssertTrue(all.contains(#selector(NSTextView.pasteAsPlainText(_:))), "the menu is the field's")
        for font in [#selector(NSFontManager.addFontTrait(_:)), #selector(NSText.underline(_:)), #selector(NSTextView.outline(_:))] {
            XCTAssertFalse(all.contains(font), "\(font)")
        }
    }

    /// How many pixels of the window's content are the chip's background (`agent-soft`, light).
    private func chipPixels(in window: NSWindow) throws -> Int {
        let view = try XCTUnwrap(window.contentView)
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        var count = 0
        for x in 0..<rep.pixelsWide { for y in 0..<rep.pixelsHigh {
            guard let pixel = rep.colorAt(x: x, y: y) else { continue }
            if abs(pixel.redComponent - 251 / 255) + abs(pixel.greenComponent - 239 / 255) + abs(pixel.blueComponent - 217 / 255) < 0.02 { count += 1 }
        } }
        return count
    }

    func testTheChipScrollsAwayWithTheFirstLineOfALongText() throws {
        let (window, field) = try show(model())
        window.appearance = NSAppearance(named: .aqua)
        field.insertText((1...14).map { "line \($0)" }.joined(separator: "\n"), replacementRange: NSRange(location: NSNotFound, length: 0))
        field.scrollToBeginningOfDocument(nil)
        settle(window)
        XCTAssertGreaterThan(try chipPixels(in: window), 100, "at the top the chip is drawn")
        field.scrollToEndOfDocument(nil)
        settle(window)
        XCTAssertEqual(try chipPixels(in: window), 0, "scrolled down it is gone, and does not cover the line that is there")
    }

    /// The bounds notification comes while the scroll view lays out, where SwiftUI state is not written.
    func testTheScrollOffsetIsWrittenAfterTheNotification() {
        var written: CGFloat = 0
        let field = ComposerField(model: model(label: false), height: .constant(0), scroll: Binding(get: { written }, set: { written = $0 }))
        let clip = NSClipView()
        clip.bounds.origin.y = 30
        ComposerField.Coordinator(field).clipMoved(Notification(name: NSView.boundsDidChangeNotification, object: clip))
        XCTAssertEqual(written, 0, "not in the notification")
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(written, 30)
    }

    // MARK: the tools

    /// A field that holds `markdown`, with `selecting` (a substring of its text) selected.
    private func field(_ markdown: String, selecting: String? = nil, in model: ComposerModel) throws -> (NSWindow, ComposerTextView) {
        let (window, field) = try show(model)
        restore(markdown, in: model)
        settle(window)
        window.makeFirstResponder(field)
        if let selecting { field.setSelectedRange((field.string as NSString).range(of: selecting)) }
        return (window, field as! ComposerTextView)
    }

    func testEachInlineToolMarksTheSelectionAndTakesItAwayAgain() throws {
        for (format, markdown) in [(ComposerFormat.strong, "one **two** three"), (.emphasis, "one *two* three"), (.strike, "one ~~two~~ three"), (.code, "one `two` three")] {
            let model = model(label: false)
            let (window, field) = try field("one two three", selecting: "two", in: model)
            model.format(format, nil)
            settle(window)
            XCTAssertEqual(model.text, markdown)
            XCTAssertTrue(model.active.contains(format))
            model.format(format, nil)
            settle(window)
            XCTAssertEqual(model.text, "one two three")
            XCTAssertFalse(field.activeFormats().contains(format))
        }
    }

    func testAToolOnTheCaretMarksWhatIsTypedNext() throws {
        let model = model(label: false)
        let (window, field) = try field("one", in: model)
        field.setSelectedRange(NSRange(location: 3, length: 0))
        model.format(.strong, nil)
        XCTAssertTrue(model.active.contains(.strong))
        field.insertText(" two", replacementRange: NSRange(location: NSNotFound, length: 0))
        settle(window)
        XCTAssertEqual(model.text, "one **two**")
        // The tool again ends the mark for what is typed after it.
        model.format(.strong, nil)
        field.insertText(" three", replacementRange: NSRange(location: NSNotFound, length: 0))
        settle(window)
        XCTAssertEqual(model.text, "one **two** three")
    }

    func testABlockToolSetsTheCaretsParagraphAndTakesItAwayAgain() throws {
        for (block, markdown) in [(ComposerMarkdown.Block.bullet, "- two"), (.number, "1. two"), (.quote, "> two"), (.code, "```\ntwo\n```"), (.h1, "# two"), (.h3, "### two")] {
            let model = model(label: false)
            let (window, field) = try field("one\ntwo\nthree", in: model)
            field.setSelectedRange(NSRange(location: 5, length: 0))
            model.format(.block(block), nil)
            settle(window)
            XCTAssertEqual(model.text, "one\n\n" + markdown + "\n\nthree")
            XCTAssertTrue(model.active.contains(.block(block)))
            model.format(.block(block), nil)
            settle(window)
            XCTAssertEqual(model.text, "one\ntwo\nthree")
        }
    }

    func testABlockToolTakesEveryParagraphTheSelectionTouches() throws {
        let model = model(label: false)
        let (window, field) = try field("one\ntwo\nthree", in: model)
        field.setSelectedRange(NSRange(location: 2, length: 5))
        model.format(.block(.number), nil)
        settle(window)
        XCTAssertEqual(model.text, "1. one\n2. two\n\nthree")
        model.format(.block(nil), nil)
        settle(window)
        XCTAssertEqual(model.text, "one\ntwo\nthree")
    }

    func testHeadingsSwapAndNormalClearsThem() throws {
        let model = model(label: false)
        let (window, field) = try field("title", in: model)
        model.format(.block(.h1), nil)
        model.format(.block(.h2), nil)
        settle(window)
        XCTAssertEqual(model.text, "## title")
        XCTAssertTrue(field.activeFormats().contains(.block(.h2)))
        model.format(.block(nil), nil)
        settle(window)
        XCTAssertEqual(model.text, "title")
    }

    func testABlockToolOnAnEmptyLastParagraphSetsTheNextTypedLine() throws {
        let model = model(label: false)
        let (window, field) = try field("a", in: model)
        field.setSelectedRange(NSRange(location: 1, length: 0))
        field.insertNewlineIgnoringFieldEditor(nil)
        model.format(.block(.bullet), nil)
        field.insertText("b", replacementRange: NSRange(location: NSNotFound, length: 0))
        settle(window)
        XCTAssertEqual(model.text, "a\n\n- b")
    }

    func testALinkIsSetOnTheSelectionTakenAwayAtTheCaretOrTypedAsItsOwnText() throws {
        let model = model(label: false)
        let (window, field) = try field("see the site now", selecting: "the site", in: model)
        let url = try XCTUnwrap(ComposerFormat.address("example.com/a"))
        XCTAssertEqual(url.absoluteString, "https://example.com/a")
        model.format(.link, url)
        settle(window)
        XCTAssertEqual(model.text, "see [the site](https://example.com/a) now")
        field.setSelectedRange(NSRange(location: 6, length: 0))
        XCTAssertTrue(field.activeFormats().contains(.link))
        model.format(.link, nil)
        settle(window)
        XCTAssertEqual(model.text, "see the site now")
        field.setSelectedRange(NSRange(location: 3, length: 0))
        model.format(.link, url)
        settle(window)
        XCTAssertEqual(model.text, "see[https://example.com/a](https://example.com/a) the site now")
    }

    func testOnlyAWebAddressMakesALink() {
        for typed in ["", "not a link", "ftp://example.com", "javascript:alert(1)", "https://"] { XCTAssertNil(ComposerFormat.address(typed), typed) }
        XCTAssertNotNil(ComposerFormat.address(" http://example.com/x "))
    }

    func testOneUndoTakesAToolBack() throws {
        let model = model(label: false)
        let (window, field) = try field("one two three", selecting: "two", in: model)
        model.format(.strong, nil)
        settle(window)
        XCTAssertEqual(model.text, "one **two** three")
        field.undoManager?.undo()
        settle(window)
        XCTAssertEqual(model.text, "one two three")
    }

    func testCommandBAndCommandIDoBoldAndItalic() throws {
        let model = model(label: false)
        let (window, field) = try field("one two three", selecting: "two", in: model)
        func press(_ key: String) -> Bool {
            let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0, windowNumber: window.windowNumber, context: nil,
                                         characters: key, charactersIgnoringModifiers: key, isARepeat: false, keyCode: 0)!
            return field.performKeyEquivalent(with: event)
        }
        XCTAssertTrue(press("b"))
        XCTAssertTrue(press("i"))
        settle(window)
        XCTAssertEqual(model.text, "one ***two*** three")
        XCTAssertFalse(press("u"), "no underline")
    }

    func testShiftReturnInAListAddsAnItemAndOnAnEmptyItemEndsTheList() throws {
        let model = model(label: false)
        let (window, field) = try field("- a", in: model)
        field.setSelectedRange(NSRange(location: 1, length: 0))
        XCTAssertFalse(field.insertLineInBlock(), "the field's own newline carries the item on")
        field.insertNewline(nil)
        field.insertText("b", replacementRange: NSRange(location: NSNotFound, length: 0))
        settle(window)
        XCTAssertEqual(model.text, "- a\n- b")
        field.insertNewline(nil)
        XCTAssertTrue(field.insertLineInBlock(), "an empty item ends the list")
        field.insertText("c", replacementRange: NSRange(location: NSNotFound, length: 0))
        settle(window)
        XCTAssertEqual(model.text, "- a\n- b\n\nc")
    }

    func testShiftReturnInACodeBlockAddsALineAndAfterAHeadingStartsAParagraph() throws {
        let model = model(label: false)
        let (window, field) = try field("```\none\n```", in: model)
        field.setSelectedRange(NSRange(location: 3, length: 0))
        XCTAssertFalse(field.insertLineInBlock())
        field.insertNewline(nil)
        field.insertText("two", replacementRange: NSRange(location: NSNotFound, length: 0))
        settle(window)
        XCTAssertEqual(model.text, "```\none\ntwo\n```")
        let (window2, heading) = try self.field("# title", in: self.model(label: false))
        heading.setSelectedRange(NSRange(location: 5, length: 0))
        XCTAssertTrue(heading.insertLineInBlock())
        heading.insertText("body", replacementRange: NSRange(location: NSNotFound, length: 0))
        settle(window2)
        XCTAssertEqual(ComposerMarkdown.markdown(from: heading.textStorage!), "# title\n\nbody")
    }

    func testRemoveLinkWorksAtTheCaretRightAfterALink() throws {
        let model = model(label: false)
        let (window, field) = try field("see [the site](https://example.com/a) now", in: model)
        field.setSelectedRange(NSRange(location: 12, length: 0))
        XCTAssertTrue(field.activeFormats().contains(.link), "the row says the caret is in the link")
        model.format(.link, nil)
        settle(window)
        XCTAssertEqual(model.text, "see the site now", "and the tool takes it away")
    }

    func testRemoveLinkTakesAWholeLinkOffMixedStyles() throws {
        // A link over bold and plain text, which the tool makes (reading Markdown gives a link no bold inside it).
        let model2 = model(label: false)
        let (window2, mixed) = try field("a **b** c", selecting: "a b c", in: model2)
        model2.format(.link, try XCTUnwrap(ComposerFormat.address("example.com/a")))
        settle(window2)
        XCTAssertEqual(model2.text, "[a **b** c](https://example.com/a)")
        mixed.setSelectedRange(NSRange(location: 3, length: 0))
        model2.format(.link, nil)
        settle(window2)
        XCTAssertEqual(model2.text, "a **b** c", "a link over bold and plain text goes whole")
    }

    func testABlockToolTurnedOnInAnEmptyFieldTurnsOffAgain() throws {
        let model = model(label: false)
        let (window, field) = try field("", in: model)
        model.format(.block(.bullet), nil)
        XCTAssertTrue(model.active.contains(.block(.bullet)))
        model.format(.block(.bullet), nil)
        XCTAssertTrue(model.active.contains(.block(nil)), "the second click takes it off")
        field.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
        settle(window)
        XCTAssertEqual(model.text, "x")
    }

    func testABlockToolOverAllOfAListAndItsEmptyLastLineTakesTheListOff() throws {
        let model = model(label: false)
        let (window, field) = try field("- a", in: model)
        field.setSelectedRange(NSRange(location: 1, length: 0))
        field.insertNewline(nil)
        field.selectAll(nil)
        model.format(.block(.bullet), nil)
        settle(window)
        XCTAssertNil(ComposerMarkdown.block(in: field.textStorage!, at: 0), "the first item is no item")
        XCTAssertFalse(model.text.contains("- "), model.text)
    }

    func testATextTypedAfterALinkIsNotPartOfIt() throws {
        let model = model(label: false)
        let (window, field) = try field("see the site", selecting: "the site", in: model)
        model.format(.link, try XCTUnwrap(ComposerFormat.address("example.com/a")))
        field.setSelectedRange(NSRange(location: 12, length: 0))
        field.insertText(" now", replacementRange: NSRange(location: NSNotFound, length: 0))
        settle(window)
        XCTAssertEqual(model.text, "see [the site](https://example.com/a) now")
        // A link typed as its own text, at a caret.
        let model2 = self.model(label: false)
        let (window2, field2) = try self.field("a ", in: model2)
        field2.setSelectedRange(NSRange(location: 2, length: 0))
        model2.format(.link, try XCTUnwrap(ComposerFormat.address("example.com")))
        field2.insertText(" more", replacementRange: NSRange(location: NSNotFound, length: 0))
        settle(window2)
        XCTAssertEqual(model2.text, "a [https://example.com](https://example.com) more")
    }

    func testAClickOnALinkInTheFieldDoesNotOpenIt() throws {
        let (_, field) = try show(model(label: false))
        // `NSTextView` opens the link itself, in the browser, unless its delegate says it handled the click.
        XCTAssertEqual(field.delegate?.textView?(field, clickedOnLink: URL(string: "https://example.com")!, at: 0), true)
    }

    func testShiftReturnAfterAHeadingWithTextBelowStartsAPlainParagraph() throws {
        let model = model(label: false)
        let (window, field) = try field("# title\n\nbody", in: model)
        field.setSelectedRange(NSRange(location: 5, length: 0))
        XCTAssertTrue(field.insertLineInBlock())
        settle(window)
        XCTAssertEqual(field.string, "title\n\nbody")
        XCTAssertEqual(ComposerMarkdown.block(in: field.textStorage!, at: 0), .h1)
        XCTAssertNil(ComposerMarkdown.block(in: field.textStorage!, at: 6), "the new line is a plain paragraph")
        XCTAssertFalse(model.text.contains("# \n"), model.text)
    }

    func testABlockToolTakesOnlyTheParagraphsASelectionReachesInto() throws {
        let model = model(label: false)
        let (window, field) = try field("a\nb", in: model)
        field.setSelectedRange(NSRange(location: 1, length: 2))
        model.format(.block(.bullet), nil)
        settle(window)
        XCTAssertEqual(model.text, "a\n\n- b", "the selection starts at the end of the first line")
    }

    /// Key events through the application, so that the field's delegate sees the event a key press makes current.
    private func press(_ characters: String, keyCode: UInt16, flags: NSEvent.ModifierFlags, in window: NSWindow) throws {
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                                   windowNumber: window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters.lowercased(),
                                                   isARepeat: false, keyCode: keyCode))
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(window.firstResponder)
        NSApp.postEvent(event, atStart: true)
        let next = try XCTUnwrap(NSApp.nextEvent(matching: .any, until: Date().addingTimeInterval(1), inMode: .default, dequeue: true))
        NSApp.sendEvent(next)
    }

    func testTheRowFollowsShiftReturnThatEndsAList() throws {
        let model = model(label: false)
        let (window, field) = try field("- a", in: model)
        field.setSelectedRange(NSRange(location: 1, length: 0))
        try press("\r", keyCode: 36, flags: .shift, in: window)
        XCTAssertEqual(field.string, "a\n", "the first Shift-Return adds an item")
        XCTAssertTrue(model.active.contains(.block(.bullet)))
        try press("\r", keyCode: 36, flags: .shift, in: window)
        settle(window)
        XCTAssertTrue(model.active.contains(.block(nil)), "the second ends the list, and the row says so")
        XCTAssertFalse(model.active.contains(.block(.bullet)))
    }

    func testCommandBAndCommandIWorkWithCapsLockOn() throws {
        let model = model(label: false)
        let (window, field) = try field("one two three", selecting: "two", in: model)
        for (key, flags) in [("B", NSEvent.ModifierFlags([.command, .capsLock])), ("I", [.command, .capsLock, .numericPad])] {
            let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: window.windowNumber, context: nil,
                                                       characters: key, charactersIgnoringModifiers: key, isARepeat: false, keyCode: 0))
            XCTAssertTrue(field.performKeyEquivalent(with: event), key)
        }
        settle(window)
        XCTAssertEqual(model.text, "one ***two*** three")
    }

    func testAListItemsMarkerAndAQuotesBarAreDrawnInTheRoomTheTextLeaves() throws {
        func gutter(_ markdown: String) throws -> Bool {
            let (_, field) = try self.field(markdown, in: model(label: false))
            let rep = try XCTUnwrap(field.bitmapImageRepForCachingDisplay(in: NSRect(x: 0, y: 0, width: 16, height: 20)))
            field.cacheDisplay(in: NSRect(x: 0, y: 0, width: 16, height: 20), to: rep)
            return (0..<16).contains { x in (0..<20).contains { y in (rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.1 } }
        }
        XCTAssertTrue(try gutter("- a"))
        XCTAssertTrue(try gutter("1. a"))
        XCTAssertTrue(try gutter("> a"))
    }
}
