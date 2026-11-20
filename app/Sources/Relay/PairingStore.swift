// The app's pairing, between launches (device pairing design 4.1): how far this Mac has got in becoming a device of a
// person, the relay it pairs with and what the Devices screen keeps. One file, `pairing.json`, written whole under a
// temporary name and renamed, then the folder flushed; the store's `lock` file is held for the life of the process, and
// one `OSAllocatedUnfairLock` holds a load, a write or an erase from the others in it. It holds no secret:
// the keys are in the Secure Enclave, the recovery secret and the enrolment secret are never stored.
// The keeper's epoch clocks (design 3.11) are not here: `AppLink` keeps them in memory and does not expose them, so
// that needs a change of the package first.
import Darwin
import Foundation
import os
import ProtocolHost

/// The file does not read as a pairing: a fault the app names, never a state it repairs by guessing (design 4.1).
public struct PairingFault: Error, CustomStringConvertible {
    public let description: String
}

/// A state the host built wrong, refused before it is written: the file on disk is untouched and still reads, so this is
/// no `PairingFault` (design 4.1). The reason names a field, never a value.
public struct PairingStateRefused: Error, CustomStringConvertible {
    public let description: String
}

public enum PairingIntent: String, Sendable, Equatable { case enrol, join }

/// How far the pairing has got (design 3.5 and 3.7).
public enum PairingStage: Sendable, Equatable {
    /// The relay (and, to join, the person) is written; the keys are made only after this.
    case keysMade(PairingIntent)
    /// Entry 0 is signed and kept until the relay places it.
    case enrolling
    /// The proof is signed and kept until the other device's add lands.
    case joining
    case paired
}

public struct PairingRelay: Sendable, Equatable {
    public var host: String
    public var port: UInt16
    /// The relay's pinned key: a P-256 point, 65 bytes.
    public var key: Data

    public init(host: String, port: UInt16, key: Data) { (self.host, self.port, self.key) = (host, port, key) }
}

/// A removal in progress (design 3.9): the devices chosen, in the order they go, and the log's length when it began.
public struct PairingRemoval: Sendable, Equatable {
    public var devices: [Data]
    public var length: Int

    public init(devices: [Data], length: Int) { (self.devices, self.length) = (devices, length) }
}

public struct PairingState: Sendable, Equatable {
    public var stage: PairingStage
    public var relay: PairingRelay
    /// The person id: given when joining, entry 0's id from `enrolling` on.
    public var person: Data?
    /// Entry 0 and its signature, while enrolling.
    public var genesis: SignedEntry?
    /// The proof of possession and this Mac's name, while joining.
    public var proof: Data?
    public var name: String?
    /// Device entries made and not yet read back: at most one (design 3.6).
    public var pending: SignedEntry?
    /// Device id to the name a pairing string gave it.
    public var labels: [Data: String] = [:]
    /// Device id to the time (seconds since 1970) this Mac first read its add.
    public var seen: [Data: Double] = [:]
    public var removal: PairingRemoval?

    public init(stage: PairingStage, relay: PairingRelay, person: Data? = nil) { (self.stage, self.relay, self.person) = (stage, relay, person) }
}

/// Reads and writes the pairing in one folder: one process holds it (the lock).
public final class PairingStore: @unchecked Sendable {
    private static let version = 1
    private let folder: URL
    private var lock: Int32 = -1
    private let calls = OSAllocatedUnfairLock()

    /// `pairing` beside the key store's `keys` and the link's `link`, under the running app's bundle identifier.
    public static func defaultFolder() throws -> URL {
        guard let identifier = Bundle.main.bundleIdentifier, !identifier.isEmpty else {
            throw StoreError(description: "the running app has no bundle identifier")
        }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return support.appendingPathComponent(identifier).appendingPathComponent("pairing")
    }

    /// Takes the store's lock, making the folder `0700` if absent and excluding it from backup; `StoreBusy` when
    /// another process holds it. A folder that is a symbolic link, belongs to another owner or has other permissions is refused.
    public init(folder: URL) throws {
        self.folder = folder
        lock = try StoreDisk.lock(folder)
    }

