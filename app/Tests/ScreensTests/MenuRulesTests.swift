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

    func testASheetIsUpWhileDevicesOrTheChannelSheetIsOpen() {
        let devices = devices(), channels = ChannelsModel(devices: devices)
        XCTAssertFalse(Menus.sheetIsUp(devices: devices, channels: channels))
        devices.isOpen = true
        XCTAssertTrue(Menus.sheetIsUp(devices: devices, channels: channels))
        devices.isOpen = false
        channels.openNew()
        XCTAssertTrue(Menus.sheetIsUp(devices: devices, channels: channels), "the channel sheet counts, and so does the name sheet")
        channels.close()
        XCTAssertFalse(Menus.sheetIsUp(devices: devices, channels: channels))
        channels.openRename(.person, current: nil)
        XCTAssertTrue(Menus.sheetIsUp(devices: devices, channels: channels))
    }

    func testASheetIsUpBetweenTheDevicesSheetClosingAndTheNameSheetOpening() {
        let devices = devices(), channels = ChannelsModel(devices: devices)
        devices.isOpen = true
        devices.closeForRename()
        XCTAssertFalse(devices.isOpen)
        XCTAssertTrue(Menus.sheetIsUp(devices: devices, channels: channels))
        XCTAssertFalse(Menus.canMakeChannel(paired: true, devices: devices, channels: channels))
        XCTAssertFalse(Menus.canOpenDevices(paired: true, devices: devices, channels: channels))
        XCTAssertTrue(devices.takeRename())
        XCTAssertFalse(Menus.sheetIsUp(devices: devices, channels: channels))
    }

    func testNewChannelNeedsAPairedMacReadyChannelsAndNoSheet() {
        let ready = devices()
        let channels = ChannelsModel(devices: ready)
        XCTAssertTrue(Menus.canMakeChannel(paired: true, devices: ready, channels: channels))
        XCTAssertFalse(Menus.canMakeChannel(paired: false, devices: ready, channels: channels))
        let unread = devices(read: false)
        XCTAssertFalse(Menus.canMakeChannel(paired: true, devices: unread, channels: ChannelsModel(devices: unread)), "not before the log is read")
        ready.isOpen = true
        XCTAssertFalse(Menus.canMakeChannel(paired: true, devices: ready, channels: channels))
    }

    func testDevicesNeedsAPairedMacAndNoSheet() {
        let devices = devices(), channels = ChannelsModel(devices: devices)
        XCTAssertTrue(Menus.canOpenDevices(paired: true, devices: devices, channels: channels))
        XCTAssertFalse(Menus.canOpenDevices(paired: false, devices: devices, channels: channels))
        channels.openNew()
        XCTAssertFalse(Menus.canOpenDevices(paired: true, devices: devices, channels: channels), "a second sheet over the channel sheet is never asked for")
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
