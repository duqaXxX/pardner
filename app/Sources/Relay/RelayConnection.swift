// The app's connection to the relay (step 6.3 design, 6): TLS 1.3 on Network.framework with the
// relay's key pinned, one long connection, and the policy of the shared `Link` running inside
// JavaScriptCore. This file holds what only the platform can do: the socket, the timer, the clock.
// One serial queue feeds one stream of events; one task takes them one at a time, so no event is
// handled while an earlier one's effects are still being performed.
import AppKit
import Foundation
import Network
import os
import Platform
import ProtocolHost
import Security

/// Where the relay is and the key it was paired with (the 65-byte uncompressed point).
public struct RelayEndpoint: Sendable {
    public let host: String
    public let port: UInt16
    public let pin: Data

    public init(host: String, port: UInt16, pin: Data) { (self.host, self.port, self.pin) = (host, port, pin) }
}

/// What the connection tells its owner: each dial, what the link delivers (its `View`, as a value), a bot's shown profile, and the end.
public enum RelayEvent: Sendable {
    case dialing
    case delivered(HostValue)
    /// The profile shown for a bot changed: the link's `profile` effect, with `bot` and `profile`, `profile` null when none reads (app data design, 5).
    case profile(HostValue)
    /// The host faulted: the connection is over for the life of the host, and does not retry.
    case faulted(String)
}

public enum RelayError: Error {
    /// The item is past the frame limit or outside its field.
    case invalidItem
}

/// What `submit` came to: the relay's result code, or why there is none.
public enum SubmitOutcome: Sendable, Equatable {
    /// The relay answered with this result code.
    case code(Int)
    /// The connection ended before the answer: send the item again.
    case unanswered
    /// The reading is not at rest: nothing was sent.
    case busy
    /// The connection was stopped, or is final (a put-back or a fault): nothing will be sent.
    case ended
}

enum Event: Sendable {
    case opened(Int, Data)
    case received(Int, Data)
    case closed(Int)
    case timer(Double)
    case networkUp
    case submit(UInt8, Data, Data, CheckedContinuation<SubmitOutcome, Error>)
    case count(CheckedContinuation<Int, Never>)
    case stop
}

/// One `NWConnection` and its token. Every handler runs on the connection's queue, which is why the
/// flags need no lock.
private final class Socket: @unchecked Sendable {
    let id: Int
    let connection: NWConnection
    private let events: AsyncStream<Event>.Continuation
    private let label: String
    private var ready = false
    private var ended = false

    init(id: Int, connection: NWConnection, label: String, events: AsyncStream<Event>.Continuation) {
        (self.id, self.connection, self.label, self.events) = (id, connection, label, events)
    }

    func start(on queue: DispatchQueue) {
        connection.stateUpdateHandler = { [self] state in
            switch state {
            case .ready:
                guard !ready else { return }
                ready = true
                guard let meta = connection.metadata(definition: NWProtocolTLS.definition) as? NWProtocolTLS.Metadata,
                      let secret = sec_protocol_metadata_create_secret(meta.securityProtocolMetadata, label.utf8.count, label, 32)
                else { return finish() } // no binding, no proof
                var binding = Data()
                (secret as DispatchData).enumerateBytes { buffer, _, _ in binding.append(contentsOf: buffer) }
                events.yield(.opened(id, binding))
                receive()
            case .failed, .waiting:
                // Before `.ready` no receive is pending to bring the end: this handler does. After it, the cancel
                // completes the pending receive with an error, and that is the one `closed`.
                if !ready { finish() }
                connection.cancel()
            default: break
            }
        }
        connection.start(queue: queue)
    }

