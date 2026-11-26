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
    /// Who wrote it and when, for a row that draws a message or an answer; nil for a call, a card, a system event or a counted row.
    var head: Grouping.Head?
    /// It stands under the head of the row above, of the same author and day, with nothing drawn between: it draws no avatar, name or time.
    var joins = false
    /// The length of the work the bot's answer ended, which its time carries (`0:36 · 3s`).
    var duration: String?

    /// It draws a header of its own: its avatar, name and time. An answer's later segment has none.
    var showsHead: Bool { if case .segment(let a) = content, a.continues { false } else { head != nil && !joins } }

    /// How far under the row above it stands: a group's 4, a message's 20, or a text's 10 to what hangs on it, a card or a call.
    var gapAbove: CGFloat { joins ? PardnerMetrics.groupGap : head == nil ? PardnerMetrics.cardGap : PardnerMetrics.messageGap }

    /// What `gapAbove` leaves to add to a stack spaced by `messageGap`; a body row keeps the spacing, its first one is placed by `LineBodyRow`.
    var offset: CGFloat { if case .body = content { 0 } else { gapAbove - Self.stack } }

    /// The spacing of the thread panel's lazy stack, which each row corrects to its own gap by `offset`. Not the message gap on purpose: a ten-question
    /// thread opened at its end drew nothing with the stack spaced by 18, 19, 20 or 24 points, and drew with 14, 16, 17, 21 and 22 (`ThreadScrollTests`, 2026-11-26).
    static let stack: CGFloat = 16
}

enum ThreadRows {
    /// The id of the row a line's head is drawn in: what the thread's scroll position names to bring it into view.
    static func id(of line: WorkLine) -> String { "l\(line.position)" }

