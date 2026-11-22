// What the recovery screens read and do (recovery design 2.1 to 2.7): the public part pasted or typed, the recovery key typed into a field
// that refuses a wrong check symbol at once, and one method for each answer the controller takes. The controller decides; the words of every
// step are here, so that a test reads them. No secret is kept in a `String`.
import Foundation
import Platform
import Relay

/// The public part the recovery key's Copy gives: `Person: <hex>`, `Relay: <host:port>` and `Relay key: <hex>`, one to a line.
enum RecoveryPublicPart {
    static func parse(_ text: String) -> (person: String, address: String, key: String)? {
        var found: [String: String] = [:]
        for line in text.split(whereSeparator: \.isNewline) {
            guard let colon = line.firstIndex(of: ":") else { continue }
            found[line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        guard let person = found["person"], let address = found["relay"], let key = found["relay key"] else { return nil }
        return (person, address, key)
    }
}

/// The recovery key as it is typed (recovery design 2.2): one symbol at a time into the request's buffer, never a `String`. A key whose check
/// symbol is wrong is refused in the field and not handed over, so the person stays where they are.
@MainActor @Observable
public final class RecoveryEntryModel {
    let request: RecoveryEntryRequest
    let secureInput = SecureInputGuard()
    public private(set) var typed = 0
    /// Whether the typed text reads as a recovery key: the right length and the right check symbol.
    public private(set) var reads = false
    public private(set) var isClosed = false
    public static let symbolCount = RecoveryText.symbolCount

    init(request: RecoveryEntryRequest) { self.request = request }

    /// False for a character that cannot be part of a recovery key.
    @discardableResult
    public func key(_ character: UniChar) -> Bool {
        guard !isClosed else { return false }
        guard let taken = request.withEntry({ $0.append(character) }) else { answered(); return false } // an answer stands: the buffer is not the field's
        refresh()
        return taken
    }

    public func deleteLast() {
        guard !isClosed else { return }
        guard request.withEntry({ $0.deleteLast() }) != nil else { return answered() }
        refresh()
    }

    /// The controller answered (a decline, from its own executor): the field closes and shows nothing typed.
    private func answered() {
        isClosed = true
        secureInput.close()
        (typed, reads) = (0, false)
    }

    /// Hands the key over, only when it reads.
    public func submit() {
        guard !isClosed, reads else { return }
        isClosed = true
        secureInput.close()
        request.answer(true)
    }

    /// Declines, and every other way the field goes away; the typed key is wiped. Safe to call again.
    public func decline() {
        guard !isClosed else { return }
        isClosed = true
        secureInput.close()
        request.answer(false)
        (typed, reads) = (0, false)
    }

    private func refresh() {
        let scratch = SecretBuffer(count: 32)
        defer { scratch.wipe() }
        let state = request.withEntry { entry in (entry.count, entry.count == Self.symbolCount && (try? entry.read(into: scratch)) != nil) }
        (typed, reads) = state ?? (0, false)
    }

    /// Every symbol is typed and the key still does not read: a character is wrong.
    public var checkFailed: Bool { typed == Self.symbolCount && !reads }
}

/// The words of the recovery screens (recovery design 2.2 to 2.7), in the design's own texts where it gives them.
public enum RecoveryScreenWords {
    /// The conversations that stay unreadable, one line per run of consecutive epochs of a channel (epoch dates design 2, 6): the day of the first and of
    /// the last message, in the system's abbreviated date; "dates unknown" when messages were read but no time was plausible; "no messages" when none was.
    public static func conversations(_ epochs: [RecoveryProgress.Epoch], locale: Locale = .current, timeZone: TimeZone = .current) -> [String] {
        var order: [Data] = []
        var byChannel: [Data: [RecoveryProgress.Epoch]] = [:]
        for epoch in epochs where !epoch.space {
            if byChannel[epoch.channel] == nil { order.append(epoch.channel) }
            byChannel[epoch.channel, default: []].append(epoch)
        }
        let style = Date.FormatStyle(date: .abbreviated, time: .omitted, locale: locale, timeZone: timeZone)
        return order.flatMap { channel -> [String] in
            var runs: [[RecoveryProgress.Epoch]] = []
            for epoch in (byChannel[channel] ?? []).sorted(by: { $0.place < $1.place }) {
                if let last = runs.last?.last, last.place + 1 == epoch.place { runs[runs.count - 1].append(epoch) } else { runs.append([epoch]) }
            }
            return runs.map { run in
                let name = Naming.channel(channel)
                guard run.contains(where: { $0.unopened.count > 0 }) else { return "\(name), no messages" }
                let firsts = run.compactMap(\.unopened.first), lasts = run.compactMap(\.unopened.last)
                guard let first = firsts.min(), let last = lasts.max() else { return "\(name), dates unknown" }
                let (from, to) = (first.formatted(style), last.formatted(style))
                return from == to ? "\(name), on \(from)" : "\(name), from \(from) to \(to)"
            }
        }
    }

    public static let choice = "Recover with your recovery key"
    public static let choiceLine = "For when every device of yours is lost. You need your recovery key: its public part and the secret you wrote down."
    public static let formHint = "Paste what Copy gave when you wrote your recovery key down, or type the three values."
    public static let notPasted = "That text does not hold the three values. Paste the person id, the relay address and the relay key, or type them."
    public static let typeKeyTitle = "Type your recovery key"
    public static let typeEarlierTitle = "Type an earlier recovery key"
    public static let typeKeyLine = "Type the characters you wrote down. Case and dashes do not matter."
    public static let checkFailed = "This is not a recovery key: a character is wrong. Check each character against what you wrote."
    public static let readingTitle = "Reading your devices"
    public static let reading = "Pardner is checking your recovery key with your relay."
    public static let devicesTitle = "Could someone else have one of your devices?"
    public static let devicesNo = "No"
    public static let devicesNoLine = "Your other devices stay as they are. You can remove any of them later in Devices."
    /// What `No` says besides that, when this Mac's earlier keys may still be active (recovery design 2.4, R4-5; the maintainer's decision of 2026-11-22).
    public static func noLine(_ earlier: EarlierKeys) -> String {
        switch earlier {
        case .notActive: devicesNoLine
        case .unnamed: devicesNoLine + " Your earlier keys on this Mac may still be active; remove them in Devices if so."
        case .named(let short): devicesNoLine + " Your earlier keys on this Mac (\(short)) stay active until you remove them in Devices."
        }
    }
    /// The pill that marks the earlier device in Devices.
    public static let earlierKeysMark = "This Mac's earlier keys"
    public static let devicesYes = "Yes"
    public static let devicesYesLine = "Only this device stays. Every other device is removed; pair again each one you still have."
    public static let newKeyTitle = "Make a new recovery key?"
    public static let newKeyLine = "You just typed your recovery key on this device. With a new one, the key you typed opens nothing new after the recovery is done."
    public static let makeNewKey = "Make a new recovery key"
    public static let keepMyKey = "Keep my recovery key"
    public static let sendingTitle = "Recovering your devices"
    public static let sending = "Pardner is sending your recovery to the relay. This Mac becomes one of your devices when the relay places it."
    public static let placedTitle = "Opening your history"
    public static let placed = "This Mac is one of your devices again. Pardner is opening your history."
    public static let sealing = "Pardner is sealing your history to your recovery key."
    public static let keepKeys = RecoveryWords.keepKeys
    public static let preparing = "Pardner is preparing the recovery."
    public static let preparingTitle = "Recovery"
    public static let cannotFinish = "Pardner cannot finish this recovery now. Quit Pardner: your recovery key and this Mac's keys stay as they are."
    public static let eraseOnContinue = "Continue erases this Mac's old device keys and pairing, then asks for your recovery key."
    public static let makeNewKeyLine = "A new recovery key is shown for you to write down and type back before anything is sent."
    public static let keepMyKeyLine = "Nothing new is made. The key you typed stays your current recovery key."

    /// Cancel is offered only while no reset is stored; a stored recovery is stopped by Quit alone, where the relay no longer accepts the key or the person.
    public static func canCancel(_ why: RecoveryRefusal) -> Bool { [.unknownPerson, .notCurrent, .madeEarlier].contains(why) }
    public static let quitRecovery = "Quit recovery and keep this Mac as it is"
    public static func canQuit(_ why: RecoveryRefusal) -> Bool { why == .noLongerCurrent || why == .personGone }
    /// A key can be typed again after these.
    public static func canTypeAgain(_ why: RecoveryRefusal) -> Bool { why != .unknownPerson && why != .noLongerCurrent && why != .personGone }
    public static let newKeyOnSheet = "After this recovery is done, this key opens your history. Until then, keep every recovery key you have."
    public static let currentKey = "Your current recovery key"
    public static let refusedKey = "That is not one of your recovery keys, or you typed it already."
    public static let doneTitle = "The recovery is done"
    public static let staleKey = "The new recovery key from the recovery that stopped opens nothing. Start again and type the recovery key you used."

    public static func refusal(_ why: RecoveryRefusal) -> (title: String, text: String) {
        switch why {
        case .unknownPerson: ("The relay does not know you", "The relay does not know this person id, or its address is wrong. Check the public part of your recovery key.")
        case .notCurrent: ("This is not your current recovery key", "This recovery key is not the current one. If you have another recovery key, type it.")
        case .madeEarlier: ("This key opens nothing", "This is the key made in the recovery that stopped. It opens nothing. Type the recovery key you used to start that recovery.")
        case .notTheStartKey: ("Type the key you started with", "Type the recovery key you used to start this recovery.")
        case .yourNewKey: ("This is your new recovery key", "This is your new recovery key. Type the recovery key you used to start this recovery.")
        case .notTyped: ("No recovery key was given", "Nothing was stopped. Type the recovery key you used to start this recovery, so that Pardner can finish it.")
        case .personGone: ("Your relay no longer knows this person", "Your relay no longer knows this person id, or its address has changed, and this Mac is not one of your devices yet.")
        case .noLongerCurrent: ("The relay no longer accepts this key", "The relay no longer accepts the recovery key you typed, and this Mac is not one of your devices yet. A recovery on another device may have replaced it.")
        }
    }

    /// An earlier key asked for, with the conversations that stay unreadable without it.
    public static func missing(_ key: String, isCurrent: Bool) -> String {
        isCurrent ? "Type \(currentKey.lowercased()), \(key), to open the rest of your history."
                  : "Part of your history is sealed to the earlier recovery key \(key). Type it to open that history."
    }

    /// Nil when there is nothing to destroy: no sentence is shown.
    public static func destroyable(_ keys: [String]) -> String? { keys.isEmpty ? nil : "You can destroy \(keys.count == 1 ? "this recovery key" : "these recovery keys"): \(keys.joined(separator: ", "))." }
}

extension PairingModel {
    var recoveryStep: RecoveryStep? { if case .recovering(let step) = phase { step } else { nil } }

    // MARK: the form (recovery design 2.2)

    public func openRecover() { showRecover = true }

    /// What was pasted fills the three fields; text that does not hold them says so and changes nothing.
    public func paste(_ text: String) {
        guard let part = RecoveryPublicPart.parse(text) else { return problem = RecoveryScreenWords.notPasted }
        (recoverPerson, recoverAddress, recoverKey, problem, refused) = (part.person, part.address, part.key, nil, nil)
    }

    public func recover() {
        guard let controller, !working else { return }
        (working, refused, problem) = (true, nil, nil)
        let (person, address, key) = (recoverPerson, recoverAddress, recoverKey)
        Task {
            var failure: Error?
            do { try await controller.startRecovery(person: person, address: address, relayKey: key) } catch { failure = error }
            finishRecover(failure, unpaired: await controller.phase.isUnpaired)
        }
    }

    func finishRecover(_ failure: Error?, unpaired: Bool) {
        switch failure {
        case nil:
            if unpaired { problem = "The recovery was stopped before it finished. Nothing was kept; start again." }
        case let error as PairingInputError:
            refused = error
            if error == .notReady { problem = "The recovery cannot start now." }
        case let error?: problem = Problem.sentence("The recovery could not start", error, next: "Check the three values and try again.")
        }
        working = false
    }

    // MARK: the answers (recovery design 2.3 to 2.6)

    public func answerDevices(someoneElse: Bool) {
        guard let controller else { return }
        Task { _ = await controller.answerDevices(someoneElse: someoneElse) }
    }

    public func answerNewKey(make: Bool) {
        guard let controller else { return }
        Task {
            var failure: Error?
            do { try await controller.answerNewKey(make: make) } catch { failure = error }
            finishAnswer(failure)
        }
    }

    /// A second click on the question finds it answered: the controller says it is not ready, and nothing is shown for that.
    func finishAnswer(_ failure: Error?) {
        switch failure {
        case nil, PairingInputError.notReady?: break
        case let error?: problem = Problem.sentence("The recovery could not go on", error, next: "Start the recovery again.")
        }
    }

    public func typeAnotherKey() {
        guard let controller else { return }
        Task { await controller.typeAnotherKey() }
    }

    /// Closes a recovery the relay no longer accepts, erasing nothing (`PairingController.quitRecovery`).
    public func quitRecovery() {
        guard let controller else { return }
        Task { _ = await controller.quitRecovery() }
    }

    public func typeEarlierKey() {
        guard let controller else { return }
        Task { await controller.typeEarlierKey() }
    }

    /// `I no longer have this key` asks for a confirmation first; the current key is never offered it.
    public func askToGiveUp(_ key: Data) {
        guard case .opening(let progress)? = recoveryStep, progress.waiting.contains(where: { $0.key == key && !$0.isCurrent }) else { return }
        givingUp = key
    }

    public func cancelGiveUp() { givingUp = nil }

    /// The confirmation's `Type the key`: it closes the confirmation and opens the field.
    public func typeInstead() {
        givingUp = nil
        typeEarlierKey()
    }

    /// The form opened from a dead end erases this Mac's old keys at Continue (the controller does it before the key is typed).
    public var formErasesOldKeys: Bool { phase == .removed || phase == .keysMissing }

    public func giveUp() {
        guard let controller, let key = givingUp else { return }
        givingUp = nil
        Task { await controller.giveUp(key: key) }
    }

    public func finishRecovery() {
        guard let controller else { return }
        Task { await controller.acknowledgeRecoveryDone() }
    }
}
