// The message block's decisions (window redesign, unit 1a): the summary's words, the mention in a prompt and the mark's shape.
// Over the synthetic samples.
import AppKit
import Conversation
import DesignSystem
import Foundation
import ProtocolHost
@testable import Screens
import SwiftUI
import XCTest

final class MessageBlockTests: XCTestCase {
    func testTheSummaryCountsRepliesInWords() {
        XCTAssertEqual(Naming.replies(0), "0 replies")
        XCTAssertEqual(Naming.replies(1), "1 reply")
        XCTAssertEqual(Naming.replies(2), "2 replies")
    }

    func testOnlyARunningOrWaitingSessionWritesAStateWord() {
        XCTAssertNil(SessionState.idle.pill)
        XCTAssertEqual(SessionState.running.pill, "Running")
        XCTAssertEqual(SessionState.waiting.pill, "Waiting for you")
    }

    func testTheSamplesSummariesCarryTheirStateWords() throws {
        let sample = Samples.model()
        let channel = try XCTUnwrap(sample.model.channels[sample.channel])
        XCTAssertNil(try XCTUnwrap(channel.threads[sample.thread]).state.pill, "the first session is idle")
        XCTAssertEqual(try XCTUnwrap(channel.threads[sample.queuedThread]).state.pill, "Waiting for you")
        XCTAssertEqual(channel.sessions.compactMap(\.state.pill).sorted(), ["Running", "Waiting for you"])
    }

    func testTheLastReplyWordsNameTheTime() throws {
        let sample = Samples.model()
        let thread = try XCTUnwrap(sample.model.channels[sample.channel]?.threads[sample.thread])
        // The sample's newest reply of this thread is the bot's answer, 9.2 minutes after the sample's start.
        let newest = Date(timeIntervalSince1970: (1_763_600_000_000 + 9.2 * 60_000) / 1000)
        XCTAssertEqual(try XCTUnwrap(thread.lastTime).timeIntervalSince1970, newest.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertEqual(thread.lastReplyWords, "Last reply " + Naming.time(newest))
    }

    func testAPromptThatDoesNotReadHasNoMentionInFrontOfIt() throws {
        var model = ReadingModel()
        model.take(view: .object([
            "do": .string("message"), "position": .number(1), "channel": .bytes(Samples.channel), "sender": .bytes(Samples.alice),
            "name": .bytes(Data(repeating: 1, count: 16)), "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(1_763_600_000_000),
            "kind": .number(2), "to": .bytes(Samples.mini), "blobs": .array([]), "files": .null, "re": .null, "again": .bool(false), "text": .null,
        ]))
        let prompt = try XCTUnwrap(model.channels[Samples.channel]?.messages.first)
        XCTAssertEqual(prompt.body, .unreadable)
        XCTAssertNil(Naming.mention(of: prompt, in: model))
    }

    func testAPromptNamesItsBotInTheTextAndAMessageBetweenPeopleDoesNot() throws {
        let sample = Samples.model()
        let channel = try XCTUnwrap(sample.model.channels[sample.channel])
        let messages = channel.timeline.compactMap { p in channel.messages.first { $0.position == p } }
        let prompt = try XCTUnwrap(messages.first { $0.kind == 2 })
        XCTAssertEqual(Naming.mention(of: prompt, in: sample.model), "@mini")
        let between = try XCTUnwrap(messages.first { $0.kind == 1 })
        XCTAssertNil(Naming.mention(of: between, in: sample.model))
    }

    func testTheMarksShapeFollowsTheSenderKind() {
        XCTAssertEqual(Avatar.shape(isBot: true), .roundedSquare)
        XCTAssertEqual(Avatar.shape(isBot: false), .circle)
    }

    func testTheSessionsSummarySpeaksItsTitleFirst() throws {
        let sample = Samples.model()
        let thread = try XCTUnwrap(sample.model.channels[sample.channel]?.threads[sample.thread])
        let plain = Summary.spoken(model: sample.model, thread: thread, showsTitle: false)
        XCTAssertTrue(plain.hasPrefix("mini, "), plain)
        XCTAssertEqual(Summary.spoken(model: sample.model, thread: thread, showsTitle: true), thread.title + ", " + plain)
    }

    /// A bot whose profile is not read yet keeps the bot's rounded square in its row: the device log names it a bot (#106). Read at the mark's
    /// corner, 4 points in from each side: inside a rounded square of radius 10, outside a circle of radius 18.
    @MainActor
    func testABotWithNoProfileIsDrawnAsABot() throws {
        var s = ScrollFixture()
        s.put(1, s.bot, ["markdown": "hello from the bot"])
        XCTAssertNil(s.model.profiles[s.bot], "no profile read")
        let message = try XCTUnwrap(s.model.channels[s.channel]?.messages.first)
        func corner(bots: Set<Data>) -> [CGFloat] {
            _ = NSApplication.shared
            _ = PardnerFonts.register()
            let row = MessageRow(model: s.model, icons: [:], message: message).environment(\.botDevices, bots)
            let hosting = NSHostingView(rootView: row.frame(width: 400, height: 80, alignment: .topLeading).background(Color.white).environment(\.colorScheme, .light))
            hosting.appearance = NSAppearance(named: .aqua)
            hosting.frame = NSRect(x: 0, y: 0, width: 400, height: 80)
            hosting.layoutSubtreeIfNeeded()
            let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds)!
            hosting.cacheDisplay(in: hosting.bounds, to: rep)
            let scale = CGFloat(rep.pixelsWide) / 400
            let c = rep.colorAt(x: Int(4 * scale), y: Int(4 * scale))!.usingColorSpace(.sRGB)!
            return [c.redComponent, c.greenComponent, c.blueComponent].map { ($0 * 255).rounded() }
        }
        XCTAssertEqual(corner(bots: []), [255, 255, 255], "with no device log entry or profile the row draws a person's circle")
        XCTAssertNotEqual(corner(bots: [s.bot]), [255, 255, 255], "the device log names it a bot: a rounded square")
    }
}
