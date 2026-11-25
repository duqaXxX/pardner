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

/// The first device's entry 0 and the relay's enrolment secret: the link sends them before its proof on every connection until the relay first serves it (device pairing design 3.5).
/// The link tells the owner when that happened (`RelayEvent.enrolled`), and the owner stops passing the secret from then on: it is not kept past the first `served` of one process, and a restart connects with the proof alone.
public struct Enrolment: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let secret: Data
    public let signed: Data
    public let sig: Data

    public init(secret: Data, signed: Data, sig: Data) { (self.secret, self.signed, self.sig) = (secret, signed, sig) }

    /// Hides the secret from a log or a debugger's print.
    public var description: String { "Enrolment(secret: <hidden>, signed: \(signed.count) bytes, sig: \(sig.count) bytes)" }
    public var debugDescription: String { description }
}

/// A recovery's connection (recovery design 2.3): the recovery key typed (its id, and the name its signing key is held under) and, once the
/// questions are answered, the reset's inputs. With no `reset` the link reads the device log, tells it and stops; with one it builds the reset on each
/// recovery connection itself, from the log that connection reads, until the relay serves this device (`RelayEvent.recovered`).
public struct RecoverRequest: Sendable, Equatable {
    public struct Reset: Sendable, Equatable {
        public var proof: Data
        public var trusted: [Data]
        public var replacement: PairingRecoveryKeys?

        public init(proof: Data, trusted: [Data], replacement: PairingRecoveryKeys?) { (self.proof, self.trusted, self.replacement) = (proof, trusted, replacement) }
    }

    public var key: Data
    public var signName: String
    public var reset: Reset?

    public init(key: Data, signName: String, reset: Reset? = nil) { (self.key, self.signName, self.reset) = (key, signName, reset) }

    var value: HostValue {
        var o: [String: HostValue] = ["key": .object(["id": .bytes(key), "sign": .string(signName)])]
        if let reset {
            var r: [String: HostValue] = ["proof": .bytes(reset.proof), "trusted": .array(reset.trusted.map(HostValue.bytes))]
            if let n = reset.replacement { r["replacement"] = .object(["signing": .bytes(n.signing), "receiving": .bytes(n.receiving)]) }
            o["reset"] = .object(r)
        }
        return .object(o)
    }
}

/// What the connection tells its owner: each dial, what the link delivers (its `View`, as a value), a bot's shown profile, and the end.
public enum RelayEvent: Sendable {
    case dialing
    case delivered(HostValue)
    /// The profile shown for a bot changed: the link's `profile` effect, with `bot` and `profile`, `profile` null when none reads (app data design, 5).
    case profile(HostValue)
    /// The names the link shows changed: its `names` effect, with `names`, each `kind`, `target` and `name` (null when none shows; names design 3).
    case names(HostValue)
    /// The sections the link shows changed: its `arrangement` effect, with `sections` (null before any is shown; each `id`, `name` and `channels`
    /// in hex), `current`, `behind` and `notApplied` (sidebar sections design 4).
    case arrangement(HostValue)
    /// The device log the link reads changed: the link's `devices` effect, with `person`, `length`, `last`, `devices` and `self` (device pairing design 4.2).
    case devices(HostValue)
    /// The relay first served a link given an `Enrolment`: entry 0 was placed, and the owner stops passing the secret (device pairing design 3.5).
    case enrolled
    /// The relay refused the secret on a connection that carried it (reason 2): the link dropped it. The owner types it again and the
    /// app builds a new connection with that `Enrolment` (device pairing design 3.5); a setter on a running connection comes with the app's first-device flow.
    case enrolRefused
    /// A recovery connection read the device log and the link stopped: the `recovery-log` effect, with `devices` (each with `id` and `active`) and `recoveries`.
    case recoveryLog(HostValue)
    /// A recovery connection ended with an answer: the `recovery` effect's `outcome`, a `refused` reason, a relay `code` or a `fault` text.
    case recovery(HostValue)
    /// The relay first served a link given a recovery's reset: the reset is in the log (recovery design 2.3 step 8).
    case recovered
    /// A connection became ready: the relay was reached over TLS with its pinned key, before anything it answered.
    case reached
    /// A dial ended without ever becoming ready: nothing reached the relay on it.
    case unreached
    /// The items of a channel's outbox changed: the link's `outbox` effect, with `channel` and `items` (new channel design 3.3).
    case outbox(HostValue)
    /// The relay refused the channel being created: the link's `channel-refused` effect, with `channel` and `code`.
    case channelRefused(HostValue)
    /// The channel being created changed: the link's `creating` effect, with `channel` (null when none is pending) and, with one, `bot` and `folder`.
    case creating(HostValue)
    /// The link stopped sending in a channel after an answer no check explains: its `channel-fault` effect, with `channel`.
    case channelFault(HostValue)
    /// A stored fault on the person's space or a spare was dropped at the first rest: the link's `channel-fault-dropped` effect, with `channel` (personal space design 2.6).
    case channelFaultDropped(HostValue)
    /// A write of the app's outbox failed: nothing is created or sent from here, and the owner ends the connection (new channel design 3.1).
    case storeFailed
    /// The host faulted: the connection is over for the life of the host, and does not retry. The sentence the person is shown.
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

/// An entry the device builds, or a pairing it only checks, against the log the link holds (device pairing design 3.4, 3.6, 3.9).
public enum DeviceAct: Sendable, Equatable {
    /// What an add would refuse, before anything is signed.
    case check(device: HostValue, proof: Data)
    case add(device: HostValue, proof: Data)
    case remove(target: Data)
}

/// What `build` came to.
public enum BuildOutcome: Sendable, Equatable {
    case checked
    case built(SignedEntry)
    /// The package's reason: `busy` (the log is not at rest), `proof` (the string was made for another person id), `named` (the device is in the log already), or the builder's own (`bad-input`, `no-such-key`).
    case refused(String)
}

/// The messages an epoch holds that this device cannot open, and the smallest and largest of their plausible signed times, as the link counts them. For display only: no rule reads them (epoch dates design 5).
public struct Unopened: Sendable, Equatable {
    public var count: Int
    public var first: Date?
    public var last: Date?

