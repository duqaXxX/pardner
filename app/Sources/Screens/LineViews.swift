// A turn's lines in the thread (turn work design 2.6 and 2.7): three forms chosen by the fields alone, the words the terminal wrote
// drawn as they came (`Text(verbatim:)`, nothing read as markup), and a preview's body in rows of at most 200 lines so that the lazy
// stack builds only what is on screen. The app owns the words `Running`, `Waiting for you` and `Interrupted` and nothing else in a line.
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
        /// A run of finished calls folded into one row (#27).
        case fold(CallFold)
        /// The `index`th row of the body of the line's preview.
        case body(WorkLine, index: Int)
    }

    let id: String
    let content: Content
    /// The time its day word goes by; nil for a row that continues an entry.
    let time: Date?
    /// Who wrote it and when, for a row that draws a message, an answer or a call that opens the bot's reply; nil for any other call, a card, a
    /// system event or a counted row.
    var head: Grouping.Head?
    /// It stands under the head above, of the same author and day, with nothing drawn between but the bot's calls, their body rows, cards and
    /// system events when the head is the bot's: it draws no avatar, name or time.
    var joins = false
    /// The length of the work a turn took, which the time of the head that opens the bot's reply carries (`0:36 · worked for 3s`): a text or a
    /// call; a person's head never has one.
    var duration: String?
    /// The row above it is a call's (a line, a fold or a preview's body): a text under it stands `callGap` from it.
    var afterCall = false

    /// A call's row or a fold's: the rows that stand `callGap` from their neighbours.
    var isCall: Bool {
        switch content {
        case .line, .fold: true
        default: false
        }
    }

    /// A call's row, a fold's, or a row of a preview's body: what a text under it stands `callGap` from.
    var endsCall: Bool {
        if case .body = content { true } else { isCall }
    }

    /// It draws a header of its own: its avatar, name and time. An answer's later segment has none.
    var showsHead: Bool { if case .segment(let a) = content, a.continues { false } else { head != nil && !joins } }

    /// How far under the row above it stands: 8 for a call's or a fold's that draws no head of its own, and for a row under a call that draws none either
    /// (a text that joins the head above, a card, a system event); else a group's 4 (a row that joins), a message's 20 (a head), or a card's 10 (a row with no head).
    var gapAbove: CGFloat {
        if isCall && !showsHead || (joins || head == nil) && afterCall { return PardnerMetrics.callGap }
        return joins ? PardnerMetrics.groupGap : head == nil ? PardnerMetrics.cardGap : PardnerMetrics.messageGap
    }

    /// What `gapAbove` leaves to add to a stack spaced by `messageGap`; a body row is placed by `LineBodyRow`, which closes the stack's spacing itself.
    var offset: CGFloat { if case .body = content { 0 } else { gapAbove - Self.stack } }

    /// The spacing of the thread panel's lazy stack, which each row corrects to its own gap by `offset`. Not the message gap on purpose: a ten-question
    /// thread opened at its end drew nothing with the stack spaced by 18, 19, 20 or 24 points, and drew with 14, 16, 17, 21 and 22 (`ThreadScrollTests`, 2026-11-26).
    static let stack: CGFloat = 16
}

/// A run of consecutive finished calls of one reply, drawn as one line (#27): the calls it holds, in order.
struct CallFold: Equatable {
    let lines: [WorkLine]

    /// The calls' words by the groups the tools declare, in order of first appearance: each group's sentence filled with its count, joined with
    /// `, `, the first as written and the rest from a lowercase letter, as the terminal writes it (`Read 2 files, ran 3 shell commands`).
    var words: String {
        var groups: [(fold: LineFold, count: Int)] = []
        for case let fold? in lines.map(\.fields.fold) {
            if let i = groups.firstIndex(where: { $0.fold == fold }) { groups[i].count += 1 } else { groups.append((fold, 1)) }
        }
        return groups.enumerated().map { i, group in
            let said = group.fold.sentence(group.count)
            return i == 0 ? said : said.prefix(1).lowercased() + said.dropFirst()
        }.joined(separator: ", ")
    }

    /// The ids the owner's open state is kept by: every line of the run, because the run's first line changes when an earlier call of it finishes
    /// after a later one, and a call in the middle that finishes joins two runs.
    private var ids: Set<String> { Set(lines.map(ThreadRows.id(of:))) }

    /// Whether the owner has the fold open: any line of the run is in `opened`.
    func isOpen(in opened: Set<String>) -> Bool { !ids.isDisjoint(with: opened) }

    /// `opened` after a click on the fold: all of the run's ids out if it was open, all in if it was closed.
    func toggled(_ opened: Set<String>) -> Set<String> { isOpen(in: opened) ? opened.subtracting(ids) : opened.union(ids) }

