// The app's pairing, as the views drive it (device pairing design 3.5, 3.8, 3.10, 4.1): which state this Mac is in at launch,
// the first device's setup from the form to `paired`, the recovery sheet as a request the view answers, the cancel rules and the
// removed device. No view lives here. One actor holds the state, so a cancel, a sheet's answer and the connection's events take
// turns; the enrolment secret is held in memory for the length of a call and never stored or logged.
import CryptoKit
import Foundation
import Network
import Platform
import ProtocolHost

/// The connection the controller runs: `RelayConnection`, or a stand-in in a test.
public protocol RelayLinking: AnyObject, Sendable {
    var events: AsyncStream<RelayEvent> { get }
    func start()
    func stop() async
    func enrol(_ enrolment: Enrolment) async -> Bool
    func submit(kind: UInt8, signed: Data, sig: Data) async throws -> SubmitOutcome
}

extension RelayConnection: RelayLinking {}

/// What the person is told on the first screen besides the two choices.
public enum UnpairedNote: Sendable, Equatable {
    /// A sheet written for the attempt that stopped opens nothing: the enrolment secret was in memory only (design 3.5).
    case staleSheet
}

public enum PairingFaultKind: Sendable, Equatable {
    /// The pairing file does not read: the only action is Pair again, with a warning (design 4.1).
    case malformedStore
    /// The pairing file was written by a newer version of the app: nothing is erased and no action is offered; the person updates Pardner (design 4.1).
    case newerStore
    /// The keys are here and no pairing says they are this Mac's: the only action is Pair again (design 4.1).
    case keysWithoutStore
    /// A store at `joining`, which a later pull request handles (design 3.7).
    case joinUnsupported
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

extension PairingPhase {
    /// What the person is told when the relay was put back (security design 5.11).
    public static let putBackAdvice = "This relay was put back. Set up a new relay with pardner relay init under a new --instance name, or after moving the old relay's folder away, then pair this Mac again."
    /// What the person is told when the link faulted.
    public static let linkFaultAdvice = "The relay sent something that fails Pardner's checks. Set up a new relay with pardner relay init under a new --instance name, or after moving the old relay's folder away, then pair this Mac again."
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
    public typealias Connect = @Sendable (ProtocolHost, any KeyStore, Data, RelayEndpoint, LinkStore, Enrolment?) throws -> any RelayLinking

    static let signName = "device.sign", receiveName = "device.receive", recoveryName = "recovery"

    private let keys: any KeyStore & Sendable
    private let pairing: PairingStore
    private let linkFolder: URL
    private let makeHost: MakeHost
    private let connect: Connect

    /// The state the views draw; every change is also yielded on `phases`.
    public private(set) var phase: PairingPhase = .starting { didSet { phaseOut.yield(phase) } }
    /// Only the newest phase is kept: a view that reads late draws the state now, not the road to it.
    public nonisolated let phases: AsyncStream<PairingPhase>
    /// What the connection tells, after the controller has read it: the reading model's input. Nothing reads it yet; the bound keeps
    /// an unread stream from growing, and the reading model that takes it will read it as events arrive.
    public nonisolated let relayEvents: AsyncStream<RelayEvent>
    private let phaseOut: AsyncStream<PairingPhase>.Continuation
    private let eventOut: AsyncStream<RelayEvent>.Continuation

    private var host: ProtocolHost?
    private var link: (any RelayLinking)?
    private var eventTask: Task<Void, Never>?
    private var connectionID = 0
    private var stored: PairingState?
    private var cancelRequested = false
    private var launching = false
    private var isShutDown = false
    // What a cancel while enrolling reads. A refusal stands until the person types the secret again (or a new attempt starts): a
    // dial does not clear it, since no later dial carries `enrol`. A refusal that arrives after a retype and before the next dial
    // answers a connection that never carried the new secret, so it is ignored.
    // "Asked the person" and "may cancel at once" are one fact, so one flag.
    private var refused = false
    private var secretRetyped = false
    // Whether a connection reached the relay since the last answer (design 3.5: wait while it can be reached).
    private var reachable = true

    public init(keys: any KeyStore & Sendable, pairing: PairingStore, linkFolder: URL,
                makeHost: @escaping MakeHost = PairingController.bundledHost, connect: @escaping Connect = PairingController.relayConnection) {
        (self.keys, self.pairing, self.linkFolder, self.makeHost, self.connect) = (keys, pairing, linkFolder, makeHost, connect)
        (phases, phaseOut) = AsyncStream.makeStream(of: PairingPhase.self, bufferingPolicy: .bufferingNewest(1))
        (relayEvents, eventOut) = AsyncStream.makeStream(of: RelayEvent.self, bufferingPolicy: .bufferingNewest(256))
    }

