// What the main window's channel acts read and do (new channel design 5): the controller's channel state as the sidebar and a channel's
// header draw it, and the sheet that makes a channel (New channel) or binds one to a folder (Bind to a folder…). The controller decides;
// this holds the sheet's fields and what its last act answered.
import Conversation
import Foundation
import Observation
import Relay

@MainActor @Observable
public final class ChannelsModel {
    /// What a name is for (names design 4.1 and 4.3): a channel or this Mac. The person's name is the Settings window's Profile pane.
    public enum NameTarget: Equatable {
        case channel(Data)
        case device
    }

    /// What the open sheet is for: a new channel, a new `/bind` prompt in a channel, or a name.
    public enum Sheet: Equatable {
        case create
        case bind(channel: Data)
        case rename(NameTarget)
        /// The channel's panel (channel folder design, 2).
        case settings(channel: Data)
    }

    /// What Save would ask of the controller: the kind of name (14 a channel's, 16 this device's), its channel and the text.
    struct NameRequest: Equatable {
        let kind: Int
        let target: Data?
        let text: String
    }

    /// An active bot as the picker lists it.
    public struct BotChoice: Equatable, Identifiable {
        public let id: Data
        /// What the person types after `@` to name it.
        public let name: String
        /// The name is the label its pairing string gave, a claim: drawn in quotes, as the Devices screen and the sidebar draw it.
        public var isLabel = false
        /// The name as a picker draws it.
        public var shown: String { isLabel ? DevicesModel.quoted(name) : name }
    }

    /// What Create or Bind would ask of the controller.
    enum Request: Equatable {
        case create(bot: Data, folder: String, name: String? = nil)
        case bind(channel: Data, draft: OutboxDraft)
    }

    public private(set) var state = ChannelsState()
    public private(set) var sheet: Sheet?
    public var folder = ""
    /// What the name sheet's field holds.
    public var nameText = ""
    /// The name the sheet opened with.
    private var nameShown: String?
    /// What the channel-name field left out or cut, until the next good edit.
    public private(set) var nameNote: String?
    // What the model last wrote into the field itself (the folder's suggestion, a normalised text), and whether the person typed a name of their own.
    private var written = ""
    private var nameTouched = false
    /// The bot the person picked; the first one stands in while it is nil or no longer active.
    public var bot: Data?
    public private(set) var problem: String?
    public private(set) var working = false
    /// Which opening of the sheet an answer belongs to: a late answer never touches a sheet opened since.
    private(set) var ticket = 0
    /// Which showing of the form window this is: it changes when a form opens over none, not when Change Folder… swaps the form in the open window.
    private(set) var epoch = 0
    /// The section the sheet was opened from (New Channel… in a section's menu); `onCreated` hands it on with the new channel's id.
    private var createSection: String?
    /// A channel was made from a section: its id and that section (sidebar sections design 7).
    @ObservationIgnored var onCreated: ((Data, String) -> Void)?
    /// Shows the form window, set once from the main scene. Every public opener calls it after setting its state, on every request: an open
    /// window comes to the front. While it is nil (the main scene has not appeared) an opener changes nothing.
    @ObservationIgnored public var present: (() -> Void)?

    private let devices: DevicesModel
    private let controller: PairingController?
    private var watching: Task<Void, Never>?

    public init(controller: PairingController, devices: DevicesModel) { (self.controller, self.devices) = (controller, devices) }

    /// A model with a fixed state and no controller: what the screenshot tool and the tests draw.
    public init(state: ChannelsState = ChannelsState(), devices: DevicesModel = DevicesModel(), sheet: Sheet? = nil, folder: String = "", problem: String? = nil) {
        (controller, self.devices, self.state, self.sheet, self.folder, self.problem) = (nil, devices, state, sheet, folder, problem)
    }

    /// Follows the controller's channel state; its first value is read at once, as the stream yields changes only.
    func start() {
        guard let controller, watching == nil else { return }
        watching = Task { [weak self] in
            let first = await controller.channels
            self?.apply(first)
            for await next in controller.channelStates { self?.apply(next) }
        }
    }

