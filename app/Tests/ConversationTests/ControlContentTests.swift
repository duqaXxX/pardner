// The `control` field of a prompt's content: every case of the fixture the bot's tests share, read from the repository.
import Conversation
import Foundation
import ProtocolHost
import XCTest

final class ControlContentTests: XCTestCase {
    private static let fixture = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("test/protocol/content-vectors/control-content.json")

    func testEveryCaseOfTheSharedFixtureReadsAsItSays() throws {
        let file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.fixture)) as? [String: Any])
        let cases = try XCTUnwrap(file["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 10)
        for c in cases {
            let name = c["name"] as? String ?? "?"
            let text = String(decoding: try JSONSerialization.data(withJSONObject: c["content"] as Any), as: UTF8.self)
            let view: HostValue = .object([
                "do": .string("message"), "position": .number(1), "channel": .bytes(Data(repeating: 1, count: 32)),
                "sender": .bytes(Data(repeating: 3, count: 32)), "name": .bytes(Data(repeating: 4, count: 16)), "time": .number(1_700_000_000_000),
                "kind": .number(2), "text": .string(text),
            ])
            let message = try XCTUnwrap(Message(view: view), name)
            XCTAssertEqual(message.control, c["control"] as? Bool, name)
        }
    }
}
