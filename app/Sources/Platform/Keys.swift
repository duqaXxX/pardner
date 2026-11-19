// The by-name functions of the interface over both kinds of key: the derived pairs (memory of this
// instance) first, then the store. A name is never in both: the makers refuse a taken name.
import CryptoKit
import Foundation

struct Derived {
    let use: KeyUse
    var scalar: Data
}

extension CryptoKitPlatform {
    func has(_ name: String) -> Bool { derived[name] != nil || store.has(name) }

    /// Makes a key pair in the store under `name`: `key-exists` for a taken name, `bad-input` for a use other than sign or receive.
    public func makeKeyPair(_ name: String, _ use: String) throws -> Data {
        guard let use = KeyUse(rawValue: use) else { throw Failure.badInput } // before the name
        guard !has(name) else { throw Failure.keyExists }
        return try store.make(name, use)
    }

    /// The 65-byte public key of `name`, or `no-such-key`.
    public func publicKey(_ name: String) throws -> Data {
        guard let pair = derived[name] else { return try store.publicKey(name) }
        switch pair.use {
        case .sign: return try P256.Signing.PrivateKey(rawRepresentation: pair.scalar).publicKey.x963Representation
        case .receive: return try P256.KeyAgreement.PrivateKey(rawRepresentation: pair.scalar).publicKey.x963Representation
        }
    }

    /// An ECDSA signature (r then s) by the signing key `name`, or `no-such-key`.
    public func sign(_ name: String, _ message: Data) throws -> Data {
        guard let pair = derived[name] else { return try store.sign(name, message) }
        guard pair.use == .sign else { throw Failure.noSuchKey }
        return try P256.Signing.PrivateKey(rawRepresentation: pair.scalar).signature(for: message).rawRepresentation // r then s
    }

    /// Opens an HPKE seal with the receiving key `name`: `no-such-key`, `bad-input` for a malformed `enc`, `open-failed`.
    public func hpkeOpen(_ name: String, _ enc: Data, _ info: Data, _ aad: Data, _ sealed: Data) throws -> Data {
        guard let pair = derived[name] else { return try store.open(name, enc, info, aad, sealed) }
        guard pair.use == .receive else { throw Failure.noSuchKey }
        return try Self.hpkeOpen(try P256.KeyAgreement.PrivateKey(rawRepresentation: pair.scalar), enc, info, aad, sealed)
    }

    /// The opening a store does with its own key: the check of `enc`, then HPKE, with no word on which step failed.
    public static func hpkeOpen(_ key: P256.KeyAgreement.PrivateKey, _ enc: Data, _ info: Data, _ aad: Data, _ sealed: Data) throws -> Data {
        guard enc.count == 65, enc[enc.startIndex] == 4 else { throw Failure.badInput }
        do {
            var recipient = try HPKE.Recipient(privateKey: key, ciphersuite: suite, info: info, encapsulatedKey: enc)
            return try recipient.open(sealed, authenticating: aad)
        } catch { throw Failure.openFailed }
    }

    /// Zeroes a derived pair's scalar and forgets it, or asks the store, whose failure to record the removal is `io-failed`.
    public func deleteKey(_ name: String) throws {
        if var pair = derived.removeValue(forKey: name) { Self.wipe(&pair.scalar) } else { try store.delete(name) }
    }

    /// The end of this instance's host: every derived scalar is zeroed and forgotten, so a fault
    /// between `enterRecovery` and `deleteKey` leaves no key in memory.
    public func endSession() {
        for name in Array(derived.keys) { if var pair = derived.removeValue(forKey: name) { Self.wipe(&pair.scalar) } }
    }
}
