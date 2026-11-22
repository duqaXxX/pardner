// What the channels model decides (new channel design 5): when New channel and Create are offered, when the bot picker shows, what each
// outcome does to the sheet, the sidebar's `Creating…` and refusal lines, a faulted channel's header, and the /bind prompt Bind to a
// folder… sends. Over fixed states and the outcomes the model's own methods take; no controller runs.
import Conversation
import Foundation
import ProtocolHost
@testable import Relay
@testable import Screens
import XCTest

@MainActor
final class ChannelsModelTests: XCTestCase {
    private static func id(_ byte: UInt8) -> Data { Data(repeating: byte, count: 32) }

    private func devices(bots: [(UInt8, Bool)] = [(2, true)], read: Bool = true) -> DevicesModel {
        var s = DevicesState()
        guard read else { return DevicesModel(state: s) }
        s.rows = bots.enumerated().map { index, bot in
            DeviceRow(id: Self.id(bot.0), kind: .bot, label: nil, shortForm: "", adder: .none, position: index + 1, active: bot.1, isThisMac: false,
                      seenAt: nil, onlyHolderEpochs: 0, addedWhileRemoving: false)
        } + [DeviceRow(id: Self.id(1), kind: .app, label: nil, shortForm: "", adder: .none, position: 0, active: true, isThisMac: true, seenAt: nil,
                       onlyHolderEpochs: 0, addedWhileRemoving: false)]
        return DevicesModel(state: s)
    }

    private let names: [Data: String] = [id(2): "mini", id(3): "studio", id(4): "gone"]

    func testNewChannelIsOfferedOnceTheLogIsRead() {
        XCTAssertFalse(ChannelsModel(devices: devices(read: false)).ready)
        XCTAssertTrue(ChannelsModel(devices: devices()).ready)
    }

    func testTheBotPickerShowsWithTwoOrMoreActiveBots() {
        XCTAssertFalse(ChannelsModel(devices: devices(bots: [(2, true)])).showsBotPicker(names: names))
        XCTAssertFalse(ChannelsModel(devices: devices(bots: [(2, true), (4, false)])).showsBotPicker(names: names), "a removed bot is no choice")
        let two = ChannelsModel(devices: devices(bots: [(3, true), (2, true)]))
        XCTAssertTrue(two.showsBotPicker(names: names))
        XCTAssertEqual(two.choices(names: names).map(\.name), ["mini", "studio"], "by name")
    }

    func testCreateNeedsAFolderAndABot() {
        let none = ChannelsModel(devices: devices(bots: []), sheet: .create, folder: "/work")
        XCTAssertFalse(none.canSubmit(names: names))
        let model = ChannelsModel(devices: devices(), sheet: .create)
        XCTAssertFalse(model.canSubmit(names: names), "no folder")
        model.folder = "   "
        XCTAssertFalse(model.canSubmit(names: names), "a blank folder")
        model.folder = " /work/app "
        XCTAssertTrue(model.canSubmit(names: names))
        XCTAssertEqual(model.request(names: names), .create(bot: Self.id(2), folder: "/work/app"), "trimmed; the only bot needs no choice")
    }

    func testTheChosenBotIsUsedAndTheFirstIsTheDefault() {
        let model = ChannelsModel(devices: devices(bots: [(3, true), (2, true)]), sheet: .create, folder: "/w")
        XCTAssertEqual(model.request(names: names), .create(bot: Self.id(2), folder: "/w"), "mini sorts first")
        model.bot = Self.id(3)
        XCTAssertEqual(model.request(names: names), .create(bot: Self.id(3), folder: "/w"))
        model.bot = Self.id(4) // a bot that went
        XCTAssertEqual(model.request(names: names), .create(bot: Self.id(2), folder: "/w"))
    }

    func testCreatedClosesTheSheet() {
        let model = ChannelsModel(devices: devices(), sheet: .create, folder: "/w")
        model.finishCreate(.created(channel: Self.id(9)))
        XCTAssertNil(model.sheet)
        XCTAssertEqual(model.folder, "")
        XCTAssertNil(model.problem)
    }

