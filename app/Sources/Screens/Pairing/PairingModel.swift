// What the pairing screens read and do (device pairing design 3.5, 3.10, 4.1): the controller's phase as the views draw it, the
// form, and one method for each action the controller allows. The controller decides; this holds only what a view needs between two
// phases (the form's text and its errors, the cancel's second question, the recovery sheet's model).
import Foundation
import Observation
import Platform
import Relay

@MainActor @Observable
public final class PairingModel {
    public private(set) var phase: PairingPhase = .starting
    /// The recovery sheet while the controller shows one.
    public private(set) var sheet: RecoverySheetModel?
    /// The form's page, which is the view's own choice (the first screen has one action).
    public var showForm = false
    /// The first screen's third page: the form of a Mac that joins devices already paired (design 3.7); `openJoin()` opens it.
    public var showJoin = false
    public var address = ""
    public var relayKey = ""
    public var enrolmentSecret = ""
    /// The join form: the three values the approving device gives, and this Mac's name.
    public var joinAddress = ""
    public var joinKey = ""
    public var joinPerson = ""
    public var joinName = ""
    /// The field the controller's check refused.
    public private(set) var refused: PairingInputError?
    /// A failure that belongs to no field.
    public private(set) var problem: String?
    public private(set) var working = false
    public var retypedSecret = ""
    public private(set) var retypeProblem: String?
    public private(set) var cancelNote: CancelNote?
    /// The second question of a cancel while the relay answers nothing, and the notes of the other outcomes.
    public enum CancelNote: Equatable {
        case waitForAnswer, confirmUnreachable, failed(String)
    }

    private let controller: PairingController?
    /// False when the data folders could not be opened at launch: no controller exists, so Retry would do nothing and is not offered.
    private let storesOpen: Bool
    private var watching: Task<Void, Never>?
    /// The Devices screen's model, over the same controller; it follows the phase (closed unless paired).
    public let devices: DevicesModel
    /// The main window's channel acts (New channel, Bind to a folder…), over the same controller and the devices' list.
    public let channels: ChannelsModel
    /// What the main window draws, over the same controller: it is emptied by an erase, not by a phase, since a new connection after a
    /// fault reads the sequence again from its start and replaces what it drew.
    public let conversation: ConversationModel
    /// The composers of the main window, beside the channel acts: they learn each outbox from the same state.
    public let composers: Composers

    public init(controller: PairingController) {
        let devices = DevicesModel(controller: controller)
        let (channels, conversation) = (ChannelsModel(controller: controller, devices: devices), ConversationModel(controller: controller))
        let composers = Composers(conversation: conversation, devices: devices) { channel, draft in try await controller.send(channel: channel, draft: draft) }
        channels.composers = composers
        (self.controller, storesOpen, self.devices, self.channels, self.conversation, self.composers) = (controller, true, devices, channels, conversation, composers)
    }

    /// This Mac's name as System Settings shows it. Read when the join form opens: the lookup can wait on the network, so it is not made at launch.
    @ObservationIgnored var computerName: () -> String = { Host.current().localizedName ?? "" }