    /// The app's own script and a `RelayConnection`.
    public static func bundledHost(_ keys: any KeyStore, _ person: RecoveryPerson) async throws -> ProtocolHost { try await ProtocolHost(store: keys, person: person) }

    public static func relayConnection(_ host: ProtocolHost, _ keys: any KeyStore, _ person: Data, _ endpoint: RelayEndpoint, _ linkStore: LinkStore, _ enrolment: Enrolment?) throws -> any RelayLinking {
        try RelayConnection(host: host, store: keys, person: person, endpoint: endpoint, linkStore: linkStore, enrol: enrolment)
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
            case .keysMade(let intent):
                // No sheet and no secret survive the stop (keys first, the store last): the attempt starts over.
                try await eraseAll()
                phase = .unpaired(intent == .enrol ? .staleSheet : nil)
            case .joining:
                phase = .fault(.joinUnsupported, "This Mac was joining a relay; joining is not in this version. Pair again starts over.")
            case .enrolling, .paired:
                guard keys.has(Self.signName), keys.has(Self.receiveName) else { return phase = .keysMissing }
                stored = state
                try await startConnection(state, enrolment: nil) // a restart holds no enrolment secret: the proof decides
                guard !isShutDown else { return }
                phase = state.stage == .paired ? .paired : .enrolling(asksSecret: false)
            }
        } catch let fault as PairingFault {
            phase = fault.isNewerVersion
                ? .fault(.newerStore, PairingPhase.newerStoreAdvice)
                : .fault(.malformedStore, PairingPhase.malformedStoreWarning)
        } catch {
            phase = .fault(.failed, "\(error)")
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
            let context = "Person: \(StoreDisk.hex(genesis.id))\nRelay: \(relay.host):\(relay.port)\nRelay key: \(StoreDisk.hex(relay.key))"
            let confirmed = try await host.showRecovery(Self.recoveryName, context: context)
            guard confirmed, !cancelRequested else { return await abandon() }
            state.stage = .enrolling
            (state.person, state.genesis) = (genesis.id, genesis)
            try pairing.write(state)
            stored = state
            do {
                try await startConnection(state, enrolment: Enrolment(secret: secret, signed: genesis.signed, sig: genesis.sig))
            } catch {
                phase = .fault(.failed, "\(error)") // `enrolling` is on disk: the next launch resumes
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
            phase = .fault(.failed, "\(error)")
            return .failed("\(error)")
        }
    }

    // MARK: removed, and pairing again (design 3.10, 4.1)

    /// Erases the keys, the link's state and the pairing, in that order, and returns to the first screen. Only from `removed`,
    /// `keysMissing`, a put-back relay (security design 5.11), a link fault, a pairing file that does not read (not one of a newer app), keys with no pairing and a store at `joining` (design 4.1); false otherwise, and false with the fault shown
    /// when an erase failed. A transient fault never offers it (the relay may hold the device): it offers `retry()`.
    /// Nothing is erased without this call.
    @discardableResult
    public func pairAgain() async -> Bool {
        switch phase {
        case .removed, .keysMissing, .putBack, .linkFaulted, .fault(.malformedStore, _), .fault(.keysWithoutStore, _), .fault(.joinUnsupported, _): break
        default: return false
        }
        do {
            try await eraseAll()
            phase = .unpaired(nil)
            return true
        } catch {
            phase = .fault(.failed, "\(error)")
            return false
        }
    }

    /// Runs the launch again from the store, after a transient fault: the connection is ended, the host made anew, and the state
    /// resumes as the launch table says. Nothing is erased. False from any other phase, and while a launch or another retry runs.
    /// Refused from `putBack` (the link store keeps the mark, so a new link ends at once) and from `linkFaulted` (the relay's fault would come again).
    @discardableResult
    public func retry() async -> Bool {
        guard case .fault(.failed, _) = phase, !launching else { return false }
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
        if outcome == .code(5), stored?.stage == .paired { await markRemoved() }
        return outcome
    }

    /// Ends the connection and declines a sheet on screen: the app is quitting. Nothing is erased.
    public func shutdown() async {
        cancelRequested = true
        isShutDown = true
        if case .showingSheet(let request) = phase { request.answer(false) }
        await stopConnection()
        phaseOut.finish()
        eventOut.finish()
    }

    // MARK: the connection's events

