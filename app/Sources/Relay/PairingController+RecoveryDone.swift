// Opening the past and "done" (recovery design 2.6): the recovery keys the person types are given to the link, which opens the epochs sealed to
// them; done is declared from what the link has read, never from what this run happens to hold. Nothing is stored but the stage.
import Foundation
import Platform
import ProtocolHost

/// What done still waits on (recovery design 2.6).
public struct RecoveryProgress: Sendable, Equatable {
    /// An epoch no held key opens, by channel and epoch id.
    public struct Epoch: Sendable, Equatable {
        public let channel: Data
        public let epoch: Data
        /// Its place in its channel's epoch log, so consecutive epochs make one range.
        public let place: Int
        public let unopened: Unopened
        /// Of the person's space or a spare: waited on like any epoch, and left out of the list of conversations.
        public let space: Bool

        public init(channel: Data, epoch: Data, place: Int = 0, unopened: Unopened = Unopened(count: 0), space: Bool = false) {
            (self.channel, self.epoch, self.place, self.unopened, self.space) = (channel, epoch, place, unopened, space)
        }
    }

    /// An earlier recovery key the person has not typed, and the epochs that stay unreadable on this device without it.
    public struct Missing: Sendable, Equatable {
        public let key: Data
        public let epochs: [Epoch]
        /// The current recovery key: asked for as such, and never given up, since the person holds it (the new key, or the key typed to start).
        public var isCurrent = false

        public init(key: Data, epochs: [Epoch], isCurrent: Bool = false) { (self.key, self.epochs, self.isCurrent) = (key, epochs, isCurrent) }
    }

    public var waiting: [Missing]
    /// Epochs this device holds the key of that the relay does not yet show sealed to the current recovery key.
    public var unsealed: Int
    /// The last key typed was not one of this person's recovery keys, or was typed already.
    public var refusedKey = false

    /// Some key still missing is an earlier one, not the current key.
    public var asksEarlierKey: Bool { waiting.contains { !$0.isCurrent } }

    public init(waiting: [Missing], unsealed: Int, refusedKey: Bool = false) { (self.waiting, self.unsealed, self.refusedKey) = (waiting, unsealed, refusedKey) }
}

/// Which keys the person may destroy when done (recovery design 2.6): every recovery key typed in this recovery but the current one.
public struct RecoveryDone: Sendable, Equatable {
    public let destroyable: [Data]
    /// The key typed to start, when it is still the current one: the person keeps it.
    public let keep: Data?

    public init(destroyable: [Data], keep: Data?) { (self.destroyable, self.keep) = (destroyable, keep) }
}

/// The words of this step, for the screens.
public enum RecoveryWords {
    public static let keepKeys = "Keep every recovery key you have until Pardner says the recovery is done"
    public static let sealedToEarlier = "Part of your history is sealed to an earlier recovery key. Type it to open that history."
    public static let noLongerHaveIt = "I no longer have this key"
    public static let typeIt = "Type the key"
    public static let keepTheStartKey = "Keep the recovery key you typed to start: it is still your current recovery key."

    /// `lines` name the conversations by channel and dates, as the screen writes them; none when the key only opens the person's space and its spares.
    public static func unreadable(_ lines: [String]) -> String {
        let tail = "This may be a recovery key Pardner told you could be destroyed."
        return lines.isEmpty ? "No conversation stays unreadable on this device. \(tail)" : "These conversations stay unreadable on this device: \(lines.joined(separator: "; ")). \(tail)"
    }
}

extension PairingController {
    /// What done waits on, from what the link read and the keys held. An epoch no key opens is excepted when it is sealed to a key that was typed (its seal
    /// failed its commitment, security design 5.3) and when every earlier key it is sealed to was given up; the current key is asked for as such (`isCurrent`) and never given up.
    static func progress(_ reading: RecoveryReading, held: Set<Data>, gaveUp: Set<Data>) -> RecoveryProgress {
        let recorded = Set(reading.recoveries)
        var missing: [Data: [RecoveryProgress.Epoch]] = [:]
        var order: [Data] = []
        var places: [Data: Int] = [:]
        for epoch in reading.epochs {
            let place = places[epoch.channel, default: 0]
            places[epoch.channel] = place + 1
            guard !epoch.open else { continue }
            let sealed = Set(epoch.sealedTo).intersection(recorded)
            guard sealed.isDisjoint(with: held) else { continue }
            let without = sealed.subtracting(held) // the current key too, while it is not held: it opens the epoch as well, and on the keep path it is the key typed to start
            guard !without.isEmpty, !without.isSubset(of: gaveUp) else { continue }
            var seen = Set<Data>()
            for key in epoch.sealedTo where without.subtracting(gaveUp).contains(key) && seen.insert(key).inserted {
                if missing[key] == nil { order.append(key) }
                missing[key, default: []].append(.init(channel: epoch.channel, epoch: epoch.epoch, place: place, unopened: epoch.unopened ?? Unopened(count: 0), space: epoch.space))
            }
        }
        let open = reading.epochs.filter(\.open)
        let missingSeal = reading.current.map { current in open.filter { !$0.sealedTo.contains(current) }.count } ?? open.count
        return RecoveryProgress(waiting: order.map { .init(key: $0, epochs: missing[$0] ?? [], isCurrent: $0 == reading.current) }, unsealed: missingSeal)
    }

