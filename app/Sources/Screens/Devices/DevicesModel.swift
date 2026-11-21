// What the Devices screen reads and does (device pairing design 3.1, 3.4, 3.6, 3.9): the controller's list as the views draw it, the
// add flow's form, the removal's choices and one method for each act the controller allows. The controller decides; this holds only what
// a view needs between two states (the pasted text and its refusal, the page, the choices the person has ticked).
import Foundation
import Observation
import Relay

@MainActor @Observable
public final class DevicesModel {
    /// The sheet's pages: the list, the form that adds a device and the confirmation that removes devices.
    public enum Page: Equatable { case list, add, remove }

    /// The sheet is open; the menu item and the sidebar's button set it.
    public var isOpen = false
    public private(set) var page: Page = .list
    public private(set) var state = DevicesState()
    /// The three values for a new device; nil until the controller has them.
    public private(set) var handoff: PairingHandoff?
    public var pasted = ""
    public private(set) var candidate: DeviceCandidate?
    public private(set) var refusal: DeviceRefusal?
    public private(set) var working = false
    /// The devices ticked on the confirmation of a removal.
    public private(set) var chosen: Set<Data> = []
    public private(set) var removalProblem: RemovalRefusal?
    private var clicked: Data?
    /// The devices the open confirmation offered: one that leaves this set went away while the person chose.
    private var offered: Set<Data> = []

    /// Told each list as it arrives: the reading model learns which devices are the person's own.
    public var onState: (@MainActor (DevicesState) -> Void)?
    private let controller: PairingController?
    private var watching: Task<Void, Never>?

    public init(controller: PairingController) { self.controller = controller }

    /// A model with a fixed state and no controller: what the screenshot tool and the previews draw.
    public init(state: DevicesState = DevicesState(), handoff: PairingHandoff? = nil, page: Page = .list, pasted: String = "", candidate: DeviceCandidate? = nil,
                refusal: DeviceRefusal? = nil, clicked: Data? = nil) {
        (controller, self.state, self.handoff, self.page, self.pasted, self.candidate, self.refusal) = (nil, state, handoff, page, pasted, candidate, refusal)
        if let clicked { (self.clicked, chosen, offered) = (clicked, [clicked], Set(state.removalChoices(clicked: clicked).map(\.id))) }
    }

    /// Follows the controller's list; its first value is read at once, as the stream yields changes only.
    func start() {
        guard let controller, watching == nil else { return }
        watching = Task { [weak self] in
            let first = await controller.deviceList
            self?.apply(first)
            for await next in controller.deviceStates { self?.apply(next) }
        }
    }

    func apply(_ next: DevicesState) {
        state = next
        onState?(next)
        // A device that went while the confirmation was open is no longer a choice; the person unticking every device is not a reason to close it.
        let available = Set(next.removalChoices(clicked: clicked ?? Data()).map(\.id))
        let gone = offered.subtracting(available)
        offered.formIntersection(available)
        chosen.formIntersection(available)
        if page == .remove, !gone.isEmpty, chosen.isEmpty { page = .list }
    }

    /// The pairing ended or the Mac is not paired: the sheet and the half-made acts go. The list stays, as the controller publishes a change only
    /// and a pairing that comes back with the same devices (a fault and Retry) publishes none; an erase publishes the empty list.
    func reset() {
        (isOpen, page, handoff) = (false, .list, nil)
        clearForm()
        (chosen, offered, clicked, removalProblem) = ([], [], nil, nil)
    }

    // MARK: what the views draw

    /// The person's active bots by profile name (the short id when none), the id breaking a tie: two bots may share a name.
    public func activeBots(names: [Data: String]) -> [ChannelsModel.BotChoice] {
        state.rows.filter { $0.kind == .bot && $0.active }
            .map { ChannelsModel.BotChoice(id: $0.id, name: names[$0.id] ?? Naming.short($0.id)) }
            .sorted { $0.name != $1.name ? $0.name < $1.name : $0.id.lexicographicallyPrecedes($1.id) }
    }

