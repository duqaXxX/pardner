// The first device's entry 0 (device pairing design 3.5, step 4), made by the package so the app never encodes an entry itself.
import Foundation

/// An entry as a device sends it: the bytes it signed, its signature and its id (`SignedEntry` of the package).
public struct SignedEntry: Sendable, Equatable {
    public let signed: Data
    public let sig: Data
    public let id: Data

    public init(signed: Data, sig: Data, id: Data) { (self.signed, self.sig, self.id) = (signed, sig, id) }
}

/// The package refused to build the entry: `reason` is the platform error it names (`bad-input`, `no-such-key`, ...).
public struct EntryRefused: Error, Equatable {
    public let reason: String
}

extension ProtocolHost {
    /// Entry 0, signed with the key the store holds as `device.sign`: `device` is this device's two public keys (kind app) and `recovery` the recovery key pair's public halves. Its id is the person id.
    public func buildGenesis(signing: Data, receiving: Data, recoverySigning: Data, recoveryReceiving: Data) async throws -> SignedEntry {
        let answer = try await callExported("buildGenesis", [
            .string("device.sign"),
            .object(["kind": .string("app"), "signing": .bytes(signing), "receiving": .bytes(receiving)]),
            .object(["signing": .bytes(recoverySigning), "receiving": .bytes(recoveryReceiving)]),
        ])
        guard case .bool(let made)? = answer["ok"] else { throw HostError.faulted("buildGenesis answered no result") }
        guard made else { throw EntryRefused(reason: answer["error"]?.stringValue ?? "unknown") }
        guard let value = answer["value"], let signed = value["signed"]?.bytesValue, let sig = value["sig"]?.bytesValue, let id = value["id"]?.bytesValue else {
            throw HostError.faulted("buildGenesis answered a malformed entry")
        }
        return SignedEntry(signed: signed, sig: sig, id: id)
    }
}