    /// Run at every rest and after a key is typed or given up: done, or what it waits on.
    func evaluateRecovery(refusedKey: Bool = false) async {
        guard atRest, stored?.stage == .recovered, let link else { return }
        guard let reading = await link.recoveryReading() else { return }
        switch phase {
        case .recovering(.placed), .recovering(.opening): break
        default: return // the person moved on while the link answered
        }
        guard stored?.stage == .recovered else { return } // another evaluation declared done while this one read
        var progress = Self.progress(reading, held: Set(heldRecovery.map(\.id)), gaveUp: gaveUp)
        progress.refusedKey = refusedKey
        if progress.waiting.isEmpty, progress.unsealed == 0, let current = reading.current { return await finishRecovery(current: current) }
        phase = .recovering(.opening(progress))
    }

    private func finishRecovery(current: Data) async {
        guard var state = stored else { return }
        let held = heldRecovery
        state.stage = .paired
        state.recovery = nil
        if let snap = snapshot, snap.devices.contains(where: { $0.id == snap.selfID && $0.active }) { state.device = snap.selfID } // else the next devices read stores it
        mayHoldUnnamedEarlier = false
        do { try pairing.write(state) } catch {
            phase = .fault(.failed, Problem.sentence("Pardner could not save the pairing", error, next: PairingPhase.retryAdvice))
            return
        }
        stored = state
        // Claimed before the first await: a second evaluation that read meanwhile finds the stage and the phase moved on.
        phase = .recovering(.done(RecoveryDone(destroyable: held.map(\.id).filter { $0 != current }, keep: held.contains { $0.id == current && $0.name == Self.enteredName } ? current : nil)))
        await dropRecoveryKeys() // 2.2: every recovery key held goes at done
    }

    /// The person read what can be destroyed: the pairing goes on as an ordinary one.
    public func acknowledgeRecoveryDone() {
        guard case .recovering(.done) = phase else { return }
        phase = .paired
    }

    /// Types an earlier recovery key (or the key typed to start, after a restart) for opening: held under `recovery.earlier.<n>` and given to the link.
    /// A key that is none of the log's recovery keys, or is held already, is put away and said so in the progress.
    public func typeEarlierKey() async {
        guard case .recovering(.opening) = phase, let link, stored?.stage == .recovered else { return }
        earlierKeys += 1
        let connection = connectionID
        let name = "recovery.earlier.\(earlierKeys)"
        cancelRequested = false
        phase = .recovering(.starting)
        var refused = false
        // A removal, a put-back or a fault that came while the key was typed stays: nothing is put back over it, and the key typed is put away.
        let mine = { [self] in
            switch phase {
            case .recovering(.starting), .recovering(.typeKey): return !isShutDown && connectionID == connection // the entry's own phases
            default: return false
            }
        }
        do {
            let host = try await hostMade()
            let typed = try await host.enterRecovery(name)
            let recorded = await link.recoveryReading()?.recoveries ?? []
            guard mine() else { return try await host.deleteRecoveryKeys(name) }
            if recorded.contains(typed.id), !heldRecovery.contains(where: { $0.id == typed.id }), await link.holdRecovery(id: typed.id, receiving: name + ".receive") {
                heldRecovery.append((typed.id, name))
            } else {
                try? await host.deleteRecoveryKeys(name)
                refused = true
            }
        } catch let declined as RecoveryRefused where declined.reason == "bad-input" {
            cancelRequested = false // the person declined, or typed a key that does not read: nothing changes
        } catch {
            if mine() { phase = .fault(.failed, Problem.sentence("Pardner could not use that recovery key", error, next: PairingPhase.retryAdvice)) }
            return
        }
        guard mine() else { return }
        phase = .recovering(.placed)
        await evaluateRecovery(refusedKey: refused)
    }

    /// `I no longer have this key` (recovery design 2.6): the epochs only that key opens stay unreadable on this device and done stops waiting on them.
    /// Nothing is recorded on the relay; a restart asks again. Whether such a step needs more than the confirmation is for the screens.
    public func giveUp(key: Data) async {
        guard case .recovering(.opening(let progress)) = phase, progress.waiting.contains(where: { $0.key == key && !$0.isCurrent }) else { return }
        gaveUp.insert(key)
        phase = .recovering(.placed)
        await evaluateRecovery()
    }
}