    /// One receive is pending at a time; the end of the stream or an error ends the connection.
    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [self] data, _, isComplete, error in
            if let data, !data.isEmpty { events.yield(.received(id, data)) }
            if isComplete || error != nil { return finish() }
            receive()
        }
    }

    /// The one `closed` of this connection, and the socket cancelled.
    private func finish() {
        if !ended {
            ended = true
            events.yield(.closed(id))
        }
        connection.cancel()
    }

    func send(_ bytes: Data) {
        connection.send(content: bytes, completion: .contentProcessed { [connection] error in
            if error != nil { connection.cancel() } // the pending receive then brings the `closed`
        })
    }
}

/// The path monitor's updates, taken on the queue: the first is the state at the start, not news.
private final class PathWatch: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private var first = true

    func start(queue: DispatchQueue, _ events: AsyncStream<Event>.Continuation) {
        monitor.pathUpdateHandler = { [self] path in
            defer { first = false }
            if !first && path.status == .satisfied { events.yield(.networkUp) }
        }
        monitor.start(queue: queue)
    }

    func cancel() { monitor.cancel() }
}

/// The device's connection to the relay. Not an actor: one task takes the events one at a time, and nothing re-enters.
/// The task holds the object, so `stop()` must be called before the last reference is dropped.
public final class RelayConnection: @unchecked Sendable {
    /// The events for the owner; the stream ends when the connection does.
    public let events: AsyncStream<RelayEvent>
    private let out: AsyncStream<RelayEvent>.Continuation
    private let inbox: AsyncStream<Event>
    private let feed: AsyncStream<Event>.Continuation
    private let queue = DispatchQueue(label: "pardner.relay")
    private let host: ProtocolHost
    private let endpoint: RelayEndpoint
    private let options: [String: HostValue]
    private let origin = ContinuousClock.now
    private let lifecycle = OSAllocatedUnfairLock(initialState: Lifecycle())

    private struct Lifecycle {
        var started = false
        var stopped = false
        var task: Task<Void, Never>?
    }

    // Touched by the task alone.
    private var link: Handle?
    private var label = ""
    private var sockets: [Int: Socket] = [:]
    private var pending: [Int: CheckedContinuation<SubmitOutcome, Error>] = [:]
    private var timer: Task<Void, Never>?
    private var armed: Double?
    private var last = 0.0 // the time the link was last given: it is never given an earlier one
    private var final = false
    private var watch: PathWatch?
    private var wakeObserver: NSObjectProtocol?

    /// `store` holds the device's keys as `device.sign` and `device.receive`, and `host` was made on that store; `person` is the id the device was paired for.
    public convenience init(host: ProtocolHost, store: KeyStore, person: Data, endpoint: RelayEndpoint) throws {
        try self.init(host: host, store: store, person: person, endpoint: endpoint, constants: [:])
    }

    /// For tests, through `@testable import`: `constants` shortens the link's `first`, `max`, `patience` and `ask`.
    init(host: ProtocolHost, store: KeyStore, person: Data, endpoint: RelayEndpoint, constants: [String: HostValue]) throws {
        self.host = host
        self.endpoint = endpoint
        var options: [String: HostValue] = [
            "relay": .bytes(endpoint.pin), "person": .bytes(person),
            "signing": .bytes(try store.publicKey("device.sign")), "receiving": .bytes(try store.publicKey("device.receive")),
        ]
        if !constants.isEmpty { options["constants"] = .object(constants) }
        self.options = options
        (events, out) = AsyncStream.makeStream(of: RelayEvent.self)
        (inbox, feed) = AsyncStream.makeStream(of: Event.self)
    }