    public init(count: Int, first: Date? = nil, last: Date? = nil) { (self.count, self.first, self.last) = (count, first, last) }

    /// The link's `unopened` value; nil for any other shape: a count of 0 or more, and with messages `first` and `last` both or neither, finite, in order and
    /// between the floor (2026-11-14, before which no header had a time) and a day ahead; none at a count of 0.
    init?(_ value: HostValue) {
        guard let count = value["count"]?.numberValue, count >= 0, count == count.rounded(), count < 1e15 else { return nil }
        let plausible = 1_794_614_400_000.0...(Date().timeIntervalSince1970 * 1000 + 86_400_000)
        switch (value["first"], value["last"]) {
        case (nil, nil): self.init(count: Int(count))
        case (let first?, let last?):
            guard count > 0, let first = first.numberValue, let last = last.numberValue, plausible.contains(first), plausible.contains(last), first <= last else { return nil }
            self.init(count: Int(count), first: Date(timeIntervalSince1970: first / 1000), last: Date(timeIntervalSince1970: last / 1000))
        default: return nil
        }
    }
}

/// What "done" needs of the link (recovery design 2.6): each epoch read with whether its key is held and who its seals are to, every recovery key the log named, and the current one.
public struct RecoveryReading: Sendable, Equatable {
    public struct Epoch: Sendable, Equatable {
        public var channel: Data
        public var epoch: Data
        public var open: Bool
        public var sealedTo: [Data]
        /// What the epoch holds unopened: present exactly when it is not open.
        public var unopened: Unopened?
        /// Whether the channel is the person's space or a spare of it: no conversation of the list.
        public var space: Bool

        public init(channel: Data, epoch: Data, open: Bool, sealedTo: [Data], unopened: Unopened? = nil, space: Bool = false) {
            (self.channel, self.epoch, self.open, self.sealedTo, self.unopened, self.space) = (channel, epoch, open, sealedTo, unopened, space)
        }

        /// The link's `epochs` entry; nil for any other shape, since a reading that drops an epoch could declare done over it.
        init?(_ value: HostValue) {
            guard let channel = value["channel"]?.bytesValue, channel.count == 32, let epoch = value["epoch"]?.bytesValue, epoch.count == 32,
                  case .bool(let open)? = value["open"], case .bool(let space)? = value["space"], let list = value["sealedTo"]?.arrayValue else { return nil }
            let sealed = list.compactMap(\.bytesValue)
            guard sealed.count == list.count, sealed.allSatisfy({ $0.count == 32 }) else { return nil }
            let unopened = value["unopened"].map(Unopened.init)
            guard open ? unopened == nil : unopened != nil, unopened != .some(nil) else { return nil }
            self.init(channel: channel, epoch: epoch, open: open, sealedTo: sealed, unopened: unopened ?? nil, space: space)
        }
    }

