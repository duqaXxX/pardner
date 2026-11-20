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
}
