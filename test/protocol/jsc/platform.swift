// The platform interface of the protocol package (src/protocol/platform.ts) on CryptoKit, with its
// keys in software: the Secure Enclave is the app's, and a vector needs keys it can make and drop.
// Limit: this harness erases what it owns (its own variables), but a `Data` shared with the
// person's screen or with the JavaScriptCore bridge is another holder's copy, and no code here can
// erase it. The app solves that with storage it owns and wipes (a buffer it allocates, not a `Data`).
// Meant to move into the app's platform module. The person of the recovery secret is a stub here.
import CryptoKit
import Foundation

enum Failure: String, Error {
    case badInput = "bad-input"
    case noSuchKey = "no-such-key"
    case keyExists = "key-exists"
    case openFailed = "open-failed"
    case ioFailed = "io-failed"
}

/// The person's side of the recovery secret: a screen that shows it and a prompt that takes it back.
struct RecoveryPerson {
    let show: (Data) -> Void
    let enter: () -> Data
}

/// An input outside the interface's limits: it reaches JavaScript as an exception, never as data.
struct Fault: Error {
    let message: String
}

final class CryptoKitPlatform {
    private static let suite = HPKE.Ciphersuite.P256_SHA256_AES_GCM_256
    private var signing: [String: P256.Signing.PrivateKey] = [:]
    private var receiving: [String: P256.KeyAgreement.PrivateKey] = [:]
    private var secrets: [String: Data] = [:]
    private let person: RecoveryPerson?

    init(person: RecoveryPerson? = nil) { self.person = person }

    func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

