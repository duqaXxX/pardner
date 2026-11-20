// The app's connection against a real relay: test/protocol/app-relay.test.ts starts the relay, enrols
// the device, runs this file with `swift test --filter RelayConnectionTests` and keeps step with it by
// files: `<dir>/<name>.step` created by this side, then the wait for `<dir>/<name>.done`. Run alone, the tests fail on the missing environment: none passes on nothing.
import Foundation
import Platform
@testable import ProtocolHost
@testable import Relay
import XCTest

/// Every event of a connection with the time it came: a test reads it from an index on, so what it waited for before is not matched again.
private final class Log: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [(at: ContinuousClock.Instant, event: RelayEvent)] = []

    init(_ connection: RelayConnection) {
        let events = connection.events
        Task { for await event in events { self.append(event) } }
    }

    private func append(_ event: RelayEvent) {
        lock.lock()
        items.append((.now, event))
        lock.unlock()
    }

    var count: Int { lock.lock(); defer { lock.unlock() }; return items.count }

    func entries(from index: Int) -> [(at: ContinuousClock.Instant, event: RelayEvent)] {
        lock.lock(); defer { lock.unlock() }
        return Array(items.dropFirst(index))
    }

    /// The index of the first event from `index` on that `matches`, once it comes, or nil after `seconds`.
    func wait(from index: Int, seconds: Double, _ matches: (RelayEvent) -> Bool) async -> Int? {
        let deadline = ContinuousClock.now.advanced(by: .seconds(seconds))
        while ContinuousClock.now < deadline {
            if let found = entries(from: index).firstIndex(where: { matches($0.event) }) { return index + found }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return nil
    }

    func at(_ index: Int) -> ContinuousClock.Instant { entries(from: index).first!.at }
}

private func isDelivered(_ event: RelayEvent, _ kind: String) -> Bool {
    if case .delivered(let view) = event { return view["do"]?.stringValue == kind }
    return false
}

private func isDialing(_ event: RelayEvent) -> Bool {
    if case .dialing = event { return true }
    return false
}

final class RelayConnectionTests: XCTestCase {
    func env(_ name: String) throws -> String {
        try XCTUnwrap(ProcessInfo.processInfo.environment[name], "\(name) is not set: run test/protocol/app-relay.test.ts")
    }

    func text(_ data: Data?) -> String { (data ?? Data()).map { String(format: "%02x", $0) }.joined() }

    /// The device's keys, made by the Node side per run, put under the names the app's store holds.
    func makeStore() throws -> SoftwareKeyStore {
        struct Held: Decodable { let use: String; let sk: String }
        let held = try JSONDecoder().decode([String: Held].self, from: Data(contentsOf: URL(fileURLWithPath: try env("PARDNER_KEY_FILE"))))
        let store = SoftwareKeyStore()
        _ = try store.importKey("device.sign", "sign", hex(try XCTUnwrap(held["app1.s"]).sk))
        _ = try store.importKey("device.receive", "receive", hex(try XCTUnwrap(held["app1.r"]).sk))
        return store
    }

    /// The link's store for these keys and relay in `folder`.
    func linkStore(_ folder: URL, _ store: KeyStore, _ endpoint: RelayEndpoint) throws -> LinkStore {
        try LinkStore(folder: folder, identity: LinkIdentity(
            signing: try store.publicKey("device.sign"), receiving: try store.publicKey("device.receive"), relay: endpoint.pin))
    }

    /// A fresh folder for a connection's store, removed when the test ends.
    func storeFolder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("pardner-store-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        return folder
    }

    func makeConnection(pin: Data? = nil, folder: URL? = nil, constants: [String: HostValue]) async throws -> RelayConnection {
        let store = try makeStore()
        let host = try await ProtocolHost(scriptPath: try env("PARDNER_JOINED_SCRIPT"), store: store)
        let held = hex(try env("PARDNER_RELAY_PIN"))
        let endpoint = RelayEndpoint(host: "127.0.0.1", port: UInt16(try env("PARDNER_RELAY_PORT"))!, pin: pin ?? held)
        return try RelayConnection(host: host, store: store, person: hex(try env("PARDNER_PERSON")), endpoint: endpoint, linkStore: try linkStore(folder ?? storeFolder(), store, endpoint), constants: constants)
    }

