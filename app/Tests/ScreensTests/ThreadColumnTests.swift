// The rules of the thread's one content column (visual pass, issue #174, unit B): a path relative to the channel's folder, the grouping of
// consecutive messages of one author, the markup stripped from a preview, the session's data row. Synthetic content.
import Conversation
import DesignSystem
import Foundation
import ProtocolHost
@testable import Screens
import SwiftUI
import XCTest

private let bot = Data(repeating: 3, count: 32)
private let alice = Data(repeating: 2, count: 32)
private let bob = Data(repeating: 7, count: 32)

/// A session of the bot opened by a prompt of alice's; each message is one second after the one before unless it names its time.
private struct Session {
    var model = ReadingModel()
    var position = 1
    let channel = Data(repeating: 1, count: 32)
    var prompt: MessageRef!

    init() {
        prompt = put(2, alice, ["text": "go"], to: bot)
        put(3, bot, [:], re: prompt)
    }

    @discardableResult
    mutating func put(_ kind: Int, _ sender: Data, _ body: [String: Any]?, to: Data? = nil, re: MessageRef? = nil, time: Double? = nil) -> MessageRef {
        let at = position
        position += 1
        let name = Data(repeating: UInt8(at), count: 16)
        model.take(view: .object([
            "do": .string("message"), "position": .number(Double(at)), "channel": .bytes(channel), "sender": .bytes(sender),
            "name": .bytes(name), "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(time ?? 1_700_000_000_000 + Double(at) * 1000),
            "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null, "blobs": .array([]), "files": .array([]),
            "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null,
            "text": body.map { .string(String(decoding: try! JSONSerialization.data(withJSONObject: $0), as: UTF8.self)) } ?? .null, "again": .bool(false),
        ]))
        return MessageRef(device: sender, name: name)
    }

    /// A message of the thread this device cannot open (a text of `.null`): it names its thread by `re` alone, as a line does.
    mutating func unreadable(from sender: Data = alice) { put(1, sender, nil, re: prompt) }

    /// A scheduled run's line, as the bot writes it (`provider.ts`, `#aside(... say: "run", at ...)`).
    mutating func run(at: Double = 1_763_999_940_000) { put(1, bot, ["thread": prompt.hex, "say": "run", "at": at, "markdown": "Running scheduled task"]) }

    mutating func typed(_ text: String, from sender: Data = alice, time: Double? = nil) { put(2, sender, ["text": text, "thread": prompt.hex], to: bot, time: time) }
    mutating func say(_ say: String, _ markdown: String) { put(1, bot, ["thread": prompt.hex, "say": say, "markdown": markdown]) }
    /// A text of the bot with no `say`: what a bot's ordinary words are.
    mutating func botText(_ markdown: String) { put(1, bot, ["thread": prompt.hex, "markdown": markdown]) }
    mutating func answer(_ markdown: String = "Done.") { put(5, bot, ["thread": prompt.hex, "markdown": markdown], re: prompt) }

    mutating func line(_ title: String) {
        put(1, bot, ["thread": prompt.hex, "say": "task", "task": ["title": title, "status": "complete", "details": NSNull(), "output": NSNull(), "task": false,
                                                                    "message": false, "calls": 0, "preview": NSNull(), "startedAt": NSNull()] as [String: Any]], re: prompt)
    }

    /// The bot has a profile, so its notices are system events.
    mutating func publishProfile() { model.take(profile: .object(["do": .string("profile"), "bot": .bytes(bot), "profile": .object(["name": .string("alpha")])])) }

    /// A text of the bot that is no reply to the prompt: an idle turn's answer, one per `name`.
    mutating func idleAnswer(_ name: UInt8, _ markdown: String = "Hello.") {
        put(4, bot, ["thread": prompt.hex, "markdown": markdown], re: MessageRef(device: bot, name: Data(repeating: name, count: 16)))
    }

