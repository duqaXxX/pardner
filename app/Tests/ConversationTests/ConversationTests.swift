// The reading model (app data design, 6) on views shaped as `AppLink` delivers them (src/protocol/index.ts,
// `MessageView`), with bodies as the relay chat module writes them (its design, 3.7 and 3.8). Synthetic content.
import Conversation
import Foundation
import ProtocolHost
import XCTest

/// A channel with alice (the owner) and her bot `mini`, and the views the link would deliver for them.
struct World {
    let channel = Data(repeating: 1, count: 32)
    let alice = Data(repeating: 2, count: 32)
    let bot = Data(repeating: 3, count: 32)
    var position = 10
    var conversation = ReadingModel()

    mutating func name() -> Data { Data(repeating: UInt8(position % 256), count: 16) }

    /// One message delivered; `json` nil for a body that did not open.
    @discardableResult
    mutating func deliver(kind: Int, from sender: Data, json: [String: Any]?, to: Data? = nil, re: MessageRef? = nil, again: Bool = false,
                          at place: Int? = nil, name given: Data? = nil, time: Double? = nil, files: [HostValue] = []) -> MessageRef {
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
            view["files"] = .array(files)
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
    func testAnAnswerCarriesTheTimeOfItsFirstPart() {
        var w = World()
        let prompt = w.deliver(kind: 2, from: w.alice, json: ["text": "fix the tests"], to: w.bot, time: 1_700_000_000_000)
        w.deliver(kind: 3, from: w.bot, json: [:], re: prompt, time: 1_700_000_001_000)
        let answer = Data(repeating: 0xAA, count: 16)
        let parts = MessageRef(device: w.bot, name: answer)
        w.deliver(kind: 4, from: w.bot, json: ["thread": prompt.hex, "markdown": "Running "], re: parts, time: 1_700_000_002_000)
        w.deliver(kind: 4, from: w.bot, json: ["thread": prompt.hex, "markdown": "the tests."], re: parts, time: 1_700_090_000_000)
        w.deliver(kind: 5, from: w.bot, json: ["thread": prompt.hex, "markdown": "Running the tests."], re: prompt, name: answer, time: 1_700_090_001_000)
        guard case .answer(let group)? = w.c.threads[prompt.hex]?.items.last else { return XCTFail("no answer group") }
        XCTAssertEqual(group.time, Date(timeIntervalSince1970: 1_700_000_002), "the first part's time, a day before the answer that lands")
    }

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

    func testAPromptIsQueuedWhileAnEarlierPromptOfTheThreadRuns() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "one"], to: w.bot)
        let thread = root.hex
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        let second = w.deliver(kind: 2, from: w.alice, json: ["text": "two", "thread": thread], to: w.bot)
        let third = w.deliver(kind: 2, from: w.alice, json: ["text": "three", "thread": thread], to: w.bot)
        XCTAssertFalse(w.c.threads[thread]!.queued.contains(root), "the one that runs is not queued")
        XCTAssertTrue(w.c.threads[thread]!.queued.contains(second))
        XCTAssertTrue(w.c.threads[thread]!.queued.contains(third))
        w.deliver(kind: 3, from: w.bot, json: [:], re: second) // the bot starts every prompt it reads, a queued one too
        XCTAssertEqual(w.c.threads[thread]?.prompts[second], .running)
        XCTAssertTrue(w.c.threads[thread]!.queued.contains(second), "running by its start, still behind the root")
        w.deliver(kind: 5, from: w.bot, json: ["thread": thread, "markdown": "done one"], re: root)
        XCTAssertFalse(w.c.threads[thread]!.queued.contains(second), "the earlier prompt ended on its answer")
        XCTAssertTrue(w.c.threads[thread]!.queued.contains(third), "now behind the second, which runs")
        w.deliver(kind: 7, from: w.bot, json: [:], re: second)
        XCTAssertFalse(w.c.threads[thread]!.queued.contains(third), "nothing before it runs any more")
    }
}

// What the bot answers to a reply of the owner's (requests design 2.2): read by the kind's `re`, from the bot the reply was `to`.
extension ConversationTests {
    /// A session with a request and the owner's reply to it; the reply carries no `thread`, as the app's does not.
    private func replied(_ w: inout World, type: String = "permission", answer: [String: Any] = ["type": "permission", "allow": true])
        -> (thread: String, prompt: MessageRef, request: MessageRef, reply: MessageRef) {
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "go"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        let request = w.deliver(kind: 9, from: w.bot, json: ["thread": root.hex, "title": "Allow?", "request": ["type": type]], re: root)
        let reply = w.deliver(kind: 10, from: w.alice, json: ["answer": answer], to: w.bot, re: request)
        return (root.hex, root, request, reply)
    }

