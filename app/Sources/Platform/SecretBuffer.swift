// Storage the platform allocates and wipes: the recovery secret and everything derived from it live
// only here (security design section 8). Never copied into a `Data`, `[UInt8]` or `String`.
// Outside this class's reach: `SymmetricKey(data:)` and CryptoKit's private key objects copy their
// input into CryptoKit's own storage, whose zeroing CryptoKit does not document; and whatever the
// person's screen does with the secret it shows or takes in; and the `HMAC` state and the `finalize()`
// value in `deriveKeyPair`, which hold the labeled input keying material and the pseudorandom key and
// which no API lets the platform wipe.
import Foundation

public final class SecretBuffer {
    public let count: Int
    private let storage: UnsafeMutableRawBufferPointer
    #if DEBUG
    /// Test-only: sees every buffer as it is made, so a test can check each is zero afterwards.
    nonisolated(unsafe) static var onCreate: ((SecretBuffer) -> Void)?
    #endif

    /// `count` zero bytes.
    public init(count: Int) {
        precondition(count > 0)
        self.count = count
        storage = .allocate(byteCount: count, alignment: 1)
        storage.initializeMemory(as: UInt8.self, repeating: 0)
        #if DEBUG
        Self.onCreate?(self)
        #endif
    }

    /// `head` followed by `tail`.
    convenience init(_ head: Data, _ tail: SecretBuffer) {
        self.init(count: head.count + tail.count)
        storage.copyBytes(from: head)
        tail.withUnsafeBytes { UnsafeMutableRawBufferPointer(rebasing: storage[head.count...]).copyBytes(from: $0) }
    }

    /// Writes `bytes` from the start; at most `count`.
    func fill(_ bytes: UnsafeRawBufferPointer) { storage.copyBytes(from: bytes.prefix(count)) }

    public func withUnsafeBytes<R>(_ body: (UnsafeRawBufferPointer) throws -> R) rethrows -> R {
        try body(UnsafeRawBufferPointer(storage))
    }

    public func withUnsafeMutableBytes<R>(_ body: (UnsafeMutableRawBufferPointer) throws -> R) rethrows -> R {
        try body(storage)
    }

    /// Zeroes the whole capacity; `memset_s`, which the compiler may not remove.
    public func wipe() { memset_s(storage.baseAddress, count, 0, count) }

    #if DEBUG
    /// Test-only: whether every byte is zero.
    var isZero: Bool { storage.allSatisfy { $0 == 0 } }
    #endif

    deinit {
        wipe()
        storage.deallocate()
    }
}
