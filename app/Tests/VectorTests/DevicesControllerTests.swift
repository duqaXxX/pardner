// The devices of a person on the pairing controller (device pairing design 3.3, 3.4, 3.6, 3.7, 3.9, 3.10): the list, the add with its
// pending entry, the join of this Mac and the removal act. The connection is a stand-in; the entries and the pairing strings are real
// (DeviceFixtures), and the package is the real one. The real relay is tried by DevicesRelayTests. Needs PARDNER_APP_SCRIPT.
import CryptoKit
import Foundation
import Platform
@testable import ProtocolHost
@testable import Relay
import XCTest

private typealias F = DeviceFixtures

private final class Clock: @unchecked Sendable {
    var now = 1_000.0
}

/// True once: a hook that must act at one point only.
private final class Once: @unchecked Sendable {
    private var used = false
    func first() -> Bool { defer { used = true }; return !used }
}

final class DevicesControllerTests: XCTestCase {
    private let relayKey = P256.Signing.PrivateKey().publicKey.x963Representation

    private static func hold(_ gate: DispatchSemaphore) { _ = gate.wait(timeout: .now() + 20) } // a wait that cannot be async

    private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    private func folder(_ name: String) -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("pardner-devices-\(name)-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func bytes(_ hex: String) -> Data {
        var data = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            data.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        return data
    }

    private func entry(_ e: F.Entry) -> SignedEntry { SignedEntry(signed: bytes(e.signed), sig: bytes(e.sig), id: bytes(e.id)) }
    private var person: Data { bytes(F.person) }
    private var relay: PairingRelay { PairingRelay(host: "relay.example", port: 8443, key: relayKey) }

    private final class Links: @unchecked Sendable {
        var all: [FakeLink] = []
        var enrolments: [Enrolment?] = []
        var link: FakeLink { all.last! }
    }

    private struct Rig {
        let controller: PairingController
        let keys: SoftwareKeyStore
        let pairing: PairingStore
        let links: Links
        let clock: Clock
        let folders: (pairing: URL, link: URL)
    }

    private func controller(_ keys: SoftwareKeyStore, _ pairing: PairingStore, _ linkFolder: URL, _ links: Links, _ clock: Clock, prime: [RelayEvent] = []) throws -> PairingController {
        let script = try XCTUnwrap(ProcessInfo.processInfo.environment["PARDNER_APP_SCRIPT"], "run test/protocol/jsc.test.ts")
        return PairingController(
            keys: keys, pairing: pairing, linkFolder: linkFolder,
            makeHost: { keys, person in try await ProtocolHost(scriptPath: script, store: keys, person: person) },
            connect: { _, _, _, _, _, enrolment in
                let link = FakeLink()
                links.all.append(link)
                links.enrolments.append(enrolment)
                prime.forEach(link.emit) // buffered until the controller reads the stream
                return link
            },
            clock: { Date(timeIntervalSince1970: clock.now) })
    }

    /// A paired Mac whose log is `[genesis, addA1]` and whose own id is the first device's, unless a state is given.
    private func rig(keys: Bool = true, state: PairingState? = nil) throws -> Rig {
        let store = SoftwareKeyStore()
        if keys {
            _ = try store.make("device.sign", .sign)
            _ = try store.make("device.receive", .receive)
        }
        let pairingFolder = folder("pairing")
        let pairing = try PairingStore(folder: pairingFolder)
        var paired = PairingState(stage: .paired, relay: relay, person: person)
        paired.labels[bytes(F.a)] = "Studio Mac"
        try pairing.write(state ?? paired)
        let linkFolder = folder("link")
        let (links, clock) = (Links(), Clock())
        return Rig(controller: try controller(store, pairing, linkFolder, links, clock), keys: store, pairing: pairing, links: links, clock: clock, folders: (pairingFolder, linkFolder))
    }

    private func started(_ rig: Rig) async -> FakeLink {
        await rig.controller.launch()
        return rig.links.link
    }

    // MARK: effects and waits

    private struct Dev {
        let id: String
        var active = true
        var by: String?
        var position: Int
        var held = 0
        /// What the package says as the short form; the id's own groups when a test does not set it.
        var short: String?
    }

    private func effect(length: Int, last: F.Entry, devices: [Dev], me: String = F.first) -> RelayEvent {
        .devices(.object([
            "do": .string("devices"), "person": .bytes(person), "length": .number(Double(length)), "last": .bytes(bytes(last.id)),
            "self": .bytes(bytes(me)),
            "devices": .array(devices.map { d in
                .object([
                    "id": .bytes(bytes(d.id)), "kind": .string("app"), "active": .bool(d.active), "short": .string(d.short ?? groups(d.id)),
                    "addedBy": d.by.map { .bytes(bytes($0)) } ?? .null, "position": .number(Double(d.position)),
                    "onlyHolder": .array((0..<d.held).map { _ in .object(["channel": .bytes(Data(repeating: 1, count: 32)), "epoch": .bytes(Data(repeating: 2, count: 32))]) }),
                ])
            }),
        ]))
    }

    /// The first 8 bytes of an id in four groups of four hex digits, as the package writes them.
    private func groups(_ id: String) -> String {
        String(id.prefix(16)).enumerated().reduce("") { $0 + ($1.offset > 0 && $1.offset % 4 == 0 ? "-" : "") + String($1.element) }
    }

    private var rest: RelayEvent { .delivered(.object(["do": .string("rest")])) }
    private func refused(_ reason: Double) -> RelayEvent { .delivered(.object(["do": .string("refused"), "reason": .number(reason)])) }

    /// The log `[genesis, addA1]`.
    private func logTwo(_ devices: [Dev]? = nil) -> RelayEvent {
        effect(length: 2, last: F.addA1, devices: devices ?? [Dev(id: F.first, by: nil, position: 0), Dev(id: F.a, by: F.first, position: 1)])
    }

