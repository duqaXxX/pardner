// What the package says about a device pairing (device pairing design 3.4, 3.6, 3.7), made by the package so the app never
// reads or writes a pairing string or an entry itself.
import Foundation

/// A pasted pairing string, read (design 3.4). `device` is the device's keys as the package holds them, to hand back to `AppLink`.
public enum PairingStringRead: Sendable, Equatable {
    case read(device: HostValue, proof: Data, name: String, shortForm: String)
    /// Not hex, a cut or oversized string, or keys that do not decode.
    case notAString
    /// It reads, and its name may not travel (empty, past 64 bytes, a hidden character).
    case badName
}

/// What a kept device entry does, read from its signed bytes (design 3.6).
public struct DeviceEntryRead: Sendable, Equatable {
    public enum Kind: String, Sendable { case add, remove }
    public let kind: Kind
    public let seq: Int
    public let prev: Data
    /// The id of the device the entry names (an add) or removes.
    public let device: Data
    /// An add's device keys and proof, to build it again at a new position.
    public let keys: HostValue?
    public let proof: Data?
}

extension ProtocolHost {
    public func inspectPairingString(_ text: String) async throws -> PairingStringRead {
        let answer = try await callExported("inspectPairingString", [.string(text)])
        guard case .bool(let read)? = answer["ok"] else { throw HostError.faulted("inspectPairingString answered no result") }
        guard read else {
            switch answer["error"]?.stringValue {
            case "bad-name": return .badName
            case "not-a-string": return .notAString
            default: throw HostError.faulted("inspectPairingString refused for a reason it does not name")
            }
        }
        guard let value = answer["value"], let device = value["device"], let proof = value["proof"]?.bytesValue,
              let name = value["name"]?.stringValue, let short = value["short"]?.stringValue else {
            throw HostError.faulted("inspectPairingString answered a malformed value")
        }
        return .read(device: device, proof: proof, name: name, shortForm: short)
    }

    /// Whether `name` may travel in a pairing string: 1 to 64 bytes with no hidden character (design 3.4).
    public func nameFits(_ name: String) async throws -> Bool {
        try await callExported("checkPairingName", [.string(name)]) == .bool(true)
    }

    /// Whether `name` may be a person's: the rule kind 15 is read under, 64 characters (names design 2.1), not the pairing string's bytes.
    public func personNameFits(_ name: String) async throws -> Bool {
        try await callExported("checkPersonName", [.string(name)]) == .bool(true)
    }

    /// The proof of possession of a joining device, signed once with `device.sign` for `person` (design 3.7).
    public func makePairingProof(person: Data, device: HostValue) async throws -> Data {
        let answer = try await callExported("makePairingProof", [.string("device.sign"), .bytes(person), device])
        guard answer["ok"] == .bool(true), let proof = answer["value"]?.bytesValue else {
            throw EntryRefused(reason: answer["error"]?.stringValue ?? "unknown")
        }
        return proof
    }

    /// The pairing string a joining device shows: its keys, its proof and its name. A name that may not travel is `bad-input`.
    public func pairingString(device: HostValue, proof: Data, name: String) async throws -> String {
        let answer = try await callExported("pairingString", [device, .bytes(proof), .string(name)])
        guard answer["ok"] == .bool(true), let text = answer["value"]?.stringValue else {
            throw EntryRefused(reason: answer["error"]?.stringValue ?? "unknown")
        }
        return text
    }

    /// What a kept add or remove does; bytes that are neither are `bad-input`.
    public func readDeviceEntry(_ signed: Data) async throws -> DeviceEntryRead {
        let answer = try await callExported("readDeviceEntry", [.bytes(signed)])
        guard answer["ok"] == .bool(true), let value = answer["value"] else { throw EntryRefused(reason: answer["error"]?.stringValue ?? "unknown") }
        guard let kind = value["kind"]?.stringValue.flatMap(DeviceEntryRead.Kind.init(rawValue:)), let seq = value["seq"]?.numberValue,
              let prev = value["prev"]?.bytesValue, let device = value["device"]?.bytesValue else {
            throw HostError.faulted("readDeviceEntry answered a malformed value")
        }
        return DeviceEntryRead(kind: kind, seq: Int(seq), prev: prev, device: device, keys: value["keys"], proof: value["proof"]?.bytesValue)
    }
}
