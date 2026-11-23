// What the menu commands and the context menus offer (window redesign, unit 1f): the rule "a sheet is up", the File menu's New Channel…
// and Devices…, and the entries of a channel's menu. Over fixed states; no controller runs.
import Conversation
import Foundation
import ProtocolHost
@testable import Relay
@testable import Screens
import XCTest

@MainActor
final class MenuRulesTests: XCTestCase {
    private static func id(_ byte: UInt8) -> Data { Data(repeating: byte, count: 32) }

    private func devices(read: Bool = true) -> DevicesModel {
        var s = DevicesState()
        if read {
            s.rows = [DeviceRow(id: Self.id(1), kind: .app, label: nil, shortForm: "", adder: .none, position: 0, active: true, isThisMac: true, seenAt: nil,
                                onlyHolderEpochs: 0, addedWhileRemoving: false)]
        }
        return DevicesModel(state: s)
    }

    func testNewChannelNeedsAPairedMacAndReadyChannels() {
        let ready = devices()
        let channels = ChannelsModel(devices: ready)
        XCTAssertTrue(Menus.canMakeChannel(paired: true, channels: channels))
        XCTAssertFalse(Menus.canMakeChannel(paired: false, channels: channels))
        XCTAssertFalse(Menus.canMakeChannel(paired: true, channels: ChannelsModel(devices: devices(read: false))), "not before the log is read")
    }

    func testNewChannelWithAFormOpenBringsThatFormForwardUnchanged() {
        let channels = ChannelsModel(devices: devices())
        var shown = 0
        channels.present = { shown += 1 }
        channels.openRename(.device, current: "Mac one")
        channels.nameText = "typed"
        XCTAssertTrue(Menus.canMakeChannel(paired: true, channels: channels), "the command stays on; the model drops the request")
        channels.openNew()
        XCTAssertEqual(channels.sheet, .rename(.device))
        XCTAssertEqual(channels.nameText, "typed")
        XCTAssertEqual(shown, 2)
    }

    func testAChannelMenuOffersRenameAndBindExceptForAFaultedChannel() {
        var state = ChannelsState()
        state.faulted = [Self.id(9)]
        let channels = ChannelsModel(state: state, devices: devices())
        XCTAssertEqual(Menus.channelEntries(channels, Self.id(8)), Menus.ChannelEntries(rename: true, bind: true))
        XCTAssertEqual(Menus.channelEntries(channels, Self.id(9)), Menus.ChannelEntries(rename: false, bind: false))
        let unread = ChannelsModel(devices: devices(read: false))
        XCTAssertEqual(Menus.channelEntries(unread, Self.id(8)), Menus.ChannelEntries(rename: false, bind: false))
    }
}
