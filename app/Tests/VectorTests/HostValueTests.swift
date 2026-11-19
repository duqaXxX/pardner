// `ProtocolHost.call`: each case of HostValue through JavaScriptCore and back, on the joined script
// of PARDNER_JOINED_SCRIPT (see VectorTests).
import Foundation
import XCTest
@testable import ProtocolHost

final class HostValueTests: XCTestCase {
    /// A host whose `protocol.box()` makes an object with `echo` (the argument back) and `fail` (a throw).
    func makeBox() async throws -> (ProtocolHost, Handle) {
        let path = try XCTUnwrap(ProcessInfo.processInfo.environment["PARDNER_JOINED_SCRIPT"], "PARDNER_JOINED_SCRIPT is not set")
        let host = try await ProtocolHost(scriptPath: path, store: SoftwareKeyStore())
        try await host.perform { state in
            _ = state.context!.evaluateScript("protocol.box = function () { return { echo: function (v) { return v; }, kind: function (v) { return Object.prototype.toString.call(v); }, fail: function () { throw new Error('boom'); }, fn: function () { return function () {}; }, make: function (code) { return eval(code); } }; };")
        }
        return (host, try await host.invoke(nil, "box"))
    }

    func testEveryCaseRoundTrips() async throws {
        let (host, box) = try await makeBox()
        let cases: [HostValue] = [
            .null, .bool(true), .bool(false), .number(0), .number(-1.5), .number(4_294_967_296), .string(""), .string("héllo ✓"),
            .bytes(Data()), .bytes(Data([0, 1, 254, 255])), .array([]), .array([.number(1), .string("a"), .null]),
            .object([:]), .object(["a": .bytes(Data([9])), "b": .array([.object(["c": .bool(true)])]), "d": .null]),
        ]
        for value in cases {
            let back = try await host.call(box, "echo", [value])
            XCTAssertEqual(back, value)
        }
    }

    func testBytesCrossAsUint8Array() async throws {
        let (host, box) = try await makeBox()
        let kind = try await host.call(box, "kind", [.bytes(Data([1, 2]))])
        XCTAssertEqual(kind, .string("[object Uint8Array]"))
        let inside = try await host.call(box, "kind", [.object(["x": .bytes(Data([1]))])])
        XCTAssertEqual(inside, .string("[object Object]"))
    }

    func testAnExceptionFaultsTheHost() async throws {
        let (host, box) = try await makeBox()
        do {
            _ = try await host.call(box, "fail")
            XCTFail("an exception must fault the host")
        } catch HostError.faulted(let message) {
            XCTAssertTrue(message.contains("boom"), message)
        }
        do {
            _ = try await host.call(box, "echo", [.null])
            XCTFail("a faulted host stays faulted")
        } catch HostError.faulted {}
    }

    func testAFunctionDoesNotCross() async throws {
        let (host, box) = try await makeBox()
        do {
            _ = try await host.call(box, "fn")
            XCTFail("a function must not cross")
        } catch is HostError {
            XCTFail("a refusal to cross is no JavaScript fault")
        } catch {}
    }

    /// Each is a fault of the host: what is not data does not cross.
    func testOnlyDataCrosses() async throws {
        for code in ["new Map()", "new Set()", "new Date(0)", "Promise.resolve(1)", "new Uint16Array(2)", "new ArrayBuffer(2)", "Symbol('x')", "[new Map()]", "({ a: new Date(0) })", "(function () { var o = {}; o.o = o; return o; })()", "(function () { var a = []; a[0] = a; return a; })()"] {
            let (host, box) = try await makeBox()
            do {
                _ = try await host.call(box, "make", [.string(code)])
                XCTFail("\(code) must not cross")
            } catch {}
        }
        let (host, box) = try await makeBox()
        // A shallow plain object, a null-prototype object and a nest of 60 levels do cross.
        let plain = try await host.call(box, "make", [.string("({ a: [1, { b: new Uint8Array([7]) }] })")])
        XCTAssertEqual(plain, .object(["a": .array([.number(1), .object(["b": .bytes(Data([7]))])])]))
        let bare = try await host.call(box, "make", [.string("Object.create(null)")])
        XCTAssertEqual(bare, .object([:]))
        let nest = try await host.call(box, "make", [.string("(function () { var v = 1; for (var i = 0; i < 60; i++) v = [v]; return v; })()")])
        XCTAssertNotNil(nest.arrayValue)
        do {
            _ = try await host.call(box, "make", [.string("(function () { var v = 1; for (var i = 0; i < 70; i++) v = [v]; return v; })()")])
            XCTFail("a nest past the depth limit must fault")
        } catch {}
    }

    func testAForeignHandleIsRefused() async throws {
        let (_, box) = try await makeBox()
        let (other, _) = try await makeBox()
        do {
            _ = try await other.call(box, "echo", [.null])
            XCTFail("a handle of another host")
        } catch HostError.foreignHandle {}
    }
}
