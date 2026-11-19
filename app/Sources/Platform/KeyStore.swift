import Foundation

public enum KeyUse: String {
    case sign
    case receive
}

/// The made keys by name: private keys the platform makes and never shows. The app's store is the
/// Secure Enclave's (6.2), which cannot import a key, so this protocol has no import. A name that
/// holds no key of the asked kind is `Failure.noSuchKey`; a removal that was not recorded is
/// `Failure.ioFailed`, the key then kept.
public protocol KeyStore: AnyObject {
    /// The 65-byte public key of a new key under `name`.
    func make(_ name: String, _ use: KeyUse) throws -> Data
    /// The public key of `name`.
    func publicKey(_ name: String) throws -> Data
    /// An ECDSA signature, r then s.
    func sign(_ name: String, _ message: Data) throws -> Data
    /// The plaintext of an HPKE seal.
    func open(_ name: String, _ enc: Data, _ info: Data, _ aad: Data, _ sealed: Data) throws -> Data
    /// Zeroes and forgets `name`, or throws `io-failed` and keeps it.
    func delete(_ name: String) throws
    /// Whether `name` holds a key of either kind.
    func has(_ name: String) -> Bool
}