    var rows: [ThreadRow] { ThreadRows.build(model.channels[channel]!.threads[prompt.hex]!, isSystem: { model.isSystemEvent($0) }) }
}

final class ThreadColumnTests: XCTestCase {
    // MARK: a path relative to the channel's folder

    func testAPathInsideTheFolderIsWrittenFromIt() {
        XCTAssertEqual(ToolPath.relative("/srv/example/project/src/a.swift", to: "/srv/example/project"), "src/a.swift")
        XCTAssertEqual(ToolPath.relative("/srv/example/project/src/a.swift", to: "/srv/example/project/"), "src/a.swift", "a folder written with its last slash")
    }

    func testTheFolderItselfIsADot() {
        XCTAssertEqual(ToolPath.relative("/srv/example/project", to: "/srv/example/project"), ".")
        XCTAssertEqual(ToolPath.relative("/srv/example/project/", to: "/srv/example/project"), ".")
    }

    func testAPathOutsideTheFolderStaysAbsolute() {
        XCTAssertEqual(ToolPath.relative("/srv/example/other/a.swift", to: "/srv/example/project"), "/srv/example/other/a.swift")
    }

    func testASiblingThatSharesAPrefixIsOutside() {
        XCTAssertEqual(ToolPath.relative("/a/bc/file", to: "/a/b"), "/a/bc/file")
        XCTAssertEqual(ToolPath.relative("/a/bc", to: "/a/b"), "/a/bc")
    }

    func testWithNoBindAPathStaysAbsolute() {
        XCTAssertEqual(ToolPath.relative("/srv/example/project/a.swift", to: nil), "/srv/example/project/a.swift")
        XCTAssertEqual(ToolPath.relative("/srv/example/project/a.swift", to: ""), "/srv/example/project/a.swift")
    }

    func testTheRootOfTheDiskIsNoBind() {
        XCTAssertEqual(ToolPath.relative("/srv/example/a.swift", to: "/"), "/srv/example/a.swift")
        XCTAssertEqual(ToolPath.relative("/srv/example/a.swift", to: "//"), "/srv/example/a.swift")
    }

    func testALongPathTheCoreCutAtEightyCharactersIsStillWrittenFromTheFolder() {
        let folder = "/srv/example/project"
        let path = folder + "/" + (1...8).map { "directory-number-\($0)" }.joined(separator: "/") + "/file.swift"
        XCTAssertGreaterThan(path.count, 80)
        let relative = String(path.dropFirst(folder.count + 1))
        let cut = "Read: " + path.prefix(79) + "…"
        XCTAssertEqual(ToolTitle.parts(cut, path: path, folder: folder).subject, relative, "the cut title names the path by its beginning")
        XCTAssertEqual(ToolTitle.parts("Read: " + path, path: path, folder: folder).subject, relative)
        XCTAssertEqual(ToolTitle.parts("Read: /srv/example/other/file.swift…", path: path, folder: folder).subject, "/srv/example/other/file.swift…", "a title that is no beginning of the path")
    }

    func testATitleSplitsIntoItsVerbAndItsSubject() {
        let path = "/srv/example/project/src/a.swift"
        XCTAssertEqual(ToolTitle.parts("Read: \(path)", path: path, folder: "/srv/example/project").subject, "src/a.swift")
        XCTAssertEqual(ToolTitle.parts("Read: \(path)", path: path, folder: "/srv/example/project").verb, "Read")
        XCTAssertEqual(ToolTitle.parts("Read: \(path)", path: path, folder: nil).subject, path, "no bind known")
        XCTAssertEqual(ToolTitle.parts("Bash: ls -la", path: nil, folder: "/srv/example/project").subject, "ls -la", "a command is no path")
        XCTAssertEqual(ToolTitle.parts("Bash: /srv/example/project/run.sh", path: nil, folder: "/srv/example/project").subject, "/srv/example/project/run.sh",
                       "only a call's own path is cut: a command that starts like one is not")
        let none = ToolTitle.parts("Update(a.txt)", path: nil, folder: nil)
        XCTAssertEqual(none.verb, "Update(a.txt)")
        XCTAssertNil(none.subject)
        XCTAssertEqual(ToolTitle.parts("Run: a: b", path: nil, folder: nil).subject, "a: b", "the first colon splits")
    }

