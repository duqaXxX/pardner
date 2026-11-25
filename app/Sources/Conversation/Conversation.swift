// The reading model (app data design, 6): the link's deliveries folded into channels, threads and
// sessions for the screens. A value: no socket, no store. Every state is derived from the messages, in
// the relay's order; nothing is held aside, since every `re` but a part's names an earlier message.
import Foundation
import ProtocolHost

/// Where a prompt of the owner's stands.
public enum PromptStatus: Sendable, Equatable {
    case sent, running, answered, cut, notRead
}

/// Where a request to the owner stands.
public enum RequestStatus: Sendable, Equatable {
    case open, replied, withdrawn, answered
    case rewritten(markdown: String)
}

/// The owner's reply a request's card shows: which reply, its body, whether the bot took it.
struct OwnerAnswer: Sendable, Equatable {
    let reply: MessageRef
    let json: String
    var taken: Bool
}

/// Why the bot did not take a reply, and which reply it was.
struct Refusal: Sendable, Equatable {
    let reply: MessageRef
    let text: String
}

/// A reply of the owner's, by what it answers and the bot it went to.
struct ReplyRecord: Sendable, Equatable {
    let request: MessageRef
    let to: Data?
    /// The reply's body: what the request's card says was answered once the bot takes it.
    let json: String
}

/// A session's state, as the Sessions tab shows it.
public enum SessionState: Sendable, Equatable {
    case idle, running, waiting
}

/// A bot's answer to a prompt, in segments: a run of its parts joined as they are written, ended by a line or any other entry. Every
/// segment of one answer has the same `ref`; the answer marks them all done, and replaces them when they do not add up to it.
public struct AnswerGroup: Sendable, Equatable {
    /// The bot and the answer's name: what each part's `re` names.
    public let ref: MessageRef
    /// The position of its first part, or of the answer when no part came.
    public let position: Int
    /// The time of its first part, or of the answer when no part came: the day the answer begins on.
    public let time: Date
    public internal(set) var markdown: String
    public internal(set) var done: Bool
    /// The prompt it answers, once the answer names it.
    public internal(set) var prompt: MessageRef?
    /// An earlier segment of the same answer stands above it: no header of its own.
    public internal(set) var continues = false
    /// The newest segment of its answer, where `Writing…` stands while the answer is not done.
    public internal(set) var last = true

    /// The text a segment draws: without the line ends at its edges, which the bot writes to set a block apart in a reply read as one
    /// text. Copy and the comparison with the answer keep `markdown` as written.
    public var shown: String {
        let ends: Set<Character> = ["\n", "\r", "\r\n"]
        guard let first = markdown.firstIndex(where: { !ends.contains($0) }), let last = markdown.lastIndex(where: { !ends.contains($0) }) else { return "" }
        return String(markdown[first...last])
    }
}

/// A line of a turn (turn work design 2.2): a call or a task, with what its newest message says.
public struct WorkLine: Sendable, Equatable {
    public let ref: MessageRef
    public let position: Int
    public let time: Date
    /// The prompt the line names: it is open while that prompt runs.
    public let prompt: MessageRef?
    public internal(set) var fields: LineFields
    /// The time of the edit that closed the line (complete or failed): the bot's build time, which the file window compares a file's change with.
    public internal(set) var ended: Date?
}

/// Where a click on a call's path stands, as the bot's messages to the hidden prompt say it (file-content design, 3.3 and 3.7).
public enum OpenAnswer: Sendable, Equatable {
    /// The prompt is sent; the bot has said nothing.
    case sent
    /// The bot started it.
    case started
    /// A restart cut it (SD 5.8).
    case cut
    /// The bot did not read it.
    case notRead
    /// The bot answered with a sentence and no file: a refusal, or a file it lost.
    case refused(String)
    /// The bot answered with its file; `modified` is the file's change time on the bot's clock, `at` the answer's time and `position` its place in the channel.
    case file(FileInfo, modified: Date?, at: Date, position: Int)
}

/// A hidden prompt with `open: true` and the newest of what its bot said to it.
public struct OpenRequest: Sendable, Equatable {
    public let prompt: Message
    public internal(set) var answer: OpenAnswer = .sent