    /// The log `[genesis, addA1, addB2]`.
    private func logThree(a: Bool = true, b: Bool = true, extra: [Dev] = [], length: Int = 3, last: F.Entry = F.addB2) -> RelayEvent {
        effect(length: length, last: last, devices: [
            Dev(id: F.first, by: nil, position: 0), Dev(id: F.a, active: a, by: F.first, position: 1), Dev(id: F.b, active: b, by: F.first, position: 2),
        ] + extra)
    }

    private func until(_ message: String, _ condition: @escaping () async -> Bool) async {
        let deadline = ContinuousClock.now.advanced(by: .seconds(20))
        while ContinuousClock.now < deadline {
            if await condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail(message)
    }

    private func list(_ rig: Rig, _ message: String, _ matches: @escaping (DevicesState) -> Bool) async -> DevicesState {
        await until(message) { matches(await rig.controller.deviceList) }
        return await rig.controller.deviceList
    }

    private func stored(_ rig: Rig) throws -> PairingState { try XCTUnwrap(try rig.pairing.load()) }

    /// A paired controller that has read `[genesis, addA1]`.
    private func readTwo(_ rig: Rig) async -> FakeLink {
        let link = await started(rig)
        link.emit(logTwo())
        _ = await list(rig, "no list") { $0.rows.count == 2 }
        return link
    }

    private func candidate(_ rig: Rig, _ text: String = F.stringA) async throws -> DeviceCandidate {
        switch await rig.controller.inspect(pairingString: text) {
        case .success(let c): return c
        case .failure(let why): throw XCTSkip("refused: \(why)")
        }
    }

    // MARK: the list (3.9)

    func testTheListIsNewestFirstWithLabelsAdderPositionAndThisMac() async throws {
        let rig = try rig()
        let link = await started(rig)
        link.emit(logThree(a: false, extra: [Dev(id: F.s, by: F.a, position: 3, held: 2)]))
        let state = await list(rig, "no list") { $0.rows.count == 4 }
        XCTAssertEqual(state.rows.map(\.position), [3, 2, 1, 0], "newest first")
        let (s, b, a, first) = (state.rows[0], state.rows[1], state.rows[2], state.rows[3])
        XCTAssertEqual(a.label, "Studio Mac", "the store's label")
        XCTAssertNil(b.label)
        XCTAssertEqual(a.shortForm, groups(F.a))
        XCTAssertEqual([a.active, b.active, s.active, first.active], [false, true, true, true])
        XCTAssertEqual(first.adder, .none)
        XCTAssertEqual(b.adder, .device(bytes(F.first)))
        XCTAssertEqual(s.adder, .removedDevice, "its adder, A, is not active")
        XCTAssertEqual([first.isThisMac, a.isThisMac, b.isThisMac, s.isThisMac], [true, false, false, false])
        XCTAssertEqual(s.onlyHolderEpochs, 2)
        XCTAssertEqual(b.onlyHolderEpochs, 0)
    }

    func testTheTimeThisMacFirstReadAnAddIsKeptAndNeverMoves() async throws {
        let rig = try rig()
        let link = await started(rig)
        rig.clock.now = 5_000
        link.emit(logTwo())
        _ = await list(rig, "no list") { $0.rows.count == 2 }
        XCTAssertEqual(try stored(rig).seen[bytes(F.a)], 5_000, "written when first read")
        rig.clock.now = 9_000
        link.emit(logThree())
        let state = await list(rig, "no new row") { $0.rows.count == 3 }
        XCTAssertEqual(state.rows.map { $0.seenAt?.timeIntervalSince1970 }, [9_000, 5_000, 5_000])
        XCTAssertTrue(state.seenTogether, "two adds first read in one go")
        XCTAssertEqual(try stored(rig).seen[bytes(F.b)], 9_000)
    }

    func testTheThreeValuesForANewDeviceAreTheRelayTheKeyAndThePerson() async throws {
        let rig = try rig()
        let before = await rig.controller.handoffValues()
        XCTAssertNil(before, "nothing before launch")
        _ = await started(rig)
        let values = await rig.controller.handoffValues()
        XCTAssertEqual(values, PairingHandoff(relayAddress: "relay.example:8443", relayKey: hex(relayKey), person: F.person))
    }

    // MARK: checks before the confirmation (3.4)

    func testAPastedStringIsCheckedAndShownWithItsKindNameAndShortForm() async throws {
        let rig = try rig()
        let link = await readTwo(rig)
        let shown = await rig.controller.inspect(pairingString: "  \(F.stringA)\n")
        guard case .success(let c) = shown else { return XCTFail("refused: \(shown)") }
        XCTAssertEqual(c.name, "Studio Mac")
        XCTAssertEqual(c.kind, .app)
        XCTAssertEqual(c.shortForm, groups(F.a))
        XCTAssertTrue(link.submitted.isEmpty, "nothing is sent on a check")
        guard case .check? = link.builds.last else { return XCTFail("no check") }
    }

    func testEachRefusalNamesItsSentence() async throws {
        let rig = try rig()
        let link = await started(rig)
        let early = await rig.controller.inspect(pairingString: F.stringA)
        XCTAssertEqual(early, .failure(.notReady), "the log is not read yet")
        link.emit(logTwo())
        _ = await list(rig, "no list") { $0.rows.count == 2 }
        let notAString = await rig.controller.inspect(pairingString: "not hex at all")
        XCTAssertEqual(notAString, .failure(.notAPairingString))
        let badName = await rig.controller.inspect(pairingString: F.stringBadName)
        XCTAssertEqual(badName, .failure(.badName))
        link.checkOutcome = .refused("proof")
        let other = await rig.controller.inspect(pairingString: F.stringForOtherPerson)
        XCTAssertEqual(other, .failure(.otherPerson))
        XCTAssertEqual(DeviceRefusal.otherPerson.message, "This string was made for another person id. Check the values you gave the device.")
        link.checkOutcome = .refused("named")
        let named = await rig.controller.inspect(pairingString: F.stringA)
        XCTAssertEqual(named, .failure(.alreadyAdded))
        XCTAssertEqual(DeviceRefusal.alreadyAdded.message, "This device was already added once. Make a new string on it.")
        XCTAssertEqual(link.submitted.count, 0)
    }

    // MARK: adding, the entry kept until it is read back (3.6)

    func testAConfirmedAddIsWrittenPendingWithItsLabelBeforeItIsSent() async throws {
        let rig = try rig()
        let link = await readTwo(rig)
        let c = try await candidate(rig, F.stringA)
        link.buildOutcomes = [.built(entry(F.addX1))] // any real add stands for the one built
        var onDisk: PairingState?
        link.onSubmit = { onDisk = try? rig.pairing.load() }
        let refusal = await rig.controller.confirmAdd(c)
        XCTAssertNil(refusal)
        XCTAssertEqual(onDisk?.pending, entry(F.addX1), "written and flushed before submit")
        XCTAssertEqual(onDisk?.labels[bytes(F.x)], "Studio Mac", "the string's name, for the device the entry names")
        guard link.submitted.count == 1 else { return XCTFail("sent \(link.submitted.count) times") }
        XCTAssertEqual(link.submitted[0].kind, 1)
        XCTAssertEqual(link.submitted[0].signed, bytes(F.addX1.signed))
        guard case .add? = link.builds.last else { return XCTFail("no add built") }
        let state = await rig.controller.deviceList
        XCTAssertTrue(state.pendingEntry)
    }

    func testAcceptedStaysPendingUntilTheLogHoldsItThenItIsDropped() async throws {
        let rig = try rig()
        let link = await readTwo(rig)
        link.buildOutcomes = [.built(entry(F.addB2))]
        let refusal = await rig.controller.confirmAdd(try await candidate(rig))
        XCTAssertNil(refusal)
        link.emit(rest)
        link.emit(logTwo(), ) // a read that does not hold it yet
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(link.submitted.count, 1, "accepted on this connection: not sent again")
        XCTAssertNotNil(try stored(rig).pending, "still kept")
        link.emit(logThree())
        _ = await list(rig, "not dropped") { !$0.pendingEntry }
        XCTAssertNil(try stored(rig).pending)
        XCTAssertEqual(try stored(rig).labels[bytes(F.b)], "Studio Mac")
    }

    func testAnAddWaitsForThePendingEntry() async throws {
        let rig = try rig()
        let link = await readTwo(rig)
        link.buildOutcomes = [.built(entry(F.addB2))]
        let first = await rig.controller.confirmAdd(try await candidate(rig))
        XCTAssertNil(first)
        let second = await rig.controller.confirmAdd(try await candidate(rig))
        XCTAssertEqual(second, .entryPending)
        XCTAssertEqual(link.builds.filter { if case .add = $0 { return true } else { return false } }.count, 1)
    }

    func testPositionRebuildsAtTheNewPositionAndSendsTheNewBytes() async throws {
        let rig = try rig(state: nil)
        let link = await started(rig)
        link.emit(effect(length: 1, last: F.genesis, devices: [Dev(id: F.first, by: nil, position: 0)]))
        _ = await list(rig, "no list") { $0.rows.count == 1 }
        link.buildOutcomes = [.built(entry(F.addA1)), .built(entry(F.addA2))]
        link.submitOutcomes = [.code(2)]
        let refusal = await rig.controller.confirmAdd(try await candidate(rig))
        XCTAssertNil(refusal)
        XCTAssertEqual(link.submitted.count, 1)
        link.emit(rest)
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(link.submitted.count, 1, "the log it holds is not here yet: nothing is sent again")
        // Another device wrote first: the log moved to length 2 with X, and the entry's prev no longer matches.
        link.emit(effect(length: 2, last: F.addX1, devices: [Dev(id: F.first, by: nil, position: 0), Dev(id: F.x, by: F.first, position: 1)]))
        await until("not rebuilt") { link.submitted.count == 2 }
        guard link.submitted.count == 2 else { return XCTFail("sent \(link.submitted.count) times") }
        XCTAssertEqual(link.submitted[1].signed, bytes(F.addA2.signed), "new bytes at the new position")
        XCTAssertEqual(try stored(rig).pending, entry(F.addA2))
        let rebuilds = link.builds.compactMap { act -> HostValue? in if case .add(let device, _) = act { return device } else { return nil } }
        guard rebuilds.count == 2 else { return XCTFail("built \(rebuilds.count) times") }
        XCTAssertEqual(rebuilds[0], rebuilds[1], "the same device and proof, not a new proof")
    }

    func testARefusedAddIsDroppedWithAMessageNamingTheDevice() async throws {
        let rig = try rig()
        let link = await readTwo(rig)
        link.buildOutcomes = [.built(entry(F.addB2))]
        link.submitOutcomes = [.code(1)]
        _ = await rig.controller.confirmAdd(try await candidate(rig))
        let state = await rig.controller.deviceList
        XCTAssertEqual(state.notice, .addRefused("Studio Mac"))
        XCTAssertEqual(state.notice?.message.contains("Studio Mac"), true)
        XCTAssertNil(try stored(rig).pending)
        XCTAssertFalse(state.pendingEntry)
    }

    func testARemovedAnswerMeansThisDeviceWasRemoved() async throws {
        let rig = try rig()
        let link = await readTwo(rig)
        link.buildOutcomes = [.built(entry(F.addB2))]
        link.submitOutcomes = [.code(5)]
        _ = await rig.controller.confirmAdd(try await candidate(rig))
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .removed)
        XCTAssertTrue(link.stopped)
    }

