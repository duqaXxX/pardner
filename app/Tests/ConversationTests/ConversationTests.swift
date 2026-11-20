// The reading model (app data design, 6) on views shaped as `AppLink` delivers them (src/protocol/index.ts,
// `MessageView`), with bodies as the relay chat module writes them (its design, 3.7 and 3.8). Synthetic content.
import Conversation
import Foundation
import ProtocolHost
import XCTest

/// A channel with alice (the owner) and her bot `mini`, and the views the link would deliver for them.
private struct World {
    let channel = Data(repeating: 1, count: 32)
    let alice = Data(repeating: 2, count: 32)
    let bot = Data(repeating: 3, count: 32)
    var position = 10
    var conversation = ReadingModel()

    mutating func name() -> Data { Data(repeating: UInt8(position % 256), count: 16) }

    /// One message delivered; `json` nil for a body that did not open.
    @discardableResult
    mutating func deliver(kind: Int, from sender: Data, json: [String: Any]?, to: Data? = nil, re: MessageRef? = nil, again: Bool = false,
                          at place: Int? = nil, name given: Data? = nil, time: Double? = nil) -> MessageRef {
        let at = place ?? position
        if place == nil { position += 1 }
        let name = given ?? Data(repeating: UInt8(at % 256), count: 16)
        var view: [String: HostValue] = [
            "do": .string("message"), "position": .number(Double(at)), "channel": .bytes(channel), "sender": .bytes(sender),
            "name": .bytes(name), "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(time ?? 1_700_000_000_000 + Double(at) * 1000),
            "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null, "blobs": .array([]), "again": .bool(again),
            "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null,
            "files": .null, "text": .null,
        ]
        if let json {
            view["files"] = .array([])
            view["text"] = .string(String(decoding: try! JSONSerialization.data(withJSONObject: json), as: UTF8.self))
        }
        conversation.take(view: .object(view))
        return MessageRef(device: sender, name: name)
    }

    var c: Channel { conversation.channels[channel]! }

    /// The view of one message, as `deliver` would hand it, without taking it.
    func view(kind: Int, from sender: Data, json: [String: Any]?, at place: Int, re: MessageRef? = nil, again: Bool = false) -> HostValue {
        var view: [String: HostValue] = [
            "do": .string("message"), "position": .number(Double(place)), "channel": .bytes(channel), "sender": .bytes(sender),
            "name": .bytes(Data(repeating: UInt8(place % 256), count: 16)), "epoch": .bytes(Data(repeating: 9, count: 32)),
            "time": .number(1_700_000_000_000 + Double(place) * 1000), "kind": .number(Double(kind)), "to": .null, "blobs": .array([]),
            "again": .bool(again), "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null,
            "files": .null, "text": .null,
        ]
        if let json { view["text"] = .string(String(decoding: try! JSONSerialization.data(withJSONObject: json), as: UTF8.self)) }
        return .object(view)
    }
}

final class ConversationTests: XCTestCase {
    func testAPromptOpensASessionThatRunsThenIsAnswered() {
        var w = World()
        let prompt = w.deliver(kind: 2, from: w.alice, json: ["text": "fix the tests"], to: w.bot)
        let thread = prompt.hex
        XCTAssertEqual(w.c.timeline.count, 1)
        XCTAssertEqual(w.c.threads[thread]?.bot, w.bot)
        XCTAssertEqual(w.c.threads[thread]?.state, .idle)
        w.deliver(kind: 3, from: w.bot, json: [:], re: prompt)
        XCTAssertEqual(w.c.threads[thread]?.state, .running)
        let answer = Data(repeating: 0xAA, count: 16)
        let parts = MessageRef(device: w.bot, name: answer)
        w.deliver(kind: 4, from: w.bot, json: ["thread": thread, "markdown": "Running "], re: parts)
        w.deliver(kind: 4, from: w.bot, json: ["thread": thread, "markdown": "the tests."], re: parts)
        guard case .answer(let partial)? = w.c.threads[thread]?.items.last else { return XCTFail("no answer group") }
        XCTAssertEqual(partial.markdown, "Running the tests.", "drawn as it is written")
        XCTAssertFalse(partial.done)
        w.deliver(kind: 5, from: w.bot, json: ["thread": thread, "markdown": "Running the tests. All pass."], re: prompt, name: answer)
        guard case .answer(let whole)? = w.c.threads[thread]?.items.last else { return XCTFail("no answer group") }
        XCTAssertEqual(whole.markdown, "Running the tests. All pass.", "the answer replaces the parts")
        XCTAssertTrue(whole.done)
        XCTAssertEqual(w.c.threads[thread]?.items.count, 1, "the parts and the answer are one item")
        XCTAssertEqual(w.c.threads[thread]?.prompts[prompt], .answered)
        XCTAssertEqual(w.c.threads[thread]?.state, .idle)
    }

