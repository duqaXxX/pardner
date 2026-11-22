// The app's pairing, as the views drive it (device pairing design 3.5, 3.8, 3.10, 4.1): which state this Mac is in at launch,
// the first device's setup from the form to `paired`, the recovery sheet as a request the view answers, the cancel rules and the
// removed device. No view lives here. One actor holds the state, so a cancel, a sheet's answer and the connection's events take
// turns; the enrolment secret is held in memory for the length of a call and never stored or logged.
import CryptoKit
import Foundation
import Network
import Platform
import ProtocolHost

/// What the reading model takes from the controller, in order.
public enum ReadingEvent: Sendable, Equatable {
    /// A `deliver` of the link, as `RelayEvent.delivered` carries it.
    case delivered(HostValue)
    /// A bot's shown profile, as `RelayEvent.profile` carries it.
    case profile(HostValue)
    /// The model starts again empty: a new connection reads the sequence from its start, or the pairing's keys and stores were erased.
    case reset
}

/// The connection the controller runs: `RelayConnection`, or a stand-in in a test.
public protocol RelayLinking: AnyObject, Sendable {
    var events: AsyncStream<RelayEvent> { get }
    func start()
    func stop() async
    func enrol(_ enrolment: Enrolment) async -> Bool
    func submit(kind: UInt8, signed: Data, sig: Data) async throws -> SubmitOutcome
    func build(_ act: DeviceAct) async throws -> BuildOutcome
    func createChannel(bot: Data, folder: String) async throws -> CreateOutcome
    func send(channel: Data, draft: OutboxDraft) async throws -> SendOutcome
    func holdRecovery(id: Data, receiving: String) async -> Bool
    func recoveryReading() async -> RecoveryReading?
}

extension RelayConnection: RelayLinking {}

/// What the person is told on the first screen besides the two choices.
public enum UnpairedNote: Sendable, Equatable {
    /// A sheet written for the attempt that stopped opens nothing: the enrolment secret was in memory only (design 3.5).
    case staleSheet
    /// A new recovery key made in a recovery that stopped opens nothing (recovery design 2.7).
    case staleRecoveryKey
}

public enum PairingFaultKind: Sendable, Equatable {
    /// The pairing file does not read: the only action is Pair again, with a warning (design 4.1).
    case malformedStore
    /// The pairing file was written by a newer version of the app: nothing is erased and no action is offered; the person updates Pardner (design 4.1).
    case newerStore
    /// The keys are here and no pairing says they are this Mac's: the only action is Pair again (design 4.1).
    case keysWithoutStore
    /// The log the relay served for a join does not hold this device's add (design 3.7, step 4): the connection is stopped, and the action is Pair again.
    case joinMismatch
    /// This Mac could not make its pairing string for a join (design 3.7): `joining` is on disk, so Retry resumes it, and Pair again starts over.
    case joinUnmade
    case failed
}

public enum PairingPhase: Sendable, Equatable {
    /// `launch()` has not run.
    case starting
    case unpaired(UnpairedNote?)
    /// The keys, the recovery key and entry 0 are being made.
    case settingUp
    /// The recovery sheet waits for the view's answer.
    case showingSheet(RecoverySheetRequest)
    /// Entry 0 is sent on every connection until the relay places it. `asksSecret`: the relay did not take the enrolment secret, or none is held after a restart (design 3.5 step 7).
    case enrolling(asksSecret: Bool)
    /// The join waits for the other device's add (design 3.7).
    case joining(JoiningInfo)
    /// A recovery with the recovery key waits at this step (recovery design 2.3).
    case recovering(RecoveryStep)
    case paired
    /// This device was removed (design 3.10): the only action is `pairAgain()`.
    case removed
    /// A store past `keys-made` whose keys are gone (a Mac restored from a backup): the only action is `pairAgain()` (design 4.1).
    case keysMissing
    /// The relay was put back by hand (security design 5.11); the string is what to tell the person. The link keeps that mark in its
    /// store and delivers it at every start without dialing, so `retry()` would meet it again: the action is `pairAgain()`.
    case putBack(String)
    /// The link ended on a fault it delivered; the string is what to tell the person. The relay sent something that fails the
    /// checks and would again, so `retry()` is refused: the action is `pairAgain()`, as for `putBack`.
    case linkFaulted(String)
    case fault(PairingFaultKind, String)
}

/// What the joining screen shows: this Mac's pairing string and its short form, to copy to the approving device (design 3.7).
public struct JoiningInfo: Sendable, Equatable {
    public let pairingString: String
    public let shortForm: String
    /// The relay refused this device as not yet known (refusal 2): "Waiting for your other device to add this one".
    public var waiting: Bool
    /// This Mac's name, as the other device will show it.
    public let name: String