    // MARK: a notice

    @MainActor
    private func width(_ view: some View) -> CGFloat {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let hosting = NSHostingView(rootView: view.fixedSize())
        hosting.layoutSubtreeIfNeeded()
        return hosting.fittingSize.width
    }

    @MainActor
    func testANoticeDrawsItsCodeSpansAndNotTheirBackticks() {
        let words = "Bound this channel to `/srv/example/project`."
        let styled = width(Text(CodeSpans.styled(words)).font(PardnerFont.ui(size: 13, weight: .regular)))
        // The icon's 14 points and the 8 between it and the words, and the room the span takes at its two sides (#27): the character before it and its own last.
        XCTAssertEqual(width(SystemEvent(text: words, indent: 0)), styled + 14 + 8 + 2 * InlineCodeText.inset, accuracy: 1)
        XCTAssertNotEqual(width(SystemEvent(text: words, indent: 0)), width(Text(verbatim: words).font(PardnerFont.ui(size: 13, weight: .regular))) + 14 + 8, accuracy: 1)
    }

    @MainActor
    private func height(_ view: some View) -> CGFloat {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let hosting = NSHostingView(rootView: view.frame(width: 500))
        hosting.layoutSubtreeIfNeeded()
        return hosting.fittingSize.height
    }

    private let notice = "Prompt:\n> run the tests\n\nSee [the notes](https://example.com/notes)."

    @MainActor
    func testAPanelNoticeIsReadAsMarkdownInItsCompactRow() {
        let linked = width(SystemEvent(text: "See [the notes](https://example.com/notes).", indent: 0))
        XCTAssertEqual(linked, width(SystemEvent(text: "See the notes.", indent: 0)), accuracy: 1, "the link's address is not drawn")
        XCTAssertGreaterThan(height(SystemEvent(text: notice, indent: 0)), height(SystemEvent(text: "Prompt:", indent: 0)) * 2, "a quote and a paragraph stand on lines of their own")
    }

    @MainActor
    func testAChannelNoticeIsDrawnAsABotsTextAndThePanelsAsASystemEvent() {
        var s = Session()
        s.publishProfile()
        s.say("notice", notice)
        s.botText(notice)
        let messages = s.model.channels[s.channel]!.threads[s.prompt.hex]!.items.compactMap { item -> Message? in if case .message(let m) = item, m.sender == bot { m } else { nil } }
        let (said, plain) = (messages[messages.count - 2], messages[messages.count - 1])
        XCTAssertTrue(said.isNotice)
        XCTAssertTrue(s.model.isSystemEvent(said), "the rule is the panel's")
        func row(_ m: Message, compact: Bool = false) -> some View {
            MessageRow(model: s.model, icons: [:], message: m, mark: .conversation, compactNotices: compact)
        }
        XCTAssertEqual(height(row(said)), height(row(plain)), accuracy: 1, "in the conversation a notice has its avatar, its name and its Markdown, as before the visual pass")
        XCTAssertLessThan(height(row(said, compact: true)), height(row(said)), "the panel draws the compact row")
    }

    // MARK: the markup of a preview

    func testAPreviewShowsItsWordsWithoutTheirMarkup() {
        XCTAssertEqual(Markup.plain("**Counts**"), "Counts")
        XCTAssertEqual(Markup.plain("a *quiet* word"), "a quiet word")
        XCTAssertEqual(Markup.plain("run `ls -la` here"), "run ls -la here")
        XCTAssertEqual(Markup.plain("see [the guide](https://example.com/guide) now"), "see the guide now")
        XCTAssertEqual(Markup.plain("**Counts** and `x` and [t](u)"), "Counts and x and t")
    }

