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
    func testThePanelIsClosedUntilAPaneIsOpened() {
        let settings = SettingsModel(devices: DevicesModel())
        XCTAssertNil(settings.pane)
        XCTAssertFalse(settings.holdsSheet)
        settings.open(.general)
        XCTAssertEqual(settings.pane, .general)
        XCTAssertTrue(settings.holdsSheet)
        settings.close()
        XCTAssertNil(settings.pane)
        XCTAssertFalse(settings.holdsSheet)
    }

    func testAPhaseChangeClosesThePanelAndForgetsTheDevicesActs() {
        let devices = DevicesModel(state: DevicesState(), page: .add, pasted: "00")
        devices.isOpen = true
        let settings = SettingsModel(devices: devices)
        settings.open(.general)
        settings.reset()
        XCTAssertNil(settings.pane)
        XCTAssertFalse(devices.isOpen)
        XCTAssertEqual(devices.pasted, "")
    }

    func testOpeningDevicesOpensItsModelAndAnotherPaneLeavesItOpen() {
        let devices = DevicesModel()
        let settings = SettingsModel(devices: devices)
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
        settings.open(.devices)
        devices.pasted = "0a1b"
        settings.close()
        XCTAssertNil(settings.pane)
        XCTAssertFalse(devices.isOpen)
        XCTAssertEqual(devices.page, .list)
        XCTAssertEqual(devices.pasted, "")
    }

    func testDoneClosesThePanelFromTheListAndBackLeavesItOpen() {
        let devices = DevicesModel(state: DevicesState(), page: .add, pasted: "00")
        devices.isOpen = true
        let settings = SettingsModel(devices: devices)
        settings.open(.devices)
        XCTAssertEqual(devices.page, .add, "opening a pane that is already open keeps its page")
        devices.back() // the Back button of the add and remove pages
        XCTAssertEqual(devices.page, .list)
        XCTAssertEqual(settings.pane, .devices, "Back never closes the panel")
        SettingsPanel.done(settings)() // the closure the Done button of every pane is given
        XCTAssertNil(settings.pane, "Done closes the panel, not just Devices")
    }

    func testARenameClosesThePanelAndHoldsTheRuleUntilTheNameSheetTakesIt() {
        let devices = DevicesModel()
        let settings = SettingsModel(devices: devices)
        settings.open(.devices)
        settings.closeForRename()
        XCTAssertNil(settings.pane)
        XCTAssertTrue(settings.holdsSheet, "a Command-Comma during the panel's dismissal cannot open it again")
        XCTAssertTrue(settings.takeRename())
        XCTAssertFalse(settings.holdsSheet)
        XCTAssertFalse(settings.takeRename(), "once")
    }

    func testThePanelHasAPaneForEachSetting() {
        XCTAssertEqual(SettingsModel.Pane.allCases.map(\.rawValue), ["General", "Devices", "Bots"])
        let settings = SettingsModel(devices: DevicesModel())
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
        settings.open(.bots)
        let read = BotProfile(name: "mini", account: "a@example.com", plan: nil, icon: nil)
        let seen = try picture(SettingsPanel(model: settings, bots: devices.listedBots(profiles: [botId: read])))
        let unseen = try picture(SettingsPanel(model: settings, bots: devices.listedBots(profiles: [:])))
        XCTAssertNotEqual(seen, unseen, "the profile's name and account, or the label and Not seen yet")
    }

    func testTheBotsPaneSaysNothingAboutNoBotsUntilTheListIsRead() throws {
        let unread = SettingsModel(devices: DevicesModel(state: DevicesState()))
        unread.open(.bots)
        var state = DevicesState()
        state.rows = [DeviceRow(id: Data(repeating: 2, count: 32), kind: .app, label: nil, shortForm: "", adder: .none, position: 0, active: true, isThisMac: true, seenAt: nil,
                                onlyHolderEpochs: 0, addedWhileRemoving: false)]
        let read = SettingsModel(devices: DevicesModel(state: state))
        read.open(.bots)
        XCTAssertFalse(unread.devices.ready)
        XCTAssertTrue(read.devices.ready)
        XCTAssertNotEqual(try picture(SettingsPanel(model: unread)), try picture(SettingsPanel(model: read)), "Reading your devices… before, No bots yet after")
    }
}