    func testNotSavedKeepsTheSheetAndItsFields() {
        let model = ChannelsModel(devices: devices(bots: [(3, true), (2, true)]), sheet: .create, folder: "/w")
        model.bot = Self.id(3)
        model.finishCreate(.notSaved)
        XCTAssertEqual(model.sheet, .create)
        XCTAssertEqual(model.folder, "/w")
        XCTAssertEqual(model.bot, Self.id(3))
        XCTAssertEqual(model.problem, "Pardner could not save the new channel. Try again.")
        model.edited()
        XCTAssertNil(model.problem, "typing takes the message back")
    }

    func testTheRefusalsHaveTheirWords() {
        let table: [(String, String)] = [
            ("busy", "Another channel is being created."),
            ("not-ready", "Pardner is still reading your devices. Try again in a moment."),
            ("bad-input", "Pardner could not use this folder or bot. Check the folder and try again."),
            ("odd", "The new channel could not be made (odd)."),
        ]
        for (reason, words) in table {
            let model = ChannelsModel(devices: devices(), sheet: .create, folder: "/w")
            model.finishCreate(.refused(reason))
            XCTAssertEqual(model.sheet, .create, reason)
            XCTAssertEqual(model.problem, words, reason)
        }
        let ended = ChannelsModel(devices: devices(), sheet: .create, folder: "/w")
        ended.finishCreate(.ended)
        XCTAssertEqual(ended.problem, "Pardner is not connected. Try again in a moment.")
    }

    func testAnAnswerForAClosedSheetChangesNothing() {
        let model = ChannelsModel(devices: devices(), sheet: .create, folder: "/w")
        let asked = model.ticket
        model.close()
        model.openNew()
        model.finishCreate(.notSaved, for: asked)
        XCTAssertNil(model.problem)
    }

    func testBindSendsANewPromptToTheBot() throws {
        let channel = Self.id(9)
        let model = ChannelsModel(devices: devices(), sheet: .bind(channel: channel), folder: " /work/app ")
        guard case .bind(let to, let draft)? = model.request(names: names) else { return XCTFail("no request") }
        XCTAssertEqual(to, channel)
        XCTAssertEqual(draft.kind, 2)
        XCTAssertEqual(draft.to, Self.id(2))
        let content = try JSONSerialization.jsonObject(with: Data(draft.content.utf8)) as? [String: String]
        XCTAssertEqual(content, ["text": "/bind /work/app"])
        // A folder with a quote or a backslash stays one JSON string.
        let hostile = ChannelsModel(devices: devices(), sheet: .bind(channel: channel), folder: "/a\"b\\c")
        guard case .bind(_, let other)? = hostile.request(names: names) else { return XCTFail("no request") }
        XCTAssertEqual(try JSONSerialization.jsonObject(with: Data(other.content.utf8)) as? [String: String], ["text": "/bind /a\"b\\c"])
    }

    func testBindOutcomes() {
        let channel = Self.id(9)
        let queued = ChannelsModel(devices: devices(), sheet: .bind(channel: channel), folder: "/w")
        queued.finishSend(.queued(name: Data(repeating: 1, count: 16)))
        XCTAssertNil(queued.sheet)
        let unsaved = ChannelsModel(devices: devices(), sheet: .bind(channel: channel), folder: "/w")
        unsaved.finishSend(.notSaved)
        XCTAssertEqual(unsaved.sheet, .bind(channel: channel))
        XCTAssertEqual(unsaved.problem, "Pardner could not save the message. Try again.")
        let fault = ChannelsModel(devices: devices(), sheet: .bind(channel: channel), folder: "/w")
        fault.finishSend(.refused("fault"))
        XCTAssertEqual(fault.problem, "Pardner stopped sending in this channel.")
        let member = ChannelsModel(devices: devices(), sheet: .bind(channel: channel), folder: "/w")
        member.finishSend(.refused("not-member"))
        XCTAssertEqual(member.problem, "This Mac is not a member of this channel.")
    }

