// Stands in for the app: loads the joined script (entry vectors.js) into JavaScriptCore, gives it
// the platform on CryptoKit, and runs every vector file of a folder but the RFC's, which is run on
// Node alone. Exits 1 on a failed case.
// Usage: run <joined script> <vectors folder>
//        run derive <ikm>   (hex: prints the private scalar CryptoKit's DeriveKeyPair gives, for Node to check against RFC 9180)
//        run accepts <scalar>   (hex: prints whether CryptoKit takes it as a P-256 private scalar)
//        run seal <recipient public key> <info> <plaintext>   (hex: prints the enc and the sealed bytes
//        CryptoKit makes, for Node to open: the other direction of the cross-engine seal check)
import Foundation
import JavaScriptCore

@main
struct Run {
    static func main() throws {
        if CommandLine.arguments[1] == "seal" {
            let a = CommandLine.arguments.dropFirst(2).map { Data(hex: $0) }
            let sealed = try CryptoKitPlatform().hpkeSeal(a[0], a[1], Data(), a[2])
            print(sealed.enc.hex, sealed.sealed.hex)
            return
        }
        if CommandLine.arguments[1] == "derive" {
            print(try CryptoKitPlatform.deriveKeyPair(Data(hex: CommandLine.arguments[2])).hex)
            return
        }
        if CommandLine.arguments[1] == "accepts" {
            print(CryptoKitPlatform.acceptsScalar(Data(hex: CommandLine.arguments[2])))
            return
        }
        let context = JSContext()!
        context.exceptionHandler = { _, error in
            print("JavaScript error: \(error?.toString() ?? "?")")
            exit(1)
        }
        context.evaluateScript(try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8))
        let bridge = Bridge(context)
        let imports = CryptoKitPlatform()
        let platform = bridge.platform(imports)
        let importKey = bridge.importKey(imports)
        let withSecret = bridge.withSecret()
        let runner = context.objectForKeyedSubscript("protocol")!
        let folder = CommandLine.arguments[2]
        var failed = 0
        var files = 0
        for name in try FileManager.default.contentsOfDirectory(atPath: folder).sorted() where name.hasSuffix(".json") && name != "hpke-rfc9180.json" {
            let text = try String(contentsOfFile: folder + "/" + name, encoding: .utf8)
            let file = context.objectForKeyedSubscript("JSON").invokeMethod("parse", withArguments: [text])!
            let names = runner.invokeMethod("runVectors", withArguments: [platform, file, importKey, withSecret])!.toArray() as! [String]
            files += 1
            for failure in names { print("FAIL \(name): \(failure)") }
            failed += names.count
        }
        print("JavaScriptCore: \(files) vector files, \(failed) failed cases")
        exit(failed == 0 && files > 0 ? 0 : 1)
    }
}

extension Data {
    init(hex: String) {
        self.init((0..<hex.count / 2).map { UInt8(hex.dropFirst($0 * 2).prefix(2), radix: 16)! })
    }
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}

/// Bytes cross as real Uint8Array values through JavaScriptCore's typed-array functions; a Result
/// is an object `{ ok, value }` or `{ ok, error }`, and a Swift error never reaches JavaScript.
struct Bridge {
    let context: JSContext

    init(_ context: JSContext) { self.context = context }

    /// A value that is not a Uint8Array is a fault: empty bytes would pass a wrong input on.
    func bytes(_ value: JSValue) throws -> Data {
        let ref = value.jsValueRef!
        let ctx = context.jsGlobalContextRef!
        guard JSValueGetTypedArrayType(ctx, ref, nil) == kJSTypedArrayTypeUint8Array else {
            throw Fault(message: "a value that is not a Uint8Array crossed the platform interface")
        }
        let length = JSObjectGetTypedArrayByteLength(ctx, ref, nil)
        guard length > 0, let pointer = JSObjectGetTypedArrayBytesPtr(ctx, ref, nil) else { return Data() }
        return Data(bytes: pointer.advanced(by: JSObjectGetTypedArrayByteOffset(ctx, ref, nil)), count: length)
    }

    func typedArray(_ data: Data) -> JSValue {
        let ctx = context.jsGlobalContextRef!
        let array = JSObjectMakeTypedArray(ctx, kJSTypedArrayTypeUint8Array, data.count, nil)!
        if let pointer = JSObjectGetTypedArrayBytesPtr(ctx, array, nil) {
            data.copyBytes(to: pointer.assumingMemoryBound(to: UInt8.self), count: data.count)
        }
        return JSValue(jsValueRef: array, in: context)
    }

    func object(_ fields: [String: Any]) -> JSValue {
        let value = JSValue(newObjectIn: context)!
        for (key, field) in fields { value.setObject(field, forKeyedSubscript: key as NSString) }
        return value
    }

    /// A fault crosses as a JavaScript exception: the caller's `try` sees it.
    func fault(_ message: String) -> JSValue {
        context.exception = JSValue(newErrorFromMessage: message, in: context)
        return JSValue(undefinedIn: context)
    }

    /// An integer argument in `range`, or a fault: `toInt32` would wrap what is out of range.
    func integer(_ value: JSValue, _ range: ClosedRange<Int>) throws -> Int {
        let number = value.toDouble()
        guard number == number.rounded(), range.contains(Int(exactly: number) ?? -1) else {
            throw Fault(message: "a number outside the interface's limits crossed the platform interface")
        }
        return Int(number)
    }