    func testPlainWordsAndUnclosedMarkupComeBackAsWritten() {
        XCTAssertEqual(Markup.plain("six tests pass"), "six tests pass")
        XCTAssertEqual(Markup.plain("a **b"), "a **b")
        XCTAssertEqual(Markup.plain("snake_case_name and 2 * 3"), "snake_case_name and 2 * 3")
        XCTAssertEqual(Markup.plain("  two  spaces"), "  two  spaces", "whitespace is kept")
    }

    // MARK: grouping

    private let day = Date(timeIntervalSince1970: 1_700_000_000)

    func testAMessageJoinsTheOneAboveOfTheSameAuthorAndDay() {
        let above = Grouping.Head(author: alice, time: day)
        XCTAssertTrue(Grouping.joins(above, Grouping.Head(author: alice, time: day.addingTimeInterval(60))))
        XCTAssertFalse(Grouping.joins(above, Grouping.Head(author: bob, time: day.addingTimeInterval(60))), "another author")
        XCTAssertFalse(Grouping.joins(above, Grouping.Head(author: alice, time: day.addingTimeInterval(2 * 86_400))), "another day")
        XCTAssertFalse(Grouping.joins(nil, Grouping.Head(author: alice, time: day)), "something else is drawn above, or nothing")
    }

    func testTheConversationJoinsWhatNothingSeparates() {
        var s = Session()
        s.typed("one")
        s.typed("two")
        s.typed("three", from: bob)
        let messages = s.model.channels[s.channel]!.threads[s.prompt.hex]!.items.compactMap { item -> Message? in if case .message(let m) = item { m } else { nil } }
        XCTAssertEqual(messages.count, 3)
        let joined = ChannelView.joined(messages, drawsBelow: { _ in false }, isTinted: { _ in false })
        XCTAssertEqual(joined, [messages[1].position], "the second joins the first; the third is another author's")
        XCTAssertEqual(ChannelView.joined(messages, drawsBelow: { $0.position == messages[0].position }, isTinted: { _ in false }), [], "a summary under the first stands between")
    }

    func testRowsOfOneAuthorJoinAndAnythingDrawnBetweenBreaksThem() {
        var s = Session()
        s.typed("one")
        s.typed("two")
        s.line("Read: a.txt")
        s.typed("three")
        let joins = s.rows.map(\.joins)
        XCTAssertEqual(joins, [false, true, false, false], "a call line stands between two and three")
    }

    /// A call that opens the bot's reply carries the bot's head, and the text after it joins that head; a later call of the same reply carries
    /// none (#136).
    func testACallThatOpensTheBotsReplyCarriesTheBotsHead() {
        var s = Session()
        s.typed("read the file")
        s.line("Read: a.txt")
        s.botText("Its first line is a title.")
        s.line("Read: b.txt")
        let rows = s.rows
        XCTAssertEqual(rows.map(\.showsHead), [true, true, false, false], "the prompt's head, the call's, the text joins it, the second call has none")
        XCTAssertEqual(rows[1].head?.author, bot)
        XCTAssertEqual(rows.map(\.joins), [false, false, true, false])
    }

    /// A bot's reply has one head: its texts after a call or a system event stand under it, until a person writes (#166).
    func testABotsReplyHasOneHeadThroughItsCallsAndSystemEvents() {
        var s = Session()
        s.publishProfile()
        s.typed("run the tests")
        s.botText("Running them.")
        s.line("Bash: npm test")
        s.botText("They pass.")
        s.say("notice", "Stopped.")
        s.botText("Anything else?")
        s.typed("no")
        let rows = s.rows
        XCTAssertEqual(rows.map(\.showsHead), [true, true, false, false, false, false, true], "the prompt, the reply's one head, then the next prompt")
        XCTAssertEqual(rows.map(\.joins), [false, false, false, true, false, true, false])
    }

