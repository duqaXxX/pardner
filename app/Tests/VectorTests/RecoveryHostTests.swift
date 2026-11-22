// What the recovery adds to the host and to the connection's options (recovery design 2.2, 2.3): the typed key taken through the package with
// its id, the two names it is held under put away together, and the options the link is given. Needs PARDNER_APP_SCRIPT, as the controller's tests do.
import Foundation
@testable import Platform
@testable import ProtocolHost
@testable import Relay
import XCTest

final class RecoveryHostTests: XCTestCase {
    private let secret = Data((1...32).map { UInt8($0) })

    private func host(_ person: RecoveryPerson) async throws -> ProtocolHost {
        let script = try XCTUnwrap(ProcessInfo.processInfo.environment["PARDNER_APP_SCRIPT"], "run test/protocol/jsc.test.ts")
        return try await ProtocolHost(scriptPath: script, store: SoftwareKeyStore(), person: person)
    }

    func testATypedKeyComesBackAsPublicKeysAndAnIdAndIsHeldUntilBothNamesAreDeleted() async throws {
        let host = try await host(.typing(secret))
        let typed = try await host.enterRecovery("recovery.entered")
        XCTAssertEqual([typed.signing.count, typed.receiving.count, typed.id.count], [65, 65, 32])
        do {
            _ = try await host.enterRecovery("recovery.entered")
            XCTFail("a name held is refused")
        } catch let refused as RecoveryRefused { XCTAssertEqual(refused.reason, "key-exists") }
        try await host.deleteRecoveryKeys("recovery.entered")
        let again = try await host.enterRecovery("recovery.entered")
        XCTAssertEqual(again.id, typed.id, "the same secret is the same key")
    }

    func testAMadeKeyAlsoCarriesItsId() async throws {
        let made = try await host(.typing(secret)).createRecovery("recovery.next")
        XCTAssertEqual(made.id.count, 32)
    }

    func testADeclinedEntryIsRefusedAsBadInput() async throws {
        let host = try await host(RecoveryPerson(show: { _, _ in true }, enter: { _ in nil }))
        do {
            _ = try await host.enterRecovery("recovery.entered")
            XCTFail("a decline is refused")
        } catch let refused as RecoveryRefused { XCTAssertEqual(refused.reason, "bad-input") }
    }

    /// A recovery connection ends its event stream (and so gives the link store's claim back) when the link stops itself: after the log it read and after a fault.
    func testARecoveryConnectionEndsWhenTheLinkStopsAfterTheLogOrAFault() async throws {
        let log = HostValue.object(["do": .string("recovery-log"), "devices": .array([]), "recoveries": .array([])])
        let fault = HostValue.object(["do": .string("recovery"), "outcome": .object(["fault": .string("a log entry that does not hold")])])
        for (name, effect) in [("log", log), ("fault", fault)] {
            let store = SoftwareKeyStore()
            _ = try store.make("device.sign", .sign)
            _ = try store.make("device.receive", .receive)
            let host = try await host(.typing(secret))
            let endpoint = RelayEndpoint(host: "127.0.0.1", port: 1, pin: Data(repeating: 4, count: 65))
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("pardner-recover-\(UUID().uuidString)")
            addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
            let linkStore = try LinkStore(folder: folder, identity: LinkIdentity(signing: try store.publicKey("device.sign"), receiving: try store.publicKey("device.receive"), relay: endpoint.pin))
            let connection = try RelayConnection(host: host, store: store, person: Data(repeating: 1, count: 32), endpoint: endpoint, linkStore: linkStore, recover: RecoverRequest(key: Data(repeating: 1, count: 32), signName: "recovery.entered.sign"))
            try await connection.perform([effect])
            connection.start()
            let ended = Task { for await _ in connection.events {}; return !Task.isCancelled }
            let timeout = Task { try await Task.sleep(for: .seconds(15)); ended.cancel() }
            let finished = await ended.value
            timeout.cancel()
            XCTAssertTrue(finished, "the stream of a recovery connection after the \(name) ends")
            await connection.stop()
        }
    }

