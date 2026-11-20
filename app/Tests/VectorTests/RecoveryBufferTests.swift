// Every buffer the recovery makes is zero when the call ends, on every path (6.2, check 6). The
// tests reach the buffers through SecretBuffer.onCreate and hold them, so a `wipe()` removed from
// the code leaves bytes that the test sees; the mutants of the pull request remove each in turn.
import CryptoKit
import Foundation
@testable import Platform
import XCTest

final class RecoveryBufferTests: XCTestCase {
    nonisolated(unsafe) var made: [SecretBuffer] = []
    let signInfo = Data([1]), receiveInfo = Data([2])

    override func setUp() {
        made = []
        SecretBuffer.onCreate = { [self] in made.append($0) }
    }

    override func tearDown() { SecretBuffer.onCreate = nil }

    func platform(_ person: RecoveryPerson) -> CryptoKitPlatform { CryptoKitPlatform(store: SoftwareKeyStore(), person: person) }

    func assertAllZero(except kept: [SecretBuffer] = [], _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(made.isEmpty, "no buffer was made", file: file, line: line)
        for (index, buffer) in made.enumerated() where !kept.contains(where: { $0 === buffer }) {
            XCTAssertTrue(buffer.isZero, "buffer \(index) of \(made.count) holds bytes \(message)", file: file, line: line)
        }
    }

    func testCreateThenEnterGiveTheSamePublicKeysAndLeaveNothing() throws {
        let shown = Box<Data>()
        let context = Box<String>()
        let creator = platform(RecoveryPerson(show: { shown.value = Data($0); context.value = $1; return true }, enter: { _ in nil }))
        let created = try creator.createRecovery("owner", signInfo, receiveInfo)
        XCTAssertNil(shown.value, "createRecovery showed the secret")
        XCTAssertEqual(creator.secrets.count, 1)
        try creator.showRecovery("owner", "id and relay")
        XCTAssertEqual(shown.value?.count, 32)
        XCTAssertEqual(context.value, "id and relay")
        assertAllZero("after showRecovery")
        XCTAssertTrue(creator.secrets.isEmpty)
        made = []
        let entered = platform(.typing(try XCTUnwrap(shown.value)))
        let keys = try entered.enterRecovery("owner", signInfo, receiveInfo)
        XCTAssertEqual(keys.signing, created.signing)
        XCTAssertEqual(keys.receiving, created.receiving)
        let held = entered.derived.values.map(\.scalar)
        XCTAssertEqual(held.count, 2)
        XCTAssertTrue(held.allSatisfy { !$0.isZero }, "the derived keys are held")
        assertAllZero(except: held, "after enterRecovery")
        try entered.deleteKey("owner.sign")
        XCTAssertTrue(held.contains { $0.isZero } && held.contains { !$0.isZero }, "deleteKey wipes the one pair")
        entered.endSession()
        XCTAssertTrue(held.allSatisfy(\.isZero), "endSession wipes what is left")
    }

    func testDeleteKeyWipesADerivedScalar() throws {
        let entered = platform(.typing(Data(count: 32)))
        _ = try entered.enterRecovery("owner", signInfo, receiveInfo)
        let held = entered.derived["owner.sign"]!.scalar
        try entered.deleteKey("owner.sign")
        XCTAssertTrue(held.isZero)
    }

    func testEndSessionWipesEveryDerivedScalar() throws {
        let entered = platform(.typing(Data(count: 32)))
        _ = try entered.enterRecovery("owner", signInfo, receiveInfo)
        let held = entered.derived.values.map(\.scalar)
        entered.endSession()
        XCTAssertTrue(held.allSatisfy(\.isZero))
        XCTAssertTrue(entered.derived.isEmpty)
    }

    func testPersonWhoDeclinesIsBadInputAndEveryBufferIsZero() {
        let entered = platform(RecoveryPerson(show: { _, _ in true }, enter: { buffer in
            buffer.withUnsafeMutableBytes { $0.copyBytes(from: [UInt8](repeating: 9, count: 32)) } // typed, then went away
            return nil
        }))
        XCTAssertThrowsError(try entered.enterRecovery("owner", signInfo, receiveInfo)) { XCTAssertEqual($0 as? Failure, .badInput) }
        assertAllZero("after a decline")
        XCTAssertTrue(entered.derived.isEmpty)
    }

