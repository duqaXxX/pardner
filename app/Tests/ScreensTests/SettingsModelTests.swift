// The Settings panel's state (settings design 2.1, 4): which pane is open, what closing and a phase change do, and the panel drawn offscreen.
// Over fixed states; no controller runs.
import AppKit
import DesignSystem
import Conversation
import Foundation
@testable import Relay
@testable import Screens
import SwiftUI
import XCTest

@MainActor
final class SettingsModelTests: XCTestCase {
    func testTheWindowIsClosedUntilAPaneIsOpened() {
        let settings = SettingsModel(devices: DevicesModel())
        XCTAssertNil(settings.pane)
        settings.present = {}
        settings.open(.general)
        XCTAssertEqual(settings.pane, .general)
        settings.close()
        XCTAssertNil(settings.pane)
    }

    func testAPhaseChangeClosesThePanelAndForgetsTheDevicesActs() {
        let devices = DevicesModel(state: DevicesState(), page: .add, pasted: "00")
        devices.isOpen = true
        let settings = SettingsModel(devices: devices)
        settings.present = {}
        settings.open(.general)
        settings.reset()
        XCTAssertNil(settings.pane)
        XCTAssertFalse(devices.isOpen)
        XCTAssertEqual(devices.pasted, "")
    }

    func testOpeningDevicesOpensItsModelAndAnotherPaneLeavesItOpen() {
        let devices = DevicesModel()
        let settings = SettingsModel(devices: devices)
        settings.present = {}
        settings.open(.devices)
        XCTAssertEqual(settings.pane, .devices)
        XCTAssertTrue(devices.isOpen)
        devices.pasted = "0a1b"
        settings.open(.general)
        XCTAssertTrue(devices.isOpen, "a form being filled is still there on return")
        settings.open(.devices)
        XCTAssertEqual(devices.pasted, "0a1b", "returning to the pane finds the form as it was")
    }

    func testClosingThePanelClosesDevicesBackToItsList() {
        let devices = DevicesModel()
        let settings = SettingsModel(devices: devices)
        settings.present = {}
        settings.open(.devices)
        devices.pasted = "0a1b"
        settings.close()
        XCTAssertNil(settings.pane)
        XCTAssertFalse(devices.isOpen)
        XCTAssertEqual(devices.page, .list)
        XCTAssertEqual(devices.pasted, "")
    }

    func testEscapeGoesBackOnADevicesPageAndClosesTheWindowElsewhere() {
        let devices = DevicesModel(state: DevicesState(), page: .add, pasted: "00")
        devices.isOpen = true
        let settings = SettingsModel(devices: devices)
        settings.present = {}
        settings.open(.devices)
        XCTAssertEqual(devices.page, .add, "opening a pane that is already open keeps its page")
        settings.escape()
        XCTAssertEqual(devices.page, .list)
        XCTAssertEqual(settings.pane, .devices, "Escape on a page goes back and keeps the window")
        settings.escape()
        XCTAssertNil(settings.pane, "on the list it closes the window")
        settings.open(.general)
        settings.escape()
        XCTAssertNil(settings.pane)
    }

    func testWithNoPresentDevicesStaysClosedToo() {
        let devices = DevicesModel()
        let settings = SettingsModel(devices: devices)
        settings.open(.devices)
        XCTAssertNil(settings.pane)
        XCTAssertFalse(devices.isOpen)
    }

    func testALateCloseOfAnEarlierShowingEndsNothingNewer() {
        let settings = SettingsModel(devices: DevicesModel())
        settings.present = {}
        settings.open(.general)
        let first = settings.epoch
        settings.open(.bots)
        XCTAssertEqual(settings.epoch, first, "a pane change is the same showing")
        settings.close()
        settings.open(.general)
        settings.close(ifEpoch: first)
        XCTAssertEqual(settings.pane, .general, "the window of the first showing went late")
        settings.close(ifEpoch: settings.epoch)
        XCTAssertNil(settings.pane)
    }