    func testAtLaunchAPendingEntryTheLogHoldsIsDropped() async throws {
        var state = PairingState(stage: .paired, relay: relay, person: person)
        state.pending = entry(F.addA1)
        let rig = try rig(state: state)
        let link = await started(rig)
        link.emit(logThree(a: true, b: false)) // the log moved on: its last entry is not the pending one, A is named
        await until("not dropped") { (try? self.stored(rig).pending) == nil }
        XCTAssertTrue(link.submitted.isEmpty)
    }

    func testAtLaunchAPendingEntryTheLogDoesNotHoldIsSentAgainWithTheSameBytes() async throws {
        var state = PairingState(stage: .paired, relay: relay, person: person)
        state.pending = entry(F.addA1)
        let rig = try rig(state: state)
        let link = await started(rig)
        link.emit(effect(length: 1, last: F.genesis, devices: [Dev(id: F.first, by: nil, position: 0)]))
        await until("not sent") { link.submitted.count == 1 }
        guard link.submitted.count == 1 else { return XCTFail("sent \(link.submitted.count) times") }
        XCTAssertEqual(link.submitted[0].signed, bytes(F.addA1.signed))
        XCTAssertEqual(link.submitted[0].sig, bytes(F.addA1.sig))
        XCTAssertTrue(link.builds.isEmpty, "the same bytes: nothing was built")
    }