    /// What the bot said, in position order: a start or a cut never undoes an answer.
    mutating func take(_ m: Message) {
        switch (m.body, answer) {
        case (.start, .sent): answer = .started
        case (.cut, .sent), (.cut, .started): answer = .cut
        case (.notRead, .sent), (.notRead, .started): answer = .notRead
        case (.answer(let markdown), _):
            if let file = m.files.first, markdown.isEmpty { answer = .file(file, modified: m.modified, at: m.time, position: m.position) } else { answer = .refused(markdown) }
        default: break
        }
    }
}

/// How a line stands now (turn work design 2.3).
public enum LineState: Sendable, Equatable {
    /// Open and running, since `since` when the call is timed.
    case running(since: Date?)
    /// Open and waiting for the owner: the request's card stands under it.
    case waiting
    /// Closed: drawn as written.
    case written
    /// Its prompt was cut or never read, or is not one of this thread.
    case interrupted
}

/// One entry of a thread, in position order.
public enum Item: Sendable, Equatable {
    case message(Message)
    case answer(AnswerGroup)
    case line(WorkLine)

    /// Where the entry sits in the relay's sequence.
    public var position: Int {
        switch self {
        case .message(let m): m.position
        case .answer(let a): a.position
        case .line(let l): l.position
        }
    }
}

/// What a thread draws: an item, or the messages that cannot be read as one counted row.
public enum Entry: Sendable, Equatable {
    case item(Item)
    case unreadable(count: Int, first: Message)
}

/// What the first sign of the prompt's bot says the opening prompt was: the bot's setup, parts or answer say a session; a line of its
/// own (`re` the prompt) or an answer that says no session, a word; a not-read before any other sign, a prompt that never ran. A cut is
/// no sign: it means a run that died after it started, and a later sign still decides.
public enum Settlement: Sendable, Equatable {
    case session, noSession, notRun
}

/// A thread: opened by a message of the channel, a session when that message is a prompt to a bot.
public struct MessageThread: Sendable, Equatable {
    /// The hex of the opening message's reference, as every body of the thread names it.
    public let key: String
    /// The opening message, once read.
    public internal(set) var root: Message?
    /// The bot the opening prompt mentions: the session's bot.
    public var bot: Data? { root?.kind == 2 ? root?.to : nil }
    public internal(set) var items: [Item] = []
    public internal(set) var prompts: [MessageRef: PromptStatus] = [:]
    public internal(set) var requests: [MessageRef: RequestStatus] = [:]
    /// The opening prompt's, set by the first sign of its bot in position order and never changed; nil while there is none.
    public internal(set) var settlement: Settlement?
    /// The prompt was settled as a word or as never run: a message with the bot's lines under it, no session.
    public var isWord: Bool { settlement == .noSession || settlement == .notRun }
    /// Whether the Sessions tab lists it: a prompt to a bot that was not settled as a word or as never run. A prompt with no sign yet
    /// is listed, so that a first turn with no text can still be opened.
    public var isSession: Bool { bot != nil && !isWord }
    /// Whether a summary that opens the thread stands under its opening message of kind `kind`: any prompt to a bot that is no word,
    /// even before its first sign.
    public func showsSummary(openedBy kind: Int) -> Bool { !isWord && (kind == 2 || !items.isEmpty) }
    /// What stands over the summary of a prompt with no sign of its bot yet: that the bot started it, or that a run cut it.
    public func unsettledNote(of prompt: MessageRef) -> String? {
        guard settlement == nil else { return nil }
        switch prompts[prompt] {
        case .running: return "Started"
        case .cut: return "Interrupted"
        default: return nil
        }
    }
    /// The body of the owner's reply each request ended on: the one sent while it waits, then the one the bot took.
    public var answers: [MessageRef: String] { replied.mapValues(\.json) }
    // By request: the owner's reply that stands for it, and whether the bot took it. A refusal of that reply, or the bot saying the
    // request was answered elsewhere before it took one, drops it.
    var replied: [MessageRef: OwnerAnswer] = [:]
    // Why the bot did not take the last reply to a request, and which reply it was.
    var reasons: [MessageRef: Refusal] = [:]
    /// The time of the newest message of the session's bot: the Sessions tab's order.
    public internal(set) var lastReply: Date?
    /// The session's title, from the newest `title` text of its bot in position order (step D2 3.2).
    public internal(set) var sessionTitle: String?
    /// The session's line, from the newest work's end of its bot that has one.
    public internal(set) var session: String?
    /// The newest `usage` (by `usage.at`) among this thread's own works' ends that carries a window, and the newest that carries a cost; `ReadingModel.windows` is the bot's across channels.
    public internal(set) var windowUsage: SessionUsage?
    public internal(set) var costUsage: SessionUsage?
    /// The bot's guess at the owner's next prompt, while nothing has come after it (step E1 design 3.2): the composer of its owner offers it.
    public internal(set) var hint: String?
    /// The files of the images each line's call returned, by the line (step E2 design 3.1): the texts that carry them are no item of the thread.
    public internal(set) var images: [MessageRef: [FileInfo]] = [:]
    // The devices whose prompts the bot started here: its owner's, the only ones whose reply it takes (SD 5.8).
    var owners: Set<Data> = []
    // The person's own devices (the Devices list): their replies count whether or not they prompted in this thread.
    var own: Set<Data> = []
    // The index in `items` of each segment of an answer and of each line: items are only appended to, so an edit or a part never
    // looks at the whole thread. Rebuilt when an answer replaces its segments.
    var segments: [MessageRef: [Int]] = [:]
    var lineIndex: [MessageRef: Int] = [:]

