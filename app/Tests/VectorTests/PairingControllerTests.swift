// The pairing controller (device pairing design 3.5, 3.10, 4.1): each launch state, the setup flow with a decline and a confirmation,
// a stop at each step, the refusal of the secret, the removed device and the cancel rules. The connection is a stand-in; the
// real one is tried against a real relay by FirstDeviceRelayTests. Needs PARDNER_APP_SCRIPT, the package built from index.js (test/protocol/jsc.test.ts sets it).
import CryptoKit
import Foundation
import Platform
@testable import ProtocolHost
@testable import Relay
import XCTest

final class FakeLink: RelayLinking, @unchecked Sendable { // one test thread at a time
    let events: AsyncStream<RelayEvent>
    private let out: AsyncStream<RelayEvent>.Continuation
    var started = false, stopped = false
    var retyped: [Enrolment] = []
    var submitOutcome = SubmitOutcome.code(0)
    /// The device acts the controller asked for, and what each is answered: `buildOutcomes` in order, then busy; a check is `checkOutcome`.
    var builds: [DeviceAct] = []
    var buildOutcomes: [BuildOutcome] = []
    var checkOutcome = BuildOutcome.checked
    var buildGate: Latch?
    /// The items sent, with what was answered: `submitOutcomes` in order, then `submitOutcome`. `onSubmit` runs as one is sent.
    var submitted: [(kind: UInt8, signed: Data, sig: Data)] = []
    var submitOutcomes: [SubmitOutcome] = []
    var onSubmit: (() -> Void)?
    /// The channels and messages the controller asked for, and what each is answered.
    var createOutcome = CreateOutcome.created(channel: Data(repeating: 0xC1, count: 32))
    var sendOutcome = SendOutcome.queued(name: Data(repeating: 0xA1, count: 16))
    var creations: [(bot: Data, folder: String)] = []
    var sends: [(channel: Data, draft: OutboxDraft)] = []
    private let putBack: Bool
    var stopGate: Latch?
    /// The recovery keys the controller gave the link to open with, what it reads back, and a hook run as one is given.
    var holds: [(id: Data, receiving: String)] = []
    var reading: RecoveryReading? = RecoveryReading()
    var onHold: ((Data) -> Void)?
    var holdResult = true
    /// Holds `recoveryReading` until the test lets it go, and counts the readings waiting: two evaluations can then be inside their await together.
    var readingGate: Latch?
    var readingsWaiting = 0

    /// `putBack`: the link store holds the put-back mark, which a real link delivers at its start and never dials (link.ts).
    init(putBack: Bool = false) {
        self.putBack = putBack
        (events, out) = AsyncStream.makeStream(of: RelayEvent.self)
    }
    func emit(_ event: RelayEvent) { out.yield(event) }
    func start() {
        started = true
        if putBack { out.yield(.delivered(.object(["do": .string("put-back")]))) }
    }
    func stop() async { await stopGate?.wait(); stopped = true; out.finish() }
    func enrol(_ enrolment: Enrolment) async -> Bool { retyped.append(enrolment); return true }
    func submit(kind: UInt8, signed: Data, sig: Data) async throws -> SubmitOutcome {
        submitted.append((kind, signed, sig))
        onSubmit?()
        return submitOutcomes.isEmpty ? submitOutcome : submitOutcomes.removeFirst()
    }
    func createChannel(bot: Data, folder: String) async throws -> CreateOutcome {
        creations.append((bot, folder))
        return createOutcome
    }
    func send(channel: Data, draft: OutboxDraft) async throws -> SendOutcome {
        sends.append((channel, draft))
        return sendOutcome
    }
    func holdRecovery(id: Data, receiving: String) async -> Bool {
        holds.append((id, receiving))
        onHold?(id)
        return holdResult
    }
    func recoveryReading() async -> RecoveryReading? {
        readingsWaiting += 1
        await readingGate?.wait()
        readingsWaiting -= 1
        return reading
    }
    func build(_ act: DeviceAct) async throws -> BuildOutcome {
        await buildGate?.wait()
        builds.append(act)
        if case .check = act { return checkOutcome }
        return buildOutcomes.isEmpty ? .refused("busy") : buildOutcomes.removeFirst()
    }
}

/// Holds a host's making until the test lets it go, so a cancel can land at a known point of the setup.
actor Latch {
    private var isOpen = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    func wait() async { if !isOpen { await withCheckedContinuation { waiting.append($0) } } }
    func open() { isOpen = true; waiting.forEach { $0.resume() }; waiting = [] }
}

private final class Seen: @unchecked Sendable {
    private let lock = NSLock()
    private var phases: [PairingPhase] = []
    func add(_ phase: PairingPhase) { lock.lock(); phases.append(phase); lock.unlock() }
    var all: [PairingPhase] { lock.lock(); defer { lock.unlock() }; return phases }
}

private final class Harness: @unchecked Sendable {
    var links: [FakeLink] = []
    var enrolments: [Enrolment?] = []
    var hostsMade = 0
    var putBackStored = false // the mark a put-back leaves in the link store: every later link delivers it at its start
    var link: FakeLink { links.last! }
}

final class PairingControllerTests: XCTestCase {
    private let relayKey = P256.Signing.PrivateKey().publicKey.x963Representation
    private let secretHex = String(repeating: "ab", count: 32)

    private func folder(_ name: String) -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("pardner-controller-\(name)-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private struct Rig {
        let controller: PairingController
        let keys: SoftwareKeyStore
        let pairing: PairingStore
        let pairingFolder: URL
        let linkFolder: URL
        let harness: Harness
    }

    private func rig(keys: Bool = false, state: PairingState? = nil, rawStore: String? = nil, latch: Latch? = nil) throws -> Rig {
        let store = SoftwareKeyStore()
        store.refusesAbsentDelete = true
        if keys {
            _ = try store.make("device.sign", .sign)
            _ = try store.make("device.receive", .receive)
        }
        let pairingFolder = folder("pairing")
        let pairing = try PairingStore(folder: pairingFolder)
        if let state { try pairing.write(state) }
        if let rawStore { try rawStore.write(to: pairingFolder.appendingPathComponent("pairing.json"), atomically: true, encoding: .utf8) }
        let linkFolder = folder("link")
        let harness = Harness()
        let script = try XCTUnwrap(ProcessInfo.processInfo.environment["PARDNER_APP_SCRIPT"], "run test/protocol/jsc.test.ts")
        let controller = PairingController(
            keys: store, pairing: pairing, linkFolder: linkFolder,
            makeHost: { keys, person in
                harness.hostsMade += 1
                await latch?.wait()
                return try await ProtocolHost(scriptPath: script, store: keys, person: person)
            },
            connect: { _, _, _, _, _, enrolment, _ in
                let link = FakeLink(putBack: harness.putBackStored)
                harness.links.append(link)
                harness.enrolments.append(enrolment)
                return link
            })
        return Rig(controller: controller, keys: store, pairing: pairing, pairingFolder: pairingFolder, linkFolder: linkFolder, harness: harness)
    }

    /// A second run of the app over the same keys and folders: the first one's stores are given back when its connection ends.
    private func relaunched(_ rig: Rig) throws -> (PairingController, Harness) {
        let harness = Harness()
        let script = try XCTUnwrap(ProcessInfo.processInfo.environment["PARDNER_APP_SCRIPT"])
        let controller = PairingController(
            keys: rig.keys, pairing: rig.pairing, linkFolder: rig.linkFolder,
            makeHost: { keys, person in try await ProtocolHost(scriptPath: script, store: keys, person: person) },
            connect: { _, _, _, _, _, enrolment, _ in
                let link = FakeLink(putBack: harness.putBackStored)
                harness.links.append(link)
                harness.enrolments.append(enrolment)
                return link
            })
        return (controller, harness)
    }

