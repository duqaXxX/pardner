// The vector files through ProtocolHost on CryptoKit, and the checks only Swift can make.
// The joined script is built by Node (test/protocol/jsc.test.ts) and its path comes in the
// environment variable PARDNER_JOINED_SCRIPT; without it a test fails, it never passes on nothing.
import CryptoKit
import Foundation
import JavaScriptCore
@testable import Platform
import XCTest
@testable import ProtocolHost

final class Weak<T: AnyObject> { weak var value: T? }

final class VectorTests: XCTestCase {
    static let vectors = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("test/protocol/vectors")

    /// The host's own store, which importKey also fills: a vector imports a key and then uses it by name.
    let defaultStore = SoftwareKeyStore()

    func script() throws -> String {
        try XCTUnwrap(ProcessInfo.processInfo.environment["PARDNER_JOINED_SCRIPT"], "PARDNER_JOINED_SCRIPT is not set")
    }

    func makeHost(person: RecoveryPerson? = nil, store: KeyStore? = nil) async throws -> ProtocolHost {
        try await ProtocolHost(scriptPath: try script(), store: store ?? defaultStore, person: person)
    }

    /// Every vector file but the RFC's (run on Node alone): the number of files and the failed cases.
    func runVectorFiles(_ host: ProtocolHost) async throws -> (files: Int, failures: [String]) {
        let (folder, store) = (Self.vectors.path, defaultStore)
        return try await host.perform { state in
            let context = state.context!
            let bridge = Bridge(context)
            let importKey = bridge.importKey(store)
            let withSecret = bridge.withSecret()
            let runner = context.objectForKeyedSubscript("protocol")!
            var files = 0
            var failures: [String] = []
            for name in try FileManager.default.contentsOfDirectory(atPath: folder).sorted() where name.hasSuffix(".json") && name != "hpke-rfc9180.json" {
                let text = try String(contentsOfFile: folder + "/" + name, encoding: .utf8)
                let file = context.objectForKeyedSubscript("JSON").invokeMethod("parse", withArguments: [text])!
                let answer = runner.invokeMethod("runVectors", withArguments: [state.platformObject!, file, importKey, withSecret])
                // A JavaScript throw leaves no list: the host reports the recorded message.
                guard let names = answer?.toArray() as? [String] else { throw HostError.faulted(state.box.message ?? "runVectors answered no list") }
                files += 1
                failures += names.map { "\(name): \($0)" }
            }
            return (files, failures)
        }
    }

    func testEveryVectorFilePasses() async throws {
        let host = try await makeHost()
        let result = try await runVectorFiles(host)
        XCTAssertGreaterThan(result.files, 0)
        XCTAssertEqual(result.failures, [])
    }

