// The recovery sheet as the controller hands it to a view (device pairing design 3.5 step 5 and 3.8). The host thread is blocked
// inside `showRecovery` until the request is answered. The contract: the view answers on every way the sheet goes away (a typed-back
// match is `answer(true)`; closing the window, Cancel and a quit are `answer(false)`), and the controller declines a sheet on screen
// when the setup is cancelled or the controller shuts down. The request is held by the controller's phase, so nothing is "dropped"
// while the sheet is shown: `deinit` is only a backstop for a request nobody ever presented.
import Foundation

/// The host thread's wait for the person's answer: answered once, by the first answer.
final class SheetGate: @unchecked Sendable { // sound: `result` is read and written under `state`, which is re-entrant
    /// Re-entrant, so `answer` called from inside `whileOpen`'s body (on the same thread) records the answer instead of deadlocking.
    private let state = NSRecursiveLock()
    private let answered = DispatchSemaphore(value: 0)
    private var result: Bool?

    /// Records the answer once; later ones change nothing. From another thread it waits for a draw in progress to end.
    func answer(_ confirmed: Bool) {
        state.lock()
        defer { state.unlock() }
        guard result == nil else { return }
        result = confirmed
        answered.signal()
    }

    /// Blocks until answered. It returns only after any `whileOpen` body has ended, even one that answered itself, so the
    /// secret's pointer is never read after this returns.
    func wait() -> Bool {
        answered.wait()
        state.lock()
        defer { state.unlock() }
        return result == true
    }

    func whileOpen<T>(_ body: () -> T) -> T? {
        state.lock()
        defer { state.unlock() }
        return result == nil ? body() : nil
    }
}

/// What the person is asked to write down: the secret and the sheet's public context. The view draws the secret from
/// `withSecret` and never copies it into a `String`; it then calls `answer(true)` once the typed-back secret matched, `answer(false)` otherwise.
public final class RecoverySheetRequest: @unchecked Sendable, Equatable { // sound: the pointer is read under the gate while it is open
    /// The person id, the relay's address and key, as text.
    public let context: String
    private let secret: UnsafeRawBufferPointer
    private let gate: SheetGate

    init(context: String, secret: UnsafeRawBufferPointer, gate: SheetGate) { (self.context, self.secret, self.gate) = (context, secret, gate) }

    /// A backstop for a request that is released before any view answered it: a decline, never a wait.
    deinit { gate.answer(false) }

    public static func == (a: RecoverySheetRequest, b: RecoverySheetRequest) -> Bool { a === b }

    /// Runs `body` on the 32 secret bytes, valid only inside it; nil once the request is answered, when the bytes are wiped.
    public func withSecret<T>(_ body: (UnsafeRawBufferPointer) -> T) -> T? { gate.whileOpen { body(secret) } }

    /// The person's answer: true only for a typed-back match. The first answer stands.
    public func answer(_ confirmed: Bool) { gate.answer(confirmed) }
}
