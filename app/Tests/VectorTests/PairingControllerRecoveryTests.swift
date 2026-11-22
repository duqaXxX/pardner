// Recovery with the recovery key on the pairing controller (recovery design 2.1 to 2.5, 2.7): the key typed, the reading connection, the two
// questions, the reset's inputs stored and the stages that follow, the refusals, a cancel and a restart at each stage. The connection is a
// stand-in that records what it was given; the real one is the package's, tried in test/protocol. Needs PARDNER_APP_SCRIPT, as the controller's tests do.
import CryptoKit
import Foundation
@testable import Platform
@testable import ProtocolHost
@testable import Relay
import XCTest

private final class Harness: @unchecked Sendable {
    var links: [FakeLink] = []
    var recoveries: [RecoverRequest?] = []
    var calls = 0
    var failingCall: Int?
    var link: FakeLink { links.last! }
    var request: RecoverRequest? { recoveries.last ?? nil }
}

private struct ConnectFailed: Error {}

final class PairingControllerRecoveryTests: XCTestCase {
    private let relayKey = P256.Signing.PrivateKey().publicKey.x963Representation
    private let person = Data(repeating: 7, count: 32)
    private let secret = Data((1...32).map { UInt8($0) })
    private let other = Data((101...132).map { UInt8($0) })
    private let (kept, gone) = (Data(repeating: 0xA1, count: 32), Data(repeating: 0xB2, count: 32))

    private struct Rig {
        let controller: PairingController
        let keys: SoftwareKeyStore
        let pairing: PairingStore
        let harness: Harness
        let script: String
    }

    private func makeRig(keys: Bool = false, state: PairingState? = nil, failingCall: Int? = nil, hostGate: Latch? = nil) throws -> Rig {
        let store = SoftwareKeyStore()
        if keys {
            _ = try store.make("device.sign", .sign)
            _ = try store.make("device.receive", .receive)
        }
        let folder = { (name: String) -> URL in
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("pardner-recovery-\(name)-\(UUID().uuidString)")
            self.addTeardownBlock { try? FileManager.default.removeItem(at: url) }
            return url
        }
        let pairing = try PairingStore(folder: folder("pairing"))
        if let state { try pairing.write(state) }
        let harness = Harness()
        let script = try XCTUnwrap(ProcessInfo.processInfo.environment["PARDNER_APP_SCRIPT"], "run test/protocol/jsc.test.ts")
        let controller = PairingController(
            keys: store, pairing: pairing, linkFolder: folder("link"),
            makeHost: { keys, person in
                await hostGate?.wait()
                return try await ProtocolHost(scriptPath: script, store: keys, person: person)
            },
            connect: { _, _, _, _, _, _, recover, _ in
                harness.calls += 1
                if harness.calls == harness.failingCall { throw ConnectFailed() }
                let link = FakeLink()
                harness.links.append(link)
                harness.recoveries.append(recover)
                return link
            })
        harness.failingCall = failingCall
        return Rig(controller: controller, keys: store, pairing: pairing, harness: harness, script: script)
    }

    private var relay: PairingRelay { PairingRelay(host: "relay.example", port: 8443, key: relayKey) }
    private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    /// The id the package gives the recovery key of `secret`, by a host of its own.
    private func keyID(_ rig: Rig, _ secret: Data) async throws -> Data {
        let host = try await ProtocolHost(scriptPath: rig.script, store: SoftwareKeyStore(), person: .typing(secret))
        return try await host.enterRecovery("probe").id
    }

    private func started(_ made: [Data] = []) -> PairingState {
        var state = PairingState(stage: .keysMade(.recover), relay: relay, person: person)
        state.recovery = PairingRecovery(made: made)
        return state
    }

    private func recovering(_ rig: Rig, keepOthers: Bool = true, replacement: PairingRecoveryKeys? = nil) async throws -> PairingState {
        var state = PairingState(stage: .recovering, relay: relay, person: person)
        state.proof = Data(repeating: 5, count: 64)
        state.recovery = PairingRecovery(made: [], reset: PairingReset(key: try await keyID(rig, secret), keepOthers: keepOthers, active: [kept, gone], replacement: replacement, previous: [Data(repeating: 4, count: 32)]))
        return state
    }

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

    private func at(_ step: RecoveryStep) -> (PairingPhase) -> Bool { { $0 == .recovering(step) } }

    /// Types `bytes` the way the person does, into the request the host waits on, and hands it over.
    private func type(_ controller: PairingController, _ bytes: Data) async {
        let phase = await wait(controller, "no entry asked") { if case .recovering(.typeKey) = $0 { true } else { false } }
        guard case .recovering(.typeKey(let request)) = phase else { return }
        let text = UnsafeMutableBufferPointer<UniChar>.allocate(capacity: RecoveryText.displayCount)
        defer { text.deallocate() }
        let buffer = SecretBuffer(bytes)
        RecoveryText.write(buffer, into: text)
        buffer.wipe()
        for character in text { request.entry.append(character) }
        request.answer(true)
    }

    private func begin(_ rig: Rig) -> Task<Void, Error> {
        let (controller, relay, person) = (rig.controller, "relay.example:8443", hex(person))
        let key = hex(relayKey)
        return Task {
            await controller.launch() // a no-op once launched
            try await controller.startRecovery(person: person, address: relay, relayKey: key)
        }
    }

    private func logRead(_ link: FakeLink, recoveries: [Data] = []) {
        let device = { (id: Data, active: Bool) in HostValue.object(["id": .bytes(id), "active": .bool(active)]) }
        link.emit(.recoveryLog(.object(["do": .string("recovery-log"), "devices": .array([device(kept, true), device(gone, false), device(Data(repeating: 0xC3, count: 32), true)]),
                                        "recoveries": .array(recoveries.map(HostValue.bytes))])))
    }

    /// A recovery up to the first question: typed, read, the log told.
    private func asked(_ rig: Rig) async throws -> Task<Void, Error> {
        let task = begin(rig)
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never reading", at(.reading))
        logRead(rig.harness.link, recoveries: [try await keyID(rig, secret)])
        _ = await wait(rig.controller, "no question", at(.askDevices(others: 2)))
        try await task.value
        return task
    }

    // MARK: the order (2.3)

    func testTheKeyIsTypedThenTheReadingConnectionProvesWithItAndNothingIsSent() async throws {
        let rig = try makeRig()
        let task = begin(rig)
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never reading", at(.reading))
        try await task.value
        let request = try XCTUnwrap(rig.harness.request)
        let id = try await keyID(rig, secret)
        XCTAssertEqual(request.key, id)
        XCTAssertEqual(request.signName, "recovery.entered.sign")
        XCTAssertNil(request.reset, "the reading connection sends no reset")
        XCTAssertTrue(rig.harness.link.started)
        XCTAssertEqual(try rig.pairing.load()?.stage, .keysMade(.recover), "nothing past keys-made is stored before the questions")
        XCTAssertTrue(rig.keys.has("device.sign"))
    }

    func testTheLogClosesTheConnectionAndAsksTheFirstQuestionWithTheOtherActiveDevices() async throws {
        let rig = try makeRig()
        _ = try await asked(rig)
        XCTAssertTrue(rig.harness.link.stopped, "the reading connection is closed before the person answers")
    }

