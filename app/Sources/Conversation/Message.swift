// A message as the screens read it (app data design, 4.1 and 6): the link's view, with its body read
// once by kind (relay chat module design, 3.7 and 3.8). What the body does not say is `unreadable`,
// never a crash: the text comes from another device and is checked here as data.
import Foundation
import ProtocolHost

/// How one message names another (PD 6.4 `re`): its sender and its name.
public struct MessageRef: Hashable, Sendable {
    public let device: Data
    public let name: Data

    /// The message `name` of the device `device`.
    public init(device: Data, name: Data) { (self.device, self.name) = (device, name) }

    /// The hex of the sender, then of the name: how a body names the thread its opening prompt opened.
    public var hex: String { device.hexString + name.hexString }
}

/// The terminal's own view of a finished call (`Preview` of src/chat/seam.ts), with its body cut in rows for a lazy stack.
public struct LinePreview: Sendable, Equatable {
    /// The most lines a row of a body holds (turn work design 2.7).
    public static let rowLines = 200

    public let title: String
    public let summary: String
    public let body: String
    /// `diff` for a diff, whose lines the first character tints; empty otherwise.
    public let language: String
    public let plain: Bool
    /// The body is the whole of the call: lines of words in one block.
    public let record: Bool
    /// The body in rows of at most `rowLines` lines; a record is one row.
    public let rows: [String]

    init?(_ o: Any?) {
        guard let o = o as? [String: Any], let title = o["title"] as? String, let summary = o["summary"] as? String,
              let body = o["body"] as? String else { return nil }
        (self.title, self.summary, self.body) = (title, summary, body)
        language = o["language"] as? String ?? ""
        plain = o["plain"] as? Bool ?? false
        record = o["record"] as? Bool ?? false
        rows = record ? (body.isEmpty ? [] : [body]) : Self.rows(of: body)
    }

    /// `body` cut at line ends into rows of at most `rowLines` lines; none for an empty body.
    public static func rows(of body: String) -> [String] {
        guard !body.isEmpty else { return [] }
        // On "\n" alone: Swift reads "\r\n" as one Character, and the core keeps a hunk's lines as the SDK wrote them.
        let lines = body.components(separatedBy: "\n")
        return stride(from: 0, to: lines.count, by: rowLines).map { lines[$0..<min($0 + rowLines, lines.count)].joined(separator: "\n") }
    }
}

public enum LineStatus: String, Sendable, Equatable {
    case pending, inProgress = "in_progress", complete, error
}

/// A `TaskUpdate` as the bot writes it into a line's body: without `id`, `name` and `folded`, `startedAt` as wall-clock milliseconds.
public struct LineFields: Sendable, Equatable {
    public let title: String
    public let status: LineStatus
    public let details: String?
    public let output: String?
    /// A subagent's or a background command's line.
    public let task: Bool
    /// A card of words to read: its `output` is its body, opened on a click.
    public let message: Bool
    public let calls: Int
    public let preview: LinePreview?
    public let startedAt: Date?
    /// The task an agent was given, on that agent's line and on its reply; nil on any other line, and from a bot that predates the field.
    public let agent: String?

    init?(_ o: [String: Any]) {
        guard let title = o["title"] as? String, let word = o["status"] as? String, let status = LineStatus(rawValue: word) else { return nil }
        (self.title, self.status) = (title, status)
        details = o["details"] as? String
        output = o["output"] as? String
        task = o["task"] as? Bool ?? false
        message = o["message"] as? Bool ?? false
        calls = (o["calls"] as? NSNumber)?.intValue ?? 0
        preview = LinePreview(o["preview"])
        agent = o["agent"] as? String
        startedAt = (o["startedAt"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }
    }
}

/// The prompts the app's own controls send in a thread (Stop and the session menu), marked by `"control": true` in their encrypted content, a
/// field the bot does not read. The reading draws none of them.
public enum ControlPrompt {
    /// The words the controls send, and the only text a control prompt may have.
    public static let words: Set<String> = ["/stop", "/bypass on", "/bypass off", "/plan on", "/plan off"]

    /// Whether a prompt's content fields mark a control: the flag is a JSON boolean (`1` is not one) and the text is one of `words`.
    public static func holds(_ fields: [String: Any]?) -> Bool {
        guard let flag = fields?["control"] as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID(), flag.boolValue,
              let text = fields?["text"] as? String else { return false }
        return words.contains(text)
    }

    /// Whether the bot's answer to this word is hidden: `/stop`'s effect is seen elsewhere, a mode word's refusal is not.
    static func hidesAnswer(_ text: String) -> Bool { text == "/stop" }
}

/// A file of an opened body, without the key that opens its blob.
public struct FileInfo: Sendable, Equatable {
    public let blob: Data
    public let size: Int
    public let type: String
    public let name: String
}

/// What a body says, by kind. Requests and replies keep their JSON as written: the screen of questions and
/// approvals reads it (plan 3.5).
public enum Body: Sendable, Equatable {
    /// Kind 1: a text, `say` being how a bot asks it drawn (`notice`, `say`, `tell`), nil for a person's.
    case text(markdown: String, say: String?)
    /// Kind 2: a prompt of the owner's.
    case prompt(text: String)
    /// Kinds 3, 6, 7: the bot started the prompt named by `re`, cut it, or did not read it.
    case start, cut, notRead
    /// Kind 4: a piece of the answer named by `re`, as it is written.
    case part(markdown: String)
    /// Kind 5: the whole answer to the prompt named by `re`.
    case answer(markdown: String)
    /// Kind 9: a question or an approval for the owner.
    case request(title: String, type: String?, json: String)
    /// Kind 10: the owner's answer to the request named by `re`.
    case reply(type: String?, json: String)
    /// Kind 11: the request named by `re` withdrawn, answered elsewhere, or rewritten as `markdown`.
    case edit(withdrawn: Bool, answered: Bool, markdown: String?)
    /// Kind 1 with `say` "task": a line of the turn, a tool call or a task, as its first sight (turn work design 2.2).
    case line(LineFields)
    /// Kind 11 whose body holds a `task`: the line named by `re`, as it stands now.
    case lineEdit(LineFields)
    /// Kinds 8, 12, 13: the bot's state, a build, a profile: nothing in the conversation.
    case state, build, profile
    /// A body that did not open, or that does not read as its kind's.
    case unreadable
}

/// The folder a bot's answer to `/bind` says the channel is bound to, and whether the bot can use it (channel folder design, 1).
public struct Bind: Sendable, Equatable {
    public enum State: String, Sendable, Equatable { case usable, untrusted, missing, unreadable }
    public let folder: String
    public let state: State

