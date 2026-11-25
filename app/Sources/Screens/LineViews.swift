// A turn's lines in the thread (turn work design 2.6 and 2.7): three forms chosen by the fields alone, the words the terminal wrote
// drawn as they came (`Text(verbatim:)`, nothing read as markup), and a preview's body in rows of at most 200 lines so that the lazy
// stack builds only what is on screen. The app owns the words `Running` and `Interrupted` and nothing else in a line.
import Conversation
import DesignSystem
import SwiftUI

/// One row of the thread panel's lazy stack: an entry of the thread, or one of the rows a line's preview body is cut in.
struct ThreadRow: Identifiable {
    enum Content {
        case message(Message)
        case unreadable(count: Int, first: Message)
        case segment(AnswerGroup)
        case line(WorkLine)
        /// The `index`th row of the body of the line's preview.
        case body(WorkLine, index: Int)
    }

    let id: String
    let content: Content
    /// The time its day word goes by; nil for a row that continues an entry.
    let time: Date?
}

enum ThreadRows {
    /// The id of the row a line's head is drawn in: what the thread's scroll position names to bring it into view.
    static func id(of line: WorkLine) -> String { "l\(line.position)" }

    /// The rows of `thread`, in order: a line with a diff or a body of code is its head then its body rows.
    static func build(_ thread: MessageThread) -> [ThreadRow] {
        var rows: [ThreadRow] = []
        for entry in thread.entries {
            switch entry {
            case .unreadable(let count, let first):
                rows.append(ThreadRow(id: "u\(first.position)", content: .unreadable(count: count, first: first), time: first.time))
            case .item(.message(let m)): rows.append(ThreadRow(id: "m\(m.position)", content: .message(m), time: m.time))
            case .item(.answer(let a)): rows.append(ThreadRow(id: "a\(a.position)", content: .segment(a), time: a.time))
            case .item(.line(let l)):
                rows.append(ThreadRow(id: id(of: l), content: .line(l), time: l.time))
                if let preview = l.fields.preview, !preview.record {
                    for index in preview.rows.indices { rows.append(ThreadRow(id: "l\(l.position).\(index)", content: .body(l, index: index), time: nil)) }
                }
            }
        }
        return rows
    }
}

/// How a line of a diff's body is tinted, by its first character (the seam's convention for `language` `diff`).
enum DiffTint: Equatable {
    case added, removed, plain

    init(_ line: some StringProtocol) { self = line.first == "+" ? .added : line.first == "-" ? .removed : .plain }

    /// `rows` as one text with each line tinted, or as written when the body is not a diff.
    static func text(_ row: String, diff: Bool) -> AttributedString {
        guard diff else { return AttributedString(row) }
        var out = AttributedString()
        let lines = row.components(separatedBy: "\n") // "\n" alone: a line may end in "\r"
        for (i, line) in lines.enumerated() {
            var piece = AttributedString(line + (i < lines.count - 1 ? "\n" : ""))
            switch DiffTint(line) {
            case .added: (piece.backgroundColor, piece.foregroundColor) = (PardnerColor.addBg, PardnerColor.addText)
            case .removed: (piece.backgroundColor, piece.foregroundColor) = (PardnerColor.delBg, PardnerColor.delText)
            case .plain: break
            }
            out += piece
        }
        return out
    }
}

extension Naming {
    /// The time a line has run, as the terminal counts it: `12s`, `1m 05s`, `1h 02m`.
    static func elapsed(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return String(format: "%dm %02ds", s / 60, s % 60) }
        return String(format: "%dh %02dm", s / 3600, s % 3600 / 60)
    }
}

/// Which of the forms a line's fields draw (turn work design 2.6, and C1 3.4 for an agent's).
enum LineForm: Equatable {
    case call, message, agentAsked, agentReplied

    init(_ f: LineFields) { self = f.agent != nil ? (f.message ? .agentReplied : .agentAsked) : (f.message ? .message : .call) }

    /// The words the app writes in place of the line's title.
    var words: String? {
        switch self {
        case .agentAsked: "Asked an agent"
        case .agentReplied: "Agent replied"
        case .call, .message: nil
        }
    }
}

