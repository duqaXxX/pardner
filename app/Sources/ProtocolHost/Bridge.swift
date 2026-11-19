import Foundation
import JavaScriptCore
import Platform

/// Bytes cross as real Uint8Array values through JavaScriptCore's typed-array functions; a Result
/// is an object `{ ok, value }` or `{ ok, error }`, and a Swift error never reaches JavaScript.
/// A block never captures a `Bridge` or a context (a JSValue held by an exported object is a retain
/// cycle): it takes `Bridge.current()`, the context JavaScript called it from.
struct Bridge {
    let context: JSContext

    init(_ context: JSContext) { self.context = context }

    static func current() -> Bridge {
        guard let context = JSContext.current() else { fatalError("a platform block ran outside a JavaScript call") }
        return Bridge(context)
    }

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

    /// The platform object the package receives. Built once, on the host thread; its blocks reach
    /// the context only through `Bridge.current()`.
    func platform(_ p: CryptoKitPlatform) -> JSValue {
        let out = JSValue(newObjectIn: context)!
        func set<T>(_ name: String, _ block: T) { out.setObject(block, forKeyedSubscript: name as NSString) }
        typealias V = JSValue
        set("sha256", { (a: V) -> V in let b = Bridge.current(); return b.plain { p.sha256(try b.bytes(a)) } } as @convention(block) (V) -> V)
        set("hkdf", { (a: V, c: V, d: V) -> V in
            let b = Bridge.current()
            return b.plain { try p.hkdf(try b.bytes(a), try b.bytes(c), try b.integer(d, 0...Int(Int32.max))) }
        } as @convention(block) (V, V, V) -> V)
        set("aesGcmSeal", { (a: V, c: V, d: V, e: V) -> V in
            let b = Bridge.current()
            return b.plain { try p.aesGcmSeal(try b.bytes(a), try b.bytes(c), try b.bytes(d), try b.bytes(e)) }
        } as @convention(block) (V, V, V, V) -> V)
        set("aesGcmOpen", { (a: V, c: V, d: V, e: V) -> V in
            let b = Bridge.current()
            return b.result { b.typedArray(try p.aesGcmOpen(try b.bytes(a), try b.bytes(c), try b.bytes(d), try b.bytes(e))) }
        } as @convention(block) (V, V, V, V) -> V)
        set("verify", { (a: V, c: V, d: V) -> V in
            let b = Bridge.current()
            do { return JSValue(bool: p.verify(try b.bytes(a), try b.bytes(c), try b.bytes(d)), in: b.context) }
            catch { return b.fault("\(error)") }
        } as @convention(block) (V, V, V) -> V)
        set("hpkeSeal", { (a: V, c: V, d: V, e: V) -> V in
            let b = Bridge.current()
            return b.result {
                let sealed = try CryptoKitPlatform.hpkeSeal(try b.bytes(a), try b.bytes(c), try b.bytes(d), try b.bytes(e))
                return b.object(["enc": b.typedArray(sealed.enc), "sealed": b.typedArray(sealed.sealed)])
            }
        } as @convention(block) (V, V, V, V) -> V)
        set("makeKeyPair", { (a: V, c: V) -> V in
            let b = Bridge.current()
            return b.result { b.typedArray(try p.makeKeyPair(a.toString(), c.toString())) }
        } as @convention(block) (V, V) -> V)
        set("publicKey", { (a: V) -> V in
            let b = Bridge.current()
            return b.result { b.typedArray(try p.publicKey(a.toString())) }
        } as @convention(block) (V) -> V)
        set("sign", { (a: V, c: V) -> V in
            let b = Bridge.current()
            return b.result { b.typedArray(try p.sign(a.toString(), try b.bytes(c))) }
        } as @convention(block) (V, V) -> V)
        set("hpkeOpen", { (a: V, c: V, d: V, e: V, f: V) -> V in
            let b = Bridge.current()
            return b.result { b.typedArray(try p.hpkeOpen(a.toString(), try b.bytes(c), try b.bytes(d), try b.bytes(e), try b.bytes(f))) }
        } as @convention(block) (V, V, V, V, V) -> V)
        set("deleteKey", { (a: V) -> V in
            Bridge.current().result { try p.deleteKey(a.toString()); return NSNull() }
        } as @convention(block) (V) -> V)
        func recovered(_ b: Bridge, _ r: (signing: Data, receiving: Data)) -> JSValue {
            b.object(["signing": b.typedArray(r.signing), "receiving": b.typedArray(r.receiving)])
        }
        set("createRecovery", { (a: V, c: V, d: V) -> V in
            let b = Bridge.current()
            return b.result { recovered(b, try p.createRecovery(a.toString(), try b.bytes(c), try b.bytes(d))) }
        } as @convention(block) (V, V, V) -> V)
        set("enterRecovery", { (a: V, c: V, d: V) -> V in
            let b = Bridge.current()
            return b.result { recovered(b, try p.enterRecovery(a.toString(), try b.bytes(c), try b.bytes(d))) }
        } as @convention(block) (V, V, V) -> V)
        set("random", { (a: V) -> V in
            let b = Bridge.current()
            return b.plain { try p.random(try b.integer(a, 0...Int(Int32.max))) }
        } as @convention(block) (V) -> V)
        set("now", { () -> Double in p.now() } as @convention(block) () -> Double)
        set("utf8Encode", { (a: V) -> V in Bridge.current().typedArray(Data(a.toString().utf8)) } as @convention(block) (V) -> V)
        set("utf8Decode", { (a: V) -> V in
            let b = Bridge.current()
            return b.result { try p.utf8Decode(try b.bytes(a)) }
        } as @convention(block) (V) -> V)
        return out
    }
}