    func testSecretOfTheWrongLengthIsBadInputAndEveryBufferIsZero() {
        let entered = platform(.typing(Data(repeating: 7, count: 31)))
        XCTAssertThrowsError(try entered.enterRecovery("owner", signInfo, receiveInfo)) { XCTAssertEqual($0 as? Failure, .badInput) }
        assertAllZero("after a short secret")
    }

    func testPersonWhoDidNotSeeTheSecretIsBadInputAndEveryBufferIsZero() throws {
        let creator = platform(RecoveryPerson(show: { _, _ in false }, enter: { _ in nil }))
        _ = try creator.createRecovery("owner", signInfo, receiveInfo)
        XCTAssertThrowsError(try creator.showRecovery("owner", "sheet")) { XCTAssertEqual($0 as? Failure, .badInput) }
        assertAllZero("after a secret nobody saw")
        XCTAssertTrue(creator.secrets.isEmpty)
        XCTAssertThrowsError(try creator.showRecovery("owner", "sheet")) { XCTAssertEqual($0 as? Failure, .badInput) }
    }

    func testShowRecoveryBeforeCreateOrTwiceIsBadInput() throws {
        let creator = platform(.typing(Data(count: 32)))
        XCTAssertThrowsError(try creator.showRecovery("owner", "sheet")) { XCTAssertEqual($0 as? Failure, .badInput) }
        _ = try creator.createRecovery("owner", signInfo, receiveInfo)
        XCTAssertThrowsError(try creator.createRecovery("owner", signInfo, receiveInfo)) { XCTAssertEqual($0 as? Failure, .keyExists) }
        try creator.showRecovery("owner", "sheet")
        XCTAssertThrowsError(try creator.showRecovery("owner", "sheet")) { XCTAssertEqual($0 as? Failure, .badInput) }
        _ = try creator.createRecovery("owner", signInfo, receiveInfo) // the name is free again
        creator.endSession()
    }

    func testDeleteKeyAndEndSessionWipeASecretNeverShown() throws {
        let creator = platform(.typing(Data(count: 32)))
        _ = try creator.createRecovery("owner", signInfo, receiveInfo)
        let held = try XCTUnwrap(creator.secrets["owner"])
        XCTAssertFalse(held.isZero)
        try creator.deleteKey("owner")
        XCTAssertTrue(held.isZero)
        XCTAssertThrowsError(try creator.showRecovery("owner", "sheet")) { XCTAssertEqual($0 as? Failure, .badInput) }
        _ = try creator.createRecovery("owner", signInfo, receiveInfo)
        let second = try XCTUnwrap(creator.secrets["owner"])
        creator.endSession()
        XCTAssertTrue(second.isZero)
        XCTAssertTrue(creator.secrets.isEmpty)
    }

    func testDeleteKeyOfASecretNeverShownIsOkOnAStoreThatRefusesAnAbsentName() throws {
        let store = SoftwareKeyStore()
        store.refusesAbsentDelete = true // as the Secure Enclave store: the name is not in the store
        let creator = CryptoKitPlatform(store: store, person: .typing(Data(count: 32)))
        _ = try creator.createRecovery("owner", signInfo, receiveInfo)
        let held = try XCTUnwrap(creator.secrets["owner"])
        XCTAssertNoThrow(try creator.deleteKey("owner"))
        XCTAssertTrue(held.isZero)
        XCTAssertNoThrow(try creator.deleteKey("owner")) // nothing held now: ok, as on the other engine
    }

    func testMakersRefuseANameASecretHolds() throws {
        let store = SoftwareKeyStore()
        store.refusesAbsentDelete = true
        let creator = CryptoKitPlatform(store: store, person: .typing(Data(count: 32)))
        _ = try creator.createRecovery("r", signInfo, receiveInfo)
        XCTAssertThrowsError(try creator.makeKeyPair("r", "sign")) { XCTAssertEqual($0 as? Failure, .keyExists) }
        XCTAssertNotNil(creator.secrets["r"]) // not wiped by a later deleteKey of a key that was never made
        _ = try creator.createRecovery("x.sign", signInfo, receiveInfo)
        XCTAssertThrowsError(try creator.enterRecovery("x", signInfo, receiveInfo)) { XCTAssertEqual($0 as? Failure, .keyExists) }
        creator.endSession()
    }

