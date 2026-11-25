// A scheduled run's line and the bot's guess at the next prompt in the thread (step E1 design 3.1 and 3.2): the row, the clearing rule of the
// hint, its stale-guess rule, and who it is read from. Over views shaped as the link delivers them; synthetic content.
import Conversation
import Foundation
import ProtocolHost
@testable import Screens
import XCTest

private let bot = Data(repeating: 3, count: 32)
private let alice = Data(repeating: 2, count: 32)
private let bob = Data(repeating: 7, count: 32)

/// A model with one session of the bot, opened by a prompt of alice's.
private struct Session {
    var model = ReadingModel()
    var position = 1
    let channel = Data(repeating: 1, count: 32)
    var prompt: MessageRef!

    init() {
        prompt = put(2, alice, ["text": "watch the build"], to: bot)
        put(3, bot, [:], re: prompt)
    }

    @discardableResult
    mutating func put(_ kind: Int, _ sender: Data, _ body: [String: Any], to: Data? = nil, re: MessageRef? = nil) -> MessageRef {
        let at = position
        position += 1
        let name = Data(repeating: UInt8(at), count: 16)
        model.take(view: .object([
            "do": .string("message"), "position": .number(Double(at)), "channel": .bytes(channel), "sender": .bytes(sender),
            "name": .bytes(name), "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(1_700_000_000_000 + Double(at) * 1000),
            "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null, "blobs": .array([]), "files": .array([]),
            "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null,
            "text": .string(String(decoding: try! JSONSerialization.data(withJSONObject: body), as: UTF8.self)), "again": .bool(false),
        ]))
        return MessageRef(device: sender, name: name)
    }

    mutating func run(at: Any = 1_763_999_940_000.0, from sender: Data = bot) {
        put(1, sender, ["thread": prompt.hex, "say": "run", "at": at, "markdown": "Running scheduled task"])
    }

    mutating func next(_ guess: Any = "run the tests", from sender: Data = bot) {
        put(1, sender, ["thread": prompt.hex, "say": "next", "next": guess])
    }

    mutating func say(_ say: String, _ markdown: String, from sender: Data = bot) {
        put(1, sender, ["thread": prompt.hex, "say": say, "markdown": markdown])
    }

    mutating func answer(_ markdown: String = "Done.") { put(5, bot, ["thread": prompt.hex, "markdown": markdown], re: prompt) }

    mutating func typed(_ text: String = "and now this") { put(2, alice, ["thread": prompt.hex, "text": text], to: bot) }

    var thread: MessageThread { model.channels[channel]!.threads[prompt.hex]! }
}

final class RunAndHintTests: XCTestCase {
    // MARK: the run row

    func testARunLineOfTheBotIsAnItemAndNoReply() {
        var s = Session()
        s.answer()
        let before = s.thread.lastReply
        s.run()
        XCTAssertEqual(s.thread.replies, 1)
        guard case .message(let m)? = s.thread.items.last else { return XCTFail("no item") }
        XCTAssertTrue(s.thread.isRunLine(m))
        XCTAssertGreaterThan(s.thread.lastReply ?? .distantPast, before ?? .distantPast, "it moves the last reply as any message of the bot")
    }

    func testARunLineFromAnotherSenderOrWithNoTimeIsAPlainText() {
        var s = Session()
        s.run(from: bob)
        s.put(1, bot, ["thread": s.prompt.hex, "say": "run", "markdown": "Running scheduled task"])
        s.run(at: "noon")
        XCTAssertEqual(s.thread.replies, 3, "each is drawn as the text it says")
        for case .message(let m) in s.thread.items { XCTAssertFalse(s.thread.isRunLine(m)) }
    }