    func testTheOwnersMessageInTheThreadAndAQuestionThatWaits() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "deploy"], to: w.bot)
        let thread = root.hex
        let next = w.deliver(kind: 2, from: w.alice, json: ["text": "and the docs", "thread": thread], to: w.bot)
        XCTAssertEqual(w.c.timeline.count, 1, "a prompt in a thread is not the channel's")
        XCTAssertEqual(w.c.threads[thread]?.prompts[next], .sent)
        w.deliver(kind: 3, from: w.bot, json: [:], re: next) // the bot started alice's prompt: her reply counts
        let request = w.deliver(kind: 9, from: w.bot, json: ["thread": thread, "title": "Allow Bash?", "request": ["type": "permission"]], re: root)
        XCTAssertEqual(w.c.threads[thread]?.state, .waiting)
        w.deliver(kind: 10, from: w.alice, json: ["thread": thread, "answer": ["type": "permission", "allow": true]], to: w.bot, re: request)
        XCTAssertEqual(w.c.threads[thread]?.requests[request], .replied)
        XCTAssertEqual(w.c.threads[thread]?.state, .running, "answered, the turn goes on")
    }

    func testAnEditWithdrawsOrRewritesARequest() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "go"], to: w.bot)
        let a = w.deliver(kind: 9, from: w.bot, json: ["thread": root.hex, "title": "Setup", "request": ["type": "setup"]], re: root)
        let b = w.deliver(kind: 9, from: w.bot, json: ["thread": root.hex, "title": "Hold", "request": ["type": "hold"]], re: root)
        w.deliver(kind: 11, from: w.bot, json: ["thread": root.hex, "withdrawn": true], re: a)
        w.deliver(kind: 11, from: w.bot, json: ["thread": root.hex, "markdown": "Sent."], re: b)
        XCTAssertEqual(w.c.threads[root.hex]?.requests[a], .withdrawn)
        XCTAssertEqual(w.c.threads[root.hex]?.requests[b], .rewritten(markdown: "Sent."))
        XCTAssertEqual(w.c.threads[root.hex]?.state, .idle)
    }

    func testACutAndANotReadEndThePrompt() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "one"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        w.deliver(kind: 6, from: w.bot, json: [:], re: root)
        let other = w.deliver(kind: 2, from: w.alice, json: ["text": "two", "thread": root.hex], to: w.bot)
        w.deliver(kind: 7, from: w.bot, json: [:], re: other)
        XCTAssertEqual(w.c.threads[root.hex]?.prompts[root], .cut)
        XCTAssertEqual(w.c.threads[root.hex]?.prompts[other], .notRead)
        XCTAssertEqual(w.c.threads[root.hex]?.state, .idle)
    }

    /// Design 6.2, round 2 N3: an answer refused 8 never lands; its parts are drawn and the prompt stays running.
    func testAnAnswerThatNeverLandsLeavesItsPartsShown() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "long"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        w.deliver(kind: 4, from: w.bot, json: ["thread": root.hex, "markdown": "part one"], re: MessageRef(device: w.bot, name: Data(repeating: 0xBB, count: 16)))
        guard case .answer(let group)? = w.c.threads[root.hex]?.items.last else { return XCTFail("no answer group") }
        XCTAssertEqual(group.markdown, "part one")
        XCTAssertEqual(w.c.threads[root.hex]?.state, .running)
    }

    func testMessagesBetweenPeopleAndTheBotsTexts() {
        var w = World()
        let hello = w.deliver(kind: 1, from: w.alice, json: ["markdown": "hello"])
        w.deliver(kind: 1, from: w.alice, json: ["markdown": "a reply in its thread", "thread": hello.hex])
        XCTAssertEqual(w.c.timeline.count, 1)
        XCTAssertNil(w.c.threads[hello.hex]?.bot, "a thread between people is no session")
        XCTAssertEqual(w.c.threads[hello.hex]?.items.count, 1)
        XCTAssertTrue(w.c.sessions.isEmpty)
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "x"], to: w.bot)
        w.deliver(kind: 1, from: w.bot, json: ["thread": root.hex, "say": "notice", "markdown": "Bound to ~/code"])
        guard case .message(let notice)? = w.c.threads[root.hex]?.items.last else { return XCTFail("no notice") }
        XCTAssertEqual(notice.body, .text(markdown: "Bound to ~/code", say: "notice"))
    }

    func testAMessageThatDidNotOpenIsShownInItsPlaceThenMovesWhenItOpens() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "x"], to: w.bot)
        let place = w.position
        let late = w.deliver(kind: 1, from: w.bot, json: nil)
        XCTAssertEqual(w.c.timeline, [10, place], "unreadable, in its place in the channel")
        XCTAssertEqual(w.c.messages.last?.body, .unreadable)
        w.deliver(kind: 1, from: w.bot, json: ["thread": root.hex, "say": "say", "markdown": "now read"], again: true, at: place, name: late.name)
        XCTAssertEqual(w.c.timeline, [10], "it belongs to its thread")
        XCTAssertEqual(w.c.messages.count, 2, "replaced, not added")
        guard case .message(let read)? = w.c.threads[root.hex]?.items.last else { return XCTFail("not in its thread") }
        XCTAssertEqual(read.position, place)
    }

    func testABodyOfTheWrongShapeIsUnreadableNeverACrash() {
        var w = World()
        w.deliver(kind: 2, from: w.alice, json: ["text": 42], to: w.bot)
        w.deliver(kind: 9, from: w.bot, json: ["title": "no request"])
        w.deliver(kind: 4, from: w.bot, json: ["markdown": "a part with no re"])
        XCTAssertEqual(w.c.messages.map(\.body), [.unreadable, .unreadable, .part(markdown: "a part with no re")])
    }

    func testTheSessionsTabOrdersByTheLastReply() {
        var w = World()
        let first = w.deliver(kind: 2, from: w.alice, json: ["text": "first"], to: w.bot)
        let second = w.deliver(kind: 2, from: w.alice, json: ["text": "second"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: first)
        XCTAssertEqual(w.c.sessions.map(\.key), [first.hex, second.hex], "the bot replied in the first last")
        w.deliver(kind: 3, from: w.bot, json: [:], re: second)
        XCTAssertEqual(w.c.sessions.map(\.key), [second.hex, first.hex])
    }

    func testARelayRecreatedEmptiesTheChannels() {
        var w = World()
        w.deliver(kind: 1, from: w.alice, json: ["markdown": "hello"])
        w.conversation.take(view: .object(["do": .string("incarnation"), "first": .bool(false), "changed": .bool(true), "incarnation": .bytes(Data(count: 16))]))
        XCTAssertTrue(w.conversation.channels.isEmpty)
        w.conversation.take(view: .object(["do": .string("incarnation"), "first": .bool(false), "changed": .bool(false), "incarnation": .bytes(Data(count: 16))]))
        w.deliver(kind: 1, from: w.alice, json: ["markdown": "again"])
        XCTAssertEqual(w.c.messages.count, 1)
    }

    func testAProfileIsShownThenDropped() {
        var w = World()
        w.conversation.take(profile: .object([
            "do": .string("profile"), "bot": .bytes(w.bot),
            "profile": .object(["name": .string("mini"), "account": .object(["name": .string("alice@example.com"), "plan": .string("max")]), "icon": .null]),
        ]))
        XCTAssertEqual(w.conversation.profiles[w.bot], BotProfile(name: "mini", account: "alice@example.com", plan: "max", icon: nil))
        w.conversation.take(profile: .object(["do": .string("profile"), "bot": .bytes(w.bot), "profile": .null]))
        XCTAssertNil(w.conversation.profiles[w.bot])
    }
}