    private func handle(_ event: RelayEvent, _ id: Int) async {
        guard id == connectionID else { return }
        eventOut.yield(event)
        switch event {
        case .dialing: secretRetyped = false // `refused` stays until the person types the secret again: no later dial carries `enrol`
        case .reached: reachable = true
        case .unreached: reachable = false
        case .enrolled: await becomePaired()
        // The link gives `enrol-refused` and then the delivered `refused 2`: the person is asked once (the app-link ledger, "For P3").
        case .enrolRefused: askForSecret()
        case .devices:
            reachable = true
            await becomePaired() // a restart never gets `enrolled`: the first reading effect says entry 0 was placed
        case .delivered(let view):
            reachable = true
            switch (view["do"]?.stringValue, view["reason"]?.numberValue.map(Int.init)) {
            case ("rest", _): await becomePaired()
            case ("refused", 2?) where stored?.stage == .enrolling: askForSecret()
            case ("refused", 1?) where stored?.stage == .paired: await markRemoved()
            case ("put-back", _): await linkEnded(.putBack(PairingPhase.putBackAdvice))
            case ("fault", _): await linkEnded(.linkFaulted(PairingPhase.linkFaultAdvice))
            default: break
            }
        case .faulted(let message):
            host = nil // a faulted host is over for good: the next action makes a new one
            await stopConnection()
            phase = .fault(.failed, message)
        case .profile: break
        }
    }

    /// The link delivered a final view and ended: nothing is erased.
    private func linkEnded(_ ended: PairingPhase) async {
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
            phase = .fault(.failed, "\(error)")
            return
        }
        stored = state
        phase = .paired
    }

    private func markRemoved() async {
        await stopConnection()
        phase = .removed
    }

    // MARK: the pieces

    private func hostMade() async throws -> ProtocolHost {
        if let host { return host }
        // Both closures run on the host's thread. `show` blocks it until the view answers, so the request goes to the actor from a task.
        let person = RecoveryPerson(show: { [weak self] secret, context in
            guard let self else { return false }
            let gate = SheetGate()
            let request = RecoverySheetRequest(context: context, secret: secret, gate: gate)
            Task { await self.present(request) }
            return gate.wait()
        }, enter: { _ in nil })
        let made = try await makeHost(keys, person)
        host = made
        return made
    }

    /// The sheet reached the actor: shown, or declined when the attempt is already over.
    private func present(_ request: RecoverySheetRequest) {
        guard case .settingUp = phase, !cancelRequested else { return request.answer(false) }
        phase = .showingSheet(request)
    }

    private func startConnection(_ state: PairingState, enrolment: Enrolment?) async throws {
        guard let person = state.person else { throw PairingFault(description: "the pairing holds no person") }
        let host = try await hostMade()
        guard !isShutDown else { return } // the app quit while the host was made: no connection starts after the streams finished
        let linkStore = try LinkStore(folder: linkFolder, identity: LinkIdentity(
            signing: try keys.publicKey(Self.signName), receiving: try keys.publicKey(Self.receiveName), relay: state.relay.key))
        let connection = try connect(host, keys, person, RelayEndpoint(host: state.relay.host, port: state.relay.port, pin: state.relay.key), linkStore, enrolment)
        connectionID += 1
        let id = connectionID
        link = connection
        (refused, secretRetyped, reachable) = (false, false, true)
        let events = connection.events
        eventTask = Task { [weak self] in for await event in events { await self?.handle(event, id) } }
        connection.start()
    }

    /// The connection ended and its store given back, so the link's files can be erased.
    private func stopConnection() async {
        connectionID += 1
        eventTask?.cancel()
        eventTask = nil
        let ended = link
        link = nil
        await ended?.stop()
    }

    /// A decline, a cancel or a stop before step 6: the held secret wiped, then the keys, the link's state and the pairing (design 3.5).
    /// After `shutdown()` only the held secret is wiped: the process is exiting, so the keys and the store stay for the next launch, which
    /// erases them and says the sheet opens nothing (3.5).
    private func abandon() async {
        try? await host?.deleteKey(Self.recoveryName)
        guard !isShutDown else { return }
        do {
            try await eraseAll()
            phase = .unpaired(nil)
        } catch {
            phase = .fault(.failed, "\(error)")
        }
    }

    /// Keys first, the link's state, the pairing last: a stop between leaves a store that the next launch reads again.
    private func eraseAll() async throws {
        await stopConnection()
        for name in [Self.signName, Self.receiveName] where keys.has(name) { try keys.delete(name) }
        try LinkStore.erase(folder: linkFolder)
        try pairing.erase()
        stored = nil
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

    private static func hexBytes(_ text: String, _ count: Int) -> Data? {
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
