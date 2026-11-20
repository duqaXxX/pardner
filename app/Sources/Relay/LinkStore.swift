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

public struct LinkStoreError: Error, CustomStringConvertible {
    public let description: String
}

/// A write the store cannot have come from the link it answers: a fault of the host, never retried.
public struct LinkStoreMismatch: Error, CustomStringConvertible {
    public let description: String
}

/// Another process of the app holds the store: it is the one that reads the relay.
public struct LinkStoreBusy: Error, CustomStringConvertible {
    public var description: String { "another copy of Pardner is running and holds the relay's store" }
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
    private let claims = OSAllocatedUnfairLock(initialState: false)
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
            throw LinkStoreError(description: "the running app has no bundle identifier")
        }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return support.appendingPathComponent(identifier).appendingPathComponent("link")
    }

    /// Takes the store's lock, making the folder `0700` if absent; `LinkStoreBusy` when another process holds it. A
    /// folder that is a symbolic link, belongs to another owner or has other permissions is refused, as the key store's.
    public init(folder: URL, identity: LinkIdentity) throws {
        (self.folder, self.identity, state) = (folder, identity, State())
        try FileManager.default.createDirectory(at: folder.deletingLastPathComponent(), withIntermediateDirectories: true)
        if mkdir(folder.path, 0o700) != 0 && Darwin.errno != EEXIST { throw Self.errno("create the store's folder") }
        var info = stat()
        guard lstat(folder.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
            throw LinkStoreError(description: "the store's folder is a link, belongs to another owner or has permissions other than 0700")
        }
        let fd = open(folder.appendingPathComponent("lock").path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw Self.errno("open the store's lock") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd)
            throw LinkStoreBusy()
        }
        lock = fd
    }

    deinit { if lock >= 0 { close(lock) } } // closing the descriptor releases the lock

    private var jsonPath: String { folder.appendingPathComponent("link.json").path }
    private var idsPath: String { folder.appendingPathComponent("link-ids").path }

    /// Taken by a connection before its first load, released when it ends: two connections on one store would cut
    /// each other's ids, as two processes would. `LinkStoreBusy` while another holds it.
    public func claim() throws {
        let taken = claims.withLock { held in
            if held { return false }
            held = true
            return true
        }
        if !taken { throw LinkStoreBusy() }
    }

    public func release() { claims.withLock { $0 = false } }

    // MARK: loading

    /// The stored state as `AppLinkOptions.stored`, or nil for a device that remembers nothing: no store, another
    /// pairing's, or one that does not read, which is logged and written over at the next write (design 3.5). A file
    /// that cannot be read now (an I/O error, a descriptor limit) throws: started again, it would cut the ids it holds.
    public func load() throws -> HostValue? {
        state = State()
        let data: Data
        do { data = try read(jsonPath) } catch Missing.file { return nil }
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

    private enum Missing: Error { case file }
    private struct Unreadable: Error { let why: String }

    private func readStore(_ data: Data) throws -> (State, [Data]) {
        let refuse = { (why: String) in Unreadable(why: why) }
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { throw refuse("not an object") }
        guard o["version"] as? Int == Self.version else { throw refuse("another version") }
        guard hex(o["signing"]) == identity.signing, hex(o["receiving"]) == identity.receiving, hex(o["relay"]) == identity.relay else {
            throw refuse("another pairing")
        }
        var s = State()
        // A count past what a file can hold is no count: its size in bytes would overflow.
        guard let count = o["count"] as? Int, count >= 0, count <= Int.max / Self.idSize, let putBack = o["putBack"] as? Bool, let fault = o["fault"] as? Bool else {
            throw refuse("a malformed field")
        }
        (s.count, s.putBack, s.fault) = (count, putBack, fault)
        if !(o["incarnation"] is NSNull) {
            guard let incarnation = hex(o["incarnation"]), incarnation.count == 16 else { throw refuse("a malformed incarnation") }
            s.incarnation = incarnation
        }
        if !(o["head"] is NSNull) {
            guard let head = o["head"] as? [String: Any], let n = head["n"] as? Int, n >= 0,
                  let chain = hex(head["chain"]), chain.count == 32, let sig = hex(head["sig"]), sig.count == 64 else {
                throw refuse("a malformed head")
            }
            s.head = Head(n: n, chain: chain, sig: sig)
        }
        // A file shorter than `count`, or none, gives the whole ids it holds (design 3.5): the rest of the store stays.
        var bytes = Data()
        if count > 0 {
            do { bytes = try read(idsPath, upTo: count * Self.idSize) } catch Missing.file {}
        }
        let whole = bytes.count / Self.idSize
        if whole < count { log.error("the ids file holds \(whole) of \(count) ids") }
        s.count = whole
        let ids = (0..<whole).map { Data(bytes[($0 * Self.idSize)..<(($0 + 1) * Self.idSize)]) }
        return (s, ids)
    }

    /// At most `length` bytes of the file; `Missing.file` when there is none, any other failure as itself.
    private func read(_ path: String, upTo length: Int = Int.max) throws -> Data {
        let fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        if fd < 0 && Darwin.errno == ENOENT { throw Missing.file }
        guard fd >= 0 else { throw errno("open \((path as NSString).lastPathComponent)") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        return try handle.read(upToCount: length) ?? Data()
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
        try syncFolder()
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
        guard fd >= 0 else { throw errno("open the ids file") }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0 else { throw errno("read the ids file's size") }
        guard Int(info.st_size) >= from * Self.idSize else { throw LinkStoreError(description: "a cut past the ids file's end") }
        guard ftruncate(fd, off_t(from * Self.idSize)) == 0 else { throw errno("cut the ids file") }
        guard lseek(fd, 0, SEEK_END) >= 0 else { throw errno("seek the ids file") }
        try writeAll(fd, bytes)
        try flush(fd)
    }

    /// `link.json` whole, under a temporary name, flushed and renamed; the caller flushes the folder.
    private func writeJSON(_ s: State) throws {
        var o: [String: Any] = [
            "version": Self.version, "count": s.count, "putBack": s.putBack, "fault": s.fault,
            "signing": hex(identity.signing), "receiving": hex(identity.receiving), "relay": hex(identity.relay),
            "incarnation": s.incarnation.map(hex) ?? NSNull(), "head": NSNull(),
        ]
        if let head = s.head { o["head"] = ["n": head.n, "chain": hex(head.chain), "sig": hex(head.sig)] }
        let data = try JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
        let temporary = jsonPath + ".tmp"
        unlink(temporary)
        let fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw errno("open the temporary store") }
        do {
            try writeAll(fd, data)
            try flush(fd)
            close(fd)
        } catch {
            close(fd)
            unlink(temporary)
            throw error
        }
        guard rename(temporary, jsonPath) == 0 else {
            let failure = errno("rename the store")
            unlink(temporary)
            throw failure
        }
    }

    /// The folder's entries to the disk, as the key store flushes its own (`F_FULLFSYNC` on the folder).
    private func syncFolder() throws {
        let dir = open(folder.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard dir >= 0 else { throw errno("open the store's folder") }
        defer { close(dir) }
        try flush(dir)
    }

    private func writeAll(_ fd: Int32, _ data: Data) throws {
        try data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
            var done = 0
            while done < buffer.count {
                let n = Darwin.write(fd, buffer.baseAddress! + done, buffer.count - done)
                if n < 0 && Darwin.errno == EINTR { continue }
                guard n > 0 else { throw errno("write") }
                done += n
            }
        }
    }

    // `F_FULLFSYNC` asks the drive to flush its cache too, as the relay's `fs.fsync` does on macOS (AD 4.2).
    private func flush(_ fd: Int32) throws {
        if fcntl(fd, F_FULLFSYNC) == 0 { return }
        guard fsync(fd) == 0 else { throw errno("flush") }
    }

    private func errno(_ what: String) -> LinkStoreError { Self.errno(what) }

    private static func errno(_ what: String) -> LinkStoreError {
        LinkStoreError(description: "\(what): \(String(cString: strerror(Darwin.errno)))")
    }
}

private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

private func hex(_ value: Any?) -> Data? {
    guard let s = value as? String, s.count % 2 == 0, s.allSatisfy(\.isHexDigit), s == s.lowercased() else { return nil }
    var data = Data(capacity: s.count / 2)
    var i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        guard let byte = UInt8(s[i..<j], radix: 16) else { return nil }
        data.append(byte)
        i = j
    }
    return data
}