    func testAReasonOnAReplyIsDrawnOnItsRequestAndMakesNoThreadItem() {
        var w = World()
        let s = replied(&w)
        XCTAssertEqual(w.c.threads[s.thread]?.requests[s.request], .replied)
        let items = w.c.threads[s.thread]!.items.count
        // A refusal can carry `thread: ""`: only `re` finds its place.
        w.deliver(kind: 5, from: w.bot, json: ["thread": "", "markdown": "The bot is no longer waiting for this answer."], re: s.reply)
        let t = w.c.threads[s.thread]!
        XCTAssertEqual(t.items.count, items, "a verdict is no thread item")
        XCTAssertNil(w.c.threads[""], "and opens no thread")
        XCTAssertEqual(t.requests[s.request], .open, "the request still waits")
        XCTAssertEqual(t.state, .waiting)
        XCTAssertEqual(t.reason(of: s.request, from: w.alice), "The bot is no longer waiting for this answer.")
        XCTAssertNil(t.reason(of: s.request, from: Data(repeating: 7, count: 32)), "the card shows this device's reply's reason")
        XCTAssertEqual(t.prompts[s.prompt], .running, "no prompt moved")
    }

    func testAnotherBotsVerdictOnAReplyIsIgnored() {
        var w = World()
        let other = Data(repeating: 4, count: 32)
        let s = replied(&w)
        w.deliver(kind: 5, from: other, json: ["thread": s.thread, "markdown": ""], re: s.reply)
        w.deliver(kind: 5, from: other, json: ["thread": s.thread, "markdown": "not me"], re: s.reply)
        w.deliver(kind: 7, from: other, json: [:], re: s.reply)
        let t = w.c.threads[s.thread]!
        XCTAssertEqual(t.requests[s.request], .replied)
        XCTAssertNil(t.reason(of: s.request, from: w.alice))
        XCTAssertFalse(t.items.contains { if case .answer = $0 { true } else { false } })
    }

    func testTheBotsEmptyVerdictAnswersARequestWhateverCameBefore() {
        var w = World()
        let s = replied(&w)
        // The bot's real order: the core withdraws the accepted request, then the module writes the empty kind 5.
        w.deliver(kind: 11, from: w.bot, json: ["thread": s.thread, "withdrawn": true], re: s.request)
        XCTAssertEqual(w.c.threads[s.thread]?.requests[s.request], .withdrawn)
        w.deliver(kind: 5, from: w.bot, json: ["thread": "", "markdown": ""], re: s.reply)
        XCTAssertEqual(w.c.threads[s.thread]?.requests[s.request], .answered)
        w.deliver(kind: 11, from: w.bot, json: ["thread": s.thread, "withdrawn": true], re: s.request)
        XCTAssertEqual(w.c.threads[s.thread]?.requests[s.request], .answered, "a withdrawal never takes it back")
    }

    func testARewrittenRequestKeepsItsTextOverTheVerdict() {
        var w = World()
        let s = replied(&w, type: "setup", answer: ["type": "setup", "selection": ["model": "default", "effort": "default", "bypass": false]])
        w.deliver(kind: 5, from: w.bot, json: ["thread": "", "markdown": ""], re: s.reply)
        XCTAssertEqual(w.c.threads[s.thread]?.requests[s.request], .answered)
        w.deliver(kind: 11, from: w.bot, json: ["thread": s.thread, "markdown": "Set: default"], re: s.request)
        XCTAssertEqual(w.c.threads[s.thread]?.requests[s.request], .rewritten(markdown: "Set: default"), "written after the verdict")
        var v = World()
        let t = replied(&v, type: "setup", answer: ["type": "setup", "selection": ["model": "default", "effort": "default", "bypass": false]])
        v.deliver(kind: 11, from: v.bot, json: ["thread": t.thread, "markdown": "Set: default"], re: t.request)
        v.deliver(kind: 5, from: v.bot, json: ["thread": "", "markdown": ""], re: t.reply)
        XCTAssertEqual(v.c.threads[t.thread]?.requests[t.request], .rewritten(markdown: "Set: default"), "written before it")
    }

    func testARequestWithNoAcceptedReplyStaysWithdrawn() {
        var w = World()
        let s = replied(&w)
        w.deliver(kind: 5, from: w.bot, json: ["thread": "", "markdown": "could not read"], re: s.reply)
        w.deliver(kind: 11, from: w.bot, json: ["thread": s.thread, "withdrawn": true], re: s.request)
        XCTAssertEqual(w.c.threads[s.thread]?.requests[s.request], .withdrawn)
        XCTAssertNil(w.c.threads[s.thread]?.reason(of: s.request, from: w.alice), "a status other than open wins over a reason")
    }

    func testAStartACutAndANotReadOnAReplyMoveNoPrompt() {
        var w = World()
        let s = replied(&w)
        w.deliver(kind: 3, from: w.bot, json: [:], re: s.reply)
        XCTAssertEqual(w.c.threads[s.thread]?.requests[s.request], .replied, "a start is no verdict")
        XCTAssertNil(w.c.threads[s.thread]?.reason(of: s.request, from: w.alice))
        w.deliver(kind: 6, from: w.bot, json: [:], re: s.reply)
        XCTAssertEqual(w.c.threads[s.thread]?.prompts[s.prompt], .running)
        XCTAssertEqual(w.c.threads[s.thread]?.requests[s.request], .open)
        XCTAssertEqual(w.c.threads[s.thread]?.reason(of: s.request, from: w.alice), "The bot did not take this answer.")
        w.deliver(kind: 7, from: w.bot, json: [:], re: s.reply)
        XCTAssertEqual(w.c.threads[s.thread]?.prompts[s.prompt], .running)
        XCTAssertEqual(w.c.threads[s.thread]?.reason(of: s.request, from: w.alice), "The bot could not read this answer.")
    }