    /// The thread's entries: its items, the messages that do not open grouped when they come one after another.
    public var entries: [Entry] {
        var out: [Entry] = []
        for item in items {
            if case .message(let m) = item, m.body == .unreadable {
                if case .unreadable(let n, let first)? = out.last { out[out.count - 1] = .unreadable(count: n + 1, first: first) } else { out.append(.unreadable(count: 1, first: m)) }
            } else {
                out.append(.item(item))
            }
        }
        return out
    }

    /// The whole text of the answer `segment` belongs to: its segments joined, which is the answer's text once it landed.
    public func text(of segment: AnswerGroup) -> String {
        (segments[segment.ref] ?? []).compactMap { if case .answer(let a) = items[$0] { a.markdown } else { nil } }.joined()
    }

    /// How `line` stands: open while its newest status is not an end and its prompt runs or was answered, or it names none (a task outlives
    /// its prompt's answer; C2 3.2).
    public func state(of line: WorkLine) -> LineState {
        guard line.fields.status == .pending || line.fields.status == .inProgress else { return .written }
        if let prompt = line.prompt, prompts[prompt] != .running, prompts[prompt] != .answered { return .interrupted }
        return line.fields.status == .pending ? .waiting : .running(since: line.fields.startedAt)
    }

    private func isOpen(at index: Int) -> WorkLine? {
        guard case .line(let l) = items[index] else { return nil }
        switch state(of: l) {
        case .running, .waiting: return l
        case .written, .interrupted: return nil
        }
    }

    /// The lines still open, oldest first.
    public var openLines: [WorkLine] { lineIndex.values.sorted().compactMap(isOpen(at:)) }

    /// Waiting for the owner while a request is open; running while a prompt runs or a line is open; idle otherwise.
    public var state: SessionState {
        if requests.values.contains(.open) { return .waiting }
        if prompts.values.contains(.running) || lineIndex.values.contains(where: { isOpen(at: $0) != nil }) { return .running }
        return .idle
    }

    init(key: String) { self.key = key }

    /// Whether a reply of `sender` is the owner's: a device whose prompt the bot started here, or one of the person's own.
    func trusts(_ sender: Data) -> Bool { owners.contains(sender) || own.contains(sender) }

    /// Why the bot did not take this device's last reply to `request`, while the request still waits; nil otherwise. A status other than
    /// `open` wins over a reason.
    public func reason(of request: MessageRef, from device: Data) -> String? {
        guard requests[request] == .open, let r = reasons[request], r.reply.device == device else { return nil }
        return r.text
    }
}

/// What a bot answered to a `/bind`: its name, the field and the text it wrote.
public struct BindAnswer: Sendable, Equatable {
    public let bot: Data
    public let bind: Bind
    public let text: String
}

public struct Channel: Sendable, Equatable {
    public let id: Data
    /// Every message read, in position order.
    public internal(set) var messages: [Message] = []
    /// The positions of the channel's own messages, those of no thread, in order.
    public internal(set) var timeline: [Int] = []
    public internal(set) var threads: [String: MessageThread] = [:]
    // Which thread a message belongs to, by its reference: how a start, a cut or a reply finds its thread.
    var threadOf: [MessageRef: String] = [:]
    // The person's own devices, handed to each thread before it reads a message.
    var own: Set<Data> = []
    // The replies of the owner's read, by their reference: the request each answers and the bot it went to. What the bot says to one is its
    // verdict, found by `re` (the body's `thread` may be empty), and never a prompt's state or a thread item.
    var replies: [MessageRef: ReplyRecord] = [:]
    // The control prompts of the owner's own devices (`ControlPrompt`), by their reference: the prompt is never drawn; for `/stop` (true) the
    // bot's start, parts, answer and text to it are not drawn either. Whatever else names one with `re` (a request, its lines) is read as usual.
    var controls: [MessageRef: Bool] = [:]
    /// The clicks on a call's path, by their prompt's reference. A click is no row on any device: its bot's start, cut and answer go to the window that asked.
    public internal(set) var opens: [MessageRef: OpenRequest] = [:]
    /// The newest bind answer of the channel: the bot's line to a `/bind` prompt that carries the field (channel folder design, 2).
    public internal(set) var bound: BindAnswer?

