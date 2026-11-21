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

    private func device(_ name: String, script: String, held: Held) throws -> (PairingController, SoftwareKeyStore, URL) {
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
        return (controller, keys, base)
    }

    func testASecondDeviceJoinsIsAddedByTheFirstAndIsRemovedByIt() async throws {
        let script = try env("PARDNER_APP_SCRIPT")
        let (port, key, secret) = (try env("PARDNER_RELAY_PORT"), try env("PARDNER_RELAY_PIN"), try env("PARDNER_ENROL_SECRET"))
        let held = Held()
        let (first, _, firstBase) = try device("first", script: script, held: held)
        let (second, secondKeys, _) = try device("second", script: script, held: held)

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

        // The channel calls reach the link through the joined script, and its refusals come back: this device is no bot, and no channel is known.
        let notABot = try await first.createChannel(bot: added2.id, folder: "/work")
        XCTAssertEqual(notABot, .refused("bad-input"))
        let unknown = try await first.send(channel: Data(repeating: 9, count: 32), draft: OutboxDraft(kind: 2, content: "{\"text\":\"hi\"}"))
        XCTAssertEqual(unknown, .refused("not-member"))

        // The first removes the second; the second ends removed, and the act ends on a log read back.
        let choices = await first.removalChoices(clicked: added2.id)
        XCTAssertEqual(choices.map(\.id), [added2.id])
        let refusal = await first.confirmRemoval(chosen: [added2.id], clicked: added2.id)
        XCTAssertNil(refusal)
        await until(90, "the second device is not removed") { await second.phase == .removed }
        await until(60, "the removal did not end") { let list = await first.deviceList; return list.removing.isEmpty && list.rows.first { $0.id == added2.id }?.active == false }

        // A channel with a bot, through the joined script to the disk. The bot is a device of the person that a pairing string adds: the
        // Node side made it for the person id given here (app-devices.test.ts).
        let sync = URL(fileURLWithPath: try env("PARDNER_SYNC_DIR"))
        try values.person.write(to: sync.appendingPathComponent("person.txt"), atomically: true, encoding: .utf8)
        var botString: String?
        await until(60, "no pairing string of a bot") { botString = try? String(contentsOf: sync.appendingPathComponent("bot.txt"), encoding: .utf8); return botString != nil }
        let botShown = await first.inspect(pairingString: try XCTUnwrap(botString))
        guard case .success(let botCandidate) = botShown else { return XCTFail("the bot's string was refused: \(botShown)") }
        XCTAssertEqual(botCandidate.kind, .bot)
        let botAdded = await first.confirmAdd(botCandidate)
        XCTAssertNil(botAdded)
        await until(60, "the bot is not in the list") { let list = await first.deviceList; return list.rows.contains { $0.kind == .bot && $0.active } && !list.pendingEntry }
        let botRows = await first.deviceList.rows
        let botID = try XCTUnwrap(botRows.first { $0.kind == .bot }?.id)
        let created = try await first.createChannel(bot: botID, folder: "/work")
        guard case .created(let channel) = created else { return XCTFail("not created: \(created)") }
        // Answered after its write: the creation and its bind prompt are on the disk now, with the pairing they belong to.
        let file = firstBase.appendingPathComponent("link/outbox.json")
        let stored = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        XCTAssertEqual(stored["version"] as? Int, 1)
        XCTAssertNotNil(stored["pending"] as? [String: Any], "the creation is stored before it is submitted")
        let items = (stored["channels"] as? [[String: Any]])?.first { $0["channel"] as? String == channel.base64EncodedString() }?["items"] as? [[String: Any]]
        XCTAssertEqual(items?.count, 1, "and its bind prompt")
        await until(60, "the creation is not told") { await first.channels.creating?.channel == channel }
        // Read back, the creation is dropped and the bind goes once the first epoch is open.
        await until(90, "the channel is not created at the relay") { let state = await first.channels; return state.creating == nil && state.outboxes.isEmpty }

        // A write the disk refuses: the draft is not saved, the connection ends, and Retry is offered.
        let link = firstBase.appendingPathComponent("link")
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: link.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: link.path) }
        let refused = try await first.send(channel: channel, draft: OutboxDraft(kind: 2, to: botID, content: "{\"text\":\"hi\"}"))
        XCTAssertEqual(refused, .notSaved)
        await until(30, "the failure is not a fault") { await first.phase == .fault(.failed, PairingPhase.storeFailedAdvice) }
        await first.shutdown()
        await second.shutdown()
    }
}
