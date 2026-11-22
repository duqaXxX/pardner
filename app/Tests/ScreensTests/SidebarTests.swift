// The sidebar's decisions (window redesign, unit 1c): a channel's bare name and the count of its threads that wait for the person.
// Over the synthetic samples.
import Conversation
import Foundation
import ProtocolHost
@testable import Screens
import XCTest

final class SidebarTests: XCTestCase {
    func testTheBareNameHasNoHash() throws {
        let sample = Samples.model()
        XCTAssertFalse(Naming.bareChannel(sample.channel, in: sample.model).hasPrefix("#"))
        XCTAssertEqual(Naming.channel(sample.channel, in: sample.model), "#" + Naming.bareChannel(sample.channel, in: sample.model))
        XCTAssertEqual(Naming.bareChannel(Data([1, 2, 3, 4, 5]), in: sample.model), "01020304")
    }

    func testTheRowCountsTheThreadsThatWait() throws {
        let sample = Samples.model()
        let channel = try XCTUnwrap(sample.model.channels[sample.channel])
        XCTAssertEqual(Sidebar.waitingCount(channel), 1)
    }

    func testAChannelWithNothingWaitingCarriesNoCount() throws {
        var model = ReadingModel()
        model.take(view: .object([
            "do": .string("message"), "position": .number(1), "channel": .bytes(Samples.channel), "sender": .bytes(Samples.bob),
            "name": .bytes(Data(repeating: 1, count: 16)), "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(1_763_600_000_000),
            "kind": .number(1), "to": .null, "blobs": .array([]), "files": .array([]), "re": .null, "again": .bool(false),
            "text": .string(#"{"markdown":"Morning."}"#),
        ]))
        XCTAssertNil(Sidebar.waitingCount(try XCTUnwrap(model.channels[Samples.channel])))
    }
}
