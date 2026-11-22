// How the screens name what the protocol carries no name for yet (app window design, decisions W2 and W3):
// a bot by its profile, else by its short id; a person and a channel by their short id.
import Conversation
import Foundation

enum Naming {
    /// The first eight hex digits of an id: enough to tell apart the few devices and channels of one person.
    static func short(_ id: Data) -> String { id.prefix(4).map { String(format: "%02x", $0) }.joined() }

    /// A sender as a message shows it.
    static func sender(_ id: Data, in model: ReadingModel) -> String {
        model.profiles[id]?.name ?? (model.isOwn(id) ? model.personName : nil) ?? model.names.devices[id] ?? short(id)
    }

    /// A channel in the sidebar and the header: its name when one shows, else its short id.
    static func channel(_ id: Data, in model: ReadingModel) -> String { "#" + (model.names.channels[id] ?? short(id)) }

    /// A channel by its short id alone, where no names are read.
    static func channel(_ id: Data) -> String { "#" + short(id) }

    /// The initial drawn on a sender's colour when no icon is given (first-screens decision 9).
    static func initial(_ name: String) -> String { name.first.map { String($0).uppercased() } ?? "?" }

    /// A short time of day, as the boards show beside a sender.
    static func time(_ date: Date) -> String { date.formatted(date: .omitted, time: .shortened) }
}

extension Message {
    /// The text a message shows, as plain text: what an agent writes is never read as markup (AD 4.4).
    var shown: String {
        switch body {
        case .text(let markdown, _), .part(let markdown), .answer(let markdown): markdown
        case .prompt(let text): text
        case .request(let title, _, _): title
        case .reply: "Answered"
        case .edit(let withdrawn, let answered, let markdown): withdrawn ? "Withdrawn" : answered ? "Answered" : markdown ?? ""
        case .unreadable: "This message cannot be read on this device."
        case .start, .cut, .notRead, .state, .build, .profile: ""
        }
    }
}

extension MessageThread {
    /// The thread's title: the first line of its opening message.
    var title: String { root?.shown.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? "" }

    /// The replies after the opening message.
    var replies: Int { items.count }

    /// The time of the newest entry, for the summary under the opening message.
    var lastTime: Date? {
        let messages = items.compactMap { item -> Date? in if case .message(let m) = item { m.time } else { nil } }.max()
        return [messages, lastReply].compactMap { $0 }.max()
    }
}

extension SessionState {
    /// The words of a session's state, as the summary and the panel show them.
    var label: String {
        switch self {
        case .idle: "Idle"
        case .running: "Running"
        case .waiting: "Waiting for you"
        }
    }
}
