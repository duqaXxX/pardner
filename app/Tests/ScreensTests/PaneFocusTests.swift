// Which pane has the focus and the scrollbars that follow it (step F design FB, 3.3): the value the panes read, the pane a point
// falls in, and the scroll view that shows its indicator only while its pane is the one the person acted in. The monitor, the first
// responder and the key notifications are driven in a window in `ScreensTests`.
import AppKit
@testable import Screens
import SwiftUI
import XCTest

@MainActor
final class PaneFocusTests: XCTestCase {
    func testAPointFallsInTheColumnThatHoldsIt() {
        let frames = [CGRect(x: 0, y: 0, width: 248, height: 800), CGRect(x: 249, y: 0, width: 600, height: 800), CGRect(x: 850, y: 0, width: 560, height: 800)]
        XCTAssertEqual(PaneFocus.pane(at: CGPoint(x: 10, y: 10), in: frames), .sidebar)
        XCTAssertEqual(PaneFocus.pane(at: CGPoint(x: 500, y: 400), in: frames), .conversation)
        XCTAssertEqual(PaneFocus.pane(at: CGPoint(x: 1000, y: 799), in: frames), .panel)
        XCTAssertNil(PaneFocus.pane(at: CGPoint(x: 248.5, y: 400), in: frames), "a divider is no pane")
        XCTAssertNil(PaneFocus.pane(at: CGPoint(x: 1500, y: 400), in: frames))
    }

    func testAClosedPanelHoldsNoPoint() {
        let frames = [CGRect(x: 0, y: 0, width: 248, height: 800), CGRect(x: 249, y: 0, width: 600, height: 800), CGRect.zero]
        XCTAssertNil(PaneFocus.pane(at: .zero, in: [.zero, .zero, .zero]), "an empty frame holds nothing, not even its origin")
        XCTAssertEqual(PaneFocus.pane(at: CGPoint(x: 300, y: 10), in: frames), .conversation)
    }

    func testAPaneActedInKeepsTheFocusUntilAnotherOneIsActedIn() {
        let focus = PaneFocus()
        focus.key = true
        XCTAssertFalse(focus.focused(.conversation), "nothing acted in yet")
        focus.acted(in: .conversation)
        XCTAssertTrue(focus.focused(.conversation))
        XCTAssertFalse(focus.focused(.panel))
        focus.acted(in: .panel)
        XCTAssertTrue(focus.focused(.panel))
        XCTAssertFalse(focus.focused(.conversation))
        focus.acted(in: .sidebar)
        XCTAssertFalse(focus.focused(.conversation) || focus.focused(.panel), "the sidebar takes the focus away from both")
    }

    func testAnActInNoPaneLeavesThePaneAlone() {
        let focus = PaneFocus()
        focus.key = true
        focus.acted(in: .panel)
        focus.acted(in: nil)
        XCTAssertTrue(focus.focused(.panel), "a click on a divider, or a first responder in no pane, changes nothing")
    }

    func testNoPaneIsFocusedWhileTheWindowIsNotKey() {
        let focus = PaneFocus()
        focus.acted(in: .conversation)
        XCTAssertFalse(focus.focused(.conversation), "the window is not key")
        focus.key = true
        XCTAssertTrue(focus.focused(.conversation), "key again: the pane last acted in has its bar back with no click")
        focus.key = false
        XCTAssertFalse(focus.focused(.conversation))
        focus.key = true
        XCTAssertTrue(focus.focused(.conversation), "the pane was kept while the window was not key")
    }