    /// Messages this device cannot open are drawn between the bot's two texts: the second text is not the first one's continuation across them.
    func testABotTextAfterUnreadableMessagesOpensItsOwnHead() {
        var s = Session()
        s.botText("First.")
        s.unreadable()
        s.unreadable()
        s.botText("Second.")
        let rows = s.rows
        guard case .unreadable(2, _) = rows[1].content else { return XCTFail("a counted group of two between the texts") }
        XCTAssertEqual(rows.map(\.joins), [false, false, false], "the group is drawn between them")
        XCTAssertTrue(rows[2].showsHead)
    }

    /// A scheduled run opens a turn: its call opens its own head and its length is the run's, not the earlier reply's (a stopped turn writes
    /// no footer).
    func testAScheduledRunOpensATurnOfItsOwn() {
        var s = Session()
        s.botText("Done earlier.")
        s.run()
        s.line("Read: a.txt")
        s.botText("Read it.")
        s.say("footer", "5s")
        let rows = s.rows
        XCTAssertEqual(rows.map(\.showsHead), [true, false, true, false], "the earlier text, the run line, the run's call, its text under it")
        XCTAssertEqual(rows.map(\.duration), [nil, nil, "5s", nil], "the run's length is on the run's head")
    }

    func testATintedBlockJoinsNothingAndNothingJoinsIt() {
        var s = Session()
        s.typed("one")
        s.typed("two")
        s.typed("three")
        let messages = s.model.channels[s.channel]!.threads[s.prompt.hex]!.items.compactMap { item -> Message? in if case .message(let m) = item { m } else { nil } }
        let second = messages[1].position
        XCTAssertEqual(ChannelView.joined(messages, drawsBelow: { _ in false }, isTinted: { $0.position == second }), [], "the band reaches 8 points past its block")
        XCTAssertEqual(ChannelView.joined(messages, drawsBelow: { _ in false }, isTinted: { _ in false }), [messages[1].position, messages[2].position])
    }

    func testOneSystemEventPredicateServesGroupingAndDrawing() {
        var s = Session()
        s.typed("one")
        s.say("notice", "Stopped.")
        let notice = s.model.channels[s.channel]!.threads[s.prompt.hex]!.items.compactMap { item -> Message? in if case .message(let m) = item, m.isNotice { m } else { nil } }[0]
        XCTAssertFalse(s.model.isSystemEvent(notice), "no profile: the notice is drawn as a message")
        XCTAssertNotNil(s.rows[1].head, "and it is grouped as one")
        s.publishProfile()
        XCTAssertTrue(s.model.isSystemEvent(notice))
        XCTAssertNil(s.rows[1].head)
    }

    func testASingleUnreadableMessageIsAHeadWithTheMessageGap() {
        var s = Session()
        s.typed("one")
        s.put(1, bot, ["thread": s.prompt.hex])
        let rows = s.rows
        guard case .unreadable(let count, _) = rows[1].content else { return XCTFail("an unreadable row") }
        XCTAssertEqual(count, 1)
        XCTAssertNotNil(rows[1].head)
        XCTAssertEqual(rows[1].gapAbove, PardnerMetrics.messageGap)
    }

    @MainActor
    func testASingleUnreadableRowKeepsItsJoinAndItsLength() {
        var s = Session()
        s.put(1, bot, ["thread": s.prompt.hex])
        guard case .unreadable(1, let first) = s.rows[0].content else { return XCTFail("one unreadable row") }
        func unreadable(joins: Bool, duration: String? = nil) -> CGFloat {
            height(UnreadableRow(model: s.model, icons: [:], message: first, count: 1, joins: joins, duration: duration))
        }
        XCTAssertLessThan(unreadable(joins: true), unreadable(joins: false), "a joined row draws no head")
        XCTAssertEqual(unreadable(joins: false, duration: "4s"), unreadable(joins: false), accuracy: 1)
    }

