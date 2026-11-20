// The recovery secret's text form (device pairing design 3.8). Vectors computed apart, with Python's integers:
// the secret as a big-endian number in 52 Crockford base32 digits, then the number mod 37 as the check symbol.
import Foundation
@testable import Platform
import XCTest

final class RecoveryTextTests: XCTestCase {
    private let vectors: [(hex: String, text: String)] = [
        (String(repeating: "00", count: 32), "00000000000000000000000000000000000000000000000000000"),
        (String(repeating: "ff", count: 32), "1ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZF"),
        ("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "0001081G81860W40J2GB1G6GW3RG2491650N2RBHG68T3CE1T7GZ2"),
        (String(repeating: "0123456789abcdef", count: 4), "00938NKRKAYDXW0J6HB7H6NWVVR14D2PF2DBSQQG28T5CY4TQKFFH"),
        ("80" + String(repeating: "00", count: 30) + "01", "10000000000000000000000000000000000000000000000000019"),
    ]

    private func secret(_ hex: String) -> SecretBuffer {
        let buffer = SecretBuffer(count: 32)
        buffer.withUnsafeMutableBytes { out in
            for i in 0..<32 { out[i] = UInt8(hex.dropFirst(2 * i).prefix(2), radix: 16)! }
        }
        return buffer
    }

    private func hex(_ buffer: SecretBuffer) -> String { buffer.withUnsafeBytes { $0.map { String(format: "%02x", $0) }.joined() } }

    private func shown(_ buffer: SecretBuffer) -> String {
        var out = [UniChar](repeating: 0, count: RecoveryText.displayCount)
        out.withUnsafeMutableBufferPointer { RecoveryText.write(buffer, into: $0) }
        return String(utf16CodeUnits: out, count: out.count)
    }

    private func entry(_ text: String) -> RecoveryEntry {
        let entry = RecoveryEntry()
        for key in text.utf16 { entry.append(key) }
        return entry
    }

    private func read(_ text: String) throws -> String {
        let out = SecretBuffer(count: 32)
        try entry(text).read(into: out)
        return hex(out)
    }

    func testVectorsShowInGroupsOfFour() {
        for v in vectors {
            let text = shown(secret(v.hex))
            XCTAssertEqual(text.replacingOccurrences(of: "-", with: ""), v.text)
            XCTAssertEqual(text.split(separator: "-", omittingEmptySubsequences: false).map(\.count), Array(repeating: 4, count: 13) + [1])
        }
    }

    func testVectorsReadBack() throws {
        for v in vectors { XCTAssertEqual(try read(v.text), v.hex) }
        for v in vectors { XCTAssertEqual(try read(shown(secret(v.hex))), v.hex, "the shown form reads back") }
    }

    func testEntryIgnoresCaseDashesAndSpacesAndReadsILO() throws {
        let v = vectors[2]
        XCTAssertEqual(try read(v.text.lowercased()), v.hex)
        XCTAssertEqual(try read(" " + v.text.prefix(10) + " - " + v.text.dropFirst(10)), v.hex)
        // I and L are 1, O is 0: the vector holds 0s and 1s at its start.
        XCTAssertEqual(try read("OOOIO8" + v.text.dropFirst(6)), v.hex)
        XCTAssertEqual(try read("OOOLO8" + v.text.dropFirst(6)), v.hex)
        XCTAssertEqual(try read("ooolo8" + v.text.dropFirst(6)), v.hex)
    }

    func testEveryWrongCharacterIsCaught() throws {
        let good = vectors[3].text
        let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        for i in 0..<52 {
            for c in alphabet where c != Array(good)[i] {
                var changed = Array(good)
                changed[i] = c
                XCTAssertThrowsError(try read(String(changed)), "position \(i) as \(c)")
            }
        }
    }

    func testEveryAdjacentSwapIsCaught() throws {
        for v in vectors {
            for i in 0..<51 where Array(v.text)[i] != Array(v.text)[i + 1] {
                var swapped = Array(v.text)
                swapped.swapAt(i, i + 1)
                XCTAssertThrowsError(try read(String(swapped)), "swap at \(i) of \(v.text)") { error in
                    XCTAssertTrue([.wrongCheck, .outOfRange].contains(error as? RecoveryTextError), "\(error)")
                }
            }
        }
    }

    func testRefusals() {
        let good = vectors[3].text
        func refused(_ text: String, _ error: RecoveryTextError, _ why: String) {
            XCTAssertThrowsError(try read(text), why) { XCTAssertEqual($0 as? RecoveryTextError, error, why) }
        }
        refused(String(good.dropLast()), .wrongLength, "a short text")
        refused(String(good.dropFirst()), .wrongLength, "a text without its first digit")
        refused("", .wrongLength, "nothing")
        // Replacing the check symbol alone: the next symbol of the alphabet.
        refused(String(good.dropLast()) + "G", .wrongCheck, "a wrong check symbol")
        // 2^256 is "1" then zeros past the number: first digit 2 is a value of 2^256 or more, even with its own check.
        refused("2" + good.dropFirst().dropLast() + "0", .outOfRange, "a first digit past 1")
        refused("G" + good.dropFirst(), .outOfRange, "a first digit past 1 (G)")
        let out = SecretBuffer(count: 32)
        XCTAssertThrowsError(try entry("1ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ").read(into: out), "2^256 - 1 with a wrong check")
        XCTAssertTrue(out.isZero, "a refused text leaves nothing in the buffer")
    }

    func testEveryRefusalWipesTheBufferItWasGiven() {
        let full = vectors[3].text
        for (what, text) in [("a short text", String(full.dropLast())), ("a bad character", "!" + full.dropFirst()), ("a wrong check", String(full.dropLast()) + "G")] {
            let reused = secret(String(repeating: "ab", count: 32)) // an earlier secret the caller kept
            let keys = Array(text.utf16)
            XCTAssertThrowsError(try keys.withUnsafeBufferPointer { try RecoveryText.read($0, into: reused) }, what)
            XCTAssertTrue(reused.isZero, what)
        }
    }

    func testTheTypedKeysLiveInASecretBuffer() {
        var made: [SecretBuffer] = []
        SecretBuffer.onCreate = { made.append($0) }
        defer { SecretBuffer.onCreate = nil }
        let typed = entry(vectors[3].text)
        XCTAssertEqual(made.count, 1, "the entry's keys are in one SecretBuffer")
        guard let keys = made.first else { return }
        XCTAssertFalse(keys.isZero)
        typed.wipe()
        XCTAssertTrue(keys.isZero, "wipe clears them")
        XCTAssertEqual(typed.count, 0)
    }

    func testEntryTakesOneKeyAtATimeAndRefusesWhatIsNoSymbol() {
        let e = RecoveryEntry()
        XCTAssertTrue(e.append(0x61)) // a
        XCTAssertTrue(e.append(0x2D)) // a hyphen is ignored
        XCTAssertFalse(e.append(0x55), "U is the check symbol alone, and it is not one here")
        XCTAssertFalse(e.append(0x21)) // !
        XCTAssertEqual(e.count, 1)
        e.deleteLast()
        XCTAssertEqual(e.count, 0)
        for key in vectors[1].text.utf16 { e.append(key) }
        XCTAssertEqual(e.count, 53)
        XCTAssertFalse(e.append(0x31), "no key past the length")
        e.wipe()
        XCTAssertEqual(e.count, 0)
    }

    func testCheckSymbolsAbove31() throws {
        // The check symbol runs 0 to 36: find secrets whose check is each of 32 to 36 and read them back.
        var seen = Set<UniChar>()
        var i: UInt8 = 0
        while seen.count < 5 && i < 250 {
            let s = secret(String(format: "%02x", i) + String(repeating: "00", count: 31))
            let text = shown(s).replacingOccurrences(of: "-", with: "")
            let check = text.utf16.last!
            if "*~$=U".utf16.contains(check) { seen.insert(check); XCTAssertEqual(try read(text), hex(s)) }
            i += 1
        }
        XCTAssertEqual(seen.count, 5, "every symbol from 32 to 36 was met and read back")
    }
}
