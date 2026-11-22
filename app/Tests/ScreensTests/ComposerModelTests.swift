// What a composer decides (composer design 2 to 4): the five cases and their bodies (each read back through the reading model's `Message`), the
// commands refused without a bot, the keys, one send per Return, the label and the bot list, every outcome's row, the size limit, drafts, the
// rows kept after a later outbox, and Queued. Over fixed states and a stand-in sender; no controller runs.
import Conversation
import Foundation
import ProtocolHost
@testable import Relay
@testable import Screens
import XCTest

@MainActor
final class ComposerModelTests: XCTestCase {
    private static func id(_ byte: UInt8) -> Data { Data(repeating: byte, count: 32) }
    private let channel = id(0x3F), alice = id(1), mini = id(2), studio = id(3), gone = id(4), bobsBot = id(9)
    private var sent: [(Data, OutboxDraft)] = []
    private var outcome: SendOutcome = .queued(name: Data(repeating: 0xE1, count: 16))

    private func devices(read: Bool = true) -> DevicesModel {
        var s = DevicesState()
        guard read else { return DevicesModel(state: s) }
        func row(_ b: UInt8, _ kind: DeviceKind, _ active: Bool) -> DeviceRow {
            DeviceRow(id: Self.id(b), kind: kind, label: nil, shortForm: "", adder: .none, position: Int(b), active: active, isThisMac: kind == .app, seenAt: nil,
                      onlyHolderEpochs: 0, addedWhileRemoving: false)
        }
        s.rows = [row(1, .app, true), row(2, .bot, true), row(3, .bot, true), row(4, .bot, false)]
        return DevicesModel(state: s)
    }

    private func put(_ m: inout ReadingModel, _ kind: Int, _ sender: Data, _ json: [String: Any], at: Int, to: Data? = nil, re: MessageRef? = nil, name: UInt8? = nil) -> MessageRef {
        m.take(view: messageView(kind, sender, json, at: at, to: to, re: re, name: name))
        return MessageRef(device: sender, name: Data(repeating: name ?? UInt8(at), count: 16))
    }

    private func messageView(_ kind: Int, _ sender: Data, _ json: [String: Any], at: Int, to: Data? = nil, re: MessageRef? = nil, name: UInt8? = nil) -> HostValue {
        let n = Data(repeating: name ?? UInt8(at), count: 16)
        return .object([
            "do": .string("message"), "position": .number(Double(at)), "channel": .bytes(channel), "sender": .bytes(sender), "name": .bytes(n),
            "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(1_700_000_000_000 + Double(at) * 1000), "kind": .number(Double(kind)),
            "to": to.map { .bytes($0) } ?? .null, "blobs": .array([]), "files": .array([]), "again": .bool(false),
            "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null,
            "text": .string(String(decoding: try! JSONSerialization.data(withJSONObject: json), as: UTF8.self)),
        ])
    }

    /// A conversation with the person's session thread (root to `mini`), her removed bot's (to `gone`), bob's bot's, and a thread people opened.
    private func reading() -> (ReadingModel, mine: String, removed: String, bobs: String, people: String) {
        var m = ReadingModel()
        let a = put(&m, 2, alice, ["text": "one"], at: 1, to: mini)
        let b = put(&m, 2, alice, ["text": "two"], at: 2, to: gone)
        let c = put(&m, 2, Self.id(8), ["text": "three"], at: 3, to: bobsBot)
        let d = put(&m, 1, Self.id(8), ["markdown": "hello"], at: 4)
        return (m, a.hex, b.hex, c.hex, d.hex)
    }

    private func composer(thread: String? = nil, reading r: ReadingModel? = nil, devices d: DevicesModel? = nil) -> ComposerModel {
        ComposerModel(channel: channel, thread: thread, conversation: ConversationModel(reading: r ?? reading().0), devices: d ?? devices()) { [self] channel, draft in
            sent.append((channel, draft))
            return outcome
        }
    }

    /// The message the link would deliver for a draft, read through the reading model's own `Message`.
    private func read(_ draft: OutboxDraft) -> Message? {
        Message(view: .object([
            "do": .string("message"), "position": .number(1), "channel": .bytes(channel), "sender": .bytes(alice), "name": .bytes(Data(repeating: 1, count: 16)),
            "time": .number(0), "kind": .number(Double(draft.kind)), "to": draft.to.map { .bytes($0) } ?? .null, "files": .array([]), "text": .string(draft.content),
        ]))
    }

