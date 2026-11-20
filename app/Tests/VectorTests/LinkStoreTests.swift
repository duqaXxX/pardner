// The link's store (app data design, 3): what a write leaves, what a load gives back, and the cases
// where it starts again or refuses. No relay: the writes are the shapes `AppLink` hands over.
import Foundation
import ProtocolHost
@testable import Relay
import XCTest

final class LinkStoreTests: XCTestCase {
    private let identity = LinkIdentity(signing: Data(repeating: 1, count: 65), receiving: Data(repeating: 2, count: 65), relay: Data(repeating: 3, count: 65))

    private func folder() -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("pardner-store-\(UUID().uuidString)")
        addTeardownBlock {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path)
            try? FileManager.default.removeItem(at: folder)
        }
        return folder
    }

    private func id(_ n: UInt8) -> HostValue { .bytes(Data(repeating: n, count: 32)) }

    private func kept(from: Int, _ ids: [HostValue], n: Int? = nil, putBack: Bool = false) -> [String: HostValue] {
        let head: HostValue = n.map { .object(["n": .number(Double($0)), "chain": .bytes(Data(repeating: 9, count: 32)), "sig": .bytes(Data(repeating: 8, count: 64))]) } ?? .null
        return ["from": .number(Double(from)), "ids": .array(ids), "head": head, "putBack": .bool(putBack)]
    }

    private func write(_ store: LinkStore, _ kept: [String: HostValue], incarnation: Data? = nil, fault: Bool = false) throws {
        var what: [String: HostValue] = ["kept": .object(kept)]
        if let incarnation { what["incarnation"] = .bytes(incarnation) }
        if fault { what["fault"] = .bool(true) }
        try store.write(.object(what))
    }

    private func ids(_ value: HostValue?) -> [Data] { value?["ids"]?.arrayValue?.compactMap(\.bytesValue) ?? [] }

    func testNoStoreIsAFreshDevice() throws {
        XCTAssertNil(try LinkStore(folder: folder(), identity: identity).load())
    }

    func testWhatIsWrittenIsGivenBack() throws {
        let place = folder()
        var store: LinkStore? = try LinkStore(folder: place, identity: identity)
        try write(store!, kept(from: 0, []), incarnation: Data(repeating: 5, count: 16))
        try write(store!, kept(from: 0, [id(1), id(2), id(3)], n: 3))
        try write(store!, kept(from: 3, [id(4)], n: 4))
        store = nil // releases the lock, as the end of the process does
        let loaded = try XCTUnwrap(try LinkStore(folder: place, identity: identity).load())
        XCTAssertEqual(ids(loaded), [1, 2, 3, 4].map { Data(repeating: $0, count: 32) })
        XCTAssertEqual(loaded["incarnation"], .bytes(Data(repeating: 5, count: 16)))
        XCTAssertEqual(loaded["head"]?["n"], .number(4))
        XCTAssertEqual(loaded["putBack"], .bool(false))
        XCTAssertEqual(loaded["fault"], .bool(false))
    }

    func testAPutBackAndAFaultAreKept() throws {
        let place = folder()
        var store: LinkStore? = try LinkStore(folder: place, identity: identity)
        try write(store!, kept(from: 0, [id(1)], n: 1, putBack: true))
        try write(store!, kept(from: 1, [], n: 1), fault: true)
        store = nil
        let loaded = try XCTUnwrap(try LinkStore(folder: place, identity: identity).load())
        XCTAssertEqual(loaded["putBack"], .bool(true), "a put-back is never taken back by a later write")
        XCTAssertEqual(loaded["fault"], .bool(true))
    }

    func testAnotherPairingsStoreIsNotRead() throws {
        let place = folder()
        var store: LinkStore? = try LinkStore(folder: place, identity: identity)
        try write(store!, kept(from: 0, [id(1)], n: 1))
        store = nil
        let other = LinkIdentity(signing: identity.signing, receiving: identity.receiving, relay: Data(repeating: 7, count: 65))
        XCTAssertNil(try LinkStore(folder: place, identity: other).load())
    }

    func testBytesACrashLeftPastTheCountAreIgnoredThenWrittenOver() throws {
        let place = folder()
        var store: LinkStore? = try LinkStore(folder: place, identity: identity)
        try write(store!, kept(from: 0, [id(1), id(2)], n: 2))
        let handle = try FileHandle(forWritingTo: place.appendingPathComponent("link-ids"))
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(repeating: 0xEE, count: 40)) // a write whose link.json never came
        try handle.close()
        store = nil
        store = try LinkStore(folder: place, identity: identity)
        XCTAssertEqual(ids(try store!.load()).count, 2)
        try write(store!, kept(from: 2, [id(3)], n: 3))
        store = nil
        let loaded = try LinkStore(folder: place, identity: identity).load()
        XCTAssertEqual(ids(loaded), [1, 2, 3].map { Data(repeating: $0, count: 32) })
        let size = try FileManager.default.attributesOfItem(atPath: place.appendingPathComponent("link-ids").path)[.size] as? Int
        XCTAssertEqual(size, 3 * 32)
    }

    func testAShortIdsFileGivesTheIdsItHoldsAndKeepsTheRest() throws {
        let place = folder()
        var store: LinkStore? = try LinkStore(folder: place, identity: identity)
        try write(store!, kept(from: 0, [id(1), id(2), id(3)], n: 3, putBack: true))
        store = nil
        let handle = try FileHandle(forWritingTo: place.appendingPathComponent("link-ids"))
        try handle.truncate(atOffset: 32 + 10) // one whole id and part of the next
        try handle.close()
        store = try LinkStore(folder: place, identity: identity)
        let loaded = try store!.load()
        XCTAssertEqual(ids(loaded), [Data(repeating: 1, count: 32)])
        XCTAssertEqual(loaded?["putBack"], .bool(true))
        // The link writes from the count it was given: one.
        try write(store!, kept(from: 1, [id(2)], n: 2))
        XCTAssertThrowsError(try write(store!, kept(from: 3, [], n: 3)), "a write from past the stored count") {
            XCTAssertTrue($0 is LinkStoreMismatch, "no link of this store asks it: the host's fault")
        }
    }

    func testACutPastTheFilesEndIsRefused() throws {
        let place = folder()
        let store = try LinkStore(folder: place, identity: identity)
        try write(store, kept(from: 0, [id(1), id(2)], n: 2))
        let handle = try FileHandle(forWritingTo: place.appendingPathComponent("link-ids"))
        try handle.truncate(atOffset: 32) // shortened under the running store
        try handle.close()
        XCTAssertThrowsError(try write(store, kept(from: 2, [id(3)], n: 3)), "zeros would read as ids")
        let size = try FileManager.default.attributesOfItem(atPath: place.appendingPathComponent("link-ids").path)[.size] as? Int
        XCTAssertEqual(size, 32, "nothing written")
    }

    func testAFailedWriteLeavesTheLastOneWritten() throws {
        let place = folder()
        var store: LinkStore? = try LinkStore(folder: place, identity: identity)
        try write(store!, kept(from: 0, [id(1)], n: 1))
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: place.path)
        XCTAssertThrowsError(try write(store!, kept(from: 1, [id(2)], n: 2), fault: true))
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: place.path)
        store = nil
        let loaded = try LinkStore(folder: place, identity: identity).load()
        XCTAssertEqual(loaded?["fault"], .bool(false))
        XCTAssertEqual(loaded?["head"]?["n"], .number(1))
    }

    func testAStoreThatDoesNotReadIsAFreshDevice() throws {
        let place = folder()
        var store: LinkStore? = try LinkStore(folder: place, identity: identity)
        try write(store!, kept(from: 0, [id(1)], n: 1))
        store = nil
        try Data("{\"version\": 2}".utf8).write(to: place.appendingPathComponent("link.json"))
        XCTAssertNil(try LinkStore(folder: place, identity: identity).load())
    }

    func testASecondStoreOnTheSameFolderIsBusy() throws {
        let place = folder()
        var first: LinkStore? = try LinkStore(folder: place, identity: identity)
        XCTAssertThrowsError(try LinkStore(folder: place, identity: identity)) { XCTAssertTrue($0 is LinkStoreBusy) }
        XCTAssertNotNil(first)
        first = nil
        XCTAssertNoThrow(try LinkStore(folder: place, identity: identity), "the lock goes with the store")
    }

    func testTheFolderIsTheOwnersAlone() throws {
        let place = folder().appendingPathComponent("link")
        // The parent made first, as the key store makes it: the store's own folder is still 0700.
        try FileManager.default.createDirectory(at: place.deletingLastPathComponent(), withIntermediateDirectories: true)
        _ = try LinkStore(folder: place, identity: identity)
        let mode = try FileManager.default.attributesOfItem(atPath: place.path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o700)
    }

    func testAFolderOpenToOthersIsRefused() throws {
        let place = folder()
        try FileManager.default.createDirectory(at: place, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        XCTAssertThrowsError(try LinkStore(folder: place, identity: identity))
    }

    func testACountNoFileCanHoldIsAStoreThatDoesNotRead() throws {
        let place = folder()
        var store: LinkStore? = try LinkStore(folder: place, identity: identity)
        try write(store!, kept(from: 0, [id(1)], n: 1))
        store = nil
        let url = place.appendingPathComponent("link.json")
        var o = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        o["count"] = 288_230_376_151_711_744 // 2^58: times 32 overflows
        try JSONSerialization.data(withJSONObject: o).write(to: url)
        XCTAssertNil(try LinkStore(folder: place, identity: identity).load())
    }

    func testAWriteOfAnotherShapeIsAMismatch() throws {
        let store = try LinkStore(folder: folder(), identity: identity)
        XCTAssertThrowsError(try store.write(.object(["incarnation": .bytes(Data(repeating: 1, count: 16))]))) {
            XCTAssertTrue($0 is LinkStoreMismatch)
        }
    }
}

