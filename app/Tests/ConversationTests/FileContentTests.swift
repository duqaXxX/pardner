// The file a call's path names, as the reading model folds it (file-content design, 3.1, 3.3 and 3.4): a line's `path`, the hidden prompt of a
// click and the bot's answers to it, and the file row. Synthetic content, shaped as the bot's tests write it.
import Conversation
import Foundation
import ProtocolHost
import XCTest

private func file(_ name: String = "notes.md", size: Int = 12) -> HostValue {
    .object(["blob": .bytes(Data(repeating: 7, count: 32)), "size": .number(Double(size)), "type": .string("application/octet-stream"), "name": .string(name)])
}

private func task(_ status: String, path: String? = nil) -> [String: Any] {
    var t: [String: Any] = ["title": "Read(/work/notes.md)", "status": status, "details": NSNull(), "output": NSNull(), "task": false, "message": false,
                            "calls": 0, "preview": NSNull(), "startedAt": NSNull()]
    if let path { t["path"] = path }
    return t
}

final class FileContentTests: XCTestCase {
    private struct Scene {
        var w = World()
        let session: MessageRef
        init() {
            session = w.deliver(kind: 2, from: w.alice, json: ["text": "read it"], to: w.bot)
            w.deliver(kind: 3, from: w.bot, json: [:], re: session)
        }
        var thread: MessageThread { w.c.threads[session.hex]! }
        mutating func click(from sender: Data? = nil, flag: Any = true) -> MessageRef {
            w.deliver(kind: 2, from: sender ?? w.alice, json: ["thread": session.hex, "text": "/open /work/notes.md", "open": flag], to: w.bot)
        }
    }

    private func ended(_ s: Scene, _ ref: MessageRef) -> Date? {
        guard case .line(let l)? = s.thread.items.first(where: { if case .line(let l) = $0 { l.ref == ref } else { false } }) else { return nil }
        return l.ended
    }

    func testALineKeepsItsPathAndTheTimeOfTheEditThatClosedIt() {
        var s = Scene()
        let line = s.w.deliver(kind: 1, from: s.w.bot, json: ["thread": s.session.hex, "say": "task", "task": task("in_progress", path: "/work/notes.md")], re: s.session)
        guard case .line(let first)? = s.thread.items.last else { return XCTFail("no line") }
        XCTAssertEqual(first.fields.path, "/work/notes.md")
        XCTAssertNil(first.ended)
        s.w.deliver(kind: 11, from: s.w.bot, json: ["thread": s.session.hex, "task": task("complete", path: "/work/notes.md")], re: line, time: 1_700_000_500_000)
        XCTAssertEqual(ended(s, line), Date(timeIntervalSince1970: 1_700_000_500))
        s.w.deliver(kind: 11, from: s.w.bot, json: ["thread": s.session.hex, "task": task("complete", path: "/work/notes.md")], re: line, time: 1_700_000_900_000)
        XCTAssertEqual(ended(s, line), Date(timeIntervalSince1970: 1_700_000_500), "a later edit of a closed line does not move its end")
    }

    func testALineFirstSeenClosedEndsAtItsOwnMessage() {
        var s = Scene()
        let line = s.w.deliver(kind: 1, from: s.w.bot, json: ["thread": s.session.hex, "say": "task", "task": task("complete", path: "/work/notes.md")], re: s.session, time: 1_700_000_300_000)
        XCTAssertEqual(ended(s, line), Date(timeIntervalSince1970: 1_700_000_300))
    }

    func testAClickIsNoRowOnTheOwnersDevicesAndOpensNoThread() {
        var s = Scene()
        let before = s.thread.items.count
        let click = s.click()
        XCTAssertEqual(s.thread.items.count, before, "no row")
        XCTAssertNil(s.thread.prompts[click], "not a prompt of the thread")
        XCTAssertEqual(s.w.c.opens[click]?.answer, .sent)
        XCTAssertNil(s.w.c.threads[click.hex], "a click opens no thread of its own")
    }

    func testAnotherMembersPromptWithTheFieldIsDrawnAsAPrompt() {
        var s = Scene()
        let other = s.click(from: Data(repeating: 9, count: 32))
        XCTAssertNil(s.w.c.opens[other], "not hidden: the owner sees what was sent to the bot")
        XCTAssertEqual(s.thread.prompts[other], .sent)
    }

    func testOnlyAJsonBooleanMarksAClick() {
        var s = Scene()
        let one = s.click(flag: 1)
        XCTAssertNil(s.w.c.opens[one], "1 is not true")
        XCTAssertEqual(s.thread.prompts[one], .sent)
    }

    func testTheAnswerIsMatchedByReAndOnlyFromTheBotTheClickWentTo() throws {
        var s = Scene()
        let first = s.click(), second = s.click()
        let stranger = Data(repeating: 8, count: 32)
        s.w.deliver(kind: 3, from: stranger, json: [:], re: first)
        XCTAssertEqual(s.w.c.opens[first]?.answer, .sent, "another bot's start is nothing")
        s.w.deliver(kind: 3, from: s.w.bot, json: [:], re: first)
        XCTAssertEqual(s.w.c.opens[first]?.answer, .started)
        s.w.deliver(kind: 5, from: s.w.bot, json: ["thread": s.session.hex, "markdown": "", "modified": 1_700_000_900_000], re: second, files: [file()])
        XCTAssertEqual(s.w.c.opens[first]?.answer, .started, "the answer to the other click does not reach this one")
        guard case .file(let info, let modified, _, _)? = s.w.c.opens[second]?.answer else { return XCTFail("no file") }
        XCTAssertEqual(info.name, "notes.md")
        XCTAssertEqual(modified, Date(timeIntervalSince1970: 1_700_000_900))
        XCTAssertFalse(s.thread.items.contains { if case .answer = $0 { true } else { false } }, "the answer is no row")
    }

    func testARefusalACutAndALateStart() {
        var s = Scene()
        let refused = s.click(), cut = s.click()
        s.w.deliver(kind: 5, from: s.w.bot, json: ["thread": s.session.hex, "markdown": "That file is too large."], re: refused)
        XCTAssertEqual(s.w.c.opens[refused]?.answer, .refused("That file is too large."))
        s.w.deliver(kind: 3, from: s.w.bot, json: [:], re: refused)
        XCTAssertEqual(s.w.c.opens[refused]?.answer, .refused("That file is too large."), "a start does not undo an answer")
        s.w.deliver(kind: 6, from: s.w.bot, json: [:], re: cut)
        XCTAssertEqual(s.w.c.opens[cut]?.answer, .cut)
    }

    func testAFileRowIsAMessageOfTheThreadWithItsFile() throws {
        var s = Scene()
        s.w.deliver(kind: 1, from: s.w.bot, json: ["thread": s.session.hex, "say": "file", "title": "notes.md"], files: [file()])
        guard case .message(let m)? = s.thread.items.last else { return XCTFail("no row") }
        XCTAssertEqual(m.body, .file(title: "notes.md"))
        XCTAssertEqual(m.files.first?.size, 12)
        s.w.deliver(kind: 1, from: s.w.bot, json: ["thread": s.session.hex, "say": "tell", "title": "notes.md", "markdown": "notes.md could not be sent."])
        guard case .message(let lost)? = s.thread.items.last, case .text(let markdown, let say) = lost.body else { return XCTFail("no text") }
        XCTAssertEqual([markdown, say], ["notes.md could not be sent.", "tell"])
    }
}
