// The platform interface of the protocol package (src/protocol/platform.ts) on CryptoKit.
// Limit: this code erases what it owns (its own variables), but a `Data` shared with the person's
// screen or with the JavaScriptCore bridge is another holder's copy, and no code here can erase it.
// 6.2 solves that with storage the platform allocates and wipes, before any screen reaches recovery.
import CryptoKit
import Foundation

public enum Failure: String, Error {
    case badInput = "bad-input"
    case noSuchKey = "no-such-key"
    case keyExists = "key-exists"
    case openFailed = "open-failed"
    case ioFailed = "io-failed"
}

/// An input outside the interface's limits: it reaches JavaScript as an exception, never as data.
public struct Fault: Error {
    public let message: String
    /// A fault with the message JavaScript receives.
    public init(message: String) { self.message = message }
}

/// The person's side of the recovery secret: a screen that shows it and a prompt that takes it back.
public struct RecoveryPerson {
    public let show: (Data) -> Void
    public let enter: () -> Data
    /// A person made of a screen that shows the secret and a prompt that takes it back.
    public init(show: @escaping (Data) -> Void, enter: @escaping () -> Data) {
        self.show = show
        self.enter = enter
    }
}

/// One instance per protocol host: the derived recovery pairs (Recovery.swift) live exactly as long as it.
public final class CryptoKitPlatform {
    public static let suite = HPKE.Ciphersuite.P256_SHA256_AES_GCM_256
    let store: KeyStore
    let person: RecoveryPerson?
    /// The pairs `enterRecovery` computes, by name; only that function writes here.
    var derived: [String: Derived] = [:]

    /// A platform whose made keys are in `store` and whose recovery secret comes from `person`.
    public init(store: KeyStore, person: RecoveryPerson? = nil) {
        self.store = store
        self.person = person
    }

    /// SHA-256 of `data`: 32 bytes.
    public func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

    /// HKDF-SHA256 with an empty salt; a fault outside `info` 1,024 bytes or `length` 1 to 8,160.
    public func hkdf(_ ikm: Data, _ info: Data, _ length: Int) throws -> Data {
        guard info.count <= 1024, (1...8160).contains(length) else { throw Fault(message: "hkdf: info over 1,024 bytes, or a length outside 1 to 8,160") }
        return HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: Data(), info: info, outputByteCount: length)
            .withUnsafeBytes { Data($0) }
    }

    /// AES-256-GCM: the ciphertext with its 16-byte tag after it; a fault on a key or nonce of the wrong size.
    public func aesGcmSeal(_ key: Data, _ nonce: Data, _ aad: Data, _ plain: Data) throws -> Data {
        guard key.count == 32, nonce.count == 12 else { throw Fault(message: "aes-256-gcm: a 32-byte key and a 12-byte nonce") }
        let box = try AES.GCM.seal(plain, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce), authenticating: aad)
        return box.ciphertext + box.tag
    }

    /// Opens what `aesGcmSeal` made; `open-failed` on any failed check.
    public func aesGcmOpen(_ key: Data, _ nonce: Data, _ aad: Data, _ sealed: Data) throws -> Data {
        guard key.count == 32, nonce.count == 12 else { throw Failure.badInput }
        guard sealed.count >= 16 else { throw Failure.openFailed }
        let box = try? AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: sealed.dropLast(16), tag: sealed.suffix(16))
        guard let box, let plain = try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad) else {
            throw Failure.openFailed
        }
        return plain
    }

    /// ECDSA P-256 with SHA-256, a 65-byte public key and a 64-byte signature (r then s); false on any malformed input.
    public func verify(_ publicKey: Data, _ message: Data, _ signature: Data) -> Bool {
        guard publicKey.count == 65, signature.count == 64,
            let key = try? P256.Signing.PublicKey(x963Representation: publicKey),
            let value = try? P256.Signing.ECDSASignature(rawRepresentation: signature)
        else { return false }
        return key.isValidSignature(value, for: message)
    }

    /// Needs no key of ours, so it is static: the vector tool seals without a store.
    /// HPKE base mode, DHKEM(P-256), HKDF-SHA256, AES-256-GCM, to a 65-byte `recipient`; `bad-input` for a malformed one.
    public static func hpkeSeal(_ recipient: Data, _ info: Data, _ aad: Data, _ plain: Data) throws -> (enc: Data, sealed: Data) {
        guard recipient.count == 65, recipient[recipient.startIndex] == 4,
            let key = try? P256.KeyAgreement.PublicKey(x963Representation: recipient)
        else { throw Failure.badInput }
        var sender = try HPKE.Sender(recipientKey: key, ciphersuite: suite, info: info)
        return (sender.encapsulatedKey, try sender.seal(plain, authenticating: aad))
    }

    /// `length` bytes from the system generator.
    public func random(_ length: Int) throws -> Data {
        if length == 0 { return Data() }
        var out = Data(count: length)
        let status = out.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, length, $0.baseAddress!) }
        guard status == errSecSuccess else { throw Fault(message: "random: the system generator failed") }
        return out
    }

    /// Milliseconds since 1970-01-01 UTC.
    public func now() -> Double { (Date().timeIntervalSince1970 * 1000).rounded(.down) }

    /// The text of valid UTF-8 bytes, a leading byte order mark kept; `bad-input` otherwise.
    public func utf8Decode(_ bytes: Data) throws -> String {
        // Not String(data:encoding:), which drops a leading byte order mark: the bytes would not
        // come back from the text, and Node's decoder here keeps it.
        guard let text = String(validating: bytes, as: UTF8.self) else { throw Failure.badInput }
        return text
    }
}