    /// The active devices, newest first: a removed device is not listed (design 3.9).
    public var rows: [DeviceRow] { state.rows.filter(\.active) }

    /// The rows of the confirmation, newest first, from the same rule as the controller's `removalChoices(clicked:)`.
    public var choices: [RemovalChoice] { state.removalChoices(clicked: clicked ?? Data()) }

    /// The log is read: before that the controller refuses every act as not ready.
    public var ready: Bool { !state.rows.isEmpty }

    /// `confirmAdd` refuses while an entry is kept and not read back (design 3.6).
    public var canAdd: Bool { ready && !state.pendingEntry }

    /// `confirmRemoval` refuses while a removal runs; this Mac never offers itself.
    public func canRemove(_ row: DeviceRow) -> Bool { ready && state.removing.isEmpty && row.active && !row.isThisMac }

    public var canConfirmRemoval: Bool { !chosen.isEmpty && state.removing.isEmpty && !working }

    /// An add waits for the log. The controller says which entry is an add: a removal's pending entry is the removal's progress, and an add
    /// made during a removal shows its own.
    public var isAdding: Bool { state.pendingAddName != nil || (state.pendingEntry && state.removing.isEmpty) }

    /// The name of the device that is being added, for the view to draw apart from the app's own words; nil when the state names none.
    public var addingName: String? { state.pendingAddName }

    public var removingLine: String? { state.removing.isEmpty ? nil : "Removing… \(state.removing.count) left" }

    /// The devices ticked that are the only holder of the keys to some earlier messages, for the warning (design 3.9).
    public var onlyHolders: [DeviceRow] { choices.filter { chosen.contains($0.id) && $0.row.onlyHolderEpochs > 0 }.map(\.row) }

    /// A name in quotes, apart from the app's own marks: no name can pass for "This Mac" (design 3.4). For a label that is only read aloud:
    /// the views draw a name with `NameText`, in a `Text` of its own.
    public static func quoted(_ name: String) -> String { "\u{201C}\(name)\u{201D}" }

    /// The label in quotes, else the kind (design 3.3).
    public static func title(_ row: DeviceRow) -> String { row.label.map(quoted) ?? kindName(row.kind) }

    public static func kindName(_ kind: DeviceKind) -> String { kind == .bot ? "Bot" : "App" }

    /// Who added a device: a name is a value for the view to draw apart, never part of a sentence made here.
    public enum AdderLine: Equatable {
        case firstDevice, removedDevice, label(String), shortForm(String), unknown
    }

    /// The first device (entry 0) says so; a device a reset named, which no device added, has no line.
    public func adder(_ row: DeviceRow) -> AdderLine? {
        switch row.adder {
        case .none: row.position == 0 ? .firstDevice : nil
        case .removedDevice: .removedDevice
        case .device(let id):
            state.rows.first { $0.id == id }.map { $0.label.map(AdderLine.label) ?? .shortForm($0.shortForm) } ?? .unknown
        }
    }

    // MARK: the sheet

    /// A sheet that was left open earlier does not come back half done.
    public func open() {
        guard !isOpen else { return }
        isOpen = true
        back()
    }

    public func close() {
        isOpen = false
        back()
    }

    public func back() {
        page = .list
        clearForm()
        (chosen, offered, clicked, removalProblem) = ([], [], nil, nil)
    }

    private func clearForm() { (pasted, candidate, refusal, working) = ("", nil, nil, false) }

    // MARK: adding a device (design 3.1, 3.4, 3.6)

    public func showAdd() {
        guard canAdd else { return }
        page = .add
        guard let controller else { return }
        Task { handoff = await controller.handoffValues() }
    }

    /// Typing takes back the refusal and the candidate: the confirmation belongs to the string it was made for.
    public func edited() { (candidate, refusal) = (nil, nil) }