    /// The sessions, by their last reply, newest first (first-screens decision 8); the key breaks a tie.
    public var sessions: [MessageThread] {
        threads.values.filter(\.isSession).sorted {
            let a = $0.lastReply ?? $0.root?.time ?? .distantPast, b = $1.lastReply ?? $1.root?.time ?? .distantPast
            return a != b ? a > b : $0.key < $1.key
        }
    }

    init(id: Data, own: Set<Data> = []) { (self.id, self.own) = (id, own) }

    mutating func fold(_ m: Message) {
        messages.append(m)
        if m.control, case .prompt(let text) = m.body, trusts(controlFrom: m) {
            controls[m.ref] = ControlPrompt.hidesAnswer(text)
            return
        }
        if let re = m.re, controls[re] == true, hidden(answerTo: m) { return }
        // A click counts as one only from the person's own devices, as a control prompt does; any other prompt with the field is a prompt.
        if m.open, case .prompt = m.body, trusts(controlFrom: m) {
            opens[m.ref] = OpenRequest(prompt: m)
            return
        }
        // Only the bot the click went to answers it (invariant 1: the other bots of a channel act on nothing here).
        if let re = m.re, let request = opens[re], m.sender == request.prompt.to, [3, 5, 6, 7].contains(m.kind) {
            opens[re]?.take(m)
            return
        }
        if let re = m.re, let reply = replies[re], let key = threadOf[re], [3, 5, 6, 7].contains(m.kind) {
            threads[key]?.take(verdict: m, of: re, reply: reply)
            return
        }
        // The bot's own line that answers a top-level prompt (`re` it): under that prompt, never a message of the channel.
        if case .text = m.body, m.thread == nil, let re = m.re, let key = threadOf[re], threads[key]?.answers(line: m) == true {
            threadOf[m.ref] = key
            threads[key]?.take(line: m)
            // A prompt answered with a bind field (whatever its text, the bot parses it) is the panel's, not the conversation's: it and the line under it are not drawn.
            if let bind = m.bind, case .text(let markdown, _) = m.body {
                bound = BindAnswer(bot: m.sender, bind: bind, text: markdown)
                timeline.removeAll { $0 == threads[key]?.root?.position }
            }
            return
        }
        let key: String?
        switch m.body {
        case .prompt where m.thread == nil, .text where m.thread == nil:
            key = m.ref.hex
            threads[key!, default: MessageThread(key: key!)].root = m
            timeline.append(m.position)
        case .start, .cut, .notRead, .reply, .edit, .lineEdit:
            key = m.re.flatMap { threadOf[$0] } ?? m.thread
        case .file where m.thread == nil:
            key = nil
            timeline.append(m.position)
        case .unreadable where m.thread == nil:
            // Its thread is in the body it lacks, but its `re` is in the clear: a message of a thread names that thread (design 2.9).
            // Only a line's text (kind 1, naming its prompt) and a line's edit (kind 11, naming a message that is no thread's root) are
            // routed so; any other message that does not open stays in the channel's list.
            key = m.re.flatMap { re in threadOf[re].flatMap { k in m.kind == 1 || (m.kind == 11 && k != re.hex) ? k : nil } }
            if key == nil { timeline.append(m.position) } // shown in the channel in its place
        default:
            key = m.thread
        }
        guard let key else { return }
        threadOf[m.ref] = key
        threads[key, default: MessageThread(key: key)].own = own
        threads[key]?.take(m)
        // A reply counts for a verdict only from one of the owner's devices, to the session's bot.
        if case .reply(_, let json) = m.body, let re = m.re, let t = threads[key], t.trusts(m.sender), m.to == t.bot {
            replies[m.ref] = ReplyRecord(request: re, to: m.to, json: json)
        }
    }
}