    func testTheSidebarShowsTheChannelBeingCreatedAtOnce() {
        var state = ChannelsState()
        let model = ChannelsModel(state: state, devices: devices())
        XCTAssertNil(model.creatingRow(known: []))
        state.creating = PendingChannel(channel: Self.id(9), bot: Self.id(2), folder: "/w")
        model.apply(state)
        XCTAssertEqual(model.creatingRow(known: []), "Creating\u{2026}")
        XCTAssertEqual(model.creatingRow(known: [Self.id(8)]), "Creating\u{2026}")
        XCTAssertNil(model.creatingRow(known: [Self.id(9)]), "once the reading holds the channel its short id shows instead")
        state.creating = nil
        model.apply(state)
        XCTAssertNil(model.creatingRow(known: []))
    }

    func testARefusedCreationIsToldUntilTheNextOne() {
        var state = ChannelsState()
        state.refusal = CreationRefusal(channel: Self.id(9), code: 7)
        let model = ChannelsModel(state: state, devices: devices())
        XCTAssertEqual(model.refusalLine, "The relay refused the new channel (code 7).")
        state.refusal = nil
        state.creating = PendingChannel(channel: Self.id(8), bot: Self.id(2), folder: "/w")
        model.apply(state)
        XCTAssertNil(model.refusalLine)
    }

    func testAFaultedChannelSaysSoAndCannotBeBound() {
        var state = ChannelsState()
        state.faulted = [Self.id(9)]
        let model = ChannelsModel(state: state, devices: devices())
        XCTAssertEqual(model.faultLine(Self.id(9)), "Pardner stopped sending in this channel: the relay answered what it should not.")
        XCTAssertNil(model.faultLine(Self.id(8)))
        XCTAssertFalse(model.canBind(Self.id(9)))
        XCTAssertTrue(model.canBind(Self.id(8)))
        XCTAssertFalse(ChannelsModel(devices: devices(read: false)).canBind(Self.id(8)), "not before the log is read")
    }

    func testBindToAFolderOpensTheSheetOnlyWhereItIsAllowed() {
        var state = ChannelsState()
        state.faulted = [Self.id(9)]
        let model = ChannelsModel(state: state, devices: devices())
        model.openBind(channel: Self.id(9))
        XCTAssertNil(model.sheet)
        model.openBind(channel: Self.id(8))
        XCTAssertEqual(model.sheet, .bind(channel: Self.id(8)))
    }

    func testResetClosesTheSheetAndTheFields() {
        let model = ChannelsModel(devices: devices(), sheet: .create, folder: "/w", problem: "x")
        model.reset()
        XCTAssertNil(model.sheet)
        XCTAssertEqual(model.folder, "")
        XCTAssertNil(model.problem)
    }

    func testPickingAnotherBotTakesTheLastErrorBack() {
        let model = ChannelsModel(devices: devices(bots: [(3, true), (2, true)]), sheet: .create, folder: "/w", problem: "x")
        model.pick(Self.id(3))
        XCTAssertEqual(model.bot, Self.id(3))
        XCTAssertNil(model.problem)
    }

    func testAThrownErrorHasItsOwnWords() {
        struct Boom: LocalizedError { var errorDescription: String? { "the link broke" } }
        let model = ChannelsModel(devices: devices(), sheet: .create, folder: "/w")
        model.finishFailure(Boom())
        XCTAssertEqual(model.sheet, .create)
        XCTAssertEqual(model.problem, "Pardner could not do this: the link broke. Try again.")
    }

    // MARK: Bind to a folder… preselects the channel's bot