    public var epochs: [Epoch]
    public var recoveries: [Data]
    public var current: Data?

    public init(epochs: [Epoch] = [], recoveries: [Data] = [], current: Data? = nil) { (self.epochs, self.recoveries, self.current) = (epochs, recoveries, current) }
}

enum Event: Sendable {
    case opened(Int, Data)
    case received(Int, Data)
    case closed(Int)
    case timer(Double)
    case networkUp
    case submit(UInt8, Data, Data, CheckedContinuation<SubmitOutcome, Error>)
    case count(CheckedContinuation<Int, Never>)
    case enrol(Enrolment, CheckedContinuation<Bool, Never>)
    case hold(id: Data, receiving: String, CheckedContinuation<Bool, Never>)
    case reading(CheckedContinuation<RecoveryReading?, Never>)
    case build(DeviceAct, CheckedContinuation<BuildOutcome, Error>)
    case createChannel(bot: Data, folder: String, name: String?, CheckedContinuation<CreateOutcome, Error>)
    case send(channel: Data, draft: OutboxDraft, CheckedContinuation<SendOutcome, Error>)
    case setName(kind: Int, target: Data?, text: String, setup: Bool, CheckedContinuation<SendOutcome, Error>)
    case arrange(SectionAct, CheckedContinuation<SendOutcome, Error>)
    case fetch(channel: Data, blob: Data, CheckedContinuation<FetchOutcome, Never>)
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
    private var options: [String: HostValue] // `run` removes the enrolment secret once the link holds it
    private let linkStore: LinkStore
    private let recover: HostValue? // given to the link by `recover` after it is made: the constructor's options do not carry it
    private let claimed = OSAllocatedUnfairLock(initialState: true) // this connection holds the store's claim
    // A store write flushes to the drive: it runs here, off the task's cooperative thread, and the task awaits it.
    private let writes = DispatchQueue(label: "pardner.relay.store")
    private let origin = ContinuousClock.now
    private let lifecycle = OSAllocatedUnfairLock(initialState: Lifecycle())
    private let purposes = OSAllocatedUnfairLock<[String]>(initialState: [])
    /// The purpose of each dial the link asked for (`active`, `upload`, `recover`), in order: for the tests of what a connection was given.
    var dialPurposes: [String] { purposes.withLock { $0 } }

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
    private let fetches = Fetches()
    private var timer: Task<Void, Never>?
    private var armed: Double?
    private var last = 0.0 // the time the link was last given: it is never given an earlier one
    private var final = false
    // The first outbox write of the call being answered, which holds the change the call made: nil until it ran. Later writes of its chain
    // (the built bytes) are not the caller's: a failure of one ends the connection, while the message is already on the disk.
    private var firstOutboxWrite: Bool?
    private var readyConnections: Set<Int> = [] // the dials that became ready and have not ended
    private var watch: PathWatch?
    private var wakeObserver: NSObjectProtocol?
    private let log = Logger(subsystem: "io.github.duqaxxx.pardner", category: "relay")

    /// `store` holds the device's keys as `device.sign` and `device.receive`, and `host` was made on that store; `person`
    /// is the id the device was paired for. `linkStore` is the process's one store of the link's state (design 3.2: its
    /// lock lives as long as the process holds it), for the same keys and relay; a store that cannot be read now throws.
    public convenience init(host: ProtocolHost, store: KeyStore, person: Data, endpoint: RelayEndpoint, linkStore: LinkStore, enrol: Enrolment? = nil, recover: RecoverRequest? = nil, ownName: String? = nil, typedName: String? = nil) throws {
        try self.init(host: host, store: store, person: person, endpoint: endpoint, linkStore: linkStore, constants: [:], enrol: enrol, recover: recover, ownName: ownName, typedName: typedName)
    }

