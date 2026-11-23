// The channel header's decisions (window redesign, unit 1d): the count the Sessions tab carries. Over the synthetic samples.
import Conversation
import Foundation
import ProtocolHost
@testable import Screens
import SwiftUI
import XCTest

final class ChannelHeaderTests: XCTestCase {
    func testTheSessionsTabCountsTheChannelsSessions() throws {
        let sample = Samples.model()
        let channel = try XCTUnwrap(sample.model.channels[sample.channel])
        XCTAssertEqual(ChannelView.sessionsCount(channel), 3)
    }

    func testAChannelWithoutSessionsCarriesNoCount() throws {
        var model = ReadingModel()
        model.take(view: .object([
            "do": .string("message"), "position": .number(1), "channel": .bytes(Samples.channel), "sender": .bytes(Samples.bob),
            "name": .bytes(Data(repeating: 1, count: 16)), "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(1_763_600_000_000),
            "kind": .number(1), "to": .null, "blobs": .array([]), "files": .array([]), "re": .null, "again": .bool(false),
            "text": .string(#"{"markdown":"Morning."}"#),
        ]))
        let channel = try XCTUnwrap(model.channels[Samples.channel])
        XCTAssertTrue(channel.sessions.isEmpty)
        XCTAssertNil(ChannelView.sessionsCount(channel))
    }

    /// The bot's chip is as wide as a short name and stops at the cap for a long one, which it cuts rather than lets run past its border.
    @MainActor
    func testTheBotChipHugsAShortNameAndCapsALongOne() throws {
        func width(_ name: String) throws -> CGFloat {
            let renderer = ImageRenderer(content: BotChip(name: name, icon: nil))
            return try XCTUnwrap(renderer.nsImage).size.width
        }
        let chrome: CGFloat = 5 + 20 + 6 + 10
        let short = try width("mini")
        XCTAssertLessThan(short, chrome + 60, "a short name is not set in an empty frame")
        let long = try width("Build and release automation bot on the Mac mini in the office")
        XCTAssertLessThanOrEqual(long, chrome + BotChip.nameMost + 1, "a long name stops at the cap")
        XCTAssertGreaterThan(long, chrome + BotChip.nameMost - 10, "a long name takes the whole cap")
    }
}
