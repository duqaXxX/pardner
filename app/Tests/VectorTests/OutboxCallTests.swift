// The connection's answers to `createChannel` and `send` against a stand-in link in the host's own context: no relay. The real link is
// reached by DevicesRelayTests; here the effects of an answer are chosen, so a fault after the answer can be made.
import Foundation
@testable import ProtocolHost
@testable import Relay
import XCTest

final class OutboxCallTests: XCTestCase {
    private var hostUsed: ProtocolHost?
    private func connection(link: String, ownName: String? = nil) async throws -> (RelayConnection, LinkStore, URL) {
        let store = SoftwareKeyStore()
        _ = try store.make("device.sign", .sign)
        _ = try store.make("device.receive", .receive)
        let script = try XCTUnwrap(ProcessInfo.processInfo.environment["PARDNER_JOINED_SCRIPT"], "run test/protocol/jsc.test.ts")
        let host = try await ProtocolHost(scriptPath: script, store: store)
        hostUsed = host
        try await host.perform { state in
            _ = state.context!.evaluateScript("protocol.appLink = function (platform, o) { protocol.sawOwnName = String(o.ownName); return { exporterLabel: function () { return 'label'; }, start: function () { return []; }, stop: function () { return []; }, \(link) }; };")
        }
        let endpoint = RelayEndpoint(host: "127.0.0.1", port: 1, pin: Data(repeating: 4, count: 65))
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("pardner-store-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        let linkStore = try LinkStore(folder: folder, identity: LinkIdentity(
            signing: try store.publicKey("device.sign"), receiving: try store.publicKey("device.receive"), relay: endpoint.pin))
        // The public init is the one `PairingController` calls: a name it is given must reach the link's options.
        if let ownName { return (try RelayConnection(host: host, store: store, person: Data(repeating: 1, count: 32), endpoint: endpoint, linkStore: linkStore, ownName: ownName), linkStore, folder) }
        return (try RelayConnection(host: host, store: store, person: Data(repeating: 1, count: 32), endpoint: endpoint, linkStore: linkStore, constants: [:]), linkStore, folder)
    }

    func testTheNameTheControllerGivesReachesTheLinksOptions() async throws {
        let (connection, _, _) = try await connection(link: "createChannel: function () { return { channel: new Uint8Array(32), effects: [] }; }", ownName: "Mac one")
        connection.start()
        var seen = ""
        for _ in 0..<40 where seen.isEmpty {
            seen = try await XCTUnwrap(hostUsed).perform { state in state.context!.evaluateScript("String(protocol.sawOwnName === undefined ? '' : protocol.sawOwnName)")!.toString() ?? "" }
            if seen.isEmpty { try await Task.sleep(for: .milliseconds(50)) }
        }
        XCTAssertEqual(seen, "Mac one")
    }

    func testAnEffectThePlatformDoesNotKnowAfterTheAnswerIsThatCallsErrorAndTheConnectionFaults() async throws {
        let (connection, _, _) = try await connection(link: "createChannel: function () { return { channel: new Uint8Array(32), effects: [{ do: 'nope' }] }; }")
        let events = connection.events
        let faulted = Task { () -> Bool in
            for await event in events { if case .faulted = event { return true } }
            return false
        }
        connection.start()
        do {
            let outcome = try await connection.createChannel(bot: Data(repeating: 2, count: 32), folder: "/work")
            XCTFail("a fault after the answer must be the call's error, not \(outcome)")
        } catch {}
        // Answered once: a second answer of the same continuation traps this process, which is the failure.
        let told = await faulted.value
        XCTAssertTrue(told, "the host's fault ends the connection as elsewhere")
        await connection.stop()
    }

    func testASetNameCallReachesTheLinkWithItsKindTargetTextAndSetupFlag() async throws {
        let (connection, _, _) = try await connection(link: "setName: function (kind, target, text, now, options) { protocol.sawName = [kind, target, text, options.setup].join('|'); return { name: new Uint8Array(16), effects: [] }; }")
        connection.start()
        let outcome = try await connection.setName(kind: 15, target: nil, text: "Ada", setup: true)
        XCTAssertEqual(outcome, .queued(name: Data(count: 16)))
        let seen = try await XCTUnwrap(hostUsed).perform { state in state.context!.evaluateScript("protocol.sawName")!.toString() ?? "" }
        XCTAssertEqual(seen, "15||Ada|true")
        await connection.stop()
    }

    func testTheSameForSend() async throws {
        let (connection, _, _) = try await connection(link: "send: function () { return { name: new Uint8Array(16), effects: [{ do: 'nope' }] }; }")
        connection.start()
        do {
            let outcome = try await connection.send(channel: Data(repeating: 3, count: 32), draft: OutboxDraft(kind: 2, content: "x"))
            XCTFail("a fault after the answer must be the call's error, not \(outcome)")
        } catch {}
        await connection.stop()
    }

    private final class Count: @unchecked Sendable { var n = 0 }

    /// The call's own change is its first write. A later write of the chain failing (the built bytes) leaves the message on the disk:
    /// the call says it was queued, since the caller keeping a draft that Retry sends again would send it twice; the connection still ends.
    func testALaterWriteOfTheChainFailingDoesNotUnsaveTheMessage() async throws {
        let write = "{ do: 'write', outbox: { pending: { signed: new Uint8Array(70), sig: new Uint8Array(64) }, channels: [], faults: [] } }"
        let (connection, store, folder) = try await connection(link: """
            send: function () { return { name: new Uint8Array(16), effects: [\(write)] }; },
            written: function (ok) { if (!ok) return [{ do: 'store-failed' }]; globalThis.writes = (globalThis.writes || 0) + 1; return globalThis.writes === 1 ? [\(write)] : []; }
            """)
        let count = Count()
        store.beforeOutboxWrite = {
            count.n += 1
            if count.n == 2 { throw StoreError(description: "the disk is full") }
        }
        let events = connection.events
        let failed = Task { () -> Bool in
            for await event in events { if case .storeFailed = event { return true } }
            return false
        }
        connection.start()
        let outcome = try await connection.send(channel: Data(repeating: 3, count: 32), draft: OutboxDraft(kind: 2, content: "x"))
        XCTAssertEqual(outcome, .queued(name: Data(repeating: 0, count: 16)))
        let kept = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: folder.appendingPathComponent("outbox.json"))) as? [String: Any])
        XCTAssertNotNil(kept["pending"] as? [String: Any], "the first write is on the disk")
        // A regression that never tells `storeFailed` fails here after 20 s rather than at the suite's alarm.
        let deadline = Task { try? await Task.sleep(for: .seconds(20)); failed.cancel() }
        let told = await failed.value
        deadline.cancel()
        XCTAssertTrue(told, "the later write's failure still ends the connection")
        await connection.stop()
    }

    /// And a failure of the first write is the call's: nothing is on the disk.
    func testTheFirstWriteFailingIsNotSaved() async throws {
        let write = "{ do: 'write', outbox: { pending: null, channels: [], faults: [] } }"
        let (connection, store, _) = try await connection(link: """
            send: function () { return { name: new Uint8Array(16), effects: [\(write)] }; },
            written: function (ok) { return ok ? [] : [{ do: 'store-failed' }]; }
            """)
        store.beforeOutboxWrite = { throw StoreError(description: "the disk is full") }
        connection.start()
        let outcome = try await connection.send(channel: Data(repeating: 3, count: 32), draft: OutboxDraft(kind: 2, content: "x"))
        XCTAssertEqual(outcome, .notSaved)
        await connection.stop()
    }
}