    private func type(_ c: ComposerModel, _ text: String) { c.edited(text) }

    /// Types `keys` one at a time after what the field holds, as the field hands each change over.
    private func press(_ c: ComposerModel, _ keys: String) { for key in keys { c.edited(c.text + String(key)) } }

    private func send(_ c: ComposerModel, _ text: String) async {
        c.edited(text)
        await c.submit()?.value
    }

    // MARK: the five cases of 2.2

    func testTheChannelWithALabelSendsAPromptToTheBot() async throws {
        let c = composer()
        type(c, "@")
        XCTAssertTrue(c.picking)
        c.pick(mini)
        await send(c, "fix it")
        let (to, draft) = try XCTUnwrap(sent.first)
        XCTAssertEqual(to, channel)
        XCTAssertEqual(draft.kind, 2)
        XCTAssertEqual(draft.to, mini)
        XCTAssertEqual(read(draft)?.body, .prompt(text: "fix it"))
        XCTAssertNil(read(draft)?.thread, "no thread: it opens one")
        XCTAssertEqual(draft.content, #"{"text":"fix it"}"#)
    }

    func testTheChannelWithNoLabelSendsATextThatReadsAsText() async throws {
        let c = composer()
        await send(c, "hello all")
        let draft = try XCTUnwrap(sent.first?.1)
        XCTAssertEqual(draft.kind, 1)
        XCTAssertEqual(draft.to, nil)
        XCTAssertEqual(read(draft)?.body, .text(markdown: "hello all", say: nil))
    }

    func testAThreadOfTheOwnActiveBotSendsAPromptToItInTheThread() async throws {
        let r = reading()
        let c = composer(thread: r.mine, reading: r.0)
        await send(c, "and the docs")
        let draft = try XCTUnwrap(sent.first?.1)
        XCTAssertEqual(draft.kind, 2)
        XCTAssertEqual(draft.to, mini)
        let message = try XCTUnwrap(read(draft))
        XCTAssertEqual(message.body, .prompt(text: "and the docs"))
        XCTAssertEqual(message.thread, r.mine)
    }

    func testAThreadOfARemovedBotIsDisabledWithItsLine() async {
        let r = reading()
        let c = composer(thread: r.removed, reading: r.0)
        XCTAssertEqual(c.availability, .botRemoved)
        XCTAssertEqual(c.disabledLine, "This bot was removed from your devices.")
        await send(c, "hi")
        XCTAssertTrue(sent.isEmpty)
    }

    func testAnyOtherThreadSendsATextInTheThread() async throws {
        let r = reading()
        for key in [r.bobs, r.people] {
            sent = []
            let c = composer(thread: key, reading: r.0)
            await send(c, "me too")
            let draft = try XCTUnwrap(sent.first?.1)
            XCTAssertEqual(draft.kind, 1)
            XCTAssertEqual(draft.to, nil)
            let message = try XCTUnwrap(read(draft))
            XCTAssertEqual(message.body, .text(markdown: "me too", say: nil), "a kind 1 reads as text")
            XCTAssertEqual(message.thread, key, "in its thread")
        }
    }

    func testEveryComposerWaitsForTheDeviceListAndAThreadForItsRoot() async {
        let c = composer(devices: devices(read: false))
        XCTAssertEqual(c.disabledLine, "Reading your devices\u{2026}")
        await send(c, "hi")
        XCTAssertTrue(sent.isEmpty)
        let unknown = composer(thread: "ab")
        XCTAssertEqual(unknown.availability, .readingThread)
    }

    // MARK: commands, labels, keys

    func testACommandWithNoBotIsRefusedAndALeadingSpaceSendsItAsText() async throws {
        let c = composer()
        await send(c, "/bind x")
        XCTAssertTrue(sent.isEmpty)
        XCTAssertEqual(c.notice, "Mention a bot to send it a command. To send people text that starts with / or !, begin it with a space.")
        XCTAssertEqual(c.text, "/bind x", "the field is as the owner has it")
        await send(c, " /bind x")
        XCTAssertEqual(sent.first?.1.kind, 1)
        let r = reading()
        let t = composer(thread: r.people, reading: r.0)
        await send(t, "!ls")
        XCTAssertEqual(t.notice, "Commands go to a bot: use a session's thread.")
        sent = []
        let session = composer(thread: r.mine, reading: r.0)
        await send(session, "/compact")
        XCTAssertEqual(sent.first?.1.kind, 2, "a bot reads commands")
        type(c, "@")
        c.pick(mini)
        await send(c, "!ls")
        XCTAssertEqual(sent.last?.1.kind, 2)
    }

    /// `studio` read as "alpha", `mini` as "Mini Dev", and a third bot known only by its pairing string's label "zeta".
    private func named() -> ComposerModel {
        var m = ReadingModel()
        m.take(profile: .object(["do": .string("profile"), "bot": .bytes(studio), "profile": .object(["name": .string("alpha")])]))
        m.take(profile: .object(["do": .string("profile"), "bot": .bytes(mini), "profile": .object(["name": .string("Mini Dev")])]))
        var s = devices().state
        s.rows.append(DeviceRow(id: Self.id(5), kind: .bot, label: "zeta", shortForm: "", adder: .none, position: 5, active: true, isThisMac: false, seenAt: nil,
                                onlyHolderEpochs: 0, addedWhileRemoving: false))
        return composer(reading: m, devices: DevicesModel(state: s))
    }

    func testTheBotListFiltersAsThePersonTypes() {
        let c = named()
        type(c, "@")
        XCTAssertEqual(c.matches().map(\.name), ["alpha", "Mini Dev", "zeta"])
        type(c, "@MI")
        XCTAssertTrue(c.picking)
        XCTAssertEqual(c.matches().map(\.name), ["Mini Dev"], "case-insensitive")
        type(c, "@e")
        XCTAssertEqual(c.matches().map(\.name), ["Mini Dev", "zeta"], "no name starts with e: the names it is inside")
        type(c, "@a")
        XCTAssertEqual(c.matches().map(\.name), ["alpha", "zeta"], "the names it starts first, then the names it is inside")
        type(c, "@mini d")
        XCTAssertTrue(c.picking, "a space inside a name keeps the list open")
        XCTAssertEqual(c.matches().map(\.name), ["Mini Dev"])
        type(c, "@nobody")
        XCTAssertFalse(c.picking, "a name that is no bot's stays text")
        XCTAssertNil(c.label)
        type(c, "@ze")
        c.movePick(5)
        XCTAssertEqual(c.pickIndex, 0, "the arrows stay inside the filtered list")
        XCTAssertTrue(c.pickHighlighted(), "Tab picks, as Return does")
        XCTAssertEqual(c.label, Self.id(5))
        XCTAssertEqual(c.text, "")
        XCTAssertEqual(c.name(of: Self.id(5)), "\u{201C}zeta\u{201D}", "a label is drawn in quotes, a claim")
        XCTAssertEqual(c.choices().first { $0.id == Self.id(5) }?.shown, "\u{201C}zeta\u{201D}")
    }

    func testATypedNameAndASpaceBecomeTheLabel() {
        let c = named()
        type(c, "@mini dev fix the test")
        XCTAssertEqual(c.label, mini, "the longest name wins")
        XCTAssertEqual(c.text, "fix the test", "the rest stays as the text")
        XCTAssertFalse(c.picking)
        type(c, "@alpha again")
        XCTAssertEqual(c.label, mini, "one label per message: a second @name is text")
        XCTAssertEqual(c.text, "@alpha again")
        let d = named()
        type(d, "@ZETA\tgo")
        XCTAssertEqual(d.label, Self.id(5), "a label's name, any case, any whitespace after it")
        XCTAssertEqual(d.text, "go")
        let e = named()
        type(e, "@alphabet soup")
        XCTAssertNil(e.label, "a name is whole: alphabet is not alpha")
        XCTAssertEqual(e.text, "@alphabet soup")
        let twins = [ChannelsModel.BotChoice(id: mini, name: "twin"), ChannelsModel.BotChoice(id: studio, name: "Twin")]
        XCTAssertNil(ComposerModel.mention(in: "@twin hi", bots: twins), "two bots of one name: no label")
        let r = reading()
        let thread = composer(thread: r.mine, reading: r.0)
        type(thread, "@alpha hi")
        XCTAssertNil(thread.label, "in a thread @ is plain text")
    }

    func testANameThatStartsALongerOneWaitsForTheNextKey() {
        var m = ReadingModel()
        m.take(profile: .object(["do": .string("profile"), "bot": .bytes(studio), "profile": .object(["name": .string("mini")])]))
        m.take(profile: .object(["do": .string("profile"), "bot": .bytes(mini), "profile": .object(["name": .string("mini dev")])]))
        let c = composer(reading: m)
        press(c, "@mini dev fix it")
        XCTAssertEqual(c.label, mini, "typed key by key, `mini dev` is reached: the space after `mini` is still the start of a longer name")
        XCTAssertEqual(c.text, "fix it")
        let d = composer(reading: m)
        press(d, "@mini hello")
        XCTAssertEqual(d.label, studio, "`mini` alone, once the next key leaves no longer name")
        XCTAssertEqual(d.text, "hello")
    }

    func testEscapeKeepsATypedNameAsText() {
        let c = named()
        type(c, "@al")
        c.closePicker()
        press(c, "pha is down again")
        XCTAssertNil(c.label, "after Escape the @name is text for people")
        XCTAssertEqual(c.text, "@alpha is down again")
    }

    func testEscapeKeepsTheListClosedUntilTheAtGoes() {
        let c = named()
        type(c, "@m")
        c.closePicker()
        XCTAssertFalse(c.picking)
        type(c, "@mi")
        XCTAssertFalse(c.picking, "typing on after Escape does not reopen it")
        XCTAssertFalse(c.returnPressed(shift: true, marked: false))
        type(c, "")
        type(c, "@")
        XCTAssertTrue(c.picking, "a new @ opens it again")
    }

    func testTheLabelListsActiveBotsByNameAndBackspaceRemovesTheLabel() {
        var m = ReadingModel()
        m.take(profile: .object(["do": .string("profile"), "bot": .bytes(studio), "profile": .object(["name": .string("alpha")])]))
        let c = composer(reading: m)
        type(c, "@")
        XCTAssertEqual(c.choices().map(\.name), ["alpha", Naming.short(mini)].sorted(), "a removed bot is no choice; short id when no profile")
        c.movePick(1)
        XCTAssertEqual(c.pickIndex, 1)
        XCTAssertTrue(c.returnPressed(shift: false, marked: false), "Return picks")
        XCTAssertNotNil(c.label)
        XCTAssertEqual(c.text, "")
        XCTAssertFalse(c.picking)
        XCTAssertTrue(c.backspaceAtStart())
        XCTAssertNil(c.label)
        XCTAssertFalse(c.backspaceAtStart())
        type(c, "@")
        c.closePicker()
        XCTAssertEqual(c.text, "@", "Escape leaves the @ as text")
        type(c, "a@b")
        XCTAssertFalse(c.picking)
        let r = reading()
        let thread = composer(thread: r.mine, reading: r.0)
        type(thread, "@")
        XCTAssertFalse(thread.picking, "in a thread @ is plain text")
        let mid = composer()
        type(mid, "hi @")
        XCTAssertFalse(mid.picking)
    }

    func testReturnSendsShiftReturnAndMarkedTextDoNot() async {
        let c = composer()
        type(c, "line")
        XCTAssertFalse(c.returnPressed(shift: true, marked: false))
        XCTAssertFalse(c.returnPressed(shift: false, marked: true))
        XCTAssertTrue(sent.isEmpty)
        XCTAssertTrue(c.returnPressed(shift: false, marked: false))
        XCTAssertEqual(c.text, "", "the text leaves the field at once")
        await Task.yield()
        XCTAssertEqual(sent.count, 1)
        type(c, "  \n ")
        XCTAssertNil(c.submit(), "only white space is not sent")
    }

    func testOneSendPerReturnWithARowInPlaceForEach() async {
        let c = composer()
        type(c, "same")
        let first = c.submit()
        XCTAssertNil(c.submit(), "the field is empty: no second send of the same text")
        type(c, "same")
        let second = c.submit()
        XCTAssertEqual(c.rows().map(\.status), [.sending, .sending])
        await first?.value
        await second?.value
        XCTAssertEqual(sent.count, 2)
    }

    func testAPasteOfAFileOrAnImageSaysItCannotBeSent() {
        let c = composer()
        c.pasteRefused()
        XCTAssertEqual(c.notice, "Files cannot be sent yet.")
        type(c, "x")
        XCTAssertNil(c.notice, "typing takes it back")
    }

    func testABodyPastTheFrameIsNotSentAndAnEscapedOneCountsItsEncodedBytes() async {
        let c = composer()
        await send(c, String(repeating: "a", count: 999_980))
        XCTAssertEqual(sent.count, 1, "under the limit once encoded")
        await send(c, String(repeating: "a", count: 1_000_000))
        XCTAssertEqual(c.notice, "This message is too long to send.")
        XCTAssertEqual(sent.count, 1)
        await send(c, String(repeating: "\u{01}", count: 170_000)) // six bytes each once escaped
        XCTAssertEqual(c.notice, "This message is too long to send.")
        XCTAssertEqual(sent.count, 1)
    }

    // MARK: rows

    private func item(_ n: UInt8, _ state: OutboxItemState, _ content: String, kind: Int = 1) -> OutboxItemRow {
        OutboxItemRow(name: Data(repeating: n, count: 16), kind: kind, to: nil, re: nil, content: content, state: state)
    }

    func testEachOutcomeIsARowInPlaceWithItsLine() async {
        let table: [(SendOutcome, String)] = [
            (.notSaved, "Pardner could not save the message. Try again."), (.ended, "Pardner is not connected. Try again in a moment."),
            (.refused("not-ready"), "Pardner could not save the message. Try again."), (.refused("bad-input"), "This message cannot be sent."),
            (.refused("fault"), "Pardner stopped sending in this channel."), (.refused("not-member"), "This Mac is not a member of this channel."),
        ]
        for (result, line) in table {
            outcome = result
            let c = composer()
            await send(c, "keep me")
            XCTAssertEqual(c.rows().map(\.status), [.notSent(line)], "\(result)")
            XCTAssertEqual(c.rows().first?.text, "keep me")
            XCTAssertEqual(c.text, "keep me", "an empty field takes the text back")
            c.take(items: [])
            XCTAssertEqual(c.rows().count, 1, "kept after a later outbox")
        }
    }

    func testAQueuedMessageIsSendingUntilSentThenNothingThenHiddenOnceRead() async {
        let c = composer()
        await send(c, "hello")
        let content = #"{"markdown":"hello"}"#
        XCTAssertEqual(c.rows().map(\.status), [.sending], "queued, the effect not seen yet")
        c.take(items: [item(0xE1, .waiting, content)])
        XCTAssertEqual(c.rows().map(\.status), [.sending])
        c.take(items: [item(0xE1, .sent, content)])
        XCTAssertEqual(c.rows().map(\.status), [.sent])
        var r = reading().0
        _ = put(&r, 1, alice, ["markdown": "hello"], at: 20, name: 0xE1)
        let after = ComposerModel(channel: channel, thread: nil, conversation: ConversationModel(reading: r), devices: devices()) { _, _ in .ended }
        after.take(items: [item(0xE1, .sent, content)])
        XCTAssertTrue(after.rows().isEmpty, "the outbox first: held names stay hidden")
    }

    func testTheReadingBeforeTheOutboxHidesTheRowAndAnItemTheOutboxStopsListingIsNeverNotDelivered() async {
        let content = #"{"markdown":"hello"}"#
        let model = ConversationModel(reading: reading().0)
        let c = ComposerModel(channel: channel, thread: nil, conversation: model, devices: devices()) { [self] _, _ in outcome }
        await send(c, "hello")
        c.take(items: [item(0xE1, .sent, content)])
        XCTAssertEqual(c.rows().count, 1)
        model.apply(.delivered(messageView(1, alice, ["markdown": "hello"], at: 20, name: 0xE1)))
        XCTAssertTrue(c.rows().isEmpty, "the delivery arrived first")
        let lost = composer()
        await send(lost, "hello")
        lost.take(items: [item(0xE1, .sent, content)])
        lost.take(items: [])
        XCTAssertTrue(lost.rows().isEmpty, "the outbox drops an item only on a read back or as refused, which is told: this one was read")
    }

    func testARefusedItemIsKeptEvenWhenItIsToldInsideTheCallThatQueuesIt() async throws {
        let content = #"{"markdown":"big"}"#
        let c = ComposerModel(channel: channel, thread: nil, conversation: ConversationModel(reading: reading().0), devices: devices()) { [self] _, _ in
            c0?.take(items: [item(0xE1, .refused, content)]) // the effect comes before the answer
            return outcome
        }
        c0 = c
        await send(c, "big")
        XCTAssertEqual(c.rows().map(\.status), [.notDelivered])
        c.take(items: [])
        XCTAssertEqual(c.rows().map(\.status), [.notDelivered], "a later effect does not drop it")
        XCTAssertEqual(c.rows().first?.text, "big")
    }
    private var c0: ComposerModel?

    func testARetriedIdenticalTextIsNotTakenForTheRefusedOne() async {
        var names = [Data(repeating: 0xE1, count: 16), Data(repeating: 0xE2, count: 16)]
        let c = ComposerModel(channel: channel, thread: nil, conversation: ConversationModel(reading: reading().0), devices: devices()) { _, _ in .queued(name: names.removeFirst()) }
        let content = #"{"markdown":"again"}"#
        await send(c, "again")
        c.take(items: [item(0xE1, .refused, content)])
        await send(c, "again")
        c.take(items: [item(0xE2, .waiting, content)])
        XCTAssertEqual(c.rows().map(\.status), [.notDelivered, .sending], "each by its name, not by its body")
    }

    func testAnOutboxItemBeforeTheAnswerMakesNoSecondRow() async {
        let content = #"{"markdown":"hello"}"#
        let gate = AsyncStream<Void>.makeStream()
        let c = ComposerModel(channel: channel, thread: nil, conversation: ConversationModel(reading: reading().0), devices: devices()) { _, _ in
            for await _ in gate.stream { break }
            return .queued(name: Data(repeating: 0xE1, count: 16))
        }
        type(c, "hello")
        let task = c.submit()
        c.take(items: [item(0xE1, .waiting, content)]) // the effect comes first
        XCTAssertEqual(c.rows().map(\.status), [.sending], "one row")
        gate.continuation.yield()
        await task?.value
        XCTAssertEqual(c.rows().map(\.status), [.sending], "still one, now bound")
        c.take(items: [item(0xE1, .sent, content)])
        XCTAssertEqual(c.rows().map(\.status), [.sent])
    }

    func testARefusedReportSurvivesALaterStateThroughTheComposers() {
        let hub = Composers(conversation: ConversationModel(reading: reading().0), devices: devices()) { _, _ in .ended }
        var first = ChannelsState()
        first.outboxes[channel] = [item(0xC1, .refused, #"{"markdown":"a"}"#)]
        first.undelivered[channel] = first.outboxes[channel]
        hub.take(first)
        var second = ChannelsState()
        second.outboxes[channel] = [item(0xC2, .waiting, #"{"markdown":"b"}"#)] // the effect that replaced the first list; the controller still holds the refusal until acknowledged
        hub.take(second)
        let shown = hub.composer(channel: channel) // made after both states: the refusal is the registry's to remember
        XCTAssertEqual(shown.rows().map(\.status), [.notDelivered, .sending], "send order: the refusal is the older")
        XCTAssertEqual(shown.rows().map(\.text), ["a", "b"])
    }

    func testADismissedRefusedRowStaysGoneWhenTheStateIsTakenAgain() {
        let hub = Composers(conversation: ConversationModel(reading: reading().0), devices: devices()) { _, _ in .ended }
        var state = ChannelsState()
        state.undelivered[channel] = [item(0xC1, .refused, #"{"markdown":"a"}"#)]
        hub.take(state)
        let c = hub.composer(channel: channel)
        XCTAssertEqual(c.rows().map(\.status), [.notDelivered])
        c.dismiss(c.rows()[0].id)
        hub.take(state)
        hub.take(ChannelsState())
        XCTAssertTrue(c.rows().isEmpty)
        XCTAssertTrue(hub.composer(channel: channel, thread: nil).rows().isEmpty)
    }

    func testAnItemTheOutboxStopsListingIsGoneNotDrawnAsSending() {
        let c = composer()
        c.take(items: [item(0xC1, .waiting, #"{"markdown":"a"}"#)])
        XCTAssertEqual(c.rows().map(\.status), [.sending])
        c.take(items: [])
        XCTAssertTrue(c.rows().isEmpty, "read back: the outbox drops an item only then, or as refused")
    }

    func testAFailedOrRefusedRowCanBeDismissed() async {
        outcome = .notSaved
        let c = composer()
        await send(c, "x")
        XCTAssertEqual(c.rows().count, 1)
        c.dismiss(c.rows()[0].id)
        XCTAssertTrue(c.rows().isEmpty)
        outcome = .queued(name: Data(repeating: 0xE1, count: 16))
        await send(c, "y")
        c.dismiss(c.rows()[0].id)
        XCTAssertEqual(c.rows().count, 1, "a message on its way is not dismissed")
    }

    func testATextTheFailureGivesBackIsNotWrittenOverATextTypedSince() async {
        outcome = .ended
        let c = composer()
        type(c, "first")
        let task = c.submit()
        type(c, "second")
        await task?.value
        XCTAssertEqual(c.text, "second")
    }

    func testABindOfASheetIsARowButAnItemWithReIsNotDrawn() {
        let c = composer()
        let bind = OutboxItemRow(name: Data(repeating: 0xB1, count: 16), kind: 2, to: mini, re: nil, content: #"{"text":"/bind /work"}"#, state: .waiting)
        let answer = OutboxItemRow(name: Data(repeating: 0xB2, count: 16), kind: 5, to: nil, re: MessageReference(device: mini, name: Data(repeating: 1, count: 16)),
                                   content: #"{"markdown":"x"}"#, state: .waiting)
        let reply = OutboxItemRow(name: Data(repeating: 0xB3, count: 16), kind: 2, to: mini, re: MessageReference(device: mini, name: Data(repeating: 1, count: 16)),
                                  content: #"{"text":"y"}"#, state: .waiting)
        c.take(items: [bind, answer, reply])
        XCTAssertEqual(c.rows().map(\.text), ["/bind /work"])
        XCTAssertEqual(c.rows().map(\.status), [.sending])
        XCTAssertEqual(c.rows().first?.to, mini)
    }

    func testAStoredItemIsDrawnFromItsContentAfterARestartInItsOwnPlace() {
        let r = reading()
        let channelComposer = composer(reading: r.0)
        let thread = composer(thread: r.mine, reading: r.0)
        let items = [item(0xC1, .waiting, #"{"markdown":"a"}"#), item(0xC2, .sent, "{\"text\":\"b\",\"thread\":\"\(r.mine)\"}", kind: 2)]
        channelComposer.take(items: items)
        thread.take(items: items)
        XCTAssertEqual(channelComposer.rows().map(\.text), ["a"])
        XCTAssertEqual(thread.rows().map(\.text), ["b"])
        XCTAssertEqual(thread.rows().map(\.status), [.sent])
    }

    func testDraftsAndRowsAreKeptPerChannelAndThread() async {
        let hub = Composers(conversation: ConversationModel(reading: reading().0), devices: devices()) { _, _ in .ended }
        let other = Self.id(0x40)
        hub.composer(channel: channel).edited("draft one")
        hub.composer(channel: other).edited("draft two")
        hub.composer(channel: channel, thread: "t").edited("in thread")
        XCTAssertEqual(hub.composer(channel: channel).text, "draft one")
        XCTAssertEqual(hub.composer(channel: other).text, "draft two")
        XCTAssertEqual(hub.composer(channel: channel, thread: "t").text, "in thread")
        var state = ChannelsState()
        state.outboxes[channel] = [item(0xC1, .waiting, #"{"markdown":"a"}"#)]
        hub.take(state)
        XCTAssertEqual(hub.composer(channel: channel).rows().count, 1)
        XCTAssertEqual(Composers(conversation: ConversationModel(), devices: devices()) { _, _ in .ended }.composer(channel: channel).rows().count, 0)
        let late = Composers(conversation: ConversationModel(), devices: devices()) { _, _ in .ended }
        late.take(state)
        XCTAssertEqual(late.composer(channel: channel).rows().count, 1, "a composer made after the restart's effect draws what waits")
    }

    // MARK: the send and mention buttons (window redesign, unit 1e)

    func testSendIsOffExactlyWhenReturnSendsNothing() async throws {
        let c = composer()
        XCTAssertFalse(c.canSend, "an empty field")
        type(c, "  \n ")
        XCTAssertFalse(c.canSend, "blanks alone")
        type(c, "hello")
        XCTAssertTrue(c.canSend)
        XCTAssertNotNil(c.submit(), "Return sends what the button's state says it can")
        XCTAssertFalse(c.canSend, "the field is empty after a send")
    }

    func testALabelAloneCannotBeSent() {
        let c = composer()
        press(c, "@")
        c.pick(mini)
        XCTAssertEqual(c.label, mini)
        XCTAssertEqual(c.text, "")
        XCTAssertFalse(c.canSend)
        XCTAssertNil(c.submit())
    }

    func testSendFollowsTheAvailability() {
        let r = reading()
        let unread = composer(devices: devices(read: false))
        type(unread, "hello")
        XCTAssertEqual(unread.availability, .readingDevices)
        XCTAssertFalse(unread.canSend)
        let unknown = composer(thread: "00", reading: r.0)
        type(unknown, "hello")
        XCTAssertEqual(unknown.availability, .readingThread)
        XCTAssertFalse(unknown.canSend)
        let removed = composer(thread: r.removed, reading: r.0)
        type(removed, "hello")
        XCTAssertEqual(removed.availability, .botRemoved)
        XCTAssertFalse(removed.canSend)
        let ready = composer(thread: r.mine, reading: r.0)
        type(ready, "hello")
        XCTAssertEqual(ready.availability, .ready)
        XCTAssertTrue(ready.canSend)
    }

    func testTheMentionButtonStartsTheBotListAsTypingAnAtSignDoes() {
        let c = composer()
        XCTAssertTrue(c.canMention)
        c.startMention()
        XCTAssertEqual(c.text, "@")
        XCTAssertTrue(c.picking)
        c.pick(mini)
        XCTAssertFalse(c.canMention, "a bot is already named")
    }

    func testTheMentionButtonDoesNothingInAThreadOrOverText() {
        let r = reading()
        let thread = composer(thread: r.mine, reading: r.0)
        XCTAssertFalse(thread.canMention, "an @ in a thread is plain text")
        thread.startMention()
        XCTAssertEqual(thread.text, "")
        let typed = composer()
        type(typed, "hello")
        XCTAssertFalse(typed.canMention)
        typed.startMention()
        XCTAssertEqual(typed.text, "hello")
        let unread = composer(devices: devices(read: false))
        XCTAssertFalse(unread.canMention)
    }

    func testSendIsOffWhileTheBotListIsOpenAndOnAfterAPick() {
        var m = ReadingModel()
        m.take(profile: .object(["do": .string("profile"), "bot": .bytes(studio), "profile": .object(["name": .string("alpha")])]))
        let c = composer(reading: m)
        press(c, "@")
        XCTAssertTrue(c.picking)
        XCTAssertFalse(c.canSend, "Return picks the highlighted bot there, so the button sends nothing")
        press(c, "al")
        XCTAssertEqual(c.text, "@al")
        XCTAssertTrue(c.picking)
        XCTAssertFalse(c.canSend)
        XCTAssertNil(c.submit())
        c.pick(studio)
        type(c, "run it")
        XCTAssertTrue(c.canSend)
    }

    func testTheSendButtonIsOffWhileTheFieldHoldsUncommittedTextButReturnStillSends() {
        let c = composer()
        type(c, "hello")
        XCTAssertFalse(c.sendOff)
        c.hasMarkedText = true
        XCTAssertTrue(c.sendOff, "the button must not send uncommitted text")
        XCTAssertTrue(c.canSend, "Return is given the live marked state by the field, so a stale flag never swallows it")
        XCTAssertNotNil(c.submit())
        c.hasMarkedText = false
        type(c, "again")
        XCTAssertFalse(c.sendOff)
    }

    func testTheMentionButtonAsksForTheFieldsFocusUntilItIsTaken() {
        let c = composer()
        XCTAssertFalse(c.focusRequested)
        c.startMention()
        XCTAssertTrue(c.focusRequested)
        c.focusTaken()
        XCTAssertFalse(c.focusRequested)
        let thread = composer(thread: reading().mine)
        thread.startMention()
        XCTAssertFalse(thread.focusRequested, "no request where the button does nothing")
    }

    func testTheMentionButtonIsOffWithNoActiveBot() {
        var s = DevicesState()
        s.rows = [DeviceRow(id: alice, kind: .app, label: nil, shortForm: "", adder: .none, position: 1, active: true, isThisMac: true, seenAt: nil,
                            onlyHolderEpochs: 0, addedWhileRemoving: false)]
        let c = composer(devices: DevicesModel(state: s))
        XCTAssertEqual(c.availability, .ready)
        XCTAssertFalse(c.canMention)
        c.startMention()
        XCTAssertEqual(c.text, "")
    }
}