    /// The composers learn each channel's outbox from the same state (they keep the rows a later state no longer lists).
    @ObservationIgnored weak var composers: Composers?

    func apply(_ next: ChannelsState) {
        state = next
        composers?.take(next)
        // The composers hold what was refused now: the controller need not keep it.
        guard let controller else { return }
        for (channel, rows) in next.undelivered { Task { await controller.acknowledgeUndelivered(channel: channel, names: Set(rows.map(\.name))) } }
    }

    /// The pairing ended: the sheet and its fields go.
    func reset() {
        sheet = nil
        clearFields()
    }

    // MARK: what the views draw

    /// The log is read: before that the controller refuses every act as not ready.
    public var ready: Bool { devices.ready }

    /// The person's active bots by profile name, the id breaking a tie: two bots may share a name.
    public func choices(names: [Data: String]) -> [BotChoice] { devices.activeBots(names: names) }

    /// The picker shows only when there is a choice: two or more active bots.
    public func showsBotPicker(names: [Data: String]) -> Bool { choices(names: names).count >= 2 }

    /// The bot a request goes to: the picked one while it is active, else the first.
    public func resolvedBot(names: [Data: String]) -> Data? {
        let all = choices(names: names)
        return all.first { $0.id == bot }?.id ?? all.first?.id
    }