    private func pairingFile(_ rig: Rig) -> URL { rig.pairingFolder.appendingPathComponent("pairing.json") }

    private var relay: PairingRelay { PairingRelay(host: "relay.example", port: 8443, key: relayKey) }
    private var person: Data { Data(repeating: 7, count: 32) }
    private var genesis: SignedEntry { SignedEntry(signed: Data(repeating: 1, count: 120), sig: Data(repeating: 1, count: 64), id: person) }
    private func stored(_ stage: PairingStage) -> PairingState {
        var state = PairingState(stage: stage, relay: relay, person: stage == .keysMade(.enrol) ? nil : person)
        if stage == .enrolling { state.genesis = genesis }
        return state
    }

    /// The phase, once it satisfies `matches`, or a failure after 20 s.
    private func wait(_ controller: PairingController, _ message: String, _ matches: (PairingPhase) -> Bool) async -> PairingPhase {
        let deadline = ContinuousClock.now.advanced(by: .seconds(20))
        while ContinuousClock.now < deadline {
            let phase = await controller.phase
            if matches(phase) { return phase }
            try? await Task.sleep(for: .milliseconds(10))
        }
        let last = await controller.phase
        XCTFail("\(message): the phase stayed \(last)")
        return last
    }

    private func sheet(_ controller: PairingController) async -> RecoverySheetRequest? {
        if case .showingSheet(let request) = await wait(controller, "no sheet", { if case .showingSheet = $0 { return true } else { return false } }) { return request }
        return nil
    }

    /// The setup of the standard form, on a task of its own: the sheet's answer comes from the test.
    private func begin(_ rig: Rig) -> Task<Void, Error> {
        let (controller, key, secret) = (rig.controller, hex(relayKey), secretHex)
        return Task { try await controller.setUp(address: "relay.example:8443", relayKey: key, enrolmentSecret: secret) }
    }

    private func relayText() -> String { "relay.example:8443" }
    private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    private func deliveredRefused(_ reason: Double) -> RelayEvent { .delivered(.object(["do": .string("refused"), "reason": .number(reason)])) }

    // MARK: launch

