// The rows' use of the message's text view (#194, unit 3c): which rows draw one, and the right-click menu: `Copy` of the selection and `Copy as Markdown` of the
// whole source with a selection, `Copy as Markdown` alone with none, nothing where the row has no copy, and a link in a hosted table's cell with `Copy as Markdown`.
import AppKit
import Conversation
import DesignSystem
import Foundation
@testable import Relay
@testable import Screens
import SwiftUI
import XCTest

@MainActor
final class MessageMenuTests: XCTestCase {
    private func textViews(in view: NSView) -> [MessageTextView] {
        (view as? MessageTextView).map { [$0] } ?? view.subviews.flatMap(textViews)
    }

    private func host<V: View>(_ root: V, width: CGFloat = 400) -> (NSHostingView<V>, NSWindow) {
        _ = NSApplication.shared
        PardnerFonts.register()
        let host = NSHostingView(rootView: root)
        host.frame = NSRect(x: 0, y: 0, width: width, height: 800)
        let window = NSWindow(contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        return (host, window)
    }

    /// The menu a right click at `point` (in `view`'s coordinates) gives.
    private func menu(of view: NSView, at point: NSPoint) throws -> NSMenu? {
        let event = try XCTUnwrap(NSEvent.mouseEvent(
            with: .rightMouseDown, location: view.convert(point, to: nil), modifierFlags: [], timestamp: 0, windowNumber: view.window?.windowNumber ?? 0,
            context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
        return view.menu(for: event)
    }

    // MARK: which rows draw the one text view

    func testAMarkdownViewDrawsOneTextViewWhenAskedAndItsBlocksWhenNot() {
        let text = "First.\n\n- one\n- two\n\nLast."
        let (whole, w1) = host(MarkdownView(text: text, wholeSelection: true).designLines())
        defer { withExtendedLifetime(w1) {} }
        XCTAssertEqual(textViews(in: whole).count, 1)
        let (blocks, w2) = host(MarkdownView(text: text).designLines())
        defer { withExtendedLifetime(w2) {} }
        XCTAssertEqual(textViews(in: blocks).count, 0)
    }

    /// The person's devices as the composer needs them: this Mac, and the bot.
    private func devices(_ s: ScrollFixture) -> DevicesModel {
        func row(_ id: Data, _ kind: DeviceKind, _ position: Int) -> DeviceRow {
            DeviceRow(id: id, kind: kind, label: nil, shortForm: "", adder: .none, position: position, active: true, isThisMac: kind == .app, seenAt: nil, onlyHolderEpochs: 0, addedWhileRemoving: false)
        }
        var state = DevicesState()
        state.rows = [row(s.alice, .app, 1), row(s.bot, .bot, 2)]
        return DevicesModel(state: state)
    }

    /// K2: each row that sets `wholeSelection` draws the message's text view, and a system event none.
    func testTheRowsOfAMessageAnAnswerAndAPendingMessageDrawTheTextViewAndASystemEventNone() async throws {
        var s = ScrollFixture()
        let prompt = s.put(2, s.alice, ["text": "Hello **bot**, a list:\n\n- one\n- two"], to: s.bot)
        s.put(3, s.bot, [:], re: prompt)
        s.put(1, s.bot, ["markdown": "The bot says:\n\n- one\n- two"])
        s.put(5, s.bot, ["thread": prompt.hex, "markdown": "The answer:\n\n1. first\n2. second"], re: prompt)
        let messages = try XCTUnwrap(s.model.channels[s.channel]?.messages)
        let person = try XCTUnwrap(messages.first { $0.sender == s.alice }), bot = try XCTUnwrap(messages.first { $0.sender == s.bot && MarkdownView.reads($0.body) })
        let thread = try XCTUnwrap(s.model.channels[s.channel]?.threads[prompt.hex])
        let answer = try XCTUnwrap(ThreadRows.build(thread, isSystem: { _ in false }, isOpen: { _ in true }).lazy.compactMap { row -> AnswerGroup? in
            if case .segment(let answer) = row.content { answer } else { nil }
        }.first)
        let composer = ComposerModel(channel: s.channel, thread: nil, conversation: ConversationModel(reading: s.model), devices: devices(s)) { _, _ in .queued(name: Data(repeating: 0xD1, count: 16)) }
        composer.edited("A pending message\n\n- one\n- two")
        await composer.submit()?.value
        XCTAssertEqual(composer.rows().count, 1)

        func count<V: View>(_ row: V) -> Int {
            let (view, window) = host(row)
            defer { withExtendedLifetime(window) {} }
            return textViews(in: view).count
        }
        XCTAssertEqual(count(MessageRow(model: s.model, icons: [:], message: bot).environment(\.botDevices, [s.bot])), 1, "the bot's message")
        XCTAssertEqual(count(MessageRow(model: s.model, icons: [:], message: person)), 1, "the person's message")
        XCTAssertEqual(count(AnswerRow(model: s.model, icons: [:], answer: answer, whole: thread.text(of: answer))), 1, "the thread's answer row")
        XCTAssertEqual(count(Answered(model: s.model, icons: [:], thread: thread, prompt: person)), 1, "the answer's segment under its prompt")
        XCTAssertEqual(count(VStack { PendingRows(model: composer) }), 1, "the owner's pending message")
        XCTAssertEqual(count(SystemEvent(text: "Stopped.\n\nA second paragraph and `code`.", indent: 0)), 0, "a system event")
    }

    func testASystemEventKeepsItsBlocks() {
        let (event, window) = host(SystemEvent(text: "Stopped.\n\nA second paragraph and `code`.", indent: 0))
        defer { withExtendedLifetime(window) {} }
        XCTAssertEqual(textViews(in: event).count, 0, "a system event is drawn block by block, as before")
    }

    func testATextTheBoundsRefuseIsTheSameViewWhenAskedFor() {
        let (view, window) = host(MarkdownView(text: String(repeating: "word ", count: 3_300), wholeSelection: true).designLines())
        defer { withExtendedLifetime(window) {} }
        XCTAssertEqual(textViews(in: view).count, 1)
    }

    // MARK: the menu

    private func message(copy: (() -> Void)?) throws -> (MessageTextView, NSWindow) {
        let (host, window) = host(MessageText(text: "First paragraph here.\n\nSecond paragraph.", open: { _ in }, copy: copy).designLines().frame(width: 400))
        return (try XCTUnwrap(textViews(in: host).first), window)
    }

    func testWithASelectionTheMenuOffersCopyAndCopyAsMarkdown() throws {
        var copied = 0
        let (view, window) = try message { copied += 1 }
        defer { withExtendedLifetime(window) {} }
        view.setSelectedRange(NSRange(location: 2, length: 8))
        let items = try XCTUnwrap(menu(of: view, at: NSPoint(x: 10, y: 10))).items
        XCTAssertEqual(items.map(\.title), ["Copy", "Copy as Markdown"])
        XCTAssertEqual(items[0].action, #selector(NSText.copy(_:)), "the selection, as Cmd-C copies it")
        XCTAssertTrue(items[0].target === view)
        XCTAssertTrue(NSApp.sendAction(try XCTUnwrap(items[1].action), to: items[1].target, from: items[1]))
        XCTAssertEqual(copied, 1, "the whole message's source, as the row's Copy copies it")
    }

    /// A right click that lands on a word selects it first (AppKit, measured on macOS 27.2.1 with a synthetic event), so the menu is built with that selection: a
    /// click on the empty room right of a shorter line is the case where nothing is selected.
    func testWithNoSelectionTheMenuOffersCopyAsMarkdownAlone() throws {
        var copied = 0
        let (view, window) = try message { copied += 1 }
        defer { withExtendedLifetime(window) {} }
        let empty = NSPoint(x: view.frame.width - 3, y: view.frame.height - 14)
        view.setSelectedRange(NSRange(location: 0, length: 0))
        let items = try XCTUnwrap(menu(of: view, at: empty)).items
        XCTAssertEqual(view.selectedRange().length, 0, "the click selected nothing")
        XCTAssertEqual(items.map(\.title), ["Copy as Markdown"])
        XCTAssertTrue(NSApp.sendAction(try XCTUnwrap(items[0].action), to: items[0].target, from: items[0]))
        XCTAssertEqual(copied, 1)
    }

    func testARightClickOnAWordSelectsItAndTheMenuOffersCopyOfIt() throws {
        let (view, window) = try message {}
        defer { withExtendedLifetime(window) {} }
        view.setSelectedRange(NSRange(location: 0, length: 0))
        let items = try XCTUnwrap(menu(of: view, at: NSPoint(x: 5, y: 10))).items
        XCTAssertEqual(view.selectedRange(), NSRange(location: 0, length: 5), "AppKit selects the word under a context click")
        XCTAssertEqual(items.map(\.title), ["Copy", "Copy as Markdown"])
    }

    func testARowWithNoCopyHasAnEmptyMenuAsBefore() throws {
        let (view, window) = try message(copy: nil)
        defer { withExtendedLifetime(window) {} }
        view.setSelectedRange(NSRange(location: 2, length: 8))
        XCTAssertEqual(try XCTUnwrap(menu(of: view, at: NSPoint(x: 10, y: 10))).items.count, 0)
    }

    func testTheMenuHasNoCopyLink() throws {
        let (host, window) = host(MessageText(text: "See [the notes](https://example.com/n) now.", open: { _ in }, copy: {}).designLines().frame(width: 400))
        defer { withExtendedLifetime(window) {} }
        let view = try XCTUnwrap(textViews(in: host).first)
        let at = (view.string as NSString).range(of: "notes")
        let rect = view.firstRect(forCharacterRange: at, actualRange: nil)
        let point = view.convert(view.window!.convertFromScreen(rect).origin, from: nil)
        let titles = try XCTUnwrap(menu(of: view, at: NSPoint(x: point.x + 2, y: point.y + 2))).items.map(\.title)
        XCTAssertFalse(titles.contains("Copy Link"), "a link's address is a placeholder")
        XCTAssertEqual(titles, ["Copy", "Copy as Markdown"], "the row's two items and no other of the text view's own")
    }

    func testALinkInAHostedTablesCellHasTheRowsCopy() throws {
        var copied = 0
        let table = "| Name | Link |\n|---|---|\n| a | [notes](https://example.com/n) |"
        let (host, window) = host(MessageText(text: table, open: { _ in }, copy: { copied += 1 }).designLines().frame(width: 400))
        defer { withExtendedLifetime(window) {} }
        func cellText(_ view: NSView) -> NSTextView? {
            (view as? NSTextView).flatMap { $0 is MessageTextView ? nil : $0 } ?? view.subviews.lazy.compactMap(cellText).first
        }
        let link = try XCTUnwrap(cellText(host), "the cell with a link is its own text view")
        let items = try XCTUnwrap(menu(of: link, at: NSPoint(x: 3, y: 3))).items
        XCTAssertEqual(items.map(\.title), ["Copy as Markdown"], "the text view's own Copy is the selection's, so this one is named for what it copies")
        XCTAssertTrue(NSApp.sendAction(try XCTUnwrap(items[0].action), to: items[0].target, from: items[0]))
        XCTAssertEqual(copied, 1)
    }

    // MARK: the row's own menu item

    func testARowsMenuItemIsCopyAsMarkdownWhereTheTextViewDrawsTheBodyAndCopyWhereItDoesNot() {
        let text = Body.text(markdown: "hello", say: nil)
        XCTAssertEqual(MessageRow.copyTitle(of: text, isBot: true), "Copy as Markdown", "a bot's text")
        XCTAssertEqual(MessageRow.copyTitle(of: text, isBot: false), "Copy as Markdown", "a person's text")
        XCTAssertEqual(MessageRow.copyTitle(of: .prompt(text: "go"), isBot: false), "Copy as Markdown", "a person's prompt")
        XCTAssertEqual(MessageRow.copyTitle(of: .answer(markdown: "done"), isBot: true), "Copy", "a bot's body that is no text keeps its code spans only")
        XCTAssertEqual(MessageRow.copyTitle(of: .file(title: "a.txt"), isBot: true), "Copy", "a file row")
        XCTAssertEqual(MessageRow.copyTitle(of: .unreadable, isBot: false), "Copy", "an unreadable row")
    }
}
