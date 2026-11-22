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
    /// The file's version is above this app's: it was written by a newer app and is never erased (design 4.1).
    public let isNewerVersion: Bool

    init(description: String, isNewerVersion: Bool = false) {
        self.description = description
        self.isNewerVersion = isNewerVersion
    }
}

/// A state the host built wrong, refused before it is written: the file on disk is untouched and still reads, so this is
/// no `PairingFault` (design 4.1). The reason names a field, never a value.
public struct PairingStateRefused: Error, CustomStringConvertible {
    public let description: String
}

public enum PairingIntent: String, Sendable, Equatable { case enrol, join, recover }

/// How far the pairing has got (design 3.5 and 3.7).
public enum PairingStage: Sendable, Equatable {
    /// The relay (and, to join, the person) is written; the keys are made only after this.
    case keysMade(PairingIntent)
    /// Entry 0 is signed and kept until the relay places it.
    case enrolling
    /// The proof is signed and kept until the other device's add lands.
    case joining
    /// The reset's inputs are kept and the reset is not yet known placed (recovery design 2.3 step 6).
    case recovering
    /// The reset is placed; the past is not yet re-sealed (recovery design 2.3 step 8).
    case recovered
    case paired
}

public struct PairingRelay: Sendable, Equatable {
    public var host: String
    public var port: UInt16
    /// The relay's pinned key: a P-256 point, 65 bytes.
    public var key: Data

    public init(host: String, port: UInt16, key: Data) { (self.host, self.port, self.key) = (host, port, key) }

    /// `host:port`, an IPv6 host in brackets: the form the setup and the recovery forms take, so what is copied is what is pasted.
    public var address: String { "\(host.contains(":") ? "[\(host)]" : host):\(port)" }
}

/// A removal in progress (design 3.9): the devices chosen, in the order they go, and the log's length when it began.
/// `left`: devices the log refused to remove. They left `devices` and stay known to the act, so that no rest takes them in again.
public struct PairingRemoval: Sendable, Equatable {
    public var devices: [Data]
    public var length: Int
    public var left: [Data]

    public init(devices: [Data], length: Int, left: [Data] = []) { (self.devices, self.length, self.left) = (devices, length, left) }
}

/// A recovery key's two public keys: P-256 points, 65 bytes each.
public struct PairingRecoveryKeys: Sendable, Equatable {
    public var signing: Data
    public var receiving: Data

    public init(signing: Data, receiving: Data) { (self.signing, self.receiving) = (signing, receiving) }
}

/// The inputs of the reset the link builds on every recovery connection (recovery design 2.3 step 6): no secret, only public ids and keys.
public struct PairingReset: Sendable, Equatable {
    /// The id of the recovery key typed to start.
    public var key: Data
    /// The answer `No` to "Could someone else have one of your devices?": the devices active in the log read stay.
    public var keepOthers: Bool
    /// The devices active in the log read at step 3.
    public var active: [Data]
    /// The new recovery key's public keys, when the person chose to make one.
    public var replacement: PairingRecoveryKeys?
    /// The ids of the recovery keys the log held before this reset.
    public var previous: [Data]

    public init(key: Data, keepOthers: Bool, active: [Data], replacement: PairingRecoveryKeys?, previous: [Data]) {
        (self.key, self.keepOthers, self.active, self.replacement, self.previous) = (key, keepOthers, active, replacement, previous)
    }
}

/// What a recovery keeps between launches (recovery design 2.3).
public struct PairingRecovery: Sendable, Equatable {
    /// The ids of the new recovery keys made in attempts that stopped: carried through every rewrite, so one typed back can be named (2.5).
    public var made: [Data]
    /// From stage `recovering` on.
    public var reset: PairingReset?

    public init(made: [Data] = [], reset: PairingReset? = nil) { (self.made, self.reset) = (made, reset) }
}

public struct PairingState: Sendable, Equatable {
    public var stage: PairingStage
    public var relay: PairingRelay
    /// The person id: given when joining, entry 0's id from `enrolling` on.
    public var person: Data?
    /// Entry 0 and its signature, while enrolling.
    public var genesis: SignedEntry?
    /// The proof of possession, while joining or recovering; the name is the joining's, and stays once paired.
    public var proof: Data?
    public var name: String?
    /// This app's own device id, stored when a pairing completes (first device, join, recovery); a Mac paired before holds none.
    public var device: Data?
    /// The device id this Mac held before a recovery began, read from the store the recovery replaced: the recovery names it and Devices marks it while it is active.
    public var earlier: Data?
    /// Device entries made and not yet read back: at most one (design 3.6).
    public var pending: SignedEntry?
    /// Device id to the name a pairing string gave it.
    public var labels: [Data: String] = [:]
    /// Device id to the time (seconds since 1970) this Mac first read its add.
    public var seen: [Data: Double] = [:]
    public var removal: PairingRemoval?
    /// A recovery's ids and inputs: the stages `keys-made` of a recovery, `recovering` and `recovered` hold it, no other does.
    public var recovery: PairingRecovery?