    deinit { if lock >= 0 { close(lock) } } // closing the descriptor releases the lock

    private var path: String { folder.appendingPathComponent("pairing.json").path }

    /// The stored pairing, or nil when there is none. A file that does not read is a `PairingFault`; one that cannot be read now throws its own error.
    public func load() throws -> PairingState? {
        try calls.withLock {
            let data: Data
            do { data = try StoreDisk.read(path) } catch StoreDisk.Missing.file { return nil }
            return try Self.decode(data)
        }
    }

    /// Writes the pairing whole and flushes the folder; the file is the old one or this one, whatever stops the app. A
    /// state the file would not read back (a stage's wrong fields, an empty name, a time that is not a number) is a `PairingStateRefused` and the old file stays.
    public func write(_ state: PairingState) throws {
        try calls.withLock {
            let data = try Self.encode(state)
            do { _ = try Self.decode(data) } catch let fault as PairingFault {
                throw PairingStateRefused(description: "the pairing state would not read back: \(fault.description)")
            }
            try StoreDisk.replace(path, with: data)
            try StoreDisk.syncFolder(folder)
        }
    }

    /// Removes the file (design 3.7: the keys are erased first, the store last).
    public func erase() throws {
        try calls.withLock {
            if unlink(path) != 0 && Darwin.errno != ENOENT { throw StoreDisk.errno("remove the pairing") }
            try StoreDisk.syncFolder(folder)
        }
    }

    // MARK: the file

    private static let keys: Set<String> = ["version", "stage", "intent", "relay", "person", "genesis", "proof", "name", "pending", "labels", "seen", "removal"]

    /// The JSON of a state, whole; a time that is not finite is refused before the serializer sees it, which raises an Objective-C exception on one.
    static func encode(_ s: PairingState) throws -> Data {
        guard s.seen.values.allSatisfy(\.isFinite) else { throw PairingStateRefused(description: "the pairing holds a time that is not a number") }
        func hex(_ data: Data) -> String { StoreDisk.hex(data) }
        let entry = { (e: SignedEntry) -> [String: Any] in ["signed": hex(e.signed), "sig": hex(e.sig), "id": hex(e.id)] }
        var o: [String: Any] = [
            "version": version,
            "relay": ["host": s.relay.host, "port": Int(s.relay.port), "key": hex(s.relay.key)],
            "labels": Dictionary(uniqueKeysWithValues: s.labels.map { (hex($0.key), $0.value) }),
            "seen": Dictionary(uniqueKeysWithValues: s.seen.map { (hex($0.key), $0.value) }),
        ]
        switch s.stage {
        case .keysMade(let intent): (o["stage"], o["intent"]) = ("keys-made", intent.rawValue)
        case .enrolling: o["stage"] = "enrolling"
        case .joining: o["stage"] = "joining"
        case .paired: o["stage"] = "paired"
        }
        if let person = s.person { o["person"] = hex(person) }
        if let genesis = s.genesis { o["genesis"] = entry(genesis) }
        if let proof = s.proof { o["proof"] = hex(proof) }
        if let name = s.name { o["name"] = name }
        if let pending = s.pending { o["pending"] = entry(pending) }
        if let removal = s.removal { o["removal"] = ["devices": removal.devices.map(hex), "length": removal.length] }
        return try JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
    }