extension Channel {
    // A control prompt counts only from the person's own devices, or from one whose prompt the thread's bot started.
    private func trusts(controlFrom m: Message) -> Bool {
        own.contains(m.sender) || (m.thread.flatMap { threads[$0] }?.owners.contains(m.sender) ?? false)
    }

    // What the bot writes to a `/stop` control: its start, cut, not-read, parts, answer and text. A request, its edits and lines stay.
    private func hidden(answerTo m: Message) -> Bool {
        switch m.body {
        case .start, .cut, .notRead, .part, .answer, .text: true
        default: false
        }
    }
}

extension MessageThread {
    // A start, cut, not-read, answer, part, request or edit counts only from the session's bot (invariant 1: the
    // other bots of a channel act on nothing here); a reply only from a device whose prompt the bot started.
    mutating func take(_ m: Message) {
        let fromBot = bot != nil && m.sender == bot
        // Any later item of the thread lets the hint go, but a work's end or a title of the bot (the guess may land before either).
        let before = items.count
        defer { if items.count > before, !(fromBot && m.leavesHint) { hint = nil } }
        if fromBot, case .next(let guess)? = m.sessionText {
            // A guess made before a prompt already in the thread is stale: the newest item before it, the bot's own lines aside, is not the person's.
            hint = lastItemIsPrompt() ? nil : guess
            return
        }
        // The first sign decides what the opening prompt was (a prompt's start is no sign).
        if fromBot, settlement == nil {
            switch m.body {
            case .request, .part, .line, .file: settlement = .session
            // A `tell` is the bot answering a Stop or a reply typed in the thread: it can precede a word's own line.
            case .text(_, let say) where m.thread != nil && say != "tell": settlement = .session
            case .answer where m.re == root?.ref: settlement = m.noSession ? .noSession : .session
            case .notRead where m.re == root?.ref: settlement = .notRun
            default: break
            }
        }
        switch m.body {
        case .prompt:
            prompts[m.ref] = .sent
            if m.thread != nil { items.append(.message(m)) }
        case .start where fromBot:
            if let re = m.re, prompts[re] != nil {
                prompts[re] = .running
                owners.insert(re.device)
            }
        case .cut where fromBot: if let re = m.re, prompts[re] != nil { prompts[re] = .cut }
        case .notRead where fromBot: if let re = m.re, prompts[re] != nil { prompts[re] = .notRead }
        case .part(let markdown) where fromBot:
            guard let re = m.re, re.device == m.sender else { return }
            // A part joins the entry before it when that is a segment of the same answer; else it opens a segment (design 2.4).
            if case .answer(var a)? = items.last, a.ref == re {
                a.markdown += markdown
                items[items.count - 1] = .answer(a)
            } else {
                var group = AnswerGroup(ref: re, position: m.position, time: m.time, markdown: markdown, done: false)
                if let before = segments[re]?.last, case .answer(var a) = items[before] {
                    (a.last, group.continues) = (false, true)
                    items[before] = .answer(a)
                }
                segments[re, default: []].append(items.count)
                items.append(.answer(group))
            }
        case .answer(let markdown) where fromBot:
            if let re = m.re, prompts[re] != nil { prompts[re] = .answered }
            if let indices = segments[m.ref] {
                var joined = ""
                for i in indices {
                    guard case .answer(var a) = items[i] else { continue }
                    joined += a.markdown
                    (a.done, a.prompt) = (true, m.re)
                    items[i] = .answer(a)
                }
                // The answer is the whole text: it replaces segments that do not add up to it (a part that did not open here, or never
                // queued). An empty answer keeps the text its parts already showed.
                if !markdown.isEmpty, markdown != joined, case .answer(var first) = items[indices[0]] {
                    first.markdown = markdown
                    items[indices[0]] = .answer(first)
                    for i in indices.dropFirst().reversed() { items.remove(at: i) }
                    reindex()
                    if let i = segments[m.ref]?.last, case .answer(var a) = items[i] { a.last = true; items[i] = .answer(a) }
                }
            } else if !markdown.isEmpty {
                segments[m.ref] = [items.count]
                items.append(.answer(AnswerGroup(ref: m.ref, position: m.position, time: m.time, markdown: markdown, done: true, prompt: m.re)))
            }
        case .request where fromBot:
            requests[m.ref] = .open
            items.append(.message(m))
        case .reply:
            // The owner's reply is no row of the thread: the request's card carries its state.
            if case .reply(_, let json) = m.body, let re = m.re, requests[re] == .open, trusts(m.sender) {
                (requests[re], replied[re]) = (.replied, OwnerAnswer(reply: m.ref, json: json, taken: false))
            }
        case .edit(let withdrawn, let answered, let markdown) where fromBot:
            guard let re = m.re, requests[re] != nil else { return }
            if withdrawn { if requests[re] != .answered { requests[re] = .withdrawn } } else if answered { requests[re] = .answered } else if let markdown { requests[re] = .rewritten(markdown: markdown) }
            // Answered elsewhere: a reply of the owner's the bot has not taken does not stand for it.
            if answered, replied[re]?.taken == false { replied[re] = nil }
        case .line(let fields) where fromBot:
            lineIndex[m.ref] = items.count
            items.append(.line(WorkLine(ref: m.ref, position: m.position, time: m.time, prompt: m.re, fields: fields, ended: fields.status.isClosed ? m.time : nil)))
        case .lineEdit(let fields) where fromBot:
            // A line the app does not hold (its text did not open here) changes nothing.
            guard let re = m.re, let i = lineIndex[re], case .line(var line) = items[i] else { return }
            // The line's end is the edit that closed it: a later edit of a closed line does not move it.
            if fields.status.isClosed, !line.fields.status.isClosed { line.ended = m.time }
            line.fields = fields
            items[i] = .line(line)
        case .image(let line) where fromBot:
            // No item, no later message, no reply: an image comes under its line whenever it lands, and a line this thread lacks is drawn by none.
            if !m.files.isEmpty { images[MessageRef(device: m.sender, name: line)] = m.files }
            return
        case .text where fromBot && m.sessionText != nil:
            switch m.sessionText {
            case .title(let title)?:
                if let title { sessionTitle = title }
                return // a title is no reply
            case .run?:
                items.append(.message(m))
            case .next?, nil: break
            case .footer(let duration, let line, let newest)?:
                if duration != nil { items.append(.message(m)) }
                if let line { session = line }
                if let newest {
                    if newest.hasWindow, newest.at > windowUsage?.at ?? -.infinity { windowUsage = newest }
                    if newest.cost != nil, newest.at > costUsage?.at ?? -.infinity { costUsage = newest }
                }
            }
        case .text, .file:
            if m.thread != nil { items.append(.message(m)) } // the opening message is the thread's root, not an item
        case .unreadable:
            items.append(.message(m))
        default:
            return
        }
        if fromBot { lastReply = max(lastReply ?? .distantPast, m.time) }
    }

