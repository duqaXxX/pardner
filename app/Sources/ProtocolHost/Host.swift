// The joined protocol script in one JSContext that only the host's own thread touches. The thread
// runs a run loop: a JSVirtualMachine runs its deferred work (garbage collection) on the run loop
// of the thread it was made on, and a serial dispatch queue promises none (JSVirtualMachine.h).
// A JavaScript fault ends the host: there is no reload, the owner makes a new host.
import Foundation
import JavaScriptCore
import Platform

public enum HostError: Error {
    /// The bundle holds no `protocol.js`: the app was built without its join phase.
    case scriptUnavailable
    case faulted(String)
    case foreignHandle
}

/// A block for the host thread: `perform(_:on:with:waitUntilDone:)` takes a selector, not a closure.
private final class Job: NSObject {
    let block: () -> Void
    init(_ block: @escaping () -> Void) { self.block = block }
    @objc func run() { block() }
}

/// The thread, its run loop, nothing else. Work goes to it with `perform(_:on:with:waitUntilDone:)`,
/// the one way NSRunLoop.h documents for another thread (a RunLoop is not thread-safe).
final class HostThread: Thread {
    private var onReady: (() -> Void)?
    private var stopped = false // touched on this thread alone

    /// Starts the thread and resumes once its run loop is ready to take work.
    func launch() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            onReady = { continuation.resume() }
            name = "pardner.protocol-host"
            start()
        }
    }

    override func main() {
        RunLoop.current.add(Port(), forMode: .default) // an input source keeps the loop alive while it runs
        onReady?()
        onReady = nil
        while !stopped { RunLoop.current.run(mode: .default, before: .distantFuture) }
    }

    func submit(_ block: @escaping () -> Void) {
        Job(block).perform(#selector(Job.run), on: self, with: nil, waitUntilDone: false)
    }

    /// Ends the loop from inside it, with no other wake-up.
    func stop() {
        submit {
            self.stopped = true
            CFRunLoopStop(CFRunLoopGetCurrent())
        }
    }
}

/// What the exception handler writes. It holds no context: the handler would make a cycle.
final class FaultBox {
    var message: String?
}

/// Touched on the host thread alone, which is why the `@unchecked Sendable` is sound: the other
/// threads only carry the reference (a Handle's deinit) and never read a field outside a block
/// submitted to the host thread.
final class HostState: @unchecked Sendable {
    var machine: JSVirtualMachine?
    var context: JSContext?
    let platform: CryptoKitPlatform
    let box = FaultBox()
    var platformObject: JSValue?
    /// The JavaScript values the package's Handles stand for: a JSValue is released under the
    /// virtual machine's lock, so it is only ever held and released here.
    var table: [Int: JSValue] = [:]
    private var nextToken = 0

    init(platform: CryptoKitPlatform) { self.platform = platform }

    func start(script: String) {
        let machine = JSVirtualMachine()!
        let context = JSContext(virtualMachine: machine)!
        let box = box
        context.exceptionHandler = { _, error in box.message = error?.toString() ?? "a JavaScript exception" }
        self.machine = machine
        self.context = context
        context.evaluateScript(script)
        platformObject = Bridge(context).platform(platform)
    }

    func store(_ value: JSValue) -> Int {
        nextToken += 1
        table[nextToken] = value
        return nextToken
    }

    /// Runs `work`; a fault, in JavaScript or in the call, ends the host for good.
    func run<T>(_ work: (HostState) throws -> T) throws -> T {
        if let message = box.message { throw HostError.faulted(message) }
        let value: T
        do { value = try work(self) } catch {
            if let message = box.message { end(); throw HostError.faulted(message) }
            throw error
        }
        if let message = box.message { end(); throw HostError.faulted(message) }
        return value
    }

    /// The derived keys go first, before anything else is released.
    func end() { platform.endSession() }

    /// The table goes before the context, so no value outlives the machine it belongs to.
    func teardown() {
        end()
        table.removeAll()
        platformObject = nil
        context = nil
        machine = nil
    }
}

/// A JavaScript object of the package, by the host that made it. It holds no JSValue: only a token
/// into its host's table, whose entry its deinit asks the host thread to remove (and nothing, when
/// the host has ended), so a handle dropped on any thread never touches the virtual machine's lock.
public final class Handle: @unchecked Sendable { // sound: every field is immutable; the table is read on the host thread alone
    let owner: UUID
    let token: Int
    private let state: HostState
    private weak var thread: HostThread?