    /// Every field is checked, and so is the stage's shape: a field that does not belong to the stage, or one it lacks, is a fault.
    static func decode(_ data: Data) throws -> PairingState {
        func refuse(_ why: String) -> PairingFault { PairingFault(description: "the pairing file does not read: \(why)") }
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { throw refuse("not an object") }
        // `as? Int` and `as? Double` take a JSON boolean for 1 or 0: a number is checked not to be one.
        func number(_ value: Any?) -> NSNumber? {
            guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
            return n
        }
        func int(_ value: Any?) -> Int? { number(value).flatMap { $0 as? Int } }
        guard int(o["version"]) == version else { throw refuse("another version") }
        guard Set(o.keys).isSubset(of: keys) else { throw refuse("an unknown field") }
        func bytes(_ value: Any?, _ size: Int, _ what: String) throws -> Data {
            guard let d = StoreDisk.hex(value), d.count == size else { throw refuse("a malformed \(what)") }
            return d
        }
        func entry(_ value: Any?, _ what: String) throws -> SignedEntry {
            guard let e = value as? [String: Any], Set(e.keys) == ["signed", "sig", "id"], let signed = StoreDisk.hex(e["signed"]), !signed.isEmpty else { throw refuse("a malformed \(what)") }
            return SignedEntry(signed: signed, sig: try bytes(e["sig"], 64, what), id: try bytes(e["id"], 32, what))
        }
        guard let r = o["relay"] as? [String: Any], Set(r.keys) == ["host", "port", "key"], let host = r["host"] as? String, !host.isEmpty,
              let port = int(r["port"]), (1...65535).contains(port) else { throw refuse("a malformed relay") }
        let relay = PairingRelay(host: host, port: UInt16(port), key: try bytes(r["key"], 65, "relay key"))
        let stage: PairingStage
        // An intent of any type belongs to `keys-made` alone: `o["intent"] as? String` would pass a number as none.
        let intent = o["intent"]
        switch o["stage"] as? String {
        case "keys-made":
            switch intent as? String {
            case "enrol"?: stage = .keysMade(.enrol)
            case "join"?: stage = .keysMade(.join)
            default: throw refuse("an unknown stage")
            }
        case "enrolling" where intent == nil: stage = .enrolling
        case "joining" where intent == nil: stage = .joining
        case "paired" where intent == nil: stage = .paired
        default: throw refuse("an unknown stage")
        }
        var s = PairingState(stage: stage, relay: relay)
        if let person = o["person"] { s.person = try bytes(person, 32, "person") }
        if let genesis = o["genesis"] { s.genesis = try entry(genesis, "genesis") }
        if let proof = o["proof"] { s.proof = try bytes(proof, 64, "proof") }
        if let name = o["name"] {
            guard let name = name as? String, !name.isEmpty else { throw refuse("a malformed name") }
            s.name = name
        }
        if let pending = o["pending"] { s.pending = try entry(pending, "pending entry") }
        guard let labels = o["labels"] as? [String: Any], let seen = o["seen"] as? [String: Any] else { throw refuse("malformed labels or seen") }
        for (id, name) in labels {
            guard let device = StoreDisk.hex(id), device.count == 32, let name = name as? String, !name.isEmpty else { throw refuse("a malformed label") }
            s.labels[device] = name
        }
        for (id, time) in seen {
            guard let device = StoreDisk.hex(id), device.count == 32, let time = number(time)?.doubleValue, time.isFinite, time >= 0 else { throw refuse("a malformed time") }
            s.seen[device] = time
        }
        if let removal = o["removal"] {
            guard let m = removal as? [String: Any], Set(m.keys) == ["devices", "length"], let list = m["devices"] as? [Any], !list.isEmpty,
                  let length = int(m["length"]), length > 0 else { throw refuse("a malformed removal") }
            s.removal = PairingRemoval(devices: try list.map { try bytes($0, 32, "removal device") }, length: length)
        }
        try shape(s, refuse)
        return s
    }

    /// Which fields each stage holds (design 4.1): the ones it needs, and no other.
    private static func shape(_ s: PairingState, _ refuse: (String) -> PairingFault) throws {
        let present = (genesis: s.genesis != nil, proof: s.proof != nil, name: s.name != nil, person: s.person != nil)
        let later = s.pending == nil && s.removal == nil
        let fits: Bool
        switch s.stage {
        case .keysMade(.enrol): fits = !present.person && !present.genesis && !present.proof && !present.name && later
        case .keysMade(.join): fits = present.person && !present.genesis && !present.proof && !present.name && later
        case .enrolling: fits = present.person && present.genesis && s.person == s.genesis?.id && !present.proof && !present.name && later
        case .joining: fits = present.person && !present.genesis && present.proof && present.name && later
        case .paired: fits = present.person && !present.genesis && !present.proof && !present.name
        }
        guard fits else { throw refuse("fields that do not belong to the stage") }
    }
}
