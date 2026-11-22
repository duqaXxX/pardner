// Recovery with the recovery key (recovery design 2.1 to 2.5, 2.7): from the typed key to the reset placed, as the views drive it. The
// order is the design's: the keys, the key typed, the reading connection, the two questions, the reset's inputs stored, then a
// connection that tries the device and, failing that, the recovery key until the relay serves it. No secret is stored: a restart asks
// for the key again. Opening the past and "done" (2.6) are not here.
import Foundation
import Platform
import ProtocolHost

/// Why the typed recovery key cannot go on (recovery design 2.5).
public enum RecoveryRefusal: Sendable, Equatable {
    /// The relay does not know the person id or its own address was wrong (refusal 2).
    case unknownPerson
    /// The relay holds another recovery key (refusal 3): the person may type another.
    case notCurrent
    /// The key is the new one made in a recovery that stopped: it opens nothing.
    case madeEarlier
    /// After a reset was stored, this key is not the one that started it: the person is asked for that one.
    case notTheStartKey
    /// The reset was stored and neither this device nor the key is accepted any longer.
    case noLongerCurrent
    /// After a reset was stored the relay says it does not know the person (refusal 2).
    case personGone
    /// After a reset was stored, the key typed is the reset's own new key: it is not the one that started the recovery.
    case yourNewKey
    /// After a reset was stored, no key was given (the person declined, or the key did not read): nothing is erased and the key may be typed again.
    case notTyped
}

/// Where a recovery waits (recovery design 2.3).
public enum RecoveryStep: Sendable, Equatable {
    /// The device keys are made, or the connection is being set up.
    case starting
    /// The host waits for the recovery key typed in the request.
    case typeKey(RecoveryEntryRequest)
    /// The reading connection proves with the key and reads the device log.
    case reading
    /// `Could someone else have one of your devices?`, with how many other devices the log holds active.
    case askDevices(others: Int)
    /// `Make a new recovery key?`
    case askNewKey
    /// The reset's inputs are stored and the connection tries until the relay serves this device.
    case sending
    /// The reset is placed and the link reads the past; done is not yet declared and nothing is known to wait.
    case placed
    /// The past is being opened: what done still waits on (recovery design 2.6).
    case opening(RecoveryProgress)
    /// Done (2.6): the recovery keys are put away, the store is `paired`, and the person is told which keys can be destroyed.
    case done(RecoveryDone)
    case refused(RecoveryRefusal)
}

/// What a recovery run holds in memory only, until its inputs are stored at step 6.
struct RecoveryAttempt {
    var key: Data?
    var active: [Data] = []
    var previous: [Data] = []
    var keepOthers: Bool?
}

extension PairingController {
    static let enteredName = "recovery.entered", nextName = "recovery.next"

    // MARK: starting (2.1 to 2.3, steps 1 to 3)

    /// Checks the three public values the recovery key's Copy gave, writes `keys-made` with the ids of keys made in recoveries that stopped,
    /// makes the device keys and waits for the key to be typed. A `PairingInputError` before anything is written; a decline or a cancel ends it in `unpaired`.
    public func startRecovery(person: String, address: String, relayKey: String) async throws {
        let before = phase
        switch before {
        case .unpaired, .removed, .keysMissing: break
        default: throw PairingInputError.notReady
        }
        let relay = try Self.relay(address: address, key: relayKey)
        guard let personID = Self.hexBytes(person, 32) else { throw PairingInputError.person }
        // The ids of keys made in recoveries that stopped. A store at recovering or recovered holds the id of the placed reset's new key as the last of them:
        // that key is the current one, so it is not carried (a key refused as "opens nothing" may be the only one the relay accepts).
        let onDisk = try? pairing.load()
        var made = onDisk?.recovery?.made ?? []
        if onDisk?.recovery?.reset?.replacement != nil { made = Array(made.dropLast()) }
        phase = .recovering(.starting) // claimed before the first await: a second start meets it and is refused
        cancelRequested = false
        if case .unpaired = before {} else { // a dead end: the old keys and pairing go
            do { try await eraseAll() } catch {
                phase = before
                throw error
            }
        }
        // Open decision of the maintainer (recovery design 2.4, R4-5): after "This Mac's keys are not here" the line "This device's earlier keys stay active"
        // and the Devices mark for this Mac's earlier device need that device's id, which the store does not hold. Not built until it is decided.
        attempt = RecoveryAttempt()
        var state = PairingState(stage: .keysMade(.recover), relay: relay, person: personID)
        state.recovery = PairingRecovery(made: made)
        do {
            try pairing.write(state)
            stored = state
            _ = try keys.make(Self.signName, .sign)
            _ = try keys.make(Self.receiveName, .receive)
            await enterKey()
        } catch {
            host = nil
            await abandonRecovery()
            throw error
        }
    }

