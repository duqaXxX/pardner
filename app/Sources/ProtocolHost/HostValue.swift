import Foundation
import JavaScriptCore
import Platform

/// A value that crosses `ProtocolHost.call`, both ways. `bytes` is a `Uint8Array` in JavaScript.
public enum HostValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case bytes(Data)
    case array([HostValue])
    case object([String: HostValue])

    /// The field `key` of an object, or nil.
    public subscript(key: String) -> HostValue? {
        if case .object(let fields) = self { return fields[key] }
        return nil
    }

    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var numberValue: Double? { if case .number(let n) = self { return n }; return nil }
    public var bytesValue: Data? { if case .bytes(let d) = self { return d }; return nil }
    public var arrayValue: [HostValue]? { if case .array(let a) = self { return a }; return nil }
}

extension Bridge {
    func jsValue(_ value: HostValue) -> JSValue {
        switch value {
        case .null: return JSValue(nullIn: context)
        case .bool(let b): return JSValue(bool: b, in: context)
        case .number(let n): return JSValue(double: n, in: context)
        case .string(let s): return JSValue(object: s, in: context)
        case .bytes(let d): return typedArray(d)
        case .array(let items):
            let array = JSValue(newArrayIn: context)!
            for (i, item) in items.enumerated() { array.setValue(jsValue(item), at: i) }
            return array
        case .object(let fields):
            let object = JSValue(newObjectIn: context)!
            for (key, field) in fields { object.setValue(jsValue(field), forProperty: key) }
            return object
        }
    }

    /// Only null, booleans, numbers, strings, Uint8Array, arrays and plain objects cross, to a depth of 64: a Map, a Set, a Date, a Promise, another typed array, a function or a symbol is a fault, and so is a cycle.
    func hostValue(_ value: JSValue, depth: Int = 0) throws -> HostValue {
        let refused = Fault(message: "a value that cannot cross the host interface came out of JavaScript")
        guard depth <= 64 else { throw refused }
        if value.isNull || value.isUndefined { return .null }
        if value.isBoolean { return .bool(value.toBool()) }
        if value.isNumber { return .number(value.toDouble()) }
        if value.isString { return .string(value.toString()) }
        let ref = value.jsValueRef!
        let ctx = context.jsGlobalContextRef!
        if JSValueGetTypedArrayType(ctx, ref, nil) != kJSTypedArrayTypeNone { return .bytes(try bytes(value)) }
        if value.isArray {
            let count = Int(value.forProperty("length").toInt32())
            return .array(try (0..<count).map { try hostValue(value.atIndex($0), depth: depth + 1) })
        }
        guard value.isObject, let object = JSValueToObject(ctx, ref, nil), !JSObjectIsFunction(ctx, object) else { throw refused }
        let constructor = context.objectForKeyedSubscript("Object")!
        let prototype = constructor.invokeMethod("getPrototypeOf", withArguments: [value])!
        guard prototype.isNull || prototype.isEqual(to: constructor.forProperty("prototype")) else { throw refused }
        let names = JSObjectCopyPropertyNames(ctx, object)!
        defer { JSPropertyNameArrayRelease(names) }
        var fields: [String: HostValue] = [:]
        for i in 0..<JSPropertyNameArrayGetCount(names) {
            let name = JSPropertyNameArrayGetNameAtIndex(names, i)!
            let key = JSStringCopyCFString(nil, name)! as String
            fields[key] = try hostValue(value.forProperty(key), depth: depth + 1)
        }
        return .object(fields)
    }
}