    func testAtLaunchAPendingEntryWhosePositionIsTakenIsRebuilt() async throws {
        var state = PairingState(stage: .paired, relay: relay, person: person)
        state.pending = entry(F.addA1)
        let rig = try rig(state: state)
        let link = await started(rig)
        link.buildOutcomes = [.built(entry(F.addA2))]
        link.emit(effect(length: 2, last: F.addX1, devices: [Dev(id: F.first, by: nil, position: 0), Dev(id: F.x, by: F.first, position: 1)]))
        await until("not rebuilt") { link.submitted.count == 1 }
        guard link.submitted.count == 1 else { return XCTFail("sent \(link.submitted.count) times") }
        XCTAssertEqual(link.submitted[0].signed, bytes(F.addA2.signed))
        XCTAssertEqual(try stored(rig).pending, entry(F.addA2))
    }

    func testTwoAddsAtOnceTakeTurns() async throws {
        let rig = try rig()
        let link = await readTwo(rig)
        let c = try await candidate(rig)
        let gate = Latch()
        link.buildGate = gate
        link.buildOutcomes = [.built(entry(F.addB2)), .built(entry(F.addX1))]
        async let first = rig.controller.confirmAdd(c)
        try await Task.sleep(for: .milliseconds(100))
        async let second = rig.controller.confirmAdd(c)
        try await Task.sleep(for: .milliseconds(100))
        await gate.open()
        let (one, two) = await (first, second)
        XCTAssertNil(one)
        XCTAssertEqual(two, .entryPending, "the second saw the first's entry")
        XCTAssertEqual(link.submitted.count, 1)
    }

    // MARK: removing (3.9, 3.10)

    private func removalRig(_ removal: PairingRemoval? = nil, pending: SignedEntry? = nil) throws -> Rig {
        var state = PairingState(stage: .paired, relay: relay, person: person)
        (state.removal, state.pending) = (removal, pending)
        return try rig(state: state)
    }

    func testTheConfirmationListsEveryActiveDeviceButThisMacNewestFirstWithTheClickedOneChosen() async throws {
        let rig = try rig()
        let link = await started(rig)
        link.emit(logThree(a: false, extra: [Dev(id: F.s, by: F.first, position: 3, held: 1)]))
        _ = await list(rig, "no list") { $0.rows.count == 4 }
        let choices = await rig.controller.removalChoices(clicked: bytes(F.b))
        XCTAssertEqual(choices.map(\.id), [bytes(F.s), bytes(F.b)], "A is gone and this Mac is left out")
        XCTAssertEqual(choices.map(\.chosen), [false, true])
        XCTAssertEqual(choices.map(\.row.onlyHolderEpochs), [1, 0], "the only holder of an epoch is said before the confirmation")
    }

    func testARemovalIsStoredThenRunsTheClickedDeviceFirstOneEntryAtATime() async throws {
        let rig = try rig()
        let link = await started(rig)
        link.emit(logThree())
        _ = await list(rig, "no list") { $0.rows.count == 3 }
        link.buildOutcomes = [.built(entry(F.remA3)), .built(entry(F.remB4))]
        var onDisk: PairingState?
        link.onSubmit = { onDisk = try? rig.pairing.load() }
        let refusal = await rig.controller.confirmRemoval(chosen: [bytes(F.a), bytes(F.b)], clicked: bytes(F.a))
        XCTAssertNil(refusal)
        XCTAssertEqual(onDisk?.removal, PairingRemoval(devices: [bytes(F.a), bytes(F.b)], length: 3), "the clicked first, the log's length at that moment")
        XCTAssertEqual(link.builds, [.remove(target: bytes(F.a))])
        XCTAssertEqual(onDisk?.pending, entry(F.remA3), "kept before it is sent")
        XCTAssertEqual(link.submitted.count, 1)
        // Accepted, not yet read back: nothing more is built and the act is not over.
        link.emit(rest)
        link.emit(logThree())
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(link.builds.count, 1, "one pending entry at a time")
        XCTAssertNotNil(try stored(rig).removal)
        // A read-back log shows A gone: the next device goes.
        link.emit(effect(length: 4, last: F.remA3, devices: [
            Dev(id: F.first, by: nil, position: 0), Dev(id: F.a, active: false, by: F.first, position: 1), Dev(id: F.b, by: F.first, position: 2)]))
        await until("B not removed") { link.submitted.count == 2 }
        XCTAssertEqual(link.builds.last, .remove(target: bytes(F.b)))
        XCTAssertNotNil(try stored(rig).removal, "B is still active")
        // The act ends only on a read-back log that shows none of its devices active.
        link.emit(effect(length: 5, last: F.remB4, devices: [
            Dev(id: F.first, by: nil, position: 0), Dev(id: F.a, active: false, by: F.first, position: 1), Dev(id: F.b, active: false, by: F.first, position: 2)]))
        await until("act not ended") { (try? self.stored(rig).removal) == nil }
        XCTAssertNil(try stored(rig).pending)
        let state = await rig.controller.deviceList
        XCTAssertEqual(state.removing, [])
    }

    func testTheOthersGoNewestFirstBehindTheClickedOne() async throws {
        let rig = try rig()
        let link = await started(rig)
        link.emit(logThree(extra: [Dev(id: F.s, by: F.first, position: 3)], length: 4, last: F.addS3))
        _ = await list(rig, "no list") { $0.rows.count == 4 }
        _ = await rig.controller.confirmRemoval(chosen: [bytes(F.a), bytes(F.b), bytes(F.s)], clicked: bytes(F.a))
        XCTAssertEqual(try stored(rig).removal?.devices, [bytes(F.a), bytes(F.s), bytes(F.b)])
    }

