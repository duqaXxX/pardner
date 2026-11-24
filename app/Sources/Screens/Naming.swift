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
    static func channel(_ id: Data, in model: ReadingModel) -> String { "#" + bareChannel(id, in: model) }

    /// A channel's name without its `#`, for the sidebar row that draws the `#` in a colour of its own.
    static func bareChannel(_ id: Data, in model: ReadingModel) -> String { model.names.channels[id] ?? short(id) }

    /// A channel by its short id alone, where no names are read.
    static func channel(_ id: Data) -> String { "#" + short(id) }

    /// The initial drawn on a sender's colour when no icon is given (first-screens decision 9).
    static func initial(_ name: String) -> String { name.first.map { String($0).uppercased() } ?? "?" }

    /// A short time of day, as the boards show beside a sender.
    static func time(_ date: Date) -> String { date.formatted(date: .omitted, time: .shortened) }

    /// The date and the time of a message, for the tooltip of its time.
    static func dateTime(_ date: Date) -> String { date.formatted(date: .abbreviated, time: .shortened) }

    /// A day's word for a separator: Today, Yesterday, else the date. `now` and `calendar` are given so that a test fixes them.
    static func day(_ date: Date, now: Date, calendar: Calendar) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return "Today" }
        if let before = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: before) { return "Yesterday" }
        return date.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, locale: calendar.locale ?? .current, calendar: calendar, timeZone: calendar.timeZone))
    }

    /// The separator before each entry: the day's word for the first entry and at each change of calendar day, else nil. An entry with no
    /// time (one whose time is not known) has no separator and leaves the day as it was.
    static func dayLabels(_ times: [Date?], now: Date, calendar: Calendar) -> [String?] {
        var current: Date?
        return times.map { time in
            guard let time else { return nil }
            defer { current = time }
            if let current, calendar.isDate(time, inSameDayAs: current) { return nil }
            return day(time, now: now, calendar: calendar)
        }
    }

    /// The words on the rule under the opening message: nil while nothing but lines answered.
    static func dividerWords(_ replies: Int) -> String? { replies > 0 ? Naming.replies(replies) : nil }

    /// What stands for `count` messages that cannot be read, one after another.
    static func unreadable(_ count: Int) -> String {
        count == 1 ? "This message cannot be read on this device." : "\(count) messages cannot be read on this device."
    }

    /// The count of a thread's replies, as its summary words it.
    static func replies(_ count: Int) -> String { count == 1 ? "1 reply" : "\(count) replies" }

    /// The `@name` a prompt opens its text with: only a prompt of the owner's that reads and names its bot.
    static func mention(of message: Message, in model: ReadingModel) -> String? {
        guard message.kind == 2, message.body != .unreadable, let to = message.to else { return nil }
        return "@" + sender(to, in: model)
    }
}

extension Message {
    /// The text a message shows, as written: a bot's text is read as Markdown where it is drawn (`MarkdownView`, #73; AD 4.4).
    var shown: String {
        switch body {
        case .text(let markdown, _), .part(let markdown), .answer(let markdown): markdown
        case .prompt(let text): text
        case .request(let title, _, _): title
        case .reply: "Answered"
        case .edit(let withdrawn, let answered, let markdown): withdrawn ? "Withdrawn" : answered ? "Answered" : markdown ?? ""
        case .unreadable: Naming.unreadable(1)
        case .line(let line), .lineEdit(let line): line.title
        case .start, .cut, .notRead, .state, .build, .profile: ""
        }
    }
}

extension MessageThread {
    /// The thread's title: the first line of its opening message.
    var title: String { root?.shown.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? "" }

    /// The replies after the opening message: a line is no reply, and the segments of one answer are one.
    var replies: Int {
        var answers = Set<MessageRef>()
        return entries.reduce(0) { count, entry in
            switch entry {
            case .unreadable, .item(.message): count + 1 // a run that cannot be read is the one row the panel draws
            case .item(.answer(let a)): answers.insert(a.ref).inserted ? count + 1 : count
            case .item(.line): count
            }
        }
    }

    /// The time of the newest entry, for the summary under the opening message.
    var lastTime: Date? {
        let messages = items.compactMap { item -> Date? in if case .message(let m) = item { m.time } else { nil } }.max()
        return [messages, lastReply].compactMap { $0 }.max()
    }

    /// `Last reply HH:mm` for the summary, nil while nothing was answered.
    var lastReplyWords: String? { lastTime.map { "Last reply \(Naming.time($0))" } }
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

    /// The state word a summary and the panel's header show: only a session that runs or waits writes one.
    var pill: String? { self == .idle ? nil : label }
}

extension Naming {
    /// The words of the row above the composer: nil while the session is idle; `Waiting for you` while a request is open, else the count of
    /// the tasks that run (C2 3.3).
    static func activityWords(_ state: SessionState, tasks: Int) -> String? {
        switch state {
        case .idle: nil
        case .waiting: "Waiting for you"
        case .running: tasks == 0 ? "Working…" : "Working · " + (tasks == 1 ? "1 task running" : "\(tasks) tasks running")
        }
    }

    /// What a task is called in the list: the task an agent was given, else the line's title.
    static func taskName(_ f: LineFields) -> String { f.agent ?? f.title }

    /// `Running` and, when the line is timed, the time since it started.
    static func runningWords(since: Date?, now: Date) -> String { since.map { "Running · " + elapsed(now.timeIntervalSince($0)) } ?? "Running" }
}
