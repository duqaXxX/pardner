// The link's state between launches (app data design, 3): the ids the device read, the relay's newest
// head, the incarnation, a put-back and a fault. No key and no content. Two files: `link-ids`, only
// appended, and `link.json`, written whole under a temporary name and renamed; its `count` is the truth,
// so bytes a crash left past it are ignored on load and written over by the next write. A third, `lock`,
// is held for the life of the process: two writers would zero-extend `link-ids` under each other.
import Darwin
import Foundation
import os
import ProtocolHost

/// The pairing a store belongs to: the device's two public keys and the relay's pinned key. A store of another is never read.
public struct LinkIdentity: Sendable, Equatable {
    public let signing: Data
    public let receiving: Data
    public let relay: Data

    public init(signing: Data, receiving: Data, relay: Data) { (self.signing, self.receiving, self.relay) = (signing, receiving, relay) }
}

/// A write the store cannot have come from the link it answers: a fault of the host, never retried.
public struct LinkStoreMismatch: Error, CustomStringConvertible {
    public let description: String
}

/// Reads and writes the link's state in one folder: one per process (the lock), claimed by one connection at a
/// time (`claim`), whose loads and writes come one after another.
public final class LinkStore: @unchecked Sendable {
    private static let version = 1
    private static let idSize = 32
    private let folder: URL
    /// The pairing this store belongs to.
    public let identity: LinkIdentity
    private var state: State
    private var lock: Int32 = -1
    private struct Claims { var held = false, closed = false }
    private let claims = OSAllocatedUnfairLock(initialState: Claims())
    private let log = Logger(subsystem: "io.github.duqaxxx.pardner", category: "store")

    private struct Head: Equatable {
        var n: Int
        var chain: Data
        var sig: Data
    }

    /// What `link.json` holds besides the identity.
    private struct State: Equatable {
        var count = 0
        var head: Head?
        var putBack = false
        var fault = false
        var incarnation: Data?
    }

    /// The store's folder of this app's set: `link` beside the key store's `keys`, under the running app's bundle identifier.
    public static func defaultFolder() throws -> URL {
        guard let identifier = Bundle.main.bundleIdentifier, !identifier.isEmpty else {
            throw StoreError(description: "the running app has no bundle identifier")
        }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return support.appendingPathComponent(identifier).appendingPathComponent("link")
    }

    /// Takes the store's lock, making the folder `0700` if absent; `StoreBusy` when another process holds it. A
    /// folder that is a symbolic link, belongs to another owner or has other permissions is refused, as the key store's.
    public init(folder: URL, identity: LinkIdentity) throws {
        (self.folder, self.identity, state) = (folder, identity, State())
        lock = try StoreDisk.lock(folder)
    }

    deinit { close() } // closing the descriptor releases the lock

    /// Gives the folder's lock back now. Called once the last write is done; a second call does nothing.
    public func close() {
        // Under the claims' lock, so a `claim()` on another task sees either a live store or a closed one.
        claims.withLock { state in
            state.closed = true
            guard lock >= 0 else { return }
            Darwin.close(lock)
            lock = -1
        }
    }

    private var jsonPath: String { folder.appendingPathComponent("link.json").path }
    private var idsPath: String { folder.appendingPathComponent("link-ids").path }

    /// Taken by a connection before its first load, released when it ends: two connections on one store would cut
    /// each other's ids, as two processes would. `StoreClaimed` while another holds it, and for good once the store is closed
    /// (its lock is gone: one store serves one process, and a connection that ends closes it).
    public func claim() throws {
        let taken = claims.withLock { state in
            if state.held || state.closed { return false }
            state.held = true
            return true
        }
        if !taken { throw StoreClaimed() }
    }

    public func release() { claims.withLock { $0.held = false } }

    // MARK: loading