    /// For tests, through `@testable import`: `constants` shortens the link's `first`, `max`, `patience` and `ask`.
    init(host: ProtocolHost, store: KeyStore, person: Data, endpoint: RelayEndpoint, linkStore: LinkStore, constants: [String: HostValue], enrol: Enrolment? = nil, recover: RecoverRequest? = nil, ownName: String? = nil, typedName: String? = nil) throws {
        self.host = host
        self.endpoint = endpoint
        let signing = try store.publicKey("device.sign"), receiving = try store.publicKey("device.receive")
        guard linkStore.identity == LinkIdentity(signing: signing, receiving: receiving, relay: endpoint.pin) else {
            throw LinkStoreMismatch(description: "the link's store belongs to other keys or another relay")
        }
        try linkStore.claim()
        self.linkStore = linkStore
        var options: [String: HostValue] = [
            "relay": .bytes(endpoint.pin), "person": .bytes(person), "signing": .bytes(signing), "receiving": .bytes(receiving),
        ]
        do {
            if let stored = try linkStore.load() { options["stored"] = stored }
            if let outbox = try linkStore.loadOutbox() { options["outbox"] = outbox }
        } catch {
            linkStore.release() // `deinit` does not run for an init that throws
            throw error
        }
        if let enrol { options["enrol"] = .object(["secret": .bytes(enrol.secret), "signed": .bytes(enrol.signed), "sig": .bytes(enrol.sig)]) }
        if let ownName { options["ownName"] = .string(ownName) }
        if let typedName { options["typedName"] = .string(typedName) }
        self.recover = recover?.value
        if !constants.isEmpty { options["constants"] = .object(constants) }
        self.options = options
        (events, out) = AsyncStream.makeStream(of: RelayEvent.self)
        (inbox, feed) = AsyncStream.makeStream(of: Event.self)
    }

    // A connection made and never started or stopped gives the store back when it goes.
    deinit { giveBack() }

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

    /// Gives the running link its enrolment again (the person typed the secret again after `enrolRefused`, design 3.5) and
    /// dials at once, so a back-off in progress does not keep the person waiting. False when the link cannot frame it or the
    /// connection has ended: nothing changed then.
    public func enrol(_ enrolment: Enrolment) async -> Bool {
        await withCheckedContinuation { continuation in
            if case .terminated = feed.yield(.enrol(enrolment, continuation)) { continuation.resume(returning: false) }
        }
    }

    /// Builds and signs an entry against the log the link holds and sends nothing; the caller keeps it pending, then `submit`s it
    /// (design 3.6). `.refused("ended")` when the connection has ended.
    public func build(_ act: DeviceAct) async throws -> BuildOutcome {
        try await withCheckedThrowingContinuation { continuation in
            if case .terminated = feed.yield(.build(act, continuation)) { continuation.resume(returning: .refused("ended")) }
        }
    }

    /// Makes a channel with a `/bind <folder>` prompt to `bot`, kept in the app outbox before anything is sent (new channel design 3.2); the
    /// link's refusal is the outcome's, and `.ended` when the connection has ended.
    public func createChannel(bot: Data, folder: String, name: String? = nil) async throws -> CreateOutcome {
        try await withCheckedThrowingContinuation { continuation in
            if case .terminated = feed.yield(.createChannel(bot: bot, folder: folder, name: name, continuation)) { continuation.resume(returning: .ended) }
        }
    }

    /// Gives the link a recovery key held under `receiving`, for opening the epochs sealed to it (recovery design 2.6): the epochs it opens are delivered at once. False when the link refused it or the connection ended.
    public func holdRecovery(id: Data, receiving: String) async -> Bool {
        await withCheckedContinuation { continuation in
            if case .terminated = feed.yield(.hold(id: id, receiving: receiving, continuation)) { continuation.resume(returning: false) }
        }
    }

    /// The epochs read, the recovery keys the log named and the current one; nil when the connection ended.
    public func recoveryReading() async -> RecoveryReading? {
        await withCheckedContinuation { continuation in
            if case .terminated = feed.yield(.reading(continuation)) { continuation.resume(returning: nil) }
        }
    }

    /// Queues a message in a channel's outbox (new channel design 3.3); `.ended` when the connection has ended.
    public func send(channel: Data, draft: OutboxDraft) async throws -> SendOutcome {
        try await withCheckedThrowingContinuation { continuation in
            if case .terminated = feed.yield(.send(channel: channel, draft: draft, continuation)) { continuation.resume(returning: .ended) }
        }
    }

    /// Sets a name the person typed (names design 4.1 to 4.3): kept pending in the app outbox and written at rest. `kind` 14 names the channel
    /// `target`, 15 the person (`setup` for the name asked at setup), 16 this device. `queued` carries the pending entry's message name.
    public func setName(kind: Int, target: Data?, text: String, setup: Bool = false) async throws -> SendOutcome {
        try await withCheckedThrowingContinuation { continuation in
            if case .terminated = feed.yield(.setName(kind: kind, target: target, text: text, setup: setup, continuation)) { continuation.resume(returning: .ended) }
        }
    }

