// The session around its turn in the thread (step D2 design, 3.1 and 3.2): the title, the replies' count, the summary, the header's line and the
// account's line. Over views shaped as the link delivers them; synthetic content.
import Conversation
import Foundation
import ProtocolHost
@testable import Screens
import XCTest

private let bot = Data(repeating: 3, count: 32)
private let alice = Data(repeating: 2, count: 32)

/// A model with one session of the bot per channel (`channel` byte), each opened by a prompt of alice's.
private struct Around {
    var model = ReadingModel()
    var position = 1
    let channel: Data
    var prompt: MessageRef!

    init(channel byte: UInt8 = 1, model: ReadingModel = ReadingModel()) {
        (channel, self.model) = (Data(repeating: byte, count: 32), model)
        prompt = put(2, alice, ["text": "fix the tests\nplease"], to: bot)
        put(3, bot, [:], re: prompt)
    }

    @discardableResult
    mutating func put(_ kind: Int, _ sender: Data, _ body: [String: Any], to: Data? = nil, re: MessageRef? = nil, time: Double? = nil) -> MessageRef {
        let at = position
        position += 1
        let name = Data(repeating: UInt8(at), count: 16)
        model.take(view: .object([
            "do": .string("message"), "position": .number(Double(at)), "channel": .bytes(channel), "sender": .bytes(sender),
            "name": .bytes(name), "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(time ?? 1_700_000_000_000 + Double(at) * 1000),
            "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null, "blobs": .array([]), "files": .array([]),
            "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null,
            "text": .string(String(decoding: try! JSONSerialization.data(withJSONObject: body), as: UTF8.self)), "again": .bool(false),
        ]))
        return MessageRef(device: sender, name: name)
    }

    mutating func say(_ say: String, _ markdown: String, from sender: Data = bot, extra: [String: Any] = [:], time: Double? = nil) {
        put(1, sender, ["thread": prompt.hex, "say": say, "markdown": markdown].merging(extra) { $1 }, time: time)
    }

    var thread: MessageThread { model.channels[channel]!.threads[prompt.hex]! }
}

private func usage(at: Double, percent: Double) -> [String: Any] {
    ["at": at, "session": ["percent": percent, "resetsAt": NSNull()] as [String: Any], "week": NSNull()]
}

final class SessionTextTests: XCTestCase {
    func testATitleOfTheBotNamesTheThreadAndIsNoReply() {
        var s = Around()
        XCTAssertEqual(s.thread.title, "fix the tests", "the root's first line before any")
        s.put(5, bot, ["thread": s.prompt.hex, "markdown": "Done."], re: s.prompt)
        let last = s.thread.lastReply
        s.say("title", "Fix the footer", time: 1_700_000_900_000)
        s.say("title", "", time: 1_700_000_950_000)
        XCTAssertEqual(s.thread.title, "Fix the footer")
        XCTAssertEqual(s.thread.sessionTitle, "Fix the footer", "an empty title is ignored")
        XCTAssertEqual(s.thread.replies, 1)
        XCTAssertEqual(s.thread.lastReply, last, "a title does not move the last reply")
        s.say("title", "Rename it")
        XCTAssertEqual(s.thread.title, "Rename it", "the newest in position order")
    }

    func testATitleFromAnotherSenderChangesNothing() {
        var s = Around()
        s.say("title", "Not mine", from: Data(repeating: 7, count: 32))
        XCTAssertNil(s.thread.sessionTitle)
        XCTAssertEqual(s.thread.title, "fix the tests")
        XCTAssertEqual(s.thread.replies, 1, "drawn as a plain text")
    }

    func testAFooterIsALineUnderTheReplyAndNoReply() {
        var s = Around()
        s.put(5, bot, ["thread": s.prompt.hex, "markdown": "Done."], re: s.prompt)
        s.say("footer", "4m 12s", time: 1_700_000_800_000)
        XCTAssertEqual(s.thread.replies, 1)
        XCTAssertEqual(s.thread.lastReply, Date(timeIntervalSince1970: 1_700_000_800), "it moves the last reply as any message of the bot")
        guard case .message(let m)? = s.thread.items.last else { return XCTFail("no item") }
        XCTAssertTrue(s.thread.isFooter(m))
        s.say("footer", "", extra: ["session": "Opus 5.5"])
        XCTAssertEqual(s.thread.items.count, 2, "none when its length is empty")
    }

    func testAFooterFromAMembersDeviceIsAPlainText() {
        var s = Around()
        s.say("footer", "4m 12s", from: Data(repeating: 7, count: 32), extra: ["session": "⚡ bypass", "usage": usage(at: 5, percent: 9)])
        XCTAssertEqual(s.thread.replies, 1)
        guard case .message(let m)? = s.thread.items.last else { return XCTFail("no item") }
        XCTAssertFalse(s.thread.isFooter(m))
        XCTAssertNil(s.thread.session)
        XCTAssertNil(s.thread.windowUsage)
        XCTAssertNil(s.thread.costUsage)
        XCTAssertTrue(s.model.windows.isEmpty)
        XCTAssertTrue(s.model.apiBots.isEmpty)
    }

