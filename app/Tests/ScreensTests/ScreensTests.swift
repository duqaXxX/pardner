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
        XCTAssertEqual(items.prefix(2).map(\.maximumThickness), [360, NSSplitViewItem.unspecifiedDimension])
        // The panel's most width is the room of the split as loaded, whose size before a window is the system's (it differs between macOS 15 and 26).
        XCTAssertGreaterThanOrEqual(items[2].maximumThickness, 320, "never under the panel's least")
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
        XCTAssertTrue(FirstLaunch(defaults: defaults).panelMovePending, "the move to the new default has a flag of its own")
        first.panelMoveDone()
        XCTAssertFalse(FirstLaunch(defaults: defaults).panelMovePending)
    }

    func testThePanelsDefaultDividerLeavesItsDefaultWidth() {
        XCTAssertEqual(Columns.panelDividerPosition(width: 1280, thickness: 1, sidebarWidth: 248), 719)
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

    /// A window the screen does not shrink: a CI runner's display can be narrower than the widths these tests set, and a window
    /// ordered in is constrained to its screen, which resizes every column in proportion.
    private final class UnconstrainedWindow: NSWindow {
        override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
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
            window = UnconstrainedWindow(contentViewController: controller)
            window.styleMask = [.titled, .resizable]
            window.setContentSize(NSSize(width: width, height: 800))
            window.makeKeyAndOrderFront(nil)
            settle()
            // Every width these tests assert assumes the window kept the one asked for: a failure here is the environment's.
            XCTAssertEqual(contentWidth, Int(width), "the test window was resized to \(contentWidth) by its environment")
        }
        /// The content's width as laid out: the widths these tests assert only mean something at the width they asked for.
        var contentWidth: Int { Int(window.contentView?.frame.width ?? 0) }
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

    /// `MainWindow` over the samples with a thread open, in a window whose size follows its SwiftUI content as the app's does, with its
    /// own autosave and first-launch state cleared before and after. `body` runs while the window is open; it is closed before the cleanup.
    @MainActor
    private func withRealWindow(_ body: (_ window: NSWindow, _ split: ColumnSplitView, _ settle: () -> Void) throws -> Void) throws {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let saved = ["NSSplitView Subview Frames MainWindow.columns", FirstLaunch.sidebarKey, FirstLaunch.panelKey, FirstLaunch.panelMoveKey]
        for key in saved { UserDefaults.standard.removeObject(forKey: key) }
        let sample = Samples.model()
        let window = UnconstrainedWindow(contentViewController: NSHostingController(rootView: MainWindow(model: sample.model, channel: sample.channel, thread: sample.thread)))
        defer {
            window.close()
            for key in saved { UserDefaults.standard.removeObject(forKey: key) }
        }
        window.styleMask = [.titled, .resizable]
        window.setContentSize(NSSize(width: 1400, height: 800))
        window.makeKeyAndOrderFront(nil)
        func settle() { RunLoop.main.run(until: Date().addingTimeInterval(0.4)); window.contentView?.layoutSubtreeIfNeeded() }
        settle()
        // Every width asserted here assumes the window kept the one asked for: a failure here is the environment's.
        XCTAssertEqual(window.contentView?.frame.width, 1400, "the test window was resized by its environment")
        func find(_ view: NSView) -> ColumnSplitView? { (view as? ColumnSplitView) ?? view.subviews.lazy.compactMap(find).first }
        try body(window, try XCTUnwrap(find(try XCTUnwrap(window.contentView))), settle)
    }

    /// The window cannot be made narrower than the columns' least width nor lower than the app's least height.
    @MainActor
    func testTheRealWindowKeepsTheColumnsLeastSize() throws {
        try withRealWindow { window, _, _ in
            XCTAssertGreaterThanOrEqual(window.contentMinSize.width, MainWindow.leastWidth(threadOpen: true))
            XCTAssertGreaterThanOrEqual(window.contentMinSize.height, MainWindow.leastHeight)
        }
    }

    /// A drag is the tracking loop `NSSplitView.mouseDown` runs on the queued drags and mouse-up.
    @MainActor
    func testTheRealWindowsPanelFollowsADragOfItsDivider() throws {
        try withRealWindow { window, split, settle in
        let frame = window.frame
        for (divider, dx) in [(0, CGFloat(40)), (1, CGFloat(-60))] {
            let widths = split.arrangedSubviews.map { $0.frame.width }
            let edge = split.arrangedSubviews[divider].frame.maxX
            let start = split.convert(NSPoint(x: edge + 0.5, y: 100), to: nil)
            func event(_ type: NSEvent.EventType, _ moved: CGFloat) -> NSEvent {
                NSEvent.mouseEvent(with: type, location: NSPoint(x: start.x + moved, y: start.y), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
            }
            for step in stride(from: CGFloat(10), through: abs(dx), by: 10) { NSApp.postEvent(event(.leftMouseDragged, dx < 0 ? -step : step), atStart: false) }
            NSApp.postEvent(event(.leftMouseUp, dx), atStart: false)
            split.mouseDown(with: event(.leftMouseDown, 0))
            settle()
            XCTAssertEqual(window.frame, frame, "dragging divider \(divider) leaves the window alone")
            XCTAssertEqual(split.arrangedSubviews[divider].frame.maxX, edge + dx, accuracy: 1, "divider \(divider) follows the drag")
            XCTAssertEqual(split.arrangedSubviews[2].frame.width, widths[2] + (divider == 1 ? -dx : 0), accuracy: 1)
        }
        }
    }

    @MainActor
    func testAFirstLaunchDrawsTheDefaultWidths() {
        withLaunches { name, defaults in
            let launch = Launch(name: name, defaults: defaults, width: 1400, thread: true)
            XCTAssertEqual(launch.widths[0], 248)
            XCTAssertEqual(launch.widths[2], 560)
            XCTAssertFalse(FirstLaunch(defaults: defaults).panelMovePending, "a new install has nothing to move")
        }
    }

    /// A launch of an install made before the panel opened at 560: both first-launch moments done, the move not made.
    private func olderInstall() -> MemoryDefaults {
        let defaults = MemoryDefaults()
        FirstLaunch(defaults: defaults).sidebarDone()
        FirstLaunch(defaults: defaults).panelDone()
        return defaults
    }

    /// The width the old default left in the split's autosave: a divider moved by code, as the first launch moved it, never by a mouse.
    @MainActor
    private func keepPanel(width: CGFloat, name: String) {
        let kept = Launch(name: name, defaults: olderInstall(), width: 1400, thread: true)
        kept.controller.splitView.setPosition(kept.controller.splitView.bounds.width - width - 1, ofDividerAt: 1)
        kept.settle()
        XCTAssertEqual(CGFloat(kept.widths[2]), width, accuracy: 1)
        kept.show(thread: false)
        kept.window.close()
    }

    @MainActor
    func testAPanelKeptAtTheOldDefaultOpensOnceAtTheNewOne() {
        withLaunches { name, _ in
            keepPanel(width: 380, name: name)
            let install = olderInstall()
            let second = Launch(name: name, defaults: install, width: 1400, thread: false)
            XCTAssertTrue(FirstLaunch(defaults: install).panelMovePending, "no panel open: nothing moved yet")
            second.show(thread: true)
            XCTAssertEqual(second.widths[2], 560, "a kept 380 opens at 560")
            XCTAssertFalse(FirstLaunch(defaults: install).panelMovePending)
            // The person brings it back to 380 by code (not by a drag): the move is made once.
            second.controller.splitView.setPosition(second.controller.splitView.bounds.width - 380 - 1, ofDividerAt: 1)
            second.settle()
            second.show(thread: false)
            second.window.close()
            let third = Launch(name: name, defaults: install, width: 1400, thread: false)
            third.show(thread: true)
            XCTAssertEqual(third.widths[2], 380, "the move is never made twice")
        }
    }

    /// A panel opened narrower than the old default (a narrow window can clamp it) is not a width the person chose: the move stays pending.
    @MainActor
    func testAPanelOpenedUnder380LeavesTheMovePendingUntilItIsAt380() {
        withLaunches { name, _ in
            keepPanel(width: 380, name: name)
            let install = olderInstall()
            let narrow = Launch(name: name, defaults: install, width: 960, thread: false)
            narrow.show(thread: true)
            XCTAssertGreaterThanOrEqual(narrow.widths[2], 320)
            XCTAssertLessThan(narrow.widths[2], 380, "the window cannot hold the kept width")
            XCTAssertTrue(FirstLaunch(defaults: install).panelMovePending, "a clamped panel is not a width the person chose")
            narrow.window.setContentSize(NSSize(width: 1400, height: 800))
            narrow.settle()
            XCTAssertTrue(FirstLaunch(defaults: install).panelMovePending, "and widening the window does not settle it")
            // The panel back at 380 (here by code), and the next layout: the move is made.
            narrow.controller.splitView.setPosition(narrow.controller.splitView.bounds.width - 380 - 1, ofDividerAt: 1)
            narrow.controller.applyFirstLaunch()
            narrow.settle()
            XCTAssertEqual(narrow.widths[2], 560)
            XCTAssertFalse(FirstLaunch(defaults: install).panelMovePending)
        }
    }

    @MainActor
    func testAPanelKeptAtADraggedWidthStaysWhenTheMoveIsMade() {
        withLaunches { name, _ in
            keepPanel(width: 400, name: name)
            let install = olderInstall()
            let second = Launch(name: name, defaults: install, width: 1400, thread: false)
            second.show(thread: true)
            XCTAssertEqual(second.widths[2], 400, "a width the person chose stays")
            XCTAssertFalse(FirstLaunch(defaults: install).panelMovePending, "and the move is not tried again")
        }
    }

    @MainActor
    func testAPanelResetByItsDividerGetsTheNewDefault() {
        withLaunches { name, defaults in
            let launch = Launch(name: name, defaults: defaults, width: 1400, thread: true)
            launch.drag(divider: 1, to: launch.controller.splitView.bounds.width - 700 - 1)
            XCTAssertEqual(launch.widths[2], 700)
            (launch.controller.splitView as? ColumnSplitView)?.resetDivider(1)
            launch.settle()
            XCTAssertEqual(launch.widths[2], 560)
        }
    }

    /// The panel has no most width of its own: it grows until the conversation is at its least.
    @MainActor
    func testThePanelGrowsUntilTheConversationIsAtItsLeast() {
        withLaunches { name, defaults in
            let launch = Launch(name: name, defaults: defaults, width: 1900, thread: true)
            launch.drag(divider: 1, to: launch.controller.splitView.bounds.width - 900 - 1)
            XCTAssertEqual(launch.widths[2], 900, "the panel is as wide as it was dragged")
            launch.drag(divider: 1, to: 300)
            XCTAssertEqual(launch.widths, [248, 420, 1230], "the conversation keeps its least width, the sidebar its own, the panel takes the rest")
            XCTAssertEqual(launch.controller.splitViewItems[2].maximumThickness, 1230, "the most width is the room beside the sidebar and the conversation's least")
        }
    }

    /// A window narrowed while the panel is at its widest takes the width from the panel: the sidebar keeps the width the person set.
    @MainActor
    func testANarrowedWindowTakesItsWidthFromAPanelAtItsWidest() {
        withLaunches { name, defaults in
            let launch = Launch(name: name, defaults: defaults, width: 1900, thread: true)
            launch.drag(divider: 0, to: 300)
            launch.drag(divider: 1, to: 300)
            XCTAssertEqual(launch.widths, [300, 420, 1178])
            launch.window.setContentSize(NSSize(width: 1700, height: 800))
            launch.settle()
            XCTAssertEqual(launch.contentWidth, 1700)
            XCTAssertEqual(launch.widths, [300, 420, 978])
        }
    }

    /// A panel left wider than a narrower window can hold comes back within that window, in the same launch and in the next one.
    @MainActor
    func testAPanelWiderThanTheWindowComesBackWithinIt() {
        withLaunches { name, defaults in
            let first = Launch(name: name, defaults: defaults, width: 1900, thread: true)
            first.drag(divider: 1, to: 300)
            XCTAssertEqual(first.widths[2], 1230)
            first.show(thread: false)
            first.window.setContentSize(NSSize(width: 1000, height: 800))
            first.settle()
            first.show(thread: true)
            XCTAssertEqual(first.contentWidth, 1000, "the window keeps its width")
            XCTAssertEqual(first.widths, [248, 420, 330])
            first.show(thread: false)
            first.window.close()
            let second = Launch(name: name, defaults: defaults, width: 1000, thread: false)
            second.show(thread: true)
            XCTAssertEqual(second.contentWidth, 1000, "the window keeps its width")
            XCTAssertEqual(second.widths, [248, 420, 330])
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
            // The app always launches with no thread open (`LiveMainWindow` passes none), then the person opens one.
            let second = Launch(name: name, defaults: defaults, width: 1000, thread: false)
            second.show(thread: true)
            XCTAssertEqual(second.widths[2], 340, "the next launch keeps the width the person dragged")
            XCTAssertFalse(FirstLaunch(defaults: defaults).panelMovePending, "a drag is the person's width: the move leaves it alone")
        }
    }

    // MARK: the pane that has the focus (step F design FB, 3.3)

    /// A click of the left button at `point` (the window's coordinates), sent the way the app is: through `NSApp.sendEvent`, which runs the local
    /// monitors; `window.sendEvent` never reaches one (measured, 2026-11-25).
    @MainActor
    private func click(_ window: NSWindow, at point: NSPoint) {
        func event(_ type: NSEvent.EventType) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        }
        NSApp.sendEvent(event(.leftMouseDown))
        NSApp.sendEvent(event(.leftMouseUp))
    }

    /// The middle of column `index`, in its window's coordinates.
    @MainActor
    private func middle(of launch: Launch, _ index: Int) -> NSPoint {
        let split = launch.controller.splitView
        let frame = split.arrangedSubviews[index].frame
        return split.convert(NSPoint(x: frame.midX, y: frame.midY), to: nil)
    }

    /// The view of column `index`'s hosting controller, which the split wraps in a view of its own.
    @MainActor
    private func hostView(of launch: Launch, _ index: Int) -> NSView { launch.controller.splitView.arrangedSubviews[index].subviews[0] }

    @MainActor
    func testThePaneFocusFollowsAClickInAPane() {
        withLaunches { name, defaults in
            let launch = Launch(name: name, defaults: defaults, width: 1400, thread: true)
            defer { launch.window.close() }
            let focus = launch.controller.focus
            XCTAssertNil(focus.pane, "nothing acted in yet")
            click(launch.window, at: middle(of: launch, 2))
            XCTAssertEqual(focus.pane, .panel)
            click(launch.window, at: middle(of: launch, 1))
            XCTAssertEqual(focus.pane, .conversation)
            click(launch.window, at: middle(of: launch, 0))
            XCTAssertEqual(focus.pane, .sidebar)
        }
    }

    @MainActor
    func testAClosedPanelHasNoFrameForAClickToFallIn() {
        withLaunches { name, defaults in
            let launch = Launch(name: name, defaults: defaults, width: 1400, thread: false)
            defer { launch.window.close() }
            let frames = launch.controller.paneFrames()
            XCTAssertEqual(frames.count, 3)
            XCTAssertEqual(frames[2], .zero)
            click(launch.window, at: NSPoint(x: 1390, y: 400))
            XCTAssertEqual(launch.controller.focus.pane, .conversation, "the conversation fills the room the panel left")
        }
    }

    @MainActor
    func testThePaneFocusIgnoresADividerAnotherWindowAndARightClick() {
        withLaunches { name, defaults in
            let launch = Launch(name: name, defaults: defaults, width: 1400, thread: true)
            let other = UnconstrainedWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 800), styleMask: [.titled], backing: .buffered, defer: false)
            other.isReleasedWhenClosed = false
            other.orderFront(nil)
            defer { other.close(); launch.window.close() }
            let focus = launch.controller.focus
            click(launch.window, at: middle(of: launch, 1))
            // A click in another window of the app, at a point that is in the panel of this one.
            click(other, at: middle(of: launch, 2))
            XCTAssertEqual(focus.pane, .conversation, "a click in another window is not read")
            let split = launch.controller.splitView
            let divider = split.convert(NSPoint(x: split.arrangedSubviews[1].frame.maxX + split.dividerThickness / 2, y: 100), to: nil)
            XCTAssertNil(PaneFocus.pane(at: divider, in: launch.controller.paneFrames()), "the divider is in no pane")
            let right = NSEvent.mouseEvent(with: .rightMouseDown, location: middle(of: launch, 2), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: launch.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
            NSApp.sendEvent(right)
            NSApp.sendEvent(NSEvent.mouseEvent(with: .rightMouseUp, location: middle(of: launch, 2), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: launch.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!)
            XCTAssertEqual(focus.pane, .conversation, "a right-click does not move the focus")
        }
    }

    @MainActor
    func testThePaneFocusFollowsTheFirstResponder() {
        withLaunches { name, defaults in
            let launch = Launch(name: name, defaults: defaults, width: 1400, thread: true)
            defer { launch.window.close() }
            let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 100, height: 20))
            hostView(of: launch, 2).addSubview(field)
            let side = NSTextField(frame: NSRect(x: 0, y: 0, width: 100, height: 20))
            hostView(of: launch, 0).addSubview(side)
            XCTAssertTrue(launch.window.makeFirstResponder(field))
            XCTAssertEqual(launch.controller.focus.pane, .panel, "typing in the thread's composer gives the thread the focus")
            XCTAssertTrue(launch.window.makeFirstResponder(side))
            XCTAssertEqual(launch.controller.focus.pane, .sidebar)
            // A first responder in no pane (the window, once a text view is removed) leaves the pane as it was.
            XCTAssertTrue(launch.window.makeFirstResponder(nil))
            XCTAssertEqual(launch.controller.focus.pane, .sidebar)
        }
    }

    @MainActor
    func testThePaneFocusReadsTheCaretThatWasThereWhenTheWindowAppeared() {
        withLaunches { name, defaults in
            let launch = Launch(name: name, defaults: defaults, width: 1400, thread: true)
            defer { launch.window.close() }
            let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 100, height: 20))
            hostView(of: launch, 1).addSubview(field)
            // Out of the screen the controller observes nothing: the caret moves with no one looking.
            launch.window.orderOut(nil)
            launch.settle()
            XCTAssertTrue(launch.window.makeFirstResponder(field))
            XCTAssertNil(launch.controller.focus.pane, "not observed while the window is out")
            launch.window.orderFront(nil)
            launch.settle()
            XCTAssertEqual(launch.controller.focus.pane, .conversation, "the first read of the observation takes the caret that is already there")
        }
    }

    @MainActor
    func testThePaneFocusKnowsWhenTheWindowStopsBeingKeyAndStartsAgain() {
        withLaunches { name, defaults in
            let launch = Launch(name: name, defaults: defaults, width: 1400, thread: true)
            defer { launch.window.close() }
            let focus = launch.controller.focus
            // A test process is not active, so the window cannot be made key: the object is set directly, and the notifications drive it.
            focus.key = true
            NotificationCenter.default.post(name: NSWindow.didResignKeyNotification, object: launch.window)
            XCTAssertFalse(focus.key)
            NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: launch.window)
            XCTAssertTrue(focus.key)
            NotificationCenter.default.post(name: NSWindow.didResignKeyNotification, object: NSWindow())
            XCTAssertTrue(focus.key, "another window's resignation is not this window's")
        }
    }

    /// The monitor, the first responder's observation and the key notifications are installed in `viewDidAppear` and removed in `viewWillDisappear`.
    @MainActor
    func testThePaneFocusObservesOnlyWhileTheWindowIsOnScreen() {
        withLaunches { name, defaults in
            let launch = Launch(name: name, defaults: defaults, width: 1400, thread: true)
            defer { launch.window.close() }
            let focus = launch.controller.focus
            launch.window.orderOut(nil)
            launch.settle()
            focus.key = true
            NotificationCenter.default.post(name: NSWindow.didResignKeyNotification, object: launch.window)
            XCTAssertTrue(focus.key, "the key notifications are not observed while the window is out")
            click(launch.window, at: middle(of: launch, 2))
            XCTAssertNil(focus.pane, "the mouse monitor is out too")
            launch.window.orderFront(nil)
            launch.settle()
            click(launch.window, at: middle(of: launch, 2))
            XCTAssertEqual(focus.pane, .panel, "and back when it appears again, once, not twice")
            launch.window.close()
            click(launch.window, at: middle(of: launch, 1))
            XCTAssertEqual(focus.pane, .panel, "a closed window observes nothing")
        }
    }

    @MainActor
    func testThePaneFocusReachesEveryHostThroughUpdate() {
        final class Seen { var focus: [PaneFocus?] = [nil, nil, nil] }
        struct Reader: View {
            let index: Int
            let seen: Seen
            @Environment(PaneFocus.self) private var focus: PaneFocus?
            var body: some View {
                seen.focus[index] = focus
                return Color.clear
            }
        }
        withLaunches { name, defaults in
            let seen = Seen()
            let controller = ColumnsController(defaults: defaults, autosaveName: name)
            _ = controller.view
            controller.update(sidebar: AnyView(Reader(index: 0, seen: seen)), conversation: AnyView(Reader(index: 1, seen: seen)), panel: AnyView(Reader(index: 2, seen: seen)), threadOpen: true)
            let window = UnconstrainedWindow(contentViewController: controller)
            window.setContentSize(NSSize(width: 1400, height: 800))
            window.orderFront(nil)
            defer { window.close() }
            RunLoop.main.run(until: Date().addingTimeInterval(0.4))
            XCTAssertTrue(seen.focus.allSatisfy { $0 === controller.focus }, "each pane reads the controller's own focus")
        }
    }
    @MainActor
    func testThePaneFocusGoesToTheConversationWhenThePanelCloses() {
        withLaunches { name, defaults in
            let launch = Launch(name: name, defaults: defaults, width: 1400, thread: true)
            defer { launch.window.close() }
            let focus = launch.controller.focus
            click(launch.window, at: middle(of: launch, 2))
            XCTAssertEqual(focus.pane, .panel)
            launch.show(thread: false)
            XCTAssertEqual(focus.pane, .conversation, "the pane that had the focus is gone: the channel takes it")
            launch.show(thread: true)
            XCTAssertEqual(focus.pane, .conversation, "opening a thread asks nothing of the focus")
            click(launch.window, at: middle(of: launch, 0))
            launch.show(thread: false)
            XCTAssertEqual(focus.pane, .sidebar, "only a focus on the panel moves")
        }
    }

    @MainActor
    func testTypingGivesTheFocusToThePaneOfTheFirstResponder() {
        withLaunches { name, defaults in
            let launch = Launch(name: name, defaults: defaults, width: 1400, thread: true)
            defer { launch.window.close() }
            let focus = launch.controller.focus
            let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 100, height: 20))
            hostView(of: launch, 2).addSubview(field)
            XCTAssertTrue(launch.window.makeFirstResponder(field))
            // A click in the channel leaves the caret where it was, in the thread's composer.
            click(launch.window, at: middle(of: launch, 1))
            XCTAssertEqual(focus.pane, .conversation)
            let key = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: launch.window.windowNumber,
                                       context: nil, characters: "a", charactersIgnoringModifiers: "a", isARepeat: false, keyCode: 0)!
            NSApp.sendEvent(key)
            XCTAssertEqual(focus.pane, .panel, "the keys go to the thread's composer: the thread is where the person acts")
        }
    }

    @MainActor
    func testAKeyInAnotherWindowIsNotRead() {
        withLaunches { name, defaults in
            let launch = Launch(name: name, defaults: defaults, width: 1400, thread: true)
            let other = UnconstrainedWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
            other.isReleasedWhenClosed = false
            other.orderFront(nil)
            defer { other.close(); launch.window.close() }
            let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 100, height: 20))
            hostView(of: launch, 2).addSubview(field)
            XCTAssertTrue(launch.window.makeFirstResponder(field))
            click(launch.window, at: middle(of: launch, 1))
            let key = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: other.windowNumber,
                                       context: nil, characters: "a", charactersIgnoringModifiers: "a", isARepeat: false, keyCode: 0)!
            NSApp.sendEvent(key)
            XCTAssertEqual(launch.controller.focus.pane, .conversation)
        }
    }
}
