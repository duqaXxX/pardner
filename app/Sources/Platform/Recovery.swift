import CryptoKit
import Foundation

extension CryptoKitPlatform {
    /// Whether a candidate is a private scalar of P-256 (1 to n-1): CryptoKit's own refusal of 0 and n or more.
    static func acceptsScalar(_ scalar: SecretBuffer) -> Bool {
        (try? scalar.withUnsafeBytes { try P256.KeyAgreement.PrivateKey(rawRepresentation: $0) }) != nil
    }

    /// HKDF-SHA256 with an empty salt over a secret `ikm`, into a buffer the caller wipes.
    static func hkdf(_ ikm: SecretBuffer, _ info: Data, _ length: Int) throws -> SecretBuffer {
        try checkHkdf(info, length)
        let out = SecretBuffer(count: length)
        HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm.withUnsafeBytes { SymmetricKey(data: $0) }, salt: Data(), info: info, outputByteCount: length)
            .withUnsafeBytes { out.fill($0) }
        return out
    }

    /// RFC 9180, 7.1.3: the first candidate scalar `accepts` takes, from the labeled extract and
    /// expand of DHKEM(P-256); the caller wipes it. The labeled input, the pseudorandom key and each
    /// rejected candidate are wiped here.
    static func deriveKeyPair(_ ikm: SecretBuffer, accepts: (SecretBuffer) -> Bool = acceptsScalar) throws -> SecretBuffer {
        let suite = Data("KEM".utf8) + Data([0x00, 0x10])
        let hpke = Data("HPKE-v1".utf8) + suite
        let labeled = SecretBuffer(hpke + Data("dkp_prk".utf8), ikm) // holds the input keying material
        defer { labeled.wipe() }
        var extract = HMAC<SHA256>(key: SymmetricKey(data: Data(count: 32)))
        labeled.withUnsafeBytes { extract.update(data: $0) }
        let prk = SecretBuffer(count: 32)
        defer { prk.wipe() }
        extract.finalize().withUnsafeBytes { prk.fill($0) }
        let key = prk.withUnsafeBytes { SymmetricKey(data: $0) }
        for counter in 0..<256 {
            let info = Data([0x00, 0x20]) + hpke + Data("candidate".utf8) + Data([UInt8(counter)])
            let scalar = SecretBuffer(count: 32)
            HKDF<SHA256>.expand(pseudoRandomKey: key, info: info, outputByteCount: 32).withUnsafeBytes { scalar.fill($0) }
            if accepts(scalar) { return scalar }
            scalar.wipe()
        }
        throw Fault(message: "DeriveKeyPairError")
    }

    /// Makes a recovery secret, shows it to the person and returns the two public keys; it holds no private key.
    /// A person who did not see it (`show` false) is `bad-input`.
    public func createRecovery(_ name: String, _ signInfo: Data, _ receiveInfo: Data) throws -> (signing: Data, receiving: Data) {
        guard let person else { throw Failure.badInput }
        guard signInfo != receiveInfo else { throw Failure.badInput } // RFC 9180, 9.2.3
        guard !taken(name) else { throw Failure.keyExists } // before the person is shown a secret
        let secret = SecretBuffer(count: 32)
        defer { secret.wipe() }
        try secret.withUnsafeMutableBytes { try Self.fillRandom($0) }
        let (signScalar, receiveScalar) = try scalars(secret, signInfo, receiveInfo) // before the person sees it
        defer { signScalar.wipe(); receiveScalar.wipe() }
        let keys = (
            try Derived(use: .sign, scalar: signScalar).signingKey().publicKey.x963Representation,
            try Derived(use: .receive, scalar: receiveScalar).agreementKey().publicKey.x963Representation)
        guard secret.withUnsafeBytes({ person.show($0) }) else { throw Failure.badInput }
        return keys
    }

    /// Holds the two pairs in this instance's memory under `<name>.sign` and `<name>.receive`; `deleteKey` or the end of the host removes them.
    /// A person who declines, or gives other than 32 bytes, is `bad-input`.
    public func enterRecovery(_ name: String, _ signInfo: Data, _ receiveInfo: Data) throws -> (signing: Data, receiving: Data) {
        guard signInfo != receiveInfo else { throw Failure.badInput }
        guard !taken(name) else { throw Failure.keyExists } // before the person types a secret
        let secret = SecretBuffer(count: 32)
        defer { secret.wipe() }
        guard let person, person.enter(secret) == 32 else { throw Failure.badInput }
        let (signScalar, receiveScalar) = try scalars(secret, signInfo, receiveInfo)
        var kept = false // the scalars move into `derived`, which `deleteKey` and the end of the host wipe
        defer { if !kept { signScalar.wipe(); receiveScalar.wipe() } }
        let (signing, receiving) = (Derived(use: .sign, scalar: signScalar), Derived(use: .receive, scalar: receiveScalar))
        let keys = (try signing.signingKey().publicKey.x963Representation, try receiving.agreementKey().publicKey.x963Representation)
        guard !taken(name) else { throw Failure.keyExists } // a name taken while the person typed
        derived[name + ".sign"] = signing
        derived[name + ".receive"] = receiving
        kept = true
        return keys
    }

    private var acceptance: (SecretBuffer) -> Bool {
        #if DEBUG
        accepts
        #else
        Self.acceptsScalar
        #endif
    }

    private func taken(_ name: String) -> Bool { has(name + ".sign") || has(name + ".receive") }

    /// Both scalars, or none: the first is wiped when the second cannot be made.
    private func scalars(_ secret: SecretBuffer, _ signInfo: Data, _ receiveInfo: Data) throws -> (SecretBuffer, SecretBuffer) {
        let scalar = { (info: Data) throws -> SecretBuffer in
            let ikm = try Self.hkdf(secret, info, 32)
            defer { ikm.wipe() }
            return try Self.deriveKeyPair(ikm, accepts: self.acceptance)
        }
        let first = try scalar(signInfo)
        do { return (first, try scalar(receiveInfo)) } catch { first.wipe(); throw error }
    }
}