    /// Steps 2 and 3: the key is typed into the host, then the reading connection (or, at `recovering`, the reset's connection) starts.
    func enterKey() async {
        guard let state = stored else { return }
        let reset = state.recovery?.reset // stored: the device may be in the log, so nothing here erases it
        await dropRecoveryKeys() // the start of an attempt, or another key: `enterRecovery` refuses a name already held
        phase = .recovering(.starting)
        do {
            let host = try await hostMade()
            let typed = try await host.enterRecovery(Self.enteredName)
            guard !isShutDown else { return await abandonRecovery() }
            if cancelRequested {
                cancelRequested = false
                return reset == nil ? await abandonRecovery() : await refuse(.notTyped)
            }
            if let reset {
                guard typed.id == reset.key else {
                    let isNew = reset.replacement.map { $0.signing == typed.signing && $0.receiving == typed.receiving } ?? false
                    return await refuse(isNew ? .yourNewKey : .notTheStartKey) // 2.5 row 3: the new key is named as such
                }
                try await startConnection(state, enrolment: nil, recover: RecoverRequest(key: typed.id, signName: Self.enteredName + ".sign", reset: try resetInputs(state)))
                phase = .recovering(.sending)
            } else {
                if state.recovery?.made.contains(typed.id) == true { return await refuse(.madeEarlier) }
                attempt.key = typed.id
                try await startConnection(state, enrolment: nil, recover: RecoverRequest(key: typed.id, signName: Self.enteredName + ".sign"))
                phase = .recovering(.reading)
            }
        } catch let declined as RecoveryRefused where declined.reason == "bad-input" {
            cancelRequested = false // the person declined, or typed a key that does not read
            if reset == nil { await abandonRecovery() } else { await refuse(.notTyped) }
        } catch {
            await dropRecoveryKeys()
            let next = reset == nil ? "Retry starts the recovery over: type the recovery key again." : PairingPhase.retryAdvice
            phase = .fault(.failed, Problem.sentence("Pardner could not start the recovery", error, next: next))
        }
    }

    /// The person types another recovery key, after a refusal that asked for one (2.5 row 1) or for the key that started this recovery.
    public func typeAnotherKey() async {
        guard case .recovering(.refused(let why)) = phase, why != .unknownPerson, why != .noLongerCurrent else { return }
        await enterKey()
    }

    func presentEntry(_ request: RecoveryEntryRequest) {
        guard case .recovering(.starting) = phase, !cancelRequested else { return request.answer(false) }
        phase = .recovering(.typeKey(request))
    }

    // MARK: the two questions (2.3 steps 4 to 6, 2.4)

    /// Step 4: `Could someone else have one of your devices?` `No` keeps every device active in the log read, `Yes` this device alone.
    public func answerDevices(someoneElse: Bool) -> Bool {
        guard case .recovering(.askDevices) = phase else { return false }
        attempt.keepOthers = !someoneElse
        phase = .recovering(.askNewKey)
        return true
    }