    /// The rows of `thread`, in order: a line with a diff or a body of code is its head then its body rows. A work's end is no row: it closes its turn, and
    /// its length goes to the head of the bot's answer of that turn, none when the turn drew no answer. `isSystem` says a message is the daemon's own line.
    static func build(_ thread: MessageThread, isSystem: (Message) -> Bool) -> [ThreadRow] {
        var rows: [ThreadRow] = []
        // The head drawn right above the next row, nil once anything else is; and the bot's last head since the previous work's end.
        var above: Grouping.Head?
        var turnHead: Int?
        func add(_ id: String, _ content: ThreadRow.Content, time: Date?, head: Grouping.Head? = nil) {
            rows.append(ThreadRow(id: id, content: content, time: time, head: head, joins: head.map { Grouping.joins(above, $0) } ?? false))
            above = head
            // A person's words close the turn the bot's last head opened: a length after them is the next turn's.
            if let head, head.author != thread.bot { turnHead = nil } else if rows[rows.count - 1].showsHead, head?.author == thread.bot { turnHead = rows.count - 1 }
        }
        for entry in thread.entries {
            switch entry {
            case .unreadable(let count, let first):
                add("u\(first.position)", .unreadable(count: count, first: first), time: first.time, head: count == 1 ? Grouping.Head(author: first.sender, time: first.time) : nil)
            case .item(.message(let m)):
                if thread.isFooter(m) {
                    if let i = turnHead, rows[i].duration == nil, case .footer(let duration?, _, _)? = m.sessionText { rows[i].duration = duration }
                    // The next answer of the bot opens a head; a person's message under the person's own stays grouped.
                    if above?.author == thread.bot { above = nil }
                    turnHead = nil
                    continue
                }
                // A person's message and a bot's text are heads; the daemon's own line, a run line and a request are drawn without one.
                var drawsHead = !thread.isRunLine(m) && !isSystem(m)
                if case .request = m.body { drawsHead = false }
                add("m\(m.position)", .message(m), time: m.time, head: drawsHead ? Grouping.Head(author: m.sender, time: m.time) : nil)
            case .item(.answer(let a)): add("a\(a.position)", .segment(a), time: a.time, head: Grouping.Head(author: a.ref.device, time: a.time))
            case .item(.line(let l)):
                add(id(of: l), .line(l), time: l.time)
                if let preview = l.fields.preview, !preview.record {
                    for index in preview.rows.indices { add("l\(l.position).\(index)", .body(l, index: index), time: nil) }
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

    var ground: Color? { self == .added ? PardnerColor.addBg : self == .removed ? PardnerColor.delBg : nil }
    var ink: Color { self == .added ? PardnerColor.addText : self == .removed ? PardnerColor.delText : PardnerColor.text }
}

/// One line of a diff's body, split into its parts. The daemon writes `<sign><square> <number> <text>` (`+🟩  7 text`), the square being its colour for a
/// chat that draws none; the app tints the whole line instead and leaves the square out (#138). A line of another shape (`...` between hunks,
/// `… +3 lines`, a body with no numbers) keeps all its words as the text, with no sign and no number.
struct DiffLine: Equatable {
    let tint: DiffTint
    /// `+`, `-` or a space.
    let sign: String
    /// The line number as the daemon padded it, so that the numbers of one body line up.
    let number: String
    let text: String
}

extension DiffLine {
    init(_ line: String) {
        tint = DiffTint(line)
        var rest = line.dropFirst()
        if line.first == "+" || line.first == "-" || line.first == " " {
            // The square is one character; a context line has two spaces in its place.
            let mark = rest.first == "\u{1F7E9}" || rest.first == "\u{1F7E5}" ? 1 : rest.hasPrefix("  ") ? 2 : 0
            rest = rest.dropFirst(mark)
            let padding = rest.dropFirst().prefix { $0 == " " }.count
            let digits = rest.dropFirst(1 + padding).prefix { $0.isASCII && $0.isNumber }
            let after = rest.dropFirst(1 + padding + digits.count)
            if mark > 0, rest.first == " ", !digits.isEmpty, after.first == " " {
                (sign, number, text) = (String(line.first!), String(rest.dropFirst().prefix(padding + digits.count)), String(after.dropFirst()))
                return
            }
        }
        (sign, number, text) = ("", "", line)
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
    /// The folder the channel is bound to, which the path in a call's title is written from; nil with no bind known.
    var folder: String?
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
                        .buttonStyle(.clickable).foregroundStyle(PardnerColor.muted)
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
        let parts = form.words.map { (verb: $0, subject: String?.none) } ?? ToolTitle.parts(f.preview?.title ?? f.title, path: f.path, folder: folder)
        // The verb in semibold, the path or command after it in muted monospace (visual pass #174, 2).
        let title = HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verbatim: parts.verb).font(PardnerFont.ui(size: 13, weight: .semibold)).lineLimit(1).truncationMode(.middle)
            if let subject = parts.subject {
                Text(verbatim: subject).font(PardnerFont.mono(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted).lineLimit(1).truncationMode(.middle)
            }
        }
        let words = Self.headWords(f, form).map {
            Text(verbatim: $0).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.muted).lineLimit(1).truncationMode(.tail)
        }
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            // The words take the room the state leaves, so that the details run up to it before they are cut; the title is cut first.
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                icon(f)
                switch link {
                case .none:
                    title.layoutPriority(1)
                    words
                case .title(let open):
                    Button(action: open) { title }.buttonStyle(.clickable).layoutPriority(1)
                    words
                case .words(let open):
                    Button(action: open) { HStack(spacing: 8) { title.layoutPriority(1); words } }.buttonStyle(.clickable)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            stateWords.fixedSize()
            if let count = Self.callCount(of: f) { Text(verbatim: count).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted).fixedSize() }
        }
        .help(Self.tooltip(f, form, path: path))
    }

    /// The word the core writes as the output of a call the owner stopped (`STOPPED`, src/core/reply/words.ts): that call ended in error, and is not a failure.
    static let stopped = "Stopped"

    /// The mark before a head: a failed call's triangle in red, a stopped one's square in muted, else the generic call symbol in muted.
    @ViewBuilder private func icon(_ f: LineFields) -> some View {
        if f.status == .error && f.output != Self.stopped {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 12)).foregroundStyle(PardnerColor.delText).frame(width: 14).accessibilityLabel("Failed")
        } else if f.status == .error {
            Image(systemName: "stop.fill").font(.system(size: 11)).foregroundStyle(PardnerColor.muted).frame(width: 14).accessibilityLabel("Stopped")
        } else {
            Image(systemName: ToolTitle.symbol).font(.system(size: 11)).foregroundStyle(PardnerColor.muted).frame(width: 14).accessibilityHidden(true)
        }
    }

    /// What a head's tooltip says, so that what is cut is not lost: its title (a file's path when the head links to it), then its details, a line each.
    nonisolated static func tooltip(_ f: LineFields, _ form: LineForm, path: String?) -> String {
        [path ?? form.words ?? f.preview?.title ?? f.title, headWords(f, form)].compactMap { $0 }.joined(separator: "\n")
    }

    /// What follows the title: an agent's task, or the first line of its reply; else the preview's summary or the details.
    nonisolated static func headWords(_ f: LineFields, _ form: LineForm) -> String? {
        switch form {
        case .agentAsked: f.agent
        case .agentReplied: firstSaid(f.output).map(Markup.plain)
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
            let row = CodeMarks.shown(preview.rows[index])
            Group {
                if preview.language == "diff" {
                    DiffRowText(row: row)
                } else {
                    Text(row).font(PardnerFont.mono(size: 12, weight: .regular)).fixedSize(horizontal: false, vertical: true)
                }
            }
            .textSelection(.enabled)
            .padding(.top, index == 0 ? firstTop : 0)
            .padding(.leading, indent).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// A diff's row as one text, so that a selection runs across its lines: per line the sign in the line's colour, the number in grey, then the text.
/// Each line's soft ground (`add-bg`, `del-bg`) is drawn behind the text from its own line layout (`Text.LayoutKey`), across the whole column,
/// and a line that wraps keeps one ground for all its pieces.
struct DiffRowText: View {
    let lines: [DiffLine]

    init(row: String) { lines = row.components(separatedBy: "\n").map(DiffLine.init) } // "\n" alone: a line may end in "\r"

    /// The room between two lines, so that a line stands 20 points from the next.
    private static let spacing: CGFloat = 4

    /// Which source line a stretch of the text is from, read back from the layout: a layout line's index is opaque, so the text carries its own.
    private struct SourceLine: TextAttribute { let index: Int }

    /// One styled piece per source line, each but the last ending in its newline.
    static func pieces(_ lines: [DiffLine]) -> [AttributedString] {
        lines.enumerated().map { i, line in piece(line) + AttributedString(i < lines.count - 1 ? "\n" : "") }
    }

    private static func piece(_ line: DiffLine) -> AttributedString {
        var text = AttributedString(line.text)
        text.foregroundColor = line.tint.ink
        guard !line.sign.isEmpty else { return text }
        var head = AttributedString(line.sign)
        head.foregroundColor = line.tint.ink
        var number = AttributedString(" " + line.number + " ")
        number.foregroundColor = PardnerColor.muted
        return head + number + text
    }

    /// The top of each layout line and the source line its runs carry (nil for an empty line, which has no run).
    private func layoutLines(_ layouts: [Text.LayoutKey.AnchoredLayout], in proxy: GeometryProxy) -> [(top: CGFloat, source: Int?)] {
        var out: [(top: CGFloat, source: Int?)] = []
        for anchored in layouts {
            let origin = proxy[anchored.origin]
            for line in anchored.layout {
                let top = out.isEmpty ? 0 : origin.y + line.typographicBounds.rect.minY - Self.spacing / 2
                out.append((top, line.lazy.compactMap { $0[SourceLine.self]?.index }.first))
            }
        }
        return out
    }

    var body: some View {
        Self.pieces(lines).enumerated().map { Text($1).customAttribute(SourceLine(index: $0)) }.reduce(Text(verbatim: ""), +)
            .font(PardnerFont.mono(size: 12, weight: .regular))
            .lineSpacing(Self.spacing).fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 8).padding(.vertical, Self.spacing / 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .backgroundPreferenceValue(Text.LayoutKey.self) { layouts in
                GeometryReader { proxy in
                    let rows = layoutLines(layouts, in: proxy)
                    ForEach(rows.indices, id: \.self) { k in
                        if let source = rows[k].source, let ground = lines[source].tint.ground {
                            ground.frame(height: (k + 1 < rows.count ? rows[k + 1].top : proxy.size.height) - rows[k].top).offset(y: rows[k].top)
                        }
                    }
                }
            }
    }
}