    func hkdf(_ ikm: Data, _ info: Data, _ length: Int) throws -> Data {
        guard info.count <= 1024, (1...8160).contains(length) else { throw Fault(message: "hkdf: info over 1,024 bytes, or a length outside 1 to 8,160") }
        return HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: Data(), info: info, outputByteCount: length)
            .withUnsafeBytes { Data($0) }
    }

    func aesGcmSeal(_ key: Data, _ nonce: Data, _ aad: Data, _ plain: Data) throws -> Data {
        guard key.count == 32, nonce.count == 12 else { throw Fault(message: "aes-256-gcm: a 32-byte key and a 12-byte nonce") }
        let box = try AES.GCM.seal(plain, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce), authenticating: aad)
        return box.ciphertext + box.tag
    }

    func aesGcmOpen(_ key: Data, _ nonce: Data, _ aad: Data, _ sealed: Data) throws -> Data {
        guard key.count == 32, nonce.count == 12 else { throw Failure.badInput }
        guard sealed.count >= 16 else { throw Failure.openFailed }
        let box = try? AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: sealed.dropLast(16), tag: sealed.suffix(16))
        guard let box, let plain = try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad) else {
            throw Failure.openFailed
        }
        return plain
    }

    func verify(_ publicKey: Data, _ message: Data, _ signature: Data) -> Bool {
        guard publicKey.count == 65, signature.count == 64,
            let key = try? P256.Signing.PublicKey(x963Representation: publicKey),
            let value = try? P256.Signing.ECDSASignature(rawRepresentation: signature)
        else { return false }
        return key.isValidSignature(value, for: message)
    }

    func hpkeSeal(_ recipient: Data, _ info: Data, _ aad: Data, _ plain: Data) throws -> (enc: Data, sealed: Data) {
        guard recipient.count == 65, recipient[recipient.startIndex] == 4,
            let key = try? P256.KeyAgreement.PublicKey(x963Representation: recipient)
        else { throw Failure.badInput }
        var sender = try HPKE.Sender(recipientKey: key, ciphersuite: Self.suite, info: info)
        return (sender.encapsulatedKey, try sender.seal(plain, authenticating: aad))
    }

    func makeKeyPair(_ name: String, _ use: String) throws -> Data {
        guard use == "sign" || use == "receive" else { throw Failure.badInput } // before the name
        guard signing[name] == nil, receiving[name] == nil else { throw Failure.keyExists }
        if use == "sign" {
            let key = P256.Signing.PrivateKey()
            signing[name] = key
            return key.publicKey.x963Representation
        }
        let key = P256.KeyAgreement.PrivateKey()
        receiving[name] = key
        return key.publicKey.x963Representation
    }

    /// The test-only constructor of design 3.3, outside the interface: a private key put under a
    /// name, so that a vector's seal can be opened. The app's platform has no such function.
    func importKey(_ name: String, _ use: String, _ privateKey: Data) throws -> Data {
        guard use == "sign" || use == "receive", privateKey.count == 32 else { throw Failure.badInput }
        guard signing[name] == nil, receiving[name] == nil else { throw Failure.keyExists }
        if use == "sign" {
            let key = try P256.Signing.PrivateKey(rawRepresentation: privateKey)
            signing[name] = key
            return key.publicKey.x963Representation
        }
        let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
        receiving[name] = key
        return key.publicKey.x963Representation
    }

    func publicKey(_ name: String) throws -> Data {
        if let key = signing[name] { return key.publicKey.x963Representation }
        if let key = receiving[name] { return key.publicKey.x963Representation }
        throw Failure.noSuchKey
    }

    func sign(_ name: String, _ message: Data) throws -> Data {
        guard let key = signing[name] else { throw Failure.noSuchKey }
        return try key.signature(for: message).rawRepresentation // r then s
    }

    func hpkeOpen(_ name: String, _ enc: Data, _ info: Data, _ aad: Data, _ sealed: Data) throws -> Data {
        guard let key = receiving[name] else { throw Failure.noSuchKey }
        guard enc.count == 65, enc[enc.startIndex] == 4 else { throw Failure.badInput }
        do {
            var recipient = try HPKE.Recipient(privateKey: key, ciphersuite: Self.suite, info: info, encapsulatedKey: enc)
            return try recipient.open(sealed, authenticating: aad)
        } catch { throw Failure.openFailed } // no more is said of which check failed
    }

    /// Keys live in memory here, so nothing can fail to be recorded: it answers like the interface's `Result<void>`.
    func deleteKey(_ name: String) throws {
        signing[name] = nil
        receiving[name] = nil
    }

    /// Whether a candidate is a private scalar of P-256 (1 to n-1): CryptoKit's own refusal of 0 and n or more.
    static func acceptsScalar(_ scalar: Data) -> Bool {
        (try? P256.KeyAgreement.PrivateKey(rawRepresentation: scalar)) != nil
    }

    /// Zeroes what this variable owns; a copy Swift shares with another holder is that holder's to erase.
    private static func wipe(_ data: inout Data) { data.resetBytes(in: 0..<data.count) }

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

    func createRecovery(_ name: String, _ signInfo: Data, _ receiveInfo: Data) throws -> (signing: Data, receiving: Data) {
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
        var shown = secret
        defer { Self.wipe(&shown) }
        person.show(shown)
        return keys
    }

    func enterRecovery(_ name: String, _ signInfo: Data, _ receiveInfo: Data) throws -> (signing: Data, receiving: Data) {
        guard signInfo != receiveInfo else { throw Failure.badInput }
        guard !taken(name) else { throw Failure.keyExists } // before the person types a secret
        var secret = person?.enter() ?? Data()
        defer { Self.wipe(&secret) }
        guard secret.count == 32 else { throw Failure.badInput }
        var (signScalar, receiveScalar) = try scalars(secret, signInfo, receiveInfo)
        defer { Self.wipe(&signScalar); Self.wipe(&receiveScalar) }
        let signKey = try P256.Signing.PrivateKey(rawRepresentation: signScalar)
        let receiveKey = try P256.KeyAgreement.PrivateKey(rawRepresentation: receiveScalar)
        guard !taken(name) else { throw Failure.keyExists } // a name taken while the person typed
        signing[name + ".sign"] = signKey
        receiving[name + ".receive"] = receiveKey
        return (signKey.publicKey.x963Representation, receiveKey.publicKey.x963Representation)
    }

    private func taken(_ name: String) -> Bool {
        [name + ".sign", name + ".receive"].contains { signing[$0] != nil || receiving[$0] != nil }
    }

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

    func random(_ length: Int) throws -> Data {
        if length == 0 { return Data() }
        var out = Data(count: length)
        let status = out.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, length, $0.baseAddress!) }
        guard status == errSecSuccess else { throw Fault(message: "random: the system generator failed") }
        return out
    }

    func now() -> Double { (Date().timeIntervalSince1970 * 1000).rounded(.down) }

    func utf8Decode(_ bytes: Data) throws -> String {
        // Not String(data:encoding:), which drops a leading byte order mark: the bytes would not
        // come back from the text, and Node's decoder here keeps it.
        guard let text = String(validating: bytes, as: UTF8.self) else { throw Failure.badInput }
        return text
    }
}
