// The Profile pane's state (person profile design 8.2, name part): the name being typed and the answer of the last Save. The picture comes
// with the profile message of issue #96; today Save sets the person's name, kind 15, as the name sheet did.
import Foundation
import Observation
import Relay

@MainActor @Observable
public final class ProfileModel {
    /// The name typed in the field; nil while the person has not edited it, and the field shows the shown name, so a name changed on another
    /// device while the pane is open shows there and Save never sends the old one back.
    public var edited: String?
    public private(set) var problem: String?
    /// A Save is on its way. It outlives a closing of the window, so a reopened pane cannot send a second name before the first is answered.
    public private(set) var working = false
    /// The name last queued and the name the device showed when it was saved: the device shows a name only once it reads it back, so while
    /// it still shows `over` the field shows `name`. Any later name read, this one or another device's, stands over it.
    private var queued: (name: String, over: String?)?
    /// Which showing of the window an answer's edit and sentence belong to: it changes when the window closes, not when the pane changes.
    private(set) var ticket = 0
    /// Which pairing an answer belongs to: an answer from before a reset shows no name.
    private var pairing = 0

    private let controller: PairingController?

    init(controller: PairingController?) { self.controller = controller }

    /// The name the pane stands on: the one queued while the device still shows the name it was saved over, else the one the device read.
    private func shown(_ live: String?) -> String? { queued.flatMap { $0.over == live ? $0.name : nil } ?? live }

    /// The text the field shows: the edit, else the shown name.
    public func text(live: String?) -> String { edited ?? shown(live) ?? "" }

    private var trimmed: String? {
        let text = edited?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }

    /// Save is offered once the log is read, with a name that differs from the one shown, and no act in flight. The ends are trimmed: a name
    /// has no space at either end.
    public func canSave(live: String?, ready: Bool) -> Bool { ready && !working && trimmed.map { $0 != shown(live) } ?? false }

    /// Asks the controller to set the typed name; the answer lands in `finish`.
    public func save(live: String?, ready: Bool) {
        guard let controller, canSave(live: live, ready: ready), let text = trimmed else { return }
        (working, problem) = (true, nil)
        let (asked, paired) = (ticket, pairing)
        Task {
            do { finish(try await controller.setName(kind: 15, target: nil, text: text), sent: text, over: live, for: asked, pairing: paired) } catch { finishFailure(error, for: asked) }
        }
    }

    /// The answer to a Save of `sent`. A name queued is shown whichever showing of the window asked; the edit and the sentence belong to it.
    func finish(_ outcome: SendOutcome, sent: String, over: String? = nil, for asked: Int? = nil, pairing paired: Int? = nil) {
        working = false
        if case .queued = outcome, paired ?? pairing == pairing { queued = (sent, over) }
        guard asked ?? ticket == ticket else { return }
        switch outcome {
        case .queued:
            problem = nil
            // Text typed after Save stays.
            if edited?.trimmingCharacters(in: .whitespacesAndNewlines) == sent { edited = nil }
        case .notSaved: problem = "Pardner could not save the name. Try again."
        case .ended: problem = "Pardner is not connected. Try again in a moment."
        case .refused("bad-input"): problem = "Use up to 64 characters, with no hidden characters and no @."
        case .refused("not-ready"): problem = "Pardner is still reading your devices. Try again in a moment."
        case .refused: problem = "Pardner could not set the name. Try again in a moment."
        }
    }

    /// The controller threw: the edit stays, and the reason is told as it is.
    func finishFailure(_ error: Error, for asked: Int? = nil) {
        working = false
        guard asked ?? ticket == ticket else { return }
        problem = Problem.sentence("Pardner could not do this", error, next: "Try again.")
    }

    /// The window closed: the edit and the last sentence go, and the edit and sentence of an answer still on its way are ignored.
    func clear() {
        (edited, problem) = (nil, nil)
        ticket += 1
    }

    /// The pairing ended: nothing of this person's name is kept.
    func reset() {
        clear()
        queued = nil
        pairing += 1
    }
}
