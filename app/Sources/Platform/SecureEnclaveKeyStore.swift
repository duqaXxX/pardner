// The made keys in the Secure Enclave. A key is a blob only this Mac's enclave can use, kept in one
// file per key in the folder of the set (`Application Support/<bundle identifier>/keys/`): two sets
// with two bundle identifiers have two folders and never see each other's names. The blob is read
// for each operation and dropped; it is not secret off this enclave.
// Not reached by `delete`: a copy of the blob (a backup, an APFS snapshot) stays usable by any
// program of the same user on this Mac (security design, section 8).
import CryptoKit
import Foundation

public final class SecureEnclaveKeyStore: KeyStore {
    private let folder: String
    /// The folder's descriptor, locked exclusively for the store's lifetime: one store per folder.
    private let lock: Int32

    /// The keys folder of this app's set, from the bundle identifier of the running app.
    public convenience init() throws {
        guard let identifier = Bundle.main.bundleIdentifier, !identifier.isEmpty else { throw Fault(message: "the running app has no bundle identifier") }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        try self.init(folder: support.appendingPathComponent(identifier).appendingPathComponent("keys"))
    }

    /// A store over `folder`, made `0700` if absent. A folder that is a symbolic link, belongs to another
    /// owner or has other permissions is refused with a `Fault`; leftover temporary files are removed.
    public init(folder: URL) throws {
        let path = folder.path
        try FileManager.default.createDirectory(at: folder.deletingLastPathComponent(), withIntermediateDirectories: true)
        if mkdir(path, 0o700) != 0 && errno != EEXIST { throw Fault(message: "the keys folder cannot be created: \(String(cString: strerror(errno)))") }
        var info = stat()
        guard lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
            throw Fault(message: "the keys folder is a link, belongs to another owner or has permissions other than 0700")
        }
        let lock = Darwin.open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard lock >= 0 else { throw Fault(message: "the keys folder cannot be opened: \(String(cString: strerror(errno)))") }
        guard flock(lock, LOCK_EX | LOCK_NB) == 0 else {
            close(lock)
            throw Fault(message: "another store holds the keys folder")
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = folder
        do { try url.setResourceValues(values) } catch { close(lock); throw error }
        self.folder = path
        self.lock = lock
        // Only with the lock held: no other store has a write in flight.
        for name in try FileManager.default.contentsOfDirectory(atPath: path) where name.hasPrefix(".tmp-") { unlink(path + "/" + name) }
    }

    deinit { close(lock) }

    private func file(_ name: String, _ use: KeyUse) -> String { "\(folder)/\(name).\(use.rawValue)" }

    /// At most 200 bytes, so that `<name>.<use>` fits a file name's 255.
    private func valid(_ name: String) -> Bool { name.utf8.count <= 200 && name.wholeMatch(of: /[a-z0-9-]{1,64}(\.[a-z0-9-]{1,64})*/) != nil }

    /// A failure of the enclave or the blob is a `Fault`; only the package's own `Failure`s are values.
    private func guarded<T>(_ body: () throws -> T) throws -> T {
        do { return try body() } catch let failure as Failure { throw failure } catch let fault as Fault { throw fault } catch {
            throw Fault(message: "the Secure Enclave key store: \(error)")
        }
    }

    private func blob(_ name: String, _ use: KeyUse) throws -> Data {
        guard valid(name) else { throw Failure.badInput }
        let descriptor = Darwin.open(file(name, use), O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else {
            if errno == ENOENT { throw Failure.noSuchKey }
            throw Fault(message: "a key blob cannot be opened: \(String(cString: strerror(errno)))")
        }
        guard let data = try FileHandle(fileDescriptor: descriptor, closeOnDealloc: true).readToEnd() else { throw Fault(message: "a key blob is empty") }
        return data
    }

    /// `O_EXCL` temporary file, synced, `RENAME_EXCL` onto the name, synced folder; the file is removed on any failure.
    func write(_ data: Data, _ name: String, _ use: KeyUse) throws {
        let temporary = "\(folder)/.tmp-" + (0..<16).map { _ in String(format: "%02x", UInt8.random(in: .min ... .max)) }.joined()
        let descriptor = Darwin.open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw Fault(message: "a key blob cannot be written: \(String(cString: strerror(errno)))") }
        var done = false
        defer { if !done { unlink(temporary) } }
        let wrote = data.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress, $0.count) } == data.count
        let synced = wrote && fcntl(descriptor, F_FULLFSYNC) == 0
        close(descriptor)
        guard synced else { throw Fault(message: "a key blob cannot be written to disk") }
        guard renamex_np(temporary, file(name, use), UInt32(RENAME_EXCL)) == 0 else {
            if errno == EEXIST { throw Failure.keyExists }
            throw Fault(message: "a key blob cannot be put in place: \(String(cString: strerror(errno)))")
        }
        done = true
        guard syncFolder() else {
            unlink(file(name, use))
            _ = syncFolder()
            throw Fault(message: "the keys folder cannot be written to disk")
        }
    }

    private func syncFolder() -> Bool { fcntl(lock, F_FULLFSYNC) == 0 }

    private static func access() throws -> SecAccessControl {
        var error: Unmanaged<CFError>?
        // After the first login since boot, also while the screen is locked (decision D1); never a prompt.
        guard let control = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &error) else {
            throw Fault(message: "the access control cannot be made: \(error?.takeRetainedValue().localizedDescription ?? "unknown")")
        }
        return control
    }

    public func make(_ name: String, _ use: KeyUse) throws -> Data {
        try guarded {
            guard valid(name) else { throw Failure.badInput }
            guard !has(name) else { throw Failure.keyExists }
            let control = try Self.access()
            switch use {
            case .sign:
                let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: control)
                try write(key.dataRepresentation, name, use)
                return key.publicKey.x963Representation
            case .receive:
                let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: control)
                try write(key.dataRepresentation, name, use)
                return key.publicKey.x963Representation
            }
        }
    }

    public func publicKey(_ name: String) throws -> Data {
        try guarded {
            if has(name, .sign) { return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob(name, .sign)).publicKey.x963Representation }
            return try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob(name, .receive)).publicKey.x963Representation
        }
    }

    public func sign(_ name: String, _ message: Data) throws -> Data {
        try guarded { try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob(name, .sign)).signature(for: message).rawRepresentation } // r then s
    }

    public func open(_ name: String, _ enc: Data, _ info: Data, _ aad: Data, _ sealed: Data) throws -> Data {
        try guarded {
            // Node's order: the key's existence first, then the remote party's input, both before any blob is read.
            guard has(name, .receive) else { throw Failure.noSuchKey }
            try CryptoKitPlatform.checkEnc(enc)
            let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob(name, .receive))
            return try CryptoKitPlatform.hpkeOpen(key, enc, info, aad, sealed)
        }
    }

    /// `unlink`, then the folder is synced. A failed `unlink` is `io-failed` and the key stays; a failed
    /// sync after it is answered as success: the key may reappear after a crash.
    public func delete(_ name: String) throws {
        try guarded {
            guard valid(name) else { throw Failure.badInput }
            for use in [KeyUse.sign, .receive] where has(name, use) {
                guard unlink(file(name, use)) == 0 else { throw Failure.ioFailed }
                _ = syncFolder()
                return
            }
            throw Failure.noSuchKey
        }
    }

    public func has(_ name: String) -> Bool { has(name, .sign) || has(name, .receive) }

    private func has(_ name: String, _ use: KeyUse) -> Bool {
        valid(name) && FileManager.default.fileExists(atPath: file(name, use))
    }
}