    /// A device name is 1 to 64 bytes with no space at either end: cut to 64 bytes, then trimmed; nothing left is an empty field with its placeholder.
    static func fitName(_ raw: String) -> String {
        var name = raw
        while name.utf8.count > 64 { name.removeLast() }
        return name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The first screen's Join as a new device: the form opens with this Mac's name, unless the person has typed one.
    public func openJoin() {
        showJoin = true
        if joinName.isEmpty { joinName = Self.fitName(computerName()) }
    }

    /// The setup is a join's, which makes keys and no recovery sheet; a first device's is the one with the sheet.
    public var isJoinSetUp: Bool {
        if case .settingUp = phase { showJoin } else { false }
    }

    /// A model with a fixed phase and no controller: what the screenshot tool and the previews draw.
    public init(phase: PairingPhase, form: Bool = false, join: Bool = false, refused: PairingInputError? = nil, note: CancelNote? = nil, storesOpen: Bool = true,
                devices: DevicesModel = DevicesModel(), conversation: ConversationModel = ConversationModel()) {
        let channels = ChannelsModel(devices: devices)
        let composers = Composers(conversation: conversation, devices: devices) { _, _ in .ended }
        channels.composers = composers
        (controller, self.phase, showForm, showJoin, self.refused, cancelNote, self.storesOpen, self.devices, self.channels, self.conversation, self.composers) =
            (nil, phase, form, join, refused, note, storesOpen, devices, channels, conversation, composers)
    }

    /// The model over this Mac's own stores. A folder that cannot be opened (another Pardner holds it, a link where a folder
    /// should be) is shown as a fault and the app is quit and opened again: no controller exists to retry.
    public static func live() -> PairingModel {
        do {
            let controller = PairingController(
                keys: try SecureEnclaveKeyStore(), pairing: try PairingStore(folder: PairingStore.defaultFolder()), linkFolder: try LinkStore.defaultFolder())
            return PairingModel(controller: controller)
        } catch {
            return PairingModel(phase: .fault(.failed, "Pardner's data folders cannot be opened: \(error). Quit Pardner and open it again."), storesOpen: false)
        }
    }

    /// The screen a phase draws (the form is the first screen's second page).
    public enum Screen: Equatable {
        case starting, first, form, joinForm, settingUp, enrolling, joining, paired, removed, keysMissing, putBack, linkFaulted, malformedStore, newerStore, needsNewPairing, joinUnmade, failed
    }

    public var screen: Screen {
        switch phase {
        case .starting: .starting
        case .unpaired: showJoin ? .joinForm : showForm ? .form : .first
        case .settingUp, .showingSheet: .settingUp
        case .enrolling: .enrolling
        case .joining: .joining
        case .paired: .paired
        case .removed: .removed
        case .keysMissing: .keysMissing
        case .putBack: .putBack
        case .linkFaulted: .linkFaulted
        case .fault(.malformedStore, _): .malformedStore
        case .fault(.newerStore, _): .newerStore
        case .fault(.keysWithoutStore, _), .fault(.joinMismatch, _): .needsNewPairing
        case .fault(.joinUnmade, _): .joinUnmade
        case .fault(.failed, _): .failed
        }
    }

    /// The text the controller gives a phase to show.
    public var message: String? {
        switch phase {
        case .putBack(let text), .linkFaulted(let text), .fault(_, let text): text
        default: nil
        }
    }

    /// The one action a notice offers. Each is one the controller allows in that phase (`pairAgain()` in removed, keysMissing, putBack,
    /// linkFaulted and the faults of a pairing file that does not read, keys with no store and a join that did not hold this Mac; `retry()` in `fault(.failed)`).
    public enum Exit: Equatable { case pairAgain, retry }

    public var exit: Exit? {
        switch screen {
        case .removed, .keysMissing, .putBack, .linkFaulted, .malformedStore, .needsNewPairing, .joinUnmade: .pairAgain
        case .failed: storesOpen ? .retry : nil
        default: nil
        }
    }

    /// A pairing string that could not be made also allows Retry, beside Pair again (the controller's `retry()` accepts `fault(.joinUnmade)`).
    public var offersRetryToo: Bool { screen == .joinUnmade && storesOpen }

    /// Follows the controller's phases and runs its launch.
    public func start() {
        guard let controller, watching == nil else { return }
        watching = Task { [weak self] in
            for await phase in controller.phases { self?.apply(phase) }
        }
        devices.start()
        channels.start()
        conversation.start()
        Task { await controller.launch() }
    }

    func apply(_ next: PairingPhase) {
        if case .showingSheet(let request) = next {
            if sheet?.source !== request {
                sheet?.close()
                sheet = RecoverySheetModel(source: request)
            }
        } else {
            sheet?.close() // whichever way the controller moved on, a sheet still open is declined and wiped
            sheet = nil
        }
        if next != phase {
            // A note belongs to the phase it was made in; a return to the first screen starts at its first page (design 3.10), except
            // from a setup that ended unpaired (a declined sheet, a failure): it stays on the form, where its message is drawn.
            cancelNote = nil
            if case .unpaired = next, !phase.isUnpaired, !phase.isSettingUp { (showForm, showJoin) = (false, false) }
            if case .paired = next {} else { devices.reset() } // the Devices sheet and its half-made acts do not outlive the pairing
            // A failed write ends the connection with `fault(.failed)` and Retry brings the pairing back: the new-channel sheet and its folder wait for
            // the answer (`notSaved`) there, and go only when the pairing ends.
            switch next {
            case .paired, .fault(.failed, _): break
            default:
                channels.reset()
                composers.reset()
            }
            if case .enrolling = next {} else { (retypedSecret, retypeProblem) = ("", nil) }
            phase = next
        }
    }

    /// The app is quitting: the view's sheet is closed and its buffers wiped. Called once the controller has shut down (or at the quit
    /// deadline), so the controller, not this decline, decides what a stopped setup leaves behind.
    public func closeSheetForQuit() { sheet?.close() }

    /// The app is quitting: the connection ends and the link store is given back (`PairingController.shutdown()`). Off the main
    /// actor, so a quit that waits in a nested loop can run it; it reads no state of the model.
    public nonisolated func endConnectionForQuit() async { await controller?.shutdown() }

    // MARK: the first device

    public func setUp() {
        guard let controller, !working else { return }
        (working, refused, problem) = (true, nil, nil)
        let (address, key, secret) = (address, relayKey, enrolmentSecret)
        Task {
            var failure: Error?
            do {
                try await controller.setUp(address: address, relayKey: key, enrolmentSecret: secret)
            } catch {
                failure = error
            }
            finishSetUp(failure, unpaired: await controller.phase.isUnpaired)
        }
    }

    /// The secret is dropped once the controller has had it, or when it is the secret that was refused; a refusal of another field
    /// keeps a correctly typed secret for the next try.
    func finishSetUp(_ failure: Error?, unpaired: Bool) {
        switch failure {
        case nil:
            if unpaired { problem = "Setup was stopped before it finished. Nothing was kept; start again." }
            enrolmentSecret = ""
        case let error as PairingInputError:
            refused = error
            if error == .notReady { problem = "Setup cannot start now." }
            if error == .enrolmentSecret { enrolmentSecret = "" }
        case let error?:
            problem = "Setup failed: \(error)"
            enrolmentSecret = ""
        }
        working = false
    }

    // MARK: joining as a new device (design 3.7)

    public func join() {
        guard let controller, !working else { return }
        (working, refused, problem) = (true, nil, nil)
        let (address, key, person, name) = (joinAddress, joinKey, joinPerson, joinName)
        Task {
            var failure: Error?
            do {
                try await controller.join(address: address, relayKey: key, person: person, name: name)
            } catch {
                failure = error
            }
            finishJoin(failure, unpaired: await controller.phase.isUnpaired)
        }
    }

    func finishJoin(_ failure: Error?, unpaired: Bool) {
        switch failure {
        case nil:
            if unpaired { problem = "Joining was stopped before it finished. Nothing was kept; start again." }
        case let error as PairingInputError:
            refused = error
            if error == .notReady { problem = "Joining cannot start now." }
        case let error?:
            problem = "Joining failed: \(error)"
        }
        working = false
    }

    /// The form's Back: the first screen again, with no secret kept.
    public func back() {
        (showForm, showJoin) = (false, false)
        enrolmentSecret = ""
        edited()
    }

    /// Typing in a field takes back its error.
    public func edited() { (refused, problem) = (nil, nil) }

    public func retypeEdited() { retypeProblem = nil }

    public func retype() {
        guard let controller, !working else { return }
        working = true
        retypeProblem = nil
        let text = retypedSecret
        Task {
            var outcome: Result<Bool, Error>
            do { outcome = .success(try await controller.retypeSecret(text)) } catch { outcome = .failure(error) }
            finishRetype(outcome)
        }
    }

    func finishRetype(_ outcome: Result<Bool, Error>) {
        switch outcome {
        case .success(true): retypedSecret = ""
        case .success(false): retypeProblem = "The connection could not take it just now. Try again."
        case .failure(PairingInputError.notReady): retypeProblem = "Pardner is not waiting for the secret now."
        case .failure(is PairingInputError): retypeProblem = "The enrolment secret is 64 hexadecimal characters."
        case .failure(let error): retypeProblem = "\(error)"
        }
        working = false
    }

    public func cancel(confirmedUnreachable: Bool = false) {
        guard let controller else { return }
        let calledIn = phase
        Task { finishCancel(await controller.cancel(confirmedUnreachable: confirmedUnreachable), calledIn: calledIn) }
    }

    /// The outcome's note shows only while the phase is still the one the cancel was asked in: a refusal that moved on must not
    /// leave a note about a screen that is gone.
    func finishCancel(_ outcome: CancelOutcome, calledIn: PairingPhase) {
        guard phase == calledIn else { return }
        switch outcome {
        case .waitForAnswer: cancelNote = .waitForAnswer
        case .confirmUnreachable: cancelNote = .confirmUnreachable
        case .failed(let message): cancelNote = .failed(message)
        case .erased, .abandoning, .notCancellable: cancelNote = nil
        }
    }

    public func keepWaiting() { cancelNote = nil }

    // MARK: the other exits

    public func pairAgain() {
        guard let controller else { return }
        Task { await controller.pairAgain() }
    }

    /// Offered only while the controller exists (`exit`).
    public func retry() {
        guard let controller else { return }
        Task { await controller.retry() }
    }
}

extension PairingPhase {
    var isUnpaired: Bool { if case .unpaired = self { true } else { false } }
    /// The setup is running: the keys are being made or the recovery sheet is on screen.
    var isSettingUp: Bool { switch self { case .settingUp, .showingSheet: true; default: false } }
}
