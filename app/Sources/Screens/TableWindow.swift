// The window a wide table opens in (wide-table preview, 2026-11-27): the whole table, drawn as the pane draws a table that fits, at its natural
// widths, scrolling with the system's bars past the screen. A real window closed by its controls, never a sheet (app windows design).
import AppKit
import Conversation
import DesignSystem
import SwiftUI

/// What a table's window shows: the text the table is a piece of and its place among that text's pieces, as the window was opened (the table as it was
/// then); the window reads the whole table from them, links and all. `size` is the pane's size for a table's cells (a system event's is 13): the cells
/// set their own colours, so the size is all the window needs to draw the table as the pane does.
public struct TableContent: Codable, Hashable, Sendable {
    let text: String
    let piece: Int
    var size: CGFloat = 14

    /// The table and the addresses of its links, nil where `piece` is no table of `text`.
    @MainActor private var read: (table: MarkdownBlocks.Table, links: [URL])? {
        guard case .read(let pieces, let links) = MarkdownBlocks.read(text), pieces.indices.contains(piece), case .table(let table) = pieces[piece].body else { return nil }
        return (table, links)
    }

    /// The table, nil where `piece` is no table of `text`.
    @MainActor var table: MarkdownBlocks.Table? { read?.table }

    /// The first three header cells, or "Table".
    @MainActor var title: String {
        let cells = (table?.rows.first ?? []).prefix(3).map { String($0.characters) }.filter { !$0.isEmpty }
        return cells.isEmpty ? "Table" : cells.joined(separator: ", ")
    }

    /// The table as Markdown, rebuilt from its cells (the reading keeps no range of the source): a code span in backticks, a link as `[text](address)`, the
    /// punctuation Markdown reads escaped. Emphasis and strikethrough are not written back.
    @MainActor var markdown: String {
        guard let (table, links) = read else { return "" }
        let lines = table.rows.map { row in "| " + row.map { Self.source(of: $0, links: links) }.joined(separator: " | ") + " |" }
        return ([lines[0], "|" + String(repeating: "---|", count: table.columns)] + lines.dropFirst()).joined(separator: "\n")
    }

    /// A cell as it is written in a table row: a pipe is escaped, a line break is a space.
    private static func source(of cell: AttributedString, links: [URL]) -> String {
        var out = ""
        for run in cell.runs {
            let text = String(cell[run.range].characters).replacingOccurrences(of: "\n", with: " ")
            var piece = run.font != nil ? code(text) : escaped(text)
            let scheme = "pardner-link:"
            if let link = run.link?.absoluteString, link.hasPrefix(scheme), let n = Int(link.dropFirst(scheme.count)), links.indices.contains(n) {
                let address = links[n].absoluteString.replacingOccurrences(of: "(", with: "%28").replacingOccurrences(of: ")", with: "%29")
                piece = "[\(piece)](\(address))"
            }
            out += piece
        }
        return out.replacingOccurrences(of: "|", with: "\\|")
    }

    private static func escaped(_ text: String) -> String {
        var out = ""
        for character in text {
            if "\\`*_[]<>~".contains(character) { out.append("\\") }
            out.append(character)
        }
        return out
    }

    /// A code span: its fence one backtick longer than the longest run inside, padded where the text begins or ends with a backtick.
    private static func code(_ text: String) -> String {
        var longest = 0, run = 0
        for character in text {
            run = character == "`" ? run + 1 : 0
            longest = max(longest, run)
        }
        let fence = String(repeating: "`", count: longest + 1)
        let pad = text.hasPrefix("`") || text.hasSuffix("`") ? " " : ""
        return fence + pad + text + pad + fence
    }
}

public struct TableWindow: View {
    let content: TableContent?
    @Environment(\.dismiss) private var dismiss

    public init(content: TableContent?) { self.content = content }

    /// What of the screen the table may take: its visible frame less the title bar and the Copy row.
    private static var room: CGSize {
        let frame = NSScreen.main?.visibleFrame.size ?? CGSize(width: 1440, height: 900)
        return CGSize(width: frame.width, height: frame.height - 80)
    }

    public var body: some View {
        if let content, content.table != nil {
            VStack(spacing: 0) {
                ScrollView([.horizontal, .vertical]) {
                    MarkdownView(text: content.text, size: content.size, only: content.piece).textSelection(.enabled).padding(PardnerMetrics.gap * 2)
                }
                .frame(maxWidth: Self.room.width, maxHeight: Self.room.height)
                Divider()
                HStack {
                    Spacer()
                    Button("Copy") { Clipboard.copy(content.markdown) }.clickable()
                }
                .padding(PardnerMetrics.gap)
            }
            .background(PardnerColor.bg)
            .background(Button("", action: { dismiss() }).keyboardShortcut(.cancelAction).opacity(0).frame(width: 0, height: 0).accessibilityHidden(true))
            .navigationTitle(content.title)
            .windowMinimizeBehavior(.disabled)
        } else {
            // A restored or stray window is not left empty (as `ReplyWindow`).
            Color.clear.onAppear { dismiss() }
        }
    }
}