    /// Starts dialing, and watching the network and the Mac's wake; after `stop()` it does nothing.
    public func start() {
        lifecycle.withLock { state in
            guard !state.started, !state.stopped else { return }
            state.started = true
            let watch = PathWatch()
            watch.start(queue: queue, feed)
            self.watch = watch
            let feed = feed
            wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: nil) { _ in
                feed.yield(.networkUp)
            }
            state.task = Task { await self.run() }
        }
    }

    /// Sends one item and says what came of it. An item past the frame limit throws `RelayError.invalidItem`.
    public func submit(kind: UInt8, signed: Data, sig: Data) async throws -> SubmitOutcome {
        try await withCheckedThrowingContinuation { continuation in
            if case .terminated = feed.yield(.submit(kind, signed, sig, continuation)) { continuation.resume(returning: .ended) }
        }
    }

    /// Ends the connection and the dialing; returns when the task has ended. Before `start()` it ends the connection for good.
    public func stop() async {
        let task = lifecycle.withLock { state -> Task<Void, Never>? in
            state.stopped = true
            return state.task
        }
        if let task {
            feed.yield(.stop)
            await task.value
        } else {
            await finish()
        }
    }

    /// The internal count of sockets the connection holds, for tests.
    func socketCount() async -> Int {
        await withCheckedContinuation { continuation in
            if case .terminated = feed.yield(.count(continuation)) { continuation.resume(returning: 0) }
        }
    }

    // MARK: the loop

    private func run() async {
        do {
            link = try await host.construct("appLink", [.object(options)])
            // An exporter under another label gives a binding no relay accepts: fail loudly, never dial.
            guard let exporter = try await host.call(link!, "exporterLabel").stringValue, !exporter.isEmpty else {
                throw HostError.faulted("the protocol script gave no exporter label")
            }
            label = exporter
            try await perform(try await call("start"))
            for await event in inbox {
                try await handle(event)
                if final { break }
            }
        } catch HostError.faulted(let message) {
            out.yield(.faulted(message))
        } catch {
            out.yield(.faulted("\(error)"))
        }
        await teardown()
    }

    private func handle(_ event: Event) async throws {
        switch event {
        case .opened(let conn, let binding): try await perform(try await call("opened", [.number(Double(conn)), .bytes(binding)]))
        case .received(let conn, let bytes): try await perform(try await call("received", [.number(Double(conn)), .bytes(bytes)]))
        case .closed(let conn):
            sockets.removeValue(forKey: conn) // the dial is over, whoever ended it: a failed one leaves nothing behind
            try await perform(try await call("closed", [.number(Double(conn))]))
        case .count(let continuation): continuation.resume(returning: sockets.count)
        case .networkUp: try await perform(try await call("networkUp"))
        case .timer(let at):
            guard armed == at else { return } // a timer that is no longer the armed one does nothing
            armed = nil
            try await perform(try await call("tick", at: at))
        case .stop:
            try await perform(try await call("stop"))
            final = true
        case .submit(let kind, let signed, let sig, let continuation):
            let answer: HostValue
            do { answer = try await call("submit", [.number(Double(kind)), .bytes(signed), .bytes(sig)]) } catch {
                continuation.resume(throwing: error)
                throw error
            }
            switch answer {
            case .string("busy"): continuation.resume(returning: .busy)
            case .string: continuation.resume(throwing: RelayError.invalidItem)
            default:
                guard let request = answer["request"]?.numberValue, let effects = answer["effects"]?.arrayValue else {
                    continuation.resume(throwing: HostError.faulted("a submit answered neither a request nor a refusal"))
                    throw HostError.faulted("a submit answered neither a request nor a refusal")
                }
                pending[Int(request)] = continuation
                try await perform(effects)
            }
        }
    }

    /// A call of the link, with the time: the clock, and never before a deadline the timer fired for.
    private func call(_ method: String, _ arguments: [HostValue] = [], at: Double = 0) async throws -> HostValue {
        let elapsed = origin.duration(to: .now)
        last = max(last, at, Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15)
        return try await host.call(link!, method, arguments + [.number(last)])
    }

    /// The effects in order.
    private func perform(_ effects: HostValue) async throws { try await perform(effects.arrayValue ?? []) }

    private func perform(_ effects: [HostValue]) async throws {
        for fx in effects {
            switch fx["do"]?.stringValue {
            case "dial": dial(fx)
            case "send":
                if let conn = fx["conn"]?.numberValue, let bytes = fx["bytes"]?.bytesValue { sockets[Int(conn)]?.send(bytes) }
            case "close":
                if let conn = fx["conn"]?.numberValue { sockets.removeValue(forKey: Int(conn))?.connection.cancel() }
            case "wake": if let at = fx["at"]?.numberValue { arm(at) }
            case "deliver":
                guard let view = fx["out"] else { break }
                if ["put-back", "fault"].contains(view["do"]?.stringValue) { final = true }
                out.yield(.delivered(view))
            case "profile": out.yield(.profile(fx))
            case "persist":
                // A `persist` ends its list. Until the app's store (app data design, 3; pull request D2) every
                // write is answered as stored, which is what the host did in 6.3.
                try await perform(try await call("persisted", [.bool(true)]))
            case "answer":
                guard let request = fx["request"]?.numberValue else { break }
                let outcome = fx["code"]?.numberValue.map { SubmitOutcome.code(Int($0)) } ?? .unanswered
                pending.removeValue(forKey: Int(request))?.resume(returning: outcome)
            default: throw HostError.faulted("the link answered an effect this driver does not know")
            }
        }
    }

    // MARK: the platform

    /// The one timer, on `ContinuousClock`, which counts time asleep: after a sleep past a deadline it fires at once.
    private func arm(_ at: Double) {
        if armed == at { return } // the link repeats its wake after every call: a timer already waiting for it stays
        armed = at
        timer?.cancel()
        let feed = feed
        let deadline = origin.advanced(by: .milliseconds(Int(at.rounded(.up))))
        timer = Task {
            try? await Task.sleep(until: deadline, clock: .continuous)
            if !Task.isCancelled { feed.yield(.timer(at)) }
        }
    }

    /// TLS 1.3 to the relay, which passes only when the first certificate's key is the pinned one: chain, name and dates are not looked at (RD 3.3).
    private func dial(_ fx: HostValue) {
        guard let conn = fx["conn"]?.numberValue.map({ Int($0) }) else { return }
        out.yield(.dialing)
        let tls = NWProtocolTLS.Options()
        let security = tls.securityProtocolOptions
        sec_protocol_options_set_min_tls_protocol_version(security, .TLSv13)
        sec_protocol_options_set_max_tls_protocol_version(security, .TLSv13)
        let pin = endpoint.pin
        sec_protocol_options_set_verify_block(security, { _, trust, complete in
            let chain = SecTrustCopyCertificateChain(sec_trust_copy_ref(trust).takeRetainedValue()) as? [SecCertificate] ?? []
            guard let first = chain.first, let key = SecCertificateCopyKey(first), let raw = SecKeyCopyExternalRepresentation(key, nil) as Data? else { return complete(false) }
            complete(raw == pin)
        }, queue)
        let tcp = NWProtocolTCP.Options()
        tcp.enableKeepalive = true
        tcp.keepaliveIdle = 30
        let connection = NWConnection(host: NWEndpoint.Host(endpoint.host), port: NWEndpoint.Port(rawValue: endpoint.port)!, using: NWParameters(tls: tls, tcp: tcp))
        let socket = Socket(id: conn, connection: connection, label: label, events: feed)
        sockets[conn] = socket
        socket.start(on: queue)
    }

    private func teardown() async {
        timer?.cancel()
        watch?.cancel()
        if let wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver) }
        for socket in sockets.values { socket.connection.cancel() }
        sockets.removeAll()
        for continuation in pending.values { continuation.resume(returning: .ended) }
        pending.removeAll()
        await finish()
    }

    /// Ends the streams; a `submit` or a count queued behind the end is answered, as one made after it is.
    private func finish() async {
        feed.finish()
        for await event in inbox {
            switch event {
            case .submit(_, _, _, let continuation): continuation.resume(returning: .ended)
            case .count(let continuation): continuation.resume(returning: 0)
            default: break
            }
        }
        out.finish()
    }
}