    public init(pairingString: String, shortForm: String, waiting: Bool = false, name: String = "") {
        (self.pairingString, self.shortForm, self.waiting, self.name) = (pairingString, shortForm, waiting, name)
    }
}

extension PairingPhase {
    /// What the person is told while a join waits for the other device.
    public static let joinWaiting = "Waiting for your other device to add this one"
    /// What the person is told when the log a join was served does not hold this device.
    public static let joinMismatchAdvice = "The relay did not serve a log that holds this Mac. Pair again starts over; remove any entry this attempt left from another of your devices."
    /// What the person is told when this Mac cannot make its pairing string.
    public static let joinUnmadeAdvice = "This Mac cannot make its pairing string. Pair again to start over."
    /// The next step after a fault the person can do nothing about but try again.
    static let retryAdvice = "Retry, or quit Pardner and open it again."
    /// What the person is told when the relay was put back (security design 5.11).
    public static let putBackAdvice = "This relay was put back. Set up a new relay with pardner relay init under a new --instance name, or after moving the old relay's folder away, then pair this Mac again."
    /// What the person is told when the link faulted.
    public static let linkFaultAdvice = "The relay sent something that fails Pardner's checks. Set up a new relay with pardner relay init under a new --instance name, or after moving the old relay's folder away, then pair this Mac again."
    /// What the person is told when a write of what the app is sending failed (new channel design 5): the relay holds whatever it was given.
    public static let storeFailedAdvice = "Pardner could not save what it is sending (the disk may be full). Nothing was lost on the relay."
    /// What the person is told when the pairing file does not read.
    public static let malformedStoreWarning = "This Mac becomes a new device. Remove the old one from another of your devices."
    /// What the person is told when the pairing file is from a newer version of the app.
    public static let newerStoreAdvice = "This Mac's pairing file was written by a newer version of Pardner. Update Pardner."
}

/// The form of an input, refused before anything is written.
public enum PairingInputError: Error, Equatable {
    /// `host:port`, port 1 to 65535.
    case address
    /// 130 hex characters that are a point of P-256.
    case relayKey
    /// 64 hex characters.
    case enrolmentSecret
    /// 64 hex characters.
    case person
    /// A name a device may not carry: 1 to 64 bytes with no hidden character, no space at either end (design 3.4).
    case name
    /// The controller is in no phase that takes this.
    case notReady
}

public enum CancelOutcome: Sendable, Equatable {
    /// The keys, the link's state and the pairing are erased; the phase is `unpaired`.
    case erased
    /// The attempt is being abandoned and the phase becomes `unpaired` when it has been erased.
    case abandoning
    /// The relay can be reached and has not answered: its answer decides whether entry 0 was placed (design 3.5).
    case waitForAnswer
    /// The relay answers nothing: ask again with `confirmedUnreachable: true` once the person has read `PairingController.unreachableWarning`.
    case confirmUnreachable
    case notCancellable
    case failed(String)
}