    func testAnAnswerToAPromptIsStillItsAnswer() {
        var w = World()
        let s = replied(&w)
        w.deliver(kind: 5, from: w.bot, json: ["thread": s.thread, "markdown": "done"], re: s.prompt)
        XCTAssertEqual(w.c.threads[s.thread]?.prompts[s.prompt], .answered)
        XCTAssertTrue(w.c.threads[s.thread]!.items.contains { if case .answer = $0 { true } else { false } })
    }

    func testAVerdictReadInARebuildFindsItsReply() {
        var w = World()
        let s = replied(&w)
        // A message delivered at a place already passed rebuilds the channel in position order.
        w.conversation.take(views: [
            w.view(kind: 5, from: w.bot, json: ["thread": "", "markdown": ""], at: 200, re: s.reply),
            w.view(kind: 1, from: w.alice, json: ["markdown": "late"], at: 3),
        ])
        XCTAssertEqual(w.c.threads[s.thread]?.requests[s.request], .answered)
    }
}

// The request's fields as the cards read them, from the body the bot wrote (`shown` in provider.ts).
extension ConversationTests {
    private func request(_ fields: [String: Any]) -> OwnerRequest? {
        let body: [String: Any] = ["thread": "t", "request": fields, "title": "x"]
        return OwnerRequest(json: String(decoding: try! JSONSerialization.data(withJSONObject: body), as: UTF8.self))
    }

    func testTheRequestsFieldsAreReadByType() throws {
        guard case .setup(let setup)? = request([
            "type": "setup", "bypassOffered": true, "efforts": ["low"], "selection": ["model": "default", "effort": "default", "bypass": false],
            "models": [["value": "sonnet", "isDefault": true, "resolvedModel": NSNull(), "displayName": "Sonnet", "description": NSNull(), "supportsEffort": true,
                        "supportedEffortLevels": ["low", "high"]]],
        ]) else { return XCTFail("no setup") }
        XCTAssertEqual(setup.models.map(\.displayName), ["Sonnet"])
        XCTAssertEqual(setup.models[0].supportedEffortLevels, ["low", "high"])
        XCTAssertEqual([setup.models[0].isDefault, setup.bypassOffered, setup.selection.bypass], [true, true, false])
        XCTAssertEqual(setup.efforts, ["low"])
        guard case .permission(let p)? = request(["type": "permission", "toolName": "Edit", "input": ["path": "a/b", "n": 1], "title": NSNull(), "description": "Edit a file", "plan": NSNull()])
        else { return XCTFail("no permission") }
        XCTAssertEqual([p.toolName, p.description], ["Edit", "Edit a file"])
        XCTAssertNil(p.title)
        XCTAssertNil(p.plan)
        XCTAssertEqual(p.input, "{\n  \"n\" : 1,\n  \"path\" : \"a/b\"\n}", "indented JSON, keys sorted")
        guard case .question(let q)? = request(["type": "question", "title": NSNull(), "questions": [
            ["header": "H", "text": "Which?", "multiSelect": true, "options": [["label": "a", "description": "A", "preview": NSNull()]]]]])
        else { return XCTFail("no question") }
        XCTAssertEqual([q[0].header, q[0].text], ["H", "Which?"])
        XCTAssertTrue(q[0].multiSelect)
        XCTAssertEqual(q[0].options.map(\.label), ["a"])
        XCTAssertEqual(q[0].options[0].description, "A")
        XCTAssertEqual(request(["type": "shell", "command": "ls\npwd", "folder": "docs"]), .shell(command: "ls\npwd", folder: "docs"))
        XCTAssertEqual(request(["type": "hold", "other": ["channel": "c", "thread": "t"], "link": "the other session"]), .hold(link: "the other session"))
        XCTAssertEqual(request(["type": "terminal", "state": "move", "running": "a turn", "command": NSNull()]),
                       .terminal(state: "move", running: "a turn", command: nil))
        XCTAssertNil(request(["type": "unknown"]), "a type this device does not know has no controls")
        XCTAssertNil(request(["type": "shell", "command": 3]), "a field of the wrong type is no request")
    }

    func testAMessageExposesItsRequest() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "go"], to: w.bot)
        w.deliver(kind: 9, from: w.bot, json: ["thread": root.hex, "title": "Run?", "request": ["type": "shell", "command": "ls", "folder": "."]], re: root)
        let m = w.c.messages.last!
        XCTAssertEqual(m.ownerRequest, .shell(command: "ls", folder: "."))
        XCTAssertNil(w.c.messages.first!.ownerRequest)
    }
}