    private func channel(_ build: ((Int, Data, String, Data?) -> Void) -> Void) -> Channel {
        var m = ReadingModel()
        var position = 1
        let channel = Self.id(0x3F)
        build { kind, sender, text, to in
            m.take(view: .object([
                "do": .string("message"), "position": .number(Double(position)), "channel": .bytes(channel), "sender": .bytes(sender),
                "name": .bytes(Data(repeating: UInt8(position), count: 16)), "epoch": .bytes(Data(repeating: 9, count: 32)),
                "time": .number(1_763_600_000_000.0 + Double(position) * 60_000), "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null,
                "blobs": .array([]), "files": .array([]), "re": .null, "text": .string(#"{"text":"\#(text)"}"#), "again": .bool(false),
            ]))
            position += 1
        }
        return m.channels[channel]!
    }

    func testBindPreselectsTheBotOfTheCreationsBindPrompt() {
        let (alice, mini, studio) = (Self.id(1), Self.id(2), Self.id(3))
        let found = channel { put in
            put(2, alice, "/bind /work/app", studio)
            put(2, alice, "fix the test", mini) // a later session of another bot
        }
        XCTAssertEqual(ChannelsModel.bot(of: found), studio, "the creation's bind goes to studio, which sorts after mini")
        let rebound = channel { put in
            put(2, alice, "/bind /work/app", studio)
            put(2, alice, "/bind /work/other", mini)
        }
        XCTAssertEqual(ChannelsModel.bot(of: rebound), mini, "the latest bind")
    }

    func testBindFallsBackToTheNewestSessionsBotThenToNothing() {
        let (alice, mini, studio) = (Self.id(1), Self.id(2), Self.id(3))
        let sessions = channel { put in
            put(2, alice, "first", mini)
            put(2, alice, "second", studio)
        }
        XCTAssertEqual(ChannelsModel.bot(of: sessions), studio, "the newest session's bot, not the oldest")
        let none = channel { put in put(1, alice, "hello", nil) }
        XCTAssertNil(ChannelsModel.bot(of: none))
    }

    func testBindFallsBackToTheNewestPromptsBotWhateverItWasSettledAs() {
        let (alice, mini, studio) = (Self.id(1), Self.id(2), Self.id(3))
        var m = ReadingModel()
        let channel = Self.id(0x3F)
        func put(_ position: Int, kind: Int, sender: Data, text: String, to: Data?, re: Data? = nil) {
            m.take(view: .object([
                "do": .string("message"), "position": .number(Double(position)), "channel": .bytes(channel), "sender": .bytes(sender),
                "name": .bytes(Data(repeating: UInt8(position), count: 16)), "epoch": .bytes(Data(repeating: 9, count: 32)),
                "time": .number(1_763_600_000_000.0 + Double(position) * 60_000), "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null,
                "blobs": .array([]), "files": .array([]),
                "re": re.map { .object(["device": .bytes(alice), "name": .bytes($0)]) } ?? .null, "text": .string(text), "again": .bool(false),
            ]))
        }
        put(1, kind: 2, sender: alice, text: #"{"text":"first"}"#, to: mini)
        put(2, kind: 2, sender: alice, text: #"{"text":"/stop"}"#, to: studio)
        // The newest prompt is answered as a word: no session of its own, and no session of studio's to read the bot from.
        put(3, kind: 5, sender: studio, text: "{\"thread\":\"\(MessageRef(device: alice, name: Data(repeating: 2, count: 16)).hex)\",\"markdown\":\"\",\"session\":false}", to: nil, re: Data(repeating: 2, count: 16))
        put(4, kind: 5, sender: mini, text: "{\"thread\":\"\(MessageRef(device: alice, name: Data(repeating: 1, count: 16)).hex)\",\"markdown\":\"done\"}", to: nil, re: Data(repeating: 1, count: 16)) // the session replies last
        XCTAssertEqual(ChannelsModel.bot(of: m.channels[channel]!), studio)
    }
    func testOpeningBindSelectsThatBotNotTheFirst() {
        let model = ChannelsModel(devices: devices(bots: [(3, true), (2, true)]))
        model.openBind(channel: Self.id(9), bot: Self.id(3))
        model.folder = "/w"
        XCTAssertEqual(model.request(names: names), .bind(channel: Self.id(9), draft: ChannelsModel.bindDraft(bot: Self.id(3), folder: "/w")),
                       "mini sorts first, and the channel's bot is studio")
    }
}
