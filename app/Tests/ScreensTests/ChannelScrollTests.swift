// The channel's conversation after a message is added: the same lazy stack as the thread panel, so the same check.
import Conversation
import Foundation
import ProtocolHost
@testable import Screens
import SwiftUI
import XCTest

@MainActor
final class ChannelScrollTests: XCTestCase {
    private struct Host: View {
        let model: ReadingModel
        let channel: Data
        @State private var tab = MainWindow.Tab.conversation
        @State private var thread: String?
        var body: some View { ChannelView(model: model, icons: [:], channel: model.channels[channel]!, tab: $tab, thread: $thread) }
    }

    /// The visible area of a long conversation holds drawn content right after a message is added, and again a second later.
    func testConversationShowsRowsAfterAMessage() throws {
        var s = ScrollFixture()
        for i in 0..<80 {
            let prompt = s.put(2, s.alice, ["text": i % 4 == 0 ? ScrollFixture.markdown(i) : "question \(i): please explain more about the thing"], to: s.bot)
            s.put(3, s.bot, [:], re: prompt)
            s.put(5, s.bot, ["markdown": ScrollFixture.markdown(i)], re: prompt, name: Data(repeating: UInt8(i), count: 16))
        }
        let hosting = ScrollHost.host(Host(model: s.model, channel: s.channel))
        defer { hosting.window?.orderOut(nil) }
        ScrollHost.spin(1.0)
        let before = try XCTUnwrap(ScrollHost.measure(hosting))
        XCTAssertGreaterThan(before.drawn, 1000, "the conversation draws its rows before the message")

        let prompt = s.put(2, s.alice, ["text": ScrollFixture.markdown(99)], to: s.bot)
        s.put(3, s.bot, [:], re: prompt)
        s.put(5, s.bot, ["markdown": ScrollFixture.markdown(99)], re: prompt, name: Data(repeating: 0xEF, count: 16))
        hosting.rootView = Host(model: s.model, channel: s.channel)
        for (label, wait) in [("0.2 s", 0.2), ("1 s", 0.8)] {
            ScrollHost.spin(wait)
            let after = try XCTUnwrap(ScrollHost.measure(hosting))
            XCTAssertGreaterThan(after.drawn, 1000, "the visible area holds drawn rows \(label) after the message: visible \(after.visible), document \(after.documentHeight), drawn \(after.drawn)")
        }
    }
}