// Who a verdict is trusted for (fix round): the reply must be to the session's bot, from a device whose prompt the bot started or one of the person's own.
extension ConversationTests {
    func testAStrangersReplyGetsNoVerdictEvenWhenItNamesTheBot() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "go"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        let request = w.deliver(kind: 9, from: w.bot, json: ["thread": root.hex, "title": "Allow?", "request": ["type": "permission"]], re: root)
        let stranger = Data(repeating: 8, count: 32)
        let reply = w.deliver(kind: 10, from: stranger, json: ["answer": ["type": "permission", "allow": true]], to: w.bot, re: request)
        w.deliver(kind: 5, from: w.bot, json: ["thread": "", "markdown": ""], re: reply)
        XCTAssertEqual(w.c.threads[root.hex]?.requests[request], .open, "neither replied nor answered")
    }

    func testAReplyToAnotherBotGetsNoVerdict() {
        var w = World()
        let other = Data(repeating: 4, count: 32)
        let s = replied(&w)
        let reply = w.deliver(kind: 10, from: w.alice, json: ["answer": ["type": "permission", "allow": true]], to: other, re: s.request)
        w.deliver(kind: 5, from: other, json: ["thread": "", "markdown": ""], re: reply)
        XCTAssertEqual(w.c.threads[s.thread]?.requests[s.request], .replied, "only the first reply, to the session's bot, counted")
    }

    func testAnOwnDeviceThatNeverPromptedHere() {
        var w = World()
        let mac = Data(repeating: 6, count: 32)
        w.conversation.setOwnDevices([mac])
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "go"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        let request = w.deliver(kind: 9, from: w.bot, json: ["thread": root.hex, "title": "Allow?", "request": ["type": "permission"]], re: root)
        let reply = w.deliver(kind: 10, from: mac, json: ["answer": ["type": "permission", "allow": true]], to: w.bot, re: request)
        XCTAssertEqual(w.c.threads[root.hex]?.requests[request], .replied, "a second Mac cannot reply twice")
        w.deliver(kind: 5, from: w.bot, json: ["thread": "", "markdown": ""], re: reply)
        XCTAssertEqual(w.c.threads[root.hex]?.requests[request], .answered)
        // Learned after the messages: the channels are read again.
        var late = World()
        let r2 = late.deliver(kind: 2, from: late.alice, json: ["text": "go"], to: late.bot)
        late.deliver(kind: 3, from: late.bot, json: [:], re: r2)
        let q2 = late.deliver(kind: 9, from: late.bot, json: ["thread": r2.hex, "title": "Allow?", "request": ["type": "permission"]], re: r2)
        late.deliver(kind: 10, from: mac, json: ["answer": ["type": "permission", "allow": true]], to: late.bot, re: q2)
        XCTAssertEqual(late.c.threads[r2.hex]?.requests[q2], .open)
        late.conversation.setOwnDevices([mac])
        XCTAssertEqual(late.c.threads[r2.hex]?.requests[q2], .replied)
    }

    func testTheOwnersRepliesAreNoThreadItems() {
        var w = World()
        let s = replied(&w)
        XCTAssertFalse(w.c.threads[s.thread]!.items.contains { if case .message(let m) = $0, m.kind == 10 { true } else { false } })
    }

    func testAVerdictMovesTheSessionsLastReply() {
        var w = World()
        let s = replied(&w)
        let before = w.c.threads[s.thread]?.lastReply
        w.deliver(kind: 5, from: w.bot, json: ["thread": "", "markdown": ""], re: s.reply, time: 1_800_000_000_000)
        XCTAssertGreaterThan(w.c.threads[s.thread]!.lastReply!, before!)
    }

    // MARK: control prompts (Stop and the mode words, sent by the app's own controls)

    /// A session whose turn runs, then a Stop prompt in its thread with the flag, its start and the bot's answer.
    private func stopped(_ w: inout World, control: Bool = true) -> (root: MessageRef, stop: MessageRef) {
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "build it"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        w.deliver(kind: 1, from: w.bot, json: ["thread": root.hex, "say": "say", "markdown": "working"], re: root)
        var fields: [String: Any] = ["text": "/stop", "thread": root.hex]
        if control { fields["control"] = true }
        let stop = w.deliver(kind: 2, from: w.alice, json: fields, to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: stop)
        w.deliver(kind: 4, from: w.bot, json: ["thread": root.hex, "markdown": "Stop"], re: stop)
        w.deliver(kind: 1, from: w.bot, json: ["thread": root.hex, "say": "tell", "markdown": "Stopping"], re: stop)
        w.deliver(kind: 5, from: w.bot, json: ["thread": root.hex, "markdown": "Stopped."], re: stop)
        return (root, stop)
    }

    func testAControlPromptItsStartAndItsAnswerDrawNothingAndMoveNothing() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "build it"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        w.deliver(kind: 1, from: w.bot, json: ["thread": root.hex, "say": "say", "markdown": "working"], re: root)
        let before = w.c.threads[root.hex]!
        let stop = w.deliver(kind: 2, from: w.alice, json: ["text": "/stop", "thread": root.hex, "control": true], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: stop, time: 1_800_000_000_000)
        w.deliver(kind: 4, from: w.bot, json: ["thread": root.hex, "markdown": "Stop"], re: stop, time: 1_800_000_000_000)
        w.deliver(kind: 1, from: w.bot, json: ["thread": root.hex, "say": "tell", "markdown": "Stopping"], re: stop, time: 1_800_000_000_000)
        w.deliver(kind: 5, from: w.bot, json: ["thread": root.hex, "markdown": "Stopped."], re: stop, time: 1_800_000_000_000)
        let after = w.c.threads[root.hex]!
        XCTAssertEqual(after.items, before.items)
        XCTAssertEqual(after.lastReply, before.lastReply)
        XCTAssertEqual(after.state, .running, "the turn's own prompt still runs")
        XCTAssertEqual(w.c.threads.count, 1)
        XCTAssertEqual(w.c.timeline, [10])
        XCTAssertEqual(w.c.sessions.map(\.key), [root.hex])
    }

    func testAPromptWithTheFlagFromAnotherSenderOrWithOtherTextIsDrawnWithItsWholeTurn() {
        var w = World()
        let stranger = Data(repeating: 7, count: 32)
        // Another sender, with a word of the controls: a top-level prompt like any other, and its thread.
        let theirs = w.deliver(kind: 2, from: stranger, json: ["text": "/stop", "control": true], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: theirs)
        w.deliver(kind: 5, from: w.bot, json: ["thread": theirs.hex, "markdown": "Stopped."], re: theirs)
        XCTAssertEqual(w.c.timeline, [10])
        XCTAssertEqual(w.c.threads[theirs.hex]?.items.count, 1)
        // The owner's own device, with text that is not a word of the controls.
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "go"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        let odd = w.deliver(kind: 2, from: w.alice, json: ["text": "rm everything", "thread": root.hex, "control": true], to: w.bot)
        w.deliver(kind: 5, from: w.bot, json: ["thread": root.hex, "markdown": "done"], re: odd)
        let items = w.c.threads[root.hex]!.items
        XCTAssertTrue(items.contains { if case .message(let m) = $0, m.ref == odd { true } else { false } })
        XCTAssertTrue(items.contains { if case .answer(let a) = $0 { a.markdown == "done" } else { false } })
    }

    func testAFlagThatIsNotABooleanIsNoControl() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "go"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        for (i, flag) in [1, "true", 0].enumerated() as EnumeratedSequence<[Any]> {
            let p = w.deliver(kind: 2, from: w.alice, json: ["text": "/stop", "thread": root.hex, "control": flag], to: w.bot)
            XCTAssertFalse(w.c.messages.last!.control, "case \(i)")
            XCTAssertTrue(w.c.threads[root.hex]!.items.contains { if case .message(let m) = $0, m.ref == p { true } else { false } })
        }
    }

    func testARequestNamingAControlPromptIsDrawnAndTheSessionWaits() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "go"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        let mode = w.deliver(kind: 2, from: w.alice, json: ["text": "/bypass off", "thread": root.hex, "control": true], to: w.bot)
        let request: [String: Any] = ["type": "permission"]
        let asked = w.deliver(kind: 9, from: w.bot, json: ["thread": root.hex, "request": request, "title": "Edit?"], re: mode)
        let t = w.c.threads[root.hex]!
        XCTAssertEqual(t.state, .waiting)
        XCTAssertTrue(t.items.contains { if case .message(let m) = $0, m.ref == asked { true } else { false } })
    }

    func testTheAnswerToAModeWordIsDrawnWithNoPromptAboveIt() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "go"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        let mode = w.deliver(kind: 2, from: w.alice, json: ["text": "/bypass on", "thread": root.hex, "control": true], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: mode)
        w.deliver(kind: 5, from: w.bot, json: ["thread": root.hex, "markdown": "Bypass is not available."], re: mode)
        let items = w.c.threads[root.hex]!.items
        XCTAssertTrue(items.contains { if case .answer(let a) = $0 { a.markdown == "Bypass is not available." } else { false } })
        XCTAssertFalse(items.contains { if case .message(let m) = $0, m.ref == mode { true } else { false } })
        XCTAssertEqual(w.c.threads[root.hex]?.state, .running, "the turn's own prompt still runs")
    }

    func testALineOfAStopsTurnIsStillDrawn() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "go"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        let stop = w.deliver(kind: 2, from: w.alice, json: ["text": "/stop", "thread": root.hex, "control": true], to: w.bot)
        let task: [String: Any] = ["title": "Run tests", "status": "in_progress"]
        w.deliver(kind: 1, from: w.bot, json: ["thread": root.hex, "say": "task", "task": task], re: stop)
        XCTAssertTrue(w.c.threads[root.hex]!.items.contains { if case .line = $0 { true } else { false } })
    }

    func testAStopTypedByTheOwnerIsStillDrawnWithItsAnswer() {
        var w = World()
        let s = stopped(&w, control: false)
        let items = w.c.threads[s.root.hex]!.items
        XCTAssertTrue(items.contains { if case .message(let m) = $0, case .prompt(let t) = m.body { t == "/stop" } else { false } })
        XCTAssertTrue(items.contains { if case .answer(let a) = $0 { a.markdown == "Stopped." } else { false } })
    }

    func testAControlPromptIsHeldInTheMessagesAndDrawnNowhere() {
        var w = World()
        let s = stopped(&w)
        XCTAssertTrue(w.c.messages.contains { $0.ref == s.stop && $0.control })
        let items = w.c.threads[s.root.hex]!.items
        XCTAssertFalse(items.contains { if case .message(let m) = $0, m.ref == s.stop { true } else { false } })
        XCTAssertFalse(items.contains { if case .answer = $0 { true } else { false } })
    }

    // MARK: a prompt answered as a word, or a session (#68)

    func testTheBotsLineThatAnswersAPromptSettlesItAsNoSessionAndSitsUnderIt() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "/bypass on"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        XCTAssertNil(w.c.threads[root.hex]?.settlement)
        XCTAssertEqual(w.c.threads[root.hex]?.unsettledNote(of: root), "Started", "only the start")
        let line = w.deliver(kind: 1, from: w.bot, json: ["say": "notice", "markdown": "Bypass applies inside a session."], re: root)
        w.deliver(kind: 5, from: w.bot, json: ["thread": root.hex, "markdown": "", "session": false], re: root)
        XCTAssertEqual(w.c.threads[root.hex]?.settlement, .noSession)
        XCTAssertEqual(w.c.timeline, [10], "the line is no message of the channel")
        XCTAssertEqual(w.c.threads[root.hex]?.items.count, 1)
        guard case .message(let under)? = w.c.threads[root.hex]?.items.first else { return XCTFail("no line under the prompt") }
        XCTAssertEqual(under.ref, line)
        XCTAssertTrue(w.c.sessions.isEmpty, "never in Sessions")
        XCTAssertNil(w.c.threads[root.hex]?.unsettledNote(of: root))
    }

    func testAnAnswerThatSaysNoSessionSettlesAWordWithNoLine() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "/stop"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        w.deliver(kind: 5, from: w.bot, json: ["thread": root.hex, "markdown": "", "session": false], re: root)
        XCTAssertEqual(w.c.threads[root.hex]?.settlement, .noSession)
        XCTAssertEqual(w.c.threads[root.hex]?.items.count, 0)
        XCTAssertEqual(w.c.threads[root.hex]?.prompts[root], .answered)
        XCTAssertTrue(w.c.sessions.isEmpty)
    }

    func testAnAnswerWithoutTheFlagAndASetupRequestAndAPartSettleASession() {
        var w = World()
        let resumed = w.deliver(kind: 2, from: w.alice, json: ["text": "/resume old"], to: w.bot)
        w.deliver(kind: 5, from: w.bot, json: ["thread": resumed.hex, "markdown": ""], re: resumed)
        let asked = w.deliver(kind: 2, from: w.alice, json: ["text": "go"], to: w.bot)
        w.deliver(kind: 9, from: w.bot, json: ["thread": asked.hex, "title": "Setup", "request": ["type": "setup"]], re: asked)
        let streamed = w.deliver(kind: 2, from: w.alice, json: ["text": "go on"], to: w.bot)
        w.deliver(kind: 4, from: w.bot, json: ["thread": streamed.hex, "markdown": "Working"], re: MessageRef(device: w.bot, name: Data(repeating: 0xCC, count: 16)))
        for key in [resumed, asked, streamed] { XCTAssertEqual(w.c.threads[key.hex]?.settlement, .session) }
        XCTAssertEqual(w.c.sessions.count, 3)
    }

    func testABotsTextInThePromptsOwnThreadIsASessionSign() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "x"], to: w.bot)
        w.deliver(kind: 1, from: w.bot, json: ["thread": root.hex, "say": "notice", "markdown": "Set: model default"])
        XCTAssertEqual(w.c.threads[root.hex]?.settlement, .session)
    }

    func testTheFirstSignWinsInPositionOrderAndNeverChanges() {
        var w = World()
        // A setup request came first: a session, whatever the answer's flag says after a cancel.
        let cancelled = w.deliver(kind: 2, from: w.alice, json: ["text": "go"], to: w.bot)
        w.deliver(kind: 9, from: w.bot, json: ["thread": cancelled.hex, "title": "Setup", "request": ["type": "setup"]], re: cancelled)
        w.deliver(kind: 5, from: w.bot, json: ["thread": cancelled.hex, "markdown": "", "session": false], re: cancelled)
        XCTAssertEqual(w.c.threads[cancelled.hex]?.settlement, .session)
        // A line first: a word, whatever follows.
        let word = w.deliver(kind: 2, from: w.alice, json: ["text": "/help"], to: w.bot)
        w.deliver(kind: 1, from: w.bot, json: ["say": "say", "markdown": "The words"], re: word)
        w.deliver(kind: 5, from: w.bot, json: ["thread": word.hex, "markdown": ""], re: word)
        XCTAssertEqual(w.c.threads[word.hex]?.settlement, .noSession)
    }

    func testACutSettlesNothingAndANotReadBeforeAnySignIsNotRun() {
        var w = World()
        let died = w.deliver(kind: 2, from: w.alice, json: ["text": "one"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: died)
        w.deliver(kind: 6, from: w.bot, json: [:], re: died)
        XCTAssertNil(w.c.threads[died.hex]?.settlement, "a run that died after it started is no prompt that never ran")
        XCTAssertEqual(w.c.threads[died.hex]?.prompts[died], .cut)
        XCTAssertEqual(w.c.threads[died.hex]?.unsettledNote(of: died), "Interrupted")
        XCTAssertEqual(w.c.sessions.count, 1, "listed: a silent session that crashed is not hidden")
        XCTAssertEqual(w.c.threads[died.hex]?.showsSummary(openedBy: 2), true, "its thread can be opened")
        w.deliver(kind: 4, from: w.bot, json: ["thread": died.hex, "markdown": "late"], re: MessageRef(device: w.bot, name: Data(repeating: 0xBB, count: 16)))
        XCTAssertEqual(w.c.threads[died.hex]?.settlement, .session, "a later sign decides")
        let unread = w.deliver(kind: 2, from: w.alice, json: ["text": "two"], to: w.bot)
        w.deliver(kind: 7, from: w.bot, json: [:], re: unread)
        XCTAssertEqual(w.c.threads[unread.hex]?.settlement, .notRun)
        XCTAssertEqual(w.c.threads[unread.hex]?.isWord, true)
        let word = w.deliver(kind: 2, from: w.alice, json: ["text": "/status"], to: w.bot)
        w.deliver(kind: 1, from: w.bot, json: ["say": "say", "markdown": "Status"], re: word)
        w.deliver(kind: 6, from: w.bot, json: [:], re: word)
        XCTAssertEqual(w.c.threads[word.hex]?.settlement, .noSession, "a cut after a sign: interrupted, not not run")
        XCTAssertEqual(w.c.threads[word.hex]?.prompts[word], .cut)
        XCTAssertEqual(w.c.threads[word.hex]?.showsSummary(openedBy: 2), false)
        XCTAssertEqual(w.c.sessions.count, 1)
    }

    func testATellInAnUnsettledWordsThreadIsNoSessionSign() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "/resume abc"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        w.deliver(kind: 1, from: w.bot, json: ["thread": root.hex, "say": "tell", "markdown": "Nothing is running in this session."])
        XCTAssertNil(w.c.threads[root.hex]?.settlement, "the bot's answer to a Stop typed in the thread is no sign")
        w.deliver(kind: 1, from: w.bot, json: ["say": "notice", "markdown": "The word's line."], re: root)
        w.deliver(kind: 5, from: w.bot, json: ["thread": root.hex, "markdown": "", "session": false], re: root)
        XCTAssertEqual(w.c.threads[root.hex]?.settlement, .noSession)
        XCTAssertTrue(w.c.sessions.isEmpty)
        // A tell, then an answer without the flag: still a session.
        let run = w.deliver(kind: 2, from: w.alice, json: ["text": "fix it"], to: w.bot)
        w.deliver(kind: 1, from: w.bot, json: ["thread": run.hex, "say": "tell", "markdown": "A refusal."])
        w.deliver(kind: 5, from: w.bot, json: ["thread": run.hex, "markdown": "done"], re: run)
        XCTAssertEqual(w.c.threads[run.hex]?.settlement, .session)
    }

    func testABotLineWithReAfterTheSessionSettledIsAnItemOfItsThread() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "fix it"], to: w.bot)
        w.deliver(kind: 5, from: w.bot, json: ["thread": root.hex, "markdown": "done"], re: root)
        let line = w.deliver(kind: 1, from: w.bot, json: ["say": "notice", "markdown": "A late refusal."], re: root)
        XCTAssertEqual(w.c.threads[root.hex]?.settlement, .session, "the first sign stands")
        XCTAssertEqual(w.c.threads[root.hex]?.items.count, 2)
        guard case .message(let item)? = w.c.threads[root.hex]?.items.last else { return XCTFail("no item") }
        XCTAssertEqual(item.ref, line)
        XCTAssertEqual(w.c.sessions.count, 1)
        XCTAssertEqual(w.c.timeline, [10], "no line of the channel")
    }

    func testALineWithReFromAnotherBotOrAPersonStaysAChannelLineInPlace() {
        var w = World()
        let other = Data(repeating: 4, count: 32)
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "hi"], to: w.bot)
        w.deliver(kind: 1, from: other, json: ["say": "notice", "markdown": "another bot"], re: root)
        w.deliver(kind: 1, from: w.alice, json: ["markdown": "a person"], re: root)
        XCTAssertNil(w.c.threads[root.hex]?.settlement)
        XCTAssertEqual(w.c.threads[root.hex]?.items.count, 0)
        XCTAssertEqual(w.c.timeline.count, 3, "each is a line of the channel")
    }

    func testALongLineInSeveralTextsDrawsEachInOrderUnderThePrompt() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "/help"], to: w.bot)
        let first = w.deliver(kind: 1, from: w.bot, json: ["say": "say", "markdown": "one"], re: root)
        let second = w.deliver(kind: 1, from: w.bot, json: ["say": "say", "markdown": "two"], re: root)
        let refs = w.c.threads[root.hex]?.items.compactMap { item -> MessageRef? in if case .message(let m) = item { m.ref } else { nil } }
        XCTAssertEqual(refs, [first, second])
    }

    func testAnOlderBotThatWritesNoFlagAndNoReKeepsTheOldReading() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "/bind demo"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: root)
        w.deliver(kind: 1, from: w.bot, json: ["say": "notice", "markdown": "Bound"]) // no `re`: a line of the channel
        w.deliver(kind: 5, from: w.bot, json: ["thread": root.hex, "markdown": ""], re: root)
        XCTAssertEqual(w.c.threads[root.hex]?.settlement, .session)
        XCTAssertEqual(w.c.sessions.count, 1)
    }

    func testTheLineAndTheAnswerSettleTheSameWhateverTheBatchOrder() {
        var w = World()
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": "/help"], to: w.bot)
        w.deliver(kind: 5, from: w.bot, json: ["thread": root.hex, "markdown": "", "session": false], re: root)
        w.deliver(kind: 1, from: w.alice, json: ["markdown": "later"], at: 13)
        // The line arrives at a place already passed: the channel is read again in position order, the line before the answer.
        w.deliver(kind: 1, from: w.bot, json: ["say": "say", "markdown": "late"], re: root, again: true, at: 12)
        XCTAssertEqual(w.c.threads[root.hex]?.settlement, .noSession)
        XCTAssertEqual(w.c.threads[root.hex]?.items.count, 1)
        XCTAssertEqual(w.c.timeline, [10, 13])
    }

    /// The `names` effect of the link (names design 3): a name for a channel, the person or a device, `null` when none shows now.
    func testTheNamesTheLinkTellsAreKeptByTheIdTheyName() {
        var model = ReadingModel()
        let (channel, person, device) = (Data(repeating: 1, count: 32), Data(repeating: 2, count: 32), Data(repeating: 3, count: 32))
        func effect(_ kind: Double, _ target: Data, _ name: HostValue) -> HostValue { .object(["kind": .number(kind), "target": .bytes(target), "name": name]) }
        model.take(names: .object(["do": .string("names"), "names": .array([
            effect(14, channel, .string("docs")), effect(15, person, .string("Ada")), effect(16, device, .string("Mac one")),
        ])]))
        XCTAssertEqual(model.names.channels[channel], "docs")
        XCTAssertEqual(model.names.persons[person], "Ada")
        XCTAssertEqual(model.names.devices[device], "Mac one")
        model.take(names: .object(["do": .string("names"), "names": .array([effect(14, channel, .null)])]))
        XCTAssertNil(model.names.channels[channel], "a name that no longer shows is dropped")
        XCTAssertEqual(model.names.persons[person], "Ada", "the others stay")
    }

    // MARK: the bind answer (channel folder design, 2)

    private func bindAnswer(_ w: inout World, text: String = "/bind /srv/code/demo", bind: [String: Any]? = ["folder": "/srv/code/demo", "state": "usable"],
                            from sender: Data? = nil, markdown: String = "Bound this channel to `/srv/code/demo`.") -> MessageRef {
        let root = w.deliver(kind: 2, from: w.alice, json: ["text": text], to: w.bot)
        var content: [String: Any] = ["say": "notice", "markdown": markdown]
        if let bind { content["bind"] = bind }
        w.deliver(kind: 1, from: sender ?? w.bot, json: content, re: root)
        return root
    }

    func testABindPromptWhoseAnswerCarriesTheFieldIsNotDrawnAndNorIsItsLine() {
        var w = World()
        let root = bindAnswer(&w)
        XCTAssertEqual(w.c.timeline, [], "the prompt is hidden")
        XCTAssertEqual(w.c.threads[root.hex]?.items.count, 1, "its line stays under it, undrawn with it")
        XCTAssertEqual(w.c.bound?.bind, Bind(folder: "/srv/code/demo", state: .usable))
        XCTAssertEqual(w.c.bound?.bot, w.bot)
        XCTAssertEqual(w.c.bound?.text, "Bound this channel to `/srv/code/demo`.")
    }

    func testABindPromptWithNoSuchAnswerIsDrawnAsToday() {
        var w = World()
        _ = bindAnswer(&w, bind: nil, markdown: "That folder is not allowed.")
        XCTAssertEqual(w.c.timeline, [10], "an answer with no field: prompt and refusal stay")
        XCTAssertNil(w.c.bound)
        let lone = w.deliver(kind: 2, from: w.alice, json: ["text": "/bind /srv/code/other"], to: w.bot)
        XCTAssertEqual(w.c.timeline, [10, 12], "no answer yet")
        XCTAssertNotNil(w.c.threads[lone.hex])
    }

    func testTheFieldCountsOnlyFromTheBotThePromptWentTo() {
        var w = World()
        _ = bindAnswer(&w, from: w.alice)
        XCTAssertTrue(w.c.timeline.contains(10), "another sender's line is no answer: the prompt stays")
        XCTAssertNil(w.c.bound)
    }

    func testThePromptsTextDoesNotDecide() {
        var w = World()
        _ = bindAnswer(&w, text: " /Bind\n/srv/code/demo")
        XCTAssertEqual(w.c.timeline, [], "the bot parses it as a bind, so the field is what counts")
        XCTAssertNotNil(w.c.bound)
    }

    func testANewerFieldReplacesTheOlder() {
        var w = World()
        _ = bindAnswer(&w)
        _ = bindAnswer(&w, text: "/bind /srv/code/other", bind: ["folder": "/srv/code/other", "state": "missing"])
        XCTAssertEqual(w.c.bound?.bind, Bind(folder: "/srv/code/other", state: .missing))
        XCTAssertEqual(w.c.timeline, [])
    }
}
