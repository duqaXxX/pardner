// The texts of the session's bot around its turn (step D2 design, 3.1 and 3.2): every case of the fixture the bot's tests share, read from the repository.
import Conversation
import Foundation
import ProtocolHost
import XCTest

final class SessionTextContentTests: XCTestCase {
    private static let fixture = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("test/protocol/content-vectors/session-text-content.json")

    private func file() throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.fixture)) as? [String: Any])
    }

    private func usage(_ value: Any?) -> SessionUsage? {
        guard let o = value as? [String: Any] else { return nil }
        func window(_ key: String) -> UsageWindow? {
            guard let w = o[key] as? [String: Any], let percent = w["percent"] as? Double else { return nil }
            return UsageWindow(percent: percent, resetsAt: w["resetsAt"] as? Double)
        }
        return SessionUsage(at: o["at"] as! Double, session: window("session"), week: window("week"), cost: o["cost"] as? Double)
    }

    func testEveryTextOfTheSharedFixtureReadsAsItSays() throws {
        let texts = try XCTUnwrap(file()["texts"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(texts.count, 8)
        for t in texts {
            let name = t["name"] as? String ?? "?"
            let text = String(decoding: try JSONSerialization.data(withJSONObject: t["content"] as Any), as: UTF8.self)
            let view: HostValue = .object([
                "do": .string("message"), "position": .number(1), "channel": .bytes(Data(repeating: 1, count: 32)),
                "sender": .bytes(Data(repeating: 3, count: 32)), "name": .bytes(Data(repeating: 4, count: 16)), "time": .number(1_700_000_000_000),
                "kind": .number(1), "text": .string(text),
            ])
            let message = try XCTUnwrap(Message(view: view), name)
            let reads = try XCTUnwrap(t["reads"] as? [String: Any], name)
            switch reads["kind"] as? String {
            case "footer":
                guard case .footer(let duration, let session, let usage)? = message.sessionText else { XCTFail("\(name): not a footer"); continue }
                XCTAssertEqual(duration, reads["duration"] as? String, name)
                XCTAssertEqual(session, reads["session"] as? String, name)
                XCTAssertEqual(usage, self.usage(reads["usage"]), name)
            case "title":
                guard case .title(let title)? = message.sessionText else { XCTFail("\(name): not a title"); continue }
                XCTAssertEqual(title, reads["title"] as? String, name)
            default: XCTFail("\(name): unknown kind")
            }
        }
    }

    func testEveryUsageLineOfTheSharedFixtureIsWrittenAsTheCoreWritesIt() throws {
        let lines = try XCTUnwrap(file()["usageLines"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(lines.count, 11)
        for l in lines {
            let name = l["name"] as? String ?? "?"
            let zone = try XCTUnwrap(TimeZone(identifier: try XCTUnwrap(l["timeZone"] as? String)), name)
            let now = Date(timeIntervalSince1970: try XCTUnwrap(l["now"] as? Double) / 1000)
            let place = try XCTUnwrap(UsageLine.Place(rawValue: try XCTUnwrap(l["place"] as? String)), name)
            let text = UsageLine.text(profileRead: try XCTUnwrap(l["profileRead"] as? Bool), plan: l["plan"] as? String, windows: usage(l["windows"]),
                                      cost: usage(l["cost"]), apiSeen: try XCTUnwrap(l["apiSeen"] as? Bool), place: place, now: now, timeZone: zone)
            XCTAssertEqual(text, l["text"] as? String, name)
        }
    }

    /// A usage whose numbers no drawing could turn into an `Int` is not read: the Bots row never traps.
    func testAUsageWithOutOfRangeNumbersIsNotRead() throws {
        let cases: [[String: Any]] = [
            ["at": 1, "session": ["percent": 1e20, "resetsAt": NSNull()]],
            ["at": 1, "session": ["percent": 40, "resetsAt": 1e300]],
            ["at": 1e300, "week": ["percent": 40, "resetsAt": NSNull()]],
            ["at": 1, "week": ["percent": -1, "resetsAt": NSNull()]],
            ["at": 1, "cost": true],
            ["at": true, "week": ["percent": 40, "resetsAt": NSNull()]],
            ["at": 1, "cost": 1e300],
            ["at": 1, "cost": -0.5],
        ]
        for (index, usage) in cases.enumerated() {
            let content: [String: Any] = ["say": "footer", "markdown": "5s", "usage": usage]
            let text = String(decoding: try JSONSerialization.data(withJSONObject: content), as: UTF8.self)
            let view: HostValue = .object([
                "do": .string("message"), "position": .number(1), "channel": .bytes(Data(repeating: 1, count: 32)),
                "sender": .bytes(Data(repeating: 3, count: 32)), "name": .bytes(Data(repeating: 4, count: 16)), "time": .number(1_700_000_000_000),
                "kind": .number(1), "text": .string(text),
            ])
            let message = try XCTUnwrap(Message(view: view), "case \(index)")
            guard case .footer(_, _, let read)? = message.sessionText else { XCTFail("case \(index): not a footer"); continue }
            XCTAssertNil(read, "case \(index)")
        }
    }
}
