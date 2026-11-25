// The images a call's result held (step E2 design 3.1): a kind 1 `say` "image" of the thread's bot, which names its line in `line` and carries the
// images as files, is no item of the thread; the thread keeps its files under the line. Over views shaped as the link delivers them; synthetic content.
@testable import Conversation
import Foundation
import ProtocolHost
import XCTest

private func file(_ name: String = "image-1.png", _ byte: UInt8 = 7, size: Int = 113) -> HostValue {
    .object(["blob": .bytes(Data(repeating: byte, count: 32)), "size": .number(Double(size)), "type": .string("image/png"), "name": .string(name)])
}

private func task(_ title: String = "Read(shot.png)") -> [String: Any] {
    ["title": title, "status": "complete", "details": NSNull(), "output": NSNull(), "task": false, "message": false, "calls": 0,
     "preview": NSNull(), "startedAt": NSNull()]
}

private struct Scene {
    var w = World()
    let session: MessageRef

    init() {
        session = w.deliver(kind: 2, from: w.alice, json: ["text": "take a screenshot"], to: w.bot)
        w.deliver(kind: 3, from: w.bot, json: [:], re: session)
    }

    @discardableResult
    mutating func line(_ title: String = "Read(shot.png)") -> MessageRef {
        w.deliver(kind: 1, from: w.bot, json: ["thread": session.hex, "say": "task", "task": task(title)], re: session)
    }

    @discardableResult
    mutating func image(of line: MessageRef, from sender: Data? = nil, files: [HostValue]? = nil, extra: [String: Any] = [:]) -> MessageRef {
        let body: [String: Any] = ["thread": session.hex, "say": "image", "line": line.name.hexString].merging(extra) { _, new in new }
        return w.deliver(kind: 1, from: sender ?? w.bot, json: body, files: files ?? [file()])
    }

    var thread: MessageThread { w.c.threads[session.hex]! }
}

final class LineImagesTests: XCTestCase {
    func testTheImagesOfALineAreKeptUnderItAndAreNoItem() throws {
        var s = Scene()
        let line = s.line()
        let before = s.thread.items.count
        s.image(of: line, files: [file("image-1.png", 7), file("image-2.png", 8)])
        XCTAssertEqual(s.thread.items.count, before, "no item")
        let kept = try XCTUnwrap(s.thread.images[line])
        XCTAssertEqual(kept.map(\.name), ["image-1.png", "image-2.png"])
        XCTAssertEqual(kept.map(\.blob), [Data(repeating: 7, count: 32), Data(repeating: 8, count: 32)])
        XCTAssertEqual(kept.map(\.type), ["image/png", "image/png"])
    }

    func testAnImageThatLandsAfterLaterLinesAndTheWorksEndIsFoundByItsLine() throws {
        var s = Scene()
        let first = s.line("Read(a.png)")
        s.line("Bash(ls)")
        s.w.deliver(kind: 5, from: s.w.bot, json: ["thread": s.session.hex, "markdown": "Done."], re: s.session)
        s.image(of: first)
        XCTAssertNotNil(s.thread.images[first])
        XCTAssertEqual(s.thread.items.count, 3, "two lines and the answer")
    }

    func testItNeverClearsTheHintNorMovesTheLastReply() throws {
        var s = Scene()
        let line = s.line()
        s.w.deliver(kind: 1, from: s.w.bot, json: ["thread": s.session.hex, "say": "next", "next": "run the tests"])
        XCTAssertEqual(s.thread.hint, "run the tests")
        let last = s.thread.lastReply
        s.image(of: line)
        XCTAssertEqual(s.thread.hint, "run the tests")
        XCTAssertEqual(s.thread.lastReply, last)
    }

    func testAnImageOfAnUnknownLineIsKeptUnderThatNameAndMatchesNoLine() throws {
        var s = Scene()
        let line = s.line()
        let ghost = MessageRef(device: s.w.bot, name: Data(repeating: 0xEE, count: 16))
        s.w.deliver(kind: 1, from: s.w.bot, json: ["thread": s.session.hex, "say": "image", "line": ghost.name.hexString], files: [file()])
        XCTAssertNil(s.thread.images[line], "the line it was not for has none")
        XCTAssertEqual(s.thread.items.count, 1, "no item for it")
        for case .line(let l) in s.thread.items { XCTAssertNil(s.thread.images[l.ref]) }
    }

    func testAnImageTextFromAnyoneButTheThreadsBotIsNothing() throws {
        var s = Scene()
        let line = s.line()
        s.image(of: line, from: Data(repeating: 9, count: 32))
        XCTAssertNil(s.thread.images[line])
        XCTAssertEqual(s.thread.items.count, 1)
    }

    func testAnImageTextWithNoFileOrNoReadableLineKeepsNothing() throws {
        var s = Scene()
        let line = s.line()
        s.image(of: line, files: [])
        XCTAssertNil(s.thread.images[line], "no file")
        s.w.deliver(kind: 1, from: s.w.bot, json: ["thread": s.session.hex, "say": "image", "line": "zz"], files: [file()])
        s.w.deliver(kind: 1, from: s.w.bot, json: ["thread": s.session.hex, "say": "image", "line": "11"], files: [file()])
        s.w.deliver(kind: 1, from: s.w.bot, json: ["thread": s.session.hex, "say": "image", "line": 5], files: [file()])
        XCTAssertTrue(s.thread.images.isEmpty)
    }

    func testAnImageTextAgainReplacesTheLinesFilesAndOtherLinesKeepTheirs() throws {
        var s = Scene()
        let one = s.line("Read(a.png)")
        let two = s.line("Read(b.png)")
        s.image(of: one, files: [file("image-1.png", 1)])
        s.image(of: two, files: [file("image-1.png", 2)])
        s.image(of: one, files: [file("image-1.png", 3)])
        XCTAssertEqual(s.thread.images[one]?.first?.blob, Data(repeating: 3, count: 32))
        XCTAssertEqual(s.thread.images[two]?.first?.blob, Data(repeating: 2, count: 32))
    }
}
