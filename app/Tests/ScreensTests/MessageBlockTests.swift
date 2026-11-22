// The message block's decisions (window redesign, unit 1a): the summary's words, the mention in a prompt and the mark's shape.
// Over the synthetic samples.
import Conversation
import Foundation
import ProtocolHost
@testable import Screens
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
}