    /// Whether `m` is a work's end of the session's bot: the line under a reply, which is no reply itself.
    public func isFooter(_ m: Message) -> Bool {
        if case .footer? = m.sessionText { return bot != nil && m.sender == bot }
        return false
    }

    /// Whether `m` is a scheduled run's line of the session's bot: one line of its own, which is no reply.
    public func isRunLine(_ m: Message) -> Bool {
        if case .run? = m.sessionText { return bot != nil && m.sender == bot }
        return false
    }

    /// Whether the newest item, the bot's work's ends and run lines aside, is a message of a person.
    private func lastItemIsPrompt() -> Bool {
        for item in items.reversed() {
            guard case .message(let m) = item else { return false }
            if isFooter(m) || isRunLine(m) { continue }
            if case .prompt = m.body { return true }
            return false
        }
        return false
    }

    /// Whether `m`, a text with no thread, is the line of the session's bot that answers the opening prompt.
    func answers(line m: Message) -> Bool {
        bot != nil && m.sender == bot && m.re != nil && m.re == root?.ref
    }

    /// The bot's line that answers the opening prompt: an item under it, and the first sign unless one came before.
    mutating func take(line m: Message) {
        if settlement == nil { settlement = .noSession }
        items.append(.message(m))
        hint = nil
        lastReply = max(lastReply ?? .distantPast, m.time)
    }

