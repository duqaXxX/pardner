// What the file window holds (file-content design, 3.3, 3.6 and 3.7): a click on a call's path is a hidden prompt to the call's bot, whose
// answer carries the file; a file row names its file in its own message. Either way the bytes are fetched whole and drawn in the window.
import Conversation
import Foundation
import Observation
import Relay

/// What a file window shows, by value: the channel, the thread, the bot and one file. A path stands for one window per thread, whichever line
/// it was clicked on.
public struct FileWindowContent: Codable, Hashable, Sendable {
    public enum Source: Codable, Hashable, Sendable {
        /// A call's path, as the agent wrote it: asked of the bot.
        case path(String)
        /// A file row's blob, from the message that carries it.
        case sent(blob: Data, name: String, size: Int, type: String, at: Date)
    }

    let channel: Data
    let thread: String
    let bot: Data
    let source: Source
}

/// What the file window says, from the bot's answer and the fetch (design 3.7).
enum FileState {
    case waiting(bot: String)
    case opening(name: String)
    case message(String)
    case unreadable
    case file(FileShown)
}

struct FileShown {
    let name: String
    /// What the header names: the path asked, or the file row's title.
    let title: String
    let size: Int
    let type: String
    let readAt: Date
    /// The file's change time, when it is after the line's end.
    let changed: Date?
    let content: FileContent
}

/// Where a fetch stands; `stamp` is the answer it was started for, so a newer click's answer never lands on an older fetch.
enum FileFetch {
    case idle
    case loading(stamp: Int)
    case failed(stamp: Int)
    case done(stamp: Int, FileContent)

    var stamp: Int? {
        switch self {
        case .idle: nil
        case .loading(let s), .failed(let s), .done(let s, _): s
        }
    }
}

enum FileWords {
    static let unreadable = "This file can no longer be read."
    static func restarted(_ bot: String) -> String { "\(bot) restarted before sending the file. Click the path again." }
    static func notRead(_ bot: String) -> String { "\(bot) could not read the request. Click the path again." }
    static let notSent = "The request could not be sent. Click the path again."
}

enum FileStates {
    /// The window's state: `answer` is the bot's newest word to the click (nil for a file row), `lineEnd` the line's closing time.
    static func state(_ content: FileWindowContent, answer: OpenAnswer?, fetch: FileFetch, bot: String, lineEnd: Date?, notSent: Bool) -> FileState {
        switch content.source {
        case .sent(_, let name, let size, let type, let at):
            return fetched(fetch, stamp: 0, name: name, title: name, size: size, type: type, readAt: at, changed: nil)
        case .path(let path):
            if notSent, answer == nil || answer == .sent { return .message(FileWords.notSent) }
            switch answer {
            case nil, .sent?, .started?: return .waiting(bot: bot)
            case .cut?: return .message(FileWords.restarted(bot))
            case .notRead?: return .message(FileWords.notRead(bot))
            case .refused(let sentence)?: return sentence.isEmpty ? .unreadable : .message(sentence)
            case .file(let info, let modified, let at, let position)?:
                let changed = modified.flatMap { m in lineEnd.map { m > $0 } == true ? m : nil }
                return fetched(fetch, stamp: position, name: info.name, title: path, size: info.size, type: info.type, readAt: at, changed: changed)
            }
        }
    }

    private static func fetched(_ fetch: FileFetch, stamp: Int, name: String, title: String, size: Int, type: String, readAt: Date, changed: Date?) -> FileState {
        guard fetch.stamp == stamp else { return .opening(name: name) }
        switch fetch {
        case .done(_, let content): return .file(FileShown(name: name, title: title, size: size, type: type, readAt: readAt, changed: changed, content: content))
        case .failed: return .unreadable
        case .idle, .loading: return .opening(name: name)
        }
    }

    /// The link on a call's line: its path, when the call is done and the bot is one of the viewer's own (invariant 1). A running, failed or cut line has none.
    static func path(of line: WorkLine, ownBot: Bool) -> String? {
        ownBot && line.fields.status == .complete ? line.fields.path : nil
    }
}