    func testThisMacIsNeverRemovedAndAnEmptyOrStaleChoiceIsRefused() async throws {
        let rig = try rig()
        let link = await started(rig)
        link.emit(logThree(a: false))
        _ = await list(rig, "no list") { $0.rows.count == 3 }
        let me = await rig.controller.confirmRemoval(chosen: [bytes(F.first), bytes(F.b)], clicked: bytes(F.b))
        XCTAssertEqual(me, .thisMac)
        let none = await rig.controller.confirmRemoval(chosen: [], clicked: bytes(F.b))
        XCTAssertEqual(none, .nothingChosen)
        let gone = await rig.controller.confirmRemoval(chosen: [bytes(F.a)], clicked: bytes(F.a))
        XCTAssertEqual(gone, .notActive)
        XCTAssertNil(try stored(rig).removal)
        XCTAssertTrue(link.builds.isEmpty)
    }

    func testADeviceAddedWhileRemovingJoinsTheActAndOneThisMacAddedDoesNot() async throws {
        let rig = try rig()
        let link = await started(rig)
        link.emit(logThree())
        _ = await list(rig, "no list") { $0.rows.count == 3 }
        link.buildOutcomes = [.built(entry(F.remA3))]
        _ = await rig.controller.confirmRemoval(chosen: [bytes(F.a)], clicked: bytes(F.a))
        // S is added by another device after the act began; X by this Mac.
        link.emit(effect(length: 5, last: F.addS3, devices: [
            Dev(id: F.first, by: nil, position: 0), Dev(id: F.a, by: F.first, position: 1), Dev(id: F.b, by: F.first, position: 2),
            Dev(id: F.s, by: F.b, position: 3), Dev(id: F.x, by: F.first, position: 4)]))
        let state = await list(rig, "no joiner") { $0.rows.contains { $0.addedWhileRemoving } }
        XCTAssertEqual(state.rows.filter(\.addedWhileRemoving).map(\.id), [bytes(F.s)])
        XCTAssertEqual(try stored(rig).removal?.devices, [bytes(F.a), bytes(F.s)])
    }

    func testAStoredRemovalResumesAfterARestartAndADeviceRemovedElsewhereIsDone() async throws {
        let rig = try removalRig(PairingRemoval(devices: [bytes(F.a), bytes(F.b)], length: 3))
        let link = await started(rig)
        link.buildOutcomes = [.built(entry(F.remB4))]
        link.emit(logThree(a: false, length: 4, last: F.remA3)) // A was removed by another device
        await until("not resumed") { link.submitted.count == 1 }
        XCTAssertEqual(link.builds, [.remove(target: bytes(F.b))])
    }

    func testAStoredRemovalWithNoDeviceLeftEndsOnTheFirstReadBack() async throws {
        let rig = try removalRig(PairingRemoval(devices: [bytes(F.a)], length: 3))
        let link = await started(rig)
        link.emit(logThree(a: false, length: 4, last: F.remA3))
        await until("not ended") { (try? self.stored(rig).removal) == nil }
        XCTAssertTrue(link.builds.isEmpty)
    }

    func testConfirmingARemovalDropsAPendingAddNotYetReadBack() async throws {
        let rig = try removalRig(nil, pending: entry(F.addB2))
        let link = await started(rig)
        link.emit(logTwo())
        _ = await list(rig, "no list") { $0.rows.count == 2 }
        // The pending add was sent at the first rest; the removal drops it, and with the remove not buildable yet nothing is pending.
        let refusal = await rig.controller.confirmRemoval(chosen: [bytes(F.a)], clicked: bytes(F.a))
        XCTAssertNil(refusal)
        XCTAssertNil(try stored(rig).pending, "the add not yet read back does not hold the removal back")
        XCTAssertEqual(try stored(rig).removal?.devices, [bytes(F.a)])
        let sentBefore = link.submitted.count
        link.emit(rest)
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(link.submitted.count, sentBefore, "the dropped add is not sent again")
        XCTAssertEqual(link.submitted.count, 1, "only the add's first sending")
    }

    func testARemovalWaitsWhenTheLogIsNotAtRest() async throws {
        let rig = try rig()
        let link = await started(rig)
        link.emit(logThree())
        _ = await list(rig, "no list") { $0.rows.count == 3 }
        let refusal = await rig.controller.confirmRemoval(chosen: [bytes(F.a)], clicked: bytes(F.a)) // the stand-in answers busy
        XCTAssertNil(refusal)
        XCTAssertNotNil(try stored(rig).removal, "stored, and tried again at the next rest")
        XCTAssertNil(try stored(rig).pending)
        link.buildOutcomes = [.built(entry(F.remA3))]
        link.emit(rest)
        await until("not tried again") { link.submitted.count == 1 }
    }

    func testARemovalWhileAnotherRunsIsRefused() async throws {
        let rig = try removalRig(PairingRemoval(devices: [bytes(F.a)], length: 3))
        let link = await started(rig)
        link.emit(logThree())
        _ = await list(rig, "no list") { $0.rows.count == 3 }
        let refusal = await rig.controller.confirmRemoval(chosen: [bytes(F.b)], clicked: bytes(F.b))
        XCTAssertEqual(refusal, .running)
    }

    // MARK: joining as a new device (3.7)

    private func joinRig() throws -> Rig {
        let store = SoftwareKeyStore()
        let pairingFolder = folder("pairing")
        let pairing = try PairingStore(folder: pairingFolder)
        let linkFolder = folder("link")
        let (links, clock) = (Links(), Clock())
        return Rig(controller: try controller(store, pairing, linkFolder, links, clock), keys: store, pairing: pairing, links: links, clock: clock, folders: (pairingFolder, linkFolder))
    }

    private func form(_ rig: Rig, person: String? = nil, name: String = "Mac mini") async throws {
        try await rig.controller.join(address: "relay.example:8443", relayKey: hex(relayKey), person: person ?? F.person, name: name)
    }