    /// What the bot says to the reply `reply`, from the bot it was `to` alone: its empty kind 5 means the answer was handed on, whatever the request's
    /// status was (the bot withdraws an accepted request before it writes it); anything else is a reason, and the request waits again.
    mutating func take(verdict m: Message, of ref: MessageRef, reply: ReplyRecord) {
        let request = reply.request
        guard bot != nil, m.sender == bot, requests[request] != nil else { return }
        lastReply = max(lastReply ?? .distantPast, m.time)
        let reason: String
        switch m.body {
        case .answer(let markdown) where markdown.isEmpty:
            // A rewritten request keeps its text: what the bot wrote of it is more than "answered".
            switch requests[request] {
            case .open, .replied, .withdrawn: requests[request] = .answered
            default: break
            }
            (reasons[request], replied[request]) = (nil, OwnerAnswer(reply: ref, json: reply.json, taken: true))
            return
        case .answer(let markdown): reason = markdown
        case .cut: reason = "The bot did not take this answer."
        case .notRead: reason = "The bot could not read this answer."
        default: return // a start is no verdict
        }
        reasons[request] = Refusal(reply: ref, text: reason)
        // The bot did not take it: it no longer stands for the request, whatever the request's status.
        if replied[request]?.reply == ref { replied[request] = nil }
        if requests[request] == .replied { requests[request] = .open }
    }

    /// The prompts that are sent or running while an earlier prompt of the thread, by position (the root, then the thread's prompts in order),
    /// still runs: the bot starts every prompt it reads and queues it in its core, so the start alone does not say a prompt is next.
    /// One pass over the thread: a screen asks once per drawing, not once per message.
    public var queued: Set<MessageRef> {
        var (result, earlierRuns) = (Set<MessageRef>(), false)
        for case let message? in [root] + items.map({ if case .message(let m) = $0 { m } else { nil } }) {
            guard case .prompt = message.body else { continue }
            if earlierRuns, prompts[message.ref] == .sent || prompts[message.ref] == .running { result.insert(message.ref) }
            if prompts[message.ref] == .running { earlierRuns = true }
        }
        return result
    }

    private mutating func reindex() {
        (segments, lineIndex) = ([:], [:])
        for (i, item) in items.enumerated() {
            switch item {
            case .answer(let a): segments[a.ref, default: []].append(i)
            case .line(let l): lineIndex[l.ref] = i
            case .message: break
            }
        }
    }
}

/// A bot as the screens name it: its profile, when one reads (BP 3.3).
public struct BotProfile: Sendable, Equatable {
    public let name: String
    public let account: String?
    public let plan: String?
    public let icon: Data?

    /// A profile as the link tells it; `account` and `plan` are the agent's login, shown beside the name.
    public init(name: String, account: String?, plan: String?, icon: Data?) {
        (self.name, self.account, self.plan, self.icon) = (name, account, plan, icon)
    }
}

/// The names the link shows (names design 3), by the id each names: a channel's, the person's and a device's. A bot is named by its profile.
public struct ShownNames: Sendable, Equatable {
    public private(set) var channels: [Data: String] = [:]
    public private(set) var persons: [Data: String] = [:]
    public private(set) var devices: [Data: String] = [:]

    /// One `names` effect: each entry gives the name now shown for its target, or `null` when none shows.
    mutating func take(_ effect: HostValue) {
        for entry in effect["names"]?.arrayValue ?? [] {
            guard let kind = entry["kind"]?.numberValue, let target = entry["target"]?.bytesValue else { continue }
            let name = entry["name"]?.stringValue
            switch Int(kind) {
            case 14: channels[target] = name
            case 15: persons[target] = name
            case 16: devices[target] = name
            default: break
            }
        }
    }
}

/// The sections the link shows (sidebar sections design 4, 4.1), as its `arrangement` effect tells them.
public struct ShownArrangement: Sendable, Equatable {
    /// One section: its id (lowercase hex, as the acts name it), its name and its channels in the content's order, held or not.
    public struct Section: Sendable, Equatable {
        public let id: String
        public let name: String
        public let channels: [Data]
    }

    /// Nil when no arrangement shows (before any is told, or none is held).
    public private(set) var sections: [Section]?
    /// Every kind 17 of the space is read and applied: the section acts are offered only then.
    public private(set) var current = false
    /// The device waits for a copy of a kind 17 that is still to come.
    public private(set) var behind = false
    /// The device's own pending tree took no part when read back (design 3.2).
    public private(set) var notApplied = false

    mutating func take(_ effect: HostValue) {
        sections = effect["sections"]?.arrayValue?.compactMap { entry in
            guard let id = entry["id"]?.stringValue, let name = entry["name"]?.stringValue else { return nil }
            return Section(id: id, name: name, channels: (entry["channels"]?.arrayValue ?? []).compactMap { $0.stringValue.flatMap(Self.bytes(hex:)) })
        }
        (current, behind, notApplied) = (effect["current"] == .bool(true), effect["behind"] == .bool(true), effect["notApplied"] == .bool(true))
    }