    public func check() {
        guard let controller, !working else { return }
        (working, refusal, candidate) = (true, nil, nil)
        let text = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { finishCheck(await controller.inspect(pairingString: text), text: text) }
    }

    /// The field as the check read it: an answer applies to that text, on the page it was asked on.
    private func stillThere(_ text: String) -> Bool { page == .add && pasted.trimmingCharacters(in: .whitespacesAndNewlines) == text }

    func finishCheck(_ result: Result<DeviceCandidate, DeviceRefusal>, text: String) {
        working = false
        guard stillThere(text) else { return }
        switch result {
        case .success(let found): candidate = found
        case .failure(let why): refusal = why
        }
    }

    public func confirmAdd() {
        guard let controller, let candidate, !working else { return }
        working = true
        let text = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { finishAdd(await controller.confirmAdd(candidate), text: text) }
    }

    /// Written (nil): the form is done and the list shows the pending add, which the controller's state names; a refusal stays in place on the
    /// form, when the form is still the one the add was made on.
    func finishAdd(_ outcome: DeviceRefusal?, text: String) {
        working = false
        guard stillThere(text) else { return }
        guard let outcome else {
            page = .list
            clearForm()
            return
        }
        refusal = outcome
    }

    // MARK: removing devices (design 3.9)

    /// Opens the confirmation with the clicked device chosen.
    public func askRemoval(clicked: Data) {
        guard let row = state.rows.first(where: { $0.id == clicked }), canRemove(row) else { return }
        (self.clicked, chosen, removalProblem, page) = (clicked, [clicked], nil, .remove)
        offered = Set(choices.map(\.id))
    }

    public func toggle(_ id: Data) {
        if chosen.contains(id) { chosen.remove(id) } else { chosen.insert(id) }
        removalProblem = nil
    }

    public func confirmRemoval() {
        guard let controller, canConfirmRemoval, let clicked else { return }
        working = true
        let ids = choices.map(\.id).filter(chosen.contains)
        Task { finishRemoval(await controller.confirmRemoval(chosen: ids, clicked: clicked), for: clicked) }
    }

    /// The result of the removal asked for `asked`: it applies only while the confirmation is still the one it was asked on.
    func finishRemoval(_ outcome: RemovalRefusal?, for asked: Data) {
        guard page == .remove, clicked == asked else { return }
        working = false
        guard let outcome else { return back() }
        removalProblem = outcome
    }
}

extension RemovalRefusal {
    /// What the person reads when a removal was not started.
    public var message: String {
        switch self {
        case .nothingChosen: "Choose at least one device."
        case .thisMac: "This Mac does not remove itself. Remove it from another device."
        case .notActive: "A chosen device is no longer in your list. Choose again."
        case .running: "A removal is still running. It ends before another starts."
        case .notReady: "Pardner is still reading your devices. Try again in a moment."
        case .failed(let why): "The removal could not be started: \(why)."
        }
    }
}

extension DevicesNotice {
    /// The device the notice is about: a `.label` came in a pairing string, so the view draws it apart from the app's own words.
    public var subject: DeviceSubject {
        switch self {
        case .addRefused(let subject), .removeRefused(let subject), .entryInvalid(let subject): subject
        }
    }

    /// The app's own words for a subject that is no name, drawn as plain text; nil for a `.label`, which the view draws with `NameText`.
    public var subjectWords: String? {
        switch subject {
        case .label: nil
        case .shortForm(let kind, let short): "the \(kind == .bot ? "bot" : "app") \(short)"
        case .unknown: "a device"
        }
    }

    /// What the app says before the name; no name is in it.
    public var headline: String {
        switch self {
        case .addRefused: "Adding this device failed"
        case .removeRefused: "Removing this device failed"
        case .entryInvalid: "A change to this device could not be sent"
        }
    }

    /// What the app says after the name.
    public var detail: String? {
        switch self {
        case .addRefused: "The log refused the entry. If the device shows in the list, it was added."
        case .removeRefused: "The log refused the entry."
        case .entryInvalid: nil
        }
    }
}