    func testJoinWritesKeysMadeBeforeTheKeysThenTheProofOnceAndShowsTheString() async throws {
        let rig = try joinRig()
        await rig.controller.launch()
        var atKeys: PairingState?
        rig.keys.onMake = { name in if name == "device.sign" { atKeys = try? rig.pairing.load() } }
        try await form(rig)
        XCTAssertEqual(atKeys?.stage, .keysMade(.join), "the store before the keys")
        XCTAssertEqual(atKeys?.person, person)
        let state = try stored(rig)
        XCTAssertEqual(state.stage, .joining)
        XCTAssertEqual(state.proof?.count, 64)
        XCTAssertEqual(state.name, "Mac mini")
        guard case .joining(let info) = await rig.controller.phase else { return XCTFail("not joining") }
        XCTAssertFalse(info.waiting)
        guard case .read(_, let proof, let name, let short) = try await host(rig).inspectPairingString(info.pairingString) else { return XCTFail("the string does not read") }
        XCTAssertEqual(name, "Mac mini")
        XCTAssertEqual(short, info.shortForm)
        XCTAssertEqual(proof, state.proof, "the proof in the string is the one kept")
        XCTAssertEqual(rig.links.all.count, 1)
        XCTAssertNil(rig.links.enrolments[0], "the connection proves with the keys alone")
    }

