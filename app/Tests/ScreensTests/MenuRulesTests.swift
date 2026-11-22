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

    func testASheetIsUpWhileThePanelDevicesOrTheChannelSheetIsOpen() {
        let devices = devices(), channels = ChannelsModel(devices: devices), settings = SettingsModel(devices: devices)
        XCTAssertFalse(Menus.sheetIsUp(settings: settings, channels: channels))
        settings.open(.general)
        XCTAssertTrue(Menus.sheetIsUp(settings: settings, channels: channels))
        settings.close()
        devices.isOpen = true
        XCTAssertTrue(Menus.sheetIsUp(settings: settings, channels: channels))
        devices.isOpen = false
        channels.openNew()
        XCTAssertTrue(Menus.sheetIsUp(settings: settings, channels: channels), "the channel sheet counts, and so does the name sheet")
        channels.close()
        XCTAssertFalse(Menus.sheetIsUp(settings: settings, channels: channels))
        channels.openRename(.person, current: nil)
        XCTAssertTrue(Menus.sheetIsUp(settings: settings, channels: channels))
    }

    func testASheetIsUpBetweenTheDevicesSheetClosingAndTheNameSheetOpening() {
        let devices = devices(), channels = ChannelsModel(devices: devices), settings = SettingsModel(devices: devices)
        devices.isOpen = true
        devices.closeForRename()
        XCTAssertFalse(devices.isOpen)
        XCTAssertTrue(Menus.sheetIsUp(settings: settings, channels: channels))
        XCTAssertFalse(Menus.canMakeChannel(paired: true, settings: settings, channels: channels))
        XCTAssertFalse(Menus.canOpenSettings(paired: true, settings: settings, channels: channels))
        XCTAssertFalse(Menus.canOpenDevices(paired: true, settings: settings, channels: channels))
        XCTAssertTrue(devices.takeRename())
        XCTAssertFalse(Menus.sheetIsUp(settings: settings, channels: channels))
    }

    func testNewChannelNeedsAPairedMacReadyChannelsAndNoSheet() {
        let ready = devices()
        let channels = ChannelsModel(devices: ready), settings = SettingsModel(devices: ready)
        XCTAssertTrue(Menus.canMakeChannel(paired: true, settings: settings, channels: channels))
        XCTAssertFalse(Menus.canMakeChannel(paired: false, settings: settings, channels: channels))
        let unread = devices(read: false)
        XCTAssertFalse(Menus.canMakeChannel(paired: true, settings: SettingsModel(devices: unread), channels: ChannelsModel(devices: unread)), "not before the log is read")
        settings.open(.general)
        XCTAssertFalse(Menus.canMakeChannel(paired: true, settings: settings, channels: channels), "Command-N is off under the panel")
    }

    func testSettingsAndDevicesNeedAPairedMacAndNoSheet() {
        let devices = devices(), channels = ChannelsModel(devices: devices), settings = SettingsModel(devices: devices)
        XCTAssertTrue(Menus.canOpenSettings(paired: true, settings: settings, channels: channels))
        XCTAssertTrue(Menus.canOpenDevices(paired: true, settings: settings, channels: channels))
        XCTAssertFalse(Menus.canOpenSettings(paired: false, settings: settings, channels: channels))
        XCTAssertFalse(Menus.canOpenDevices(paired: false, settings: settings, channels: channels))
        channels.openNew()
        XCTAssertFalse(Menus.canOpenSettings(paired: true, settings: settings, channels: channels), "a second sheet over the channel sheet is never asked for")
        XCTAssertFalse(Menus.canOpenDevices(paired: true, settings: settings, channels: channels))
        channels.close()
        settings.open(.general)
        XCTAssertFalse(Menus.canOpenSettings(paired: true, settings: settings, channels: channels), "nor a second panel over the panel")
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
