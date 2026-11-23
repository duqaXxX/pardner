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
        /// The request a reply (kind 10) answers; nil for a prompt or a text.
        let re: MessageRef?
        /// Whether the field takes the text back when the call fails: a prompt or a text typed in the field, not a command or a reply.
        let restores: Bool
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
    /// Escape closed the bot list: it stays closed until the `@` that opened it goes, or the field is a lone `@` again.
    private var pickerClosed = false
    public private(set) var pickIndex = 0
    /// What the last key or send refused to do, until the next edit.
    public private(set) var notice: String?

    private var entries: [Entry] = []
    private var cards: [MessageRef: RequestCardModel] = [:]
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

    /// The name a label or a row's chip shows for a bot: as the `@` list draws it while the bot is active.
    public func name(of bot: Data) -> String { choices().first { $0.id == bot }?.shown ?? names[bot] ?? Naming.short(bot) }

    // MARK: the field and its keys

    /// What follows a leading `@` in a channel composer with no label, while it can still become a bot's name: one word, or the start of a
    /// name with a space in it. Nil in a thread, where `@` is plain text.
    private var query: String? {
        guard thread == nil, label == nil, text.first == "@", !text.contains(where: \.isNewline) else { return nil }
        let typed = String(text.dropFirst())
        guard typed.contains(where: \.isWhitespace) else { return typed }
        return choices().contains { $0.name.lowercased().hasPrefix(typed.lowercased()) } ? typed : nil
    }

    /// The bot list, open while a leading `@` is typed and some bot's name matches it, until Escape.
    public var picking: Bool { !pickerClosed && query != nil && !matches().isEmpty }

    /// The bots the list shows for what follows the `@`, case-insensitive: the names it starts first, then the names it is inside.
    public func matches() -> [ChannelsModel.BotChoice] {
        let all = choices()
        guard let typed = query?.lowercased(), !typed.isEmpty else { return all }
        let starts = all.filter { $0.name.lowercased().hasPrefix(typed) }
        return starts + all.filter { !$0.name.lowercased().hasPrefix(typed) && $0.name.lowercased().contains(typed) }
    }

    /// The field's text changed. A leading `@` in a channel composer opens the bot list and filters it as the person types; a bot's whole
    /// name after the `@`, followed by a space, becomes the label and the rest stays as the text, once what was typed starts no bot's
    /// name (`@mini ` waits while a bot is named `mini dev`). A name that is no bot's stays text, and so does any after Escape.
    public func edited(_ new: String) {
        // A lone `@` that was not one before is a new one: the `@` the list was closed for went, by Backspace or a whole text typed over.
        let freshAt = new == "@" && text != "@"
        text = new
        notice = nil
        pickIndex = 0
        if text.first != "@" || freshAt { pickerClosed = false }
        let typed = text.dropFirst().lowercased()
        let startsAName = choices().contains { $0.name.lowercased().hasPrefix(typed) }
        if thread == nil, label == nil, !pickerClosed, !startsAName, let named = Self.mention(in: text, bots: choices()) {
            (label, text, pickerClosed) = (named.bot, named.rest, false)
        }
    }

    /// The bot whose whole name follows the leading `@` and a whitespace, with the text after that whitespace; nil when no bot has that
    /// name or two bots share it. The longest name wins: `@mini dev` is not `@mini` followed by `dev`.
    static func mention(in text: String, bots: [ChannelsModel.BotChoice]) -> (bot: Data, rest: String)? {
        guard text.first == "@" else { return nil }
        let typed = text.dropFirst()
        for name in Set(bots.map { $0.name.lowercased() }).sorted(by: { $0.count > $1.count }) {
            guard typed.count > name.count, typed.prefix(name.count).lowercased() == name, typed.dropFirst(name.count).first?.isWhitespace == true else { continue }
            let named = bots.filter { $0.name.lowercased() == name }
            return named.count == 1 ? (named[0].id, String(typed.dropFirst(name.count + 1))) : nil
        }
        return nil
    }

    /// The pick becomes the label in front of the text, and the `@` and the name typed after it go.
    public func pick(_ bot: Data) {
        guard picking else { return }
        (label, text, notice, pickerClosed) = (bot, "", nil, false)
    }

    /// Arrow keys move through the list, without wrapping.
    public func movePick(_ step: Int) {
        guard picking else { return }
        pickIndex = min(max(pickIndex + step, 0), max(matches().count - 1, 0))
    }

    /// Return or Tab while the list is open: the highlighted bot becomes the label. True when the key was taken.
    public func pickHighlighted() -> Bool {
        guard picking else { return false }
        let all = matches()
        if all.indices.contains(pickIndex) { pick(all[pickIndex].id) }
        return true
    }

    /// Whether the field holds uncommitted text of an input method, as the field tells it: set from the live view on each edit and cleared when a field is
    /// made, dismantled or loses the keyboard. Only the send button reads it.
    public var hasMarkedText = false

    /// The send button is off when Return would send nothing and while the field holds uncommitted text, which the button must not send.
    public var sendOff: Bool { !canSend || hasMarkedText }

    /// Set by the mention button, so that the field takes the keyboard (arrows, Return, Escape reach the list); cleared by `focusTaken` once honoured.
    public private(set) var focusRequested = false

    /// Set with `focusRequested` by the emoji button: once the field has the keyboard, the system's emoji palette opens on it.
    public private(set) var paletteRequested = false

    /// The field took the keyboard the mention or the emoji button asked for.
    public func focusTaken() { (focusRequested, paletteRequested) = (false, false) }

    /// The emoji button: the field takes the keyboard, then the system's emoji palette opens and types into it.
    public func startEmoji() {
        guard availability == .ready else { return }
        (focusRequested, paletteRequested) = (true, true)
    }

    /// Whether this composer shows the formatting row; one per channel and thread, as the composer is.
    public var formatting = false

    /// What the empty field says: in a channel, its name, and how to reach a bot while no bot is named and one can be; in a session's thread,
    /// the bot a reply goes to, named as the bot list names it, while a reply can go.
    public var placeholder: String {
        guard thread != nil else {
            let message = "Message \(Naming.channel(channel, in: reading))"
            return label == nil && !choices().isEmpty ? message + ", or type @ to hand a task to a bot" : message
        }
        guard availability == .ready, let bot = sessionBot?.id else { return "Reply in the thread" }
        return "Reply to \(name(of: bot))"
    }

    /// The mention button is on in a channel's composer that is ready, with a bot to choose, no bot named and nothing typed: the list opens from an `@` at the start.
    public var canMention: Bool { thread == nil && availability == .ready && label == nil && text.isEmpty && !choices().isEmpty }

    /// The mention button: types the leading `@`, which opens the bot list, and asks for the field's focus.
    public func startMention() {
        guard canMention else { return }
        edited("@")
        focusRequested = true
    }

    /// Escape closes the list and leaves what was typed as text.
    public func closePicker() { pickerClosed = true }

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
        if pickHighlighted() { return true }
        submit()
        return true
    }

    /// A paste of a file or an image: nothing is sent until a design seals file keys at rest.
    public func pasteRefused() { notice = "Files cannot be sent yet." }

    // MARK: sending

    /// Whether Return sends: the composer is ready, the field holds text beyond blanks (a label alone has none), and the bot list is closed (Return picks there). Return gets the
    /// field's live marked state itself (`returnPressed`), so `submit` never reads `hasMarkedText`.
    public var canSend: Bool { availability == .ready && !picking && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// Sends the field as one message and leaves the field empty. Nothing is sent for an empty text, a composer that is not ready, a command with no
    /// bot to read it, or a body past the frame; the last two say why. The task ends when the call has answered.
    @discardableResult
    public func submit() -> Task<Void, Never>? {
        guard canSend else { return nil }
        let bot = promptBot
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
        let task = queue(OutboxDraft(kind: bot == nil ? 1 : 2, to: bot, content: content), text: text, restores: true)
        (text, label, notice, pickerClosed) = ("", nil, nil, false)
        return task
    }

    /// Sends `text` as a prompt in the thread to the session's bot (a word of the daemon's: `/stop`, `/bypass on`), leaving the field as it is.
    /// Nothing is sent from a channel's composer, one that is not ready, or a session whose bot was removed.
    @discardableResult
    public func command(_ text: String) -> Task<Void, Never>? {
        guard canCommand, let bot = promptBot else { return nil }
        return queue(OutboxDraft(kind: 2, to: bot, content: Self.body(prompt: true, text: text, thread: thread)), text: text, restores: false)
    }

    /// Whether `command` sends: a thread of a session whose bot is one of the person's active devices.
    public var canCommand: Bool { thread != nil && availability == .ready && promptBot != nil }

    /// Puts a message in the outbox through the sender and draws its row until the reading holds it. The task ends when the call has answered.
    private func queue(_ draft: OutboxDraft, text: String, restores: Bool) -> Task<Void, Never> {
        entries.append(Entry(id: nextID, kind: Int(draft.kind), to: draft.to, text: text, content: draft.content, re: draft.re.map(Self.ref),
                             restores: restores, fromOutbox: false, name: nil, phase: .calling))
        let id = nextID
        nextID += 1
        let (channel, send) = (channel, send)
        return Task { [weak self] in
            do { self?.finish(id, try await send(channel, draft)) } catch {
                self?.fail(id, Problem.sentence("Pardner could not send the message", error, next: "Try again."))
            }
        }
    }

    // MARK: replies to requests

    /// How the reply to a request stands on its card.
    public enum ReplyState: Equatable {
        /// Queued or on its way, or held by the relay and not read back.
        case sending
        /// The call did not queue it; the line says why.
        case notSent(String)
        /// The relay refused it.
        case notDelivered
    }

    /// What the reading holds now.
    var reading: ReadingModel { conversation.reading }

    /// The bot of this thread's session, while it is one of the person's active devices.
    var sessionBotID: Data? { sessionBot?.id }

    /// The device this composer sends from: the one whose replies a card draws the bot's reason for.
    var thisDevice: Data? { devices.state.rows.first { $0.isThisMac }?.id }

    /// The card of a request of this thread, kept so that what the owner chose in it stays while the panel is closed.
    public func card(for request: Message) -> RequestCardModel {
        if let made = cards[request.ref] { return made }
        let made = RequestCardModel(request: request, composer: self)
        cards[request.ref] = made
        return made
    }

    /// How the last reply this composer holds to `request` stands; nil when there is none (or the reading has read it back).
    public func replyState(_ request: MessageRef) -> ReplyState? {
        let held = heldNames
        // A bound item whose name the reading holds was read back, as `rows()` takes it, though no outbox listing marked it seen.
        guard let entry = entries.last(where: { entry in
            if entry.re != request { return false }
            if case .bound(let name, _) = entry.phase, held.contains(name) { return false }
            return true
        }) else { return nil }
        switch entry.phase {
        case .calling, .bound: return .sending
        case .failed(let line): return .notSent(line)
        case .refused: return .notDelivered
        }
    }

    /// Sends `answer` as the owner's reply to `request`: a kind 10 to the request's bot, naming it, with the body `{"answer": ...}`. One reply is on its
    /// way at a time; the note of an earlier attempt that failed goes with the next. Nothing is sent where `command` would not send, or to a bot that
    /// is not the session's.
    @discardableResult
    func answer(_ request: Message, _ answer: [String: Any]) -> Task<Void, Never>? {
        guard canCommand, request.kind == 9, sessionBot?.id == request.sender, replyState(request.ref) != .sending else { return nil }
        entries.removeAll { entry in
            guard entry.re == request.ref else { return false }
            if let name = entry.name { dismissed.insert(name) }
            return true
        }
        let json = try? JSONSerialization.data(withJSONObject: ["answer": answer], options: [.withoutEscapingSlashes, .sortedKeys])
        let draft = OutboxDraft(kind: 10, to: request.sender, re: MessageReference(device: request.sender, name: request.name), content: String(decoding: json ?? Data(), as: UTF8.self))
        return queue(draft, text: "", restores: false)
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
        if entry.restores, text.isEmpty, label == nil {
            // A text that starts with `@` comes back as the text it was, the bot list closed; any other leaves the list free, so that an
            // `@` typed over it opens the list as in an empty field (#107).
            (text, pickerClosed) = (entry.text, entry.text.first == "@")
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

    private static func ref(_ re: MessageReference) -> MessageRef { MessageRef(device: re.device, name: re.name) }

    private static func shownText(_ content: String) -> String {
        let fields = (try? JSONSerialization.jsonObject(with: Data(content.utf8))) as? [String: Any]
        return (fields?["text"] as? String) ?? (fields?["markdown"] as? String) ?? ""
    }

    /// Whether an outbox item is this composer's: a prompt or a text with its thread's key, or a reply to a request of this thread. A reply to a request
    /// the reading has not read yet (a restart) is claimed too: the one that reads it back drops it, and only a card of its thread draws it.
    private func isMine(_ item: OutboxItemRow) -> Bool {
        guard !dismissed.contains(item.name) else { return false }
        if item.kind == 10, let re = item.re, let thread {
            let ref = MessageRef(device: re.device, name: re.name)
            let threads = conversation.reading.channels[channel]?.threads
            return threads?[thread]?.requests[ref] != nil || !(threads?.values.contains { $0.requests[ref] != nil } ?? false)
        }
        return item.re == nil && (item.kind == 1 || item.kind == 2) && Self.threadKey(item.content) == thread
    }

    /// A channel's outbox as the link tells it now, with the items it dropped as refused. An item no row holds by name is drawn from its content
    /// (a restart, or a bind made in a sheet); a call's own row takes it over when the call answers. A bound item that the list stops naming
    /// was read back (the outbox drops an item only then, or as refused, which is told): it is hidden, never `Not delivered.`
    func take(items all: [OutboxItemRow]) {
        let mine = all.filter(isMine)
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
                entries.append(Entry(id: nextID, kind: item.kind, to: item.to, text: Self.shownText(item.content), content: item.content, re: item.re.map(Self.ref),
                                     restores: false, fromOutbox: true, name: item.name, phase: .bound(name: item.name, seen: true)))
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
            entries.append(Entry(id: nextID, kind: item.kind, to: item.to, text: Self.shownText(item.content), content: item.content, re: item.re.map(Self.ref),
                                 restores: false, fromOutbox: true, name: item.name, phase: .refused))
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
            if entry.re != nil { return nil } // a reply is drawn on its request's card
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
