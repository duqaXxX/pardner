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
        noSession = kind == 5 && fields?["session"] as? Bool == false
        body = fields.map { Self.body(kind: Int(kind), $0, text: view["text"]?.stringValue ?? "") } ?? .unreadable
    }

    private static func object(_ text: String) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
    }

    private static func body(kind: Int, _ o: [String: Any], text: String) -> Body {
        let markdown = o["markdown"] as? String
        switch kind {
        case 1: return markdown.map { .text(markdown: $0, say: o["say"] as? String) } ?? .unreadable
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