    func testTheFormIsCheckedBeforeAnythingIsWrittenForAJoin() async throws {
        let rig = try joinRig()
        await rig.controller.launch()
        do { try await form(rig, person: "abcd"); XCTFail("accepted") } catch { XCTAssertEqual(error as? PairingInputError, .person) }
        do { try await form(rig, name: " Mac"); XCTFail("accepted") } catch { XCTAssertEqual(error as? PairingInputError, .name) }
        do { try await form(rig, name: ""); XCTFail("accepted") } catch { XCTAssertEqual(error as? PairingInputError, .name) }
        XCTAssertNil(try rig.pairing.load())
        XCTAssertFalse(rig.keys.has("device.sign"))
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .unpaired(nil))
    }

    func testRefusalTwoOnAJoinSaysWaitingForTheOtherDevice() async throws {
        let rig = try joinRig()
        await rig.controller.launch()
        try await form(rig)
        rig.links.link.emit(refused(2))
        await until("not waiting") { if case .joining(let info) = await rig.controller.phase { return info.waiting } else { return false } }
        XCTAssertFalse(rig.links.link.stopped, "the link goes on dialing")
        XCTAssertEqual(PairingPhase.joinWaiting, "Waiting for your other device to add this one")
    }

    func testServedWithThisDevicesAddMakesItPairedAndDropsTheProof() async throws {
        let rig = try joinRig()
        await rig.controller.launch()
        try await form(rig)
        rig.links.link.emit(effect(length: 2, last: F.addA1, devices: [Dev(id: F.first, by: nil, position: 0), Dev(id: F.a, by: F.first, position: 1)], me: F.a))
        await until("not paired") { await rig.controller.phase == .paired }
        let state = try stored(rig)
        XCTAssertEqual(state.stage, .paired)
        XCTAssertNil(state.proof)
        XCTAssertNil(state.name)
        let list = await list(rig, "no list") { $0.rows.count == 2 }
        XCTAssertTrue(list.rows.first { $0.id == bytes(F.a) }!.isThisMac)
    }

    func testServedWithoutThisDevicesAddStopsAndOffersPairAgain() async throws {
        let rig = try joinRig()
        await rig.controller.launch()
        try await form(rig)
        let link = rig.links.link
        link.emit(effect(length: 2, last: F.addX1, devices: [Dev(id: F.first, by: nil, position: 0), Dev(id: F.x, by: F.first, position: 1)], me: F.a))
        await until("not faulted") { if case .fault(.joinMismatch, _) = await rig.controller.phase { return true } else { return false } }
        XCTAssertTrue(link.stopped)
        XCTAssertEqual(try stored(rig).stage, .joining, "nothing is erased without the click")
        let done = await rig.controller.pairAgain()
        XCTAssertTrue(done)
        XCTAssertNil(try rig.pairing.load())
    }

    func testARestartWhileJoiningShowsTheSameStringAndConnectsWithTheProofAlone() async throws {
        let rig = try joinRig()
        await rig.controller.launch()
        try await form(rig)
        guard case .joining(let before) = await rig.controller.phase else { return XCTFail("not joining") }
        await rig.controller.shutdown()
        let (links, clock) = (Links(), Clock())
        let again = try controller(rig.keys, rig.pairing, rig.folders.link, links, clock)
        await again.launch()
        guard case .joining(let after) = await again.phase else { return XCTFail("not joining after the restart") }
        XCTAssertEqual(after.pairingString, before.pairingString, "the proof was signed once")
        XCTAssertNil(links.enrolments[0])
    }

    func testACancelWhileJoiningErasesTheKeysThenTheStore() async throws {
        let rig = try joinRig()
        await rig.controller.launch()
        try await form(rig)
        var storeAtDelete: PairingState?
        rig.keys.onDelete = { name in if name == "device.sign" { storeAtDelete = try? rig.pairing.load() } }
        let outcome = await rig.controller.cancel()
        XCTAssertEqual(outcome, .erased)
        XCTAssertEqual(storeAtDelete?.stage, .joining, "the store is still there when the first key goes")
        XCTAssertNil(try rig.pairing.load())
        XCTAssertFalse(rig.keys.has("device.sign"))
        XCTAssertFalse(rig.keys.has("device.receive"))
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .unpaired(nil))
    }

    // MARK: fix round 1 of the review

    func testAnAddThatWasAwaitingTheLinkWritesNothingAfterPairAgain() async throws {
        let rig = try rig()
        let link = await readTwo(rig)
        let c = try await candidate(rig)
        let gate = Latch()
        link.buildGate = gate
        link.buildOutcomes = [.built(entry(F.addB2))]
        async let added = rig.controller.confirmAdd(c)
        try await Task.sleep(for: .milliseconds(200))
        link.emit(refused(1))
        await until("not removed") { await rig.controller.phase == .removed }
        async let again = rig.controller.pairAgain()
        try await Task.sleep(for: .milliseconds(200))
        await gate.open()
        _ = await (added, again)
        XCTAssertNil(try rig.pairing.load(), "a stale copy of the store did not come back")
        XCTAssertFalse(rig.keys.has("device.sign"))
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .unpaired(nil))
    }

    func testAnAddIsRefusedWhileARemovalRuns() async throws {
        let rig = try removalRig(PairingRemoval(devices: [bytes(F.a)], length: 3))
        let link = await started(rig)
        link.emit(logThree())
        _ = await list(rig, "no list") { $0.rows.count == 3 }
        let refusal = await rig.controller.confirmAdd(try await candidate(rig))
        XCTAssertEqual(refusal, .removalRunning)
        XCTAssertEqual(DeviceRefusal.removalRunning.message, "Finish removing first. A device is being removed, and an add waits for it.")
        XCTAssertNil(try stored(rig).pending)
    }

    func testARemoveTheLogRefusedIsNamedAsARemoveAndLeavesTheAct() async throws {
        let rig = try rig()
        let link = await started(rig)
        link.emit(logThree())
        _ = await list(rig, "no list") { $0.rows.count == 3 }
        link.buildOutcomes = [.built(entry(F.remA3))]
        link.submitOutcomes = [.code(1)]
        let refusal = await rig.controller.confirmRemoval(chosen: [bytes(F.a), bytes(F.b)], clicked: bytes(F.a))
        XCTAssertNil(refusal)
        let notice = await rig.controller.deviceList.notice
        XCTAssertEqual(notice, .removeRefused("Studio Mac"))
        XCTAssertEqual(notice?.message, "Removing \"Studio Mac\" failed: the log refused the entry.")
        XCTAssertNil(try stored(rig).pending)
        XCTAssertEqual(try stored(rig).removal?.devices, [bytes(F.b)], "the refused device is not built again at every rest")
        XCTAssertEqual(link.builds, [.remove(target: bytes(F.a))])
    }

    func testADeviceTheLogRefusedStaysOutOfTheActAndTheActEndsWithoutIt() async throws {
        let rig = try rig()
        let link = await started(rig)
        link.emit(logThree())
        _ = await list(rig, "no list") { $0.rows.count == 3 }
        link.buildOutcomes = [.built(entry(F.remA3))]
        _ = await rig.controller.confirmRemoval(chosen: [bytes(F.a)], clicked: bytes(F.a))
        // S is added by another device during the act and joins it.
        let withS = [Dev(id: F.first, by: nil, position: 0), Dev(id: F.a, by: F.first, position: 1), Dev(id: F.b, by: F.first, position: 2), Dev(id: F.s, by: F.b, position: 3)]
        link.emit(effect(length: 4, last: F.addS3, devices: withS))
        await until("S did not join") { (try? self.stored(rig).removal?.devices) == [self.bytes(F.a), self.bytes(F.s)] }
        // A is removed; the log refuses the remove of S.
        link.buildOutcomes = [.built(entry(F.remB4))]
        link.submitOutcomes = [.code(1)]
        link.emit(effect(length: 5, last: F.remA3, devices: [withS[0], Dev(id: F.a, active: false, by: F.first, position: 1)] + withS[2...]))
        await until("S not out of the act") { (try? self.stored(rig).removal?.left) == [self.bytes(F.s)] }
        XCTAssertEqual(try stored(rig).removal?.devices, [bytes(F.a)])
        link.emit(rest)
        await until("the act did not end") { (try? self.stored(rig).removal) == nil }
        XCTAssertEqual(link.builds, [.remove(target: bytes(F.a)), .remove(target: bytes(F.s))], "S is not removed a second time")
        XCTAssertEqual(link.submitted.count, 2)
        let shown = await list(rig, "no list") { $0.rows.count == 4 }
        XCTAssertTrue(shown.rows.first { $0.id == bytes(F.s) }!.active, "S stays active and shown")
        XCTAssertTrue(shown.removing.isEmpty)
    }

    func testAHostErrorKeepsThePendingEntry() async throws {
        var state = PairingState(stage: .paired, relay: relay, person: person)
        state.pending = entry(F.addA1)
        let rig = try rig(state: state)
        let link = await started(rig)
        let made = await rig.controller.host
        let host = try XCTUnwrap(made)
        _ = try? await host.callExported("noSuchExport") // a JavaScript exception ends the host: every later call throws
        link.emit(effect(length: 1, last: F.genesis, devices: [Dev(id: F.first, by: nil, position: 0)]))
        _ = await list(rig, "no list") { $0.rows.count == 1 }
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(try stored(rig).pending, entry(F.addA1), "only an entry the package refuses is dropped")
        XCTAssertTrue(link.submitted.isEmpty)
    }

    func testTheShortFormIsTheOneThePackageGave() async throws {
        let rig = try rig()
        let link = await started(rig)
        link.emit(logTwo([Dev(id: F.first, by: nil, position: 0, short: "1111-2222-3333-4444"), Dev(id: F.a, by: F.first, position: 1)]))
        let state = await list(rig, "no list") { $0.rows.count == 2 }
        XCTAssertEqual(state.rows.map(\.shortForm), [groups(F.a), "1111-2222-3333-4444"])
    }

    func testAMalformedDevicesEffectIsAHostFault() async throws {
        let rig = try rig()
        let link = await started(rig)
        link.emit(.devices(.object(["do": .string("devices")])))
        await until("not faulted") { if case .fault(.failed, _) = await rig.controller.phase { return true } else { return false } }
        XCTAssertTrue(link.stopped)
    }

    func testShutdownFinishesTheDeviceStatesToo() async throws {
        let rig = try rig()
        _ = await started(rig)
        let ended = Latch()
        let reader = Task { for await _ in rig.controller.deviceStates {}; await ended.open() }
        await rig.controller.shutdown()
        await ended.wait()
        reader.cancel()
    }

    func testARemovalThatCannotBeWrittenAnswersAFailureAndStoresNothing() async throws {
        let rig = try rig()
        let link = await readTwo(rig)
        _ = link
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: rig.folders.pairing.path)
        addTeardownBlock { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: rig.folders.pairing.path) }
        let refusal = await rig.controller.confirmRemoval(chosen: [bytes(F.a)], clicked: bytes(F.a))
        XCTAssertEqual(refusal, .failed("the pairing could not be written"))
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: rig.folders.pairing.path)
        XCTAssertNil(try stored(rig).removal)
    }

    // MARK: the join's races (3.7, 3.10)

    /// A join that was form-filled and stopped, whose store a new controller reads at launch.
    private func joinedThenStopped() async throws -> Rig {
        let rig = try joinRig()
        await rig.controller.launch()
        try await form(rig)
        await rig.controller.shutdown()
        return rig
    }

    func testADevicesEffectLandingDuringTheLaunchEndsPaired() async throws {
        let rig = try await joinedThenStopped()
        let again = try controller(rig.keys, rig.pairing, rig.folders.link, Links(), Clock(), prime: [
            effect(length: 2, last: F.addA1, devices: [Dev(id: F.first, by: nil, position: 0), Dev(id: F.a, by: F.first, position: 1)], me: F.a)
        ])
        await again.launch()
        await until("not paired") { await again.phase == .paired }
        XCTAssertEqual(try stored(rig).stage, .paired)
    }

    func testARefusalTwoDuringTheLaunchStillShowsWaiting() async throws {
        let rig = try await joinedThenStopped()
        let again = try controller(rig.keys, rig.pairing, rig.folders.link, Links(), Clock(), prime: [refused(2)])
        await again.launch()
        await until("not waiting") { if case .joining(let info) = await again.phase { return info.waiting } else { return false } }
    }

    func testACancelDuringTheJoinsAwaitsErasesTheAttempt() async throws {
        let rig = try joinRig()
        await rig.controller.launch()
        let once = Once()
        let (entered, release) = (DispatchSemaphore(value: 0), DispatchSemaphore(value: 0))
        rig.keys.onPublicKey = { _ in // the gate holds the string's making until the cancel is in
            guard (try? rig.pairing.load())?.stage == .joining, once.first() else { return }
            entered.signal()
            Self.hold(release)
        }
        let controller = rig.controller
        let canceller = Task.detached { // asks the cancel once the join is inside the gate; the cancel queues behind the join on the actor
            Self.hold(entered)
            let asked = Task { await controller.cancel() }
            try? await Task.sleep(nanoseconds: 100_000_000) // lets the cancel reach the actor's queue before the string is made
            release.signal()
            return await asked.value
        }
        try await form(rig)
        let outcome = await canceller.value
        XCTAssertEqual(outcome, .abandoning, "the join was still making its string")
        XCTAssertNil(try rig.pairing.load(), "the cancel was honoured")
        XCTAssertFalse(rig.keys.has("device.sign"))
        XCTAssertFalse(rig.keys.has("device.receive"))
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .unpaired(nil))
    }

    func testAJoiningStringThatCannotBeMadeIsAFaultWithARetry() async throws {
        let rig = try joinRig()
        await rig.controller.launch()
        let once = Once()
        rig.keys.onPublicKey = { _ in
            guard (try? rig.pairing.load())?.stage == .joining, once.first() else { return }
            throw HostError.faulted("no string")
        }
        do { try await form(rig); XCTFail("accepted") } catch {}
        let phase = await rig.controller.phase
        XCTAssertEqual(phase, .fault(.joinUnmade, "This Mac cannot make its pairing string. Pair again to start over."))
        XCTAssertEqual(try stored(rig).stage, .joining, "joining is on disk: the retry resumes")
        let retried = await rig.controller.retry()
        XCTAssertTrue(retried)
        guard case .joining = await rig.controller.phase else { return XCTFail("not joining after the retry") }
    }

    func testAStoredJoiningWhoseStringCannotBeMadeIsJoinUnmadeAtLaunchAndAfterARetry() async throws {
        let rig = try await joinedThenStopped()
        let again = try controller(rig.keys, rig.pairing, rig.folders.link, Links(), Clock())
        rig.keys.onPublicKey = { _ in throw HostError.faulted("no string") }
        await again.launch()
        let advice = PairingPhase.joinUnmadeAdvice
        let launched = await again.phase
        XCTAssertEqual(launched, .fault(.joinUnmade, advice))
        let retried = await again.retry()
        XCTAssertTrue(retried)
        let afterRetry = await again.phase
        XCTAssertEqual(afterRetry, .fault(.joinUnmade, advice))
        XCTAssertEqual(try stored(rig).stage, .joining)
        let done = await again.pairAgain()
        XCTAssertTrue(done)
        XCTAssertNil(try rig.pairing.load())
    }

    func testAJoiningStringThatCannotBeMadeAlsoAllowsPairAgainWhichErasesTheAttempt() async throws {
        let rig = try joinRig()
        await rig.controller.launch()
        let once = Once()
        rig.keys.onPublicKey = { _ in
            guard (try? rig.pairing.load())?.stage == .joining, once.first() else { return }
            throw HostError.faulted("no string")
        }
        do { try await form(rig); XCTFail("accepted") } catch {}
        let cancelled = await rig.controller.cancel()
        XCTAssertEqual(cancelled, .notCancellable)
        let done = await rig.controller.pairAgain()
        XCTAssertTrue(done)
        XCTAssertNil(try rig.pairing.load())
        XCTAssertFalse(rig.keys.has("device.sign"))
    }

    func testRefusalOneWhileJoiningMeansThisDeviceWasRemoved() async throws {
        let rig = try joinRig()
        await rig.controller.launch()
        try await form(rig)
        rig.links.link.emit(refused(1))
        await until("not removed") { await rig.controller.phase == .removed }
        XCTAssertTrue(rig.links.link.stopped)
    }

    private func host(_ rig: Rig) async throws -> ProtocolHost {
        try await ProtocolHost(scriptPath: try XCTUnwrap(ProcessInfo.processInfo.environment["PARDNER_APP_SCRIPT"]), store: rig.keys)
    }
}
