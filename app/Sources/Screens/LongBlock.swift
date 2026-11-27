// The one rule for a long block of the thread (long block rule, 2026-11-27): a call's preview body and a fenced code block of a message up to
// `wholeLines` lines are drawn whole; a longer one shows its first `shownLines` lines and a footer, `Show all N lines`, which opens it in place.
import Conversation
import DesignSystem
import Observation
import SwiftUI

/// Which long blocks the owner has opened, in memory for the app's run: a restart draws every block closed. A key names a block by what stays
/// the same while it is written (`LongBlock.key`), so a diff that grows keeps its state.
@MainActor @Observable
final class OpenBlocks {
    static let shared = OpenBlocks()

    private(set) var keys: Set<String> = []

    func isOpen(_ key: String) -> Bool { keys.contains(key) }

    func toggle(_ key: String) {
        if keys.contains(key) { keys.remove(key) } else { keys.insert(key) }
    }
}

enum LongBlock {
    /// A block of up to this many lines is drawn whole: about what the thread shows of a call before it reads as a wall.
    static let wholeLines = 30
    /// A longer block shows this many lines closed, six under `wholeLines` so that the cut is plainly a cut and the footer is not under a few lines.
    static let shownLines = 24

    /// The lines of `text`: split on "\n" alone (a line may end in "\r"), a final line end opening none.
    static func count(of text: String) -> Int {
        let n = text.components(separatedBy: "\n").count
        return text.hasSuffix("\n") && n > 1 ? n - 1 : n
    }

    /// The lines of a preview's body (which is cut in rows of `LinePreview.rowLines`): counted from the body, so that a final line end on a row's edge opens none.
    static func count(of preview: LinePreview) -> Int {
        preview.rows.isEmpty ? 0 : count(of: preview.body)
    }

    static func isLong(_ total: Int) -> Bool { total > wholeLines }

    /// The footer's words for a block of `total` lines: nil when it is drawn whole.
    static func footer(total: Int, open: Bool) -> String? {
        guard isLong(total) else { return nil }
        return open ? "Show less" : "Show all \(total) lines"
    }

    /// How many of a preview's body rows are drawn: all of them, or the first alone while a long body is closed (the rest hold lines it does not show).
    static func rowsDrawn(of preview: LinePreview, open: Bool) -> Int {
        open || !isLong(count(of: preview)) ? preview.rows.count : min(1, preview.rows.count)
    }

    /// The first `shownLines` lines of `text`.
    static func head(of text: String) -> String {
        text.components(separatedBy: "\n").prefix(shownLines).joined(separator: "\n")
    }

    /// A call's preview is named by its line's reference, which an edit of the call keeps.
    static func key(of line: WorkLine) -> String { "call " + line.ref.hex }

    /// The name of an answer's segment, whose blocks are counted from its own first piece: every segment of one answer has the same `ref`.
    static func key(of answer: AnswerGroup) -> String { "\(answer.ref.hex)@\(answer.position)" }

    /// A code block is named by its message (or answer) and its place among the message's pieces.
    static func key(message: String, block: Int) -> String { "\(message)#\(block)" }

    /// The path of the file a call's head links to, which its footer opens too: nil where the head has no such link.
    @MainActor static func file(of line: WorkLine, place: FilePlace?, opener: FileOpener?) -> String? {
        place == nil ? nil : opener?.link(for: line)
    }
}

/// The footer row of a long block: its fold control, and `Open file` beside it where the block is a file.
struct LongBlockFooter: View {
    let label: String
    let toggle: () -> Void
    var openFile: (() -> Void)?

    var body: some View {
        HStack(spacing: 12) {
            Button(action: toggle) { Text(verbatim: label) }.buttonStyle(.clickable)
            if let openFile { Button(action: openFile) { Text(verbatim: "Open file") }.buttonStyle(.clickable) }
        }
        .font(PardnerFont.ui(size: PardnerFont.toolSize, weight: .regular)).foregroundStyle(PardnerColor.muted)
    }
}