    /// The stored state as `AppLinkOptions.stored`, or nil for a device that remembers nothing: no store, another
    /// pairing's, or one that does not read, which is logged and written over at the next write (design 3.5). A file
    /// that cannot be read now (an I/O error, a descriptor limit) throws: started again, it would cut the ids it holds.
    public func load() throws -> HostValue? {
        state = State()
        let data: Data
        do { data = try StoreDisk.read(jsonPath) } catch StoreDisk.Missing.file { return nil }
        do {
            let (read, ids) = try readStore(data)
            state = read
            var stored: [String: HostValue] = [
                "ids": .array(ids.map { .bytes($0) }), "putBack": .bool(read.putBack), "fault": .bool(read.fault),
                "incarnation": read.incarnation.map { .bytes($0) } ?? .null, "head": .null,
            ]
            if let head = read.head {
                stored["head"] = .object(["n": .number(Double(head.n)), "chain": .bytes(head.chain), "sig": .bytes(head.sig)])
            }
            return .object(stored)
        } catch let unreadable as Unreadable {
            log.error("the link's store does not read and is started again: \(unreadable.why, privacy: .public)")
            state = State()
            return nil
        }
    }

    private struct Unreadable: Error { let why: String }

    private func readStore(_ data: Data) throws -> (State, [Data]) {
        let refuse = { (why: String) in Unreadable(why: why) }
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { throw refuse("not an object") }
        guard o["version"] as? Int == Self.version else { throw refuse("another version") }
        guard StoreDisk.hex(o["signing"]) == identity.signing, StoreDisk.hex(o["receiving"]) == identity.receiving, StoreDisk.hex(o["relay"]) == identity.relay else {
            throw refuse("another pairing")
        }
        var s = State()
        // A count past what a file can hold is no count: its size in bytes would overflow.
        guard let count = o["count"] as? Int, count >= 0, count <= Int.max / Self.idSize, let putBack = o["putBack"] as? Bool, let fault = o["fault"] as? Bool else {
            throw refuse("a malformed field")
        }
        (s.count, s.putBack, s.fault) = (count, putBack, fault)
        if !(o["incarnation"] is NSNull) {
            guard let incarnation = StoreDisk.hex(o["incarnation"]), incarnation.count == 16 else { throw refuse("a malformed incarnation") }
            s.incarnation = incarnation
        }
        if !(o["head"] is NSNull) {
            guard let head = o["head"] as? [String: Any], let n = head["n"] as? Int, n >= 0,
                  let chain = StoreDisk.hex(head["chain"]), chain.count == 32, let sig = StoreDisk.hex(head["sig"]), sig.count == 64 else {
                throw refuse("a malformed head")
            }
            s.head = Head(n: n, chain: chain, sig: sig)
        }
        // A file shorter than `count`, or none, gives the whole ids it holds (design 3.5): the rest of the store stays.
        var bytes = Data()
        if count > 0 {
            do { bytes = try StoreDisk.read(idsPath, upTo: count * Self.idSize) } catch StoreDisk.Missing.file {}
        }
        let whole = bytes.count / Self.idSize
        if whole < count { log.error("the ids file holds \(whole) of \(count) ids") }
        s.count = whole
        let ids = (0..<whole).map { Data(bytes[($0 * Self.idSize)..<(($0 + 1) * Self.idSize)]) }
        return (s, ids)
    }

    /// Removes the link's two files from `folder` (design 3.10: Pair again erases the link store after the keys): the ids
    /// and the state belong to keys that are gone, and a store of another pairing is never read. The folder and its lock stay;
    /// `StoreBusy` while a store holds the folder, so a connection must have ended and dropped its store first.
    public static func erase(folder: URL) throws {
        let fd = try StoreDisk.lock(folder)
        defer { Darwin.close(fd) }
        for name in ["link.json", "link-ids"] where unlink(folder.appendingPathComponent(name).path) != 0 && Darwin.errno != ENOENT {
            throw StoreDisk.errno("remove the link's state")
        }
        try StoreDisk.syncFolder(folder)
    }

    // MARK: writing