    // DeriveKeyPair on CryptoKit gives the private key of RFC 9180's own vector (A.3, 7.1.3).
    func testDeriveKeyPairGivesRFC9180PrivateKey() throws {
        let data = try Data(contentsOf: Self.vectors.appendingPathComponent("hpke-rfc9180.json"))
        let rfc = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])["vector"] as! [String: Any]
        let derived = try CryptoKitPlatform.deriveKeyPair(SecretBuffer(hex(rfc["ikmR"] as! String)))
        XCTAssertEqual(derived.withUnsafeBytes { $0.map { String(format: "%02x", $0) }.joined() }, rfc["skRm"] as? String)
    }

    // The boundary of DeriveKeyPair's acceptance, which no ikm reaches: 0, 1, n-1, n, 2^256-1.
    func testScalarAcceptanceBoundary() {
        let n = "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"
        let nMinus1 = "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632550"
        let cases = [String(repeating: "0", count: 64), String(repeating: "0", count: 63) + "1", nMinus1, n, String(repeating: "f", count: 64)]
        XCTAssertEqual(cases.map { CryptoKitPlatform.acceptsScalar(SecretBuffer(hex($0))) }, [false, true, true, false, false])
    }

    func testJavaScriptFaultIsAnErrorAndEndsTheHost() async throws {
        let host = try await makeHost()
        do {
            try await host.perform { _ = $0.context!.evaluateScript("throw new Error('boom')") }
            XCTFail("a fault must throw")
        } catch HostError.faulted(let message) { XCTAssertTrue(message.contains("boom"), message) }
        do {
            _ = try await host.perform { _ in 1 }
            XCTFail("a faulted host must refuse every later call")
        } catch HostError.faulted {}
    }

    func testHostRefusesAHandleOfAnotherHost() async throws {
        let (first, second) = (try await makeHost(), try await makeHost())
        let handle = try await first.invoke(nil, "toString")
        do {
            _ = try await second.invoke(handle, "toString")
            XCTFail("a foreign handle must be refused")
        } catch HostError.foreignHandle {}
    }

    func testPublicInitializerFailsWithoutABundledScript() async {
        do {
            _ = try await ProtocolHost(store: SoftwareKeyStore())
            XCTFail("the test bundle holds no script")
        } catch HostError.scriptUnavailable {} catch { XCTFail("\(error)") }
    }

    func testDroppedHostReleasesContextMachineAndThread() async throws {
        let (context, machine, thread) = (Weak<JSContext>(), Weak<JSVirtualMachine>(), Weak<Thread>())
        var host: ProtocolHost? = try await makeHost()
        _ = try await runVectorFiles(host!)
        try await host!.perform { state in
            // The platform reachable from the global and called through it: a block that captured the
            // context would make a cycle through this object and keep the context alive.
            state.context!.setObject(state.platformObject, forKeyedSubscript: "platformUnderTest" as NSString)
            XCTAssertEqual(state.context!.evaluateScript("platformUnderTest.sha256(new Uint8Array(1)).length")?.toInt32(), 32)
            context.value = state.context
            machine.value = state.machine
            thread.value = Thread.current
        }
        host = nil
        for _ in 0..<100 where context.value != nil || machine.value != nil || thread.value != nil {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertNil(context.value, "the context outlived the host")
        XCTAssertNil(machine.value, "the virtual machine outlived the host")
        XCTAssertNil(thread.value, "the host thread did not end")
    }

    func testMadeKeyBlocksRecoveryUnderTheSameNameBeforeThePersonIsAsked() async throws {
        let flag = Flag()
        let host = try await makeHost(person: RecoveryPerson.typing(Data(count: 32), onAsk: { flag.value = true }))
        try await host.perform { state in
            _ = try state.platform.makeKeyPair("owner.sign", "sign")
            XCTAssertThrowsError(try state.platform.enterRecovery("owner", Data([1]), Data([2]))) { XCTAssertEqual($0 as? Failure, .keyExists) }
            XCTAssertThrowsError(try state.platform.makeKeyPair("owner.sign", "sign")) { XCTAssertEqual($0 as? Failure, .keyExists) }
        }
        XCTAssertFalse(flag.value, "the person was asked for a name already taken")
    }

    func testDerivedKeysDieWithAFaultedHostAndTheRecoveryEntersAgain() async throws {
        let secret = Data((0..<32).map { UInt8($0) })
        let person = RecoveryPerson.typing(secret)
        let store = SoftwareKeyStore()
        let first = try await makeHost(person: person, store: store)
        try await first.perform { _ = try $0.platform.enterRecovery("owner", Data([1]), Data([2])) }
        do { try await first.perform { _ = $0.context!.evaluateScript("throw new Error('boom')") } } catch HostError.faulted {}
        XCTAssertFalse(store.has("owner.sign"))
        XCTAssertTrue(first.state.platform.derived.isEmpty, "a faulted host kept a derived key")
        let second = try await makeHost(person: person, store: store)
        try await second.perform { state in
            XCTAssertThrowsError(try state.platform.publicKey("owner.sign")) { XCTAssertEqual($0 as? Failure, .noSuchKey) }
            _ = try state.platform.enterRecovery("owner", Data([1]), Data([2]))
            try state.platform.deleteKey("owner.sign")
            XCTAssertThrowsError(try state.platform.publicKey("owner.sign"))
        }
    }

    func testDerivedKeysDieWithAHostThatIsDropped() async throws {
        let person = RecoveryPerson.typing(Data(count: 32))
        var host: ProtocolHost? = try await makeHost(person: person)
        let platform = host!.state.platform
        try await host!.perform { _ = try $0.platform.enterRecovery("owner", Data([1]), Data([2])) }
        XCTAssertEqual(platform.derived.count, 2)
        host = nil
        for _ in 0..<100 where !platform.derived.isEmpty { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertTrue(platform.derived.isEmpty, "a dropped host kept a derived key")
    }

    func testRecoveryNameBlocksAMadeKeyOfTheSameName() async throws {
        let host = try await makeHost(person: RecoveryPerson.typing(Data(count: 32)))
        try await host.perform { state in
            _ = try state.platform.enterRecovery("owner", Data([1]), Data([2]))
            XCTAssertThrowsError(try state.platform.makeKeyPair("owner.sign", "sign")) { XCTAssertEqual($0 as? Failure, .keyExists) }
        }
    }

    // A handle dropped on another thread never waits for the host's JavaScript (the virtual machine's lock).
    func testHandleDroppedWhileTheHostRunsJavaScriptReturnsAtOnce() async throws {
        let host = try await makeHost()
        var handle: Handle? = try await host.invoke(nil, "toString")
        let busy = Task { try await host.perform { _ = $0.context!.evaluateScript("var t = Date.now(); while (Date.now() - t < 2000) {}") } }
        try await Task.sleep(nanoseconds: 300_000_000)
        let start = Date()
        handle = nil
        XCTAssertLessThan(Date().timeIntervalSince(start), 0.1)
        try await busy.value
        XCTAssertNil(handle)
    }

    func testHandleOutlivingItsHostKeepsNothingAlive() async throws {
        let (context, machine) = (Weak<JSContext>(), Weak<JSVirtualMachine>())
        var host: ProtocolHost? = try await makeHost()
        let handle = try await host!.invoke(nil, "toString")
        try await host!.perform { state in
            context.value = state.context
            machine.value = state.machine
        }
        host = nil
        for _ in 0..<100 where context.value != nil || machine.value != nil { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertNil(context.value, "a handle kept the context alive")
        XCTAssertNil(machine.value, "a handle kept the virtual machine alive")
        withExtendedLifetime(handle) {}
    }

    func testDeleteKeyReportsAStoreThatCouldNotRecordTheRemoval() async throws {
        final class Failing: KeyStore {
            let inner = SoftwareKeyStore()
            func make(_ name: String, _ use: KeyUse) throws -> Data { try inner.make(name, use) }
            func publicKey(_ name: String) throws -> Data { try inner.publicKey(name) }
            func sign(_ name: String, _ message: Data) throws -> Data { try inner.sign(name, message) }
            func open(_ name: String, _ enc: Data, _ info: Data, _ aad: Data, _ sealed: Data) throws -> Data { try inner.open(name, enc, info, aad, sealed) }
            func delete(_ name: String) throws { throw Failure.ioFailed }
            func has(_ name: String) -> Bool { inner.has(name) }
        }
        let host = try await makeHost(store: Failing())
        try await host.perform { state in
            _ = try state.platform.makeKeyPair("k", "sign")
            XCTAssertThrowsError(try state.platform.deleteKey("k")) { XCTAssertEqual($0 as? Failure, .ioFailed) }
            XCTAssertNoThrow(try state.platform.publicKey("k"))
        }
    }
}

final class Flag: @unchecked Sendable { var value = false } // set on the host thread, read after it answered

func hex(_ string: String) -> Data {
    Data((0..<string.count / 2).map { UInt8(string.dropFirst($0 * 2).prefix(2), radix: 16)! })
}