    func testTheHeadersLineIsTheNewestEndsAndATextWithoutOneLeavesIt() {
        var s = Around()
        s.say("footer", "1s", extra: ["session": "Opus 5.5"])
        s.say("footer", "2s", extra: ["session": "⚡ bypass · Opus 5.5 · ctx 34%"])
        s.say("footer", "3s")
        XCTAssertEqual(s.thread.session, "⚡ bypass · Opus 5.5 · ctx 34%")
    }

    func testTheSummaryInTheConversationSpeaksTheSessionsTitleFirst() {
        var s = Around()
        let before = Summary.spoken(model: s.model, thread: s.thread, showsTitle: false)
        s.say("title", "Fix the footer")
        let after = Summary.spoken(model: s.model, thread: s.thread, showsTitle: false)
        XCTAssertEqual(after, "Fix the footer, " + before)
        XCTAssertEqual(Summary.spoken(model: s.model, thread: s.thread, showsTitle: true), "Fix the footer, " + before)
    }

    func testTheBotsRowTakesTheNewestUsageByItsOwnTimeAcrossChannels() {
        var first = Around(channel: 1)
        // The channel read first holds the later usage, sent earlier in message time: the order is `usage.at`'s, not the message's.
        first.say("footer", "1s", extra: ["usage": usage(at: 2_000, percent: 80)], time: 1_700_000_000_000)
        var second = Around(channel: 2, model: first.model)
        second.say("footer", "1s", extra: ["usage": usage(at: 1_000, percent: 10)], time: 1_700_000_999_000)
        XCTAssertEqual(second.model.windows[bot]?.at, 2_000)
        XCTAssertEqual(second.model.windows[bot]?.session?.percent, 80)
        second.say("footer", "1s", extra: ["usage": usage(at: 3_000, percent: 5)], time: 1_700_000_500_000)
        XCTAssertEqual(second.model.windows[bot]?.session?.percent, 5, "a newer one in the other channel wins")
    }

    private func cost(at: Double, _ amount: Double) -> [String: Any] {
        ["at": at, "session": NSNull(), "week": NSNull(), "cost": amount]
    }

    private func line(_ s: Around, plan: String?, profileRead: Bool = true, place: UsageLine.Place = .composer, now: Double = 1_764_000_000_000) -> String? {
        UsageLine.text(profileRead: profileRead, plan: plan, windows: s.model.windows[bot], cost: s.thread.costUsage, apiSeen: s.model.apiBots.contains(bot),
                       place: place, now: Date(timeIntervalSince1970: now / 1000))
    }

    func testACostAloneIsAUsageAndNeverReplacesTheNewestWindows() {
        var s = Around()
        s.say("footer", "1s", extra: ["usage": usage(at: 1_000, percent: 10)])
        s.say("footer", "1s", extra: ["usage": cost(at: 2_000, 1.84)])
        XCTAssertEqual(s.model.windows[bot]?.at, 1_000, "a usage with no window is not the windows")
        XCTAssertEqual(s.thread.costUsage?.cost, 1.84)
        XCTAssertEqual(s.model.apiBots, [bot])
        s.say("footer", "1s", extra: ["usage": cost(at: 1_500, 9)])
        XCTAssertEqual(s.thread.costUsage?.cost, 1.84, "the newest by its own time")
    }

    func testTheCostIsTheThreadsOwnAndAPISeenIsTheBots() {
        var first = Around(channel: 1)
        first.say("footer", "1s", extra: ["usage": cost(at: 1_763_999_820_000, 1.84)])
        var second = Around(channel: 2, model: first.model)
        XCTAssertNil(second.thread.costUsage)
        XCTAssertEqual(line(first, plan: nil), "API · $1.84 this session")
        XCTAssertEqual(line(second, plan: nil), "API", "another thread's cost is not this thread's")
        XCTAssertEqual(line(second, plan: nil, place: .bots), "API")
        second.say("footer", "1s", extra: ["usage": cost(at: 1_763_999_900_000, 0.5)])
        XCTAssertEqual(line(second, plan: nil), "API · $0.50 this session")
    }

    func testTheRowsOfTheAccountsLine() {
        var s = Around()
        XCTAssertNil(line(s, plan: nil), "a profile with no account and nothing seen: no line, not API")
        XCTAssertEqual(line(s, plan: "Claude Max"), "Claude Max", "a plan with no window read: the plan alone, never API")
        XCTAssertNil(line(s, plan: "Claude Max", profileRead: false), "a profile not read yet")
        s.say("footer", "1s", extra: ["usage": usage(at: 1_763_999_820_000, percent: 40)])
        XCTAssertEqual(line(s, plan: "Claude Max"), "Claude Max · 5h 40%")
        XCTAssertEqual(line(s, plan: "Claude Max", now: 1_764_000_600_001), "Claude Max · 5h 40%", "old values carry no time")
        XCTAssertNil(line(s, plan: nil), "windows without a cost never make an API account")
    }
}