extension LinkStoreTests {
    func testAnIdsFileThatCannotBeReadNowThrowsAndCutsNothing() throws {
        let place = folder()
        var store: LinkStore? = try LinkStore(folder: place, identity: identity)
        try write(store!, kept(from: 0, [id(1), id(2)], n: 2))
        store = nil
        let ids = place.appendingPathComponent("link-ids")
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: ids.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: ids.path) }
        XCTAssertThrowsError(try LinkStore(folder: place, identity: identity).load(), "started again, the next write would cut both ids")
    }

    func testACountThatIsNoWholeNumberIsAMismatch() throws {
        let store = try LinkStore(folder: folder(), identity: identity)
        for bad in [Double.nan, .infinity, 2.5, -1, 1e300] {
            var k = kept(from: 0, [])
            k["from"] = .number(bad)
            XCTAssertThrowsError(try store.write(.object(["kept": .object(k)]))) { XCTAssertTrue($0 is LinkStoreMismatch, "\(bad)") }
        }
    }
}

extension LinkStoreTests {
    func testOneConnectionAtATimeClaimsTheStore() throws {
        let store = try LinkStore(folder: folder(), identity: identity)
        try store.claim()
        XCTAssertThrowsError(try store.claim()) { XCTAssertTrue($0 is LinkStoreBusy) }
        store.release()
        XCTAssertNoThrow(try store.claim())
    }
}