    private var trimmedFolder: String { folder.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Create or Bind is offered with a folder, a bot and no act in flight.
    public func canSubmit(names: [Data: String]) -> Bool { ready && !working && !trimmedFolder.isEmpty && resolvedBot(names: names) != nil }

    /// The sidebar's row for the channel being created; nil once the reading holds it (`known`, the ids of the channels read), when it shows by its short id.
    public func creatingRow(known: Set<Data>) -> String? {
        guard let pending = state.creating, !known.contains(pending.channel) else { return nil }
        return "Creating\u{2026}"
    }

    /// The relay's refusal of the last new channel, until the next creation.
    public var refusalLine: String? { state.refusal.map { "The relay refused the new channel (code \($0.code))." } }

    /// The header's line for a channel the link stopped sending in; nil for any other.
    public func faultLine(_ channel: Data) -> String? {
        state.faulted.contains(channel) ? "Pardner stopped sending in this channel: the relay answered what it should not." : nil
    }

    /// A faulted channel takes no new prompt: the link refuses it.
    public func canBind(_ channel: Data) -> Bool { ready && !state.faulted.contains(channel) }

    // MARK: the sheet

    /// Opens the sheet for a new channel with empty fields, from a section's menu when `section` is given; nothing opens before the log is read.
    public func openNew(in section: String? = nil) {
        guard admitsRequest(), ready else { return }
        open(.create)
        createSection = section
        present?()
    }

    /// Opens the sheet for a new `/bind` prompt in `channel`, with `bot` (the channel's own, see `bot(of:)`) picked; nothing opens for a faulted channel.
    public func openBind(channel: Data, bot: Data? = nil) {
        guard admitsRequest(), canBind(channel) else { return }
        open(.bind(channel: channel))
        self.bot = bot
        present?()
    }

    /// The first line of each public opener, before any write: nothing opens while there is no window to show it, and a form already open
    /// comes to the front unchanged (the new request is dropped).
    private func admitsRequest() -> Bool {
        guard let present else { return false }
        guard sheet == nil else { present(); return false }
        return true
    }

    /// The bot a channel's `/bind` goes to: the `to` of its latest `/bind` prompt (the creation's), else the `to` of its newest prompt (a word has no session, and still names its bot).
    static func bot(of channel: Channel) -> Data? {
        channel.messages.last { $0.kind == 2 && $0.shown.hasPrefix("/bind ") }?.to ?? channel.messages.last { $0.kind == 2 }?.to
    }

    private func open(_ next: Sheet) {
        if sheet == nil { epoch += 1 }
        ticket += 1
        clearFields()
        sheet = next
    }

    /// Closes the sheet and drops its fields; an answer still to come for it is ignored.
    public func close() {
        ticket += 1
        sheet = nil
        clearFields()
    }

    /// The window closed: ends the form it showed, and not a newer one opened since.
    func close(ifEpoch shown: Int) {
        if shown == epoch { close() }
    }

    /// Opens the channel's panel.
    public func openSettings(channel: Data) {
        guard admitsRequest() else { return }
        open(.settings(channel: channel))
        present?()
    }

    /// Change Folder… in the panel: the form's own step from `settings` to `bind`, in the same window; nothing happens for a faulted channel.
    public func changeFolder(bot: Data?) {
        guard case .settings(let channel)? = sheet, canBind(channel) else { return }
        open(.bind(channel: channel))
        self.bot = bot
    }

    private func clearFields() {
        (folder, nameText, nameNote, written, nameTouched, bot, problem, working) = ("", "", nil, "", false, nil, nil, false)
        createSection = nil
    }

    /// Typing takes back what the last act answered; a new channel's name follows the folder until the person types one.
    public func edited() {
        problem = nil
        guard sheet == .create, !nameTouched else { return }
        written = ChannelNameRule.suggestion(forFolder: folder)
        nameText = written
        nameNote = nil // a line about an earlier name is no line about this one
    }

    /// The channel-name field changed: the text becomes what the rule makes of it, and the line says what was left out. A change the model made
    /// itself is no new typing, so it keeps the line.
    public func channelNameEdited() {
        problem = nil
        let result = ChannelNameRule.normalise(nameText)
        let theirs = nameText != written // typed or pasted by the person, whether or not the rule then rewrites it
        if theirs { nameTouched = true }
        if result.text != nameText {
            nameText = result.text
            nameNote = result.note
            written = result.text
        } else if theirs {
            nameNote = nil
        }
    }

    /// The line for a name another of the person's channels already has (the relay cannot tell: names are encrypted); nil for none.
    public func duplicateWarning(channels: [Data: String]) -> String? {
        let own: Data? = if case .rename(.channel(let channel))? = sheet { channel } else { nil }
        guard !nameText.isEmpty, channels.contains(where: { $0.key != own && $0.value == nameText }) else { return nil }
        return "Another of your channels is already called \(nameText)."
    }

    /// The person picked a bot: the last error was about the choice before.
    public func pick(_ choice: Data?) {
        bot = choice
        problem = nil
    }

    // MARK: names

    /// Opens the name sheet for `target`, filled with the name now shown; nothing opens before the log is read.
    public func openRename(_ target: NameTarget, current: String?) {
        guard admitsRequest(), ready else { return }
        if case .channel(let channel) = target, !canRename(channel) { return }
        open(.rename(target))
        nameText = current ?? ""
        nameShown = current
        present?()
    }

    /// A faulted channel takes no name: the link would never write it.
    public func canRename(_ channel: Data) -> Bool { ready && !state.faulted.contains(channel) }

    /// The ends are trimmed: a name has no space at either end.
    func nameRequest() -> NameRequest? {
        guard case .rename(let target)? = sheet else { return nil }
        let text = nameText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        switch target {
        case .channel(let channel): return NameRequest(kind: 14, target: channel, text: text)
        case .device: return NameRequest(kind: 16, target: nil, text: text)
        }
    }

    /// Save is offered with a name that differs from the one shown, and no act in flight.
    public var canSaveName: Bool { ready && !working && nameRequest().map { $0.text != nameShown } ?? false }

    /// Asks the controller to set the name the sheet holds; the answer lands in `finishName`.
    public func saveName() {
        guard let controller, canSaveName, let request = nameRequest() else { return }
        (working, problem) = (true, nil)
        let asked = ticket
        Task {
            do { finishName(try await controller.setName(kind: request.kind, target: request.target, text: request.text), for: asked) } catch { finishFailure(error, for: asked) }
        }
    }

    func finishName(_ outcome: SendOutcome, for asked: Int? = nil) {
        guard asked ?? ticket == ticket, case .rename(let target)? = sheet else { return }
        working = false
        switch outcome {
        case .queued: close()
        case .notSaved: problem = "Pardner could not save the name. Try again."
        case .ended: problem = Self.notConnected
        case .refused(let reason):
            problem = switch (reason, target) {
            case ("bad-input", .channel): "Use only lowercase letters, digits, - and _, up to 80 characters."
            case ("bad-input", .device): Self.deviceNameRule
            case ("not-ready", _): Self.notReady
            case ("not-member", _): "This Mac is not a member of this channel."
            default: "Pardner could not set the name. Try again in a moment."
            }
        }
    }

    // MARK: the acts

    func request(names: [Data: String]) -> Request? {
        guard let sheet, !trimmedFolder.isEmpty, let bot = resolvedBot(names: names) else { return nil }
        switch sheet {
        case .create: return .create(bot: bot, folder: trimmedFolder, name: nameText.isEmpty ? nil : nameText)
        case .bind(let channel): return .bind(channel: channel, draft: Self.bindDraft(bot: bot, folder: trimmedFolder))
        case .rename, .settings: return nil
        }
    }

    /// A kind 2 prompt to the bot: `/bind` with the folder as the bot's `/bind` takes it.
    static func bindDraft(bot: Data, folder: String) -> OutboxDraft {
        let json = try? JSONSerialization.data(withJSONObject: ["text": "/bind \(folder)"], options: [.withoutEscapingSlashes])
        return OutboxDraft(kind: 2, to: bot, content: String(decoding: json ?? Data(), as: UTF8.self))
    }

    /// Asks the controller for what the sheet holds; the answer lands in `finishCreate` or `finishSend`.
    public func submit(names: [Data: String]) {
        guard let controller, canSubmit(names: names), let request = request(names: names) else { return }
        (working, problem) = (true, nil)
        let asked = ticket
        Task {
            switch request {
            case .create(let bot, let folder, let name):
                do { finishCreate(try await controller.createChannel(bot: bot, folder: folder, name: name), for: asked) } catch { finishFailure(error, for: asked) }
            case .bind(let channel, let draft):
                do { finishSend(try await controller.send(channel: channel, draft: draft), for: asked) } catch { finishFailure(error, for: asked) }
            }
        }
    }

    /// The controller threw: the sheet stays with its fields, and the reason is told as it is (the connection's own faults come through the phase).
    func finishFailure(_ error: Error, for asked: Int? = nil) {
        guard asked ?? ticket == ticket, sheet != nil else { return }
        (working, problem) = (false, Problem.sentence("Pardner could not do this", error, next: "Try again."))
    }

    func finishCreate(_ outcome: CreateOutcome, for asked: Int? = nil) {
        guard asked ?? ticket == ticket, sheet != nil else { return }
        working = false
        switch outcome {
        case .created(let channel):
            let section = createSection
            close()
            if let section { onCreated?(channel, section) }
        case .notSaved: problem = "Pardner could not save the new channel. Try again."
        case .ended: problem = Self.notConnected
        case .refused(let reason):
            problem = switch reason {
            case "busy": "Another channel is being created."
            case "not-ready": Self.notReady
            case "bad-input": "Pardner could not use this folder or bot. Check the folder and try again."
            default: "The new channel could not be made (\(reason))."
            }
        }
    }

    func finishSend(_ outcome: SendOutcome, for asked: Int? = nil) {
        guard asked ?? ticket == ticket, sheet != nil else { return }
        working = false
        switch outcome {
        case .queued: close()
        case .notSaved: problem = "Pardner could not save the message. Try again."
        case .ended: problem = Self.notConnected
        case .refused(let reason):
            problem = switch reason {
            case "fault": "Pardner stopped sending in this channel."
            case "not-member": "This Mac is not a member of this channel."
            case "not-ready": Self.notReady
            case "bad-input": "Pardner could not use this folder or bot. Check the folder and try again."
            default: "The message could not be sent (\(reason))."
            }
        }
    }

    /// What a device's name must be; a section's name is under the same rule.
    static let deviceNameRule = "Use up to 64 characters, with no hidden characters."
    private static let notReady = "Pardner is still reading your devices. Try again in a moment."
    private static let notConnected = "Pardner is not connected. Try again in a moment."
}
