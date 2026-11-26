// The thread panel after a send, while the answer grows and when another thread opens: a lazy stack counts the rows it has not built with an estimated height, so rows added at the bottom of a
// long thread must not leave the view over a region with no row built.
import Conversation
import Foundation
import ProtocolHost
@testable import Screens
import SwiftUI
import XCTest

@MainActor
final class ThreadScrollTests: XCTestCase {
    /// A thread of ten questions with long answers, the last one still running; `tag` makes its names differ from another thread's.
    /// With `task`, an agent's line that stays open sits under the first question.
    private func longThread(_ s: inout ScrollFixture, tag: UInt8 = 0, task: Bool = false) -> MessageRef {
        let root = s.put(2, s.alice, ["text": "start the work \(tag)"], to: s.bot)
        s.put(3, s.bot, [:], re: root)
        for i in 0..<10 {
            let prompt = s.put(2, s.alice, ["text": "question \(i): please explain more about the thing", "thread": root.hex], to: s.bot)
            s.put(3, s.bot, [:], re: prompt)
            if task, i == 0 {
                s.put(1, s.bot, ["thread": root.hex, "say": "task", "task": ["title": "Agent(look)", "status": "in_progress", "task": true, "agent": "look at the tests"] as [String: Any]], re: prompt)
            }
            s.put(5, s.bot, ["thread": root.hex, "markdown": ScrollFixture.markdown(i)], re: prompt, name: Data(repeating: UInt8(0xA0 + i), count: 16))
        }
        let running = MessageRef(device: s.bot, name: Data(repeating: 0xEE &- tag, count: 16))
        s.put(4, s.bot, ["thread": root.hex, "markdown": ScrollFixture.markdown(99)], re: running)
        return root
    }

    private func panel(_ s: ScrollFixture, _ root: MessageRef) -> ThreadPanel {
        ThreadPanel(model: s.model, icons: [:], thread: s.model.channels[s.channel]!.threads[root.hex]!, close: {})
    }

    private func send(_ s: inout ScrollFixture, _ root: MessageRef, _ text: String, answer: UInt8) -> MessageRef {
        let prompt = s.put(2, s.alice, ["text": text, "thread": root.hex], to: s.bot)
        s.put(3, s.bot, [:], re: prompt)
        let running = MessageRef(device: s.bot, name: Data(repeating: answer, count: 16))
        s.put(4, s.bot, ["thread": root.hex, "markdown": "Starting on it. "], re: running)
        return running
    }

    /// Asserts that the visible area reaches the end of the document (within a point) and holds drawn rows.
    private func assertAtEnd(_ hosting: NSView, _ step: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let m = try XCTUnwrap(ScrollHost.measure(hosting), file: file, line: line)
        let note = "\(step): visible \(m.visible), document \(m.documentHeight), drawn \(m.drawn)"
        XCTAssertGreaterThan(m.drawn, 1000, "drawn rows, \(note)", file: file, line: line)
        XCTAssertEqual(m.visible.maxY, m.documentHeight, accuracy: 1, "the end, \(note)", file: file, line: line)
    }