    /// Writes one `persist` of the link, `{kept: {from, ids, head, putBack}, incarnation?, fault?}` (design 3.3), and
    /// throws on a failure, the state held staying the last one written: `LinkStoreMismatch` for a write no link of this
    /// store could make, which is the host's fault; any other error is the disk's, and the link may ask again.
    public func write(_ what: HostValue) throws {
        guard let kept = what["kept"], let from = Self.count(kept["from"]),
              let ids = kept["ids"]?.arrayValue, case .bool(let putBack)? = kept["putBack"], let head = kept["head"] else {
            throw LinkStoreMismatch(description: "a write this store does not know")
        }
        guard from >= 0, from <= state.count else { throw LinkStoreMismatch(description: "ids from past the stored count") }
        var next = state
        if head != .null {
            guard let n = Self.count(head["n"]), let chain = head["chain"]?.bytesValue, chain.count == 32,
                  let sig = head["sig"]?.bytesValue, sig.count == 64 else {
                throw LinkStoreMismatch(description: "a malformed head")
            }
            next.head = Head(n: n, chain: chain, sig: sig)
        }
        if let incarnation = what["incarnation"], incarnation != .null {
            guard let bytes = incarnation.bytesValue, bytes.count == 16 else { throw LinkStoreMismatch(description: "a malformed incarnation") }
            next.incarnation = bytes
        }
        if what["fault"] == .bool(true) { next.fault = true }
        next.putBack = next.putBack || putBack
        let bytes = try ids.reduce(into: Data()) { all, id in
            guard let id = id.bytesValue, id.count == Self.idSize else { throw LinkStoreMismatch(description: "an id that is not 32 bytes") }
            all.append(id)
        }
        if !bytes.isEmpty || from < state.count { try appendIds(from: from, bytes) }
        next.count = from + ids.count
        try writeJSON(next)
        // Renamed: the disk holds `next` from here on, whatever the folder's flush says, so a later write starts from it.
        state = next
        try StoreDisk.syncFolder(folder)
    }

    /// A count that crossed from JavaScript: a whole number a file of ids can hold, or nil.
    private static func count(_ value: HostValue?) -> Int? {
        guard let v = value?.numberValue, v.isFinite, v >= 0, v.rounded() == v, v <= Double(Int.max / idSize) else { return nil }
        return Int(v)
    }

    /// `link-ids` cut to `from` ids, then `bytes` appended and flushed to the disk. A cut past the file's end
    /// would fill the gap with zeros, read later as ids the relay never gave: refused (design 3.5).
    private func appendIds(from: Int, _ bytes: Data) throws {
        let fd = open(idsPath, O_WRONLY | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw StoreDisk.errno("open the ids file") }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0 else { throw StoreDisk.errno("read the ids file's size") }
        guard Int(info.st_size) >= from * Self.idSize else { throw StoreError(description: "a cut past the ids file's end") }
        guard ftruncate(fd, off_t(from * Self.idSize)) == 0 else { throw StoreDisk.errno("cut the ids file") }
        guard lseek(fd, 0, SEEK_END) >= 0 else { throw StoreDisk.errno("seek the ids file") }
        try StoreDisk.writeAll(fd, bytes)
        try StoreDisk.flush(fd)
    }

    /// `link.json` whole, under a temporary name, flushed and renamed; the caller flushes the folder.
    private func writeJSON(_ s: State) throws {
        var o: [String: Any] = [
            "version": Self.version, "count": s.count, "putBack": s.putBack, "fault": s.fault,
            "signing": StoreDisk.hex(identity.signing), "receiving": StoreDisk.hex(identity.receiving), "relay": StoreDisk.hex(identity.relay),
            "incarnation": s.incarnation.map(StoreDisk.hex) ?? NSNull(), "head": NSNull(),
        ]
        if let head = s.head { o["head"] = ["n": head.n, "chain": StoreDisk.hex(head.chain), "sig": StoreDisk.hex(head.sig)] }
        let data = try JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
        try StoreDisk.replace(jsonPath, with: data)
    }
}