public actor PairingController {
    /// The warning the second confirmation shows (design 3.5, the cancel row).
    public static let unreachableWarning = "The relay may already hold your first entry and then has an owner nobody holds. The way back is pardner relay init on a new directory, or later the recovery sheet."

    public typealias MakeHost = @Sendable (any KeyStore, RecoveryPerson) async throws -> ProtocolHost
    public typealias Connect = @Sendable (ProtocolHost, any KeyStore, Data, RelayEndpoint, LinkStore, Enrolment?, RecoverRequest?) throws -> any RelayLinking

    static let signName = "device.sign", receiveName = "device.receive", recoveryName = "recovery"

    let keys: any KeyStore & Sendable
    let pairing: PairingStore
    private let linkFolder: URL
    private let makeHost: MakeHost
    private let connect: Connect

    /// The state the views draw; every change is also yielded on `phases`.
    public internal(set) var phase: PairingPhase = .starting { didSet { phaseOut.yield(phase) } }
    /// Only the newest phase is kept: a view that reads late draws the state now, not the road to it.
    public nonisolated let phases: AsyncStream<PairingPhase>
    /// The reading model's input (app data design, 6): `reset` when a connection starts or the pairing's stores are erased, then every
    /// delivery and profile of the current connection in the order the link gave them. Unbounded, since a delivery dropped would be a
    /// message missing from the window; the app's `ConversationModel` reads it from launch, and a controller run with no reader keeps
    /// every delivery until it shuts down.
    public nonisolated let readings: AsyncStream<ReadingEvent>
    private let phaseOut: AsyncStream<PairingPhase>.Continuation
    private let readingOut: AsyncStream<ReadingEvent>.Continuation

    var host: ProtocolHost?
    var link: (any RelayLinking)?
    private var eventTask: Task<Void, Never>?
    var connectionID = 0
    var stored: PairingState?
    var cancelRequested = false
    private var launching = false
    var isShutDown = false
    // What a cancel while enrolling reads. A refusal stands until the person types the secret again (or a new attempt starts): a
    // dial does not clear it, since no later dial carries `enrol`. A refusal that arrives after a retype and before the next dial
    // answers a connection that never carried the new secret, so it is ignored.
    // "Asked the person" and "may cancel at once" are one fact, so one flag.
    private var refused = false
    private var secretRetyped = false
    // Whether a connection reached the relay since the last answer (design 3.5: wait while it can be reached).
    private var reachable = true
    // The join's screen, kept to say a refusal 2 on it (design 3.7).
    var joiningScreen: JoiningInfo?
    // The devices of the person (design 3.6, 3.9), in PairingController+Devices.swift.
    let clock: @Sendable () -> Date
    var snapshot: DeviceSnapshot?
    /// The device the pending entry adds; nil when it is a removal's. Not stored: every rest reads the kept entry and sets it again.
    var pendingAddDevice: Data?
    var acceptedOn: Int?
    var heldAtLength: Int?
    var gate = Gate()
    var attempt = RecoveryAttempt()
    /// The recovery keys given to the link for opening, in order, with the name each is held under; and the keys the person said they no longer have. Memory only.
    var heldRecovery: [(id: Data, name: String)] = []
    var gaveUp = Set<Data>()
    var earlierKeys = 0 // the n of `recovery.earlier.<n>`, from 1
    var atRest = false // a rest of this connection was seen: what the link read is all it will read until the log moves
    /// What the Devices screen reads; every change is also yielded on `deviceStates`.
    public internal(set) var deviceList = DevicesState() { didSet { deviceOut.yield(deviceList) } }
    public nonisolated let deviceStates: AsyncStream<DevicesState>
    let deviceOut: AsyncStream<DevicesState>.Continuation
    /// What the new-channel sheet and the sidebar read (new channel design 5); every change is also yielded on `channelStates`, newest only.
    public internal(set) var channels = ChannelsState() { didSet { channelOut.yield(channels) } }
    public nonisolated let channelStates: AsyncStream<ChannelsState>
    private let channelOut: AsyncStream<ChannelsState>.Continuation

    public init(keys: any KeyStore & Sendable, pairing: PairingStore, linkFolder: URL,
                makeHost: @escaping MakeHost = PairingController.bundledHost, connect: @escaping Connect = PairingController.relayConnection,
                clock: @escaping @Sendable () -> Date = { Date() }) {
        (self.keys, self.pairing, self.linkFolder, self.makeHost, self.connect, self.clock) = (keys, pairing, linkFolder, makeHost, connect, clock)
        (deviceStates, deviceOut) = AsyncStream.makeStream(of: DevicesState.self, bufferingPolicy: .bufferingNewest(1))
        (channelStates, channelOut) = AsyncStream.makeStream(of: ChannelsState.self, bufferingPolicy: .bufferingNewest(1))
        (phases, phaseOut) = AsyncStream.makeStream(of: PairingPhase.self, bufferingPolicy: .bufferingNewest(1))
        (readings, readingOut) = AsyncStream.makeStream(of: ReadingEvent.self)
    }

    /// The app's own script and a `RelayConnection`.
    public static func bundledHost(_ keys: any KeyStore, _ person: RecoveryPerson) async throws -> ProtocolHost { try await ProtocolHost(store: keys, person: person) }

    public static func relayConnection(_ host: ProtocolHost, _ keys: any KeyStore, _ person: Data, _ endpoint: RelayEndpoint, _ linkStore: LinkStore, _ enrolment: Enrolment?, _ recover: RecoverRequest?) throws -> any RelayLinking {
        try RelayConnection(host: host, store: keys, person: person, endpoint: endpoint, linkStore: linkStore, enrol: enrolment, recover: recover)
    }

    // MARK: launch (design 3.5 table, 3.10, 4.1)

    /// Decides the state from the pairing store and the keys; with a pairing past `keys-made` and its keys, it runs the relay connection.
    public func launch() async {
        guard case .starting = phase, !launching else { return }
        launching = true
        defer { launching = false }
        await decideLaunch()
    }

    private func decideLaunch() async {
        do {
            guard let state = try pairing.load() else {
                phase = keys.has(Self.signName) || keys.has(Self.receiveName)
                    ? .fault(.keysWithoutStore, "This Mac holds device keys that no pairing owns. Pair again makes it a new device; remove the old one from another device.")
                    : .unpaired(nil)
                return
            }
            switch state.stage {
            case .keysMade(.recover), .recovering, .recovered: try await launchRecovery(state)
            case .keysMade(let intent):
                // No sheet and no secret survive the stop (keys first, the store last): the attempt starts over.
                try await eraseAll()
                phase = .unpaired(intent == .enrol ? .staleSheet : nil) // `.recover` is taken above
            case .enrolling, .joining, .paired:
                guard keys.has(Self.signName), keys.has(Self.receiveName) else { return phase = .keysMissing }
                stored = state
                // The string is made again from the kept proof (signed once) before the connection starts: nothing it tells can land during this wait.
                let joining: JoiningInfo?
                if state.stage == .joining {
                    do { joining = try await joiningInfo(state) } catch {
                        return phase = .fault(.joinUnmade, PairingPhase.joinUnmadeAdvice) // `joining` stays on disk: Retry resumes it, Pair again starts over
                    }
                } else { joining = nil }
                try await startConnection(state, enrolment: nil) // a restart holds no enrolment secret: the proof decides
                guard !isShutDown else { return }
                switch state.stage {
                case .paired: phase = .paired
                case .joining: phase = .joining(joining!) // no await since the connection started: its first event finds this phase
                default: phase = .enrolling(asksSecret: false)
                }
            }
        } catch let fault as PairingFault {
            phase = fault.isNewerVersion
                ? .fault(.newerStore, PairingPhase.newerStoreAdvice)
                : .fault(.malformedStore, PairingPhase.malformedStoreWarning)
        } catch {
            phase = .fault(.failed, Problem.sentence("Pardner could not read its pairing", error, next: PairingPhase.retryAdvice))
        }
    }

    // MARK: setting up a new relay (design 3.5 steps 1 to 8)

    /// Steps 1 to 8: checks the form, writes `keys-made`, makes the keys, the recovery key and entry 0, waits for the sheet's answer, writes
    /// `enrolling` and starts the connection with the enrolment. Throws a `PairingInputError` before anything is written; any other error
    /// after the attempt was erased (or, once `enrolling` is written, left for the next launch to resume). A decline or a cancel ends it
    /// with no throw, in `unpaired`.
    public func setUp(address: String, relayKey: String, enrolmentSecret: String) async throws {
        guard case .unpaired = phase else { throw PairingInputError.notReady }
        let relay = try Self.relay(address: address, key: relayKey)
        let secret = try Self.secret(enrolmentSecret)
        phase = .settingUp
        cancelRequested = false
        var state = PairingState(stage: .keysMade(.enrol), relay: relay)
        do {
            try pairing.write(state) // before the keys: keys with no store are a fault, never left-overs (step 2)
            _ = try keys.make(Self.signName, .sign)
            _ = try keys.make(Self.receiveName, .receive)
            let host = try await hostMade()
            let recovery = try await host.createRecovery(Self.recoveryName)
            let genesis = try await host.buildGenesis(
                signing: try keys.publicKey(Self.signName), receiving: try keys.publicKey(Self.receiveName),
                recoverySigning: recovery.signing, recoveryReceiving: recovery.receiving)
            // Nothing that carries entry 0 is written before the sheet is confirmed (step 4).
            guard !cancelRequested else { return await abandon() }
            let context = "Person: \(StoreDisk.hex(genesis.id))\nRelay: \(relay.address)\nRelay key: \(StoreDisk.hex(relay.key))"
            let confirmed = try await host.showRecovery(Self.recoveryName, context: context)
            guard confirmed, !cancelRequested else { return await abandon() }
            state.stage = .enrolling
            (state.person, state.genesis) = (genesis.id, genesis)
            try pairing.write(state)
            stored = state
            do {
                try await startConnection(state, enrolment: Enrolment(secret: secret, signed: genesis.signed, sig: genesis.sig))
            } catch {
                // `enrolling` is on disk: the next launch resumes
                phase = .fault(.failed, Problem.sentence("Pardner could not connect to the relay", error, next: "Retry: the setup goes on where it stopped."))
                throw error
            }
            phase = .enrolling(asksSecret: false)
        } catch let error where stored?.stage != .enrolling {
            host = nil // a host that failed is over for good: the next setup makes its own
            await abandon()
            throw error
        }
    }

    /// The person typed the enrolment secret again after the relay refused it (or after a restart): sent on a new dial.
    /// False when the connection could not take it; the phase is then unchanged.
    public func retypeSecret(_ text: String) async throws -> Bool {
        guard case .enrolling = phase, let link, let genesis = stored?.genesis else { throw PairingInputError.notReady }
        let secret = try Self.secret(text)
        guard await link.enrol(Enrolment(secret: secret, signed: genesis.signed, sig: genesis.sig)) else { return false }
        (refused, secretRetyped) = (false, true) // a refusal before this one says nothing of the new secret
        phase = .enrolling(asksSecret: false)
        return true
    }

    // MARK: cancel (design 3.5, the table's cancel row)

    /// Cancels the setup. While the sheet or the keys are being made, the attempt is abandoned. While enrolling: at once after a refusal 2;
    /// when the relay answers nothing, on a second confirmation; otherwise it waits for the relay's answer.
    public func cancel(confirmedUnreachable: Bool = false) async -> CancelOutcome {
        switch phase {
        case .settingUp:
            cancelRequested = true
            return .abandoning
        case .showingSheet(let request):
            cancelRequested = true
            request.answer(false)
            return .abandoning
        case .recovering:
            return await cancelRecovery()
        case .joining:
            return await eraseForCancel() // the add that lands later names a device nobody holds: the person removes it (design 3.7, step 5)
        case .enrolling:
            if refused { return await eraseForCancel() }
            guard !reachable else { return .waitForAnswer }
            return confirmedUnreachable ? await eraseForCancel() : .confirmUnreachable
        default:
            return .notCancellable
        }
    }

    private func eraseForCancel() async -> CancelOutcome {
        do {
            try await eraseAll()
            phase = .unpaired(nil)
            return .erased
        } catch {
            phase = .fault(.failed, Problem.sentence("Pardner could not erase the setup", error, next: PairingPhase.retryAdvice))
            return .failed(Problem.reason(error))
        }
    }

    // MARK: removed, and pairing again (design 3.10, 4.1)

    /// Erases the keys, the link's state and the pairing, in that order, and returns to the first screen. Only from `removed`,
    /// `keysMissing`, a put-back relay (security design 5.11), a link fault, a pairing file that does not read (not one of a newer app), keys with no pairing and a join whose log did not hold this Mac (design 4.1); false otherwise, and false with the fault shown
    /// when an erase failed. A transient fault never offers it (the relay may hold the device): it offers `retry()`.
    /// Nothing is erased without this call.
    @discardableResult
    public func pairAgain() async -> Bool {
        switch phase {
        case .removed, .keysMissing, .putBack, .linkFaulted, .fault(.malformedStore, _), .fault(.keysWithoutStore, _), .fault(.joinMismatch, _), .fault(.joinUnmade, _): break
        default: return false
        }
        do {
            try await eraseAll()
            phase = .unpaired(nil)
            return true
        } catch {
            phase = .fault(.failed, Problem.sentence("Pardner could not erase the pairing", error, next: PairingPhase.retryAdvice))
            return false
        }
    }

    /// Runs the launch again from the store, after a transient fault: the connection is ended, the host made anew, and the state
    /// resumes as the launch table says. Nothing is erased. False from any other phase, and while a launch or another retry runs.
    /// Refused from `putBack` (the link store keeps the mark, so a new link ends at once) and from `linkFaulted` (the relay's fault would come again).
    @discardableResult
    public func retry() async -> Bool {
        switch phase {
        case .fault(.failed, _), .fault(.joinUnmade, _): break
        default: return false
        }
        guard !launching else { return false }
        launching = true // claimed before the first await: a second retry meets it
        defer { launching = false }
        await stopConnection()
        host = nil
        stored = nil
        phase = .starting
        await decideLaunch()
        return true
    }

    /// Sends one item through the running connection; a submit answered removed (5) is this device removed.
    public func submit(kind: UInt8, signed: Data, sig: Data) async throws -> SubmitOutcome {
        guard let link else { return .ended }
        let outcome = try await link.submit(kind: kind, signed: signed, sig: sig)
        if outcome == .code(5), removable { await markRemoved() }
        return outcome
    }

    /// Makes a channel bound to `folder` through the running connection (new channel design 3.2); the link's `creating` effect puts it
    /// in `channels.creating`, and takes it out when it is read back or refused.
    public func createChannel(bot: Data, folder: String) async throws -> CreateOutcome {
        guard let link else { return .ended }
        return try await link.createChannel(bot: bot, folder: folder)
    }

    /// Queues one message in a channel's outbox through the running connection (new channel design 3.3).
    public func send(channel: Data, draft: OutboxDraft) async throws -> SendOutcome {
        guard let link else { return .ended }
        return try await link.send(channel: channel, draft: draft)
    }

    /// The screen took these refused items of `channel` (`ChannelsState.undelivered`): they are not kept any longer.
    public func acknowledgeUndelivered(channel: Data, names: Set<Data>) {
        guard let kept = channels.undelivered[channel] else { return }
        let rest = kept.filter { !names.contains($0.name) }
        channels.undelivered[channel] = rest.isEmpty ? nil : rest
    }

    /// Ends the connection and declines a sheet on screen: the app is quitting. Nothing is erased.
    public func shutdown() async {
        cancelRequested = true
        isShutDown = true
        if case .showingSheet(let request) = phase { request.answer(false) }
        if case .recovering(.typeKey(let request)) = phase { request.answer(false) }
        await stopConnection()
        phaseOut.finish()
        readingOut.finish()
        deviceOut.finish()
        channelOut.finish()
    }

    // MARK: the connection's events

    private func handle(_ event: RelayEvent, _ id: Int) async {
        guard id == connectionID else { return }
        // Before any suspension below: a stop or an erase that runs in one of them moves `connectionID` first, so nothing of this
        // connection is yielded after the next `reset`.
        switch event {
        case .delivered(let view): readingOut.yield(.delivered(view))
        case .profile(let profile): readingOut.yield(.profile(profile))
        default: break
        }
        // The channel state is set before any suspension below too: a stop that runs in one moves `connectionID` first.
        switch event {
        case .outbox(let effect): outboxChanged(effect)
        case .creating(let effect): creationChanged(effect)
        case .channelRefused(let effect): creationRefused(effect)
        case .channelFault(let effect): if let channel = effect["channel"]?.bytesValue { channels.faulted.insert(channel) }
        case .channelFaultDropped(let effect): if let channel = effect["channel"]?.bytesValue { channels.faulted.remove(channel) }
        default: break
        }
        switch event {
        case .dialing:
            atRest = false // a new dial reads again from the cursor: nothing is declared from the partial read before the next rest
            secretRetyped = false // `refused` stays until the person types the secret again: no later dial carries `enrol`
        case .reached: reachable = true
        case .unreached: reachable = false
        case .enrolled: await becomePaired()
        // The link gives `enrol-refused` and then the delivered `refused 2`: the person is asked once (the app-link ledger, "For P3").
        case .enrolRefused: askForSecret()
        case .recoveryLog(let effect): await recoveryLogRead(effect)
        case .recovery(let outcome): await recoveryAnswered(outcome)
        case .recovered: await recoveryPlaced()
        case .devices(let effect):
            reachable = true
            await becomePaired() // a restart never gets `enrolled`: the first reading effect says entry 0 was placed
            await devicesRead(effect)
        case .delivered(let view):
            reachable = true
            switch (view["do"]?.stringValue, view["reason"]?.numberValue.map(Int.init)) {
            case ("rest", _):
                await becomePaired()
                atRest = true
                await evaluateRecovery()
                await settle() // every rest: a pending entry is read back, sent again or rebuilt (design 3.6)
            case ("refused", 2?) where stored?.stage == .enrolling: askForSecret()
            case ("refused", 2?) where stored?.stage == .joining: waitForAdd()
            case ("refused", 1?) where removable: await markRemoved()
            case ("put-back", _): await linkEnded(.putBack(PairingPhase.putBackAdvice))
            case ("fault", _): await linkEnded(.linkFaulted(PairingPhase.linkFaultAdvice))
            default: break
            }
        case .storeFailed:
            // Not the relay's fault: Retry builds a new connection, which loads the app outbox again (new channel design 3.1).
            await stopConnection()
            phase = .fault(.failed, PairingPhase.storeFailedAdvice)
        case .faulted(let message): await hostFaulted(message)
        case .profile, .outbox, .creating, .channelRefused, .channelFault, .channelFaultDropped: break
        }
    }

    /// A channel's items as the link lists them now; a channel with none is dropped.
    private func outboxChanged(_ effect: HostValue) {
        guard let channel = effect["channel"]?.bytesValue else { return }
        let rows = (effect["items"]?.arrayValue ?? []).compactMap { item -> OutboxItemRow? in
            guard let name = item["name"]?.bytesValue, let kind = item["kind"]?.numberValue,
                  let state = item["state"]?.stringValue.flatMap(OutboxItemState.init(rawValue:)) else { return nil }
            let re = item["re"].flatMap { r in r["device"]?.bytesValue.flatMap { d in r["name"]?.bytesValue.map { MessageReference(device: d, name: $0) } } }
            return OutboxItemRow(name: name, kind: Int(kind), to: item["to"]?.bytesValue, re: re, content: item["content"]?.stringValue ?? "", state: state)
        }
        channels.outboxes[channel] = rows.isEmpty ? nil : rows
        var kept = channels.undelivered[channel] ?? []
        let known = Set(kept.map(\.name))
        let refused = rows.filter { $0.state == .refused && !known.contains($0.name) }
        if !refused.isEmpty {
            kept += refused
            channels.undelivered[channel] = kept
        }
    }

    private func creationRefused(_ effect: HostValue) {
        guard let channel = effect["channel"]?.bytesValue, let code = effect["code"]?.numberValue else { return }
        channels.refusal = CreationRefusal(channel: channel, code: Int(code))
    }

    /// The link's `creating` effect: the channel being created with its bot and folder, or none. A new creation clears the last refusal.
    private func creationChanged(_ effect: HostValue) {
        guard let channel = effect["channel"]?.bytesValue, let bot = effect["bot"]?.bytesValue, let folder = effect["folder"]?.stringValue else {
            channels.creating = nil
            return
        }
        channels.refusal = nil
        channels.creating = PendingChannel(channel: channel, bot: bot, folder: folder)
    }

    /// A host that faulted is over for good: the next action makes a new one.
    func hostFaulted(_ message: String) async {
        await dropRecoveryKeys()
        host = nil
        await stopConnection()
        phase = .fault(.failed, message)
    }

    /// The link delivered a final view and ended: nothing is erased.
    private func linkEnded(_ ended: PairingPhase) async {
        await dropRecoveryKeys()
        await stopConnection()
        phase = ended
    }

    private func askForSecret() {
        guard !secretRetyped else { return } // it answers a connection that did not carry the new secret
        refused = true
        guard phase != .enrolling(asksSecret: true) else { return } // the link gives `enrol-refused` and `refused 2` for one refusal
        phase = .enrolling(asksSecret: true)
    }

    /// Entry 0 is placed: the pairing's stage moves on, the entry and its signature are dropped from the store.
    private func becomePaired() async {
        guard var state = stored, state.stage == .enrolling else { return }
        state.stage = .paired
        state.genesis = nil
        do {
            try pairing.write(state)
        } catch {
            phase = .fault(.failed, Problem.sentence("Pardner could not save the pairing", error, next: PairingPhase.retryAdvice))
            return
        }
        stored = state
        phase = .paired
    }

    /// A stage whose device the relay may refuse as removed (design 3.10, recovery design 2.5).
    var removable: Bool { [.paired, .joining, .recovering, .recovered].contains(stored?.stage) }

    func markRemoved() async {
        await dropRecoveryKeys() // a removal is a stop of a recovery too (recovery design 2.2)
        await stopConnection()
        phase = .removed
    }

    // MARK: the pieces

    func hostMade() async throws -> ProtocolHost {
        if let host { return host }
        // Both closures run on the host's thread. `show` blocks it until the view answers, so the request goes to the actor from a task.
        let person = RecoveryPerson(show: { [weak self] secret, context in
            guard let self else { return false }
            let gate = SheetGate()
            let request = RecoverySheetRequest(context: context, secret: secret, gate: gate)
            Task { await self.present(request) }
            return gate.wait()
        }, enter: { [weak self] secret in
            guard let self else { return nil }
            let gate = SheetGate()
            let request = RecoveryEntryRequest(gate: gate)
            Task { await self.presentEntry(request) }
            guard gate.wait() else { return nil }
            defer { request.entry.wipe() }
            do { try request.entry.read(into: secret) } catch { return nil } // a key that does not read is a decline
            return 32
        })
        let made = try await makeHost(keys, person)
        forgetHeldKeys() // a new host holds none of the recovery keys the last one did
        host = made
        return made
    }

    /// The sheet reached the actor: shown, or declined when the attempt is already over.
    private func present(_ request: RecoverySheetRequest) {
        switch phase {
        case .settingUp, .recovering(.starting): break
        default: return request.answer(false)
        }
        guard !cancelRequested else { return request.answer(false) }
        phase = .showingSheet(request)
    }

    func startConnection(_ state: PairingState, enrolment: Enrolment?, recover: RecoverRequest? = nil) async throws {
        guard let person = state.person else { throw PairingFault(description: "the pairing holds no person") }
        let host = try await hostMade()
        guard !isShutDown else { return } // the app quit while the host was made: no connection starts after the streams finished
        let linkStore = try LinkStore(folder: linkFolder, identity: LinkIdentity(
            signing: try keys.publicKey(Self.signName), receiving: try keys.publicKey(Self.receiveName), relay: state.relay.key))
        let connection = try connect(host, keys, person, RelayEndpoint(host: state.relay.host, port: state.relay.port, pin: state.relay.key), linkStore, enrolment, recover)
        connectionID += 1
        atRest = false
        forgetHeldKeys() // a new link holds no recovery key
        let id = connectionID
        // The new link reads the sequence from position 0: the model starts empty and is rebuilt in order, rather than patched one
        // position at a time over what the last connection drew (a rebuild of the channel per message).
        readingOut.yield(.reset)
        link = connection
        (refused, secretRetyped, reachable) = (false, false, true)
        (snapshot, acceptedOn, heldAtLength) = (nil, nil, nil)
        let events = connection.events
        eventTask = Task { [weak self] in for await event in events { await self?.handle(event, id) } }
        connection.start()
    }

    /// The connection ended and its store given back, so the link's files can be erased.
    func stopConnection() async {
        connectionID += 1
        atRest = false
        // What an ended connection told is not the next one's, except the refusals the screen has not taken: a stop must not lose them (`eraseAll` does).
        let untaken = channels.undelivered
        channels = ChannelsState()
        channels.undelivered = untaken
        eventTask?.cancel()
        eventTask = nil
        let ended = link
        link = nil
        await ended?.stop()
    }

    /// A decline, a cancel or a stop before step 6: the held secret wiped, then the keys, the link's state and the pairing (design 3.5).
    /// After `shutdown()` only the held secret is wiped: the process is exiting, so the keys and the store stay for the next launch, which
    /// erases them and says the sheet opens nothing (3.5).
    func abandon() async {
        try? await host?.deleteKey(Self.recoveryName)
        guard !isShutDown else { return }
        do {
            try await eraseAll()
            phase = .unpaired(nil)
        } catch {
            phase = .fault(.failed, Problem.sentence("Pardner could not erase the pairing", error, next: PairingPhase.retryAdvice))
        }
    }

    /// Keys first, the link's state, the pairing last: a stop between leaves a store that the next launch reads again. It takes its turn
    /// on the devices queue, so an act that copied the store and waits on the link cannot write it back after the erase.
    func eraseAll(keepingPairing: Bool = false) async throws {
        try await serially {
            await stopConnection()
            await dropRecoveryKeys()
            // Once the connection is stopped nothing of it is yielded again; the next pairing may read another person's sequence, so
            // nothing read under this one stays drawn, even when an erase below fails.
            readingOut.yield(.reset)
            for name in [Self.signName, Self.receiveName] where keys.has(name) { try keys.delete(name) }
            try LinkStore.erase(folder: linkFolder)
            if !keepingPairing { try pairing.erase() }
            stored = nil
            (snapshot, joiningScreen, deviceList, channels) = (nil, nil, DevicesState(), ChannelsState())
        }
    }

    // MARK: the form's checks (design 3.5 step 1)

    static func relay(address: String, key: String) throws -> PairingRelay {
        let text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let (host, port) = hostAndPort(text) else { throw PairingInputError.address }
        guard let bytes = hexBytes(key, 65), (try? P256.Signing.PublicKey(x963Representation: bytes)) != nil else { throw PairingInputError.relayKey }
        return PairingRelay(host: host, port: port, key: bytes)
    }

    /// `host:port` with a host name or an IPv4 address, or `[IPv6]:port`; the port 1 to 65535. Nothing else: no scheme, no path.
    private static func hostAndPort(_ text: String) -> (String, UInt16)? {
        let host: Substring, portText: Substring
        if text.hasPrefix("[") {
            guard let close = text.firstIndex(of: "]"), text.index(after: close) < text.endIndex, text[text.index(after: close)] == ":" else { return nil }
            host = text[text.index(after: text.startIndex)..<close]
            portText = text[text.index(close, offsetBy: 2)...]
            guard IPv6Address(String(host)) != nil else { return nil }
        } else {
            let parts = text.split(separator: ":", omittingEmptySubsequences: false)
            guard parts.count == 2 else { return nil }
            (host, portText) = (parts[0], parts[1])
            let name = host.split(separator: ".", omittingEmptySubsequences: false)
            // Labels of letters, digits and hyphens, none empty and none starting or ending with a hyphen: an IPv4 address is one.
            guard !host.isEmpty, name.allSatisfy({ !$0.isEmpty && !$0.hasPrefix("-") && !$0.hasSuffix("-") && $0.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") } }) else { return nil }
        }
        guard !portText.isEmpty, portText.allSatisfy({ $0.isASCII && $0.isNumber }), let port = UInt16(portText), port > 0 else { return nil }
        return (String(host), port)
    }

    static func secret(_ text: String) throws -> Data {
        guard let bytes = hexBytes(text, 32) else { throw PairingInputError.enrolmentSecret }
        return bytes
    }

    static func hexBytes(_ text: String, _ count: Int) -> Data? {
        let digits = Array(text.trimmingCharacters(in: .whitespacesAndNewlines).utf8)
        guard digits.count == count * 2 else { return nil }
        var out = Data()
        for pair in stride(from: 0, to: digits.count, by: 2) {
            guard let high = nibble(digits[pair]), let low = nibble(digits[pair + 1]) else { return nil }
            out.append(high << 4 | low)
        }
        return out
    }

    private static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30
        case 0x61...0x66: return c - 0x61 + 10
        case 0x41...0x46: return c - 0x41 + 10
        default: return nil
        }
    }
}