    func testAnotherDayStartsAHeadAgain() {
        var s = Session()
        s.typed("one", time: 1_700_000_000_000)
        s.typed("two", time: 1_700_000_000_000 + 3 * 86_400_000)
        XCTAssertEqual(s.rows.map(\.joins), [false, false])
    }

    func testAWorksEndDrawsNothingSoItBreaksNothing() {
        var s = Session()
        s.typed("one")
        s.say("footer", "4s")
        s.typed("two")
        let rows = s.rows
        XCTAssertEqual(rows.count, 2, "the work's end is no row")
        XCTAssertTrue(rows[1].joins)
    }

    func testASystemEventIsNoHeadAndBreaksTheGroup() {
        var s = Session()
        s.publishProfile()
        s.typed("one")
        s.say("notice", "Stopped.")
        s.typed("two")
        let rows = s.rows
        XCTAssertEqual(rows.map(\.joins), [false, false, false])
        XCTAssertNil(rows[1].head, "a compact row, no avatar")
    }

    func testTheDurationStandsBesideTheTimeOfTheBotsAnswer() {
        var s = Session()
        s.answer()
        s.say("footer", "4s")
        let rows = s.rows
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].duration, "4s")
    }

    /// A turn of calls alone has the bot's head over its first call, and its length goes there; a person's time never carries it (#136).
    func testACallsOnlyTurnGivesItsLengthToTheHeadOverItsFirstCall() {
        var s = Session()
        s.typed("one")
        s.line("Read: a.txt")
        s.say("footer", "4s")
        XCTAssertEqual(s.rows.map(\.duration), [nil, "4s"], "the person's prompt, then the call under the bot's head")
    }

    func testAFooterWithNoLengthDrawsNoRow() {
        var s = Session()
        s.typed("one")
        s.say("footer", "")
        XCTAssertEqual(s.rows.count, 1, "the panel and a word's answer draw these rows")
        s.answer()
        s.say("footer", "")
        XCTAssertNil(s.rows.last?.duration)
    }

    func testAPersonsPromptClosesTheTurnSoALaterLengthIsNotTheEarlierAnswers() {
        var s = Session()
        s.idleAnswer(0xA1)
        s.typed("/stop")
        s.line("Read: a.txt")
        s.say("footer", "9s")
        XCTAssertEqual(s.rows.map(\.duration), [nil, nil, "9s"], "the answer ended with no footer; the calls-only turn after the prompt has its own head")
    }

    @MainActor
    func testAWordsAnswerInTheConversationShowsItsLength() {
        func drawn(_ footer: String) -> CGFloat {
            var s = Session()
            s.answer()
            s.say("footer", footer)
            let thread = s.model.channels[s.channel]!.threads[s.prompt.hex]!
            return height(Answered(model: s.model, icons: [:], thread: thread, prompt: thread.root!))
        }
        XCTAssertGreaterThan(drawn("3s"), drawn(""), "the length stands under the answer")
    }

    /// A reply whose first row is a text draws its length beside its time: the line under the reply would say it twice.
    @MainActor
    func testAWordsAnswerThatStartsWithATextDrawsItsLengthOnce() {
        func drawn(_ footer: String) -> CGFloat {
            var s = Session()
            s.botText("Done.")
            s.say("footer", footer)
            let thread = s.model.channels[s.channel]!.threads[s.prompt.hex]!
            return height(Answered(model: s.model, icons: [:], thread: thread, prompt: thread.root!))
        }
        XCTAssertEqual(drawn("3s"), drawn(""), accuracy: 1, "beside the time, with no line of its own")
    }

    /// A word's answer whose reply starts with a call keeps its length in the conversation: the head that carries it in the thread is the
    /// call's, which this list does not draw.
    @MainActor
    func testAWordsAnswerThatStartsWithACallShowsItsLength() {
        func drawn(_ footer: String) -> CGFloat {
            var s = Session()
            s.line("Read: a.txt")
            s.answer()
            s.say("footer", footer)
            let thread = s.model.channels[s.channel]!.threads[s.prompt.hex]!
            XCTAssertEqual(ThreadRows.build(thread, isSystem: { _ in false }).first?.duration, footer.isEmpty ? nil : footer, "the call's row carries it")
            return height(Answered(model: s.model, icons: [:], thread: thread, prompt: thread.root!))
        }
        XCTAssertGreaterThan(drawn("3s"), drawn(""), "the length stands under the answer")
    }

    func testAWorksEndClosesItsTurnAndTheNextTurnHasItsOwnHeadAndLength() {
        var s = Session()
        s.idleAnswer(0xA1)
        s.say("footer", "4s")
        s.line("Read: a.txt")
        s.say("footer", "9s")
        let rows = s.rows
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].duration, "4s", "the first answer keeps its own length")
        XCTAssertEqual(rows[1].duration, "9s", "the calls-only turn after the work's end has its head and its length")
        XCTAssertTrue(rows[1].showsHead)
    }

    func testEachIdleTurnHasItsHeadAndItsLength() {
        var s = Session()
        s.idleAnswer(0xA1)
        s.say("footer", "4s")
        s.idleAnswer(0xA2)
        s.say("footer", "9s")
        let rows = s.rows
        XCTAssertEqual(rows.map(\.duration), ["4s", "9s"])
        XCTAssertEqual(rows.map(\.joins), [false, false], "a work's end closes the turn: the next answer starts a head")
    }

    func testTheGapAboveARowIsItsGroupsMessagesOrCards() {
        var s = Session()
        s.typed("one")
        s.typed("two")
        s.line("Read: a.txt")
        s.typed("three")
        XCTAssertEqual(s.rows.map(\.gapAbove), [PardnerMetrics.messageGap, PardnerMetrics.groupGap, PardnerMetrics.messageGap, PardnerMetrics.messageGap],
                       "the call opens the bot's reply: a message's gap")
        XCTAssertEqual(s.rows.map { ThreadRow.stack + $0.offset }, s.rows.map(\.gapAbove), "each row corrects the stack's spacing to its own gap")
    }

    // MARK: the session's data row

    func testTheSessionLineSeparatesItsFacts() {
        let facts = SessionFacts("Sonnet · effort low · main (+0,-0) · ctx 7% · 457.4k tokens")
        XCTAssertEqual(facts.parts, [.model("Sonnet"), .plain("effort low"), .branch(.init(name: "main", added: 0, removed: 0)), .context(7), .tokens("457.4k tokens")])
    }

    func testThePartsKeepTheirOrderAndTheModelIsTheOneToBold() {
        let facts = SessionFacts("⚡ bypass · Opus 5.5 · effort low · main (+1,-2) · ctx 7% · 12k tokens · demo")
        XCTAssertEqual(facts.parts, [.plain("⚡ bypass"), .model("Opus 5.5"), .plain("effort low"), .branch(.init(name: "main", added: 1, removed: 2)), .context(7), .tokens("12k tokens"), .plain("demo")])
        XCTAssertEqual(SessionFacts("Sonnet · API · $1.84 this session").parts, [.model("Sonnet"), .plain("API"), .plain("$1.84 this session")])
        XCTAssertEqual(SessionFacts("⏸ plan · effort high").parts, [.plain("⏸ plan"), .plain("effort high")], "no model known")
    }

    func testAPartTheRowDoesNotKnowStaysAsWritten() {
        let facts = SessionFacts("⚡ bypass · Opus 5.5 · feature/x (+12,-3) · API · $1.84 this session")
        XCTAssertEqual(facts.plain, ["⚡ bypass", "API", "$1.84 this session"])
        XCTAssertEqual(facts.parts[2], .branch(.init(name: "feature/x", added: 12, removed: 3)))
        XCTAssertEqual(SessionFacts("(+1,-2)").parts, [.branch(.init(name: "", added: 1, removed: 2))], "changes with no branch")
    }
}