    func testTheRunLineSaysTheTimeAsTheTerminalDoes() {
        let utc = TimeZone(identifier: "UTC")!
        let night = 1_764_024_540_000.0 // Nov 24 2025, 22:49 UTC
        XCTAssertEqual(Naming.runLine(at: night, timeZone: utc), "Running scheduled task (Nov 24 10:49pm)")
        XCTAssertEqual(Naming.runLine(at: night, timeZone: TimeZone(identifier: "Europe/Rome")!), "Running scheduled task (Nov 24 11:49pm)")
        XCTAssertEqual(Naming.runLine(at: night + 8 * 3_600_000 + 16 * 60_000, timeZone: utc), "Running scheduled task (Nov 25 7:05am)")
    }

    // MARK: the hint

    func testTheHintIsTheNewestGuessOfTheBotAndNoReply() {
        var s = Session()
        s.answer()
        s.next("run the tests")
        XCTAssertEqual(s.thread.hint, "run the tests")
        XCTAssertEqual(s.thread.replies, 1, "no row, no reply")
        XCTAssertEqual(s.thread.items.count, 1, "the guess is no item")
        s.next("commit it")
        XCTAssertEqual(s.thread.hint, "commit it")
    }

    func testTheHintDoesNotDependOnWhetherTheGuessOrTheWorksEndLandsFirst() {
        var s = Session()
        s.answer()
        s.say("footer", "4s")
        s.next()
        XCTAssertEqual(s.thread.hint, "run the tests")
        var t = Session()
        t.answer()
        t.next()
        t.say("footer", "4s")
        t.say("title", "Watch the build")
        XCTAssertEqual(t.thread.hint, "run the tests", "a work's end and a title of the bot leave it")
    }

    func testAnyLaterItemClearsTheHint() {
        let later: [(String, (inout Session) -> Void)] = [
            ("a prompt of the person", { $0.typed() }),
            ("an answer", { $0.answer("More.") }),
            ("a run line", { $0.run() }),
            ("a text of the bot", { $0.say("say", "Anything else?") }),
            ("a text of another sender", { $0.say("say", "hello", from: bob) }),
            ("a work's end of another sender", { $0.say("footer", "4s", from: bob) }),
        ]
        for (name, act) in later {
            var s = Session()
            s.answer()
            s.next()
            XCTAssertNotNil(s.thread.hint, name)
            act(&s)
            XCTAssertNil(s.thread.hint, name)
        }
    }

    func testAGuessMadeBeforeAPromptAlreadyInTheThreadIsStale() {
        var s = Session()
        s.answer()
        s.typed() // on the network before the guess landed
        s.next()
        XCTAssertNil(s.thread.hint)
        // The bot's run line and work's end between the prompt and the guess do not make it fresh.
        s.run()
        s.say("footer", "4s")
        s.next()
        XCTAssertNil(s.thread.hint)
        // A newer answer does.
        s.answer("Done again.")
        s.next("run the tests")
        XCTAssertEqual(s.thread.hint, "run the tests")
    }

    func testAGuessAfterARunLineAndAWorksEndStandsWhenTheItemBeforeIsTheBotsOwn() {
        var s = Session()
        s.answer()
        s.run()
        s.say("footer", "4s")
        s.next()
        XCTAssertEqual(s.thread.hint, "run the tests")
    }

    func testOnlyTheThreadsBotGivesAHint() {
        var s = Session()
        s.answer()
        s.next(from: bob)
        XCTAssertNil(s.thread.hint)
        s.next("")
        XCTAssertNil(s.thread.hint)
        s.next(5)
        XCTAssertNil(s.thread.hint)
    }

    func testAGuessIsNoRowAndDoesNotMoveTheLastReply() {
        var s = Session()
        s.answer()
        let before = s.thread.lastReply
        s.next()
        XCTAssertEqual(s.thread.lastReply, before)
    }

    func testALineOfTheBotUnderTheOpeningPromptTakesTheHintAwayToo() {
        var s = Session()
        s.answer()
        s.next()
        XCTAssertNotNil(s.thread.hint)
        // The bot's line that answers the opening prompt itself (no `thread`, `re` the root): an item like any other.
        s.put(1, bot, ["markdown": "A word for the prompt"], re: s.prompt)
        XCTAssertNil(s.thread.hint)
    }
}
