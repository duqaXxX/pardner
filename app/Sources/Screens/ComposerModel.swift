// What a composer decides (composer design 2): what each of the five cases sends and with which body, the label and its bot list, the keys, the
// rows of the messages on their way, and the drafts. One model per composer: the channel's under the Conversation tab and each thread's under
// its panel, kept by `Composers` for the app's life. The controller sends; this holds the field, the rows and what the last act answered.
import Conversation
import Foundation
import Observation
import Relay

/// How a composer queues a message: `PairingController.send(channel:draft:)`, or a stand-in.
public typealias ComposerSender = @MainActor (Data, OutboxDraft) async throws -> SendOutcome

@MainActor @Observable
public final class ComposerModel {
    /// Whether the composer takes text, and if not why.
    public enum Availability: Equatable {
        case ready
        /// The device list has not been read since the start: a session could be taken for someone else's.
        case readingDevices
        /// The thread's opening message is not read yet, so what its composer sends is not known.
        case readingThread
        /// The session's bot is no longer one of the person's devices.
        case botRemoved
    }

    /// Where a message on its way stands, as its row says it.
    public enum Status: Equatable {
        case sending
        /// The relay holds it and this device has not read it back: nothing more to say.
        case sent
        /// The call did not queue it; the line says why.
        case notSent(String)
        /// The relay refused it: the outbox told it so.
        case notDelivered

        /// A row that stays until the owner closes it.
        public var canDismiss: Bool {
            switch self {
            case .notSent, .notDelivered: true
            case .sending, .sent: false
            }
        }
    }

    /// A message of this composer that the reading does not hold yet.
    public struct Row: Equatable, Identifiable {
        public let id: Int
        public let text: String
        /// The bot a prompt goes to; nil for a text.
        public let to: Data?
        public let status: Status
    }

    private enum Phase: Equatable {
        case calling
        case failed(String)
        /// The outbox item `name`; `seen` once an `outbox` effect has listed it.
        case bound(name: Data, seen: Bool)
        case refused
    }

    private struct Entry {
        let id: Int
        let kind: Int
        let to: Data?
        let text: String
        let content: String
        /// Made from an outbox item that no call of this composer queued (a restart, or the /bind of a sheet).
        let fromOutbox: Bool
        /// The outbox item's name, once it is known.
        var name: Data?
        var phase: Phase
    }

    public let channel: Data
    /// The key of the thread this composer answers in; nil for the channel's.
    public let thread: String?
    public private(set) var text = ""
    /// The bot the channel composer's message is a prompt to; nil sends a text.
    public private(set) var label: Data?
    public private(set) var picking = false
    public private(set) var pickIndex = 0
    /// What the last key or send refused to do, until the next edit.
    public private(set) var notice: String?

    private var entries: [Entry] = []
    private var nextID = 0
    /// The state of each item of this place that the last `outbox` effect listed.
    private var known: [Data: OutboxItemState] = [:]
    /// Refused items not yet bound to a row: one can be told inside the very call that queues it, before the name is known (design 2.7).
    private var refusedPending: [OutboxItemRow] = []
    /// The names of rows the owner closed: the controller and the registry still hand their items over, and they stay gone.
    private var dismissed: Set<Data> = []
    private let conversation: ConversationModel
    private let devices: DevicesModel
    private let send: ComposerSender

    public init(channel: Data, thread: String?, conversation: ConversationModel, devices: DevicesModel, send: @escaping ComposerSender) {
        (self.channel, self.thread, self.conversation, self.devices, self.send) = (channel, thread, conversation, devices, send)
    }

    /// The relay's frame is 1,048,576 bytes with its header, its seal and the files' list: a body past this is not sent.
    static let sizeLimit = 1_000_000

    // MARK: where it sends

    private var names: [Data: String] { conversation.reading.profiles.mapValues(\.name) }
    private var threadRoot: Message? { thread.flatMap { conversation.reading.channels[channel]?.threads[$0]?.root } }

    /// The bot a thread's prompts go to: the root's `to` while it is a prompt to one of the person's bots.
    private var sessionBot: DeviceRow? {
        guard let root = threadRoot, root.kind == 2, let to = root.to else { return nil }
        return devices.state.rows.first { $0.id == to && $0.kind == .bot }
    }