extension ConversationTests {
    func testOnlyTheSessionsBotMovesItsPromptsAndOnlyItsOwnerAnswers() {
        var w = World()
        let other = Data(repeating: 4, count: 32), bob = Data(repeating: 5, count: 32)
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "go"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        w.deliver(kind: 6, from: other, json: [:], re: root) // another bot of the channel
        XCTAssertEqual(w.c.threads[root.hex]?.prompts[root], .running, "another bot cuts nothing here")
        let request = w.deliver(kind: 9, from: w.bot, json: ["thread": root.hex, "title": "Allow?", "request": ["type": "permission"]], re: root)
        w.deliver(kind: 10, from: bob, json: ["thread": root.hex, "answer": ["type": "permission", "allow": true]], to: w.bot, re: request)
        XCTAssertEqual(w.c.threads[root.hex]?.requests[request], .open, "the bot takes its owner's reply alone")
        XCTAssertEqual(w.c.threads[root.hex]?.state, .waiting)
        w.deliver(kind: 10, from: w.alice, json: ["thread": root.hex, "answer": ["type": "permission", "allow": true]], to: w.bot, re: request)
        XCTAssertEqual(w.c.threads[root.hex]?.requests[request], .replied)
    }

    func testAnEmptyAnswerKeepsWhatItsPartsShowed() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "go"], to: w.bot)
        let name = Data(repeating: 0xCC, count: 16)
        w.deliver(kind: 4, from: w.bot, json: ["thread": root.hex, "markdown": "shown"], re: MessageRef(device: w.bot, name: name))
        w.deliver(kind: 5, from: w.bot, json: ["thread": root.hex, "markdown": ""], re: root, name: name)
        guard case .answer(let a)? = w.c.threads[root.hex]?.items.last else { return XCTFail("no answer") }
        XCTAssertEqual(a.markdown, "shown")
        XCTAssertTrue(a.done)
    }

    func testAnUnreadableBodyWhoseThreadReadsStaysInItsThread() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "go"], to: w.bot)
        w.deliver(kind: 9, from: w.bot, json: ["thread": root.hex, "title": "bad", "request": "not an object"], re: root)
        XCTAssertEqual(w.c.timeline.count, 1, "not the channel's")
        guard case .message(let m)? = w.c.threads[root.hex]?.items.last else { return XCTFail("not in its thread") }
        XCTAssertEqual(m.body, .unreadable)
    }

    func testABatchOfMessagesDeliveredAgainRebuildsOnceInPositionOrder() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "go"], to: w.bot)
        let a = w.position, b = w.position + 1
        w.deliver(kind: 1, from: w.bot, json: nil)
        w.deliver(kind: 1, from: w.bot, json: nil)
        w.deliver(kind: 1, from: w.alice, json: ["markdown": "later"])
        w.conversation.take(views: [
            w.view(kind: 1, from: w.bot, json: ["thread": root.hex, "say": "say", "markdown": "second"], at: b, again: true),
            w.view(kind: 1, from: w.bot, json: ["thread": root.hex, "say": "say", "markdown": "first"], at: a, again: true),
        ])
        XCTAssertEqual(w.c.messages.map(\.position), [10, a, b, b + 1])
        let texts = w.c.threads[root.hex]?.items.compactMap { if case .message(let m) = $0, case .text(let md, _) = m.body { md } else { nil } }
        XCTAssertEqual(texts, ["first", "second"], "in position order, whatever order they came in")
        XCTAssertEqual(w.c.timeline, [10, b + 1])
    }

    func testSessionsWithTheSameTimeKeepOneOrder() {
        var w = World()
        let x = w.deliver(kind: 2, from: w.alice, json: ["text": "x"], to: w.bot, time: 1_700_000_000_000)
        let y = w.deliver(kind: 2, from: w.alice, json: ["text": "y"], to: w.bot, time: 1_700_000_000_000)
        let order = w.c.sessions.map(\.key)
        XCTAssertEqual(order, [x.hex, y.hex].sorted())
    }
}
