// Test-only: people for the recovery tests, and a buffer made from known bytes.
import Foundation
@testable import Platform

extension SecretBuffer {
    /// A buffer holding `data` (the test's own copy of it).
    convenience init(_ data: Data) {
        self.init(count: data.count)
        withUnsafeMutableBytes { $0.copyBytes(from: data) }
    }
}

extension RecoveryPerson {
    /// A person who types `secret` and is shown nothing; `onAsk` runs when asked for it.
    static func typing(_ secret: Data, onAsk: @escaping @Sendable () -> Void = {}) -> RecoveryPerson {
        RecoveryPerson(show: { _, _ in true }, enter: { buffer in
            onAsk()
            buffer.withUnsafeMutableBytes { $0.copyBytes(from: secret.prefix(buffer.count)) }
            return secret.count
        })
    }
}
