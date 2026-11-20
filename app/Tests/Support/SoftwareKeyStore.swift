// Test-only: the made keys in software, which a vector can make, import and drop. The app's made
// keys are the Secure Enclave's, which cannot import a key: nothing here ships in a module.
import CryptoKit
import Foundation
import Platform

final class SoftwareKeyStore: KeyStore, @unchecked Sendable { // one test thread at a time
    private var signing: [String: P256.Signing.PrivateKey] = [:]
    private var receiving: [String: P256.KeyAgreement.PrivateKey] = [:]
    /// As the Secure Enclave store does: deleting a name that holds nothing is `no-such-key`.
    var refusesAbsentDelete = false
    /// Called before a key is made or deleted: a test reads what else is on disk at that moment (the order of design 3.7).
    var onMake: ((String) -> Void)?
    var onDelete: ((String) -> Void)?
    /// Called as a public key is read: a test throws, or lets a cancel land, at a known point of a join.
    var onPublicKey: ((String) throws -> Void)?

    func make(_ name: String, _ use: KeyUse) throws -> Data {
        onMake?(name)
        switch use {
        case .sign:
            let key = P256.Signing.PrivateKey()
            signing[name] = key
            return key.publicKey.x963Representation
        case .receive:
            let key = P256.KeyAgreement.PrivateKey()
            receiving[name] = key
            return key.publicKey.x963Representation
        }
    }

    /// Outside the interface: a private key put under a name, so that a vector's seal can be opened.
    func importKey(_ name: String, _ use: String, _ privateKey: Data) throws -> Data {
        guard let use = KeyUse(rawValue: use), privateKey.count == 32 else { throw Failure.badInput }
        guard !has(name) else { throw Failure.keyExists }
        switch use {
        case .sign:
            let key = try P256.Signing.PrivateKey(rawRepresentation: privateKey)
            signing[name] = key
            return key.publicKey.x963Representation
        case .receive:
            let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
            receiving[name] = key
            return key.publicKey.x963Representation
        }
    }

    func publicKey(_ name: String) throws -> Data {
        try onPublicKey?(name)
        if let key = signing[name] { return key.publicKey.x963Representation }
        if let key = receiving[name] { return key.publicKey.x963Representation }
        throw Failure.noSuchKey
    }

    func sign(_ name: String, _ message: Data) throws -> Data {
        guard let key = signing[name] else { throw Failure.noSuchKey }
        return try key.signature(for: message).rawRepresentation // r then s
    }

    func open(_ name: String, _ enc: Data, _ info: Data, _ aad: Data, _ sealed: Data) throws -> Data {
        guard let key = receiving[name] else { throw Failure.noSuchKey }
        return try CryptoKitPlatform.hpkeOpen(key, enc, info, aad, sealed)
    }

    func delete(_ name: String) throws {
        onDelete?(name)
        if refusesAbsentDelete && !has(name) { throw Failure.noSuchKey }
        signing[name] = nil
        receiving[name] = nil
    }

    func has(_ name: String) -> Bool { signing[name] != nil || receiving[name] != nil }
}