    public var availability: Availability {
        guard devices.ready else { return .readingDevices }
        guard thread != nil else { return .ready }
        guard threadRoot != nil else { return .readingThread }
        if let bot = sessionBot, !bot.active { return .botRemoved }
        return .ready
    }

    /// The words under a composer that takes no text.
    public var disabledLine: String? {
        switch availability {
        case .ready: nil
        case .readingDevices: "Reading your devices\u{2026}"
        case .readingThread: "Reading this thread\u{2026}"
        case .botRemoved: "This bot was removed from your devices."
        }
    }

    /// The bot a message goes to as a prompt, or nil when it is a text.
    private var promptBot: Data? { thread == nil ? label : sessionBot?.id }

    /// The bots the label offers: the person's active ones, by profile name.
    public func choices() -> [ChannelsModel.BotChoice] { devices.activeBots(names: names) }

    /// The name a label or a row's chip shows for a bot.
    public func name(of bot: Data) -> String { names[bot] ?? Naming.short(bot) }

    // MARK: the field and its keys

    /// The field's text changed. `@` typed first in an empty channel composer opens the bot list; in a thread it is plain text.
    public func edited(_ new: String) {
        let old = text
        text = new
        notice = nil
        if thread == nil, label == nil, old.isEmpty, new == "@", !choices().isEmpty {
            (picking, pickIndex) = (true, 0)
        } else if picking, new != "@" {
            picking = false
        }
    }

    /// The pick becomes the label in front of the text, and the `@` that asked for the list goes.
    public func pick(_ bot: Data) {
        guard picking else { return }
        (label, text, picking, notice) = (bot, "", false, nil)
    }

    /// Arrow keys move through the list, without wrapping.
    public func movePick(_ step: Int) {
        guard picking else { return }
        pickIndex = min(max(pickIndex + step, 0), max(choices().count - 1, 0))
    }

    /// Escape closes the list and leaves the `@` as text.
    public func closePicker() { picking = false }

    /// Backspace with the caret at the start of the text removes the label; false when there is none to remove.
    public func backspaceAtStart() -> Bool {
        guard label != nil else { return false }
        label = nil
        return true
    }

    /// Return: the list picks, else the text is sent. Shift-Return and a Return that commits an input method's marked text are the field's own.
    /// True when the key was taken here.
    public func returnPressed(shift: Bool, marked: Bool) -> Bool {
        if shift || marked { return false }
        if picking {
            let all = choices()
            if all.indices.contains(pickIndex) { pick(all[pickIndex].id) }
            return true
        }
        submit()
        return true
    }

    /// A paste of a file or an image: nothing is sent until a design seals file keys at rest.
    public func pasteRefused() { notice = "Files cannot be sent yet." }

    // MARK: sending

    /// Sends the field as one message and leaves the field empty. Nothing is sent for an empty text, a composer that is not ready, a command with no
    /// bot to read it, or a body past the frame; the last two say why. The task ends when the call has answered.
    @discardableResult
    public func submit() -> Task<Void, Never>? {
        guard availability == .ready, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        var bot = promptBot
        if thread == nil, let label, !choices().contains(where: { $0.id == label }) {
            notice = "This bot was removed from your devices."
            return nil
        }
        if bot == nil, let first = text.first, first == "/" || first == "!" {
            notice = thread == nil
                ? "Mention a bot to send it a command. To send people text that starts with / or !, begin it with a space."
                : "Commands go to a bot: use a session's thread."
            return nil
        }
        let content = Self.body(prompt: bot != nil, text: text, thread: thread)
        if content.utf8.count > Self.sizeLimit {
            notice = "This message is too long to send."
            return nil
        }
        let draft = OutboxDraft(kind: bot == nil ? 1 : 2, to: bot, content: content)
        bot = nil
        entries.append(Entry(id: nextID, kind: Int(draft.kind), to: draft.to, text: text, content: content, fromOutbox: false, name: nil, phase: .calling))
        let id = nextID
        nextID += 1
        (text, label, picking, notice) = ("", nil, false, nil)
        let (channel, send) = (channel, send)
        return Task { [weak self] in
            do { self?.finish(id, try await send(channel, draft)) } catch {
                self?.fail(id, "Pardner could not send the message: \(error.localizedDescription).")
            }
        }
    }

