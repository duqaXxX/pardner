// Two devices of one person against a real relay: test/protocol/app-devices.test.ts starts a relay on a fresh `init` directory and runs
// this file with `swift test --filter DevicesRelayTests`, giving its port, key and enrolment secret. The first device enrols; a second
// joins with the three values and shows its pairing string; the first checks and confirms the add; both lists show both devices; the
// first removes the second, which ends removed (device pairing design 3.4, 3.6, 3.7, 3.9, 3.10). Run alone, it fails on the missing environment.
import Foundation
import Platform
@testable import ProtocolHost
@testable import Relay
import XCTest

private final class Held: @unchecked Sendable {
    private let lock = NSLock()
    private var held: [AnyObject] = []
    func add(_ connection: AnyObject) { lock.lock(); held.append(connection); lock.unlock() }
}

final class DevicesRelayTests: XCTestCase {
    private func env(_ name: String) throws -> String {
        try XCTUnwrap(ProcessInfo.processInfo.environment[name], "\(name) is not set: run test/protocol/app-devices.test.ts")
    }

    private func until(_ seconds: Double, _ message: String, _ condition: () async -> Bool) async {
        let deadline = ContinuousClock.now.advanced(by: .seconds(seconds))
        while ContinuousClock.now < deadline {
            if await condition() { return }
            try? await Task.sleep(for: .milliseconds(20))
        }
        XCTFail(message)
    }

    private func device(_ name: String, script: String, held: Held) throws -> (PairingController, SoftwareKeyStore) {
        let keys = SoftwareKeyStore()
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("pardner-devices-relay-\(name)-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: base) }
        let pairing = try PairingStore(folder: base.appendingPathComponent("pairing"))
        let controller = PairingController(
            keys: keys, pairing: pairing, linkFolder: base.appendingPathComponent("link"),
            makeHost: { keys, person in try await ProtocolHost(scriptPath: script, store: keys, person: person) },
            connect: { host, keys, person, endpoint, linkStore, enrolment in
                let connection = try PairingController.relayConnection(host, keys, person, endpoint, linkStore, enrolment)
                held.add(connection)
                return connection
            })
        return (controller, keys)
    }

    func testASecondDeviceJoinsIsAddedByTheFirstAndIsRemovedByIt() async throws {
        let script = try env("PARDNER_APP_SCRIPT")
        let (port, key, secret) = (try env("PARDNER_RELAY_PORT"), try env("PARDNER_RELAY_PIN"), try env("PARDNER_ENROL_SECRET"))
        let held = Held()
        let (first, _) = try device("first", script: script, held: held)
        let (second, secondKeys) = try device("second", script: script, held: held)

        // The first device enrols.
        await first.launch()
        let setUp = Task { try await first.setUp(address: "127.0.0.1:\(port)", relayKey: key, enrolmentSecret: secret) }
        await until(30, "no sheet") { if case .showingSheet = await first.phase { return true } else { return false } }
        guard case .showingSheet(let request) = await first.phase else { return XCTFail("no sheet") }
        request.answer(true)
        try await setUp.value
        await until(60, "the first device is not paired") { await first.phase == .paired }
        let handoff = await first.handoffValues()
        let values = try XCTUnwrap(handoff, "the three values for the new device")
        XCTAssertEqual(values.relayAddress, "127.0.0.1:\(port)")
        XCTAssertEqual(values.relayKey, key)
        await until(30, "the first device reads its log") { await first.deviceList.rows.count == 1 }

        // The second device joins with them and shows its string; the relay does not know it yet.
        await second.launch()
        try await second.join(address: values.relayAddress, relayKey: values.relayKey, person: values.person, name: "Second Mac")
        guard case .joining(let info) = await second.phase else { return XCTFail("not joining: \(await second.phase)") }
        await until(60, "the second device is not told to wait") { if case .joining(let now) = await second.phase { return now.waiting } else { return false } }

        // The first device checks the string, shows what it names and adds the device.
        let shown = await first.inspect(pairingString: info.pairingString)
        guard case .success(let candidate) = shown else { return XCTFail("the string was refused: \(shown)") }
        XCTAssertEqual(candidate.name, "Second Mac")
        XCTAssertEqual(candidate.shortForm, info.shortForm, "the two screens show one short form")
        let added = await first.confirmAdd(candidate)
        XCTAssertNil(added)

        // The second is served and paired; both lists show both devices.
        await until(90, "the second device is not paired") { await second.phase == .paired }
        await until(60, "the first list lacks the second device") { let list = await first.deviceList; return list.rows.count == 2 && !list.pendingEntry }
        await until(60, "the second list lacks the first device") { await second.deviceList.rows.count == 2 }
        let firstList = await first.deviceList
        let secondList = await second.deviceList
        XCTAssertEqual(Set(firstList.rows.map(\.id)), Set(secondList.rows.map(\.id)))
        let added2 = try XCTUnwrap(firstList.rows.first { !$0.isThisMac })
        XCTAssertEqual(added2.label, "Second Mac")
        XCTAssertEqual(added2.shortForm, info.shortForm)
        XCTAssertEqual(secondList.rows.filter(\.isThisMac).count, 1)
        XCTAssertNotEqual(secondList.rows.first { $0.isThisMac }?.id, firstList.rows.first { $0.isThisMac }?.id)
        XCTAssertTrue(secondKeys.has("device.sign"), "the second device holds its own keys")

        // The first removes the second; the second ends removed, and the act ends on a log read back.
        let choices = await first.removalChoices(clicked: added2.id)
        XCTAssertEqual(choices.map(\.id), [added2.id])
        let refusal = await first.confirmRemoval(chosen: [added2.id], clicked: added2.id)
        XCTAssertNil(refusal)
        await until(90, "the second device is not removed") { await second.phase == .removed }
        await until(60, "the removal did not end") { let list = await first.deviceList; return list.removing.isEmpty && list.rows.first { $0.id == added2.id }?.active == false }
        await first.shutdown()
        await second.shutdown()
    }
}
