// What the main window's channel acts read and do (new channel design 5): the controller's channel state as the sidebar and a channel's
// header draw it, and the sheet that makes a channel (New channel) or binds one to a folder (Bind to a folder…). The controller decides;
// this holds the sheet's fields and what its last act answered.
import Conversation
import Foundation
import Observation
import Relay

@MainActor @Observable
public final class ChannelsModel {
    /// What the open sheet is for: a new channel, or a new `/bind` prompt in a channel.
    public enum Sheet: Equatable {
        case create
        case bind(channel: Data)
    }

    /// An active bot as the picker lists it.
    public struct BotChoice: Equatable, Identifiable {
        public let id: Data
        public let name: String
    }

    /// What Create or Bind would ask of the controller.
    enum Request: Equatable {
        case create(bot: Data, folder: String)
        case bind(channel: Data, draft: OutboxDraft)
    }

    public private(set) var state = ChannelsState()
    public private(set) var sheet: Sheet?
    public var folder = ""
    /// The bot the person picked; the first one stands in while it is nil or no longer active.
    public var bot: Data?
    public private(set) var problem: String?
    public private(set) var working = false
    /// Which opening of the sheet an answer belongs to: a late answer never touches a sheet opened since.
    private(set) var ticket = 0

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

    func apply(_ next: ChannelsState) { state = next }

    /// The pairing ended: the sheet and its fields go.
    func reset() {
        sheet = nil
        clearFields()
    }

    // MARK: what the views draw

    /// The log is read: before that the controller refuses every act as not ready.
    public var ready: Bool { devices.ready }

    /// The person's active bots by profile name, the id breaking a tie: two bots may share a name.
    public func choices(names: [Data: String]) -> [BotChoice] {
        devices.state.rows.filter { $0.kind == .bot && $0.active }
            .map { BotChoice(id: $0.id, name: names[$0.id] ?? Naming.short($0.id)) }
            .sorted { $0.name != $1.name ? $0.name < $1.name : $0.id.lexicographicallyPrecedes($1.id) }
    }

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

    /// Opens the sheet for a new channel with empty fields; nothing opens before the log is read.
    public func openNew() {
        guard ready else { return }
        open(.create)
    }

    /// Opens the sheet for a new `/bind` prompt in `channel`, with `bot` (the channel's own, see `bot(of:)`) picked; nothing opens for a faulted channel.
    public func openBind(channel: Data, bot: Data? = nil) {
        guard canBind(channel) else { return }
        open(.bind(channel: channel))
        self.bot = bot
    }

    /// The bot a channel's `/bind` goes to: the `to` of its latest `/bind` prompt (the creation's), else the bot of its newest session.
    static func bot(of channel: Channel) -> Data? {
        channel.messages.last { $0.kind == 2 && $0.shown.hasPrefix("/bind ") }?.to ?? channel.sessions.first?.bot
    }

    private func open(_ next: Sheet) {
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

    private func clearFields() { (folder, bot, problem, working) = ("", nil, nil, false) }

    /// Typing takes back what the last act answered.
    public func edited() { problem = nil }

    /// The person picked a bot: the last error was about the choice before.
    public func pick(_ choice: Data?) {
        bot = choice
        problem = nil
    }

    // MARK: the acts

    func request(names: [Data: String]) -> Request? {
        guard let sheet, !trimmedFolder.isEmpty, let bot = resolvedBot(names: names) else { return nil }
        switch sheet {
        case .create: return .create(bot: bot, folder: trimmedFolder)
        case .bind(let channel): return .bind(channel: channel, draft: Self.bindDraft(bot: bot, folder: trimmedFolder))
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
            case .create(let bot, let folder):
                do { finishCreate(try await controller.createChannel(bot: bot, folder: folder), for: asked) } catch { finishFailure(error, for: asked) }
            case .bind(let channel, let draft):
                do { finishSend(try await controller.send(channel: channel, draft: draft), for: asked) } catch { finishFailure(error, for: asked) }
            }
        }
    }

    /// The controller threw: the sheet stays with its fields, and the reason is told as it is (the connection's own faults come through the phase).
    func finishFailure(_ error: Error, for asked: Int? = nil) {
        guard asked ?? ticket == ticket, sheet != nil else { return }
        (working, problem) = (false, "Pardner could not do this: \(error.localizedDescription).")
    }

    func finishCreate(_ outcome: CreateOutcome, for asked: Int? = nil) {
        guard asked ?? ticket == ticket, sheet != nil else { return }
        working = false
        switch outcome {
        case .created: close()
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

    private static let notReady = "Pardner is still reading your devices. Try again in a moment."
    private static let notConnected = "Pardner is not connected. Try again in a moment."
}