    /// The body's JSON as the relay chat module reads it: a prompt is `{text, thread?}`, a text `{markdown, thread?}` (its design 3.7 and 3.8).
    static func body(prompt: Bool, text: String, thread: String?) -> String {
        var fields: [String: Any] = [prompt ? "text" : "markdown": text]
        if let thread { fields["thread"] = thread }
        let json = try? JSONSerialization.data(withJSONObject: fields, options: [.withoutEscapingSlashes, .sortedKeys])
        return String(decoding: json ?? Data(), as: UTF8.self)
    }

    private func finish(_ id: Int, _ outcome: SendOutcome) {
        guard var entry = entries.first(where: { $0.id == id }) else { return }
        switch outcome {
        case .queued(let name):
            guard entry.phase == .calling else { return }
            entry.name = name
            if let duplicate = entries.first(where: { $0.fromOutbox && $0.name == name }) {
                // The outbox effect came before this answer and made a row of its own: this row takes over its state.
                entries.removeAll { $0.id == duplicate.id }
                entry.phase = duplicate.phase
            } else if let pending = refusedPending.firstIndex(where: { $0.name == name }) {
                refusedPending.remove(at: pending)
                entry.phase = .refused
            } else {
                entry.phase = .bound(name: name, seen: false)
            }
            replace(entry)
        case .notSaved: failed(entry, "Pardner could not save the message. Try again.")
        case .ended: failed(entry, "Pardner is not connected. Try again in a moment.")
        case .refused(let reason):
            let line = switch reason {
            case "fault": "Pardner stopped sending in this channel."
            case "not-member": "This Mac is not a member of this channel."
            case "not-ready": "Pardner could not save the message. Try again."
            case "bad-input": "This message cannot be sent."
            default: "The message could not be sent (\(reason))."
            }
            failed(entry, line)
        }
        flushRefused()
    }

    private func fail(_ id: Int, _ line: String) {
        if let entry = entries.first(where: { $0.id == id }) { failed(entry, line) }
        flushRefused()
    }

    private func replace(_ entry: Entry) {
        if let i = entries.firstIndex(where: { $0.id == entry.id }) { entries[i] = entry }
    }

    /// The call did not queue it: its row says why, and an empty field takes the text back to send again.
    private func failed(_ entry: Entry, _ line: String) {
        var entry = entry
        entry.phase = .failed(line)
        replace(entry)
        if text.isEmpty, label == nil {
            text = entry.text
            if thread == nil { label = entry.to }
        }
    }

    /// A failed or refused row goes when the owner closes it.
    public func dismiss(_ id: Int) {
        entries.removeAll { entry in
            guard entry.id == id else { return false }
            switch entry.phase {
            case .failed, .refused:
                if let name = entry.name { dismissed.insert(name) }
                return true
            case .calling, .bound: return false
            }
        }
    }

    // MARK: the outbox

    /// The body's thread key: absent at the top level, where the channel's composer draws it.
    private static func threadKey(_ content: String) -> String? {
        ((try? JSONSerialization.jsonObject(with: Data(content.utf8))) as? [String: Any])?["thread"] as? String
    }

    private static func shownText(_ content: String) -> String {
        let fields = (try? JSONSerialization.jsonObject(with: Data(content.utf8))) as? [String: Any]
        return (fields?["text"] as? String) ?? (fields?["markdown"] as? String) ?? ""
    }

    /// A channel's outbox as the link tells it now, with the items it dropped as refused. An item no row holds by name is drawn from its content
    /// (a restart, or a bind made in a sheet); a call's own row takes it over when the call answers. A bound item that the list stops naming
    /// was read back (the outbox drops an item only then, or as refused, which is told): it is hidden, never `Not delivered.`
    func take(items all: [OutboxItemRow]) {
        let mine = all.filter { !dismissed.contains($0.name) && $0.re == nil && ($0.kind == 1 || $0.kind == 2) && Self.threadKey($0.content) == thread }
        known = Dictionary(mine.filter { $0.state != .refused }.map { ($0.name, $0.state) }, uniquingKeysWith: { first, _ in first })
        for item in mine {
            let index = entries.firstIndex { $0.name == item.name }
            if item.state == .refused {
                if let index {
                    entries[index].phase = .refused
                } else if !refusedPending.contains(where: { $0.name == item.name }) {
                    refusedPending.append(item)
                    flushRefused() // in the order told, unless a call in flight may own it
                }
            } else if let index {
                if case .bound = entries[index].phase { entries[index].phase = .bound(name: item.name, seen: true) }
            } else {
                entries.append(Entry(id: nextID, kind: item.kind, to: item.to, text: Self.shownText(item.content), content: item.content, fromOutbox: true,
                                     name: item.name, phase: .bound(name: item.name, seen: true)))
                nextID += 1
            }
        }
        flushRefused()
        let held = heldNames
        entries.removeAll { if case .bound(let name, let seen) = $0.phase { held.contains(name) || (seen && known[name] == nil) } else { false } }
    }

