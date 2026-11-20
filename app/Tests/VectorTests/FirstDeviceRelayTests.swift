// The first device against a real relay: test/protocol/app-first-device.test.ts starts a relay on a fresh `init` directory
// and runs this file with `swift test --filter FirstDeviceRelayTests`, giving its port, key and enrolment secret. The
// controller sets up, the sheet is confirmed, the relay places entry 0 and the stage becomes `paired`; a second run of the
// app over the same folders stays paired and reads. Run alone, it fails on the missing environment.
import Foundation
import Platform
@testable import ProtocolHost
@testable import Relay
import XCTest

/// Keeps every connection alive until the test ends, as a late reference would: the store's lock must not depend on their release.
private final class Held: @unchecked Sendable {
    private let lock = NSLock()
    private var held: [AnyObject] = []
    func add(_ connection: AnyObject) { lock.lock(); held.append(connection); lock.unlock() }
}

final class FirstDeviceRelayTests: XCTestCase {
    private func env(_ name: String) throws -> String {
        try XCTUnwrap(ProcessInfo.processInfo.environment[name], "\(name) is not set: run test/protocol/app-first-device.test.ts")
    }

    private func hex(_ text: String) -> Data {
        var data = Data()
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(index, offsetBy: 2)
            data.append(UInt8(text[index..<next], radix: 16)!)
            index = next
        }
        return data
    }

    private func wait(_ controller: PairingController, seconds: Double, _ matches: (PairingPhase) -> Bool) async -> PairingPhase {
        let deadline = ContinuousClock.now.advanced(by: .seconds(seconds))
        while ContinuousClock.now < deadline {
            let phase = await controller.phase
            if matches(phase) { return phase }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return await controller.phase
    }

    func testEnrolsOnAFreshRelayAndStaysPairedAfterARestart() async throws {
        let script = try env("PARDNER_APP_SCRIPT")
        let (port, key, secret) = (try env("PARDNER_RELAY_PORT"), try env("PARDNER_RELAY_PIN"), try env("PARDNER_ENROL_SECRET"))
        let keys = SoftwareKeyStore()
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("pardner-first-device-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: base) }
        let pairing = try PairingStore(folder: base.appendingPathComponent("pairing"))
        let linkFolder = base.appendingPathComponent("link")
        let held = Held()
        func makeController() -> PairingController {
            PairingController(keys: keys, pairing: pairing, linkFolder: linkFolder,
                              makeHost: { keys, person in try await ProtocolHost(scriptPath: script, store: keys, person: person) },
                              connect: { host, keys, person, endpoint, linkStore, enrolment in
                                  let connection = try PairingController.relayConnection(host, keys, person, endpoint, linkStore, enrolment)
                                  held.add(connection)
                                  return connection
                              })
        }

        let first = makeController()
        await first.launch()
        let start = await first.phase
        XCTAssertEqual(start, .unpaired(nil))
        let setUp = Task { try await first.setUp(address: "127.0.0.1:\(port)", relayKey: key, enrolmentSecret: secret) }
        let sheet = await wait(first, seconds: 30) { if case .showingSheet = $0 { return true } else { return false } }
        guard case .showingSheet(let request) = sheet else { return XCTFail("no sheet: \(sheet)") }
        request.answer(true)
        try await setUp.value
        let paired = await wait(first, seconds: 60) { $0 == .paired }
        XCTAssertEqual(paired, .paired, "the relay placed entry 0")
        let stored = try XCTUnwrap(try pairing.load())
        XCTAssertEqual(stored.stage, .paired)
        XCTAssertNil(stored.genesis)
        XCTAssertEqual(stored.relay.key, hex(key))
        await first.shutdown()

        // A restart holds no enrolment secret: the proof alone keeps it paired and reading.
        let second = makeController()
        await second.launch()
        let again = await second.phase
        XCTAssertEqual(again, .paired)
        let events = second.relayEvents
        let rested = await Task {
            for await event in events {
                if case .delivered(let view) = event, view["do"]?.stringValue == "rest" { return true }
            }
            return false
        }.value
        XCTAssertTrue(rested, "the second run reaches rest on the proof alone")
        let after = await second.phase
        XCTAssertEqual(after, .paired)
        await second.shutdown()

        // A stopped connection gives the folder's lock back even while something still holds the connection.
        XCTAssertNoThrow(try LinkStore.erase(folder: linkFolder), "the store is erased at once after the connection stopped")
    }
}
