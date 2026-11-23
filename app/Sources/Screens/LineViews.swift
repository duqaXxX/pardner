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
                rows.append(ThreadRow(id: "l\(l.position)", content: .line(l), time: l.time))
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

/// The head of a line: its words by the three forms, and the state the app owns.
struct LineRow: View {
    let line: WorkLine
    /// How the line stands, worked out by the caller so that a change to the thread elsewhere does not draw every row again.
    let state: LineState
    /// What the row is indented by to line up with a bot's text.
    var indent: CGFloat = MessageRow.Mark.thread.size + MessageRow.Mark.thread.gap
    @State private var opened = false

    var body: some View {
        let f = line.fields
        VStack(alignment: .leading, spacing: 2) {
            if let preview = f.preview, preview.record {
                Text(verbatim: preview.body).font(PardnerFont.ui(size: 13, weight: .regular))
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if f.status == .error { Image(systemName: "exclamationmark.triangle").font(.system(size: 12)).foregroundStyle(PardnerColor.delText).accessibilityLabel("Failed") }
                    Text(verbatim: f.preview?.title ?? f.title).font(PardnerFont.ui(size: 13, weight: .semibold))
                    if let words = f.preview?.summary ?? f.details { Text(verbatim: words).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.muted) }
                    stateWords
                }
                if f.preview == nil {
                    if f.message, let output = f.output {
                        Button { opened.toggle() } label: {
                            Label(opened ? "Hide" : "Show", systemImage: opened ? "chevron.down" : "chevron.right").font(PardnerFont.ui(size: 12, weight: .medium))
                        }
                        .buttonStyle(.plain).pointerStyle(.link).foregroundStyle(PardnerColor.muted)
                        if opened {
                            // Whole, in rows of at most 200 lines so that a long reply builds what is on screen (a selection stops at a row's end).
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(Array(Self.messageRows(of: f).enumerated()), id: \.offset) { _, row in
                                    Text(verbatim: row).font(PardnerFont.ui(size: 13, weight: .regular)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                    } else if f.status == .error, let output = f.output {
                        Text(verbatim: Self.bounded(output)).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                    }
                }
            }
        }
        .padding(.leading, indent)
        .frame(maxWidth: .infinity, alignment: .leading)
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

    /// A message line's body in rows of at most 200 lines, as a preview's is: the subagent's whole reply, with no cut. A call's output is no body.
    static func messageRows(of fields: LineFields) -> [String] {
        fields.message ? LinePreview.rows(of: fields.output ?? "") : []
    }

    @ViewBuilder private var stateWords: some View {
        switch state {
        case .running(let since):
            if let since {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(verbatim: "Running · " + Naming.elapsed(context.date.timeIntervalSince(since)))
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

/// One row of a preview's body, in the monospace font.
struct LineBodyRow: View {
    let line: WorkLine
    let index: Int
    var indent: CGFloat = MessageRow.Mark.thread.size + MessageRow.Mark.thread.gap

    var body: some View {
        if let preview = line.fields.preview, preview.rows.indices.contains(index) {
            Text(DiffTint.text(preview.rows[index], diff: preview.language == "diff"))
                .font(PardnerFont.mono(size: 12, weight: .regular)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .padding(.leading, indent).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