    fileprivate init(owner: UUID, token: Int, state: HostState, thread: HostThread) {
        (self.owner, self.token, self.state, self.thread) = (owner, token, state, thread)
    }

    deinit {
        guard let thread else { return }
        let (state, token) = (state, token)
        thread.submit { state.table[token] = nil }
    }
}

public final class ProtocolHost: @unchecked Sendable { // sound: immutable fields; the state is touched on the host thread alone
    static let scriptResource = "protocol"
    let id = UUID()
    private let thread = HostThread()
    let state: HostState

    /// The app's own script, from its bundle under one fixed name: no path comes in from outside.
    public convenience init(store: KeyStore, person: RecoveryPerson? = nil) async throws {
        guard let url = Bundle.main.url(forResource: Self.scriptResource, withExtension: "js") else { throw HostError.scriptUnavailable }
        try await self.init(scriptPath: url.path, store: store, person: person)
    }

    /// For tests, through `@testable import`.
    init(scriptPath: String, store: KeyStore, person: RecoveryPerson? = nil) async throws {
        state = HostState(platform: CryptoKitPlatform(store: store, person: person))
        // The thread runs before anything here can throw: `deinit` hands its teardown to it, and a
        // thread that never started would never run (nor free) that work.
        await thread.launch()
        let script = try String(contentsOfFile: scriptPath, encoding: .utf8)
        try await perform { $0.start(script: script) }
    }

    deinit {
        let state = state
        thread.submit { state.teardown() }
        thread.stop()
    }

    func perform<T: Sendable>(_ work: @escaping (HostState) throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            thread.submit {
                do { continuation.resume(returning: try self.state.run(work)) } catch { continuation.resume(throwing: error) }
            }
        }
    }

    /// Calls `method` of the package's `protocol` object, or of the object `handle` names, and returns the result as a new handle.
    public func invoke(_ handle: Handle?, _ method: String, _ arguments: [Any] = []) async throws -> Handle {
        if let handle, handle.owner != id { throw HostError.foreignHandle }
        let (owner, thread) = (id, thread)
        return try await perform { state in
            let target: JSValue
            if let handle {
                guard let held = state.table[handle.token] else { throw HostError.foreignHandle }
                target = held
            } else {
                target = state.context!.objectForKeyedSubscript("protocol")!
            }
            let token = state.store(target.invokeMethod(method, withArguments: arguments))
            return Handle(owner: owner, token: token, state: state, thread: thread)
        }
    }

    /// Calls `method` of the object `handle` names and returns what it answers, as a value: bytes cross as `Uint8Array`. A JavaScript exception faults the host.
    public func call(_ handle: Handle, _ method: String, _ arguments: [HostValue] = []) async throws -> HostValue {
        guard handle.owner == id else { throw HostError.foreignHandle }
        return try await perform { state in
            guard let target = state.table[handle.token] else { throw HostError.foreignHandle }
            let bridge = Bridge(state.context!)
            let answer = target.invokeMethod(method, withArguments: arguments.map(bridge.jsValue))
            // A throw leaves no value: `run` reports the recorded exception after this block.
            guard state.box.message == nil, let answer else { return HostValue.null }
            return try bridge.hostValue(answer)
        }
    }

    /// Calls the factory `method` of the package's `protocol` object with the host's platform first, and returns what it made as a handle: the way to make an object that holds the platform, which never crosses.
    public func construct(_ method: String, _ arguments: [HostValue] = []) async throws -> Handle {
        let (owner, thread) = (id, thread)
        return try await perform { state in
            let bridge = Bridge(state.context!)
            let target = state.context!.objectForKeyedSubscript("protocol")!
            let made = target.invokeMethod(method, withArguments: [state.platformObject!] + arguments.map(bridge.jsValue))!
            return Handle(owner: owner, token: state.store(made), state: state, thread: thread)
        }
    }

    /// Calls the plain function `name` exported by the package, with the host's platform first, and returns what it answers as a value: for a function that makes a value once and keeps no object (a `Result` is an object with `ok`). A JavaScript exception faults the host.
    public func callExported(_ name: String, _ arguments: [HostValue] = []) async throws -> HostValue {
        try await perform { state in
            let bridge = Bridge(state.context!)
            let target = state.context!.objectForKeyedSubscript("protocol")!
            let answer = target.invokeMethod(name, withArguments: [state.platformObject!] + arguments.map(bridge.jsValue))
            guard state.box.message == nil, let answer else { return HostValue.null }
            return try bridge.hostValue(answer)
        }
    }
}