    private static func bytes(hex: String) -> Data? {
        guard hex.count.isMultiple(of: 2) else { return nil }
        var out = Data(), rest = hex[...]
        while !rest.isEmpty {
            guard let byte = UInt8(rest.prefix(2), radix: 16) else { return nil }
            out.append(byte)
            rest = rest.dropFirst(2)
        }
        return out
    }
}

/// The channels and the bots' profiles, as the link delivered them.
public struct ReadingModel: Sendable, Equatable {
    public private(set) var names = ShownNames()
    public private(set) var arrangement = ShownArrangement()
    public private(set) var channels: [Data: Channel] = [:]
    public private(set) var profiles: [Data: BotProfile] = [:]
    // The person's own app devices, as the Devices list names them.
    private var ownDevices: Set<Data> = []

    /// An empty model, before the link's first delivery.
    public init() {}

    /// One `deliver` of the link: `take(views:)` with one view.
    public mutating func take(view: HostValue) { take(views: [view]) }

    /// The `deliver`s of one batch, in order. A relay recreated empties the channels: every position comes again. A
    /// message delivered again, or at a place already passed, rebuilds its channel in position order, once per batch.
    public mutating func take(views: [HostValue]) {
        var rebuild: [Data: [Int: Message]] = [:] // by channel: the messages that replace or join a place passed
        for view in views {
            if view["do"]?.stringValue == "incarnation", view["changed"] == .bool(true) {
                channels = [:]
                rebuild = [:]
            }
            guard let m = Message(view: view) else { continue }
            let passed = channels[m.channel]?.messages.last.map { $0.position >= m.position } ?? false
            if rebuild[m.channel] != nil || passed {
                rebuild[m.channel, default: [:]][m.position] = m
            } else {
                channels[m.channel, default: Channel(id: m.channel, own: ownDevices)].fold(m)
            }
        }
        for (id, changed) in rebuild {
            var all = Dictionary(uniqueKeysWithValues: (channels[id]?.messages ?? []).map { ($0.position, $0) })
            all.merge(changed) { _, new in new }
            var c = Channel(id: id, own: ownDevices)
            for position in all.keys.sorted() { c.fold(all[position]!) }
            channels[id] = c
        }
    }

    /// The person's own devices changed: a reply of one counts for a request's status, so every channel is read again from its messages.
    public mutating func setOwnDevices(_ ids: Set<Data>) {
        guard ids != ownDevices else { return }
        ownDevices = ids
        for (id, channel) in channels {
            var c = Channel(id: id, own: ids)
            for m in channel.messages { c.fold(m) }
            channels[id] = c
        }
    }

    /// One `names` effect of the link.
    public mutating func take(names effect: HostValue) { names.take(effect) }

    /// One `arrangement` effect of the link.
    public mutating func take(arrangement effect: HostValue) { arrangement.take(effect) }

    /// The person's own name, when one shows (a Mac has one person).
    public var personName: String? { names.persons.values.first }

    /// Whether `device` is one of the person's own apps, as the Devices list names them.
    public func isOwn(_ device: Data) -> Bool { ownDevices.contains(device) }

    /// The newest `usage` of each bot that carries a window, by `usage.at`, across every channel read.
    public var windows: [Data: SessionUsage] {
        var out: [Data: SessionUsage] = [:]
        for channel in channels.values {
            for thread in channel.threads.values {
                guard let bot = thread.bot, let u = thread.windowUsage, u.at > out[bot]?.at ?? -.infinity else { continue }
                out[bot] = u
            }
        }
        return out
    }

    /// The bots with any `usage`, in any channel read, that carried a cost: the bot writes one only for an account with no plan.
    public var apiBots: Set<Data> {
        Set(channels.values.flatMap { $0.threads.values.compactMap { $0.costUsage == nil ? nil : $0.bot } })
    }

    /// One `profile` effect of the link: the profile shown for a bot, or none.
    public mutating func take(profile: HostValue) {
        guard let bot = profile["bot"]?.bytesValue else { return }
        let p = profile["profile"]
        guard let name = p?["name"]?.stringValue else {
            profiles[bot] = nil
            return
        }
        profiles[bot] = BotProfile(
            name: name, account: p?["account"]?["name"]?.stringValue, plan: p?["account"]?["plan"]?.stringValue,
            icon: p?["icon"]?.bytesValue)
    }
}