    /// A bind of `folder` in `state`.
    public init(folder: String, state: State) { (self.folder, self.state) = (folder, state) }

    /// The `bind` of a kind 1 content; nil unless it is an object with a folder and one of the four states: the text is then drawn alone.
    init?(_ value: Any?) {
        guard let o = value as? [String: Any], let folder = o["folder"] as? String, let name = o["state"] as? String,
              let state = State(rawValue: name) else { return nil }
        self.init(folder: folder, state: state)
    }
}

public struct Message: Sendable, Equatable {
    public let position: Int
    public let channel: Data
    public let sender: Data
    public let name: Data
    public let time: Date
    public let kind: Int
    public let to: Data?
    public let re: MessageRef?
    /// The thread the body names, the hex of its opening prompt's reference; nil for one that opens a thread or has none.
    public let thread: String?
    public let body: Body
    public let files: [FileInfo]
    /// A kind 5 that says its prompt's thread holds no session (`"session": false`): the prompt was answered as a word, or refused.
    public let noSession: Bool
    /// A kind 1 that carries a bind field (the bot's answer to `/bind`).
    public let bind: Bind?
    /// A kind 2 whose content says `"control": true` with one of the words the app's controls send (`ControlPrompt`). Whether it is the owner's
    /// is the reading's to decide (`Channel.fold`): the prompt is never drawn.
    public let control: Bool

    public var ref: MessageRef { MessageRef(device: sender, name: name) }

    /// A view the link delivered (`{do: "message", ...}`), or nil when it is not one.
    public init?(view: HostValue) {
        guard view["do"]?.stringValue == "message", let position = view["position"]?.numberValue,
              let channel = view["channel"]?.bytesValue, let sender = view["sender"]?.bytesValue,
              let name = view["name"]?.bytesValue, let time = view["time"]?.numberValue,
              let kind = view["kind"]?.numberValue else { return nil }
        (self.position, self.channel, self.sender, self.name, self.kind) = (Int(position), channel, sender, name, Int(kind))
        self.time = Date(timeIntervalSince1970: time / 1000)
        to = view["to"]?.bytesValue
        if let device = view["re"]?["device"]?.bytesValue, let n = view["re"]?["name"]?.bytesValue {
            re = MessageRef(device: device, name: n)
        } else { re = nil }
        files = (view["files"]?.arrayValue ?? []).compactMap { f in
            guard let blob = f["blob"]?.bytesValue, let size = f["size"]?.numberValue, let type = f["type"]?.stringValue,
                  let name = f["name"]?.stringValue else { return nil }
            return FileInfo(blob: blob, size: Int(size), type: type, name: name)
        }
        let fields = view["text"]?.stringValue.flatMap(Self.object)
        thread = fields?["thread"] as? String
        bind = kind == 1 ? Bind(fields?["bind"]) : nil
        control = kind == 2 && ControlPrompt.holds(fields)
        noSession = kind == 5 && fields?["session"] as? Bool == false
        body = fields.map { Self.body(kind: Int(kind), $0, text: view["text"]?.stringValue ?? "") } ?? .unreadable
    }

    private static func object(_ text: String) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
    }

    private static func body(kind: Int, _ o: [String: Any], text: String) -> Body {
        let markdown = o["markdown"] as? String
        switch kind {
        case 1:
            if o["say"] as? String == "task" { return (o["task"] as? [String: Any]).flatMap(LineFields.init).map { .line($0) } ?? .unreadable }
            return markdown.map { .text(markdown: $0, say: o["say"] as? String) } ?? .unreadable
        case 2: return (o["text"] as? String).map { .prompt(text: $0) } ?? .unreadable
        case 3: return .start
        case 4: return markdown.map { .part(markdown: $0) } ?? .unreadable
        case 5: return markdown.map { .answer(markdown: $0) } ?? .unreadable
        case 6: return .cut
        case 7: return .notRead
        case 8: return .state
        case 9:
            guard let title = o["title"] as? String, let request = o["request"] as? [String: Any] else { return .unreadable }
            return .request(title: title, type: request["type"] as? String, json: text)
        case 10:
            guard let answer = o["answer"] as? [String: Any] else { return .unreadable }
            return .reply(type: answer["type"] as? String, json: text)
        case 11:
            if let task = o["task"] as? [String: Any] { return LineFields(task).map { .lineEdit($0) } ?? .unreadable }
            return .edit(withdrawn: o["withdrawn"] as? Bool ?? false, answered: o["answered"] as? Bool ?? false, markdown: markdown)
        case 12: return .build
        case 13: return .profile
        default: return .unreadable
        }
    }
}

extension Data {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