extension Naming {
    /// The count of an agent's calls.
    static func calls(_ count: Int) -> String { count == 1 ? "1 call" : "\(count) calls" }
}

/// The head of a line: its words by the forms, and the state the app owns.
struct LineRow: View {
    let line: WorkLine
    /// How the line stands, worked out by the caller so that a change to the thread elsewhere does not draw every row again.
    let state: LineState
    /// What the row is indented by to line up with a bot's text.
    var indent: CGFloat = MessageRow.Mark.thread.size + MessageRow.Mark.thread.gap
    /// The thread the line is in, where a click on its path opens the file; nil where the window has no pairing.
    var place: FilePlace?
    /// The files of the images the line's call returned (step E2 design 3.1), drawn as thumbnails under its head.
    var images: [FileInfo] = []
    @Environment(\.openWindow) private var openWindow
    @Environment(FileOpener.self) private var opener: FileOpener?

    var body: some View {
        let f = line.fields
        VStack(alignment: .leading, spacing: 2) {
            if let preview = f.preview, preview.record {
                Text(verbatim: preview.body).font(PardnerFont.ui(size: 13, weight: .regular))
            } else {
                let form = LineForm(f)
                if form == .agentReplied, let reply = ReplyContent(f) {
                    head(f, form, link: .words { openWindow(id: WindowID.reply, value: reply) })
                } else if let opener, let place, let path = opener.link(for: line) {
                    // The call's file: a click opens its content in a window of its own (file-content design, 3.7).
                    head(f, form, path: path, link: .title {
                        let content = FileWindowContent(channel: place.channel, thread: place.thread, bot: line.ref.device, source: .path(path))
                        opener.open(content, lineEnd: line.ended)
                        openWindow(id: WindowID.file, value: content)
                    })
                } else {
                    head(f, form)
                }
                if let details = Self.agentDetails(f, form) {
                    Text(verbatim: details).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                }
                if f.preview == nil {
                    if form == .message, let reply = ReplyContent(f) {
                        Button { openWindow(id: WindowID.reply, value: reply) } label: {
                            Label("Show", systemImage: "chevron.right").font(PardnerFont.ui(size: 12, weight: .medium))
                        }
                        .buttonStyle(.plain).pointerStyle(.link).foregroundStyle(PardnerColor.muted)
                    } else if f.status == .error, let output = f.output {
                        Text(verbatim: Self.bounded(output)).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                    }
                }
                if !images.isEmpty, let opener, let place {
                    ThumbnailRow(files: images, place: place, opener: opener, bot: line.ref.device, at: line.ended ?? line.time)
                }
            }
        }
        .padding(.leading, indent)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// What of a head is a link: nothing, its title alone (a file), or its title and details (a reply). The blank part of the row is never one.
    private enum HeadLink {
        case none
        case title(() -> Void)
        case words(() -> Void)
    }

    /// A call's head on one line (step F design FB, 3.1): the title cut in the middle, the details cut at the end, the state words whole on the right.
    private func head(_ f: LineFields, _ form: LineForm, path: String? = nil, link: HeadLink = .none) -> some View {
        let title = Text(verbatim: form.words ?? f.preview?.title ?? f.title).font(PardnerFont.ui(size: 13, weight: .semibold))
            .lineLimit(1).truncationMode(.middle)
        let words = Self.headWords(f, form).map {
            Text(verbatim: $0).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.muted).lineLimit(1).truncationMode(.tail)
        }
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            // The words take the room the state leaves, so that the details run up to it before they are cut; the title is cut first.
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if f.status == .error { Image(systemName: "exclamationmark.triangle").font(.system(size: 12)).foregroundStyle(PardnerColor.delText).accessibilityLabel("Failed") }
                switch link {
                case .none:
                    title.layoutPriority(1)
                    words
                case .title(let open):
                    Button(action: open) { title }.buttonStyle(.plain).pointerStyle(.link).layoutPriority(1)
                    words
                case .words(let open):
                    Button(action: open) { HStack(spacing: 8) { title.layoutPriority(1); words } }.buttonStyle(.plain).pointerStyle(.link)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            stateWords.fixedSize()
            if let count = Self.callCount(of: f) { Text(verbatim: count).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted).fixedSize() }
        }
        .help(Self.tooltip(f, form, path: path))
    }

    /// What a head's tooltip says, so that what is cut is not lost: its title (a file's path when the head links to it), then its details, a line each.
    nonisolated static func tooltip(_ f: LineFields, _ form: LineForm, path: String?) -> String {
        [path ?? form.words ?? f.preview?.title ?? f.title, headWords(f, form)].compactMap { $0 }.joined(separator: "\n")
    }

    /// What follows the title: an agent's task, or the first line of its reply; else the preview's summary or the details.
    nonisolated static func headWords(_ f: LineFields, _ form: LineForm) -> String? {
        switch form {
        case .agentAsked: f.agent
        case .agentReplied: firstSaid(f.output)
        case .call, .message: f.preview?.summary ?? f.details
        }
    }

    /// An agent's details (its calls, one to a line) on rows of their own under the head: a call's stay in its head.
    nonisolated static func agentDetails(_ f: LineFields, _ form: LineForm) -> String? { form == .agentAsked ? f.details : nil }

    /// The count of an agent's calls once its line is closed; nil while it works, with no call, or on a line that is no agent's.
    nonisolated static func callCount(of f: LineFields) -> String? {
        guard f.agent != nil, !f.message, f.status != .pending, f.status != .inProgress, f.calls > 0 else { return nil }
        return Naming.calls(f.calls)
    }

    /// The first line of `output` with a letter or a digit in it, which is what a reply's row says of it.
    nonisolated static func firstSaid(_ output: String?) -> String? {
        output?.split(whereSeparator: \.isNewline).first { $0.contains { $0.isLetter || $0.isNumber } }.map(String.init)
    }

    /// The most lines of an output the row shows.
    static let outputLines = 40
    private static let outputCharacters = 4_000

    /// `output` cut at a line's end to `outputLines` lines with the count of the rest; one line past `outputCharacters` is cut between characters.
    static func bounded(_ output: String) -> String {
        var lines = output.components(separatedBy: "\n")
        if lines.count > 1, lines.last == "" { lines.removeLast() } // a final line end opens no line
        var shown = lines.prefix(outputLines).joined(separator: "\n")
        if shown.count > outputCharacters { shown = String(shown.prefix(outputCharacters)) + "…" }
        return lines.count > outputLines ? shown + "\n… +\(lines.count - outputLines) lines" : shown
    }

    @ViewBuilder private var stateWords: some View {
        switch state {
        case .running(let since):
            if let since {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(verbatim: "Running · " + Naming.elapsed(context.date.timeIntervalSince(since))).monospacedDigit()
                }
                .font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.agentText)
            } else {
                Text("Running").font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.agentText)
            }
        case .interrupted: Text("Interrupted").font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.muted)
        case .waiting, .written: EmptyView()
        }
    }
}

/// One row of a preview's body, in the monospace font, invisible code points written as their numbers (#73, 2.5).
struct LineBodyRow: View {
    let line: WorkLine
    let index: Int
    var indent: CGFloat = MessageRow.Mark.thread.size + MessageRow.Mark.thread.gap
    /// The offset of the first row, which the caller works out from its stack's spacing (`top(underStackOf:)`); the rows after it keep the spacing.
    var firstTop: CGFloat = 0

    /// How far under its head the first row of a body stands.
    static let headGap: CGFloat = 2

    /// The first row's offset in a stack of `spacing`, so that it stands `headGap` under the head above it.
    static func top(underStackOf spacing: CGFloat) -> CGFloat { headGap - spacing }

    var body: some View {
        if let preview = line.fields.preview, preview.rows.indices.contains(index) {
            Text(DiffTint.text(CodeMarks.shown(preview.rows[index]), diff: preview.language == "diff"))
                .font(PardnerFont.mono(size: 12, weight: .regular)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .padding(.top, index == 0 ? firstTop : 0)
                .padding(.leading, indent).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