    /// Makes an act on the sections (sidebar sections design 3): one pending entry of the app outbox, written at rest. `queued` carries its message name;
    /// `refused` carries `not-ready` (the device has not read everything), `bad-input` or `too-many`.
    public func arrange(_ act: SectionAct) async throws -> SendOutcome {
        try await withCheckedThrowingContinuation { continuation in
            if case .terminated = feed.yield(.arrange(act, continuation)) { continuation.resume(returning: .ended) }
        }
    }

    /// Fetches the file a message of `channel` names by `blob`, whole and opened: its frames cross the bridge one copy each way (file-content design, 3.6).
    public func fetch(channel: Data, blob: Data) async -> FetchOutcome {
        await withCheckedContinuation { continuation in
            if case .terminated = feed.yield(.fetch(channel: channel, blob: blob, continuation)) { continuation.resume(returning: .ended) }
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
            options["enrol"] = nil
            if let recover {
                guard try await host.call(link!, "recover", [recover])["ok"] == .bool(true) else { throw HostError.faulted("the link refused the recovery's options") }
            }
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
        } catch {
            out.yield(.faulted(Problem.sentence("Pardner stopped its connection", error, next: PairingPhase.retryAdvice)))
        }
        await teardown()
    }

    private func handle(_ event: Event) async throws {
        switch event {
        case .opened(let conn, let binding):
            if sockets[conn] != nil { readyConnections.insert(conn); out.yield(.reached) }
            try await perform(try await call("opened", [.number(Double(conn)), .bytes(binding)]))
        case .received(let conn, let bytes): try await perform(try await call("received", [.number(Double(conn)), .bytes(bytes)]))
        case .closed(let conn):
            // The dial is over, whoever ended it: a failed one leaves nothing behind. One that the `close` effect already ended was told then.
            let known = sockets.removeValue(forKey: conn) != nil
            if readyConnections.remove(conn) == nil, known { out.yield(.unreached) }
            try await perform(try await call("closed", [.number(Double(conn))]))
        case .count(let continuation): continuation.resume(returning: sockets.count)
        case .enrol(let enrolment, let continuation):
            let taken: HostValue
            do { taken = try await call("enrol", [.bytes(enrolment.secret), .bytes(enrolment.signed), .bytes(enrolment.sig)]) } catch {
                continuation.resume(returning: false)
                throw error
            }
            guard taken["ok"] == .bool(true) else { continuation.resume(returning: false); return }
            continuation.resume(returning: true)
            try await perform(try await call("networkUp")) // a back-off cut short, as when the network returns
        case .hold(let id, let receiving, let continuation):
            let held: HostValue
            do { held = try await call("holdRecovery", [.object(["id": .bytes(id), "receiving": .string(receiving)])]) } catch {
                continuation.resume(returning: false)
                throw error
            }
            guard held["ok"] == .bool(true) else { return continuation.resume(returning: false) }
            continuation.resume(returning: true)
            try await perform(held["effects"] ?? .null)
        case .reading(let continuation):
            do {
                let epochs = (try await host.call(link!, "epochs")).arrayValue ?? []
                let parsed = epochs.compactMap(RecoveryReading.Epoch.init)
                let ids = (try await host.call(link!, "recoveries")).arrayValue ?? []
                let recoveries = ids.compactMap(\.bytesValue)
                // A value of another shape refuses the whole reading: done is never declared over an epoch or a key that was dropped.
                guard parsed.count == epochs.count, recoveries.count == ids.count else { return continuation.resume(returning: nil) }
                continuation.resume(returning: RecoveryReading(epochs: parsed, recoveries: recoveries, current: try await host.call(link!, "currentRecovery").bytesValue))
            } catch {
                continuation.resume(returning: nil)
                throw error
            }
        case .build(let act, let continuation):
            do { continuation.resume(returning: try await built(act)) } catch {
                continuation.resume(throwing: error)
                throw error
            }
        case .createChannel(let bot, let folder, let name, let continuation):
            // Answered once, after the call's effects ran: a failure of them (a host fault) is its error, and the run ends on it as elsewhere.
            let outcome: CreateOutcome
            do { outcome = try await created(bot: bot, folder: folder, name: name) } catch {
                continuation.resume(throwing: error)
                throw error
            }
            continuation.resume(returning: outcome)
        case .send(let channel, let draft, let continuation):
            let outcome: SendOutcome
            do { outcome = try await queued(channel: channel, draft: draft) } catch {
                continuation.resume(throwing: error)
                throw error
            }
            continuation.resume(returning: outcome)
        case .setName(let kind, let target, let text, let setup, let continuation):
            let outcome: SendOutcome
            do { outcome = try await named(kind: kind, target: target, text: text, setup: setup) } catch {
                continuation.resume(throwing: error)
                throw error
            }
            continuation.resume(returning: outcome)
        case .arrange(let act, let continuation):
            let outcome: SendOutcome
            do { outcome = try await arranged(act) } catch {
                continuation.resume(throwing: error)
                throw error
            }
            continuation.resume(returning: outcome)
        case .fetch(let channel, let blob, let continuation):
            let answer: HostValue
            do { answer = try await call("getBlob", [.bytes(channel), .bytes(blob)]) } catch {
                continuation.resume(returning: .ended)
                throw error
            }
            // A blob no opened body names (a launch before its history is read, a rewind) or a link that is final is retried later; a blob id of
            // another shape is a file that cannot be read.
            guard let request = answer["request"]?.numberValue, let effects = answer["effects"]?.arrayValue else {
                continuation.resume(returning: answer.stringValue == "bad-input" ? .gone : .ended)
                return
            }
            fetches.add(Int(request), Fetches.Get(channel: channel, blob: blob, continuation))
            try await perform(effects)
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

    /// The link's answer to a call of the app's outbox: its refusal as text, or the value and the effects to perform.
    private func answered(_ answer: HostValue) throws -> (value: HostValue, effects: [HostValue])? {
        if answer.stringValue != nil { return nil }
        guard let effects = answer["effects"]?.arrayValue else { throw HostError.faulted("the link answered neither a result nor a refusal") }
        return (answer, effects)
    }

    private func created(bot: Data, folder: String, name: String?) async throws -> CreateOutcome {
        var bind: [String: HostValue] = ["bot": .bytes(bot), "folder": .string(folder)]
        if let name { bind["name"] = .string(name) } // the channel's name goes in the write that keeps entry 0 (names design 4.1)
        let answer = try await call("createChannel", [.object(bind)])
        guard let (made, effects) = try answered(answer) else { return .refused(answer.stringValue ?? "") }
        guard let channel = made["channel"]?.bytesValue else { throw HostError.faulted("a new channel answered with no id") }
        // `notSaved` when the write this call made failed: the caller keeps what it typed (new channel design 9).
        return try await saved(effects) ? .created(channel: channel) : .notSaved
    }

    /// Performs the effects of an outbox call and says whether its first write of the app outbox, the one that holds the call's own
    /// change, was stored; a later write of the chain that fails still ends the connection through `storeFailed`.
    private func saved(_ effects: [HostValue]) async throws -> Bool {
        firstOutboxWrite = nil
        try await perform(effects)
        return firstOutboxWrite ?? true
    }

    private func queued(channel: Data, draft: OutboxDraft) async throws -> SendOutcome {
        var fields: [String: HostValue] = ["kind": .number(Double(draft.kind)), "content": .string(draft.content)]
        if let to = draft.to { fields["to"] = .bytes(to) }
        if let name = draft.name { fields["name"] = .bytes(name) }
        if let re = draft.re { fields["re"] = .object(["device": .bytes(re.device), "name": .bytes(re.name)]) }
        let answer = try await call("send", [.bytes(channel), .object(fields)])
        guard let (made, effects) = try answered(answer) else { return .refused(answer.stringValue ?? "") }
        guard let name = made["name"]?.bytesValue else { throw HostError.faulted("a queued message answered with no name") }
        return try await saved(effects) ? .queued(name: name) : .notSaved
    }

    private func named(kind: Int, target: Data?, text: String, setup: Bool) async throws -> SendOutcome {
        let answer = try await call("setName", [.number(Double(kind)), target.map { .bytes($0) } ?? .null, .string(text)], tail: [.object(["setup": .bool(setup)])])
        guard let (made, effects) = try answered(answer) else { return .refused(answer.stringValue ?? "") }
        guard let name = made["name"]?.bytesValue else { throw HostError.faulted("a name answered with no message name") }
        return try await saved(effects) ? .queued(name: name) : .notSaved
    }

    private func arranged(_ act: SectionAct) async throws -> SendOutcome {
        let answer = try await call("arrange", [act.hostValue])
        guard let (made, effects) = try answered(answer) else { return .refused(answer.stringValue ?? "") }
        guard let name = made["name"]?.bytesValue else { throw HostError.faulted("an arrangement answered with no message name") }
        return try await saved(effects) ? .queued(name: name) : .notSaved
    }

    private func built(_ act: DeviceAct) async throws -> BuildOutcome {
        func pairing(_ device: HostValue, _ proof: Data) -> HostValue { .object(["device": device, "proof": .bytes(proof)]) }
        let answer: HostValue
        switch act {
        case .check(let device, let proof): answer = try await call("checkPairing", [pairing(device, proof)])
        case .add(let device, let proof): answer = try await call("addDevice", [pairing(device, proof)])
        case .remove(let target): answer = try await call("removeDevice", [.bytes(target)])
        }
        guard case .bool(let made)? = answer["ok"] else { throw HostError.faulted("the link answered a device act with no result") }
        guard made else { return .refused(answer["error"]?.stringValue ?? "unknown") }
        if case .check = act { return .checked }
        guard let value = answer["value"], let signed = value["signed"]?.bytesValue, let sig = value["sig"]?.bytesValue, let id = value["id"]?.bytesValue else {
            throw HostError.faulted("the link built a malformed entry")
        }
        return .built(SignedEntry(signed: signed, sig: sig, id: id))
    }

    /// A call of the link, with the time: the clock, and never before a deadline the timer fired for.
    private func call(_ method: String, _ arguments: [HostValue] = [], at: Double = 0, tail: [HostValue] = []) async throws -> HostValue {
        let elapsed = origin.duration(to: .now)
        last = max(last, at, Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15)
        return try await host.call(link!, method, arguments + [.number(last)] + tail)
    }

    /// The effects in order.
    private func perform(_ effects: HostValue) async throws { try await perform(effects.arrayValue ?? []) }

    func perform(_ effects: [HostValue]) async throws { // not private: the tests give it the effects a recovery connection ends on
        for fx in effects {
            switch fx["do"]?.stringValue {
            case "dial": dial(fx)
            case "send":
                if let conn = fx["conn"]?.numberValue, let bytes = fx["bytes"]?.bytesValue { sockets[Int(conn)]?.send(bytes) }
            case "close":
                if let conn = fx["conn"]?.numberValue, let socket = sockets.removeValue(forKey: Int(conn)) {
                    socket.connection.cancel()
                    // A cancel before `.ready` goes preparing to cancelled, which the socket's handler ignores: no `closed` ever
                    // comes for it, so the dial that never reached the relay is told here (a relay that drops packets).
                    if !readyConnections.contains(Int(conn)) { out.yield(.unreached) }
                }
            case "wake": if let at = fx["at"]?.numberValue { arm(at) }
            case "deliver":
                guard let view = fx["out"] else { break }
                if ["put-back", "fault"].contains(view["do"]?.stringValue) { final = true }
                out.yield(.delivered(view))
            case "profile": out.yield(.profile(fx))
            case "names": out.yield(.names(fx))
            case "arrangement": out.yield(.arrangement(fx))
            case "devices": out.yield(.devices(fx))
            case "outbox": out.yield(.outbox(fx))
            case "creating": out.yield(.creating(fx))
            case "channel-refused": out.yield(.channelRefused(fx))
            case "channel-fault": out.yield(.channelFault(fx))
            case "channel-fault-dropped": out.yield(.channelFaultDropped(fx))
            case "store-failed": out.yield(.storeFailed)
            case "write":
                // A `write` ends its list as a `persist` does, and is answered by the link's own call: the connection is serial, so no call
                // lands while it is held (new channel design 3.1).
                var stored = true
                do { try await writeOutbox(fx["outbox"] ?? .null) } catch let mismatch as LinkStoreMismatch {
                    throw HostError.faulted("the link asked the store for an outbox write it cannot make: \(mismatch)")
                } catch {
                    stored = false
                    if firstOutboxWrite == nil { firstOutboxWrite = false }
                    log.error("the app outbox's store write failed: \(String(describing: error), privacy: .public)")
                }
                if firstOutboxWrite == nil { firstOutboxWrite = true }
                try await perform(try await call("written", [.bool(stored)]))
            case "recovery-log":
                out.yield(.recoveryLog(fx))
                final = true // the link stopped itself after the log: the connection gives the store's claim back
            case "recovery":
                let outcome = fx["outcome"] ?? .null
                out.yield(.recovery(outcome))
                if outcome["fault"] != nil || [2, 3, 6].contains(outcome["refused"]?.numberValue.map(Int.init)) { final = true } // the link stops after these

            case "recovered": out.yield(.recovered)
            case "enrolled": out.yield(.enrolled)
            case "enrol-refused": out.yield(.enrolRefused)
            case "persist":
                // A `persist` ends its list: the write first, then what the link gives once it is answered.
                var written = true
                do { try await write(fx["what"] ?? .null) } catch let mismatch as LinkStoreMismatch {
                    // The joined script and this store disagree: asking again would fail again, for good.
                    throw HostError.faulted("the link asked the store for a write it cannot make: \(mismatch)")
                } catch {
                    written = false
                    log.error("the link's store write failed: \(String(describing: error), privacy: .public)")
                }
                try await perform(try await call("persisted", [.bool(written)]))
            case "blob":
                if let request = fx["request"]?.numberValue, let offset = fx["offset"]?.numberValue, let chunk = fx["chunk"]?.bytesValue {
                    fetches.take(request: Int(request), offset: Int(offset), chunk: chunk)
                }
            case "answer":
                guard let request = fx["request"]?.numberValue else { break }
                if let get = fetches.end(Int(request)) {
                    let outcome: FetchOutcome
                    do { outcome = try await opened(get, code: fx["code"]) } catch {
                        get.continuation.resume(returning: .ended) // a host fault ends the run: the caller is not left waiting
                        throw error
                    }
                    get.continuation.resume(returning: outcome)
                    break
                }
                let outcome = fx["code"]?.numberValue.map { SubmitOutcome.code(Int($0)) } ?? .unanswered
                pending.removeValue(forKey: Int(request))?.resume(returning: outcome)
            default: throw HostError.faulted("the link answered an effect this driver does not know")
            }
        }
    }

    /// What a get came to: its gathered bytes opened by the package when the relay gave the blob (code 0), else the file is gone, or the link ended.
    private func opened(_ get: Fetches.Get, code: HostValue?) async throws -> FetchOutcome {
        guard let number = code?.numberValue else { return .ended } // "unanswered": the link is final
        guard number == 0 else { return .gone }
        let opened = try await host.call(link!, "openFile", [.bytes(get.channel), .bytes(get.blob), .bytes(get.gathered.data)])
        if opened["ok"] == .bool(true) { return opened["value"]?.bytesValue.map(FetchOutcome.file) ?? .gone }
        // A key the package no longer holds (the relay's incarnation changed during the download) is not a file that is lost: the history is read again.
        return opened.stringValue == "unknown" || opened["error"]?.stringValue == "unknown" ? .ended : .gone
    }

    /// The store's claim given back once, whichever end comes first: a second release would free a later connection's.
    private func giveBack() {
        if claimed.withLock({ held in defer { held = false }; return held }) { linkStore.release() }
    }

    private func write(_ what: HostValue) async throws {
        let (store, writes) = (linkStore, writes)
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            writes.async {
                do {
                    try store.write(what)
                    done.resume()
                } catch { done.resume(throwing: error) }
            }
        }
    }

    private func writeOutbox(_ what: HostValue) async throws {
        let (store, writes) = (linkStore, writes)
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            writes.async {
                do {
                    try store.writeOutbox(what)
                    done.resume()
                } catch { done.resume(throwing: error) }
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
        purposes.withLock { $0.append(fx["purpose"]?.stringValue ?? "") }
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
        fetches.endAll()
        await finish()
    }

    /// Ends the streams; a `submit` or a count queued behind the end is answered, as one made after it is.
    private func finish() async {
        linkStore.close() // closed before the claim is given back, so no claim lands on a store about to close; the folder's lock goes now, not when the last reference does: the owner may erase the store at once
        giveBack()
        feed.finish()
        for await event in inbox {
            switch event {
            case .submit(_, _, _, let continuation): continuation.resume(returning: .ended)
            case .count(let continuation): continuation.resume(returning: 0)
            case .enrol(_, let continuation): continuation.resume(returning: false)
            case .hold(_, _, let continuation): continuation.resume(returning: false)
            case .reading(let continuation): continuation.resume(returning: nil)
            case .build(_, let continuation): continuation.resume(returning: .refused("ended"))
            case .createChannel(_, _, _, let continuation): continuation.resume(returning: .ended)
            case .send(_, _, let continuation): continuation.resume(returning: .ended)
            case .setName(_, _, _, _, let continuation): continuation.resume(returning: .ended)
            case .arrange(_, let continuation): continuation.resume(returning: .ended)
            case .fetch(_, _, let continuation): continuation.resume(returning: .ended)
            default: break
            }
        }
        out.finish()
    }
}
