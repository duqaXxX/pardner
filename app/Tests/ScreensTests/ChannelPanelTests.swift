// The channel's panel (channel folder design, 2): what it shows from the latest `bind` field, and how it holds the one-sheet rule and hands
// over to the bind sheet. Over fixed messages; no controller runs.
import Conversation
import Foundation
import ProtocolHost
@testable import Relay
@testable import Screens
import XCTest

@MainActor
final class ChannelPanelTests: XCTestCase {
    private static func id(_ byte: UInt8) -> Data { Data(repeating: byte, count: 32) }
    private let (alice, bot, channelId) = (ChannelPanelTests.id(1), ChannelPanelTests.id(2), ChannelPanelTests.id(0x3F))

    private func devices() -> DevicesModel {
        var s = DevicesState()
        s.rows = [DeviceRow(id: Self.id(1), kind: .app, label: nil, shortForm: "", adder: .none, position: 0, active: true, isThisMac: true, seenAt: nil,
                            onlyHolderEpochs: 0, addedWhileRemoving: false)]
        return DevicesModel(state: s)
    }

    /// A channel in which each (prompt text, answer content) pair was sent to `bot` and answered by it.
    private func channel(_ pairs: [(String, [String: Any])]) -> Channel {
        var m = ReadingModel()
        var position = 1
        func put(kind: Int, from sender: Data, json: [String: Any], to: Data? = nil, re: MessageRef? = nil) -> MessageRef {
            let name = Data(repeating: UInt8(position), count: 16)
            m.take(view: .object([
                "do": .string("message"), "position": .number(Double(position)), "channel": .bytes(channelId), "sender": .bytes(sender),
                "name": .bytes(name), "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(1_763_600_000_000.0 + Double(position) * 60_000),
                "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null, "blobs": .array([]), "files": .array([]),
                "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null,
                "text": .string(String(decoding: try! JSONSerialization.data(withJSONObject: json), as: UTF8.self)), "again": .bool(false),
            ]))
            position += 1
            return MessageRef(device: sender, name: name)
        }
        for (text, answer) in pairs {
            let prompt = put(kind: 2, from: alice, json: ["text": text], to: bot)
            _ = put(kind: 1, from: bot, json: answer, re: prompt)
        }
        return m.channels[channelId]!
    }

    private func answer(_ folder: String, _ state: String, _ text: String = "Bound.") -> [String: Any] {
        ["say": "notice", "markdown": text, "bind": ["folder": folder, "state": state]]
    }

    func testEachStateHasItsWords() throws {
        let words: [(String, String)] = [
            ("usable", "Usable"),
            ("untrusted", "Not trusted in Claude Code: open the folder in Claude Code once and accept the trust prompt"),
            ("missing", "The folder is missing"),
            ("unreadable", "The folder cannot be read"),
        ]
        for (state, line) in words {
            let panel = try XCTUnwrap(ChannelPanel(channel: channel([("/bind /srv/code/demo", answer("/srv/code/demo", state, "Text of \(state)."))])), state)
            XCTAssertEqual(panel, ChannelPanel(bot: bot, folder: "/srv/code/demo", state: line, text: "Text of \(state)."), state)
        }
    }

    func testWithNoFieldTheChannelIsNotKnownYet() {
        XCTAssertNil(ChannelPanel(channel: channel([("/bind /srv/code/demo", ["say": "notice", "markdown": "Bound."])])), "an older bot")
    }

    func testANewerFieldReplacesTheOlderAndARefusalWithoutOneChangesNothing() throws {
        let both = channel([("/bind /srv/code/a", answer("/srv/code/a", "usable")), ("/bind /srv/code/b", answer("/srv/code/b", "missing", "Gone."))])
        XCTAssertEqual(try XCTUnwrap(ChannelPanel(channel: both)).folder, "/srv/code/b")
        let refused = channel([("/bind /srv/code/a", answer("/srv/code/a", "usable")), ("/bind /elsewhere", ["say": "notice", "markdown": "Not allowed."])])
        XCTAssertEqual(try XCTUnwrap(ChannelPanel(channel: refused)).folder, "/srv/code/a", "the folder that stays")
    }

    func testChangeFolderMovesThePanelToTheBindFormInOneStepInTheSameWindow() {
        let channels = ChannelsModel(devices: devices())
        var shown = 0
        channels.present = { shown += 1 }
        channels.openSettings(channel: channelId)
        XCTAssertEqual(shown, 1)
        channels.folder = "/typed"
        channels.changeFolder(bot: bot)
        XCTAssertEqual(channels.sheet, .bind(channel: channelId))
        XCTAssertEqual(channels.bot, bot)
        XCTAssertEqual(channels.folder, "", "the fields of the panel are cleared, as for any new form")
        XCTAssertEqual(shown, 1, "the window is the one already open")
    }

    func testALateCloseEndsNothingNewerAndChangeFolderIsTheSameShowing() {
        let channels = ChannelsModel(devices: devices())
        channels.present = {}
        channels.openSettings(channel: channelId)
        let first = channels.epoch
        channels.changeFolder(bot: bot)
        XCTAssertEqual(channels.epoch, first)
        channels.close()
        channels.openNew()
        channels.close(ifEpoch: first)
        XCTAssertEqual(channels.sheet, .create)
        channels.close(ifEpoch: channels.epoch)
        XCTAssertNil(channels.sheet)
    }

    func testChangeFolderOpensNothingFromAnotherFormAndNothingForAFaultedChannel() {
        let channels = ChannelsModel(devices: devices())
        channels.present = {}
        channels.openNew()
        channels.changeFolder(bot: bot)
        XCTAssertEqual(channels.sheet, .create)
        var state = ChannelsState()
        state.faulted = [channelId]
        let faulted = ChannelsModel(state: state, devices: devices())
        faulted.present = {}
        faulted.openSettings(channel: channelId)
        faulted.changeFolder(bot: bot)
        XCTAssertEqual(faulted.sheet, .settings(channel: channelId), "the panel stays")
    }

    func testResetEndsTheBindForm() {
        let channels = ChannelsModel(devices: devices())
        channels.present = {}
        channels.openSettings(channel: channelId)
        channels.changeFolder(bot: bot)
        channels.reset()
        XCTAssertNil(channels.sheet)
    }
}
