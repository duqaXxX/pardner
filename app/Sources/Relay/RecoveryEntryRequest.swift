// The recovery key as the controller asks the person to type it (recovery design 2.2). The host thread is blocked inside
// `enterRecovery` until the request is answered; the view types into `entry`, which this object owns and wipes, and answers
// `true` to hand it over or `false` to decline. A request released before any answer is a decline, never a wait.
import Foundation
import Platform

public final class RecoveryEntryRequest: @unchecked Sendable, Equatable { // sound: `entry` is written by the view before its answer and read by the host thread after it
    public let entry = RecoveryEntry()
    private let gate: SheetGate

    init(gate: SheetGate) { self.gate = gate }

    /// A request nobody waits on: what the screenshot tool and the previews draw the key field over.
    public convenience init() { self.init(gate: SheetGate()) }

    /// The first answer stands: `true` once the person has typed the key, `false` to decline.
    /// A decline wipes the typed key only when it is the answer that stands: after a `true` the host thread reads the buffer.
    public func answer(_ typed: Bool) {
        gate.answer(typed) { if !typed { entry.wipe() } } // the wipe is under the gate's lock, so no key typed meanwhile survives it
    }

    /// Runs `body` on the typed key while no answer stands; nil after one. The one way the view writes or reads the buffer: once the answer stands
    /// the buffer is the host thread's (a `true`) or wiped (a `false`).
    public func withEntry<T>(_ body: (RecoveryEntry) -> T) -> T? { gate.whileOpen { body(entry) } }

    deinit { answer(false) }

    public static func == (a: RecoveryEntryRequest, b: RecoveryEntryRequest) -> Bool { a === b }
}