    func testCreateRefusesANameAKeyHoldsAsItself() throws {
        let store = SoftwareKeyStore()
        let creator = CryptoKitPlatform(store: store, person: .typing(Data(count: 32)))
        _ = try store.make("owner", .sign)
        XCTAssertThrowsError(try creator.createRecovery("owner", signInfo, receiveInfo)) { XCTAssertEqual($0 as? Failure, .keyExists) }
        XCTAssertTrue(creator.secrets.isEmpty)
        creator.derived["held"] = Derived(use: .sign, scalar: SecretBuffer(count: 32))
        XCTAssertThrowsError(try creator.createRecovery("held", signInfo, receiveInfo)) { XCTAssertEqual($0 as? Failure, .keyExists) }
        creator.endSession()
    }

    func testEnterRefusesANameWithASecretNeverShownBeforeThePersonTypes() throws {
        let asked = Box<Bool>()
        let person = RecoveryPerson(show: { _, _ in true }, enter: { _ in asked.value = true; return nil })
        let creator = platform(person)
        _ = try creator.createRecovery("owner", signInfo, receiveInfo)
        XCTAssertThrowsError(try creator.enterRecovery("owner", signInfo, receiveInfo)) { XCTAssertEqual($0 as? Failure, .keyExists) }
        XCTAssertNil(asked.value, "the person was asked")
        XCTAssertNoThrow(try creator.showRecovery("owner", "sheet")) // the secret was kept
    }

    func testWithoutAPersonCreateAndShowAreBadInput() {
        let bare = CryptoKitPlatform(store: SoftwareKeyStore())
        XCTAssertThrowsError(try bare.createRecovery("owner", signInfo, receiveInfo)) { XCTAssertEqual($0 as? Failure, .badInput) }
        XCTAssertThrowsError(try bare.showRecovery("owner", "sheet")) { XCTAssertEqual($0 as? Failure, .badInput) }
    }

    func testNameTakenWhilePersonTypedIsKeyExistsAndEveryBufferIsZero() throws {
        let store = SoftwareKeyStore()
        let entered = CryptoKitPlatform(store: store, person: RecoveryPerson(show: { _, _ in true }, enter: { buffer in
            _ = try? store.make("owner.sign", .sign) // taken while the person typed
            buffer.withUnsafeMutableBytes { $0.copyBytes(from: [UInt8](repeating: 5, count: 32)) }
            return 32
        }))
        XCTAssertThrowsError(try entered.enterRecovery("owner", signInfo, receiveInfo)) { XCTAssertEqual($0 as? Failure, .keyExists) }
        assertAllZero("after a taken name")
        XCTAssertTrue(entered.derived.isEmpty)
    }

    func testSecondScalarThatCannotBeMadeWipesTheFirstAndEveryBufferIsZero() {
        let creator = platform(.typing(Data(count: 32)))
        var accepted = 0
        creator.accepts = { _ in accepted += 1; return accepted == 1 } // the first half is made, the second never
        XCTAssertThrowsError(try creator.createRecovery("owner", signInfo, receiveInfo)) { XCTAssertTrue($0 is Fault) }
        assertAllZero("after a derivation that failed")
    }

    func testRejectedCandidatesAreWiped() throws {
        var seen = 0
        let ikm = SecretBuffer(Data(repeating: 3, count: 32))
        let scalar = try CryptoKitPlatform.deriveKeyPair(ikm, accepts: { _ in seen += 1; return seen == 3 })
        let rejected = made.filter { $0.count == 32 && $0 !== ikm && $0 !== scalar }
        XCTAssertTrue(rejected.contains { $0.isZero }, "the candidates")
        XCTAssertFalse(scalar.isZero)
        scalar.wipe()
        ikm.wipe()
        assertAllZero("after DeriveKeyPair")
    }

    // The instance hkdf's limit holds for the recovery's own derivation too, as on Node: a Fault.
    func testAnHkdfInfoOver1024BytesIsAFaultAndEveryBufferIsZero() {
        let entered = platform(.typing(Data(repeating: 1, count: 32)))
        XCTAssertThrowsError(try entered.enterRecovery("owner", Data(repeating: 1, count: 2000), receiveInfo)) { XCTAssertTrue($0 is Fault, "\($0)") }
        assertAllZero("after an info over the limit")
        XCTAssertTrue(entered.derived.isEmpty)
    }

    func testSecretBufferWipeZeroesTheWholeCapacity() {
        let buffer = SecretBuffer(Data(repeating: 0xAA, count: 40))
        XCTAssertFalse(buffer.isZero)
        buffer.wipe()
        XCTAssertTrue(buffer.isZero)
    }
}

final class Box<T>: @unchecked Sendable { var value: T? } // written on the thread of the test's call
