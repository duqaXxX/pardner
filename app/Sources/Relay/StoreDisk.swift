// What the app's stores share on the disk (link, pairing): a folder only its owner can use, a file written whole under
// a temporary name and renamed, and the flushes that make it last. The folders are excluded from backup, as the key
// store's is: a backup restored on another Mac would carry state bound to keys that are not there.
import Darwin
import Foundation

/// A store's disk failed, or its folder is not one a store may use: the message says which.
public struct StoreError: Error, CustomStringConvertible {
    public let description: String
}

/// Another process of the app holds the store.
public struct StoreBusy: Error, CustomStringConvertible {
    public var description: String { "another copy of Pardner is running and holds the store" }
}

/// Another connection of this process holds the store (`LinkStore.claim`).
public struct StoreClaimed: Error, CustomStringConvertible {
    public var description: String { "another connection of Pardner already uses the store" }
}

enum StoreDisk {
    /// No file at the path.
    enum Missing: Error { case file }

    /// Makes `folder` `0700` if absent (its parent too), and refuses one that is a symbolic link, belongs to another
    /// owner or has other permissions, as the key store does. Excluded from backup.
    static func prepareFolder(_ folder: URL) throws {
        try FileManager.default.createDirectory(at: folder.deletingLastPathComponent(), withIntermediateDirectories: true)
        if mkdir(folder.path, 0o700) != 0 && Darwin.errno != EEXIST { throw errno("create the store's folder") }
        var info = stat()
        guard lstat(folder.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
            throw StoreError(description: "the store's folder is a link, belongs to another owner or has permissions other than 0700")
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = folder
        try url.setResourceValues(values)
    }

    /// Prepares `folder` and takes its `lock` file for the life of the descriptor returned; `StoreBusy` when another
    /// process holds it. Closing the descriptor releases the lock.
    static func lock(_ folder: URL) throws -> Int32 {
        try prepareFolder(folder)
        let fd = open(folder.appendingPathComponent("lock").path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw errno("open the store's lock") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd)
            throw StoreBusy()
        }
        return fd
    }

    /// At most `length` bytes of the file; `Missing.file` when there is none, any other failure as itself.
    static func read(_ path: String, upTo length: Int = Int.max) throws -> Data {
        let fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        if fd < 0 && Darwin.errno == ENOENT { throw Missing.file }
        guard fd >= 0 else { throw errno("open \((path as NSString).lastPathComponent)") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        return try handle.read(upToCount: length) ?? Data()
    }

    /// `data` as the whole file at `path`, under `<path>.tmp`, flushed and renamed; the caller flushes the folder.
    static func replace(_ path: String, with data: Data) throws {
        let temporary = path + ".tmp"
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
        guard rename(temporary, path) == 0 else {
            let failure = errno("rename the store")
            unlink(temporary)
            throw failure
        }
    }

    /// The folder's entries to the disk, as the key store flushes its own (`F_FULLFSYNC` on the folder).
    static func syncFolder(_ folder: URL) throws {
        let dir = open(folder.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard dir >= 0 else { throw errno("open the store's folder") }
        defer { close(dir) }
        try flush(dir)
    }

    static func writeAll(_ fd: Int32, _ data: Data) throws {
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
    static func flush(_ fd: Int32) throws {
        if fcntl(fd, F_FULLFSYNC) == 0 { return }
        guard fsync(fd) == 0 else { throw errno("flush") }
    }

    static func errno(_ what: String) -> StoreError {
        StoreError(description: "\(what): \(String(cString: strerror(Darwin.errno)))")
    }

    static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    /// Lowercase hexadecimal text as bytes, or nil.
    static func hex(_ value: Any?) -> Data? {
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
}