    /// With no call in flight a refused item no row will claim is drawn from its content.
    private func flushRefused() {
        guard !entries.contains(where: { $0.phase == .calling }) else { return }
        for item in refusedPending {
            entries.append(Entry(id: nextID, kind: item.kind, to: item.to, text: Self.shownText(item.content), content: item.content, fromOutbox: true,
                                 name: item.name, phase: .refused))
            nextID += 1
        }
        refusedPending = []
    }

    /// The names of the messages the reading holds in this channel.
    private var heldNames: Set<Data> { Set(conversation.reading.channels[channel]?.messages.map(\.name) ?? []) }

    /// The rows to draw in place: each message not yet read back, in the order it was sent.
    public func rows() -> [Row] {
        let held = heldNames
        let calling = Set(entries.filter { $0.phase == .calling }.map(\.content))
        return entries.compactMap { entry in
            if entry.fromOutbox, case .bound = entry.phase, calling.contains(entry.content) { return nil } // the call that queued it is still to answer
            let status: Status
            switch entry.phase {
            case .calling: status = .sending
            case .failed(let line): status = .notSent(line)
            case .refused: status = .notDelivered
            case .bound(let name, _):
                if held.contains(name) { return nil }
                if let state = known[name] { status = state == .waiting ? .sending : .sent } else { status = .sending }
            }
            return Row(id: entry.id, text: entry.text, to: entry.to, status: status)
        }
    }
}

/// The composers of the main window, one per channel and per thread, kept while the app runs so that switching channel or closing a panel loses
/// no draft and no row. Nothing is stored: a draft not sent is not necessary to keep past a quit (invariant 3).
@MainActor
public final class Composers {
    private struct Place: Hashable {
        let channel: Data
        let thread: String?
    }

    private let conversation: ConversationModel
    private let devices: DevicesModel
    private let send: ComposerSender
    private var made: [Place: ComposerModel] = [:]
    /// The last outbox of each channel: a composer made after a restart's effect still draws what waits.
    private var outboxes: [Data: [OutboxItemRow]] = [:]
    /// The refused items the controller told, kept for the app's life: a composer made later still draws them.
    private var refused: [Data: [OutboxItemRow]] = [:]

    public init(conversation: ConversationModel, devices: DevicesModel, send: @escaping ComposerSender) {
        (self.conversation, self.devices, self.send) = (conversation, devices, send)
    }

    /// The composer of a channel, or of one of its threads.
    public func composer(channel: Data, thread: String? = nil) -> ComposerModel {
        let place = Place(channel: channel, thread: thread)
        if let existing = made[place] { return existing }
        let model = ComposerModel(channel: channel, thread: thread, conversation: conversation, devices: devices, send: send)
        model.take(items: items(of: channel))
        made[place] = model
        return model
    }

    private func items(of channel: Data) -> [OutboxItemRow] { (refused[channel] ?? []) + (outboxes[channel] ?? []) }

    /// Each channel's outbox as the controller holds it, with its refused items, which are kept here; a channel it no longer lists has none.
    public func take(_ state: ChannelsState) {
        outboxes = state.outboxes
        for (channel, rows) in state.undelivered {
            let have = Set((refused[channel] ?? []).map(\.name))
            refused[channel, default: []] += rows.filter { !have.contains($0.name) }
        }
        for (place, model) in made { model.take(items: items(of: place.channel)) }
    }

    /// The pairing ended: drafts and rows go.
    func reset() {
        made = [:]
        outboxes = [:]
        refused = [:]
    }
}