    /// Step 5 and 6: `Make a new recovery key?` A new key is made, its id stored, shown and typed back before the reset's inputs are stored;
    /// a sheet that is declined asks the question again. Throws what stopped it, after the attempt was erased.
    public func answerNewKey(make: Bool) async throws {
        guard case .recovering(.askNewKey) = phase, var state = stored, let person = state.person, let key = attempt.key, let keepOthers = attempt.keepOthers else {
            throw PairingInputError.notReady
        }
        phase = .recovering(.starting) // no cancel lands while the key is made and written
        do {
            var replacement: PairingRecoveryKeys?
            if make {
                let host = try await hostMade()
                let made = try await host.createRecovery(Self.nextName)
                state.recovery?.made.append(made.id)
                try pairing.write(state) // before the key is shown: after a restart the app can name it (2.5 row 1)
                stored = state
                let context = "Person: \(StoreDisk.hex(person))\nRelay: \(state.relay.address)\nRelay key: \(StoreDisk.hex(state.relay.key))"
                let confirmed = try await host.showRecovery(Self.nextName, context: context)
                phase = .recovering(.starting) // the sheet is over: a cancel from here finds nothing to stop, and none lands between the awaits below
                guard !cancelRequested, !isShutDown else { return await abandonRecovery() }
                guard confirmed else { return phase = .recovering(.askNewKey) }
                replacement = PairingRecoveryKeys(signing: made.signing, receiving: made.receiving)
            }
            let host = try await hostMade()
            let proof = try await host.makePairingProof(person: person, device: try deviceValue())
            state.stage = .recovering
            state.proof = proof
            // The replacement is the last id of `made`, written at step 5 before the key was shown: `startRecovery` drops it when a placed reset's store is read again.
            state.recovery?.reset = PairingReset(key: key, keepOthers: keepOthers, active: attempt.active, replacement: replacement, previous: attempt.previous)
            try pairing.write(state) // before the first connection that carries the reset
            stored = state
        } catch {
            host = nil
            await abandonRecovery()
            throw error
        }
        do {
            try await startConnection(state, enrolment: nil, recover: RecoverRequest(key: key, signName: Self.enteredName + ".sign", reset: try resetInputs(state)))
            phase = .recovering(.sending)
        } catch {
            await dropRecoveryKeys()
            phase = .fault(.failed, Problem.sentence("Pardner could not connect to the relay", error, next: "Retry: the recovery goes on where it stopped."))
            throw error
        }
    }

    /// The reset's inputs as the link takes them: after `No` the devices active in the log read, after `Yes` none (2.4).
    private func resetInputs(_ state: PairingState) throws -> RecoverRequest.Reset {
        guard let reset = state.recovery?.reset, let proof = state.proof else { throw PairingFault(description: "the pairing at recovering holds no reset") }
        return RecoverRequest.Reset(proof: proof, trusted: reset.keepOthers ? reset.active : [], replacement: reset.replacement)
    }

    // MARK: the connection's answers (2.3 steps 3, 7 and 8, 2.5)

    func recoveryLogRead(_ effect: HostValue) async {
        guard case .recovering(.reading) = phase, let list = effect["devices"]?.arrayValue else { return }
        attempt.active = list.compactMap { if case .bool(true)? = $0["active"] { $0["id"]?.bytesValue } else { nil } }
        attempt.previous = (effect["recoveries"]?.arrayValue ?? []).compactMap(\.bytesValue)
        await stopConnection() // the reading connection is closed before the person answers (2.3 step 3)
        phase = .recovering(.askDevices(others: attempt.active.count))
    }

    func recoveryAnswered(_ outcome: HostValue) async {
        switch (outcome["refused"]?.numberValue.map(Int.init), outcome["fault"]?.stringValue) {
        case (2?, _): await refuse(stored?.stage == .recovering ? .personGone : .unknownPerson) // after a reset is stored nothing can be stopped or retyped
        case (3?, _): await refuse(stored?.stage == .recovering ? .noLongerCurrent : .notCurrent)
        case (_, _?):
            await dropRecoveryKeys()
            await stopConnection()
            phase = .linkFaulted(PairingPhase.linkFaultAdvice)
        default: break // a reset's result: the link goes on by itself
        }
    }

