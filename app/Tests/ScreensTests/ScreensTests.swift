// The main window over the synthetic conversation: the samples fold as the boards need them, and the window
// draws in both themes, offscreen, as the snapshot tool renders it.
import AppKit
import Conversation
import DesignSystem
@testable import Screens
import SwiftUI
import XCTest

final class ScreensTests: XCTestCase {
    func testTheSamplesHoldEverySessionStateTheBoardsDraw() {
        let sample = Samples.model()
        let channel = try! XCTUnwrap(sample.model.channels[sample.channel])
        XCTAssertEqual(Set(channel.sessions.map(\.state)), [.idle, .running, .waiting])
        XCTAssertEqual(channel.timeline.count, 4, "a message between people and three prompts")
        XCTAssertEqual(sample.model.profiles.count, 2)
        XCTAssertEqual(channel.threads[sample.thread]?.title, "The relay test fails on a restart. Find why and fix it.")
    }

    func testNamesFallBackToTheShortId() {
        XCTAssertEqual(Naming.short(Data([0xA1, 0x1C, 0xE0, 0x01, 0xFF])), "a11ce001")
        XCTAssertEqual(Naming.channel(Data([0x3F, 0x3F, 0x3F, 0x3F])), "#3f3f3f3f")
        XCTAssertEqual(Naming.sender(Samples.mini, in: Samples.model().model), "mini")
        XCTAssertEqual(Naming.initial("mini"), "M")
    }

