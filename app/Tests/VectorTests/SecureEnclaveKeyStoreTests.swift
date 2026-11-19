// The Secure Enclave store over scratch folders only: nothing here touches the keychain, and no key
// needs a prompt. Skipped where the machine has no Secure Enclave.
import CryptoKit
import Foundation
@testable import Platform
import XCTest

final class SecureEnclaveKeyStoreTests: XCTestCase {
    var roots: [URL] = []

    override func setUpWithError() throws {
        try XCTSkipUnless(SecureEnclave.isAvailable, "this machine has no Secure Enclave")
    }

    override func tearDown() {
        for root in roots {
            chmod(root.appendingPathComponent("keys").path, 0o700)
            try? FileManager.default.removeItem(at: root)
        }
    }

    func scratch() -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pardner-keys-" + UUID().uuidString)
        roots.append(root)
        return root.appendingPathComponent("keys")
    }

    func store(_ folder: URL? = nil) throws -> (SecureEnclaveKeyStore, URL) {
        let folder = folder ?? scratch()
        return (try SecureEnclaveKeyStore(folder: folder), folder)
    }

    func testMakeSignVerify() throws {
        let (store, _) = try store()
        let publicKey = try store.make("device", .sign)
        let message = Data("hello".utf8)
        let signature = try store.sign("device", message)
        XCTAssertEqual(publicKey, try store.publicKey("device"))
        XCTAssertTrue(CryptoKitPlatform(store: store).verify(publicKey, message, signature))
    }

    func testSealWithCryptoKitAndOpenByName() throws {
        let (store, _) = try store()
        let publicKey = try store.make("device.main", .receive)
        let (enc, sealed) = try CryptoKitPlatform.hpkeSeal(publicKey, Data("info".utf8), Data("aad".utf8), Data("secret".utf8))
        XCTAssertEqual(try store.open("device.main", enc, Data("info".utf8), Data("aad".utf8), sealed), Data("secret".utf8))
    }

    func testWrongInfoAndOffCurveEncAreOpenFailed() throws {
        let (store, _) = try store()
        let publicKey = try store.make("device", .receive)
        let (enc, sealed) = try CryptoKitPlatform.hpkeSeal(publicKey, Data("info".utf8), Data(), Data("x".utf8))
        XCTAssertThrowsError(try store.open("device", enc, Data("other".utf8), Data(), sealed)) { XCTAssertEqual($0 as? Failure, .openFailed) }
        let offCurve = Data([4]) + Data(count: 31) + Data([1]) + Data(count: 31) + Data([1])
        XCTAssertThrowsError(try store.open("device", offCurve, Data(), Data(), sealed)) { XCTAssertEqual($0 as? Failure, .openFailed) }
    }

    func testAStoreMadeAgainOverTheSameFolderUsesTheSameKeys() throws {
        var first: SecureEnclaveKeyStore? = nil
        let folder = scratch()
        first = try store(folder).0
        let signing = try first!.make("a", .sign), receiving = try first!.make("b", .receive)
        first = nil // the app quit: the lock goes with the store
        let (second, _) = try store(folder)
        XCTAssertEqual(try second.publicKey("a"), signing)
        XCTAssertTrue(CryptoKitPlatform(store: second).verify(signing, Data("m".utf8), try second.sign("a", Data("m".utf8))))
        let (enc, sealed) = try CryptoKitPlatform.hpkeSeal(receiving, Data(), Data(), Data("x".utf8))
        XCTAssertEqual(try second.open("b", enc, Data(), Data(), sealed), Data("x".utf8))
    }

    func testAKeyOfOneUseNeverServesTheOther() throws {
        let (store, _) = try store()
        let receiving = try store.make("r", .receive)
        _ = try store.make("s", .sign)
        XCTAssertThrowsError(try store.sign("r", Data("m".utf8))) { XCTAssertEqual($0 as? Failure, .noSuchKey) }
        let (enc, sealed) = try CryptoKitPlatform.hpkeSeal(receiving, Data(), Data(), Data("x".utf8))
        XCTAssertThrowsError(try store.open("s", enc, Data(), Data(), sealed)) { XCTAssertEqual($0 as? Failure, .noSuchKey) }
        XCTAssertTrue(store.has("r") && store.has("s"))
        XCTAssertThrowsError(try store.make("r", .sign)) { XCTAssertEqual($0 as? Failure, .keyExists) }
    }

    func testADamagedBlobIsAFaultNotAValue() throws {
        let (store, folder) = try store()
        let receiving = try store.make("r", .receive)
        _ = try store.make("s", .sign)
        for (name, use) in [("s", "sign"), ("r", "receive")] {
            let path = folder.appendingPathComponent("\(name).\(use)").path
            var blob = try Data(contentsOf: URL(fileURLWithPath: path))
            blob[blob.count - 1] ^= 0xFF
            blob[blob.count / 2] ^= 0xFF
            try blob.write(to: URL(fileURLWithPath: path))
        }
        XCTAssertThrowsError(try store.sign("s", Data("m".utf8))) { XCTAssertTrue($0 is Fault, "\($0)") }
        let (enc, sealed) = try CryptoKitPlatform.hpkeSeal(receiving, Data(), Data(), Data("x".utf8))
        XCTAssertThrowsError(try store.open("r", enc, Data(), Data(), sealed)) { XCTAssertTrue($0 is Fault, "\($0)") }
    }

    func testDeleteThenTheKeyIsGone() throws {
        let (store, folder) = try store()
        _ = try store.make("k", .sign)
        try store.delete("k")
        XCTAssertThrowsError(try store.publicKey("k")) { XCTAssertEqual($0 as? Failure, .noSuchKey) }
        XCTAssertThrowsError(try store.delete("k")) { XCTAssertEqual($0 as? Failure, .noSuchKey) }
        XCTAssertFalse(store.has("k"))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), [])
    }

    func testAReadOnlyFolderMakesDeleteIoFailedAndKeepsTheKey() throws {
        let (store, folder) = try store()
        let publicKey = try store.make("k", .sign)
        chmod(folder.path, 0o500)
        XCTAssertThrowsError(try store.delete("k")) { XCTAssertEqual($0 as? Failure, .ioFailed) }
        chmod(folder.path, 0o700)
        XCTAssertEqual(try store.publicKey("k"), publicKey)
    }

    func testALeftoverTemporaryFileIsRemovedAtOpenAndNeverBlocksAMake() throws {
        let folder = scratch()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        chmod(folder.path, 0o700)
        let leftover = folder.appendingPathComponent(".tmp-deadbeef")
        try Data("x".utf8).write(to: leftover)
        let (store, _) = try store(folder)
        XCTAssertFalse(FileManager.default.fileExists(atPath: leftover.path))
        XCTAssertNoThrow(try store.make("k", .sign))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), ["k.sign"])
    }

    func testTwoFoldersNeverSeeEachOthersNames() throws {
        let (first, _) = try store(), (second, _) = try store()
        _ = try first.make("device", .sign)
        XCTAssertTrue(first.has("device"))
        XCTAssertFalse(second.has("device"))
        XCTAssertThrowsError(try second.publicKey("device")) { XCTAssertEqual($0 as? Failure, .noSuchKey) }
        XCTAssertNoThrow(try second.make("device", .sign))
    }

    func testBadNamesAreBadInputBeforeTheDisk() throws {
        let (store, folder) = try store()
        for name in ["", "A", "a/b", "../a", ".a", "a.", "a..b", "a b", "é", String(repeating: "a", count: 65), ".tmp-x"] {
            XCTAssertThrowsError(try store.make(name, .sign), name) { XCTAssertEqual($0 as? Failure, .badInput, name) }
            XCTAssertThrowsError(try store.delete(name), name) { XCTAssertEqual($0 as? Failure, .badInput, name) }
            XCTAssertFalse(store.has(name), name)
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), [])
        XCTAssertNoThrow(try store.make("a-b.c-d.e", .sign))
    }

    func testFilesAre0600AndTheFolder0700() throws {
        let (store, folder) = try store()
        _ = try store.make("k", .receive)
        func mode(_ url: URL) throws -> Int { (try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int) ?? -1 }
        XCTAssertEqual(try mode(folder), 0o700)
        XCTAssertEqual(try mode(folder.appendingPathComponent("k.receive")), 0o600)
    }

    func testASymbolicLinkOrOtherPermissionsInPlaceOfTheFolderAreRefused() throws {
        let real = scratch()
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        chmod(real.path, 0o700)
        let link = scratch()
        try FileManager.default.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        XCTAssertThrowsError(try SecureEnclaveKeyStore(folder: link)) { XCTAssertTrue($0 is Fault) }
        let open = scratch()
        try FileManager.default.createDirectory(at: open, withIntermediateDirectories: true)
        chmod(open.path, 0o755)
        XCTAssertThrowsError(try SecureEnclaveKeyStore(folder: open)) { XCTAssertTrue($0 is Fault) }
    }

    func testASecondStoreOverTheSameFolderIsRefusedAndTheFirstKeepsWorking() throws {
        let (first, folder) = try store()
        let leftover = folder.appendingPathComponent(".tmp-inflight")
        try Data("x".utf8).write(to: leftover) // another store's write in flight
        XCTAssertThrowsError(try SecureEnclaveKeyStore(folder: folder)) { XCTAssertTrue($0 is Fault) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: leftover.path), "a refused store removed a temporary file")
        XCTAssertNoThrow(try first.make("k", .sign))
    }

    func testAShortSealedTextIsOpenFailedOnTheEnclaveStore() throws {
        let (store, _) = try store()
        let publicKey = try store.make("device", .receive)
        let (enc, _) = try CryptoKitPlatform.hpkeSeal(publicKey, Data(), Data(), Data("x".utf8))
        for count in [0, 15] {
            XCTAssertThrowsError(try store.open("device", enc, Data(), Data(), Data(count: count))) { XCTAssertEqual($0 as? Failure, .openFailed, "\(count) bytes") }
        }
    }

    func testEncIsAnsweredBeforeTheBlobIsRead() throws {
        let (store, folder) = try store()
        _ = try store.make("r", .receive)
        let path = folder.appendingPathComponent("r.receive")
        try Data("not a blob".utf8).write(to: path)
        let offCurve = Data([4]) + Data(count: 31) + Data([1]) + Data(count: 31) + Data([1])
        for (enc, answer) in [(Data(count: 64), Failure.badInput), (Data([2]) + Data(count: 64), .badInput), (offCurve, .openFailed)] {
            XCTAssertThrowsError(try store.open("r", enc, Data(), Data(), Data(count: 32))) { XCTAssertEqual($0 as? Failure, answer) }
        }
    }

    // Node answers no-such-key before it looks at the enc: a name with no receiving key, or with a
    // signing key only, answers the same here whatever the enc.
    func testAMissingReceivingKeyIsNoSuchKeyWhateverTheEnc() throws {
        let (store, _) = try store()
        _ = try store.make("s", .sign)
        let offCurve = Data([4]) + Data(count: 31) + Data([1]) + Data(count: 31) + Data([1])
        for name in ["missing", "s"] {
            for enc in [Data(count: 64), offCurve] {
                XCTAssertThrowsError(try store.open(name, enc, Data(), Data(), Data(count: 32))) {
                    XCTAssertEqual($0 as? Failure, .noSuchKey, "\(name), \(enc.count) bytes")
                }
            }
        }
    }

    func testANameWhoseFileNameWouldBeTooLongIsBadInput() throws {
        let (store, _) = try store()
        let long = [String](repeating: String(repeating: "a", count: 64), count: 4).joined(separator: ".") // 259 bytes
        XCTAssertThrowsError(try store.make(long, .sign)) { XCTAssertEqual($0 as? Failure, .badInput) }
        let fits = String(repeating: "a", count: 64) + "." + String(repeating: "b", count: 64) + "." + String(repeating: "c", count: 60) // 190
        XCTAssertNoThrow(try store.make(fits, .sign))
    }

    // The write never replaces: a file that appeared after the check stays as it was.
    func testWriteOntoAnExistingNameIsKeyExistsAndLeavesTheFileAndNoTemporary() throws {
        let (store, folder) = try store()
        try store.write(Data("first".utf8), "k", .sign)
        XCTAssertThrowsError(try store.write(Data("second".utf8), "k", .sign)) { XCTAssertEqual($0 as? Failure, .keyExists) }
        XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent("k.sign")), Data("first".utf8))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), ["k.sign"])
    }

    func testTheFolderIsExcludedFromBackup() throws {
        let (_, folder) = try store()
        XCTAssertEqual(try folder.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    func testThroughThePlatformByName() throws {
        let (store, _) = try store()
        let platform = CryptoKitPlatform(store: store)
        let publicKey = try platform.makeKeyPair("device", "sign")
        XCTAssertTrue(platform.verify(publicKey, Data("m".utf8), try platform.sign("device", Data("m".utf8))))
        XCTAssertThrowsError(try platform.makeKeyPair("device", "receive")) { XCTAssertEqual($0 as? Failure, .keyExists) }
        try platform.deleteKey("device")
        XCTAssertFalse(platform.has("device"))
    }
}