    /// Step 8: the reset is in the log. The key typed to start is given to the link to open the past with; every recovery key stays held until done (2.6).
    func recoveryPlaced() async {
        guard var state = stored, state.stage == .recovering, let reset = state.recovery?.reset else { return }
        state.stage = .recovered
        state.proof = nil
        do { try pairing.write(state) } catch {
            phase = .fault(.failed, Problem.sentence("Pardner could not save the pairing", error, next: PairingPhase.retryAdvice))
            return
        }
        stored = state
        phase = .recovering(.placed)
        // Held only when the link took it: otherwise its epochs are asked for, and the key put away like any refused one.
        if await link?.holdRecovery(id: reset.key, receiving: Self.enteredName + ".receive") == true {
            heldRecovery = [(reset.key, Self.enteredName)] // the epochs it opens arrive as deliveries
        } else {
            try? await host?.deleteRecoveryKeys(Self.enteredName)
        }
    }

    /// A refusal that stops the connection and puts every recovery key held away (2.2).
    private func refuse(_ why: RecoveryRefusal) async {
        await stopConnection()
        await dropRecoveryKeys()
        phase = .recovering(.refused(why))
    }

    // MARK: ending (2.2)

    /// Cancels a recovery that is not placed: the typing declined, the keys put away, everything erased. A reset already sent may land
    /// later and leave this device active in the log with no keys behind it: the person removes it in Devices.
    func cancelRecovery() async -> CancelOutcome {
        guard case .recovering(let step) = phase else { return .notCancellable }
        switch step {
        case .typeKey(let request):
            cancelRequested = true
            request.answer(false)
            return .abandoning
        case .askDevices, .askNewKey, .refused, .reading, .sending:
            // A stored reset may be placed and this device in the log: no stop is offered then (whether one exists is the maintainer's decision).
            if stored?.stage == .recovering { return .notCancellable }
            await abandonRecovery()
            return .erased
        case .starting, .placed, .opening, .done:
            return .notCancellable
        }
    }

    func abandonRecovery() async {
        await dropRecoveryKeys()
        guard !isShutDown else { return }
        do {
            try await eraseAll()
            phase = .unpaired(nil)
        } catch {
            phase = .fault(.failed, Problem.sentence("Pardner could not erase the recovery", error, next: PairingPhase.retryAdvice))
        }
    }

    /// Every recovery key held, the typed one and a new one not yet shown: `enterRecovery` holds the typed key under two suffixed names.
    func dropRecoveryKeys() async {
        // The host's thread waits for the person inside a typed key or a shown one: it answers nothing else until that request is declined.
        switch phase {
        case .recovering(.typeKey(let request)): request.answer(false)
        case .showingSheet(let request): request.answer(false)
        default: break
        }
        let held = heldRecovery
        forgetHeldKeys() // before any await and before the host guard: what is listed as held is never more than what a link and a host hold
        guard let host else { return }
        try? await host.deleteRecoveryKeys(Self.enteredName)
        try? await host.deleteKey(Self.nextName)
        for earlier in held where earlier.name != Self.enteredName { try? await host.deleteRecoveryKeys(earlier.name) }
    }

    /// The keys held for opening are tied to the link that holds them: a new connection or a new host starts with none, and none given up.
    func forgetHeldKeys() { (heldRecovery, gaveUp, earlierKeys) = ([], [], 0) }

    // MARK: a restart (2.7)

    /// The store's recovery stages at launch: `keys-made` starts over (the keys and the link go, the ids of keys made stay), `recovering` asks for the key again, `recovered` runs an ordinary connection.
    func launchRecovery(_ state: PairingState) async throws {
        switch state.stage {
        case .keysMade:
            let named = state.recovery?.made.isEmpty == false // the ids of keys made are all the store keeps then
            try await eraseAll(keepingPairing: named)
            phase = .unpaired(named ? .staleRecoveryKey : nil)
        case .recovering:
            guard keys.has(Self.signName), keys.has(Self.receiveName) else { return phase = .keysMissing }
            stored = state
            Task { await self.enterKey() } // the key is typed by the person: launch does not wait for it
        default:
            guard keys.has(Self.signName), keys.has(Self.receiveName) else { return phase = .keysMissing }
            stored = state
            try await startConnection(state, enrolment: nil)
            guard !isShutDown else { return }
            phase = .recovering(.placed) // the keys are asked again by `opening`, as the rest says what is unopened (2.7)
        }
    }
}
