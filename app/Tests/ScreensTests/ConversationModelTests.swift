// What the main window reads (app data design, 6): the controller's readings applied to the reading model, and an erase that empties
// it. Over readings given by the test; no controller runs. Synthetic content.
import Conversation
import Foundation
import ProtocolHost
@testable import Relay
@testable import Screens
import XCTest

@MainActor
final class ConversationModelTests: XCTestCase {
    private let channel = Data(repeating: 1, count: 32)
    private let alice = Data(repeating: 2, count: 32)
    private let bot = Data(repeating: 3, count: 32)

    /// A text message of alice's at `place`, as `AppLink` delivers it.
    private func text(_ words: String, at place: Int) -> HostValue {
        .object([
            "do": .string("message"), "position": .number(Double(place)), "channel": .bytes(channel), "sender": .bytes(alice),
            "name": .bytes(Data(repeating: UInt8(place), count: 16)), "epoch": .bytes(Data(repeating: 9, count: 32)),
            "time": .number(1_700_000_000_000 + Double(place) * 1000), "kind": .number(1), "to": .null, "blobs": .array([]),
            "again": .bool(false), "re": .null, "files": .array([]),
            "text": .string(String(decoding: try! JSONSerialization.data(withJSONObject: ["text": words]), as: UTF8.self)),
        ])
    }

    func testDeliveriesAndProfilesReachTheModelAndAResetEmptiesIt() {
        let model = ConversationModel()
        model.apply(.delivered(text("hello", at: 0)))
        model.apply(.delivered(.object(["do": .string("rest")])))
        model.apply(.profile(.object(["bot": .bytes(bot), "profile": .object(["name": .string("mini")])])))
        model.apply(.delivered(text("again", at: 1)))
        XCTAssertEqual(model.reading.channels[channel]?.messages.map(\.position), [0, 1], "a rest is not a message")
        XCTAssertEqual(model.reading.profiles[bot]?.name, "mini")
        model.apply(.reset)
        XCTAssertEqual(model.reading, ReadingModel(), "nothing of the last connection or pairing stays drawn")
    }

    func testANewConnectionRebuildsFromEmpty() {
        // The controller yields `reset` before a new connection reads from position 0: the model is rebuilt, never patched.
        let model = ConversationModel()
        model.apply(.delivered(text("hello", at: 0)))
        model.apply(.delivered(text("again", at: 1)))
        model.apply(.reset)
        model.apply(.delivered(text("hello", at: 0)))
        XCTAssertEqual(model.reading.channels[channel]?.messages.map(\.position), [0])
    }

    /// A message of `kind` at `place`, named by its place, as `AppLink` delivers it.
    private func view(_ kind: Int, from sender: Data, _ json: [String: Any], at place: Int, to: Data? = nil, re: MessageRef? = nil) -> HostValue {
        .object([
            "do": .string("message"), "position": .number(Double(place)), "channel": .bytes(channel), "sender": .bytes(sender),
            "name": .bytes(Data(repeating: UInt8(place), count: 16)), "epoch": .bytes(Data(repeating: 9, count: 32)),
            "time": .number(1_700_000_000_000 + Double(place) * 1000), "kind": .number(Double(kind)),
            "to": to.map { .bytes($0) } ?? .null, "blobs": .array([]), "again": .bool(false),
            "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null, "files": .array([]),
            "text": .string(String(decoding: try! JSONSerialization.data(withJSONObject: json), as: UTF8.self)),
        ])
    }

    func testThePersonsOwnDevicesOutliveAReset() {
        // The Devices list of a new connection can come before its reset: the reply of a Mac that never prompted still counts.
        let model = ConversationModel()
        let mac = Data(repeating: 6, count: 32)
        model.setOwnDevices([mac])
        model.apply(.reset)
        let ref = { (place: Int, device: Data) in MessageRef(device: device, name: Data(repeating: UInt8(place), count: 16)) }
        model.apply(.delivered(view(2, from: alice, ["text": "go"], at: 0, to: bot)))
        let root = ref(0, alice)
        model.apply(.delivered(view(3, from: bot, [:], at: 1, re: root)))
        model.apply(.delivered(view(9, from: bot, ["thread": root.hex, "title": "Allow?", "request": ["type": "permission"]], at: 2, re: root)))
        let request = ref(2, bot)
        model.apply(.delivered(view(10, from: mac, ["answer": ["type": "permission", "allow": true]], at: 3, to: bot, re: request)))
        XCTAssertEqual(model.reading.channels[channel]?.threads[root.hex]?.requests[request], .replied)
    }
}