/// How a window draws a file's bytes.
enum FileContent: Equatable {
    case markdown(String)
    case text(String)
    case other

    /// By the name's ending, then by whether the bytes read as UTF-8 text (no NUL). A Markdown file over what `MarkdownView` reads is drawn as text:
    /// past that bound it would be one SwiftUI `Text`, rebuilt at every message the relay delivers.
    init(name: String, data: Data) {
        let lower = name.lowercased()
        guard !data.contains(0), let text = String(validating: data, as: UTF8.self) else { self = .other; return }
        let markdown = lower.hasSuffix(".md") || lower.hasSuffix(".markdown")
        self = markdown && text.utf8.count <= CodeSpans.most ? .markdown(text) : .text(text)
    }
}

@MainActor @Observable
public final class FileOpener {
    private struct Session {
        /// The showing of the click that made this: a close from an earlier showing of the same path ends nothing (as `ChannelsModel.epoch`).
        var showing: Int
        /// The click this state belongs to: what an earlier click's send writes is dropped.
        var generation: Int
        var prompt: MessageRef?
        var notSent = false
        /// The end of the line the latest click was on.
        var lineEnd: Date?
        var fetch = FileFetch.idle
    }

    private let conversation: ConversationModel
    private let devices: DevicesModel
    private let send: ComposerSender
    /// How long a fetch the connection could not make waits before it asks again.
    var retryAfter = Duration.seconds(3)
    private let fetchFile: @Sendable (Data, Data) async -> FetchOutcome
    private var sessions: [FileWindowContent: Session] = [:]
    private var counter = 0
    /// The names the relay refused while a click's send was in flight, by channel: an item may be refused before its send returns its name.
    private var refused: [Data: Set<Data>] = [:]
    private var sendsInFlight = 0

    /// An opener over the reading, the devices, the composers' sender and the connection's fetch.
    public init(conversation: ConversationModel, devices: DevicesModel, send: @escaping ComposerSender, fetch: @escaping @Sendable (Data, Data) async -> FetchOutcome) {
        (self.conversation, self.devices, self.send, fetchFile) = (conversation, devices, send, fetch)
    }

    /// Whether `bot` is one of the person's own bots that can still answer.
    func isOwnBot(_ bot: Data) -> Bool { devices.state.rows.contains { $0.id == bot && $0.kind == .bot && $0.active } }

    /// The path a call's line links to, or nil.
    func link(for line: WorkLine) -> String? { FileStates.path(of: line, ownBot: isOwnBot(line.ref.device)) }

    /// A click on a path, or on a file row: the session starts, or starts again (a click on an open window asks the bot again; a file row's bytes
    /// already held stay), then the caller opens the window. The task ends when the prompt has been queued.
    @discardableResult
    public func open(_ content: FileWindowContent, lineEnd: Date? = nil) -> Task<Void, Never> {
        counter += 1
        let generation = counter
        let showing = generation
        guard case .path(let path) = content.source else {
            // A file row's bytes held, or on their way, stay: only a failed or idle fetch starts again.
            switch sessions[content]?.fetch {
            case .done?, .loading?: sessions[content]?.showing = showing
            default: sessions[content] = Session(showing: showing, generation: generation)
            }
            return Task {}
        }
        sessions[content] = Session(showing: showing, generation: generation, lineEnd: lineEnd)
        guard let device = devices.state.rows.first(where: \.isThisMac)?.id else {
            sessions[content]?.notSent = true
            return Task {}
        }
        let body = ComposerModel.body(prompt: true, text: "/open " + path, thread: content.thread, open: true)
        let draft = OutboxDraft(kind: 2, to: content.bot, content: body)
        let (channel, send) = (content.channel, send)
        sendsInFlight += 1
        return Task { [weak self] in
            let outcome = try? await send(channel, draft)
            guard let self else { return }
            sendsInFlight -= 1
            defer { if sendsInFlight == 0 { refused = [:] } } // a name matters only to a send that has not checked it yet
            guard sessions[content]?.generation == generation else { return }
            if case .queued(let name)? = outcome, refused[channel]?.contains(name) != true {
                sessions[content]?.prompt = MessageRef(device: device, name: name)
            } else {
                sessions[content]?.notSent = true
            }
        }
    }

