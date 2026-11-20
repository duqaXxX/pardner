// The pairing store (device pairing design 4.1): every stage round-trips, a file that does not read is a fault, a stop
// between the temporary file and the rename leaves the old file, and the folder is checked as the link store's is.
import Foundation
import os
import ProtocolHost
@testable import Relay
import XCTest

final class PairingStoreTests: XCTestCase {
    private let relay = PairingRelay(host: "relay.example", port: 8443, key: Data(repeating: 3, count: 65))
    private let person = Data(repeating: 7, count: 32)

    private func folder() -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("pardner-pairing-\(UUID().uuidString)")
        addTeardownBlock {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path)
            try? FileManager.default.removeItem(at: folder)
        }
        return folder
    }

    private func entry(_ n: UInt8) -> SignedEntry { SignedEntry(signed: Data(repeating: n, count: 120), sig: Data(repeating: n, count: 64), id: Data(repeating: n, count: 32)) }

    /// Every stage with the fields it holds, and the extras of the paired one.
    private func states() -> [PairingState] {
        let genesis = entry(1)
        var enrolling = PairingState(stage: .enrolling, relay: relay, person: genesis.id) // the person is entry 0's id (design 3.5)
        enrolling.genesis = genesis
        var joining = PairingState(stage: .joining, relay: relay, person: person)
        (joining.proof, joining.name) = (Data(repeating: 5, count: 64), "Carol's Mac mini")
        var paired = PairingState(stage: .paired, relay: relay, person: person)
        paired.pending = entry(2)
        paired.labels = [Data(repeating: 8, count: 32): "Studio", Data(repeating: 9, count: 32): "Laptop"]
        paired.seen = [Data(repeating: 8, count: 32): 1_790_000_000.5]
        paired.removal = PairingRemoval(devices: [Data(repeating: 8, count: 32), Data(repeating: 9, count: 32)], length: 6, left: [Data(repeating: 7, count: 32)])
        return [
            PairingState(stage: .keysMade(.enrol), relay: relay),
            PairingState(stage: .keysMade(.join), relay: relay, person: person),
            enrolling, joining, paired,
            PairingState(stage: .paired, relay: relay, person: person),
        ]
    }

    func testNoFileIsNoPairing() throws {
        XCTAssertNil(try PairingStore(folder: folder()).load())
    }

    func testEveryStageRoundTrips() throws {
        let place = folder()
        for state in states() {
            var store: PairingStore? = try PairingStore(folder: place)
            try store!.write(state)
            store = nil // releases the lock, as the end of the process does
            XCTAssertEqual(try PairingStore(folder: place).load(), state, "\(state.stage)")
        }
    }

    func testAWriteReplacesTheWholeFileAndEraseRemovesIt() throws {
        let store = try PairingStore(folder: folder())
        try store.write(states()[4])
        try store.write(states()[0])
        XCTAssertEqual(try store.load(), states()[0])
        try store.erase()
        XCTAssertNil(try store.load())
        try store.erase() // nothing to remove is not a failure
    }

    func testAStopBetweenTheTemporaryFileAndTheRenameLeavesTheOldFile() throws {
        let place = folder()
        let store = try PairingStore(folder: place)
        try store.write(states()[2])
        // What a crash leaves: a temporary file, half written, beside the file.
        try Data("{\"version\":1,\"sta".utf8).write(to: place.appendingPathComponent("pairing.json.tmp"))
        XCTAssertEqual(try store.load(), states()[2], "the old file is the pairing")
        try store.write(states()[4])
        XCTAssertEqual(try store.load(), states()[4], "the next write goes over the leftover")
        XCTAssertFalse(FileManager.default.fileExists(atPath: place.appendingPathComponent("pairing.json.tmp").path))
    }

    private func fault(_ text: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let place = folder()
        let store = try PairingStore(folder: place)
        try Data(text.utf8).write(to: place.appendingPathComponent("pairing.json"))
        XCTAssertThrowsError(try store.load(), file: file, line: line) { XCTAssertTrue($0 is PairingFault, "\($0)", file: file, line: line) }
    }

    func testAFileThatDoesNotReadIsAFault() throws {
        let good = String(decoding: try PairingStore.encode(states()[4]), as: UTF8.self)
        try fault("")
        try fault("[]")
        try fault("{\"version\":1")
        try fault(good.replacingOccurrences(of: "\"version\":1", with: "\"version\":2"))
        try fault(good.replacingOccurrences(of: "\"stage\":\"paired\"", with: "\"stage\":\"done\""))
        try fault("{\"extra\":1," + good.dropFirst())
        try fault(good.replacingOccurrences(of: "\"port\":8443", with: "\"port\":70000"))
        try fault(good.replacingOccurrences(of: "\"host\":\"relay.example\"", with: "\"host\":\"\""))
        try fault(good.replacingOccurrences(of: String(repeating: "03", count: 65), with: "03"))
        try fault(good.replacingOccurrences(of: String(repeating: "07", count: 32), with: String(repeating: "0G", count: 32)))
    }

    func testAStageThatLacksOrHoldsTheWrongFieldsIsAFault() throws {
        for state in states() {
            var bare = state
            switch state.stage {
            case .keysMade(.enrol): bare.person = person
            case .keysMade(.join): bare.person = nil
            case .enrolling: bare.genesis = nil
            case .joining: bare.name = nil
            case .paired: bare.person = nil
            }
            try faultFrom(bare)
        }
        var early = states()[0]
        early.pending = entry(1)
        try faultFrom(early)
        var stray = states()[5]
        stray.genesis = entry(1)
        try faultFrom(stray)
    }

    private func faultFrom(_ state: PairingState, line: UInt = #line) throws {
        try fault(String(decoding: try PairingStore.encode(state), as: UTF8.self), line: line)
    }

    func testTheFolderIsExcludedFromBackup() throws {
        let place = folder()
        _ = try PairingStore(folder: place)
        XCTAssertEqual(try place.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        let link = folder()
        _ = try LinkStore(folder: link, identity: LinkIdentity(signing: Data([1]), receiving: Data([2]), relay: Data([3])))
        XCTAssertEqual(try link.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true, "the link's folder too")
    }

    func testTheFolderIsCreatedPrivateAndHeldByOneProcess() throws {
        let place = folder()
        let store = try PairingStore(folder: place)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: place.path)[.posixPermissions] as? Int, 0o700)
        XCTAssertThrowsError(try PairingStore(folder: place)) { XCTAssertTrue($0 is StoreBusy) }
        _ = store
    }

    func testAFolderThatIsALinkHasOtherPermissionsOrIsAFileIsRefused() throws {
        let place = folder()
        let target = folder()
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(at: place.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: place, withDestinationURL: target)
        XCTAssertThrowsError(try PairingStore(folder: place)) { XCTAssertTrue($0 is StoreError, "a symbolic link") }

        let open = folder()
        try FileManager.default.createDirectory(at: open, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        XCTAssertThrowsError(try PairingStore(folder: open)) { XCTAssertTrue($0 is StoreError, "permissions other than 0700") }

        let file = folder()
        try Data().write(to: file)
        XCTAssertThrowsError(try PairingStore(folder: file)) { XCTAssertTrue($0 is StoreError, "a file") }
    }

    // MARK: what write refuses, what decode refuses, and the lock

    func testAWriteOfAStateTheFileWouldNotReadThrowsAndKeepsTheOldFile() throws {
        let store = try PairingStore(folder: folder())
        let old = states()[4]
        try store.write(old)
        var bad: [(String, PairingState)] = []
        func add(_ what: String, _ stage: PairingState, _ change: (inout PairingState) -> Void) { var s = stage; change(&s); bad.append((what, s)) }
        let all = states()
        add("join without a person", all[1]) { $0.person = nil }
        add("enrol with a person", all[0]) { $0.person = person }
        add("enrolling without a genesis", all[2]) { $0.genesis = nil }
        add("enrolling for another person", all[2]) { $0.person = person }
        add("empty host", all[5]) { $0.relay.host = "" }
        add("port 0", all[5]) { $0.relay.port = 0 }
        add("short relay key", all[5]) { $0.relay.key = Data(count: 64) }
        add("short person", all[5]) { $0.person = Data(count: 31) }
        add("empty name", all[3]) { $0.name = "" }
        add("short id", all[5]) { $0.pending = SignedEntry(signed: Data([1]), sig: Data(count: 64), id: Data(count: 31)) }
        add("empty removal", all[5]) { $0.removal = PairingRemoval(devices: [], length: 3) }
        add("a removal that left twice", all[5]) { $0.removal = PairingRemoval(devices: [Data(count: 32)], length: 3, left: [Data(repeating: 1, count: 32), Data(repeating: 1, count: 32)]) }
        add("a device both in the act and left", all[5]) { $0.removal = PairingRemoval(devices: [Data(count: 32)], length: 3, left: [Data(count: 32)]) }
        add("a short device that left", all[5]) { $0.removal = PairingRemoval(devices: [Data(count: 32)], length: 3, left: [Data(count: 31)]) }
        add("removal length 0", all[5]) { $0.removal = PairingRemoval(devices: [Data(count: 32)], length: 0) }
        add("a time that is not a number", all[5]) { $0.seen = [Data(count: 32): .nan] }
        add("an infinite time", all[5]) { $0.seen = [Data(count: 32): .infinity] }
        add("a negative time", all[5]) { $0.seen = [Data(count: 32): -1] }
        add("an empty label", all[5]) { $0.labels = [Data(count: 32): ""] }
        for (what, state) in bad {
            XCTAssertThrowsError(try store.write(state), what) { XCTAssertTrue($0 is PairingStateRefused, "\(what): \($0)") }
        }
        XCTAssertEqual(try store.load(), old, "the old file stays")
    }

    func testJSONBooleansAreNotNumbers() throws {
        let good = String(decoding: try PairingStore.encode(states()[4]), as: UTF8.self)
        try fault(good.replacingOccurrences(of: "\"version\":1", with: "\"version\":true"))
        try fault(good.replacingOccurrences(of: "\"port\":8443", with: "\"port\":true"))
        try fault(good.replacingOccurrences(of: "\"length\":6", with: "\"length\":true"))
        try fault(good.replacingOccurrences(of: "1790000000.5", with: "true"))
    }

    func testAnIntentBelongsToKeysMadeAlone() throws {
        for state in states() where state.stage != .keysMade(.enrol) && state.stage != .keysMade(.join) {
            let text = String(decoding: try PairingStore.encode(state), as: UTF8.self)
            try fault("{\"intent\":\"enrol\"," + text.dropFirst())
            try fault("{\"intent\":5," + text.dropFirst())
        }
    }

    func testEnrollingNamesTheGenesisIdAsThePerson() throws {
        var state = states()[2]
        state.person = person
        try faultFrom(state)
    }

    /// Two writes on one temporary name used to lose one and report both done.
    func testConcurrentWritesAndLoadsAreOneAfterAnother() throws {
        let place = folder()
        let store = try PairingStore(folder: place)
        let all = states()
        try store.write(all[0])
        let failures = OSAllocatedUnfairLock(initialState: [String]())
        let group = DispatchGroup()
        for i in 0..<64 {
            group.enter()
            DispatchQueue.global().async {
                defer { group.leave() }
                do {
                    if i % 4 == 3 { _ = try store.load() } else { try store.write(all[i % all.count]) }
                } catch { failures.withLock { $0.append("\(i): \(error)") } }
            }
        }
        group.wait()
        XCTAssertEqual(failures.withLock { $0 }, [], "no call fails")
        XCTAssertTrue(all.contains(try store.load()!), "the file decodes to one of the states written")
        XCTAssertFalse(FileManager.default.fileExists(atPath: place.appendingPathComponent("pairing.json.tmp").path))
    }
}