    func testNoKeepsEveryActiveDeviceAndTheKeepAnswerMakesNoNewKey() async throws {
        let rig = try makeRig()
        _ = try await asked(rig)
        let asked = await rig.controller.answerDevices(someoneElse: false)
        XCTAssertTrue(asked)
        _ = await wait(rig.controller, "no second question", at(.askNewKey))
        try await rig.controller.answerNewKey(make: false)
        _ = await wait(rig.controller, "never sending", at(.sending))
        let request = try XCTUnwrap(rig.harness.request)
        let reset = try XCTUnwrap(request.reset)
        XCTAssertEqual(reset.trusted, [kept, Data(repeating: 0xC3, count: 32)], "the devices active in the log read, the one removed left out")
        XCTAssertEqual(reset.proof.count, 64)
        XCTAssertNil(reset.replacement)
        let state = try XCTUnwrap(try rig.pairing.load())
        XCTAssertEqual(state.stage, .recovering)
        XCTAssertEqual(state.proof, reset.proof)
        let stored = try XCTUnwrap(state.recovery?.reset)
        let id = try await keyID(rig, secret)
        XCTAssertEqual(stored, PairingReset(key: request.key, keepOthers: true, active: [kept, Data(repeating: 0xC3, count: 32)], replacement: nil, previous: [id]))
        XCTAssertTrue(rig.harness.link.started)
    }

    func testYesKeepsThisDeviceAlone() async throws {
        let rig = try makeRig()
        _ = try await asked(rig)
        _ = await rig.controller.answerDevices(someoneElse: true)
        try await rig.controller.answerNewKey(make: false)
        let reset = try XCTUnwrap(rig.harness.request?.reset)
        XCTAssertEqual(reset.trusted, [])
        let stored = try XCTUnwrap(try rig.pairing.load()?.recovery?.reset)
        XCTAssertFalse(stored.keepOthers)
        XCTAssertEqual(stored.active.count, 2, "the answer is stored with the devices read, so a rebuild never asks again")
    }

    func testANewKeyIsStoredBeforeItIsShownAndItsPublicKeysGoIntoTheReset() async throws {
        let rig = try makeRig()
        _ = try await asked(rig)
        _ = await rig.controller.answerDevices(someoneElse: false)
        let controller = rig.controller
        let answering = Task { try await controller.answerNewKey(make: true) }
        let phase = await wait(rig.controller, "no sheet") { if case .showingSheet = $0 { true } else { false } }
        guard case .showingSheet(let sheet) = phase else { return }
        let made = try XCTUnwrap(try rig.pairing.load()?.recovery?.made)
        XCTAssertEqual(made.count, 1, "its id is on disk before it is shown")
        XCTAssertTrue(sheet.context.contains("Person: \(hex(person))"))
        sheet.answer(true)
        try await answering.value
        let reset = try XCTUnwrap(rig.harness.request?.reset)
        XCTAssertEqual(reset.replacement?.signing.count, 65)
        XCTAssertEqual(try rig.pairing.load()?.recovery?.reset?.replacement, reset.replacement)
        XCTAssertEqual(try rig.pairing.load()?.recovery?.made, made)
    }

    func testADeclinedSheetAsksTheQuestionAgainAndKeepsTheIdOfTheKeyShown() async throws {
        let rig = try makeRig()
        _ = try await asked(rig)
        _ = await rig.controller.answerDevices(someoneElse: false)
        let controller = rig.controller
        let answering = Task { try await controller.answerNewKey(make: true) }
        guard case .showingSheet(let sheet) = await wait(rig.controller, "no sheet", { if case .showingSheet = $0 { true } else { false } }) else { return }
        sheet.answer(false)
        try await answering.value
        _ = await wait(rig.controller, "not asked again", at(.askNewKey))
        XCTAssertEqual(try rig.pairing.load()?.recovery?.made.count, 1)
        XCTAssertEqual(try rig.pairing.load()?.stage, .keysMade(.recover), "no reset was stored")
        let second = Task { try await controller.answerNewKey(make: true) } // the name `recovery.next` is free again after the sheet
        guard case .showingSheet(let again) = await wait(rig.controller, "no second sheet", { if case .showingSheet = $0 { true } else { false } }) else { return }
        again.answer(false)
        try await second.value
    }

    func testThePlacedResetMovesTheStoreToRecoveredAndDropsTheProof() async throws {
        let rig = try makeRig()
        _ = try await asked(rig)
        _ = await rig.controller.answerDevices(someoneElse: false)
        try await rig.controller.answerNewKey(make: false)
        rig.harness.link.emit(.recovered)
        _ = await wait(rig.controller, "never placed", at(.placed))
        let state = try XCTUnwrap(try rig.pairing.load())
        XCTAssertEqual(state.stage, .recovered)
        XCTAssertNil(state.proof)
        XCTAssertNotNil(state.recovery?.reset, "the ids stay for the opening of the past")
    }

    // MARK: refusals (2.5)

    func testARefusalThatTheKeyIsNotCurrentPutsTheKeysAwayAndLetsAnotherBeTyped() async throws {
        let rig = try makeRig()
        let task = begin(rig)
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never reading", at(.reading))
        try await task.value
        rig.harness.link.emit(.recovery(.object(["refused": .number(3)])))
        _ = await wait(rig.controller, "not refused", at(.refused(.notCurrent)))
        let controller = rig.controller
        let again = Task { await controller.typeAnotherKey() } // the host refuses at once if the first key were still held
        await type(rig.controller, other)
        _ = await wait(rig.controller, "no second reading", at(.reading))
        await again.value
        XCTAssertEqual(rig.harness.links.count, 2)
        let id = try await keyID(rig, other)
        XCTAssertEqual(rig.harness.request?.key, id)
    }

