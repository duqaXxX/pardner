// The recovery key of the first device (device pairing design 3.5, steps 3 and 5), made and shown through the package so
// the labels its two keys are derived under stay the package's. The secret never crosses: it is held in the host's platform
// and handed to the person's `show` closure there.
import Foundation

/// The platform or the package refused a recovery call: `reason` is the platform error it names (`key-exists`, ...).
public struct RecoveryRefused: Error, Equatable {
    public let reason: String
}

extension ProtocolHost {
    /// Makes the recovery secret, holds it in the host's memory under `name` and returns its two public keys and its id; nothing is shown.
    public func createRecovery(_ name: String) async throws -> (signing: Data, receiving: Data, id: Data) {
        try await recoveryKeys("createRecoveryKey", name)
    }

    /// Takes the recovery secret from the person's `enter` (it never reaches JavaScript) and holds the two private keys under
    /// `<name>.sign` and `<name>.receive`; `deleteRecoveryKeys` removes them. A person who declines, or a secret of the wrong size, is refused as `bad-input`.
    public func enterRecovery(_ name: String) async throws -> (signing: Data, receiving: Data, id: Data) {
        try await recoveryKeys("enterRecoveryKey", name)
    }

    private func recoveryKeys(_ method: String, _ name: String) async throws -> (signing: Data, receiving: Data, id: Data) {
        let answer = try await callExported(method, [.string(name)])
        guard case .bool(let made)? = answer["ok"] else { throw HostError.faulted("\(method) answered no result") }
        guard made else { throw RecoveryRefused(reason: answer["error"]?.stringValue ?? "unknown") }
        guard let value = answer["value"], let signing = value["signing"]?.bytesValue, let receiving = value["receiving"]?.bytesValue, let id = value["id"]?.bytesValue else {
            throw HostError.faulted("\(method) answered malformed keys")
        }
        return (signing, receiving, id)
    }

    /// Removes the two keys `enterRecovery` held under `name`: `deleteKey(name)` alone does nothing for them.
    public func deleteRecoveryKeys(_ name: String) async throws {
        var first: Error?
        for suffix in [".sign", ".receive"] {
            do { try await deleteKey(name + suffix) } catch { first = first ?? error } // both are attempted
        }
        if let first { throw first }
    }

    /// Shows the held secret with the sheet's `context` through the host's `RecoveryPerson`, then wipes it, whatever the answer.
    /// False when the person did not confirm; the call waits for the person's answer on the host's thread.
    public func showRecovery(_ name: String, context: String) async throws -> Bool {
        let answer = try await callExported("showRecoveryKey", [.string(name), .string(context)])
        guard case .bool(let shown)? = answer["ok"] else { throw HostError.faulted("showRecoveryKey answered no result") }
        if shown { return true }
        guard answer["error"]?.stringValue == "bad-input" else { throw RecoveryRefused(reason: answer["error"]?.stringValue ?? "unknown") }
        return false
    }

    /// Wipes the secret `createRecovery` made and `showRecovery` has not shown; a name that holds nothing is fine.
    public func deleteKey(_ name: String) async throws {
        try await perform { try $0.platform.deleteKey(name) }
    }
}
