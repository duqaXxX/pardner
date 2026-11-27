// The window a wide table opens in (wide-table preview, 2026-11-27): the whole table, drawn as the pane draws a table that fits, at its natural
// widths, scrolling with the system's bars past the screen. A real window closed by its controls, never a sheet (app windows design).
import AppKit
import Conversation
import DesignSystem
import SwiftUI

/// What a table's window shows: the text the table is a piece of and its place among that text's pieces, as the window was opened (the table as it
/// was then); the window reads the whole table from them, links and all.
public struct TableContent: Codable, Hashable, Sendable {
    let text: String
    let piece: Int

    /// The table, nil where `piece` is no table of `text`.
    @MainActor var table: MarkdownBlocks.Table? {
        guard case .read(let pieces, _) = MarkdownBlocks.read(text), pieces.indices.contains(piece), case .table(let table) = pieces[piece].body else { return nil }
        return table
    }

    /// The first three header cells, or "Table".
    @MainActor var title: String {
        let cells = (table?.rows.first ?? []).prefix(3).map { String($0.characters) }.filter { !$0.isEmpty }
        return cells.isEmpty ? "Table" : cells.joined(separator: ", ")
    }

    /// The table as Markdown, the cells as plain text.
    @MainActor var markdown: String {
        guard let table else { return "" }
        let lines = table.rows.map { row in
            "| " + row.map { String($0.characters).replacingOccurrences(of: "|", with: "\\|").replacingOccurrences(of: "\n", with: " ") }.joined(separator: " | ") + " |"
        }
        return ([lines[0], "|" + String(repeating: "---|", count: table.columns)] + lines.dropFirst()).joined(separator: "\n")
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
                    MarkdownView(text: content.text, only: content.piece).textSelection(.enabled).padding(PardnerMetrics.gap * 2)
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
