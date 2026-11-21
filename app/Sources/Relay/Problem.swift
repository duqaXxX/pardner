// What went wrong, in words a person reads: every error a screen can show goes through here, so that no screen shows a case name, a
// raw `String(describing:)` or a bridged "The operation couldn't be completed" alone. A screen builds its sentence around the reason:
// what failed, this reason, and the next step.
import Foundation
import Network
import Platform
import ProtocolHost

public enum Problem {
    /// "`failed`: the reason. `next`", where an error that only one step helps gives that step in place of `next`.
    public static func sentence(_ failed: String, _ error: Error, next: String) -> String {
        "\(failed): \(reason(error)). \(ownStep(error) ?? next)"
    }

    private static func ownStep(_ error: Error) -> String? {
        switch error {
        case HostError.scriptUnavailable: "Install Pardner again from a complete build."
        case is StoreBusy: "Quit the other copy of Pardner, then open this one again."
        default: nil
        }
    }

    /// The reason an act failed, as a clause with no capital and no full stop, to follow "Pardner could not …: ".
    public static func reason(_ error: Error) -> String {
        switch error {
        case HostError.scriptUnavailable: "this copy of Pardner lacks its protocol script, so it is incomplete"
        case HostError.faulted(let what): "Pardner's protocol code stopped (\(what))"
        case HostError.foreignHandle: "Pardner's protocol code was handed a key of another session"
        case let failure as Failure: words(failure)
        case let fault as Fault: fault.message
        case let refused as EntryRefused: "the protocol code refused to sign the entry (\(Failure(rawValue: refused.reason).map(words) ?? refused.reason))"
        case let refused as RecoveryRefused: "the recovery key could not be used (\(Failure(rawValue: refused.reason).map(words) ?? refused.reason))"
        case RelayError.invalidItem: "a message was too large or malformed for the relay"
        case let error as NWError: words(error)
        case let text as RecoveryTextError: words(text)
        case let posix as POSIXError: trimmed(String(cString: strerror(posix.code.rawValue)))
        case let localized as LocalizedError where !isCocoa(error) && localized.errorDescription != nil: trimmed(localized.errorDescription ?? "")
        // An NSError made as one (not a Swift error bridged to it) prints as a dump: its own sentence, or its domain and code.
        case _ where type(of: error) is NSError.Type || isCocoa(error): system(error)
        case let described as CustomStringConvertible: trimmed(described.description)
        default: "an unexpected error (\(type(of: error)))"
        }
    }

    private static func words(_ failure: Failure) -> String {
        switch failure {
        case .badInput: "the system's cryptography refused a value"
        case .noSuchKey: "a key this Mac needs is missing"
        case .keyExists: "a key of that name already exists on this Mac"
        case .openFailed: "a sealed value did not open"
        case .ioFailed: "the disk could not be read or written"
        }
    }

    private static func words(_ error: RecoveryTextError) -> String {
        switch error {
        case .wrongLength: "the recovery key has the wrong number of characters"
        case .badCharacter: "the recovery key holds a character it never uses"
        case .outOfRange, .wrongCheck: "the recovery key does not check out: a character is mistyped"
        }
    }

    private static func words(_ error: NWError) -> String {
        switch error {
        case .posix(let code): "the connection failed (\(trimmed(String(cString: strerror(code.rawValue))).lowercased()))"
        case .dns: "the relay's address could not be found"
        case .tls(let status): "the secure connection to the relay failed (TLS status \(status))"
        default: "the connection failed"
        }
    }

    /// The sentence a system error carries, when it has one of its own; else its domain and code.
    private static func system(_ error: Error) -> String {
        let ns = error as NSError
        let text = ns.localizedFailureReason ?? ns.userInfo[NSLocalizedDescriptionKey] as? String
        return text.map(trimmed) ?? "a system error (\(ns.domain) \(ns.code))"
    }

    /// An error of the system's own domains.
    private static func isCocoa(_ error: Error) -> Bool {
        [NSCocoaErrorDomain, NSPOSIXErrorDomain, NSOSStatusErrorDomain, NSURLErrorDomain].contains((error as NSError).domain)
    }

    private static func trimmed(_ text: String) -> String {
        var text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasSuffix(".") { text.removeLast() }
        // "No space left" reads as "no space left"; "SSL error" and "Pardner" keep their capitals.
        let second = text.dropFirst().first
        return second?.isUppercase == true || text.hasPrefix("Pardner") ? text : text.prefix(1).lowercased() + text.dropFirst()
    }
}