    func testNoStoreAndNoKeysIsUnpaired() async throws {
        let rig = try rig()
        await rig.controller.launch()
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .unpaired(nil))
    }

    func testKeysWithNoStoreAreANamedFaultWhosOnlyActionIsPairAgain() async throws {
        let rig = try rig(keys: true)
        await rig.controller.launch()
        let phase = await rig.controller.phase
        guard case .fault(.keysWithoutStore, _) = phase else { return XCTFail("\(phase)") }
        XCTAssertTrue(rig.keys.has("device.sign"), "nothing is erased at launch")
        let paired = await rig.controller.pairAgain()
        XCTAssertTrue(paired)
        XCTAssertFalse(rig.keys.has("device.sign"))
        XCTAssertFalse(rig.keys.has("device.receive"))
        let after = await rig.controller.phase
        XCTAssertEqual(after, .unpaired(nil))
    }

    func testAMalformedStoreIsANamedFault() async throws {
        let rig = try rig(keys: true, rawStore: "{not json")
        await rig.controller.launch()
        let phase = await rig.controller.phase
        guard case .fault(.malformedStore, _) = phase else { return XCTFail("\(phase)") }
        XCTAssertTrue(rig.harness.links.isEmpty)
    }

    /// Design 4.1, two exits decided: a file that does not read is Pair again, with the warning that this Mac becomes a new device.
    func testAMalformedStoreOffersPairAgainAndErasesKeysLinkAndPairing() async throws {
        let rig = try rig(keys: true, rawStore: "{not json")
        try FileManager.default.createDirectory(at: rig.linkFolder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let linkFile = rig.linkFolder.appendingPathComponent("link.json")
        try Data("{}".utf8).write(to: linkFile)
        await rig.controller.launch()
        let phase = await rig.controller.phase
        guard case .fault(.malformedStore, let warning) = phase else { return XCTFail("\(phase)") }
        XCTAssertEqual(warning, PairingPhase.malformedStoreWarning)
        XCTAssertTrue(rig.keys.has("device.sign"), "nothing is erased at launch")
        let done = await rig.controller.pairAgain()
        XCTAssertTrue(done)
        XCTAssertFalse(rig.keys.has("device.sign"))
        XCTAssertFalse(rig.keys.has("device.receive"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: linkFile.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: rig.pairingFolder.appendingPathComponent("pairing.json").path))
        let after = await rig.controller.phase
        XCTAssertEqual(after, .unpaired(nil))
    }

    /// Design 4.1: a file written by a newer app is the newer app's: nothing is erased and no action is offered but updating.
    func testANewerVersionStoreErasesNothingAndRefusesPairAgain() async throws {
        let rig = try rig(keys: true, rawStore: #"{"version": 3}"#)
        await rig.controller.launch()
        let phase = await rig.controller.phase
        guard case .fault(.newerStore, let advice) = phase else { return XCTFail("\(phase)") }
        XCTAssertEqual(advice, PairingPhase.newerStoreAdvice)
        let done = await rig.controller.pairAgain()
        XCTAssertFalse(done)
        let retried = await rig.controller.retry()
        XCTAssertFalse(retried)
        XCTAssertTrue(rig.keys.has("device.sign"))
        XCTAssertTrue(rig.keys.has("device.receive"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: rig.pairingFolder.appendingPathComponent("pairing.json").path))
        let after = await rig.controller.phase
        XCTAssertEqual(after, phase)
    }

    /// The table's "stops before step 6": the keys go, then the store, and the person is told the sheet opens nothing.
    func testAStopAtKeysMadeStartsOverAndSaysTheSheetOpensNothing() async throws {
        let rig = try rig(keys: true, state: stored(.keysMade(.enrol)))
        await rig.controller.launch()
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .unpaired(.staleSheet))
        XCTAssertFalse(rig.keys.has("device.sign"))
        XCTAssertNil(try rig.pairing.load())
    }

    func testAStopAtKeysMadeBeforeTheKeysWereMadeIsTheSame() async throws {
        let rig = try rig(state: stored(.keysMade(.enrol)))
        await rig.controller.launch()
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .unpaired(.staleSheet))
        XCTAssertNil(try rig.pairing.load())
    }

    func testAStopWhileEnrollingResumesWithTheProofAlone() async throws {
        let rig = try rig(keys: true, state: stored(.enrolling))
        await rig.controller.launch()
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .enrolling(asksSecret: false))
        XCTAssertEqual(rig.harness.enrolments.count, 1)
        XCTAssertNil(rig.harness.enrolments[0], "no secret is held after a restart")
        XCTAssertTrue(rig.harness.link.started)
    }

    func testServedAfterARestartMovesToPairedOnTheFirstRest() async throws {
        let rig = try rig(keys: true, state: stored(.enrolling))
        await rig.controller.launch()
        rig.harness.link.emit(.delivered(.object(["do": .string("incarnation")])))
        rig.harness.link.emit(.delivered(.object(["do": .string("rest")])))
        _ = await wait(rig.controller, "never paired") { $0 == .paired }
        let state = try XCTUnwrap(try rig.pairing.load())
        XCTAssertEqual(state.stage, .paired)
        XCTAssertNil(state.genesis, "entry 0 is dropped once placed")
    }

    func testServedAfterARestartMovesToPairedOnTheFirstDevicesEffect() async throws {
        let rig = try rig(keys: true, state: stored(.enrolling))
        await rig.controller.launch()
        let id = Data(repeating: 7, count: 32)
        rig.harness.link.emit(.devices(.object(["person": .bytes(id), "length": .number(1), "last": .bytes(id), "self": .bytes(id), "devices": .array([])])))
        _ = await wait(rig.controller, "never paired") { $0 == .paired }
        XCTAssertEqual(try rig.pairing.load()?.stage, .paired)
    }

    func testPairedRunsTheConnectionAndStaysPairedAcrossARestart() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .paired)
        XCTAssertTrue(rig.harness.link.started)
        await rig.controller.shutdown()
        XCTAssertEqual(try rig.pairing.load()?.stage, .paired)
    }

    func testAStoreWhoseKeysAreGoneIsKeysMissingAndNothingIsErased() async throws {
        for stage in [PairingStage.paired, .enrolling] {
            let rig = try rig(state: stored(stage))
            await rig.controller.launch()
            let phase = await rig.controller.phase
            XCTAssertEqual(phase, .keysMissing, "\(stage)")
            XCTAssertNotNil(try rig.pairing.load(), "the store stays until the person acts")
            XCTAssertTrue(rig.harness.links.isEmpty)
            let again = await rig.controller.pairAgain()
            XCTAssertTrue(again)
            XCTAssertNil(try rig.pairing.load())
        }
    }

    // MARK: setup

    func testTheFormIsCheckedBeforeAnythingIsWritten() async throws {
        let rig = try rig()
        await rig.controller.launch()
        let cases: [(String, String, String, PairingInputError)] = [
            ("relay.example", hex(relayKey), secretHex, .address),
            ("relay.example:0", hex(relayKey), secretHex, .address),
            (":8443", hex(relayKey), secretHex, .address),
            (relayText(), String(hex(relayKey).dropLast(2)), secretHex, .relayKey),
            (relayText(), "04" + String(repeating: "00", count: 64), secretHex, .relayKey), // not on the curve
            (relayText(), hex(relayKey), String(secretHex.dropLast()), .enrolmentSecret),
            (relayText(), hex(relayKey), String(repeating: "zz", count: 32), .enrolmentSecret),
        ]
        for (address, key, secret, error) in cases {
            do {
                try await rig.controller.setUp(address: address, relayKey: key, enrolmentSecret: secret)
                XCTFail("\(address) was taken")
            } catch let thrown as PairingInputError { XCTAssertEqual(thrown, error, address) }
            XCTAssertNil(try rig.pairing.load(), "nothing was written")
            XCTAssertFalse(rig.keys.has("device.sign"))
        }
    }

    /// Steps 2 to 5: `keys-made` is on disk when the keys are made, and nothing carrying entry 0 is written before the sheet is confirmed.
    func testADeclineErasesTheKeysThenTheStoreAndSendsNothing() async throws {
        let rig = try rig()
        await rig.controller.launch()
        let setUp = begin(rig)
        let found = await sheet(rig.controller); let request = try XCTUnwrap(found)
        XCTAssertEqual(try rig.pairing.load()?.stage, .keysMade(.enrol), "the store says keys-made while the sheet shows")
        XCTAssertNil(try rig.pairing.load()?.genesis)
        XCTAssertTrue(rig.keys.has("device.sign") && rig.keys.has("device.receive"))
        XCTAssertTrue(request.context.contains("relay.example:8443"))
        XCTAssertTrue(request.context.contains(hex(relayKey)))
        XCTAssertEqual(request.withSecret { $0.count }, 32)
        request.answer(false)
        try await setUp.value
        let phase = await wait(rig.controller, "no unpaired") { $0 == .unpaired(nil) }
        XCTAssertEqual(phase, .unpaired(nil))
        XCTAssertFalse(rig.keys.has("device.sign"))
        XCTAssertNil(try rig.pairing.load())
        XCTAssertTrue(rig.harness.links.isEmpty, "nothing was sent")
        XCTAssertNil(request.withSecret { $0.count }, "the secret is out of reach once answered")
    }

    func testAConfirmationWritesEnrollingWithEntryZeroThenConnectsWithTheSecret() async throws {
        let rig = try rig()
        await rig.controller.launch()
        let setUp = begin(rig)
        let found = await sheet(rig.controller); let request = try XCTUnwrap(found)
        request.answer(true)
        try await setUp.value
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .enrolling(asksSecret: false))
        let state = try XCTUnwrap(try rig.pairing.load())
        XCTAssertEqual(state.stage, .enrolling)
        let entry = try XCTUnwrap(state.genesis)
        XCTAssertEqual(state.person, entry.id)
        XCTAssertTrue(request.context.contains(hex(entry.id)), "the sheet names the person id")
        let enrolment = try XCTUnwrap(try XCTUnwrap(rig.harness.enrolments.first))
        XCTAssertEqual(enrolment.secret, Data(repeating: 0xab, count: 32))
        XCTAssertEqual(enrolment.signed, entry.signed)
        let text = try String(contentsOf: pairingFile(rig), encoding: .utf8)
        XCTAssertFalse(text.contains(secretHex), "the enrolment secret is never stored")
        rig.harness.link.emit(.enrolled)
        _ = await wait(rig.controller, "never paired") { $0 == .paired }
        XCTAssertEqual(try rig.pairing.load()?.stage, .paired)
        XCTAssertNil(try rig.pairing.load()?.genesis)
    }

    /// A sheet that goes away with no answer (the app quitting) is a decline: the host thread is released. Nothing is erased while the
    /// process exits (design 3.5): the store stays at `keys-made`, and the next launch cleans up and says the sheet opens nothing.
    func testAStopWhileTheSheetShowsIsADeclineThatLeavesTheCleaningToTheNextLaunch() async throws {
        let rig = try rig()
        await rig.controller.launch()
        let setUp = begin(rig)
        _ = await sheet(rig.controller)
        await rig.controller.shutdown()
        try await setUp.value
        XCTAssertEqual(try rig.pairing.load()?.stage, .keysMade(.enrol))
        XCTAssertTrue(rig.keys.has("device.sign"))
        XCTAssertTrue(rig.keys.has("device.receive"))
        XCTAssertTrue(rig.harness.links.isEmpty)
        let (again, _) = try relaunched(rig)
        await again.launch()
        let phase = await again.phase
        XCTAssertEqual(phase, .unpaired(.staleSheet))
        XCTAssertFalse(rig.keys.has("device.sign"))
        XCTAssertNil(try rig.pairing.load())
        await again.shutdown()
    }

    func testACancelWhileTheSheetShowsDeclinesIt() async throws {
        let rig = try rig()
        await rig.controller.launch()
        let setUp = begin(rig)
        _ = await sheet(rig.controller)
        let outcome = await rig.controller.cancel()
        XCTAssertEqual(outcome, .abandoning)
        try await setUp.value
        let phase = await wait(rig.controller, "no unpaired") { $0 == .unpaired(nil) }
        XCTAssertEqual(phase, .unpaired(nil))
        XCTAssertNil(try rig.pairing.load())
    }

    func testACancelBeforeTheSheetNeverShowsIt() async throws {
        let latch = Latch()
        let rig = try rig(latch: latch)
        await rig.controller.launch()
        let phases = rig.controller.phases
        let seen = Seen()
        let watcher = Task { for await phase in phases { seen.add(phase) } }
        let setUp = begin(rig)
        _ = await wait(rig.controller, "never setting up") { $0 == .settingUp }
        let outcome = await rig.controller.cancel() // the host is not made yet: the cancel lands before the sheet can
        XCTAssertEqual(outcome, .abandoning)
        await latch.open()
        _ = await wait(rig.controller, "no unpaired") { $0 == .unpaired(nil) }
        try await setUp.value
        watcher.cancel()
        XCTAssertFalse(seen.all.contains { if case .showingSheet = $0 { return true } else { return false } }, "no sheet was shown: \(seen.all)")
        XCTAssertNil(try rig.pairing.load())
        XCTAssertFalse(rig.keys.has("device.sign"))
    }

    // MARK: refusal of the enrolment secret

    private func enrolling(_ rig: Rig) async throws {
        let setUp = begin(rig)
        let found = await sheet(rig.controller); let request = try XCTUnwrap(found)
        request.answer(true)
        try await setUp.value
    }

    func testARefusalTwoOnAConnectionThatCarriedEnrolAsksOnce() async throws {
        let rig = try rig()
        await rig.controller.launch()
        try await enrolling(rig)
        let seen = Seen()
        let phases = rig.controller.phases
        let watcher = Task { for await phase in phases { seen.add(phase) } }
        rig.harness.link.emit(.enrolRefused)
        rig.harness.link.emit(deliveredRefused(2)) // the link gives both for one refusal
        _ = await wait(rig.controller, "no ask") { $0 == .enrolling(asksSecret: true) }
        try await Task.sleep(for: .milliseconds(200))
        watcher.cancel()
        XCTAssertEqual(seen.all.filter { $0 == .enrolling(asksSecret: true) }.count, 1, "asked once: \(seen.all)")
        XCTAssertEqual(try rig.pairing.load()?.stage, .enrolling, "entry 0 and the keys stay")
        XCTAssertTrue(rig.keys.has("device.sign"))
        let taken = try await rig.controller.retypeSecret(String(repeating: "cd", count: 32))
        XCTAssertTrue(taken)
        XCTAssertEqual(rig.harness.link.retyped.first?.secret, Data(repeating: 0xcd, count: 32))
        XCTAssertEqual(rig.harness.link.retyped.first?.signed, try rig.pairing.load()?.genesis?.signed)
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .enrolling(asksSecret: false))
        let waits = await rig.controller.cancel()
        XCTAssertEqual(waits, .waitForAnswer, "the refusal said nothing of the new secret, so the cancel waits for its answer")
        // A second refusal of the new secret, on the dial that carried it, asks again.
        rig.harness.link.emit(.dialing)
        rig.harness.link.emit(.enrolRefused)
        rig.harness.link.emit(deliveredRefused(2))
        _ = await wait(rig.controller, "no second ask") { $0 == .enrolling(asksSecret: true) }
    }

    func testARefusalTwoAfterARestartWithNoSecretAsksForIt() async throws {
        let rig = try rig(keys: true, state: stored(.enrolling))
        await rig.controller.launch()
        rig.harness.link.emit(deliveredRefused(2))
        _ = await wait(rig.controller, "no ask") { $0 == .enrolling(asksSecret: true) }
    }

    func testARetypedSecretMustBeWellFormed() async throws {
        let rig = try rig(keys: true, state: stored(.enrolling))
        await rig.controller.launch()
        do {
            _ = try await rig.controller.retypeSecret("12")
            XCTFail("taken")
        } catch { XCTAssertEqual(error as? PairingInputError, .enrolmentSecret) }
        XCTAssertTrue(rig.harness.link.retyped.isEmpty)
    }

    // MARK: cancel

    func testACancelAtOnceAfterARefusalTwoErasesTheKeysThenTheStore() async throws {
        let rig = try rig(keys: true, state: stored(.enrolling))
        await rig.controller.launch()
        rig.harness.link.emit(deliveredRefused(2))
        _ = await wait(rig.controller, "no ask") { $0 == .enrolling(asksSecret: true) }
        let outcome = await rig.controller.cancel()
        XCTAssertEqual(outcome, .erased)
        XCTAssertFalse(rig.keys.has("device.sign"))
        XCTAssertNil(try rig.pairing.load())
        XCTAssertTrue(rig.harness.link.stopped)
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .unpaired(nil))
    }

    func testACancelWaitsForTheAnswerOfARelayThatCanBeReached() async throws {
        let rig = try rig(keys: true, state: stored(.enrolling))
        await rig.controller.launch()
        rig.harness.link.emit(.dialing)
        rig.harness.link.emit(.reached)
        try await Task.sleep(for: .milliseconds(200))
        let outcome = await rig.controller.cancel()
        XCTAssertEqual(outcome, .waitForAnswer)
        XCTAssertNotNil(try rig.pairing.load())
        XCTAssertTrue(rig.keys.has("device.sign"))
    }

    /// A dial in flight, and a dial that reached the relay after one that did not, say nothing of an unreachable relay.
    func testADialInFlightAndAConnectionThatReachedTheRelayAreReachable() async throws {
        let rig = try rig(keys: true, state: stored(.enrolling))
        await rig.controller.launch()
        for events in [[RelayEvent.dialing], [.dialing, .unreached, .dialing, .reached]] {
            events.forEach(rig.harness.link.emit)
            try await Task.sleep(for: .milliseconds(150))
            let outcome = await rig.controller.cancel()
            XCTAssertEqual(outcome, .waitForAnswer, "\(events)")
        }
    }

    func testACancelWhileTheRelayAnswersNothingNeedsASecondConfirmation() async throws {
        let rig = try rig(keys: true, state: stored(.enrolling))
        await rig.controller.launch()
        rig.harness.link.emit(.dialing)
        rig.harness.link.emit(.unreached)
        rig.harness.link.emit(.dialing) // the second dial is in flight: the first one ended without reaching the relay
        try await Task.sleep(for: .milliseconds(200))
        let first = await rig.controller.cancel()
        XCTAssertEqual(first, .confirmUnreachable)
        XCTAssertTrue(PairingController.unreachableWarning.contains("pardner relay init"))
        XCTAssertNotNil(try rig.pairing.load(), "nothing is erased before the confirmation")
        let second = await rig.controller.cancel(confirmedUnreachable: true)
        XCTAssertEqual(second, .erased)
        XCTAssertFalse(rig.keys.has("device.sign"))
        XCTAssertNil(try rig.pairing.load())
    }

    func testAnAnswerMakesTheRelayReachableAgain() async throws {
        let rig = try rig(keys: true, state: stored(.enrolling))
        await rig.controller.launch()
        rig.harness.link.emit(.dialing)
        rig.harness.link.emit(.unreached)
        rig.harness.link.emit(.delivered(.object(["do": .string("incarnation")])))
        rig.harness.link.emit(.dialing)
        try await Task.sleep(for: .milliseconds(200))
        let outcome = await rig.controller.cancel()
        XCTAssertEqual(outcome, .waitForAnswer)
    }

    func testPairedCannotBeCancelled() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        let outcome = await rig.controller.cancel()
        XCTAssertEqual(outcome, .notCancellable)
    }

    // MARK: this device removed

    func testARefusalOneRemovesThisDeviceAndErasesNothingUntilPairAgain() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        rig.harness.link.emit(deliveredRefused(1))
        _ = await wait(rig.controller, "not removed") { $0 == .removed }
        XCTAssertNotNil(try rig.pairing.load())
        XCTAssertTrue(rig.keys.has("device.sign"))
        let notYet = await rig.controller.cancel()
        XCTAssertEqual(notYet, .notCancellable)
        // The next launch asks again.
        let (again, harness) = try relaunched(rig)
        await again.launch()
        harness.link.emit(deliveredRefused(1))
        _ = await wait(again, "not removed again") { $0 == .removed }
        XCTAssertNotNil(try rig.pairing.load(), "asked again, still nothing erased")
        await again.shutdown()
        let paired = await rig.controller.pairAgain()
        XCTAssertTrue(paired)
        XCTAssertFalse(rig.keys.has("device.sign"))
        XCTAssertNil(try rig.pairing.load())
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .unpaired(nil))
    }

    func testASubmitAnsweredRemovedIsThisDeviceRemoved() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        rig.harness.link.submitOutcome = .code(5)
        let outcome = try await rig.controller.submit(kind: 1, signed: Data(), sig: Data())
        XCTAssertEqual(outcome, .code(5))
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .removed)
    }

    // MARK: a new channel and the app's outbox (new channel design 3, 5)

    private func channelID(_ n: UInt8) -> Data { Data(repeating: n, count: 32) }

    private func outboxEffect(_ channel: Data, _ items: [HostValue]) -> RelayEvent {
        .outbox(.object(["do": .string("outbox"), "channel": .bytes(channel), "items": .array(items)]))
    }

    private func creatingEffect(_ channel: Data?, bot: Data = Data(repeating: 0xB0, count: 32), folder: String = "/work") -> RelayEvent {
        guard let channel else { return .creating(.object(["do": .string("creating"), "channel": .null])) }
        return .creating(.object(["do": .string("creating"), "channel": .bytes(channel), "bot": .bytes(bot), "folder": .string(folder)]))
    }

    private func outboxItem(_ n: UInt8, _ state: String, to: Data? = nil) -> HostValue {
        var item: [String: HostValue] = ["name": .bytes(Data(repeating: n, count: 16)), "kind": .number(2), "content": .string("{\"text\":\"hi \(n)\"}"), "state": .string(state)]
        if let to { item["to"] = .bytes(to) }
        return .object(item)
    }

    private func channelState(_ controller: PairingController, _ message: String, _ matches: (ChannelsState) -> Bool) async -> ChannelsState {
        let deadline = ContinuousClock.now.advanced(by: .seconds(20))
        while ContinuousClock.now < deadline {
            let state = await controller.channels
            if matches(state) { return state }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail(message)
        return await controller.channels
    }

    func testCreateChannelAndSendGoThroughTheLink() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        let bot = Data(repeating: 0xB0, count: 32)
        let created = try await rig.controller.createChannel(bot: bot, folder: "/work")
        XCTAssertEqual(created, .created(channel: channelID(0xC1)))
        XCTAssertEqual(rig.harness.link.creations.count, 1)
        XCTAssertEqual(rig.harness.link.creations.first?.bot, bot)
        XCTAssertEqual(rig.harness.link.creations.first?.folder, "/work")
        let draft = OutboxDraft(kind: 2, to: bot, content: "{\"text\":\"hi\"}")
        let sent = try await rig.controller.send(channel: channelID(0xC1), draft: draft)
        XCTAssertEqual(sent, .queued(name: Data(repeating: 0xA1, count: 16)))
        XCTAssertEqual(rig.harness.link.sends.first?.channel, channelID(0xC1))
        XCTAssertEqual(rig.harness.link.sends.first?.draft, draft)
    }

    func testARefusedCreationLeavesNoPendingChannel() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        rig.harness.link.createOutcome = .refused("busy")
        let created = try await rig.controller.createChannel(bot: Data(repeating: 0xB0, count: 32), folder: "/work")
        XCTAssertEqual(created, .refused("busy"))
        let creating = await rig.controller.channels.creating
        XCTAssertNil(creating)
    }

    func testCreateChannelAndSendWithNoConnectionAreEnded() async throws {
        let rig = try rig()
        await rig.controller.launch()
        let created = try await rig.controller.createChannel(bot: Data(repeating: 0xB0, count: 32), folder: "/work")
        let sent = try await rig.controller.send(channel: channelID(1), draft: OutboxDraft(kind: 2, content: "x"))
        XCTAssertEqual(created, .ended)
        XCTAssertEqual(sent, .ended)
    }

    func testTheOutboxEffectIsEachChannelsItemsWithTheirState() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        let bot = Data(repeating: 0xB0, count: 32)
        rig.harness.link.emit(outboxEffect(channelID(1), [outboxItem(1, "waiting", to: bot), outboxItem(2, "sent")]))
        rig.harness.link.emit(outboxEffect(channelID(2), [outboxItem(3, "refused")]))
        let state = await channelState(rig.controller, "no outbox") { $0.outboxes.count == 2 }
        XCTAssertEqual(state.outboxes[channelID(1)]?.map(\.state), [.waiting, .sent])
        XCTAssertEqual(state.outboxes[channelID(1)]?.first?.to, bot)
        XCTAssertEqual(state.outboxes[channelID(1)]?.first?.name, Data(repeating: 1, count: 16))
        XCTAssertEqual(state.outboxes[channelID(1)]?.map(\.content), ["{\"text\":\"hi 1\"}", "{\"text\":\"hi 2\"}"], "the body the owner wrote, to draw it until it is read back")
        XCTAssertEqual(state.outboxes[channelID(2)]?.map(\.state), [.refused])
        rig.harness.link.emit(outboxEffect(channelID(1), []))
        let after = await channelState(rig.controller, "the empty list stays") { $0.outboxes.count == 1 }
        XCTAssertNil(after.outboxes[channelID(1)], "a channel with nothing left in its outbox is not listed")
    }

    func testARefusedItemIsKeptUntilTheScreenAcknowledgesIt() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        rig.harness.link.emit(outboxEffect(channelID(1), [outboxItem(1, "refused")]))
        rig.harness.link.emit(outboxEffect(channelID(1), [outboxItem(2, "waiting")])) // the next effect replaces the channel's items
        let state = await channelState(rig.controller, "both effects") { $0.outboxes[self.channelID(1)]?.map(\.state) == [.waiting] }
        XCTAssertEqual(state.undelivered[channelID(1)]?.map(\.name), [Data(repeating: 1, count: 16)], "told once, kept for the screen")
        XCTAssertEqual(state.undelivered[channelID(1)]?.first?.content, "{\"text\":\"hi 1\"}")
        rig.harness.link.emit(outboxEffect(channelID(1), [outboxItem(1, "refused")]))
        rig.harness.link.emit(outboxEffect(channelID(1), []))
        let again = await channelState(rig.controller, "emptied") { $0.outboxes[self.channelID(1)] == nil }
        XCTAssertEqual(again.undelivered[channelID(1)]?.count, 1, "the same name is not kept twice")
        await rig.controller.acknowledgeUndelivered(channel: channelID(1), names: [Data(repeating: 1, count: 16)])
        let after = await rig.controller.channels
        XCTAssertNil(after.undelivered[channelID(1)], "the screen took it")
    }

    func testAStopKeepsTheRefusalsTheScreenHasNotTaken() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        rig.harness.link.emit(outboxEffect(channelID(1), [outboxItem(1, "refused")]))
        _ = await channelState(rig.controller, "refusal kept") { $0.undelivered[self.channelID(1)] != nil }
        await rig.controller.stopConnection()
        let after = await rig.controller.channels
        XCTAssertEqual(after.undelivered[channelID(1)]?.count, 1, "a stop does not lose what the screen has not taken")
        XCTAssertTrue(after.outboxes.isEmpty, "the rest of what the connection told goes")
    }

    func testTheCreatingEffectIsTheChannelBeingCreatedAndNullEndsIt() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        let bot = Data(repeating: 0xB0, count: 32)
        rig.harness.link.emit(creatingEffect(channelID(0xC1), bot: bot, folder: "/work"))
        let state = await channelState(rig.controller, "no creation") { $0.creating != nil }
        XCTAssertEqual(state.creating, PendingChannel(channel: channelID(0xC1), bot: bot, folder: "/work"))
        rig.harness.link.emit(creatingEffect(nil))
        _ = await channelState(rig.controller, "the creation stays") { $0.creating == nil }
    }

    func testAChannelTheRelayRefusedKeepsItsCodeUntilTheNextCreation() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        rig.harness.link.emit(creatingEffect(channelID(0xC1)))
        rig.harness.link.emit(creatingEffect(nil))
        rig.harness.link.emit(.channelRefused(.object(["do": .string("channel-refused"), "channel": .bytes(channelID(0xC1)), "code": .number(1)])))
        let state = await channelState(rig.controller, "no refusal") { $0.refusal != nil }
        XCTAssertEqual(state.refusal, CreationRefusal(channel: channelID(0xC1), code: 1))
        XCTAssertNil(state.creating)
        rig.harness.link.emit(creatingEffect(channelID(0xC2), folder: "/other"))
        let next = await channelState(rig.controller, "no new creation") { $0.creating != nil }
        XCTAssertNil(next.refusal, "the refusal stands until the next creation")
        XCTAssertEqual(next.creating?.folder, "/other")
    }

    func testAChannelFaultMarksTheChannel() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        rig.harness.link.emit(.channelFault(.object(["do": .string("channel-fault"), "channel": .bytes(channelID(4))])))
        let state = await channelState(rig.controller, "no fault") { !$0.faulted.isEmpty }
        XCTAssertEqual(state.faulted, [channelID(4)])
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .paired, "a channel's fault stops that channel alone")
    }

    func testTheChannelStatesAreStreamedAndOnlyTheNewestIsKept() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        for n: UInt8 in 1...3 { rig.harness.link.emit(outboxEffect(channelID(n), [outboxItem(n, "waiting")])) }
        _ = await channelState(rig.controller, "no outbox") { $0.outboxes.count == 3 }
        var newest: ChannelsState?
        for await state in rig.controller.channelStates { newest = state; break }
        XCTAssertEqual(newest?.outboxes.count, 3, "a stream read late gives the state now, not the road to it")
    }

    func testAFailedStoreWriteEndsTheConnectionWithTheRetryableFaultAndItsOwnText() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        rig.harness.link.emit(outboxEffect(channelID(1), [outboxItem(1, "waiting")]))
        _ = await channelState(rig.controller, "no outbox") { !$0.outboxes.isEmpty }
        rig.harness.link.emit(.storeFailed)
        let phase = await wait(rig.controller, "the store failure is not a fault") { if case .fault = $0 { return true } else { return false } }
        XCTAssertEqual(phase, .fault(.failed, PairingPhase.storeFailedAdvice))
        XCTAssertEqual(PairingPhase.storeFailedAdvice, "Pardner could not save what it is sending (the disk may be full). Nothing was lost on the relay.")
        XCTAssertTrue(rig.harness.link.stopped)
        let ended = await rig.controller.channels
        XCTAssertEqual(ended, ChannelsState(), "what the ended connection told is not drawn while it is a fault")
        // Retry builds a new connection, which loads the outbox again, and what the old one drew is gone.
        let retried = await rig.controller.retry()
        XCTAssertTrue(retried)
        XCTAssertEqual(rig.harness.links.count, 2)
        let channels = await rig.controller.channels
        XCTAssertEqual(channels, ChannelsState())
    }

    func testARemovedDeviceDrawsNoChannelsOfTheEndedConnection() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        rig.harness.link.emit(creatingEffect(channelID(0xC1)))
        rig.harness.link.emit(outboxEffect(channelID(0xC1), [outboxItem(1, "waiting")]))
        _ = await channelState(rig.controller, "no outbox") { $0.creating != nil && !$0.outboxes.isEmpty }
        rig.harness.link.emit(deliveredRefused(1))
        _ = await wait(rig.controller, "not removed") { $0 == .removed }
        let channels = await rig.controller.channels
        XCTAssertEqual(channels, ChannelsState())
    }

    func testRetryShowsTheStoredCreationAgainWhenTheNewLinkTellsIt() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        rig.harness.link.emit(creatingEffect(channelID(0xC1)))
        _ = await channelState(rig.controller, "no creation") { $0.creating != nil }
        rig.harness.link.emit(.storeFailed)
        _ = await wait(rig.controller, "no fault") { if case .fault = $0 { return true } else { return false } }
        let retried = await rig.controller.retry()
        XCTAssertTrue(retried)
        let cleared = await rig.controller.channels
        XCTAssertNil(cleared.creating, "the old connection's creation is gone until the new link tells its own")
        rig.harness.link.emit(creatingEffect(channelID(0xC1)))
        let state = await channelState(rig.controller, "the stored creation is not shown again") { $0.creating != nil }
        XCTAssertEqual(state.creating?.channel, channelID(0xC1))
    }

    func testPairAgainIsRefusedWhileNothingIsRemovedOrBroken() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        let done = await rig.controller.pairAgain()
        XCTAssertFalse(done)
        XCTAssertTrue(rig.keys.has("device.sign"))
    }

    // MARK: a refusal speaks only for its own connection

    func testAStaleRefusalTwoAfterARetypeDoesNotRearmTheImmediateCancel() async throws {
        let rig = try rig()
        await rig.controller.launch()
        try await enrolling(rig)
        rig.harness.link.emit(.enrolRefused)
        rig.harness.link.emit(deliveredRefused(2))
        _ = await wait(rig.controller, "no ask") { $0 == .enrolling(asksSecret: true) }
        let taken = try await rig.controller.retypeSecret(String(repeating: "cd", count: 32))
        XCTAssertTrue(taken)
        // A proof-only connection already in flight is refused 2: it never carried the new secret.
        rig.harness.link.emit(deliveredRefused(2))
        try await Task.sleep(for: .milliseconds(200))
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .enrolling(asksSecret: false), "not asked again for a secret that was never tried")
        let stale = await rig.controller.cancel()
        XCTAssertEqual(stale, .waitForAnswer)
        // The next dial carries the new secret and places entry 0: the answer is lost, and the cancel still waits.
        rig.harness.link.emit(.dialing)
        rig.harness.link.emit(.reached)
        try await Task.sleep(for: .milliseconds(100))
        let after = await rig.controller.cancel()
        XCTAssertEqual(after, .waitForAnswer)
        XCTAssertNotNil(try rig.pairing.load())
        XCTAssertTrue(rig.keys.has("device.sign"))
    }

    func testARefusalTwoOnTheDialAfterARetypeIsHonouredAndLaterDialsDoNotClearIt() async throws {
        let rig = try rig()
        await rig.controller.launch()
        try await enrolling(rig)
        rig.harness.link.emit(deliveredRefused(2))
        _ = await wait(rig.controller, "no ask") { $0 == .enrolling(asksSecret: true) }
        _ = try await rig.controller.retypeSecret(String(repeating: "cd", count: 32))
        rig.harness.link.emit(.dialing)
        rig.harness.link.emit(deliveredRefused(2)) // this connection carried the new secret
        _ = await wait(rig.controller, "no second ask") { $0 == .enrolling(asksSecret: true) }
        // A later dial carries no `enrol` (the link dropped it after the refusal): the warning that the relay may hold entry 0 would be false.
        rig.harness.link.emit(.dialing)
        rig.harness.link.emit(.reached)
        try await Task.sleep(for: .milliseconds(150))
        let outcome = await rig.controller.cancel()
        XCTAssertEqual(outcome, .erased, "until the person types the secret again, the refusal stands")
    }

    // MARK: faults, put-back and Pair again

    func testATransientFaultOffersRetryAndNeverPairAgain() async throws {
        let rig = try rig(keys: true, state: stored(.enrolling))
        await rig.controller.launch()
        rig.harness.link.emit(.faulted("the host faulted"))
        _ = await wait(rig.controller, "no fault") { if case .fault(.failed, _) = $0 { return true } else { return false } }
        XCTAssertTrue(rig.harness.link.stopped, "a host fault stops the link")
        let done = await rig.controller.pairAgain()
        XCTAssertFalse(done)
        XCTAssertTrue(rig.keys.has("device.sign"))
        XCTAssertEqual(try rig.pairing.load()?.stage, .enrolling)
        let retried = await rig.controller.retry()
        XCTAssertTrue(retried)
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .enrolling(asksSecret: false), "resumes as the table says")
        XCTAssertEqual(rig.harness.links.count, 2)
        XCTAssertEqual(rig.harness.hostsMade, 2, "the faulted host was dropped")
    }

    func testAStoreAtJoiningResumesTheJoinWithTheProofAlone() async throws {
        var state = stored(.joining)
        (state.proof, state.name) = (Data(repeating: 3, count: 64), "this Mac")
        let rig = try rig(keys: true, state: state)
        await rig.controller.launch()
        guard case .joining(let info) = await rig.controller.phase else { return XCTFail("not joining") }
        XCTAssertFalse(info.waiting)
        XCTAssertEqual(rig.harness.links.count, 1)
        XCTAssertEqual(rig.harness.enrolments.count, 1)
        XCTAssertNil(rig.harness.enrolments[0], "a join carries no enrolment")
        let cancelled = await rig.controller.cancel()
        XCTAssertEqual(cancelled, .erased)
        XCTAssertNil(try rig.pairing.load())
        XCTAssertFalse(rig.keys.has("device.sign"))
    }

    func testAStoreAtJoiningWhoseKeysAreGoneIsKeysMissing() async throws {
        var state = stored(.joining)
        (state.proof, state.name) = (Data(repeating: 3, count: 64), "this Mac")
        let rig = try rig(state: state)
        await rig.controller.launch()
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .keysMissing)
        XCTAssertNotNil(try rig.pairing.load(), "nothing is erased")
    }

    func testALinkFaultOffersPairAgainAndRefusesRetry() async throws {
        for stage in [PairingStage.enrolling, .paired] {
            let rig = try rig(keys: true, state: stored(stage))
            await rig.controller.launch()
            rig.harness.link.emit(.delivered(.object(["do": .string("fault")])))
            let phase = await wait(rig.controller, "fault not mapped") { if case .linkFaulted = $0 { return true } else { return false } }
            guard case .linkFaulted(let advice) = phase else { return XCTFail("\(phase)") }
            XCTAssertEqual(advice, PairingPhase.linkFaultAdvice)
            XCTAssertTrue(rig.harness.link.stopped)
            let cancelled = await rig.controller.cancel()
            XCTAssertEqual(cancelled, .notCancellable)
            XCTAssertTrue(rig.keys.has("device.sign"))
            XCTAssertNotNil(try rig.pairing.load())
            // The relay's fault would come again from the same link store: retry() is refused, as for a put-back.
            let retried = await rig.controller.retry()
            XCTAssertFalse(retried)
            let done = await rig.controller.pairAgain()
            XCTAssertTrue(done)
            XCTAssertFalse(rig.keys.has("device.sign"))
            XCTAssertNil(try rig.pairing.load())
            let after = await rig.controller.phase
            XCTAssertEqual(after, .unpaired(nil))
        }
    }

    /// SD 5.11: a relay put back leaves its mark in the link store, so a new link delivers it at once and never dials: retry() would loop.
    /// The way out is a new relay (`pardner relay init`) and a new enrolment: pair again erases.
    func testAPutBackOffersPairAgainNotRetryBecauseTheMarkSurvivesInTheStore() async throws {
        for stage in [PairingStage.enrolling, .paired] {
            let rig = try rig(keys: true, state: stored(stage))
            await rig.controller.launch()
            rig.harness.putBackStored = true
            rig.harness.link.emit(.delivered(.object(["do": .string("put-back")])))
            let phase = await wait(rig.controller, "put-back not mapped") { if case .putBack = $0 { return true } else { return false } }
            guard case .putBack(let advice) = phase else { return XCTFail("\(phase)") }
            XCTAssertTrue(advice.contains("pardner relay init"), advice)
            XCTAssertTrue(rig.harness.link.stopped)
            let cancelled = await rig.controller.cancel()
            XCTAssertEqual(cancelled, .notCancellable)
            let retried = await rig.controller.retry()
            XCTAssertFalse(retried, "a retry would meet the stored mark again")
            XCTAssertEqual(rig.harness.links.count, 1, "nothing was started")
            XCTAssertTrue(rig.keys.has("device.sign"))
            XCTAssertNotNil(try rig.pairing.load())
            try Data("x".utf8).write(to: rig.linkFolder.appendingPathComponent("link.json"))
            let done = await rig.controller.pairAgain()
            XCTAssertTrue(done)
            XCTAssertFalse(rig.keys.has("device.sign"))
            XCTAssertFalse(rig.keys.has("device.receive"))
            XCTAssertFalse(FileManager.default.fileExists(atPath: rig.linkFolder.appendingPathComponent("link.json").path), "the link store goes")
            XCTAssertNil(try rig.pairing.load())
            let after = await rig.controller.phase
            XCTAssertEqual(after, .unpaired(nil))
        }
    }

    /// A launch over a store that carries the put-back mark lands on `putBack` again, so the person never loops through retry.
    func testALaunchOverAStoredPutBackMarkEndsOnPutBack() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        rig.harness.putBackStored = true
        await rig.controller.launch()
        _ = await wait(rig.controller, "put-back not mapped") { if case .putBack = $0 { return true } else { return false } }
        let retried = await rig.controller.retry()
        XCTAssertFalse(retried)
    }

    /// Two retries from one fault with a live link make one launch: the first claims before its first await.
    func testTwoRetriesAtOnceFromAFaultMakeOneLaunch() async throws {
        let rig = try rig(keys: true, state: stored(.enrolling))
        await rig.controller.launch()
        // A pairing store that cannot be written: the first `enrolled` is a fault with the link still live.
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: rig.pairingFolder.path)
        addTeardownBlock { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: rig.pairingFolder.path) }
        rig.harness.link.emit(.enrolled)
        _ = await wait(rig.controller, "no fault") { if case .fault(.failed, _) = $0 { return true } else { return false } }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: rig.pairingFolder.path)
        let gate = Latch()
        rig.harness.link.stopGate = gate
        let controller = rig.controller
        let (one, two) = (Task { await controller.retry() }, Task { await controller.retry() })
        try await Task.sleep(for: .milliseconds(150))
        await gate.open()
        let results = [await one.value, await two.value]
        XCTAssertEqual(results.filter { $0 }.count, 1, "one retry runs, the other finds one in flight")
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .enrolling(asksSecret: false))
        XCTAssertEqual(rig.harness.links.count, 2)
        rig.harness.link.emit(.enrolled)
        _ = await wait(rig.controller, "entry 0 not recorded: the state was lost") { $0 == .paired }
    }

    // MARK: launch twice, shutdown during launch

    func testTwoLaunchesAtOnceStartOneConnection() async throws {
        let latch = Latch()
        let rig = try rig(keys: true, state: stored(.enrolling), latch: latch)
        let controller = rig.controller
        let (one, two) = (Task { await controller.launch() }, Task { await controller.launch() })
        try await Task.sleep(for: .milliseconds(100))
        await latch.open()
        await one.value
        await two.value
        XCTAssertEqual(rig.harness.links.count, 1)
        XCTAssertEqual(rig.harness.hostsMade, 1)
    }

    func testAShutdownWhileTheHostIsMadeStartsNoConnection() async throws {
        let latch = Latch()
        let rig = try rig(keys: true, state: stored(.enrolling), latch: latch)
        let controller = rig.controller
        let launching = Task { await controller.launch() }
        try await Task.sleep(for: .milliseconds(100))
        await controller.shutdown()
        await latch.open()
        await launching.value
        XCTAssertTrue(rig.harness.links.isEmpty)
    }

    // MARK: the address and the streams

    func testTheAddressTakesHostPortAndBracketedIPv6Only() throws {
        let key = hex(relayKey)
        for (text, host, port) in [("relay.example:8443", "relay.example", UInt16(8443)), ("10.0.0.5:1", "10.0.0.5", 1), ("[::1]:65535", "::1", 65535), ("localhost:80", "localhost", 80)] {
            let relay = try PairingController.relay(address: text, key: key)
            XCTAssertEqual(relay.host, host); XCTAssertEqual(relay.port, port)
        }
        for text in ["https://h:8443", "wss://h:1", "h:8443/", "h:8443/x", "::1:8443", "fe80::1:8443", "h", "h:0", "h:65536", "h:-1", "h:+1", ":8443", "[::1]", "[::1]8443", "[h]:80", "[::1]:", "h :80", "h..x:80", "-h:80", "h:80:80"] {
            XCTAssertThrowsError(try PairingController.relay(address: text, key: key), text) { XCTAssertEqual($0 as? PairingInputError, .address, text) }
        }
    }

    func testAPhaseStreamKeepsOnlyTheNewest() async throws {
        let rig = try rig()
        await rig.controller.launch()
        try await enrolling(rig)
        var iterator = rig.controller.phases.makeAsyncIterator()
        let first = await iterator.next()
        XCTAssertEqual(first, .enrolling(asksSecret: false), "a late reader gets the state now")
    }

    /// The first `count` readings, or fewer if 20 s pass first.
    private func readings(_ controller: PairingController, _ count: Int) async -> [ReadingEvent] {
        let stream = controller.readings
        let reader = Task {
            var got: [ReadingEvent] = []
            for await event in stream {
                got.append(event)
                if got.count == count { break }
            }
            return got
        }
        let timer = Task { try? await Task.sleep(for: .seconds(20)); reader.cancel() }
        let got = await reader.value
        timer.cancel()
        return got
    }

    func testReadingsCarryEveryDeliveryAndProfileInTheLinksOrderAndNothingElse() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        let message = HostValue.object(["do": .string("message"), "position": .number(4)])
        let profile = HostValue.object(["bot": .bytes(Data(repeating: 3, count: 32)), "profile": .null])
        let rest = HostValue.object(["do": .string("rest")])
        rig.harness.link.emit(.delivered(message))
        rig.harness.link.emit(.reached)
        rig.harness.link.emit(.profile(profile))
        rig.harness.link.emit(.devices(.object(["person": .bytes(person), "length": .number(1), "last": .bytes(person), "self": .bytes(person), "devices": .array([])])))
        rig.harness.link.emit(.delivered(rest))
        let got = await readings(rig.controller, 4)
        XCTAssertEqual(got, [.reset, .delivered(message), .profile(profile), .delivered(rest)], "a reach and the devices are not the reading model's")
        await rig.controller.shutdown()
    }

    func testEveryNewConnectionStartsTheModelAgainBeforeItsFirstDelivery() async throws {
        let rig = try rig(keys: true, state: stored(.paired))
        await rig.controller.launch()
        let first = HostValue.object(["do": .string("message"), "position": .number(0)])
        rig.harness.link.emit(.delivered(first))
        rig.harness.link.emit(.faulted("the host faulted"))
        _ = await wait(rig.controller, "no fault") { if case .fault(.failed, _) = $0 { return true } else { return false } }
        let retried = await rig.controller.retry()
        XCTAssertTrue(retried)
        XCTAssertEqual(rig.harness.links.count, 2)
        rig.harness.link.emit(.delivered(first)) // the new link reads from position 0 again
        let got = await readings(rig.controller, 4)
        XCTAssertEqual(got, [.reset, .delivered(first), .reset, .delivered(first)], "rebuilt from empty, never patched over the last connection")
        await rig.controller.shutdown()
    }

    // It proves the erase's reset is there, after what the connection gave; not its place against a `handle` suspended across the
    // erase, which the yields' position before any suspension in `handle` keeps (ledger of the branch, row 3).
    func testAnEraseResetsTheModelAfterWhatItsConnectionGave() async throws {
        let rig = try rig(keys: true, state: stored(.enrolling))
        await rig.controller.launch()
        let message = HostValue.object(["do": .string("message"), "position": .number(0)])
        rig.harness.link.emit(.delivered(message))
        rig.harness.link.emit(deliveredRefused(2))
        _ = await wait(rig.controller, "no ask") { $0 == .enrolling(asksSecret: true) }
        let outcome = await rig.controller.cancel()
        XCTAssertEqual(outcome, .erased)
        await rig.controller.shutdown()
        let got = await readings(rig.controller, 99) // the stream ends at the shutdown
        XCTAssertEqual(got, [.reset, .delivered(message), .delivered(.object(["do": .string("refused"), "reason": .number(2)])), .reset])
    }

    // MARK: the sheet's contract

    func testTheSecondAnswerOfASheetChangesNothing() {
        let gate = SheetGate()
        gate.answer(true)
        gate.answer(false)
        XCTAssertTrue(gate.wait())
    }

    func testTheSecretIsGoneOnceTheSheetIsAnswered() {
        let bytes = [UInt8](repeating: 9, count: 32)
        bytes.withUnsafeBytes { raw in
            let request = RecoverySheetRequest(context: "c", secret: raw, gate: SheetGate())
            XCTAssertEqual(request.withSecret { $0.count }, 32)
            request.answer(false)
            XCTAssertNil(request.withSecret { $0.count })
        }
    }

    /// The view may answer from inside the draw (the last key typed matched while the secret is on screen).
    func testAnsweringFromInsideWithSecretDoesNotDeadlockAndHoldsTheHostThreadUntilTheDrawEnds() {
        let bytes = [UInt8](repeating: 9, count: 32)
        bytes.withUnsafeBytes { raw in
            let gate = SheetGate()
            let request = RecoverySheetRequest(context: "c", secret: raw, gate: gate)
            let released = Locked(false), drawEnded = Locked(false)
            let host = Thread {
                _ = gate.wait()
                released.set(true)
                XCTAssertTrue(drawEnded.get(), "the host thread was released before the draw ended")
            }
            let done = DispatchSemaphore(value: 0)
            host.start()
            let draw = Thread {
                _ = request.withSecret { _ in
                    request.answer(true)
                    Thread.sleep(forTimeInterval: 0.2) // the pointer is still read here
                    drawEnded.set(true)
                }
                done.signal()
            }
            draw.start()
            XCTAssertEqual(done.wait(timeout: .now() + 10), .success, "answer inside withSecret deadlocked")
            let deadline = Date().addingTimeInterval(10)
            while !released.get(), Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
            XCTAssertTrue(released.get())
        }
    }

    /// Only a backstop: nothing drops a request the controller's phase holds, but one released before any view saw it is a decline.
    func testARequestReleasedUnpresentedIsADeclineBackstop() {
        let bytes = [UInt8](repeating: 9, count: 32)
        bytes.withUnsafeBytes { raw in
            let gate = SheetGate()
            var request: RecoverySheetRequest? = RecoverySheetRequest(context: "c", secret: raw, gate: gate)
            XCTAssertNotNil(request)
            request = nil
            XCTAssertFalse(gate.wait())
        }
    }
}

private final class Locked<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ value: T) { self.value = value }
    func get() -> T { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ new: T) { lock.lock(); value = new; lock.unlock() }
}
