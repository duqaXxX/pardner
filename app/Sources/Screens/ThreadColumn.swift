// The rules behind the thread's one content column (visual pass, issue #174, 2), pure so that each has its tests: a call's path, the messages that
// share a head, the markup a preview drops, the facts of the session's data row.
import Conversation
import Foundation

/// A call's path as the thread draws it.
enum ToolPath {
    /// `path` from the channel's bound `folder` when it lies inside it (the folder itself is `.`); any other path, or no bind known (the root of the disk is none), as written.
    static func relative(_ path: String, to folder: String?) -> String {
        guard let folder else { return path }
        var base = folder
        while base.hasSuffix("/") { base.removeLast() }
        guard !base.isEmpty else { return path }
        // The slash after the folder is part of the test: `/a/bc` is not inside `/a/b`.
        guard path == base || path.hasPrefix(base + "/") else { return path }
        let rest = path.dropFirst(base.count).drop { $0 == "/" }
        return rest.isEmpty ? "." : String(rest)
    }
}

enum ToolTitle {
    /// A call's title as its verb and its subject (`Read: <path>`): the subject is written from the bound folder only when it is the call's own path, which the
    /// core cuts at 80 characters with `…` (`TITLE_LIMIT`): then the whole path is the one written.
    static func parts(_ title: String, path: String?, folder: String?) -> (verb: String, subject: String?) {
        guard let colon = title.range(of: ": ") else { return (title, nil) }
        let subject = String(title[colon.upperBound...])
        let isPath = path.map { subject == $0 || (subject.hasSuffix("…") && $0.hasPrefix(subject.dropLast())) } ?? false
        return (String(title[..<colon.lowerBound]), isPath ? ToolPath.relative(path ?? subject, to: folder) : subject)
    }

    /// The one symbol of a call's line and card: the agent's own words for a tool are not known to the app (invariant 4).
    static let symbol = "wrench.and.screwdriver"
}

/// The head a message or the start of an answer draws, for the rule that lets the next one stand under it.
enum Grouping {
    struct Head: Equatable { let author: Data, time: Date }

    /// Whether a message joins the head drawn right above it: the same author on the same day. `above` is nil when anything else is drawn
    /// between, or nothing is. In the thread panel the bot's own calls, cards and system events leave `above` in place (a reply has one head);
    /// a person's message, a counted group of unreadable ones, a summary, a run line and a work's end do not.
    static func joins(_ above: Head?, _ head: Head, calendar: Calendar = .current) -> Bool {
        guard let above else { return false }
        return above.author == head.author && calendar.isDate(above.time, inSameDayAs: head.time)
    }
}

enum Markup {
    /// `markdown` as the words it reads: emphasis, code and a link's address dropped. Text that does not read as markup, or does not parse, as written.
    static func plain(_ markdown: String) -> String {
        let inline = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: markdown, options: inline)).map { String($0.characters) } ?? markdown
    }
}

/// The session's data line the bot writes (`⚡ bypass · Sonnet · effort low · main (+0,-0) · ctx 7% · 457.4k tokens · demo`) read by its parts, in the order
/// it wrote them, so that the row draws the model, the branch, the context and the tokens each in its own way. A part it does not know is `plain`.
struct SessionFacts: Equatable {
    struct Branch: Equatable { let name: String, added: Int, removed: Int }
    enum Part: Equatable {
        case plain(String), model(String), branch(Branch), context(Int), tokens(String)
    }
    var parts: [Part] = []
    /// Where the right side of the row starts: the context and the tokens are set apart there, and what the bot wrote after them stands with them.
    var firstRight: Int? { parts.firstIndex { if case .context = $0 { true } else if case .tokens = $0 { true } else { false } } }
    var plain: [String] { parts.compactMap { if case .plain(let text) = $0 { text } else { nil } } }

    init(_ line: String) {
        for part in line.components(separatedBy: " \u{B7} ") {
            if let found = Self.changes(part) {
                parts.append(.branch(found))
            } else if part.hasPrefix("ctx "), part.hasSuffix("%"), let percent = Int(part.dropFirst(4).dropLast()) {
                parts.append(.context(percent))
            } else if part.hasSuffix(" tokens") {
                parts.append(.tokens(part))
            } else if !parts.contains(where: { if case .model = $0 { true } else { false } }), !Self.isAside(part) {
                parts.append(.model(part)) // the first part that is no mode mark, advisor or effort: the footer writes the model right after the mark
            } else {
                parts.append(.plain(part))
            }
        }
    }

    /// The mode mark and the advisor and effort, which the footer writes around the model.
    private static func isAside(_ part: String) -> Bool { part.hasPrefix("⚡ ") || part.hasPrefix("⏸ ") || part.hasPrefix("advisor ") || part.hasPrefix("effort ") }

    /// `main (+12,-3)`, or `(+12,-3)` with no branch.
    private static func changes(_ part: String) -> Branch? {
        guard part.hasSuffix(")"), let open = part.range(of: "(+", options: .backwards) else { return nil }
        let counts = part[open.upperBound...].dropLast().components(separatedBy: ",-")
        guard counts.count == 2, let added = Int(counts[0]), let removed = Int(counts[1]) else { return nil }
        return Branch(name: part[..<open.lowerBound].trimmingCharacters(in: .whitespaces), added: added, removed: removed)
    }
}

extension ReadingModel {
    /// Whether `message` is a bot's notice, drawn as a compact system event: only a bot publishes a profile, so it says who is one. The one rule of the
    /// grouping and of the drawing.
    func isSystemEvent(_ message: Message) -> Bool { message.isNotice && profiles[message.sender] != nil }
}