    func testOpenCallsPresentOnEveryRequestAndNothingOpensWithoutIt() {
        let settings = SettingsModel(devices: DevicesModel())
        settings.open(.general)
        XCTAssertNil(settings.pane, "no window to show it: no state")
        var shown = 0
        settings.present = { shown += 1 }
        settings.open(.general)
        settings.open(.general)
        settings.open(.bots)
        XCTAssertEqual(shown, 3, "an open window comes forward on each request")
        XCTAssertEqual(settings.pane, .bots)
    }

    func testThePanelHasAPaneForEachSetting() {
        XCTAssertEqual(SettingsModel.Pane.allCases.map(\.rawValue), ["General", "Profile", "Devices", "Bots"])
        let settings = SettingsModel(devices: DevicesModel())
        settings.present = {}
        settings.open(.bots)
        XCTAssertEqual(settings.pane, .bots)
        XCTAssertFalse(settings.devices.isOpen, "only the Devices pane opens the Devices model")
    }

    func testTheThemeIsLightOrDarkAndAppliesToTheApp() {
        XCTAssertEqual(Theme.allCases.map(\.rawValue), ["Light", "Dark"])
        _ = NSApplication.shared
        let before = NSApplication.shared.appearance
        defer { NSApplication.shared.appearance = before }
        Theme.dark.apply()
        XCTAssertEqual(NSApplication.shared.appearance?.name, .darkAqua)
        Theme.light.apply()
        XCTAssertEqual(NSApplication.shared.appearance?.name, .aqua)
    }

    /// The panel as it draws in `appearance`, 600 by 640 points offscreen.
    private func picture(_ panel: SettingsPanel, _ appearance: NSAppearance.Name = .aqua) throws -> Data {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let view = NSHostingView(rootView: panel)
        view.appearance = NSAppearance(named: appearance)
        view.frame = NSRect(x: 0, y: 0, width: 600, height: 640)
        view.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        return try XCTUnwrap(rep.representation(using: .png, properties: [:]))
    }

    func testEachPaneDrawsInBothThemes() throws {
        for pane in SettingsModel.Pane.allCases {
            let settings = SettingsModel(devices: DevicesModel(state: DevicesState()))
            settings.present = {}
            settings.open(pane)
            let panel = SettingsPanel(model: settings)
            XCTAssertNotEqual(try picture(panel, .aqua), try picture(panel, .darkAqua), "\(pane.rawValue): the two themes draw differently")
        }
    }

    func testTheBotsPaneDrawsAProfileAndItsAbsenceDifferently() throws {
        var state = DevicesState()
        let botId = Data(repeating: 1, count: 32)
        state.rows = [DeviceRow(id: botId, kind: .bot, label: "studio-dev", shortForm: "", adder: .none, position: 1, active: true, isThisMac: false, seenAt: nil,
                                onlyHolderEpochs: 0, addedWhileRemoving: false)]
        let devices = DevicesModel(state: state)
        let settings = SettingsModel(devices: devices)
        settings.present = {}
        settings.open(.bots)
        let read = BotProfile(name: "mini", account: "a@example.com", plan: nil, icon: nil)
        let seen = try picture(SettingsPanel(model: settings, bots: devices.listedBots(profiles: [botId: read])))
        let unseen = try picture(SettingsPanel(model: settings, bots: devices.listedBots(profiles: [:])))
        XCTAssertNotEqual(seen, unseen, "the profile's name and account, or the label and Not seen yet")
    }

    func testTheBotsPaneSaysNothingAboutNoBotsUntilTheListIsRead() throws {
        let unread = SettingsModel(devices: DevicesModel(state: DevicesState()))
        unread.present = {}
        unread.open(.bots)
        var state = DevicesState()
        state.rows = [DeviceRow(id: Data(repeating: 2, count: 32), kind: .app, label: nil, shortForm: "", adder: .none, position: 0, active: true, isThisMac: true, seenAt: nil,
                                onlyHolderEpochs: 0, addedWhileRemoving: false)]
        let read = SettingsModel(devices: DevicesModel(state: state))
        read.present = {}
        read.open(.bots)
        XCTAssertFalse(unread.devices.ready)
        XCTAssertTrue(read.devices.ready)
        XCTAssertNotEqual(try picture(SettingsPanel(model: unread)), try picture(SettingsPanel(model: read)), "Reading your devices… before, No bots yet after")
    }
}