    /// Tells the Node side a step was reached, and waits for it to say its part is done.
    func step(_ name: String) async throws {
        // A file, not a line on standard error: `swift test` holds a test's stderr until the run ends.
        // Written under another name and renamed, so the Node side never finds it half made.
        let folder = URL(fileURLWithPath: try env("PARDNER_SYNC_DIR"))
        let temporary = folder.appendingPathComponent("\(name).step.tmp")
        try Data().write(to: temporary)
        try FileManager.default.moveItem(at: temporary, to: folder.appendingPathComponent("\(name).step"))
        let done = folder.appendingPathComponent("\(name).done").path
        let deadline = ContinuousClock.now.advanced(by: .seconds(300))
        while !FileManager.default.fileExists(atPath: done) {
            XCTAssertLessThan(ContinuousClock.now, deadline, "the Node side never finished step \(name)")
            if ContinuousClock.now >= deadline { throw CancellationError() }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    /// A connection to a port nothing listens on, with a host of its own and no relay: for the tests of the driver's own rules.
    func makeLonelyConnection(constants: [String: HostValue]) async throws -> RelayConnection {
        let store = SoftwareKeyStore()
        _ = try store.make("device.sign", .sign)
        _ = try store.make("device.receive", .receive)
        let host = try await ProtocolHost(scriptPath: try env("PARDNER_JOINED_SCRIPT"), store: store)
        // A port that was free a moment ago: bound, read, closed.
        let probe = socket(AF_INET, SOCK_STREAM, 0)
        var address = sockaddr_in(sin_len: UInt8(MemoryLayout<sockaddr_in>.size), sin_family: sa_family_t(AF_INET), sin_port: 0, sin_addr: in_addr(s_addr: inet_addr("127.0.0.1")), sin_zero: (0, 0, 0, 0, 0, 0, 0, 0))
        _ = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(probe, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.getsockname(probe, $0, &length) } }
        Darwin.close(probe)
        let endpoint = RelayEndpoint(host: "127.0.0.1", port: UInt16(bigEndian: address.sin_port), pin: Data(repeating: 4, count: 65))
        return try RelayConnection(host: host, store: store, person: Data(repeating: 1, count: 32), endpoint: endpoint, linkStore: try linkStore(storeFolder(), store, endpoint), constants: constants)
    }

    // MARK: tests

    /// App data design 3: what one run stored, the next run is given; a second process on the same store is refused.
    func testARunGivesTheNextOneItsStoredState() async throws {
        let folder = try storeFolder()
        var first: RelayConnection? = try await makeConnection(folder: folder, constants: [:])
        let log = Log(first!)
        first!.start()
        let rested = await log.wait(from: 0, seconds: 30) { isDelivered($0, "rest") }
        XCTAssertNotNil(rested, "the first run reaches rest")
        XCTAssertThrowsError(try LinkStore(folder: folder, identity: LinkIdentity(signing: Data(), receiving: Data(), relay: Data()))) {
            XCTAssertTrue($0 is LinkStoreBusy, "the first run holds the store")
        }
        await first!.stop()
        first = nil // the store's lock goes with the connection, as it goes with the process
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: folder.appendingPathComponent("link.json"))) as? [String: Any]
        let count = try XCTUnwrap(json?["count"] as? Int)
        XCTAssertGreaterThan(count, 0, "the ids read are stored")
        let second = try await makeConnection(folder: folder, constants: [:])
        let again = Log(second)
        second.start()
        let rest = await again.wait(from: 0, seconds: 30) { isDelivered($0, "rest") }
        XCTAssertNotNil(rest, "the next run reads under the stored state and reaches rest")
        let incarnation = again.entries(from: 0).first { isDelivered($0.event, "incarnation") }
        if let incarnation, case .delivered(let view) = incarnation.event {
            XCTAssertEqual(view["first"], .bool(false), "the stored incarnation was given back")
        } else { XCTFail("no incarnation delivered") }
        await second.stop()
    }

    /// A dial that ends on its own (a refused connection) leaves no socket behind.
    func testFailedDialsLeaveNoSocket() async throws {
        let connection = try await makeLonelyConnection(constants: ["first": .number(30), "max": .number(60)])
        let log = Log(connection)
        connection.start()
        let sixth = await log.wait(from: 0, seconds: 20) { _ in log.entries(from: 0).filter { isDialing($0.event) }.count >= 6 }
        XCTAssertNotNil(sixth, "the link dials again and again")
        let held = await connection.socketCount()
        XCTAssertLessThanOrEqual(held, 1, "only the dial in progress holds a socket")
        await connection.stop()
    }

    func testStopBeforeStartEndsTheConnectionForGood() async throws {
        let connection = try await makeLonelyConnection(constants: [:])
        let log = Log(connection)
        await connection.stop()
        connection.start()
        let outcome = try await connection.submit(kind: 4, signed: Data([1]), sig: Data([2]))
        XCTAssertEqual(outcome, .ended)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(log.count, 0, "a stopped connection never dials")
    }

    func testAnItemPastTheFrameLimitIsInvalid() async throws {
        let connection = try await makeLonelyConnection(constants: [:])
        connection.start()
        do {
            _ = try await connection.submit(kind: 4, signed: Data(count: 1_100_000), sig: Data(count: 64))
            XCTFail("an item past the frame limit must be refused")
        } catch RelayError.invalidItem {}
        await connection.stop()
    }

    func testAWrongPinIsRefusedBeforeAnyFrame() async throws {
        var wrong = hex(try env("PARDNER_RELAY_PIN"))
        wrong[wrong.count - 1] ^= 1
        let connection = try await makeConnection(pin: wrong, constants: ["first": .number(300), "max": .number(600)])
        let log = Log(connection)
        connection.start()
        // The handshake fails in the verify block, so the link never leaves `dialing`: it dials again after its back-off, and delivers nothing.
        let second = await log.wait(from: 1, seconds: 10) { isDialing($0) }
        XCTAssertNotNil(second, "a refused pin is a dropped connection: the link dials again")
        let delivered = log.entries(from: 0).filter { if case .delivered = $0.event { return true } else { return false } }
        XCTAssertTrue(delivered.isEmpty, "nothing reaches the link from a relay whose key is not the pinned one")
        await connection.stop()
    }

    func testTheLinkProvesFollowsSubmitsRestartsAndIsRemoved() async throws {
        let ask = 3.0
        let connection = try await makeConnection(constants: ["first": .number(500), "max": .number(4000), "ask": .number(ask * 1000)])
        let log = Log(connection)
        connection.start()

        // The proof binds the exporter under the final label: the relay refuses a proof for any other binding, and serves this one.
        let rest = await log.wait(from: 0, seconds: 60) { isDelivered($0, "rest") }
        XCTAssertNotNil(rest, "the relay served the proof and the link read to rest")
        try await step("rest")

        // A message the second device submits reaches the follow, opened.
        let (app1, app2) = (try env("PARDNER_APP1_ID"), try env("PARDNER_APP2_ID"))
        func message(from sender: String, named name: String) -> (RelayEvent) -> Bool {
            { event in
                guard case .delivered(let view) = event, view["do"]?.stringValue == "message" else { return false }
                return self.text(view["sender"]?.bytesValue) == sender && self.text(view["name"]?.bytesValue) == name && view["text"]?.stringValue == "{}"
            }
        }
        let followed = await log.wait(from: rest!, seconds: 30, message(from: app2, named: try env("PARDNER_NAME_FOLLOW")))
        XCTAssertNotNil(followed, "the second device's message came through the follow")

        // An item of its own: answered 0, and read back through the follow.
        // A push takes the reading off rest until its head is read: a submit meanwhile is `busy`, and the caller sends it again.
        var code = SubmitOutcome.busy
        for _ in 0..<100 where code == .busy {
            code = try await connection.submit(kind: UInt8(try env("PARDNER_ITEM_KIND"))!, signed: hex(try env("PARDNER_ITEM_SIGNED")), sig: hex(try env("PARDNER_ITEM_SIG")))
            if code == .busy { try await Task.sleep(for: .milliseconds(50)) }
        }
        XCTAssertEqual(code, .code(0))
        let own = await log.wait(from: followed ?? 0, seconds: 30, message(from: app1, named: try env("PARDNER_NAME_OWN")))
        XCTAssertNotNil(own, "the item the app submitted came back")
        try await step("exchanged") // the relay stops and serves again on its port

        // A dial within the back-off (at most 4 s apart), and a read under the new incarnation (the relay draws a fresh one at every start, directory kept: `changed`).
        let mark = log.count
        let redial = await log.wait(from: mark, seconds: 30) { isDialing($0) }
        XCTAssertNotNil(redial, "the link dialed the relay again")
        let again = await log.wait(from: mark, seconds: 60) { isDelivered($0, "incarnation") }
        XCTAssertNotNil(again, "a read under the new incarnation")
        if let again, case .delivered(let view) = log.entries(from: again).first!.event { XCTAssertEqual(view["changed"], .bool(true)) }
        let restAgain = await log.wait(from: again ?? mark, seconds: 60) { isDelivered($0, "rest") }
        XCTAssertNotNil(restAgain, "read to rest under the new incarnation")
        try await step("restarted") // the second device removes this one

        let refused = await log.wait(from: restAgain ?? mark, seconds: 30) { isDelivered($0, "refused") }
        XCTAssertNotNil(refused, "the removed device is refused")
        if let refused, case .delivered(let view) = log.entries(from: refused).first!.event { XCTAssertEqual(view["reason"], .number(1)) }
        let next = await log.wait(from: (refused ?? mark) + 1, seconds: ask + 10) { isDialing($0) }
        XCTAssertNotNil(next, "the link dials again after a refusal 1")
        if let refused, let next {
            let waited = log.at(refused).duration(to: log.at(next))
            XCTAssertGreaterThanOrEqual(waited, .seconds(ask * 0.9), "after refusal 1 the next dial waits ASK, not the back-off")
        }
        let refusedAgain = await log.wait(from: (next ?? mark) + 1, seconds: 30) { isDelivered($0, "refused") }
        XCTAssertNotNil(refusedAgain, "the dial after ASK is refused 1 again")
        try await step("finished")
        await connection.stop()
    }
}