    private func wheelUp(_ scroll: NSScrollView, turns: Int) throws {
        for _ in 0..<turns {
            let wheel = try XCTUnwrap(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 400, wheel2: 0, wheel3: 0))
            scroll.scrollWheel(with: try XCTUnwrap(NSEvent(cgEvent: wheel)))
            ScrollHost.spin(0.1)
        }
        ScrollHost.spin(0.5)
    }

    /// The visible area of the thread panel holds drawn rows at the end of the thread after a send, at 0.2 s and 1 s, after a second send and
    /// while the running answer grows.
    func testPanelShowsRowsAfterASend() throws {
        var s = ScrollFixture()
        let root = longThread(&s)
        let hosting = ScrollHost.host(panel(s, root))
        defer { hosting.window?.orderOut(nil) }
        ScrollHost.spin(1.0)
        try assertAtEnd(hosting, "before the send")

        var running = send(&s, root, "a new question after launch", answer: 0xEF)
        hosting.rootView = panel(s, root)
        ScrollHost.spin(0.2)
        try assertAtEnd(hosting, "0.2 s after the send")
        ScrollHost.spin(0.8)
        try assertAtEnd(hosting, "1 s after the send")

        running = send(&s, root, "and a second one", answer: 0xF0)
        hosting.rootView = panel(s, root)
        ScrollHost.spin(0.5)
        try assertAtEnd(hosting, "after the second send")
        for part in 1...3 {
            s.put(4, s.bot, ["thread": root.hex, "markdown": String(repeating: "More words arrive in the answer, with a [link](https://example.com). ", count: 20 * part)], re: running)
            hosting.rootView = panel(s, root)
            ScrollHost.spin(0.5)
            try assertAtEnd(hosting, "after part \(part)")
        }
    }

    /// An owner who scrolled up to read is not taken to the bottom by a send.
    func testPanelStaysWhereTheOwnerReadsAfterASend() throws {
        var s = ScrollFixture()
        let root = longThread(&s)
        let hosting = ScrollHost.host(panel(s, root))
        defer { hosting.window?.orderOut(nil) }
        ScrollHost.spin(1.0)
        let scroll = try XCTUnwrap(ScrollHost.scrollView(in: hosting))
        try wheelUp(scroll, turns: 10)
        let reading = scroll.documentVisibleRect.origin.y
        let before = try XCTUnwrap(ScrollHost.measure(hosting))
        XCTAssertLessThan(reading, before.documentHeight - before.visible.height - 1000, "the wheel moved the view up: \(before.visible), document \(before.documentHeight)")

        _ = send(&s, root, "a new question after launch", answer: 0xEF)
        hosting.rootView = panel(s, root)
        ScrollHost.spin(1.0)
        let after = try XCTUnwrap(ScrollHost.measure(hosting))
        let note = "visible \(after.visible), document \(after.documentHeight), drawn \(after.drawn), before the send y \(reading)"
        XCTAssertEqual(after.visible.origin.y, reading, accuracy: 20, "the view stays where the owner reads: \(note)")
        XCTAssertGreaterThan(after.drawn, 1000, note)
    }

    /// A thread opened after the owner scrolled up in another shows its end.
    func testAnotherThreadOpensAtItsEnd() throws {
        var s = ScrollFixture()
        let a = longThread(&s)
        let b = longThread(&s, tag: 1)
        let hosting = ScrollHost.host(panel(s, a))
        defer { hosting.window?.orderOut(nil) }
        ScrollHost.spin(1.0)
        try wheelUp(try XCTUnwrap(ScrollHost.scrollView(in: hosting)), turns: 10)
        let up = try XCTUnwrap(ScrollHost.measure(hosting))
        XCTAssertLessThan(up.visible.origin.y, up.documentHeight - up.visible.height - 1000, "the wheel moved the view up: \(up.visible), document \(up.documentHeight)")

        hosting.rootView = panel(s, b)
        ScrollHost.spin(1.0)
        try assertAtEnd(hosting, "the other thread")
    }

    /// The id a click on a task of the list gives the scroll position (C2 3.3) is the id of that line's row, early in a long thread. The click
    /// itself is not driven (a popover of an offscreen window takes no event here); the position's reaction to a later change of `scrolledID` was
    /// measured once with a delayed assignment (the view went from the end to the top of a 10,750-point thread).
    func testTheIdOfATasksLineNamesItsRowInTheLazyStack() throws {
        var s = ScrollFixture()
        let root = longThread(&s, task: true)
        let thread = s.model.channels[s.channel]!.threads[root.hex]!
        let open = try XCTUnwrap(thread.openLines.first)
        XCTAssertEqual(open.fields.title, "Agent(look)")
        let rows = ThreadRows.build(thread, isSystem: { _ in false })
        let index = try XCTUnwrap(rows.firstIndex { $0.id == ThreadRows.id(of: open) })
        guard case .line(let drawn) = rows[index].content else { return XCTFail("the row is the line's") }
        XCTAssertEqual(drawn.ref, open.ref)
        XCTAssertLessThan(index, 5, "early in the thread: the first question's line")
        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count, "one row each")
    }
}
