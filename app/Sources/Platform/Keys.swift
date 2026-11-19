// The by-name functions of the interface over both kinds of key: the derived pairs (memory of this
// instance) first, then the store. A name is never in both: the makers refuse a taken name.
import CryptoKit
import Foundation

struct Derived {
    let use: KeyUse
    let scalar: SecretBuffer

    func signingKey() throws -> P256.Signing.PrivateKey { try scalar.withUnsafeBytes { try P256.Signing.PrivateKey(rawRepresentation: $0) } }
    func agreementKey() throws -> P256.KeyAgreement.PrivateKey { try scalar.withUnsafeBytes { try P256.KeyAgreement.PrivateKey(rawRepresentation: $0) } }
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
        case .sign: return try pair.signingKey().publicKey.x963Representation
        case .receive: return try pair.agreementKey().publicKey.x963Representation
        }
    }

    /// An ECDSA signature (r then s) by the signing key `name`, or `no-such-key`.
    public func sign(_ name: String, _ message: Data) throws -> Data {
        guard let pair = derived[name] else { return try store.sign(name, message) }
        guard pair.use == .sign else { throw Failure.noSuchKey }
        return try pair.signingKey().signature(for: message).rawRepresentation // r then s
    }

    /// Opens an HPKE seal with the receiving key `name`: `no-such-key`; `bad-input` for an `enc` that is not 65 bytes
    /// or does not start with 0x04; `open-failed` for one off the curve, a failed check or a short sealed text.
    public func hpkeOpen(_ name: String, _ enc: Data, _ info: Data, _ aad: Data, _ sealed: Data) throws -> Data {
        guard let pair = derived[name] else { return try store.open(name, enc, info, aad, sealed) }
        guard pair.use == .receive else { throw Failure.noSuchKey }
        try Self.checkEnc(enc)
        return try Self.hpkeOpen(try pair.agreementKey(), enc, info, aad, sealed)
    }

    /// What a remote party sent as `enc`, checked before any key is loaded: `bad-input` for a length other
    /// than 65 or a prefix other than 0x04, `open-failed` for a well formed one off the curve (not told apart).
    public static func checkEnc(_ enc: Data) throws {
        guard enc.count == 65, enc[enc.startIndex] == 4 else { throw Failure.badInput }
        guard (try? P256.KeyAgreement.PublicKey(x963Representation: enc)) != nil else { throw Failure.openFailed }
    }

    /// The opening a store does with its own key, of any kind, after `checkEnc`. A `CryptoKitError` or an
    /// `HPKE.Errors` of the recipient or its open (a failed check, a sealed text shorter than its tag) is
    /// `open-failed`; any other error is the key's own, and goes up (the store makes it a `Fault`).
    public static func hpkeOpen(_ key: some HPKEDiffieHellmanPrivateKey, _ enc: Data, _ info: Data, _ aad: Data, _ sealed: Data) throws -> Data {
        try checkEnc(enc)
        do {
            var recipient = try HPKE.Recipient(privateKey: key, ciphersuite: suite, info: info, encapsulatedKey: enc)
            return try recipient.open(sealed, authenticating: aad)
        } catch is CryptoKitError { throw Failure.openFailed } catch is HPKE.Errors { throw Failure.openFailed }
    }

    /// Zeroes a derived pair's scalar and forgets it, or asks the store, whose failure to record the removal is `io-failed`.
    public func deleteKey(_ name: String) throws {
        if let pair = derived.removeValue(forKey: name) { pair.scalar.wipe() } else { try store.delete(name) }
    }

    /// The end of this instance's host: every derived scalar is zeroed and forgotten, so a fault
    /// between `enterRecovery` and `deleteKey` leaves no key in memory.
    public func endSession() {
        for pair in derived.values { pair.scalar.wipe() }
        derived.removeAll()
    }
}