    /// Whether `line` folds: a finished call of a tool that declares words, which is no task, agent, card of words or preview, and returned no image.
    /// A call that runs, waits for the owner or failed, a background command, an agent, a message card, a call with a preview and a call with images
    /// (drawn as thumbnails under it) keep a row of their own.
    static func holds(_ line: WorkLine, images: [FileInfo]) -> Bool {
        let f = line.fields
        return f.status == .complete && f.fold != nil && !f.task && f.agent == nil && !f.message && f.preview == nil && images.isEmpty
    }
}

enum ThreadRows {
    /// The id of the row a line's head is drawn in: what the thread's scroll position names to bring it into view.
    static func id(of line: WorkLine) -> String { "l\(line.position)" }

    /// The rows of `thread`, in order: a line with a diff or a body of code is its head then its body rows. A bot's reply has one head, over the first
    /// thing it draws, a call or a text. A work's end is no row: it closes its turn, and its length goes to the head of the bot's reply of that turn. `isSystem` says a message is the daemon's own line.
    static func build(_ thread: MessageThread, isSystem: (Message) -> Bool) -> [ThreadRow] {
        var rows: [ThreadRow] = []
        // The head the next row may join: the last one drawn, which a call, a card or a system event of the bot's reply leaves in place, so
        // that a reply has one head (#166), and which any other head-less row (a counted group of unreadable messages) drops; and the bot's
        // last head since the previous work's end.
        var above: Grouping.Head?
        var turnHead: Int?
        func add(_ id: String, _ content: ThreadRow.Content, time: Date?, head: Grouping.Head? = nil) {
            var row = ThreadRow(id: id, content: content, time: time, head: head, joins: head.map { Grouping.joins(above, $0) } ?? false)
            row.afterCall = rows.last?.endsCall ?? false
            rows.append(row)
            if head != nil || above?.author != thread.bot { above = head }
            // A person's words close the turn the bot's last head opened: a length after them is the next turn's.
            if let head, head.author != thread.bot { turnHead = nil } else if rows[rows.count - 1].showsHead, head?.author == thread.bot { turnHead = rows.count - 1 }
        }
        // The finished calls in a row: one fold, put where they end (a text, a card, a work's end, a call that keeps its row).
        var run: [WorkLine] = []
        func flush() {
            guard let first = run.first else { return }
            let opens = turnHead == nil && first.ref.device == thread.bot
            add(id(of: first), .fold(CallFold(lines: run)), time: first.time, head: opens ? Grouping.Head(author: first.ref.device, time: first.time) : nil)
            run = []
        }
        for entry in thread.entries {
            if case .item(.line(let l)) = entry, CallFold.holds(l, images: thread.images[l.ref] ?? []) {
                run.append(l)
                continue
            }
            flush()
            switch entry {
            case .unreadable(let count, let first):
                add("u\(first.position)", .unreadable(count: count, first: first), time: first.time, head: count == 1 ? Grouping.Head(author: first.sender, time: first.time) : nil)
                // A counted group is drawn between the bot's texts: the next one is not the first one's continuation across other messages.
                if count > 1 { above = nil }
            case .item(.message(let m)):
                if thread.isFooter(m) {
                    if let i = turnHead, rows[i].duration == nil, case .footer(let duration?, _, _)? = m.sessionText { rows[i].duration = duration }
                    // The next answer of the bot opens a head; a person's message under the person's own stays grouped.
                    if above?.author == thread.bot { above = nil }
                    turnHead = nil
                    continue
                }
                // A scheduled run opens a turn, as a work's end closes one: a stopped turn writes no footer, and the run's own calls and texts
                // must not join the reply before it nor hand it their length.
                if thread.isRunLine(m) {
                    if above?.author == thread.bot { above = nil }
                    turnHead = nil
                }
                // A person's message and a bot's text are heads; the daemon's own line, a run line and a request are drawn without one.
                var drawsHead = !thread.isRunLine(m) && !isSystem(m)
                if case .request = m.body { drawsHead = false }
                add("m\(m.position)", .message(m), time: m.time, head: drawsHead ? Grouping.Head(author: m.sender, time: m.time) : nil)
            case .item(.answer(let a)): add("a\(a.position)", .segment(a), time: a.time, head: Grouping.Head(author: a.ref.device, time: a.time))
            case .item(.line(let l)):
                // A call that opens the bot's reply carries the bot's head, so that it does not read as part of the prompt above (#136).
                let opens = turnHead == nil && l.ref.device == thread.bot
                add(id(of: l), .line(l), time: l.time, head: opens ? Grouping.Head(author: l.ref.device, time: l.time) : nil)
                if let preview = l.fields.preview, !preview.record {
                    for index in preview.rows.indices { add("l\(l.position).\(index)", .body(l, index: index), time: nil) }
                }
            }
        }
        flush()
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
        // The row is 12.5 point muted text, the verb alone in semibold, the path or command after it in monospace (visual pass #174, 2; the reading pass).
        let title = HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verbatim: parts.verb).font(PardnerFont.ui(size: PardnerFont.toolSize, weight: .semibold)).foregroundStyle(PardnerColor.muted).lineLimit(1).truncationMode(.middle)
            if let subject = parts.subject {
                Text(verbatim: subject).font(PardnerFont.mono(size: PardnerFont.toolSize, weight: .regular)).foregroundStyle(PardnerColor.muted).lineLimit(1).truncationMode(.middle)
            }
        }
        let words = Self.headWords(f, form).map {
            Text(verbatim: $0).font(PardnerFont.ui(size: PardnerFont.toolSize, weight: .regular)).foregroundStyle(PardnerColor.muted).lineLimit(1).truncationMode(.tail)
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
    nonisolated static let stopped = "Stopped"

    /// Whether `output` is a stop's: the owner's (`Stopped`) or a restart's (`Stopped: the bot restarted`). A call's own output that begins with the word
    /// (`Stopped waiting for lock`) is not. The mark and the end words both ask it, so that they agree.
    nonisolated static func isStop(_ output: String?) -> Bool { output == stopped || (output ?? "").hasPrefix(stopped + ":") }

    /// The mark before a head.
    enum Mark: Equatable { case failed, stopped, call }

    /// A failed call's triangle in red, a stopped one's square in muted, else the generic call symbol in muted.
    nonisolated static func mark(of f: LineFields) -> Mark {
        guard f.status == .error else { return .call }
        return isStop(f.output) ? .stopped : .failed
    }

    @ViewBuilder private func icon(_ f: LineFields) -> some View {
        switch Self.mark(of: f) {
        case .failed:
            Image(systemName: "exclamationmark.triangle").font(.system(size: 12)).foregroundStyle(PardnerColor.delText).frame(width: 14).accessibilityLabel("Failed")
        case .stopped:
            Image(systemName: "stop.fill").font(.system(size: 11)).foregroundStyle(PardnerColor.muted).frame(width: 14).accessibilityLabel("Stopped")
        case .call:
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

    /// How a background command's closed line ends, in the words the app owns (#166): `✓ Done · 5m 00s` or `× Failed · 5m 00s`, timed from the line's start to the
    /// edit that closed it, and with no time when the line has no start. nil for every other line: a call, an agent, a card of words, one the owner stopped or a restart closed (`Stopped` and `Stopped: the bot restarted`).
    nonisolated static func endWords(of line: WorkLine) -> (text: String, failed: Bool)? {
        let f = line.fields
        guard f.task, f.agent == nil, !f.message, f.status == .complete || f.status == .error, !isStop(f.output) else { return nil }
        let failed = f.status == .error
        let words = failed ? "× Failed" : "✓ Done"
        guard let start = f.startedAt, let end = line.ended else { return (words, failed) }
        return ("\(words) · \(Naming.elapsed(end.timeIntervalSince(start)))", failed)
    }

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
        // The call has not run, its card waits for the owner (#137): the words of the card's fallback and of the channel's pill, in their colour.
        case .waiting: Text("Waiting for you").font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.agentText)
        case .written:
            if let end = Self.endWords(of: line) {
                Text(verbatim: end.text).font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(end.failed ? PardnerColor.delText : PardnerColor.okText)
            }
        }
    }
}

/// One row of a preview's body, in the monospace font, invisible code points written as their numbers (#73, 2.5).
struct LineBodyRow: View {
    let line: WorkLine
    let index: Int
    var indent: CGFloat = MessageRow.Mark.thread.size + MessageRow.Mark.thread.gap
    /// The spacing of the stack the row stands in, which it takes back: the first row stands `headGap` under its head, each later one right under the row
    /// above, so that the preview reads as one block (#142). nil for a row in no stack.
    var stack: CGFloat?

    /// How far under its head the first row of a body stands.
    static let headGap: CGFloat = 2

    /// The first row's offset in a stack of `spacing`, so that it stands `headGap` under the head above it.
    static func top(underStackOf spacing: CGFloat) -> CGFloat { headGap - spacing }

    /// A later row's offset in a stack of `spacing`: none of the spacing stays between it and the row above.
    static func top(continuingStackOf spacing: CGFloat) -> CGFloat { -spacing }

    private var top: CGFloat {
        guard let stack else { return 0 }
        return index == 0 ? Self.top(underStackOf: stack) : Self.top(continuingStackOf: stack)
    }

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
            .padding(.top, top)
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
