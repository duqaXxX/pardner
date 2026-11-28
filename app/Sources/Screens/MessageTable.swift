// A table in the message's text view (#194, design 10.7): the attachment's view provider hosts the shared `TableCard`, measures it at the line's width,
// and the card shows the selection over it. The card and its measuring root are outside the row's SwiftUI hierarchy, so what the row sets around it that
// the card reads (line spacing, text selection, tint) is applied to both roots here.
import AppKit
import DesignSystem
import SwiftUI

/// Whether the selection covers a table, and whether the text view shows it as the key window's: what the card draws its overlay from.
final class TableSelection: ObservableObject {
    @Published var selected = false
    @Published var emphasized = false
}

/// What a table's card needs of the row around the text view.
struct TableEnvironment {
    /// The row's line spacing (`.designLines()`), which every cell's text reads.
    var lineSpacing: CGFloat = 0
    var size: CGFloat = 14
    var codeGround = PardnerColor.codeInline
    var open: (URL) -> Void = { _ in }
    /// Opens the window of the table at a piece index: a closure of `MarkdownView`, since the hosted card has no `openWindow` of its own (F9).
    var openTable: (Int) -> Void = { _ in }
    /// The row's `Copy as Markdown`, which a link in a cell offers in its menu.
    var copy: (() -> Void)?
}

/// The card with the values it reads from the row, applied the same to the root that is measured and the root that is hosted, and a selection-coloured
/// overlay over it that takes no click: the hosted view lies above the text view's own selection, which cannot show through it (design R4). Its size is the
/// card's own, so that the hosted view takes no press and shows no cursor in the empty area right of a narrow card (measured offscreen, #194 H6: a view the
/// width of the line took the hit test there).
private struct HostedTable: View {
    let table: MarkdownBlocks.Table
    let piece: Int
    var environment: TableEnvironment
    @ObservedObject var selection: TableSelection

    var body: some View {
        TableCard(table: table, size: environment.size, codeGround: environment.codeGround, openWindow: { environment.openTable(piece) }, open: environment.open, copy: environment.copy, copyTitle: "Copy as Markdown")
            .lineSpacing(environment.lineSpacing)
            .textSelection(.enabled)
            // `MarkdownView`'s own tint.
            .tint(PardnerColor.brandText)
            .overlay {
                if selection.selected {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color(nsColor: selection.emphasized ? .selectedTextBackgroundColor : .unemphasizedSelectedTextBackgroundColor).opacity(0.5))
                        .allowsHitTesting(false)
                }
            }
    }
}

extension TableAttachment {
    override func viewProvider(for parentView: NSView?, location: any NSTextLocation, textContainer: NSTextContainer?) -> NSTextAttachmentViewProvider? {
        TableViewProvider(textAttachment: self, parentView: parentView, textLayoutManager: textContainer?.textLayoutManager, location: location)
    }
}

/// Hosts the table's card. The text system does not size a hosted view, so the provider answers `attachmentBounds` itself: the card's own size at the width
/// the line leaves from where the attachment stands (measured, R2d). The attachment must not override that method, or the provider is never loaded (R2c).
final class TableViewProvider: NSTextAttachmentViewProvider {
    override init(textAttachment: NSTextAttachment, parentView: NSView?, textLayoutManager: NSTextLayoutManager?, location: any NSTextLocation) {
        super.init(textAttachment: textAttachment, parentView: parentView, textLayoutManager: textLayoutManager, location: location)
        tracksTextAttachmentViewBounds = true
    }

    @MainActor private var root: HostedTable? {
        guard let table = textAttachment as? TableAttachment else { return nil }
        let environment = (textLayoutManager?.textContainer?.textView as? MessageTextView)?.tableEnvironment ?? TableEnvironment()
        return HostedTable(table: table.table, piece: table.piece, environment: environment, selection: table.selection)
    }

    // The text system calls both on the main thread, where `self` is only used; the SDK declares them nonisolated.
    override func loadView() {
        nonisolated(unsafe) let provider = self
        view = MainActor.assumeIsolated { provider.root.map { NSHostingView(rootView: $0) } ?? NSView() }
    }

    override func attachmentBounds(for attributes: [NSAttributedString.Key: Any], location: any NSTextLocation, textContainer: NSTextContainer?, proposedLineFragment: CGRect, position: CGPoint) -> CGRect {
        nonisolated(unsafe) let provider = self
        let descent = (attributes[.font] as? NSFont)?.descender ?? 0
        return MainActor.assumeIsolated {
            guard let root = provider.root else { return .zero }
            // A table in a list item or a quote stands at the paragraph's indent (`position.x`), which the fragment's width does not leave out.
            let size = NSHostingController(rootView: root).sizeThatFits(in: CGSize(width: proposedLineFragment.width - position.x, height: .greatestFiniteMagnitude))
            return CGRect(x: 0, y: descent, width: size.width, height: size.height)
        }
    }
}

extension MessageTextView {
    /// The cards that are loaded read the environment they were made with, so each takes the new one; a card's height depends on the line spacing and the
    /// size, so the layout is invalidated when either changed.
    func tableEnvironmentChanged(from old: TableEnvironment) {
        for hosted in hostedTables(in: self) { hosted.rootView.environment = tableEnvironment }
        if old.lineSpacing != tableEnvironment.lineSpacing || old.size != tableEnvironment.size, let layout = textLayoutManager {
            layout.invalidateLayout(for: layout.documentRange)
            needsLayout = true
        }
    }

    private func hostedTables(in view: NSView) -> [NSHostingView<HostedTable>] {
        view.subviews.flatMap { ($0 as? NSHostingView<HostedTable>).map { [$0] } ?? hostedTables(in: $0) }
    }
}
