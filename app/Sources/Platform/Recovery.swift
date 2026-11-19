import CryptoKit
import Foundation

extension CryptoKitPlatform {
    /// Whether a candidate is a private scalar of P-256 (1 to n-1): CryptoKit's own refusal of 0 and n or more.
    static func acceptsScalar(_ scalar: Data) -> Bool {
        (try? P256.KeyAgreement.PrivateKey(rawRepresentation: scalar)) != nil
    }

    /// Zeroes what this variable owns; a copy Swift shares with another holder is that holder's to erase.
    static func wipe(_ data: inout Data) { data.resetBytes(in: 0..<data.count) }

    /// RFC 9180, 7.1.3: the first candidate scalar the curve accepts, from the labeled extract and
    /// expand of DHKEM(P-256). The pseudorandom key and each rejected candidate are erased.
    static func deriveKeyPair(_ ikm: Data) throws -> Data {
        let suite = Data("KEM".utf8) + Data([0x00, 0x10])
        let hpke = Data("HPKE-v1".utf8) + suite
        var labeled = hpke + Data("dkp_prk".utf8) + ikm // holds the input keying material
        defer { wipe(&labeled) }
        var prk = Data(HMAC<SHA256>.authenticationCode(
            for: labeled, using: SymmetricKey(data: Data(count: 32))))
        defer { wipe(&prk) }
        for counter in 0..<256 {
            let info = Data([0x00, 0x20]) + hpke + Data("candidate".utf8) + Data([UInt8(counter)])
            var scalar = HKDF<SHA256>.expand(pseudoRandomKey: prk, info: info, outputByteCount: 32)
                .withUnsafeBytes { Data($0) }
            if acceptsScalar(scalar) { return scalar }
            wipe(&scalar)
        }
        throw Fault(message: "DeriveKeyPairError")
    }

    /// Makes a recovery secret, shows it to the person and returns the two public keys; it holds no private key.
    public func createRecovery(_ name: String, _ signInfo: Data, _ receiveInfo: Data) throws -> (signing: Data, receiving: Data) {
        guard let person else { throw Failure.badInput }
        guard signInfo != receiveInfo else { throw Failure.badInput } // RFC 9180, 9.2.3
        guard !taken(name) else { throw Failure.keyExists } // before the person is shown a secret
        var secret = try random(32)
        defer { Self.wipe(&secret) }
        var (signScalar, receiveScalar) = try scalars(secret, signInfo, receiveInfo) // before the person sees it
        defer { Self.wipe(&signScalar); Self.wipe(&receiveScalar) }
        let keys = (
            try P256.Signing.PrivateKey(rawRepresentation: signScalar).publicKey.x963Representation,
            try P256.KeyAgreement.PrivateKey(rawRepresentation: receiveScalar).publicKey.x963Representation)
        person.show(secret) // no extra copy: the one `secret` is wiped by the defer above
        return keys
    }

    /// Holds the two pairs in this instance's memory under `<name>.sign` and `<name>.receive`; `deleteKey` or the end of the host removes them.
    public func enterRecovery(_ name: String, _ signInfo: Data, _ receiveInfo: Data) throws -> (signing: Data, receiving: Data) {
        guard signInfo != receiveInfo else { throw Failure.badInput }
        guard !taken(name) else { throw Failure.keyExists } // before the person types a secret
        var secret = person?.enter() ?? Data()
        defer { Self.wipe(&secret) }
        guard secret.count == 32 else { throw Failure.badInput }
        var (signScalar, receiveScalar) = try scalars(secret, signInfo, receiveInfo)
        defer { Self.wipe(&signScalar); Self.wipe(&receiveScalar) }
        let keys = (
            try P256.Signing.PrivateKey(rawRepresentation: signScalar).publicKey.x963Representation,
            try P256.KeyAgreement.PrivateKey(rawRepresentation: receiveScalar).publicKey.x963Representation)
        guard !taken(name) else { throw Failure.keyExists } // a name taken while the person typed
        // The stored copy is the one `deleteKey` wipes; the local one is wiped by the defer above.
        derived[name + ".sign"] = Derived(use: .sign, scalar: Data(signScalar))
        derived[name + ".receive"] = Derived(use: .receive, scalar: Data(receiveScalar))
        return keys
    }

    private func taken(_ name: String) -> Bool { has(name + ".sign") || has(name + ".receive") }

    /// Both scalars, or none: the first is erased when the second cannot be made.
    private func scalars(_ secret: Data, _ signInfo: Data, _ receiveInfo: Data) throws -> (Data, Data) {
        let scalar = { (info: Data) throws -> Data in
            var ikm = try self.hkdf(secret, info, 32)
            defer { Self.wipe(&ikm) }
            return try Self.deriveKeyPair(ikm)
        }
        var first = try scalar(signInfo)
        do { return (first, try scalar(receiveInfo)) } catch { Self.wipe(&first); throw error }
    }
}