    /// The link ignores a `recover` in its constructor's options (the reviewer's proof: it dialled `active`): the connection must call `recover`.
    func testAConnectionGivenARecoverRequestDialsForARecovery() async throws {
        let store = SoftwareKeyStore()
        _ = try store.make("device.sign", .sign)
        _ = try store.make("device.receive", .receive)
        let host = try await host(.typing(secret))
        let endpoint = RelayEndpoint(host: "127.0.0.1", port: 1, pin: Data(repeating: 4, count: 65))
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("pardner-recover-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        let linkStore = try LinkStore(folder: folder, identity: LinkIdentity(signing: try store.publicKey("device.sign"), receiving: try store.publicKey("device.receive"), relay: endpoint.pin))
        let request = RecoverRequest(key: Data(repeating: 1, count: 32), signName: "recovery.entered.sign")
        let connection = try RelayConnection(host: host, store: store, person: Data(repeating: 1, count: 32), endpoint: endpoint, linkStore: linkStore, recover: request)
        connection.start()
        let deadline = ContinuousClock.now.advanced(by: .seconds(20))
        while connection.dialPurposes.isEmpty, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(connection.dialPurposes.first, "recover")
        await connection.stop()
    }

    /// The link's own answers, through a real connection with no relay: nothing read yet, a key held for opening accepted, a malformed one refused.
    func testAConnectionAnswersTheRecoveryReadingAndTakesAKeyToOpenWith() async throws {
        let store = SoftwareKeyStore()
        _ = try store.make("device.sign", .sign)
        _ = try store.make("device.receive", .receive)
        let host = try await host(.typing(secret))
        let endpoint = RelayEndpoint(host: "127.0.0.1", port: 1, pin: Data(repeating: 4, count: 65))
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("pardner-recover-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        let linkStore = try LinkStore(folder: folder, identity: LinkIdentity(signing: try store.publicKey("device.sign"), receiving: try store.publicKey("device.receive"), relay: endpoint.pin))
        let connection = try RelayConnection(host: host, store: store, person: Data(repeating: 1, count: 32), endpoint: endpoint, linkStore: linkStore)
        connection.start()
        let reading = await connection.recoveryReading()
        XCTAssertEqual(reading, RecoveryReading())
        let held = await connection.holdRecovery(id: Data(repeating: 9, count: 32), receiving: "recovery.entered.receive")
        XCTAssertTrue(held)
        let refused = await connection.holdRecovery(id: Data(repeating: 9, count: 3), receiving: "recovery.entered.receive")
        XCTAssertFalse(refused)
        await connection.stop()
        let after = await connection.recoveryReading()
        XCTAssertNil(after, "a connection that ended reads nothing")
    }

    func testTheRecoverOptionsCarryTheKeyAndTheResetsInputsAsTheLinkTakesThem() {
        let bare = RecoverRequest(key: Data(repeating: 1, count: 32), signName: "recovery.entered.sign")
        XCTAssertEqual(bare.value, .object(["key": .object(["id": .bytes(Data(repeating: 1, count: 32)), "sign": .string("recovery.entered.sign")])]))
        let keys = PairingRecoveryKeys(signing: Data(repeating: 2, count: 65), receiving: Data(repeating: 3, count: 65))
        let full = RecoverRequest(key: bare.key, signName: bare.signName, reset: .init(proof: Data(repeating: 4, count: 64), trusted: [Data(repeating: 5, count: 32)], replacement: keys))
        XCTAssertEqual(full.value["reset"]?["trusted"], .array([.bytes(Data(repeating: 5, count: 32))]))
        XCTAssertEqual(full.value["reset"]?["replacement"]?["receiving"], .bytes(keys.receiving))
        XCTAssertNil(RecoverRequest(key: bare.key, signName: bare.signName, reset: .init(proof: Data(), trusted: [], replacement: nil)).value["reset"]?["replacement"])
    }
}