    @MainActor
    func testTheWindowDrawsInBothThemes() throws {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let sample = Samples.model()
        var pictures: [Data] = []
        for name in [NSAppearance.Name.aqua, .darkAqua] {
            let view = NSHostingView(rootView: MainWindow(model: sample.model, channel: sample.channel, thread: sample.thread))
            view.appearance = NSAppearance(named: name)
            view.frame = NSRect(x: 0, y: 0, width: 1280, height: 800)
            view.layoutSubtreeIfNeeded()
            let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: rep)
            pictures.append(try XCTUnwrap(rep.representation(using: .png, properties: [:])))
        }
        XCTAssertNotEqual(pictures[0], pictures[1], "the two themes draw differently")
    }

    func testTheEmptyWindowNeedsNoChannel() {
        XCTAssertTrue(ReadingModel().channels.isEmpty)
        _ = MainWindow(model: ReadingModel()).body
    }

    func testTheSummarysLastTimeCountsTheAnswer() {
        let sample = Samples.model()
        let t = try! XCTUnwrap(sample.model.channels[sample.channel]?.threads[sample.thread])
        XCTAssertEqual(t.lastTime, t.lastReply, "the answer landed after every message of the thread")
    }

    func testTheWindowsLeastWidthFollowsTheColumns() {
        XCTAssertEqual(MainWindow.leastWidth(threadOpen: true), 942, "200 + 420 + 320 and two dividers")
        XCTAssertEqual(MainWindow.leastWidth(threadOpen: false), 621, "200 + 420 and one divider")
    }

    @MainActor
    func testTheSplitItemsHoldTheLimitsTheLeastWidthIsBuiltFrom() {
        let controller = ColumnsController(defaults: MemoryDefaults(), autosaveName: "ScreensTests.limits.\(UUID())")
        _ = controller.view
        let items = controller.splitViewItems
        XCTAssertEqual(items.map(\.minimumThickness), [200, 420, 320])
        XCTAssertEqual(items.map(\.canCollapse), [false, false, false], "the person collapses no column")
        XCTAssertEqual(items.map(\.maximumThickness), [360, NSSplitViewItem.unspecifiedDimension, 640])
        XCTAssertTrue(controller.splitView.autosaveName?.hasPrefix("ScreensTests.limits.") ?? false)
        XCTAssertEqual(controller.splitView.dividerThickness, Columns.divider, "the thin divider")
        XCTAssertEqual(items[1].minimumThickness + items[0].minimumThickness + controller.splitView.dividerThickness, MainWindow.leastWidth(threadOpen: false))
    }

    func testThePanelShowsOnlyAThreadTheChannelHolds() {
        let sample = Samples.model()
        let channel = sample.model.channels[sample.channel]
        XCTAssertNotNil(MainWindow.openThread(in: channel, key: sample.thread))
        XCTAssertNil(MainWindow.openThread(in: channel, key: nil))
        XCTAssertNil(MainWindow.openThread(in: channel, key: "no such thread"))
        XCTAssertNil(MainWindow.openThread(in: nil, key: sample.thread))
    }

    func testEachFirstLaunchMomentIsDoneOnce() {
        let defaults = MemoryDefaults()
        let first = FirstLaunch(defaults: defaults)
        XCTAssertTrue(first.sidebarPending)
        XCTAssertTrue(first.panelPending)
        first.sidebarDone()
        XCTAssertFalse(FirstLaunch(defaults: defaults).sidebarPending)
        XCTAssertTrue(FirstLaunch(defaults: defaults).panelPending, "the two moments are marked apart")
        first.panelDone()
        XCTAssertFalse(FirstLaunch(defaults: defaults).panelPending)
    }

    func testThePanelsDefaultDividerLeavesItsDefaultWidth() {
        XCTAssertEqual(Columns.panelDividerPosition(width: 1280, thickness: 1, sidebarWidth: 248), 899)
        XCTAssertEqual(Columns.panelDividerPosition(width: 1000, thickness: 1, sidebarWidth: 250), 671, "the conversation keeps 420 beside the sidebar")
    }

    // MARK: the split driven in an offscreen window

    /// The flags in memory: a defaults suite leaves a plist in the user's Preferences that the preferences daemon writes again after the test deletes it.
    private final class MemoryDefaults: UserDefaults {
        private var values: [String: Any] = [:]
        init() { super.init(suiteName: nil)! }
        override func set(_ value: Any?, forKey key: String) { values[key] = value }
        override func set(_ value: Bool, forKey key: String) { values[key] = value }
        override func bool(forKey key: String) -> Bool { values[key] as? Bool ?? false }
    }

    /// One window over a `ColumnsController` with its own autosave name and flags, as a launch of the app has.
    @MainActor
    private final class Launch {
        let controller: ColumnsController
        let window: NSWindow
        /// Updates the controller before the window lays it out, as SwiftUI does on a launch.
        init(name: String, defaults: UserDefaults, width: CGFloat, thread: Bool) {
            controller = ColumnsController(defaults: defaults, autosaveName: name)
            _ = controller.view
            controller.update(sidebar: AnyView(Color.red), conversation: AnyView(Color.green), panel: AnyView(Color.blue), threadOpen: thread)
            window = NSWindow(contentViewController: controller)
            window.styleMask = [.titled, .resizable]
            window.setContentSize(NSSize(width: width, height: 800))
            window.makeKeyAndOrderFront(nil)
            settle()
        }
        func settle() {
            RunLoop.main.run(until: Date().addingTimeInterval(0.3))
            window.contentView?.layoutSubtreeIfNeeded()
        }
        func show(thread: Bool) {
            controller.update(sidebar: AnyView(Color.red), conversation: AnyView(Color.green), panel: AnyView(Color.blue), threadOpen: thread)
            settle()
        }
        var widths: [Int] { controller.splitView.arrangedSubviews.map { Int($0.frame.width) } }
        /// A person's drag: the mouse goes down on the divider (the mouse-up is queued so the tracking loop ends), then it moves to `x`.
        func drag(divider: Int, to x: CGFloat) {
            let split = controller.splitView
            let frame = split.arrangedSubviews[divider].frame
            let point = split.convert(NSPoint(x: frame.maxX + split.dividerThickness / 2, y: 100), to: nil)
            func event(_ type: NSEvent.EventType) -> NSEvent {
                NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
            }
            NSApp.postEvent(event(.leftMouseUp), atStart: false)
            split.mouseDown(with: event(.leftMouseDown))
            split.setPosition(x, ofDividerAt: divider)
            settle()
        }
    }

    @MainActor
    private func withLaunches(_ test: String = #function, _ body: (_ name: String, _ defaults: UserDefaults) -> Void) {
        _ = NSApplication.shared
        let name = "ScreensTests.split.\(test.dropLast(2))"
        let defaults = MemoryDefaults()
        UserDefaults.standard.removeObject(forKey: "NSSplitView Subview Frames \(name)")
        defer {
            UserDefaults.standard.removeObject(forKey: "NSSplitView Subview Frames \(name)")
        }
        body(name, defaults)
    }

    @MainActor
    func testAFirstLaunchDrawsTheDefaultWidths() {
        withLaunches { name, defaults in
            let launch = Launch(name: name, defaults: defaults, width: 1400, thread: true)
            XCTAssertEqual(launch.widths[0], 248)
            XCTAssertEqual(launch.widths[2], 380)
        }
    }

    @MainActor
    func testTheFirstThreadKeepsASidebarTheWindowWasDraggedTo() {
        withLaunches { name, defaults in
            let launch = Launch(name: name, defaults: defaults, width: 1000, thread: false)
            launch.drag(divider: 0, to: 250)
            launch.show(thread: true)
            XCTAssertEqual(launch.widths[0], 250, "opening the first thread does not move the sidebar: the panel gives way")
            XCTAssertGreaterThanOrEqual(launch.widths[1], 420)
            XCTAssertGreaterThanOrEqual(launch.widths[2], 320)
        }
    }

    @MainActor
    func testAPanelCollapsedAtQuitComesBackAtItsWidth() {
        withLaunches { name, defaults in
            let first = Launch(name: name, defaults: defaults, width: 1400, thread: true)
            first.drag(divider: 1, to: first.controller.splitView.bounds.width - 600 - 1)
            XCTAssertEqual(first.widths[2], 600)
            first.show(thread: false)
            first.window.close()
            let second = Launch(name: name, defaults: defaults, width: 1400, thread: false)
            XCTAssertTrue(second.controller.splitViewItems[2].isCollapsed, "no thread open: the panel stays closed")
            second.show(thread: true)
            XCTAssertEqual(second.widths[2], 600)
        }
    }

    @MainActor
    func testAPanelSavedOpenStaysClosedWhenNoThreadIsOpen() {
        withLaunches { name, defaults in
            let first = Launch(name: name, defaults: defaults, width: 1400, thread: true)
            first.window.close()
            let second = Launch(name: name, defaults: defaults, width: 1400, thread: false)
            XCTAssertTrue(second.controller.splitViewItems[2].isCollapsed)
        }
    }

    @MainActor
    func testADraggedDividerIsNeverFirstLaunchedAgain() {
        withLaunches { name, defaults in
            let first = Launch(name: name, defaults: defaults, width: 1000, thread: false)
            first.drag(divider: 0, to: 330)
            first.show(thread: true) // no room: the panel's default does not land, and its moment stays pending
            first.drag(divider: 0, to: 200)
            first.drag(divider: 1, to: first.controller.splitView.bounds.width - 340 - 1)
            XCTAssertEqual(first.widths[2], 340)
            first.window.close()
            let second = Launch(name: name, defaults: defaults, width: 1000, thread: true)
            XCTAssertEqual(second.widths[2], 340, "the next launch keeps the width the person dragged")
        }
    }
}
