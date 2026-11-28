// The card a Markdown table is drawn as, shared by every place that draws one: the block path of `MarkdownView` and, in unit 3b, the text view's hosted
// attachment. It reads the line spacing, text selection and tint from its environment, so a host outside the row sets them (design 10.7); links open
// through the `open` closure it is given.
import DesignSystem
import SwiftUI

/// The table takes the column's width, its cells wrapping; a column that would fall under its floor makes it a preview (the columns that fit, a fade and a
/// footer, and a click opens the whole table in a window of its own). A card on `container` with a hairline border and a faint ground behind the header
/// row, a column of numbers aligned right. The table's own window (`whole`) draws it whole at its natural widths.
struct TableCard: View {
    let table: MarkdownBlocks.Table
    /// The size of a paragraph, from which a body cell's is one point less.
    let size: CGFloat
    /// The ground of an inline code span in a cell, as `MarkdownView.codeGround`.
    var codeGround = PardnerColor.codeInline
    /// Whether to draw it whole at its natural widths (the table's window), not fitted to the column's width.
    var whole = false
    /// What a click on a preview does: opens the table's window.
    let openWindow: () -> Void
    /// What a link in a fitted cell does, and the row's `Copy` a link offers as a menu.
    let open: (URL) -> Void
    var copy: (() -> Void)?
    /// The title of that menu item (`LinkText.copyTitle`).
    var copyTitle = "Copy"

    /// The room at each side of a table's cells, inside its card.
    static let pad: CGFloat = 12

    var body: some View {
        let numeric = (0..<table.columns).map { table.isNumeric(column: $0) }
        Group {
            if whole {
                grid(numeric, mode: .whole)
            } else {
                ViewThatFits(in: .horizontal) {
                    grid(numeric, mode: .fitted)
                    // The whole card is the button: the cells take no hit and no selection and draw no AppKit view, so a click anywhere on it opens the window.
                    Button(action: openWindow) {
                        grid(numeric, mode: .preview).allowsHitTesting(false).textSelection(.disabled).mask {
                            HStack(spacing: 0) {
                                Rectangle()
                                LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: TableFit.fade)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.clickable).accessibilityHint("Opens the whole table in a window")
                }
            }
        }
        .background(PardnerColor.container, in: RoundedRectangle(cornerRadius: 8))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(PardnerColor.line))
    }

    private func grid(_ numeric: [Bool], mode: TableFit.Mode) -> some View {
        TableFit(columns: table.columns, numeric: numeric, bleed: Self.pad, mode: mode) {
            // The header's ground, the first child: drawn under the cells and across the card's padding.
            PardnerColor.tableHead
            ForEach(table.rows.indices, id: \.self) { r in
                ForEach(0..<table.columns, id: \.self) { c in cell(r, c, tabular: numeric[c], inert: mode == .preview) }
                if r < table.rows.count - 1 { Rectangle().fill(PardnerColor.line).frame(height: 1) }
            }
            // A preview's footer for each count of columns it may leave out: the layout places the one that is true.
            if mode == .preview {
                ForEach(0..<table.columns, id: \.self) { hidden in
                    Text(verbatim: TableFit.footer(hidden: hidden)).font(PardnerFont.ui(size: PardnerFont.toolSize, weight: .regular)).foregroundStyle(PardnerColor.muted)
                }
            }
        }
        .padding(.horizontal, Self.pad)
    }

    /// A cell: the header row small, semibold and grey, a body row at one point under the text; a code span keeps its monospace face but not its ground (#174).
    /// A cell of a column of numbers sets its digits at one width, so that the figures line up under each other.
    private func cell(_ row: Int, _ column: Int, tabular: Bool, inert: Bool) -> some View {
        var text = table.rows[row][column]
        for run in text.runs where run.backgroundColor != nil { text[run.range].backgroundColor = nil }
        // A code span of the header is as small as the header's words.
        if row == 0 { for run in text.runs where run.font != nil { text[run.range].font = PardnerFont.mono(size: 12, weight: .regular) } }
        return MarkdownView.inline(text, size: row == 0 ? 12 : size - 1, weight: row == 0 ? .semibold : .regular, color: row == 0 ? PardnerColor.muted : PardnerColor.text,
                                   codeSize: row == 0 ? 12 : 12.5, tabular: tabular, inert: inert, ground: codeGround, open: open, copy: copy, copyTitle: copyTitle)
            .foregroundStyle(row == 0 ? PardnerColor.muted : PardnerColor.text)
    }
}
