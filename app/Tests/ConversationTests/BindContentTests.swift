// The `bind` field of a bot's kind 1 content (channel folder design, 1): every case of the fixture the bot's tests share, read from the repository.
import Conversation
import Foundation
import ProtocolHost
import XCTest

final class BindContentTests: XCTestCase {
    private static let fixture = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("test/protocol/content-vectors/bind-content.json")

    func testEveryCaseOfTheSharedFixtureReadsAsItSays() throws {
        let file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.fixture)) as? [String: Any])
        let cases = try XCTUnwrap(file["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 9)
        for c in cases {
            let name = c["name"] as? String ?? "?"
            let text = String(decoding: try JSONSerialization.data(withJSONObject: c["content"] as Any), as: UTF8.self)
            let view: HostValue = .object([
                "do": .string("message"), "position": .number(1), "channel": .bytes(Data(repeating: 1, count: 32)),
                "sender": .bytes(Data(repeating: 3, count: 32)), "name": .bytes(Data(repeating: 4, count: 16)), "time": .number(1_700_000_000_000),
                "kind": .number(1), "text": .string(text),
            ])
            let message = try XCTUnwrap(Message(view: view), name)
            let expected = c["bind"] as? [String: String]
            XCTAssertEqual(message.bind.map { ["folder": $0.folder, "state": $0.state.rawValue] }, expected, name)
            XCTAssertEqual(message.body, .text(markdown: "Bound this channel to `/srv/code/demo`.", say: "notice"), "\(name): the text is drawn whatever the field says")
        }
    }
}