    /// For a function that returns plain bytes: any error is a fault.
    func plain(_ body: () throws -> Data) -> JSValue {
        do { return typedArray(try body()) } catch let fault as Fault { return self.fault(fault.message) }
        catch { return self.fault("\(error)") }
    }

    /// `body` answers a value, or throws a `Failure`; either becomes a Result. A `Fault` is no Result.
    func result(_ body: () throws -> Any) -> JSValue {
        do { return object(["ok": true, "value": try body()]) }
        catch let failure as Failure { return object(["ok": false, "error": failure.rawValue]) }
        catch let fault as Fault { return self.fault(fault.message) }
        catch { return object(["ok": false, "error": Failure.badInput.rawValue]) }
    }

    /// The test-only import function, handed to the runner beside the platform and not inside it.
    func importKey(_ p: CryptoKitPlatform) -> JSValue {
        let block = { (a: JSValue, b: JSValue, c: JSValue) -> JSValue in
            result { typedArray(try p.importKey(a.toString(), b.toString(), try bytes(c))) }
        } as @convention(block) (JSValue, JSValue, JSValue) -> JSValue
        return JSValue(object: block, in: context)
    }

    /// The test-only way to give a recovery its secret: a fresh platform whose person types it.
    func withSecret() -> JSValue {
        let block = { (a: JSValue) -> JSValue in
            do {
                let secret = try bytes(a)
                return platform(CryptoKitPlatform(person: RecoveryPerson(show: { _ in }, enter: { secret })))
            } catch { return fault("\(error)") }
        } as @convention(block) (JSValue) -> JSValue
        return JSValue(object: block, in: context)
    }

    func platform(_ p: CryptoKitPlatform) -> JSValue {
        let out = JSValue(newObjectIn: context)!
        func set<T>(_ name: String, _ block: T) { out.setObject(block, forKeyedSubscript: name as NSString) }
        typealias V = JSValue
        set("sha256", { (a: V) -> V in plain { p.sha256(try bytes(a)) } } as @convention(block) (V) -> V)
        set("hkdf", { (a: V, b: V, c: V) -> V in
            plain { try p.hkdf(try bytes(a), try bytes(b), try integer(c, 0...Int(Int32.max))) }
        } as @convention(block) (V, V, V) -> V)
        set("aesGcmSeal", { (a: V, b: V, c: V, d: V) -> V in
            plain { try p.aesGcmSeal(try bytes(a), try bytes(b), try bytes(c), try bytes(d)) }
        } as @convention(block) (V, V, V, V) -> V)
        set("aesGcmOpen", { (a: V, b: V, c: V, d: V) -> V in
            result { typedArray(try p.aesGcmOpen(try bytes(a), try bytes(b), try bytes(c), try bytes(d))) }
        } as @convention(block) (V, V, V, V) -> V)
        set("verify", { (a: V, b: V, c: V) -> V in
            do { return JSValue(bool: p.verify(try bytes(a), try bytes(b), try bytes(c)), in: context) }
            catch { return fault("\(error)") }
        } as @convention(block) (V, V, V) -> V)
        set("hpkeSeal", { (a: V, b: V, c: V, d: V) -> V in
            result {
                let sealed = try p.hpkeSeal(try bytes(a), try bytes(b), try bytes(c), try bytes(d))
                return object(["enc": typedArray(sealed.enc), "sealed": typedArray(sealed.sealed)])
            }
        } as @convention(block) (V, V, V, V) -> V)
        set("makeKeyPair", { (a: V, b: V) -> V in
            result { typedArray(try p.makeKeyPair(a.toString(), b.toString())) }
        } as @convention(block) (V, V) -> V)
        set("publicKey", { (a: V) -> V in result { typedArray(try p.publicKey(a.toString())) } } as @convention(block) (V) -> V)
        set("sign", { (a: V, b: V) -> V in result { typedArray(try p.sign(a.toString(), try bytes(b))) } } as @convention(block) (V, V) -> V)
        set("hpkeOpen", { (a: V, b: V, c: V, d: V, e: V) -> V in
            result { typedArray(try p.hpkeOpen(a.toString(), try bytes(b), try bytes(c), try bytes(d), try bytes(e))) }
        } as @convention(block) (V, V, V, V, V) -> V)
        set("deleteKey", { (a: V) -> V in
            result { try p.deleteKey(a.toString()); return NSNull() }
        } as @convention(block) (V) -> V)
        func recovered(_ r: (signing: Data, receiving: Data)) -> JSValue {
            object(["signing": typedArray(r.signing), "receiving": typedArray(r.receiving)])
        }
        set("createRecovery", { (a: V, b: V, c: V) -> V in
            result { recovered(try p.createRecovery(a.toString(), try bytes(b), try bytes(c))) }
        } as @convention(block) (V, V, V) -> V)
        set("enterRecovery", { (a: V, b: V, c: V) -> V in
            result { recovered(try p.enterRecovery(a.toString(), try bytes(b), try bytes(c))) }
        } as @convention(block) (V, V, V) -> V)
        set("random", { (a: V) -> V in plain { try p.random(try integer(a, 0...Int(Int32.max))) } } as @convention(block) (V) -> V)
        set("now", { () -> Double in p.now() } as @convention(block) () -> Double)
        set("utf8Encode", { (a: V) -> V in typedArray(Data(a.toString().utf8)) } as @convention(block) (V) -> V)
        set("utf8Decode", { (a: V) -> V in result { try p.utf8Decode(try bytes(a)) } } as @convention(block) (V) -> V)
        return out
    }
}