    func testTheMarginKeepsTheScrollersWidthOnlyWhileALegacyBarIsHiddenOverContentThatOverflows() {
        let width = NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy)
        XCTAssertGreaterThan(width, 0)
        XCTAssertEqual(FocusedScrollbar.margin(shown: false, legacy: true, overflows: true), width)
        XCTAssertEqual(FocusedScrollbar.margin(shown: false, legacy: true, overflows: false), 0, "content that fits has no bar to leave room for")
        XCTAssertEqual(FocusedScrollbar.margin(shown: true, legacy: true, overflows: true), 0, "the bar takes its own room")
        XCTAssertEqual(FocusedScrollbar.margin(shown: false, legacy: false, overflows: true), 0, "an overlay bar takes none")
        XCTAssertEqual(FocusedScrollbar.margin(shown: true, legacy: false, overflows: false), 0)
    }

    // MARK: the scroll view

    private struct Tall: View {
        let pane: PaneFocus.Pane
        var body: some View {
            ScrollView { VStack { ForEach(0..<200, id: \.self) { Text("row \($0)") } }.frame(maxWidth: .infinity) }.focusedScrollbar(pane)
        }
    }

    private func hosted(_ pane: PaneFocus.Pane, focus: PaneFocus?) -> (NSHostingView<AnyView>, NSWindow) {
        _ = NSApplication.shared
        let root = AnyView(Group { if let focus { Tall(pane: pane).environment(focus) } else { Tall(pane: pane) } })
        let hosting = NSHostingView(rootView: root)
        let window = NSWindow(contentRect: NSRect(x: -3000, y: -3000, width: 300, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.orderFront(nil)
        return (hosting, window)
    }

    /// Runs the loop until `condition` holds or two seconds pass.
    private func until(_ condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(2)
        while !condition(), Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    }

    private func bar(_ hosting: NSView) -> Bool? {
        hosting.layoutSubtreeIfNeeded()
        return ScrollHost.scrollView(in: hosting)?.hasVerticalScroller
    }

    func testAScrollViewShowsItsBarWhileItsPaneHasTheFocus() {
        let focus = PaneFocus()
        let (hosting, window) = hosted(.panel, focus: focus)
        defer { window.close() }
        until { bar(hosting) == false }
        XCTAssertEqual(bar(hosting), false, "no pane has been acted in")
        focus.key = true
        focus.acted(in: .panel)
        until { bar(hosting) == true }
        XCTAssertEqual(bar(hosting), true)
        focus.acted(in: .conversation)
        until { bar(hosting) == false }
        XCTAssertEqual(bar(hosting), false, "another pane has the focus")
        focus.acted(in: .panel)
        focus.key = false
        until { bar(hosting) == false }
        XCTAssertEqual(bar(hosting), false, "the window is not key")
    }

    /// A scroll view of `rows` rows in the legacy style, whatever the system's: the width its content is laid out at.
    private final class Width { var value: CGFloat = 0 }

    private func contentWidth(rows: Int, focus: PaneFocus) -> CGFloat {
        _ = NSApplication.shared
        let width = Width()
        let view = ScrollView {
            VStack { ForEach(0..<rows, id: \.self) { Text("row \($0)") } }.frame(maxWidth: .infinity)
                .background(GeometryReader { g in Color.clear.onAppear { width.value = g.size.width }.onChange(of: g.size.width) { _, new in width.value = new } })
        }
        .focusedScrollbar(.panel, legacy: true)
        .environment(focus)
        let hosting = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: NSRect(x: -3000, y: -3000, width: 300, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.orderFront(nil)
        defer { window.close() }
        until { width.value > 0 }
        // The overflow is read once the scroll view has laid out: let the margin settle.
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        hosting.layoutSubtreeIfNeeded()
        return width.value
    }

    func testALegacyBarsMarginIsKeptOnlyOverContentThatOverflows() {
        let side = NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy)
        let unfocused = PaneFocus()
        let focused = PaneFocus()
        focused.key = true
        focused.acted(in: .panel)
        let full = contentWidth(rows: 3, focus: focused)
        XCTAssertGreaterThan(full, 200)
        XCTAssertEqual(contentWidth(rows: 3, focus: unfocused), full, accuracy: 0.5, "three rows fit: no bar, no margin")
        // The tall one takes the margin only while unfocused (a test process draws overlay bars, which take no room of their own).
        XCTAssertEqual(contentWidth(rows: 200, focus: unfocused), full - side, accuracy: 0.5, "two hundred rows overflow: the margin keeps the bar's room")
        XCTAssertEqual(contentWidth(rows: 200, focus: focused), full - (NSScroller.preferredScrollerStyle == .legacy ? side : 0), accuracy: 0.5, "and a shown bar is the system's own")
    }

    func testAScrollViewWithNoFocusObjectKeepsTheSystemsBar() {
        let (hosting, window) = hosted(.panel, focus: nil)
        defer { window.close() }
        until { bar(hosting) == true }
        XCTAssertEqual(bar(hosting), true, "a view outside the main window (a preview, a test) has no pane to follow")
    }

    // MARK: a table's sideways bar

    private struct Wide: View {
        let hovering: Bool
        var body: some View {
            ScrollView(.horizontal) { Color.clear.frame(width: 2000, height: 40) }.hoverScrollbar(hovering: hovering, legacy: true)
        }
    }

    private func wideBar(hovering: Bool) -> Bool? {
        _ = NSApplication.shared
        let hosting = NSHostingView(rootView: Wide(hovering: hovering))
        let window = NSWindow(contentRect: NSRect(x: -3000, y: -3000, width: 300, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.orderFront(nil)
        defer { window.close() }
        until { hosting.layoutSubtreeIfNeeded(); return ScrollHost.scrollView(in: hosting) != nil }
        let expected = hovering
        until { hosting.layoutSubtreeIfNeeded(); return ScrollHost.scrollView(in: hosting)?.hasHorizontalScroller == expected }
        return ScrollHost.scrollView(in: hosting)?.hasHorizontalScroller
    }

    func testATablesSidewaysBarShowsWhileThePointerIsOverIt() {
        XCTAssertEqual(wideBar(hovering: true), true)
        XCTAssertEqual(wideBar(hovering: false), false, "the pointer is elsewhere: no bar")
    }

    /// The height a wide scroll view takes with `width` of content, the modifier assuming the legacy style whatever the process's. The overflow is
    /// read once the scroll view has laid out, so the height is polled until it is `expecting`, or the deadline passes; nil takes the first layout.
    private func wideHeight(hovering: Bool, content width: CGFloat, expecting: CGFloat? = nil) -> CGFloat {
        _ = NSApplication.shared
        let view = ScrollView(.horizontal) { Color.clear.frame(width: width, height: 40) }.hoverScrollbar(hovering: hovering, legacy: true).frame(width: 300)
        let hosting = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: NSRect(x: -3000, y: -3000, width: 300, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.orderFront(nil)
        defer { window.close() }
        hosting.layoutSubtreeIfNeeded()
        if let expecting { until { hosting.layoutSubtreeIfNeeded(); return abs(hosting.fittingSize.height - expecting) < 0.5 } }
        return hosting.fittingSize.height
    }

    /// Whether this process draws legacy scrollers: it does on a Mac with a mouse, and the tests run there too.
    private var processIsLegacy: Bool { NSScroller.preferredScrollerStyle == .legacy }

    func testATablesBarKeepsItsHeightAsAMarginOnlyWhileItIsHiddenOverATableThatOverflows() {
        // The child of the test below runs this one and sets the variable: a child that did not come up legacy fails here, not green.
        if ProcessInfo.processInfo.environment["PARDNER_EXPECT_LEGACY"] != nil { XCTAssertTrue(processIsLegacy, "`-AppleShowScrollBars Always` did not make the process legacy") }
        let side = NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy)
        let shown = wideHeight(hovering: true, content: 2000)
        // An overlay bar takes no room of its own, so the margin is the whole difference; a legacy bar takes `side` when shown, and the margin the same.
        let hidden = shown + (processIsLegacy ? 0 : side)
        XCTAssertEqual(wideHeight(hovering: false, content: 2000, expecting: hidden), hidden, accuracy: 0.5, "the bar's room stays under the table, so that the rows below do not move")
        let fits = wideHeight(hovering: true, content: 100)
        XCTAssertEqual(wideHeight(hovering: false, content: 100, expecting: fits), fits, accuracy: 0.5, "a table that fits has no bar to leave room for")
    }

    /// A process cannot be put in the legacy style, so the test above runs again in a child process started with `-AppleShowScrollBars Always`,
    /// where a shown bar takes its own room and the margin has to be the same (measured 2026-11-27: 17 points each, 82 with the table's rows).
    func testTheMarginMatchesALegacyBarsRoom() throws {
        try XCTSkipIf(processIsLegacy, "this process is legacy already: the test above ran in it")
        let name = "ScreensTests.PaneFocusTests/testATablesBarKeepsItsHeightAsAMarginOnlyWhileItIsHiddenOverATableThatOverflows"
        let runner = try XCTUnwrap(Bundle.main.executableURL, "the test runner's own path")
        try XCTSkipUnless(runner.lastPathComponent == "xctest", "the child is started with `xctest`; this runner is \(runner.lastPathComponent)")
        let child = Process()
        child.executableURL = runner
        child.arguments = ["-AppleShowScrollBars", "Always", "-XCTest", name, Bundle(for: Self.self).bundlePath]
        child.environment = ProcessInfo.processInfo.environment.merging(["PARDNER_EXPECT_LEGACY": "1"]) { $1 }
        let output = Pipe()
        child.standardOutput = output
        child.standardError = output
        try child.run()
        let watchdog = DispatchWorkItem { if child.isRunning { child.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 120, execute: watchdog)
        let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        child.waitUntilExit()
        watchdog.cancel()
        XCTAssertEqual(child.terminationStatus, 0, "the legacy child failed:\n\(text.split(separator: "\n").filter { $0.contains("error") }.joined(separator: "\n"))")
        XCTAssertTrue(text.contains("Executed 1 test"), "the legacy child ran the test:\n\(text)")
    }
}
