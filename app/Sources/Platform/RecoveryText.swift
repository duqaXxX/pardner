// The recovery secret's text form (device pairing design 3.8): the 32-byte secret as a 256-bit big-endian number in 52
// Crockford base32 digits, then Crockford's check symbol (the number mod 37), shown in groups of four. The digits are 260
// bits wide, so the first one is 0 or 1; a larger one is a value of 2^256 or more and is refused on entry.
// Spec: https://www.crockford.com/base32.html (Douglas Crockford, "Base 32", read 2026-11-20). Entry reads
// case-insensitively, ignores hyphens and spaces, and takes I and L for 1 and O for 0. The check symbols for 32 to 36
// are `*`, `~`, `$`, `=` and `U`; the 32 data symbols have no I, L, O or U.
// Only `SecretBuffer`s and caller-owned `UniChar` buffers hold the secret here: never a `String` (design 3.8). The
// arithmetic runs on stack integers.
import Foundation

public enum RecoveryTextError: Error, Equatable {
    case wrongLength
    case badCharacter
    case outOfRange
    case wrongCheck
}

public enum RecoveryText {
    private static let symbols = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U".utf16)
    /// Data digits, check symbol, and the characters of the shown form: 13 hyphens between 14 groups.
    public static let digitCount = 52
    public static let symbolCount = 53
    public static let displayCount = 66
    private static let size = 32

    /// The value of a symbol (0 to 36), with Crockford's reading of I, L and O, or nil. A check symbol is 32 or more.
    static func value(_ c: UniChar) -> Int? {
        var c = c
        if c >= 0x61 && c <= 0x7A { c -= 0x20 } // a-z to A-Z
        switch c {
        case 0x49, 0x4C: c = 0x31 // I, L
        case 0x4F: c = 0x30 // O
        default: break
        }
        return symbols.firstIndex(of: c)
    }

    /// The symbol for `value`, as the character `entry` and the display use.
    static func symbol(_ value: Int) -> UniChar { symbols[value] }

    private static func check(_ bytes: UnsafeRawBufferPointer) -> Int {
        bytes.reduce(0) { ($0 * 256 + Int($1)) % 37 }
    }

    /// Writes the grouped text into `out` (`displayCount` characters, which the caller wipes) from a 32-byte secret.
    public static func write(_ secret: SecretBuffer, into out: UnsafeMutableBufferPointer<UniChar>) {
        precondition(secret.count == size && out.count >= displayCount)
        secret.withUnsafeBytes { bytes in
            var shown = 0
            func put(_ symbol: UniChar) {
                if shown % 5 == 4 { out[shown] = 0x2D; shown += 1 } // a hyphen after each group of four
                out[shown] = symbol
                shown += 1
            }
            var (acc, bits) = (UInt32(0), 4) // the four zero bits that widen 256 to 260
            for byte in bytes {
                acc = (acc << 8) | UInt32(byte)
                bits += 8
                while bits >= 5 {
                    put(symbols[Int((acc >> UInt32(bits - 5)) & 31)])
                    bits -= 5
                }
                acc &= (1 << UInt32(bits)) - 1
            }
            put(symbols[check(bytes)])
        }
    }

    /// Reads `symbolCount` normalized symbols (no separators; see `RecoveryEntry`) into `secret`, which is wiped on a refusal.
    static func read(_ text: UnsafeBufferPointer<UniChar>, into secret: SecretBuffer) throws {
        precondition(secret.count == size)
        do {
            guard text.count == symbolCount else { throw RecoveryTextError.wrongLength }
            try secret.withUnsafeMutableBytes { out in
                // Each symbol is read where it is used: no array holds the digits.
                func digit(_ i: Int) throws -> Int {
                    guard let v = value(text[i]), v < 32 || i == symbolCount - 1 else { throw RecoveryTextError.badCharacter }
                    return v
                }
                let first = try digit(0)
                guard first <= 1 else { throw RecoveryTextError.outOfRange }
                var (acc, bits, written) = (UInt32(first), 1, 0)
                for i in 1..<digitCount {
                    acc = (acc << 5) | UInt32(try digit(i))
                    bits += 5
                    while bits >= 8 {
                        out[written] = UInt8((acc >> UInt32(bits - 8)) & 0xFF)
                        written += 1
                        bits -= 8
                    }
                    acc &= (1 << UInt32(bits)) - 1
                }
                guard check(UnsafeRawBufferPointer(out)) == (try digit(digitCount)) else { throw RecoveryTextError.wrongCheck }
            }
        } catch {
            secret.wipe()
            throw error
        }
    }
}

/// What the person types, one key at a time, kept in a `SecretBuffer` this object owns and wipes: no `String`. A key that
/// is no symbol of the alphabet is refused (false), a hyphen or a space is ignored, and what is kept is normalized.
public final class RecoveryEntry {
    private let keys = SecretBuffer(count: RecoveryText.symbolCount * MemoryLayout<UniChar>.size, alignment: MemoryLayout<UniChar>.alignment)
    public private(set) var count = 0

    public init() {}

    /// True when the key was taken or ignored as a separator; false for a character that cannot be part of the key or a key past its length.
    @discardableResult
    public func append(_ key: UniChar) -> Bool {
        if key == 0x2D || key == 0x20 { return true }
        guard count < RecoveryText.symbolCount, let v = RecoveryText.value(key), v < 32 || count == RecoveryText.symbolCount - 1 else { return false }
        store(RecoveryText.symbol(v), at: count)
        count += 1
        return true
    }

    /// Takes back the last key typed, zeroing its place; nothing when none is.
    public func deleteLast() {
        guard count > 0 else { return }
        count -= 1
        store(0, at: count)
    }

    /// The secret the typed text holds, in `secret` (32 bytes); throws what is wrong with it, leaving `secret` zero.
    public func read(into secret: SecretBuffer) throws {
        try keys.withUnsafeBytes { bytes in
            let symbols = bytes.bindMemory(to: UniChar.self)
            try RecoveryText.read(UnsafeBufferPointer(rebasing: symbols[0..<count]), into: secret)
        }
    }

    /// Zeroes every key typed and forgets them.
    public func wipe() {
        keys.wipe()
        count = 0
    }

    private func store(_ symbol: UniChar, at index: Int) {
        keys.withUnsafeMutableBytes { $0.storeBytes(of: symbol, toByteOffset: index * MemoryLayout<UniChar>.size, as: UniChar.self) }
    }
}