    /// The relay refused these items (`ChannelsState.undelivered`): a click among them was not delivered.
    func take(undelivered: [Data: [OutboxItemRow]]) {
        for (channel, rows) in undelivered {
            let names = Set(rows.map(\.name))
            if sendsInFlight > 0 { refused[channel, default: []].formUnion(names) }
            for (content, session) in sessions where content.channel == channel {
                if let prompt = session.prompt, names.contains(prompt.name) { sessions[content]?.notSent = true }
            }
        }
    }

    /// The window of showing `showing` is closed: its bytes go, unless a newer showing of the same path holds the session.
    public func close(_ content: FileWindowContent, showing: Int) {
        if sessions[content]?.showing == showing { sessions[content] = nil }
    }

    /// How many refused names are held: for the tests.
    var refusedKept: Int { refused.values.reduce(0) { $0 + $1.count } }

    /// The name of the prompt the latest click queued, once it has: for the tests of which click a send belongs to.
    func promptName(of content: FileWindowContent) -> Data? { sessions[content]?.prompt?.name }

    /// The window's showing, which its close names; nil without a session: a stray window does not stay.
    public func showing(of content: FileWindowContent) -> Int? { sessions[content]?.showing }

    private func answer(of content: FileWindowContent) -> OpenAnswer? {
        guard let prompt = sessions[content]?.prompt else { return nil }
        return conversation.reading.channels[content.channel]?.opens[prompt]?.answer
    }

    /// The window's state now.
    func state(of content: FileWindowContent) -> FileState {
        let session = sessions[content]
        return FileStates.state(content, answer: answer(of: content), fetch: session?.fetch ?? .idle, bot: Naming.sender(content.bot, in: conversation.reading),
                                lineEnd: session?.lineEnd, notSent: session?.notSent ?? false)
    }

    /// What the window waits for, which its task restarts the fetch on when it changes: the click, and the answer it came with (a file row's is 0).
    func wanted(_ content: FileWindowContent) -> Wanted? {
        guard let session = sessions[content] else { return nil }
        switch content.source {
        case .sent(let blob, let name, _, _, _): return Wanted(blob: blob, name: name, stamp: 0, generation: session.generation)
        case .path:
            if case .file(let info, _, _, let position)? = answer(of: content) { return Wanted(blob: info.blob, name: info.name, stamp: position, generation: session.generation) }
            return nil
        }
    }

    struct Wanted: Hashable {
        let blob: Data
        let name: String
        let stamp: Int
        let generation: Int
    }

    /// Fetches what the window waits for, unless it has it or no longer exists. A fetch the connection could not make (no link, a history not
    /// read yet) is asked again every few seconds while the window is open; only a blob the relay lacks, or that does not open, is unreadable.
    func fetchWanted(_ content: FileWindowContent) async {
        // Still the fetch of this click and this answer: a window closed, a click again or an answer read at a new place makes it stale.
        func current(_ want: Wanted) -> Bool {
            !Task.isCancelled && sessions[content]?.generation == want.generation && sessions[content]?.fetch.stamp == want.stamp
        }
        while !Task.isCancelled, let want = wanted(content), sessions[content]?.fetch.stamp != want.stamp {
            sessions[content]?.fetch = .loading(stamp: want.stamp)
            let outcome = await fetchFile(content.channel, want.blob)
            guard current(want) else { return }
            switch outcome {
            case .file(let data):
                // Classified and decoded off the main actor; only the drawn form is kept.
                let (name, stamp) = (want.name, want.stamp)
                let drawn = await Task.detached(priority: .userInitiated) { FileContent(name: name, data: data) }.value
                guard current(want) else { return }
                sessions[content]?.fetch = .done(stamp: stamp, drawn)
            case .gone: sessions[content]?.fetch = .failed(stamp: want.stamp)
            case .ended:
                sessions[content]?.fetch = .idle
                try? await Task.sleep(for: retryAfter)
            }
        }
    }
}