    func testARefusalOfThePersonAsksForNothingMore() async throws {
        let rig = try makeRig()
        let task = begin(rig)
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never reading", at(.reading))
        try await task.value
        rig.harness.link.emit(.recovery(.object(["refused": .number(2)])))
        _ = await wait(rig.controller, "not refused", at(.refused(.unknownPerson)))
        await rig.controller.typeAnotherKey()
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .recovering(.refused(.unknownPerson)))
    }

    func testTheKeyMadeInARecoveryThatStoppedIsNamedAndNothingIsSent() async throws {
        let rig = try makeRig(state: started([try await keyID(try makeRig(), secret)]))
        await rig.controller.launch() // a restart at keys-made: the ids stay
        let note = await rig.controller.phase
        XCTAssertEqual(note, .unpaired(.staleRecoveryKey))
        let task = begin(rig)
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "not refused", at(.refused(.madeEarlier)))
        try await task.value
        XCTAssertTrue(rig.harness.links.isEmpty)
    }

    func testAFaultOfTheLogStopsTheRecoveryAndOffersOnlyPairAgain() async throws {
        let rig = try makeRig()
        let task = begin(rig)
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never reading", at(.reading))
        try await task.value
        rig.harness.link.emit(.recovery(.object(["fault": .string("a log entry that does not hold")])))
        let phase = await wait(rig.controller, "no fault") { if case .linkFaulted = $0 { true } else { false } }
        XCTAssertEqual(phase, .linkFaulted(PairingPhase.linkFaultAdvice))
        XCTAssertTrue(rig.harness.link.stopped)
    }

    func testARemovalAtRecoveringIsThisDeviceRemoved() async throws {
        let rig = try makeRig(keys: true, state: try await recovering(try makeRig(), keepOthers: true))
        await rig.controller.launch()
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never sending", at(.sending))
        rig.harness.link.emit(.delivered(.object(["do": .string("refused"), "reason": .number(1)])))
        _ = await wait(rig.controller, "not removed") { $0 == .removed }
    }

    // MARK: cancel and decline

    func testACancelWhileTheKeyIsAskedDeclinesItAndErasesTheAttempt() async throws {
        let rig = try makeRig()
        let task = begin(rig)
        let phase = await wait(rig.controller, "no entry asked") { if case .recovering(.typeKey) = $0 { true } else { false } }
        XCTAssertNotNil(phase)
        let outcome = await rig.controller.cancel()
        XCTAssertEqual(outcome, .abandoning)
        try await task.value
        _ = await wait(rig.controller, "not unpaired") { $0 == .unpaired(nil) }
        XCTAssertNil(try rig.pairing.load())
        XCTAssertFalse(rig.keys.has("device.sign"))
        XCTAssertTrue(rig.harness.links.isEmpty)
    }

    func testACancelAtAQuestionErasesTheKeysTheLinkAndTheStore() async throws {
        let rig = try makeRig()
        _ = try await asked(rig)
        let outcome = await rig.controller.cancel()
        XCTAssertEqual(outcome, .erased)
        XCTAssertNil(try rig.pairing.load())
        XCTAssertFalse(rig.keys.has("device.receive"))
        let again = begin(rig) // the held keys were put away: a new attempt may type its key
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never reading", at(.reading))
        try await again.value
    }

    func testAKeyThatDoesNotReadIsADeclineNotAHang() async throws {
        let rig = try makeRig()
        let task = begin(rig)
        let phase = await wait(rig.controller, "no entry asked") { if case .recovering(.typeKey) = $0 { true } else { false } }
        guard case .recovering(.typeKey(let request)) = phase else { return }
        request.entry.append(0x31) // one symbol of fifty-three
        request.answer(true)
        try await task.value
        _ = await wait(rig.controller, "not unpaired") { $0 == .unpaired(nil) }
        XCTAssertNil(try rig.pairing.load())
    }

    // MARK: a restart (2.7)

    func testARestartAtKeysMadeErasesTheKeysAndTheLinkAndKeepsTheStoreForItsIds() async throws {
        let rig = try makeRig(keys: true, state: started([kept]))
        await rig.controller.launch()
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .unpaired(.staleRecoveryKey))
        XCTAssertFalse(rig.keys.has("device.sign"))
        XCTAssertEqual(try rig.pairing.load()?.recovery?.made, [kept])
        let bare = try makeRig(keys: true, state: started())
        await bare.controller.launch()
        let none = await bare.controller.phase
        XCTAssertEqual(none, .unpaired(nil))
    }

    func testARestartAtRecoveringAsksForTheKeyThenSendsTheStoredInputsWithoutAskingAgain() async throws {
        let rig = try makeRig(keys: true, state: try await recovering(try makeRig(), keepOthers: false))
        await rig.controller.launch()
        XCTAssertTrue(rig.harness.links.isEmpty, "no connection before the key is typed")
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never sending", at(.sending))
        let reset = try XCTUnwrap(rig.harness.request?.reset)
        XCTAssertEqual(reset.trusted, [], "the stored answer Yes stands")
        XCTAssertEqual(reset.proof, Data(repeating: 5, count: 64))
    }

    func testARestartAtRecoveringRefusesAKeyThatDidNotStartTheRecoveryAndSendsNothing() async throws {
        let rig = try makeRig(keys: true, state: try await recovering(try makeRig()))
        await rig.controller.launch()
        await type(rig.controller, other)
        _ = await wait(rig.controller, "not refused", at(.refused(.notTheStartKey)))
        XCTAssertTrue(rig.harness.links.isEmpty)
        let controller = rig.controller
        let again = Task { await controller.typeAnotherKey() }
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never sending", at(.sending))
        await again.value
    }

    func testARestartAtRecoveredRunsAnOrdinaryConnection() async throws {
        var state = try await recovering(try makeRig())
        (state.stage, state.proof) = (.recovered, nil)
        let rig = try makeRig(keys: true, state: state)
        await rig.controller.launch()
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .recovering(.placed))
        XCTAssertEqual(rig.harness.recoveries.count, 1)
        XCTAssertNil(rig.harness.recoveries[0], "the device is active: no reset is sent again")
    }

    func testADeadEndStartsARecoveryAfterErasingTheOldKeys() async throws {
        let rig = try makeRig(keys: true, state: PairingState(stage: .paired, relay: relay, person: person))
        await rig.controller.launch()
        rig.harness.link.emit(.delivered(.object(["do": .string("refused"), "reason": .number(1)])))
        _ = await wait(rig.controller, "not removed") { $0 == .removed }
        let task = begin(rig)
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never reading", at(.reading))
        try await task.value
        XCTAssertEqual(try rig.pairing.load()?.stage, .keysMade(.recover))
    }

    func testAFormThatIsWrongIsRefusedBeforeAnythingIsWritten() async throws {
        let rig = try makeRig()
        await rig.controller.launch()
        do {
            try await rig.controller.startRecovery(person: "abc", address: "relay.example:8443", relayKey: hex(relayKey))
            XCTFail("no error")
        } catch { XCTAssertEqual(error as? PairingInputError, .person) }
        XCTAssertNil(try rig.pairing.load())
        XCTAssertFalse(rig.keys.has("device.sign"))
    }

    // MARK: review of the controller's first commit

    /// Design 2.2 and crypto.md: every stop that ends a recovery puts the typed recovery key away; a removal at `recovering` is one.
    func testARemovalAtRecoveringPutsTheTypedRecoveryKeyAway() async throws {
        let rig = try makeRig(keys: true, state: try await recovering(try makeRig()))
        await rig.controller.launch()
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never sending", at(.sending))
        rig.harness.link.emit(.delivered(.object(["do": .string("refused"), "reason": .number(1)])))
        _ = await wait(rig.controller, "not removed") { $0 == .removed }
        try await assertNoRecoveryKeyHeld(rig)
    }

    func testAPutBackAndAFaultAtRecoveringPutTheTypedRecoveryKeyAway() async throws {
        for delivered in ["put-back", "fault"] {
            let rig = try makeRig(keys: true, state: try await recovering(try makeRig()))
            await rig.controller.launch()
            await type(rig.controller, secret)
            _ = await wait(rig.controller, "never sending", at(.sending))
            rig.harness.link.emit(.delivered(.object(["do": .string(delivered)])))
            _ = await wait(rig.controller, "not ended") { if case .putBack = $0 { true } else if case .linkFaulted = $0 { true } else { false } }
            try await assertNoRecoveryKeyHeld(rig)
        }
    }

    private func assertNoRecoveryKeyHeld(_ rig: Rig, line: UInt = #line) async throws {
        let host = try await rig.controller.hostMade()
        do {
            _ = try await host.enterRecovery("recovery.entered") // `key-exists` before the person is asked, if still held
            XCTFail("no refusal", line: line)
        } catch let refused as RecoveryRefused {
            XCTAssertNotEqual(refused.reason, "key-exists", "the typed recovery key is still held", line: line)
        }
    }

    /// Design 2.5 row 3: at `recovering` the reset's own new key typed back is named as the new key, never as the key that opens nothing.
    func testTheResetsNewKeyTypedAtRecoveringIsNamedAsTheNewKeyAndTheStartKeyIsAskedFor() async throws {
        let next = try await ProtocolHost(scriptPath: rig0Script(), store: SoftwareKeyStore(), person: .typing(other)).enterRecovery("probe")
        var state = try await recovering(try makeRig())
        state.recovery?.made = [next.id]
        state.recovery?.reset?.replacement = PairingRecoveryKeys(signing: next.signing, receiving: next.receiving)
        let rig = try makeRig(keys: true, state: state)
        await rig.controller.launch()
        await type(rig.controller, other)
        _ = await wait(rig.controller, "not named", at(.refused(.yourNewKey)))
        XCTAssertTrue(rig.harness.links.isEmpty)
    }

    private func rig0Script() throws -> String { try XCTUnwrap(ProcessInfo.processInfo.environment["PARDNER_APP_SCRIPT"]) }

    /// Design 2.7: a decline of the key at a restart in `recovering` keeps the device keys and the stored reset (it may be placed) and waits to be asked again.
    func testADeclineOfTheKeyAtARestartInRecoveringKeepsTheRecoveryAndOffersToTypeAgain() async throws {
        let rig = try makeRig(keys: true, state: try await recovering(try makeRig()))
        await rig.controller.launch()
        _ = await wait(rig.controller, "no entry asked") { if case .recovering(.typeKey) = $0 { true } else { false } }
        let outcome = await rig.controller.cancel()
        XCTAssertEqual(outcome, .abandoning)
        _ = await wait(rig.controller, "not waiting", at(.refused(.notTyped)))
        XCTAssertEqual(try rig.pairing.load()?.stage, .recovering)
        XCTAssertTrue(rig.keys.has("device.sign"))
        let controller = rig.controller
        let again = Task { await controller.typeAnotherKey() }
        await type(rig.controller, secret) // not declined by a flag left from the cancel
        _ = await wait(rig.controller, "never sending", at(.sending))
        await again.value
    }

    func testAKeyThatDoesNotReadAtARestartInRecoveringKeepsTheRecoveryToo() async throws {
        let rig = try makeRig(keys: true, state: try await recovering(try makeRig()))
        await rig.controller.launch()
        guard case .recovering(.typeKey(let request)) = await wait(rig.controller, "no entry asked", { if case .recovering(.typeKey) = $0 { true } else { false } }) else { return }
        request.entry.append(0x31)
        request.answer(true)
        _ = await wait(rig.controller, "not waiting", at(.refused(.notTyped)))
        XCTAssertEqual(try rig.pairing.load()?.stage, .recovering)
        XCTAssertTrue(rig.keys.has("device.sign"))
    }

    /// There is no stop of a recovery whose reset is stored: the device may be in the log.
    func testNothingCancelsARecoveryWhoseResetIsStored() async throws {
        let rig = try makeRig(keys: true, state: try await recovering(try makeRig()))
        await rig.controller.launch()
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never sending", at(.sending))
        let outcome = await rig.controller.cancel()
        XCTAssertEqual(outcome, .notCancellable)
        XCTAssertEqual(try rig.pairing.load()?.stage, .recovering)
    }

    func testTheReadingStepCanBeCancelledWhileTheRelayAnswersNothing() async throws {
        let rig = try makeRig()
        let task = begin(rig)
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never reading", at(.reading))
        try await task.value
        let outcome = await rig.controller.cancel()
        XCTAssertEqual(outcome, .erased)
        XCTAssertNil(try rig.pairing.load())
        XCTAssertTrue(rig.harness.link.stopped)
    }

    /// Two starts from a dead end: the second finds the phase taken and is refused, so no second attempt erases the first's keys.
    func testASecondStartFromADeadEndIsRefused() async throws {
        let rig = try makeRig(keys: true, state: PairingState(stage: .paired, relay: relay, person: person))
        await rig.controller.launch()
        rig.harness.link.emit(.delivered(.object(["do": .string("refused"), "reason": .number(1)])))
        _ = await wait(rig.controller, "not removed") { $0 == .removed }
        let (controller, relayText, personText, key) = (rig.controller, "relay.example:8443", hex(person), hex(relayKey))
        let first = Task { try await controller.startRecovery(person: personText, address: relayText, relayKey: key) }
        let second = Task { try await controller.startRecovery(person: personText, address: relayText, relayKey: key) }
        await type(rig.controller, secret)
        var refused = 0
        for result in [await first.result, await second.result] {
            if case .failure(let error) = result, error as? PairingInputError == .notReady { refused += 1 }
        }
        XCTAssertEqual(refused, 1, "exactly one of two concurrent starts is refused")
    }

    /// A removal answered to a submit (code 5) is this device removed at every stage the delivered refusal 1 is.
    func testAnAnswerFiveToASubmitAtRecoveredIsThisDeviceRemoved() async throws {
        var state = try await recovering(try makeRig())
        (state.stage, state.proof) = (.recovered, nil)
        let rig = try makeRig(keys: true, state: state)
        await rig.controller.launch()
        rig.harness.link.submitOutcome = .code(5)
        _ = try await rig.controller.submit(kind: 1, signed: Data([1]), sig: Data([2]))
        _ = await wait(rig.controller, "not removed") { $0 == .removed }
    }

    /// An answer given after another answer changes nothing: a decline that arrives after the typed key was handed over must not wipe the buffer the host thread reads.
    func testADeclineAfterTheKeyWasHandedOverLeavesTheTypedKeyForTheHost() {
        let request = RecoveryEntryRequest(gate: SheetGate())
        request.entry.append(0x31)
        request.answer(true)
        request.answer(false)
        XCTAssertEqual(request.entry.count, 1)
    }

    /// A cancel that lands after the new key's sheet was confirmed either stops the recovery or finds nothing to stop; it never answers `.abandoning` and
    /// then lets the reset go. The window is a few awaits wide, so the test tries it many times; it cannot force the interleaving.
    func testACancelAfterTheSheetIsConfirmedNeverLetsTheResetGoOnceItAnswersAbandoning() async throws {
        for _ in 0..<15 {
            let rig = try makeRig()
            _ = try await asked(rig)
            _ = await rig.controller.answerDevices(someoneElse: false)
            let controller = rig.controller
            let answering = Task { try? await controller.answerNewKey(make: true) }
            guard case .showingSheet(let sheet) = await wait(rig.controller, "no sheet", { if case .showingSheet = $0 { true } else { false } }) else { return }
            sheet.answer(true)
            let outcome = await rig.controller.cancel()
            await answering.value
            if outcome == .abandoning {
                _ = await wait(rig.controller, "not erased") { $0 == .unpaired(nil) }
                XCTAssertNil(try rig.pairing.load(), "the recovery was cancelled and went on")
                XCTAssertEqual(rig.harness.links.count, 1, "the reset's connection started after a cancel")
            }
        }
    }

    /// A connection error once the reset is stored is a stop too: the typed recovery key is put away before the fault is shown.
    func testAConnectionErrorAfterTheResetIsStoredPutsTheTypedKeyAway() async throws {
        let rig = try makeRig(failingCall: 2) // the reset's connection
        _ = try await asked(rig)
        _ = await rig.controller.answerDevices(someoneElse: true)
        do {
            try await rig.controller.answerNewKey(make: false)
            XCTFail("the connection did not fail")
        } catch {}
        let phase = await rig.controller.phase
        guard case .fault = phase else { return XCTFail("\(phase)") }
        XCTAssertEqual(try rig.pairing.load()?.stage, .recovering)
        try await assertNoRecoveryKeyHeld(rig)
    }

    // MARK: opening the past and done (2.6)

    private let (channel, epochA, epochB) = (Data(repeating: 0xC1, count: 32), Data(repeating: 0xE1, count: 32), Data(repeating: 0xE2, count: 32))
    private let current = Data(repeating: 0xCC, count: 32)

    private func epoch(_ id: Data, open: Bool, _ sealedTo: [Data]) -> RecoveryReading.Epoch { .init(channel: channel, epoch: id, open: open, sealedTo: sealedTo) }

    /// A recovery placed in this run: the key typed to start is held and given to the link.
    private func placed(_ keepKey: Bool = true) async throws -> Rig {
        let rig = try makeRig()
        _ = try await asked(rig)
        _ = await rig.controller.answerDevices(someoneElse: false)
        try await rig.controller.answerNewKey(make: false)
        rig.harness.link.emit(.recovered)
        _ = await wait(rig.controller, "never placed", at(.placed))
        return rig
    }

    private func rest(_ rig: Rig, _ reading: RecoveryReading) {
        rig.harness.link.reading = reading
        rig.harness.link.emit(.delivered(.object(["do": .string("rest")])))
    }

    private func opening(_ rig: Rig) async -> RecoveryProgress? {
        if case .recovering(.opening(let progress)) = await wait(rig.controller, "not opening", { if case .recovering(.opening) = $0 { true } else { false } }) { return progress }
        return nil
    }

    func testPlacedGivesTheKeyTypedToStartToTheLinkToOpenWith() async throws {
        let rig = try await placed()
        XCTAssertEqual(rig.harness.link.holds.map(\.receiving), ["recovery.entered.receive"])
        let start = try await keyID(rig, secret)
        XCTAssertEqual(rig.harness.link.holds.first?.id, start)
    }

    func testDoneOnTheKeepPathDropsTheKeysAndSaysToKeepTheKeyTypedToStart() async throws {
        let rig = try await placed()
        let start = try await keyID(rig, secret)
        rest(rig, RecoveryReading(epochs: [epoch(epochA, open: true, [start])], recoveries: [start], current: start))
        let phase = await wait(rig.controller, "not done") { if case .recovering(.done) = $0 { true } else { false } }
        XCTAssertEqual(phase, .recovering(.done(RecoveryDone(destroyable: [], keep: start))))
        XCTAssertEqual(try rig.pairing.load()?.stage, .paired)
        XCTAssertNil(try rig.pairing.load()?.recovery)
        try await assertNoRecoveryKeyHeld(rig)
        await rig.controller.acknowledgeRecoveryDone()
        let after = await rig.controller.phase
        XCTAssertEqual(after, .paired)
    }

    func testAnEpochSealedToAnEarlierKeyNotTypedWaitsAndTypingTheKeyOpensItAndDoneNamesTheKeysToDestroy() async throws {
        let rig = try await placed()
        let (start, earlier) = (try await keyID(rig, secret), try await keyID(rig, other))
        let link = rig.harness.link
        link.onHold = { id in
            if id == earlier { link.reading = RecoveryReading(epochs: [self.epoch(self.epochA, open: true, [self.current]), self.epoch(self.epochB, open: true, [earlier, self.current])], recoveries: [earlier, start, self.current], current: self.current) }
        }
        rest(rig, RecoveryReading(epochs: [epoch(epochA, open: true, [current]), epoch(epochB, open: false, [earlier, current])], recoveries: [earlier, start, current], current: current))
        let found = await opening(rig)
        let progress = try XCTUnwrap(found)
        XCTAssertEqual(progress.waiting.map(\.key), [earlier, current], "any key it is sealed to opens it; the current key is asked for while it is not held")
        XCTAssertEqual(progress.unsealed, 0)
        let controller = rig.controller
        let typing = Task { await controller.typeEarlierKey() }
        await type(rig.controller, other)
        await typing.value
        XCTAssertEqual(link.holds.map(\.receiving), ["recovery.entered.receive", "recovery.earlier.1.receive"])
        let phase = await wait(rig.controller, "not done") { if case .recovering(.done) = $0 { true } else { false } }
        XCTAssertEqual(phase, .recovering(.done(RecoveryDone(destroyable: [start, earlier], keep: nil))), "the new key path: the key typed to start can go as well")
        try await assertNoRecoveryKeyHeld(rig)
    }

    func testAKeyThatIsNoneOfTheLogsRecoveryKeysIsPutAwayAndSaidSo() async throws {
        let rig = try await placed()
        let (start, earlier) = (try await keyID(rig, secret), try await keyID(rig, other))
        rest(rig, RecoveryReading(epochs: [epoch(epochB, open: false, [earlier, current])], recoveries: [earlier, start, current], current: current))
        _ = await opening(rig)
        let stranger = Data((201...232).map { UInt8($0) })
        let controller = rig.controller
        let typing = Task { await controller.typeEarlierKey() }
        await type(rig.controller, stranger)
        await typing.value
        XCTAssertEqual(rig.harness.link.holds.count, 1, "a stranger's key is not given to the link")
        let found = await opening(rig)
        let progress = try XCTUnwrap(found)
        XCTAssertTrue(progress.refusedKey)
    }

    func testGivingUpAKeyLetsDoneStopWaitingOnItsEpochs() async throws {
        let rig = try await placed()
        let (start, earlier) = (try await keyID(rig, secret), try await keyID(rig, other))
        rest(rig, RecoveryReading(epochs: [epoch(epochA, open: true, [current]), epoch(epochB, open: false, [earlier])], recoveries: [earlier, start, current], current: current))
        _ = await opening(rig)
        await rig.controller.giveUp(key: start) // not a key it waits on: nothing changes
        let still = await rig.controller.phase
        if case .recovering(.opening) = still {} else { XCTFail("\(still)") }
        await rig.controller.giveUp(key: earlier)
        _ = await wait(rig.controller, "not done") { if case .recovering(.done) = $0 { true } else { false } }
    }

    func testAnEpochSealedToAKeyThatWasTypedButNotOpenedIsExceptedAndDoesNotBlockDone() async throws {
        let rig = try await placed()
        let (start, earlier) = (try await keyID(rig, secret), try await keyID(rig, other))
        rest(rig, RecoveryReading(epochs: [epoch(epochA, open: true, [current]), epoch(epochB, open: false, [start, earlier, current])], recoveries: [earlier, start, current], current: current))
        _ = await wait(rig.controller, "not done") { if case .recovering(.done) = $0 { true } else { false } }
    }

    func testDoneWaitsUntilTheRelayShowsASealToTheCurrentKeyForEveryEpochHeld() async throws {
        let rig = try await placed()
        let start = try await keyID(rig, secret)
        rest(rig, RecoveryReading(epochs: [epoch(epochA, open: true, [start])], recoveries: [start, current], current: current))
        let found = await opening(rig)
        let progress = try XCTUnwrap(found)
        XCTAssertEqual(progress.unsealed, 1)
        XCTAssertTrue(progress.waiting.isEmpty)
        rest(rig, RecoveryReading(epochs: [epoch(epochA, open: true, [start, current])], recoveries: [start, current], current: current))
        _ = await wait(rig.controller, "not done") { if case .recovering(.done) = $0 { true } else { false } }
    }

    func testARestartAtRecoveredAsksForTheKeyTypedToStartAgainWhenItsEpochsAreNotOpened() async throws {
        var state = try await recovering(try makeRig())
        (state.stage, state.proof) = (.recovered, nil)
        let rig = try makeRig(keys: true, state: state)
        await rig.controller.launch()
        let start = try await keyID(rig, secret)
        rest(rig, RecoveryReading(epochs: [epoch(epochA, open: false, [start, current])], recoveries: [start, current], current: current))
        let found = await opening(rig)
        let progress = try XCTUnwrap(found)
        XCTAssertEqual(progress.waiting.map(\.key), [start, current], "nothing is held after a restart, so done is never declared from what this run holds")
    }

    /// The link reads again from the cursor after a connection drops: nothing is declared from the partial read, only from the next rest.
    func testNothingIsEvaluatedBetweenADroppedConnectionAndTheNextRest() async throws {
        let rig = try await placed()
        let (start, earlier) = (try await keyID(rig, secret), try await keyID(rig, other))
        rest(rig, RecoveryReading(epochs: [epoch(epochB, open: false, [earlier, current])], recoveries: [earlier, start, current], current: current))
        _ = await opening(rig)
        rig.harness.link.emit(.dialing)
        try await Task.sleep(for: .milliseconds(150)) // the controller takes the event
        rig.harness.link.reading = RecoveryReading(epochs: [epoch(epochA, open: true, [start, current])], recoveries: [earlier, start, current], current: current)
        await rig.controller.giveUp(key: earlier)
        await rig.controller.giveUp(key: current)
        let partial = await rig.controller.phase
        if case .recovering(.done) = partial { XCTFail("done came from a partial read") }
        rest(rig, rig.harness.link.reading!)
        _ = await wait(rig.controller, "not done at the rest") { if case .recovering(.done) = $0 { true } else { false } }
    }

    // MARK: review of the third commit

    /// After a fault and Retry the new link holds no recovery key: done never counts the keys the old link held.
    func testDoneAfterARetryDoesNotCountAKeyTheNewLinkDoesNotHold() async throws {
        let rig = try await placed()
        let start = try await keyID(rig, secret)
        rest(rig, RecoveryReading(epochs: [epoch(epochA, open: true, [start])], recoveries: [start, current], current: current))
        _ = await opening(rig)
        _ = try rig.keys.make("recovery.earlier.1.sign", .sign) // the name is taken: typing an earlier key faults
        await rig.controller.typeEarlierKey()
        _ = await wait(rig.controller, "no fault") { if case .fault(.failed, _) = $0 { true } else { false } }
        let retried = await rig.controller.retry()
        XCTAssertTrue(retried)
        rest(rig, RecoveryReading(epochs: [epoch(epochA, open: false, [start])], recoveries: [start, current], current: current))
        let phase = await wait(rig.controller, "neither opening nor done") { if case .recovering(.opening) = $0 { true } else if case .recovering(.done) = $0 { true } else { false } }
        if case .recovering(.done) = phase { XCTFail("done came early, the start key counted as held") }
        XCTAssertEqual(rig.harness.link.holds.count, 0)
    }

    /// A restart at `recovered` on the keep path: the current key is the start key, not held, so an epoch sealed only to it is asked for.
    func testARestartOnTheKeepPathAsksForTheCurrentKeyWhenItIsNotHeld() async throws {
        var state = try await recovering(try makeRig())
        (state.stage, state.proof) = (.recovered, nil)
        let rig = try makeRig(keys: true, state: state)
        await rig.controller.launch()
        let start = try await keyID(rig, secret)
        rest(rig, RecoveryReading(epochs: [epoch(epochA, open: false, [start])], recoveries: [start], current: start))
        let found = await opening(rig)
        XCTAssertEqual(try XCTUnwrap(found).waiting.map(\.key), [start])
    }

    /// Two evaluations inside their await together declare done once: the second finds it declared.
    func testDoneIsDeclaredOnceWhenTwoEvaluationsMeet() async throws {
        let rig = try await placed()
        let (start, earlier) = (try await keyID(rig, secret), try await keyID(rig, other))
        let pending = RecoveryReading(epochs: [epoch(epochA, open: true, [start]), epoch(epochB, open: false, [earlier])], recoveries: [earlier, start], current: start)
        rest(rig, pending)
        _ = await opening(rig)
        let gate = Latch()
        rig.harness.link.readingGate = gate
        let controller = rig.controller
        rest(rig, pending)
        let giving = Task { await controller.giveUp(key: earlier) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while rig.harness.link.readingsWaiting < 2, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(rig.harness.link.readingsWaiting, 2, "both evaluations are inside the reading")
        rig.harness.link.reading = RecoveryReading(epochs: [epoch(epochA, open: true, [start, start])], recoveries: [earlier, start], current: start)
        await gate.open()
        await giving.value
        _ = await wait(rig.controller, "not done") { if case .recovering(.done) = $0 { true } else { false } }
        try await Task.sleep(for: .milliseconds(200))
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .recovering(.done(RecoveryDone(destroyable: [], keep: start))), "a second declaration of done replaced the first")
    }

    /// A removal that arrives while an earlier key is typed stays: the typing does not put the phase back.
    func testARemovalWhileAnEarlierKeyIsTypedIsNotOverwritten() async throws {
        let rig = try await placed()
        let (start, earlier) = (try await keyID(rig, secret), try await keyID(rig, other))
        rest(rig, RecoveryReading(epochs: [epoch(epochB, open: false, [earlier, current])], recoveries: [earlier, start, current], current: current))
        _ = await opening(rig)
        let controller = rig.controller
        let typing = Task { await controller.typeEarlierKey() }
        guard case .recovering(.typeKey(let request)) = await wait(rig.controller, "no entry asked", { if case .recovering(.typeKey) = $0 { true } else { false } }) else { return }
        rig.harness.link.emit(.delivered(.object(["do": .string("refused"), "reason": .number(1)])))
        _ = await wait(rig.controller, "not removed") { $0 == .removed }
        let text = UnsafeMutableBufferPointer<UniChar>.allocate(capacity: RecoveryText.displayCount)
        defer { text.deallocate() }
        let buffer = SecretBuffer(other)
        RecoveryText.write(buffer, into: text)
        buffer.wipe()
        for character in text { request.entry.append(character) }
        request.answer(true)
        await typing.value
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .removed)
        try await assertNoRecoveryKeyHeld(rig)
    }

    /// A key the link refused is not held: its epochs are asked for, not excepted.
    func testAKeyTheLinkRefusedIsNotCountedAsHeld() async throws {
        let rig = try makeRig()
        _ = try await asked(rig)
        _ = await rig.controller.answerDevices(someoneElse: false)
        try await rig.controller.answerNewKey(make: false)
        rig.harness.link.holdResult = false // the reset's connection refuses the key it is given
        rig.harness.link.emit(.recovered)
        _ = await wait(rig.controller, "never placed", at(.placed))
        let start = try await keyID(rig, secret)
        rest(rig, RecoveryReading(epochs: [epoch(epochA, open: false, [start, current])], recoveries: [start, current], current: current))
        let found = await opening(rig)
        XCTAssertEqual(try XCTUnwrap(found).waiting.map(\.key), [start, current], "the refused start key still counted as held")
        try await assertNoRecoveryKeyHeld(rig)
    }

    func testAnEarlierKeyTheLinkRefusedIsPutAwayAndSaidSo() async throws {
        let rig = try await placed()
        let (start, earlier) = (try await keyID(rig, secret), try await keyID(rig, other))
        rest(rig, RecoveryReading(epochs: [epoch(epochB, open: false, [earlier, current])], recoveries: [earlier, start, current], current: current))
        _ = await opening(rig)
        rig.harness.link.holdResult = false
        let controller = rig.controller
        let typing = Task { await controller.typeEarlierKey() }
        await type(rig.controller, other)
        await typing.value
        let found = await opening(rig)
        let progress = try XCTUnwrap(found)
        XCTAssertTrue(progress.refusedKey)
        XCTAssertTrue(progress.waiting.contains { $0.key == earlier })
    }

    func testAnEpochOfAnUnexpectedShapeRefusesTheWholeReading() {
        let good = HostValue.object(["channel": .bytes(Data(repeating: 1, count: 32)), "epoch": .bytes(Data(repeating: 2, count: 32)), "open": .bool(true), "sealedTo": .array([.bytes(Data(repeating: 3, count: 32))])])
        XCTAssertNotNil(RecoveryReading.Epoch(good))
        XCTAssertNil(RecoveryReading.Epoch(.object(["channel": .bytes(Data()), "epoch": .bytes(Data(repeating: 2, count: 32)), "open": .string("yes"), "sealedTo": .array([])])))
        XCTAssertNil(RecoveryReading.Epoch(.object(["channel": .bytes(Data(repeating: 1, count: 32)), "epoch": .bytes(Data(repeating: 2, count: 32)), "open": .bool(true), "sealedTo": .array([.number(1)])])), "a recipient that is no bytes")
    }

    func testAnEpochNamesAKeyOnceWhateverTimesItIsSealedToIt() async throws {
        let rig = try makeRig()
        let key = Data(repeating: 0xAB, count: 32)
        let progress = PairingController.progress(RecoveryReading(epochs: [epoch(epochA, open: false, [key, key, current])], recoveries: [key, current], current: current), held: [], gaveUp: [])
        XCTAssertEqual(progress.waiting.first?.epochs.count, 1)
        _ = rig
    }

    /// The start key is kept only when it is the key held under the start name: a new key typed as an earlier one is never "the key you typed to start".
    func testKeepNamesOnlyTheKeyHeldUnderTheStartName() async throws {
        let rig = try await placed()
        let (start, earlier) = (try await keyID(rig, secret), try await keyID(rig, other))
        let link = rig.harness.link
        link.onHold = { id in
            if id == earlier { link.reading = RecoveryReading(epochs: [self.epoch(self.epochA, open: true, [earlier])], recoveries: [start, earlier], current: earlier) }
        }
        rest(rig, RecoveryReading(epochs: [epoch(epochA, open: false, [earlier])], recoveries: [start, earlier], current: earlier))
        _ = await opening(rig) // the new key `earlier` is current and not held: the epoch is only open to it
        let controller = rig.controller
        let typing = Task { await controller.typeEarlierKey() }
        await type(rig.controller, other)
        await typing.value
        let phase = await wait(rig.controller, "not done") { if case .recovering(.done) = $0 { true } else { false } }
        XCTAssertEqual(phase, .recovering(.done(RecoveryDone(destroyable: [start], keep: nil))))
    }

    /// A launch at `recovered` that the app's quit overtakes sets no phase.
    func testALaunchAtRecoveredAfterShutdownSetsNoPhase() async throws {
        var state = try await recovering(try makeRig())
        (state.stage, state.proof) = (.recovered, nil)
        let gate = Latch()
        let rig = try makeRig(keys: true, state: state, hostGate: gate)
        let controller = rig.controller
        let launching = Task { await controller.launch() }
        try await Task.sleep(for: .milliseconds(100))
        await controller.shutdown()
        await gate.open()
        await launching.value
        let phase = await controller.phase
        XCTAssertEqual(phase, .starting)
    }

    /// The current key is asked for as the current key and never offered "I no longer have this key": the person holds it (the new key, or the key typed to start).
    func testTheCurrentKeyIsMarkedAndGivingItUpDoesNothing() async throws {
        let (earlier, start) = (Data(repeating: 2, count: 32), Data(repeating: 1, count: 32))
        let reading = RecoveryReading(epochs: [epoch(epochB, open: false, [earlier, current])], recoveries: [earlier, start, current], current: current)
        let progress = PairingController.progress(reading, held: [start], gaveUp: [])
        XCTAssertEqual(progress.waiting.map(\.key), [earlier, current])
        XCTAssertEqual(progress.waiting.map(\.isCurrent), [false, true])
        let rig = try await placed()
        rest(rig, reading)
        _ = await opening(rig)
        await rig.controller.giveUp(key: current)
        rest(rig, reading)
        let after = await opening(rig)
        XCTAssertEqual(try XCTUnwrap(after).waiting.map(\.key), [earlier, current], "the current key stays asked for")
    }

    /// The new key of a placed reset is the current key: a recovery started afterwards from a dead end never calls it a key that opens nothing.
    func testTheCurrentKeyFromAPlacedRecoveryIsNotCalledAKeyThatOpensNothing() async throws {
        let next = try await ProtocolHost(scriptPath: try rig0Script(), store: SoftwareKeyStore(), person: .typing(other)).enterRecovery("probe")
        var state = try await recovering(try makeRig(), keepOthers: false, replacement: PairingRecoveryKeys(signing: next.signing, receiving: next.receiving))
        (state.stage, state.proof) = (.recovered, nil)
        state.recovery?.made = [next.id] // written at step 5, before the key was shown; the reset that carried it is placed
        let rig = try makeRig(keys: true, state: state)
        await rig.controller.launch()
        rig.harness.link.emit(.delivered(.object(["do": .string("refused"), "reason": .number(1)])))
        _ = await wait(rig.controller, "not removed") { $0 == .removed }
        let task = begin(rig)
        await type(rig.controller, other)
        _ = await wait(rig.controller, "never reading", at(.reading))
        try await task.value
        XCTAssertEqual(try rig.pairing.load()?.recovery?.made, [], "the current key is not carried as a key that opens nothing")
    }

    /// A key made in a recovery that stopped before its reset was stored is carried: only the placed reset's key is current.
    func testAKeyMadeInAStoppedRecoveryIsStillCarriedFromKeysMade() async throws {
        let rig = try makeRig(state: started([kept]))
        await rig.controller.launch()
        let task = begin(rig)
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never reading", at(.reading))
        try await task.value
        XCTAssertEqual(try rig.pairing.load()?.recovery?.made, [kept])
    }

    /// After a reset is stored a refusal of the person cannot be the person's fault to fix or to cancel: it is the same plain stop as a key that is no longer accepted.
    func testARefusalOfThePersonAtRecoveringIsItsOwnStop() async throws {
        let rig = try makeRig(keys: true, state: try await recovering(try makeRig()))
        await rig.controller.launch()
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never sending", at(.sending))
        rig.harness.link.emit(.recovery(.object(["refused": .number(2)])))
        _ = await wait(rig.controller, "not refused", at(.refused(.personGone)))
        let outcome = await rig.controller.cancel()
        XCTAssertEqual(outcome, .notCancellable)
    }
    /// The one stop of a stored recovery: the relay answered that the key is no longer current or no longer knows the person. Nothing is erased,
    /// the phase is one Retry leaves, and a later launch asks for the key again.
    func testQuitRecoveryAtAStoredRefusalKeepsEverythingAndRetryAsksForTheKeyAgain() async throws {
        for (answer, why) in [(3, RecoveryRefusal.noLongerCurrent), (2, .personGone)] {
            let rig = try makeRig(keys: true, state: try await recovering(try makeRig()))
            await rig.controller.launch()
            await type(rig.controller, secret)
            _ = await wait(rig.controller, "never sending", at(.sending))
            rig.harness.link.emit(.recovery(.object(["refused": .number(Double(answer))])))
            _ = await wait(rig.controller, "not refused", at(.refused(why)))
            let before = try rig.pairing.load()
            let quit = await rig.controller.quitRecovery()
            XCTAssertTrue(quit, "\(why)")
            let phase = await rig.controller.phase
            XCTAssertEqual(phase, .fault(.failed, PairingPhase.recoveryQuitAdvice))
            XCTAssertTrue(PairingPhase.recoveryQuitAdvice.hasPrefix("The recovery is paused."), "the store stays at recovering: it is not closed")
            XCTAssertTrue(PairingPhase.recoveryQuitAdvice.contains("Quit Pardner"), "the way out today")
            XCTAssertEqual(try rig.pairing.load(), before, "the stored reset is as it was")
            XCTAssertTrue(rig.keys.has("device.sign") && rig.keys.has("device.receive"))
            let retried = await rig.controller.retry()
            XCTAssertTrue(retried)
            _ = await wait(rig.controller, "no key asked again", { if case .recovering(.typeKey) = $0 { true } else { false } })
        }
    }

    /// Quit is for those two refusals alone: a reset in flight, or a key that can be typed again, has its own ways.
    func testQuitRecoveryIsRefusedWhereAnotherWayExists() async throws {
        let rig = try makeRig(keys: true, state: try await recovering(try makeRig()))
        await rig.controller.launch()
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never sending", at(.sending))
        let sending = await rig.controller.quitRecovery()
        XCTAssertFalse(sending, "no Stop once the reset is sent")
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .recovering(.sending))
    }

    // MARK: this Mac's earlier keys (2.4, R4-5; maintainer's decision 2026-11-22)

    private let earlier = Data(repeating: 0x5E, count: 32)

    /// A recovery started at the dead end `before` leaves, with the log read listing `earlier` as `active` and short form `5e5e 5e5e 5e5e 5e5e`.
    private func askedAfter(_ dead: PairingState, earlierActive: Bool = true) async throws -> Rig {
        let rig = try makeRig(state: dead)
        await rig.controller.launch()
        let task = begin(rig)
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never reading", at(.reading))
        let device = { (id: Data, active: Bool) in HostValue.object(["id": .bytes(id), "active": .bool(active), "short": .string("5e5e 5e5e 5e5e 5e5e")]) }
        rig.harness.link.emit(.recoveryLog(.object(["do": .string("recovery-log"), "devices": .array([device(kept, true), device(self.earlier, earlierActive)]), "recoveries": .array([])])))
        _ = await wait(rig.controller, "no question") { if case .recovering(.askDevices) = $0 { true } else { false } }
        try await task.value
        return rig
    }

    private func pairedBefore(device: Data?) -> PairingState {
        var state = PairingState(stage: .paired, relay: relay, person: person)
        state.device = device
        return state
    }

    func testTheEarlierDeviceIsNamedAndKeptWhenThisMacsKeysAreNotHere() async throws {
        let rig = try await askedAfter(pairedBefore(device: earlier))
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .recovering(.askDevices(others: 2, earlier: .named("5e5e 5e5e 5e5e 5e5e"))))
        XCTAssertEqual(try rig.pairing.load()?.earlier, earlier, "kept in the recovery's store, with the stage that rewrote it")
    }

    func testAMacPairedBeforeWithNoStoredIdGetsTheLineThatNamesNothing() async throws {
        let rig = try await askedAfter(pairedBefore(device: nil))
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .recovering(.askDevices(others: 2, earlier: .unnamed)))
        XCTAssertNil(try rig.pairing.load()?.earlier)
    }

    func testAnEarlierDeviceThatIsNotActiveInTheLogIsNotMentioned() async throws {
        let rig = try await askedAfter(pairedBefore(device: earlier), earlierActive: false)
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .recovering(.askDevices(others: 1, earlier: .notActive)))
    }

    /// After "removed" the earlier device is not active, and with no stored id nothing is known of it: no line.
    func testAfterRemovedWithNoStoredIdNothingIsSaidOfEarlierKeys() async throws {
        let rig = try makeRig(keys: true, state: pairedBefore(device: nil))
        await rig.controller.launch()
        rig.harness.link.emit(.delivered(.object(["do": .string("refused"), "reason": .number(1)])))
        _ = await wait(rig.controller, "not removed") { $0 == .removed }
        let task = begin(rig)
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never reading", at(.reading))
        logRead(rig.harness.link)
        _ = await wait(rig.controller, "no question", at(.askDevices(others: 2)))
        try await task.value
    }

    /// G1: a cancel erases the attempt's keys but keeps the file that holds the earlier id, as a restart does: the next attempt still names it.
    func testACancelKeepsTheEarlierDeviceForTheNextAttempt() async throws {
        let rig = try await askedAfter(pairedBefore(device: earlier))
        let outcome = await rig.controller.cancel()
        XCTAssertEqual(outcome, .erased)
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .unpaired(nil))
        XCTAssertEqual(try rig.pairing.load()?.earlier, earlier)
        XCTAssertFalse(rig.keys.has("device.sign"))
        let task = begin(rig)
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never reading", at(.reading))
        let device = HostValue.object(["id": .bytes(earlier), "active": .bool(true), "short": .string("5e5e 5e5e 5e5e 5e5e")])
        rig.harness.links.last!.emit(.recoveryLog(.object(["do": .string("recovery-log"), "devices": .array([device]), "recoveries": .array([])])))
        _ = await wait(rig.controller, "no question", at(.askDevices(others: 1, earlier: .named("5e5e 5e5e 5e5e 5e5e"))))
        try await task.value
    }

    /// G1: the unnamed origin survives a cancel in the same run.
    func testACancelKeepsTheUnnamedOriginForTheNextAttempt() async throws {
        let rig = try await askedAfter(pairedBefore(device: nil))
        _ = await rig.controller.cancel()
        let task = begin(rig)
        await type(rig.controller, secret)
        _ = await wait(rig.controller, "never reading", at(.reading))
        logRead(rig.harness.links.last!)
        _ = await wait(rig.controller, "no question", at(.askDevices(others: 2, earlier: .unnamed)))
        try await task.value
    }

    /// F2: the earlier id of a store at recovering or recovered is the device before that recovery, not the recovery's own: the line names nothing.
    func testAStoreAtRecoveringNeverNamesTheDeviceBeforeThatRecovery() async throws {
        var state = try await recovering(try makeRig())
        state.earlier = earlier
        let rig = try await askedAfter(state)
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .recovering(.askDevices(others: 2, earlier: .unnamed)))
        XCTAssertNil(try rig.pairing.load()?.earlier)
    }

    /// G2: a done that read no snapshot listing this Mac stores its id at the next read that does.
    func testDoneWithNoSnapshotStoresThisMacsIdAtTheNextRead() async throws {
        let rig = try await placed()
        let start = try await keyID(rig, secret)
        rest(rig, RecoveryReading(epochs: [epoch(epochA, open: true, [start])], recoveries: [start], current: start))
        _ = await wait(rig.controller, "not done") { if case .recovering(.done) = $0 { true } else { false } }
        XCTAssertNil(try rig.pairing.load()?.device)
        let me = Data(repeating: 0x6F, count: 32)
        let item = HostValue.object(["id": .bytes(me), "kind": .string("app"), "active": .bool(true), "short": .string("6f6f 6f6f 6f6f 6f6f"), "position": .number(1)])
        rig.harness.link.emit(.devices(.object(["person": .bytes(person), "length": .number(2), "last": .bytes(person), "self": .bytes(me), "devices": .array([item])])))
        for _ in 0..<200 where try rig.pairing.load()?.device == nil { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(try rig.pairing.load()?.device, me)
    }

    /// A restart at keys-made keeps the earlier id: the next start carries it.
    func testARestartAtKeysMadeKeepsTheEarlierDevice() async throws {
        var state = started()
        state.earlier = earlier
        let rig = try makeRig(keys: true, state: state)
        await rig.controller.launch()
        XCTAssertEqual(try rig.pairing.load()?.earlier, earlier)
    }

    /// The id is carried to done and the new pairing stores its own device id.
    func testDoneKeepsTheEarlierDeviceAndStoresThisMacsNewId() async throws {
        let rig = try await askedAfter(pairedBefore(device: earlier))
        _ = await rig.controller.answerDevices(someoneElse: false)
        try await rig.controller.answerNewKey(make: false)
        rig.harness.link.emit(.recovered)
        _ = await wait(rig.controller, "never placed", at(.placed))
        let start = try await keyID(rig, secret)
        let me = Data(repeating: 0x6F, count: 32)
        let item = HostValue.object(["id": .bytes(me), "kind": .string("app"), "active": .bool(true), "short": .string("6f6f 6f6f 6f6f 6f6f"), "position": .number(1)])
        rig.harness.link.emit(.devices(.object(["person": .bytes(person), "length": .number(2), "last": .bytes(person), "self": .bytes(me), "devices": .array([item])])))
        rest(rig, RecoveryReading(epochs: [epoch(epochA, open: true, [start])], recoveries: [start], current: start))
        _ = await wait(rig.controller, "not done") { if case .recovering(.done) = $0 { true } else { false } }
        XCTAssertEqual(try rig.pairing.load()?.device, me)
        XCTAssertEqual(try rig.pairing.load()?.earlier, earlier)
    }
}
