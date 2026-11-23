// What the sidebar's section views decide without drawing (sidebar sections design 7): the entries of a section's menu, the lines under the
// header and the count a folded section carries.
import Conversation
import Foundation
import ProtocolHost
@testable import Relay
@testable import Screens
import XCTest

@MainActor
final class SidebarSectionsTests: XCTestCase {
    private static func id(_ byte: UInt8) -> Data { Data(repeating: byte, count: 32) }
    private static func hex(_ byte: UInt8) -> String { id(byte).map { String(format: "%02x", $0) }.joined() }

    private final class MemoryDefaults: UserDefaults {
        init() { super.init(suiteName: nil)! }
        override func set(_ value: Any?, forKey key: String) {}
        override func stringArray(forKey key: String) -> [String]? { nil }
    }

    private func rig(_ layout: [(UInt8, [UInt8])], current: Bool = true) -> SectionsModel {
        let conversation = ConversationModel()
        let model = SectionsModel(conversation: conversation, channels: ChannelsModel(devices: DevicesModel()), defaults: MemoryDefaults()) { _ in .ended }
        for (position, byte) in Set(layout.flatMap(\.1)).sorted().enumerated() {
            conversation.apply(.delivered(.object([
                "do": .string("message"), "position": .number(Double(position)), "channel": .bytes(Self.id(byte)), "sender": .bytes(Self.id(9)),
                "name": .bytes(Data([byte])), "time": .number(0), "kind": .number(2),
            ])))
        }
        let sections: [HostValue] = layout.map { .object(["id": .string(Self.hex($0.0)), "name": .string("s\($0.0)"), "channels": .array($0.1.map { .string(Self.hex($0)) })]) }
        conversation.apply(.arrangement(.object(["sections": .array(sections), "current": .bool(current), "behind": .bool(false), "notApplied": .bool(false)])))
        return model
    }

    func testAMiddleSectionOffersBothMovesAndAnEdgeOnlyOne() {
        let model = rig([(0xA1, [1]), (0xA2, []), (0xA3, [])])
        XCTAssertEqual(SectionsMenu.entries(model, channelsReady: true, section: Self.hex(0xA2)), .init(enabled: true, newChannel: true, up: true, down: true))
        XCTAssertEqual(SectionsMenu.entries(model, channelsReady: true, section: Self.hex(0xA1)), .init(enabled: true, newChannel: true, up: false, down: true))
        XCTAssertEqual(SectionsMenu.entries(model, channelsReady: true, section: Self.hex(0xA3)), .init(enabled: true, newChannel: true, up: true, down: false))
    }

    func testEveryCommandIsOffWhileTheDeviceIsNotCurrent() {
        let model = rig([(0xA1, []), (0xA2, [])], current: false)
        XCTAssertEqual(SectionsMenu.entries(model, channelsReady: true, section: Self.hex(0xA1)), .init(enabled: false, newChannel: false, up: false, down: true))
    }

    func testNewChannelWaitsForTheChannelsToBeReady() {
        let model = rig([(0xA1, [])])
        XCTAssertEqual(SectionsMenu.entries(model, channelsReady: false, section: Self.hex(0xA1)), .init(enabled: true, newChannel: false, up: false, down: false))
    }

    func testTheLinesSayWhyTheCommandsAreOff() {
        XCTAssertEqual(SectionsMenu.line(current: false, behind: false, notApplied: false), "Reading your sections…")
        XCTAssertEqual(SectionsMenu.line(current: false, behind: true, notApplied: false), "Your sections from your other devices are still being read.")
        XCTAssertEqual(SectionsMenu.line(current: true, behind: false, notApplied: true), "A change to your sections was not applied: another device changed them first.")
        XCTAssertNil(SectionsMenu.line(current: true, behind: false, notApplied: false))
        // Not current wins: the not-applied line waits until the device has read everything.
        XCTAssertEqual(SectionsMenu.line(current: false, behind: false, notApplied: true), "Reading your sections…")
    }

    func testARenameOfASectionThatIsGoneCloses() {
        let tree = rig([(0xA1, [])]).tree
        XCTAssertEqual(SectionsMenu.kept(.rename(section: Self.hex(0xA1)), in: tree), .rename(section: Self.hex(0xA1)))
        XCTAssertNil(SectionsMenu.kept(.rename(section: Self.hex(0xA2)), in: tree))
        XCTAssertEqual(SectionsMenu.kept(.new(channel: nil), in: tree), .new(channel: nil))
        XCTAssertNil(SectionsMenu.kept(nil, in: tree))
    }

    func testAFoldedSectionCountsTheSessionsWaitingInItsChannels() throws {
        let sample = Samples.model()
        let quiet = Data(repeating: 0x55, count: 32)
        var model = sample.model
        model.take(view: .object([
            "do": .string("message"), "position": .number(500), "channel": .bytes(quiet), "sender": .bytes(Samples.bob),
            "name": .bytes(Data(repeating: 7, count: 16)), "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(1_763_600_000_000),
            "kind": .number(1), "to": .null, "blobs": .array([]), "files": .array([]), "re": .null, "again": .bool(false), "text": .string(#"{"markdown":"Hi."}"#),
        ]))
        let waiting = try XCTUnwrap(Sidebar.waitingCount(try XCTUnwrap(model.channels[sample.channel])))
        let both = SectionsModel.Group(id: "a", name: "Work", channels: [sample.channel, quiet])
        XCTAssertEqual(SectionsMenu.waiting(both, in: model), waiting)
        XCTAssertNil(SectionsMenu.waiting(SectionsModel.Group(id: "b", name: "Quiet", channels: [quiet]), in: model))
        XCTAssertNil(SectionsMenu.waiting(SectionsModel.Group(id: "c", name: "Empty", channels: []), in: model))
    }
}
