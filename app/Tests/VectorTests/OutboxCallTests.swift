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

    /// One entry per act: the object the link reads is `ArrangeAct` (src/protocol/arrangement-act.ts), ids in lowercase hex, a Swift nil as null.
    func testEachActReachesTheLinkAsTheArrangeActItIs() async throws {
        let (connection, _, _) = try await connection(link: "arrange: function (act, now) { protocol.sawActs = (protocol.sawActs || []).concat([JSON.stringify(act)]); return { name: new Uint8Array(16), effects: [] }; }")
        connection.start()
        let channel = Data([0x0a, 0xff, 0x00, 0x1b])
        let acts: [(SectionAct, String)] = [
            (.newSection(name: "Work"), #"{"type":"section-new","name":"Work"}"#),
            (.newSection(name: "Work", channel: channel), #"{"type":"section-new","name":"Work","channel":"0aff001b"}"#),
            (.renameSection(section: "ab12", name: "Home"), #"{"type":"section-rename","section":"ab12","name":"Home"}"#),
            (.moveSection(section: "ab12", before: nil), #"{"type":"section-move","section":"ab12","before":null}"#),
            (.moveSection(section: "ab12", before: "cd34"), #"{"type":"section-move","section":"ab12","before":"cd34"}"#),
            (.removeSection(section: "ab12"), #"{"type":"section-remove","section":"ab12"}"#),
            (.moveChannel(channel: channel, section: nil, before: nil), #"{"type":"channel-move","channel":"0aff001b","section":null,"before":null}"#),
            (.moveChannel(channel: channel, section: "ab12", before: Data([1, 2])), #"{"type":"channel-move","channel":"0aff001b","section":"ab12","before":"0102"}"#),
        ]
        for (act, _) in acts {
            let outcome = try await connection.arrange(act)
            XCTAssertEqual(outcome, .queued(name: Data(count: 16)))
        }
        let seen = try await XCTUnwrap(hostUsed).perform { state in state.context!.evaluateScript("JSON.stringify(protocol.sawActs)")!.toString() ?? "" }
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(seen.utf8)) as? [String])
        // Compared as parsed objects: the key order of a JSON text is the engine's.
        func parsed(_ text: String) throws -> NSDictionary { try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? NSDictionary) }
        XCTAssertEqual(try sent.map(parsed), try acts.map { try parsed($0.1) })
        await connection.stop()
    }

    func testEachRefusalOfAnArrangeIsItsOutcome() async throws {
        let (connection, _, _) = try await connection(link: "arrange: function (act) { var n = protocol.n = (protocol.n || 0) + 1; return ['not-ready', 'bad-input', 'too-many'][n - 1]; }")
        connection.start()
        for reason in ["not-ready", "bad-input", "too-many"] {
            let outcome = try await connection.arrange(.removeSection(section: "ab12"))
            XCTAssertEqual(outcome, .refused(reason))
        }
        await connection.stop()
    }

    func testAnArrangeWhoseFirstWriteFailsIsNotSavedAndAFaultAfterItsAnswerIsItsError() async throws {
        let write = "{ do: 'write', outbox: { pending: { signed: new Uint8Array(70), sig: new Uint8Array(64) }, channels: [], faults: [] } }"
        let (connection, store, _) = try await connection(link: """
            arrange: function () { protocol.n = (protocol.n || 0) + 1; return { name: new Uint8Array(16), effects: protocol.n === 1 ? [\(write)] : [{ do: 'nope' }] }; },
            written: function () { return []; }
            """)
        store.beforeOutboxWrite = { throw StoreError(description: "the disk is full") }
        connection.start()
        let outcome = try await connection.arrange(.removeSection(section: "ab12"))
        XCTAssertEqual(outcome, .notSaved)
        do {
            let second = try await connection.arrange(.removeSection(section: "ab12"))
            XCTFail("a fault after the answer must be the call's error, not \(second)")
        } catch {}
        await connection.stop()
    }

    func testTheArrangementEffectBecomesTheEvent() async throws {
        let shown = "{ do: 'arrangement', sections: [{ id: 'ab12', name: 'Work', channels: ['0a0b'] }], current: true, behind: false, notApplied: false }"
        let (connection, _, _) = try await connection(link: "arrange: function () { return { name: new Uint8Array(16), effects: [\(shown)] }; }")
        let events = connection.events
        let got = Task { () -> HostValue? in
            for await event in events { if case .arrangement(let fx) = event { return fx } }
            return nil
        }
        connection.start()
        _ = try await connection.arrange(.newSection(name: "Work"))
        // Bounded: a missing event ends the wait with nil, not with a test that never returns.
        let bound = Task { try? await Task.sleep(for: .seconds(10)); got.cancel() }
        let seen = await got.value
        bound.cancel()
        let fx = try XCTUnwrap(seen)
        XCTAssertEqual(fx["sections"]?.arrayValue?.first?["id"]?.stringValue, "ab12")
        XCTAssertEqual(fx["sections"]?.arrayValue?.first?["channels"]?.arrayValue?.first?.stringValue, "0a0b")
        XCTAssertEqual(fx["current"], .bool(true))
        await connection.stop()
    }

    func testAnArrangeAfterTheConnectionEndedIsEnded() async throws {
        let (connection, _, _) = try await connection(link: "arrange: function () { return { name: new Uint8Array(16), effects: [] }; }")
        connection.start()
        await connection.stop()
        let outcome = try await connection.arrange(.newSection(name: "Work"))
        XCTAssertEqual(outcome, .ended, "the feed has ended")
    }

    /// An arrange asked before the connection ever started and stopped for good is answered by the end's drain or by the ended feed, whichever
    /// the ask meets: both answer `ended`.
    func testAnArrangeQueuedBehindTheEndIsEnded() async throws {
        let (connection, _, _) = try await connection(link: "arrange: function () { return { name: new Uint8Array(16), effects: [] }; }")
        let asked = Task { try await connection.arrange(.removeSection(section: "ab12")) }
        await Task.yield()
        await connection.stop()
        let outcome = try await asked.value
        XCTAssertEqual(outcome, .ended)
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
