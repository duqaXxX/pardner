// Which pane has the focus (step F design FB, 3.3): the value the panes read and the pane a point falls in. The monitor, the first
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
}