    public init(stage: PairingStage, relay: PairingRelay, person: Data? = nil) { (self.stage, self.relay, self.person) = (stage, relay, person) }
}

/// Reads and writes the pairing in one folder: one process holds it (the lock).
public final class PairingStore: @unchecked Sendable {
    /// Version 2 is a file that holds a recovery: an app that reads version 1 only calls it newer and erases nothing (design 4.1).
    /// Version 3 is a file that keeps the name typed at setup or at a join, from `keys-made` of a first device to paired (names design 4.2, 4.3): an app that reads version 2 or 1 calls it newer and erases nothing.
    /// Version 4 is a file that keeps this app's device id or a recovery's earlier one: an app that reads up to version 3 calls it newer and erases nothing.
    private static let version = 4, nameVersion = 3, recoveryVersion = 2, plainVersion = 1
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

    private static let keys: Set<String> = ["version", "stage", "intent", "relay", "person", "genesis", "proof", "name", "device", "earlier", "pending", "labels", "seen", "removal", "recovery"]

    /// The JSON of a state, whole; a time that is not finite is refused before the serializer sees it, which raises an Objective-C exception on one.
    static func encode(_ s: PairingState) throws -> Data {
        guard s.seen.values.allSatisfy(\.isFinite) else { throw PairingStateRefused(description: "the pairing holds a time that is not a number") }
        func hex(_ data: Data) -> String { StoreDisk.hex(data) }
        let entry = { (e: SignedEntry) -> [String: Any] in ["signed": hex(e.signed), "sig": hex(e.sig), "id": hex(e.id)] }
        var o: [String: Any] = [
            "version": s.device != nil || s.earlier != nil ? version : s.name != nil && s.stage != .joining ? nameVersion : s.recovery == nil ? plainVersion : recoveryVersion,
            "relay": ["host": s.relay.host, "port": Int(s.relay.port), "key": hex(s.relay.key)],
            "labels": Dictionary(uniqueKeysWithValues: s.labels.map { (hex($0.key), $0.value) }),
            "seen": Dictionary(uniqueKeysWithValues: s.seen.map { (hex($0.key), $0.value) }),
        ]
        switch s.stage {
        case .keysMade(let intent): (o["stage"], o["intent"]) = ("keys-made", intent.rawValue)
        case .enrolling: o["stage"] = "enrolling"
        case .joining: o["stage"] = "joining"
        case .recovering: o["stage"] = "recovering"
        case .recovered: o["stage"] = "recovered"
        case .paired: o["stage"] = "paired"
        }
        if let person = s.person { o["person"] = hex(person) }
        if let genesis = s.genesis { o["genesis"] = entry(genesis) }
        if let proof = s.proof { o["proof"] = hex(proof) }
        if let name = s.name { o["name"] = name }
        if let device = s.device { o["device"] = hex(device) }
        if let earlier = s.earlier { o["earlier"] = hex(earlier) }
        if let pending = s.pending { o["pending"] = entry(pending) }
        if let removal = s.removal { o["removal"] = ["devices": removal.devices.map(hex), "length": removal.length, "left": removal.left.map(hex)] }
        if let recovery = s.recovery {
            var r: [String: Any] = ["made": recovery.made.map(hex)]
            if let x = recovery.reset {
                var reset: [String: Any] = ["key": hex(x.key), "keep": x.keepOthers, "active": x.active.map(hex), "previous": x.previous.map(hex)]
                if let n = x.replacement { reset["replacement"] = ["signing": hex(n.signing), "receiving": hex(n.receiving)] }
                r["reset"] = reset
            }
            o["recovery"] = r
        }
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
        guard let fileVersion = int(o["version"]), [plainVersion, recoveryVersion, nameVersion, version].contains(fileVersion), fileVersion == plainVersion ? o["recovery"] == nil : true else {
            let newer = int(o["version"]).map { $0 > version } ?? false
            throw PairingFault(description: refuse("another version").description, isNewerVersion: newer)
        }
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
            case "recover"?: stage = .keysMade(.recover)
            default: throw refuse("an unknown stage")
            }
        case "enrolling" where intent == nil: stage = .enrolling
        case "joining" where intent == nil: stage = .joining
        case "recovering" where intent == nil: stage = .recovering
        case "recovered" where intent == nil: stage = .recovered
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
        if let device = o["device"] { s.device = try bytes(device, 32, "device id") }
        if let earlier = o["earlier"] { s.earlier = try bytes(earlier, 32, "earlier device id") }
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
            guard let m = removal as? [String: Any], Set(m.keys) == ["devices", "length", "left"], let list = m["devices"] as? [Any], !list.isEmpty,
                  let leftList = m["left"] as? [Any], let length = int(m["length"]), length > 0 else { throw refuse("a malformed removal") }
            let devices = try list.map { try bytes($0, 32, "removal device") }, left = try leftList.map { try bytes($0, 32, "removal device that left") }
            guard Set(left).count == left.count, Set(left).isDisjoint(with: devices) else { throw refuse("a malformed removal") }
            s.removal = PairingRemoval(devices: devices, length: length, left: left)
        }
        if let recovery = o["recovery"] { s.recovery = try Self.recovery(recovery, bytes, refuse) }
        try shape(s, refuse)
        if s.stage != .joining, s.name != nil, fileVersion < nameVersion { throw refuse("a name that belongs to version 3") }
        if s.device != nil || s.earlier != nil, fileVersion != version { throw refuse("a device id that belongs to version 4") }
        return s
    }

    private static func recovery(_ value: Any, _ bytes: (Any?, Int, String) throws -> Data, _ refuse: (String) -> PairingFault) throws -> PairingRecovery {
        func ids(_ value: Any?, _ what: String) throws -> [Data] {
            guard let list = value as? [Any] else { throw refuse("a malformed \(what)") }
            let ids = try list.map { try bytes($0, 32, what) }
            guard Set(ids).count == ids.count else { throw refuse("a malformed \(what)") }
            return ids
        }
        guard let r = value as? [String: Any], Set(r.keys).isSubset(of: ["made", "reset"]) else { throw refuse("a malformed recovery") }
        var recovery = PairingRecovery(made: try ids(r["made"], "recovery key made"))
        guard let reset = r["reset"] else { return recovery }
        guard let m = reset as? [String: Any], Set(m.keys).isSubset(of: ["key", "keep", "active", "replacement", "previous"]),
              let flag = m["keep"] as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID(), let key = m["key"] else { throw refuse("a malformed reset") }
        var replacement: PairingRecoveryKeys?
        if let n = m["replacement"] {
            guard let k = n as? [String: Any], Set(k.keys) == ["signing", "receiving"] else { throw refuse("a malformed reset") }
            replacement = PairingRecoveryKeys(signing: try bytes(k["signing"], 65, "new recovery key"), receiving: try bytes(k["receiving"], 65, "new recovery key"))
        }
        recovery.reset = PairingReset(key: try bytes(key, 32, "recovery key id"), keepOthers: flag.boolValue, active: try ids(m["active"], "active device"),
                                      replacement: replacement, previous: try ids(m["previous"], "earlier recovery key"))
        return recovery
    }

    /// Which fields each stage holds (design 4.1): the ones it needs, and no other.
    private static func shape(_ s: PairingState, _ refuse: (String) -> PairingFault) throws {
        let present = (genesis: s.genesis != nil, proof: s.proof != nil, name: s.name != nil, person: s.person != nil)
        let later = s.pending == nil && s.removal == nil
        let ownDevice = s.device == nil || s.stage == .paired, earlier = s.earlier == nil || [.keysMade(.recover), .recovering, .recovered, .paired].contains(s.stage)
        let (made, reset) = (s.recovery != nil, s.recovery?.reset != nil)
        let fits: Bool
        switch s.stage {
        case .keysMade(.recover): fits = present.person && !present.genesis && !present.proof && !present.name && later && made && !reset
        case .recovering: fits = present.person && !present.genesis && present.proof && !present.name && later && reset
        case .recovered: fits = present.person && !present.genesis && !present.proof && !present.name && later && reset
        case .keysMade(.enrol): fits = !made && !present.person && !present.genesis && !present.proof && later // the name typed at setup may be there, in a version 3 file
        case .keysMade(.join): fits = !made && present.person && !present.genesis && !present.proof && !present.name && later
        case .enrolling: fits = !made && present.person && present.genesis && s.person == s.genesis?.id && !present.proof && later
        case .joining: fits = !made && present.person && !present.genesis && present.proof && present.name && later
        case .paired: fits = !made && present.person && !present.genesis && !present.proof // a name may stay: the one typed at a join (names design 4.3), in a version 3 file
        }
        guard fits, ownDevice, earlier else { throw refuse("fields that do not belong to the stage") }
    }
}
