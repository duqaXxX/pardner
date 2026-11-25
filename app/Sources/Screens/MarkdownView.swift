// Draws a bot's text: as `CodeSpans.styled` draws a text the bounds refuse, else one row per piece of `MarkdownBlocks` in a
// flat stack, never a view nested per level (#73, step B2, design 2.3). A kept link carries `pardner-link:<n>`, so the only way to
// an address is this view's own `OpenURLAction`, which asks before anything opens (2.4).
import AppKit
import Conversation
import DesignSystem
import SwiftUI

/// What the confirm of a link shows (2.4): the address, then its host on its own line.
struct LinkConfirmation: Equatable {
    let url: URL
    let message: String

    /// The confirmation for a `pardner-link:<n>` url, or nil when it is another url or `n` names no link of the text.
    init?(_ url: URL, links: [URL]) {
        let scheme = "pardner-link:"
        guard url.absoluteString.hasPrefix(scheme), let n = Int(url.absoluteString.dropFirst(scheme.count)), links.indices.contains(n)
        else { return nil }
        let real = links[n]
        self.url = real
        message = "\(real.absoluteString)\nHost: \(real.host(percentEncoded: false)?.lowercased() ?? "")"
    }
}

extension MarkdownView {
    /// Whether a bot's message is read: a text (kind 1) alone; a request or another body keeps its code spans only.
    static func reads(_ body: Conversation.Body) -> Bool {
        if case .text = body { return true }
        return false
    }
}

/// The fonts of a piece's runs. Inter is a variable font built from a `CTFont`: SwiftUI derives neither its bold nor its italic
/// from an inline intent, so each run carries the face its intent asks for.
enum MarkdownFonts {
    /// `text` with a font on every run that has none: the base `size` and `weight`, strong one step heavier (semibold, or bold on
    /// a semibold base), emphasized in the italic file. A strikethrough is set as a style, so it never depends on the intent.
    static func styled(_ text: AttributedString, size: CGFloat, weight: InterWeight) -> AttributedString {
        var out = text
        for run in text.runs where run.font == nil {
            let intent = run.inlinePresentationIntent ?? []
            let heavier: InterWeight = weight == .regular ? .semibold : .bold
            out[run.range].font = PardnerFont.ui(
                size: size, weight: intent.contains(.stronglyEmphasized) ? heavier : weight, italic: intent.contains(.emphasized))
            if intent.contains(.strikethrough) { out[run.range].strikethroughStyle = .single }
        }
        return out
    }
}

struct MarkdownView: View {
    let text: String
    /// What the row's `Copy` does; a piece with a link offers it as its own menu (design 2.7).
    var copy: (() -> Void)?

    @State private var confirming: LinkConfirmation?
    /// One list step, and one quote bar with its gap.
    private static let step: CGFloat = 22
    private static let barWidth: CGFloat = 3
    private static let barGap: CGFloat = 10

    var body: some View {
        content
            .environment(\.openURL, OpenURLAction { url in
                open(url)
                return .handled
            })
            .tint(Color(nsColor: .linkColor))
            .alert("Open this link?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), presenting: confirming) { link in
                Button("Open") { NSWorkspace.shared.open(link.url) }
                Button("Cancel", role: .cancel) {}
            } message: { link in
                Text(verbatim: link.message)
            }
    }

    @ViewBuilder private var content: some View {
        if case .read(let pieces, _) = MarkdownBlocks.read(text) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(pieces.indices, id: \.self) { row(pieces[$0], gaps: Self.gaps(from: $0 > 0 ? pieces[$0 - 1] : nil, to: pieces[$0])) }
            }
        } else {
            Text(CodeSpans.styled(text)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The space above piece `b` after piece `a`, the first rule that holds (FA 3.4): before a heading 20, after one 8, between two list items
    /// 4 (a code block or a table among them stands apart), any other pair 12.
    static func gap(from a: MarkdownBlocks.Piece, to b: MarkdownBlocks.Piece) -> CGFloat {
        func isHeading(_ piece: MarkdownBlocks.Piece) -> Bool { if case .heading = piece.body { true } else { false } }
        func isBlock(_ piece: MarkdownBlocks.Piece) -> Bool {
            switch piece.body {
            case .code, .table: true
            default: false
            }
        }
        if isHeading(b) { return 20 }
        if isHeading(a) { return 8 }
        if b.marker != nil, a.depth > a.bars, !isBlock(a), !isBlock(b) { return 4 }
        return 12
    }

    /// The gap as padding: on `b`'s marker and text together, so a marker stays on its text's first line, and on each bar of `b` that `a`
    /// has not (a quote starting at `b`); a bar both have runs through the gap. The first piece has none.
    static func gaps(from a: MarkdownBlocks.Piece?, to b: MarkdownBlocks.Piece) -> (content: CGFloat, bars: [CGFloat]) {
        guard let a else { return (0, [CGFloat](repeating: 0, count: b.bars)) }
        let gap = gap(from: a, to: b)
        return (gap, (0..<b.bars).map { $0 < a.bars ? 0 : gap })
    }

    private func row(_ piece: MarkdownBlocks.Piece, gaps: (content: CGFloat, bars: [CGFloat])) -> some View {
        let lists = max(piece.depth - piece.bars, 0)
        return HStack(alignment: .top, spacing: 0) {
            ForEach(0..<piece.bars, id: \.self) { bar in
                Rectangle().fill(PardnerColor.line).frame(width: Self.barWidth).padding(.top, gaps.bars[bar]).padding(.trailing, Self.barGap)
            }
            if lists > 0 {
                Color.clear.frame(width: CGFloat(lists - 1) * Self.step, height: 0)
                // A marker such as `100.` keeps its width and pushes the text, where a fixed frame would cut it.
                Text(verbatim: piece.marker ?? "").fixedSize().padding(.trailing, 6).frame(minWidth: Self.step, alignment: .leading).padding(.top, gaps.content)
            }
            body(of: piece.body).padding(.top, gaps.content)
        }
    }

    /// A run of inline text: SwiftUI's `Text`, or `LinkText` when it holds a kept link, since only AppKit gives a link the pointing hand (2.4).
    @ViewBuilder private func inline(_ text: AttributedString, size: CGFloat, weight: InterWeight) -> some View {
        if text.runs.contains(where: { $0.link != nil }) {
            LinkText(text: text, size: size, weight: weight, open: { open($0) }, copy: copy)
        } else {
            Text(MarkdownFonts.styled(text, size: size, weight: weight)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Asks before a `pardner-link:<n>` url opens anything: the one path from a link to an address.
    private func open(_ url: URL) {
        if case .read(_, let links) = MarkdownBlocks.read(text) { confirming = LinkConfirmation(url, links: links) }
    }

    private func cell(_ table: MarkdownBlocks.Table, _ row: Int, _ column: Int) -> some View {
        inline(table.rows[row][column], size: 14, weight: row == 0 ? .semibold : .regular)
    }

    @ViewBuilder private func body(of body: MarkdownBlocks.Body) -> some View {
        switch body {
        case .paragraph(let text):
            inline(text, size: 14, weight: .regular)
        case .heading(let level, let text):
            inline(text, size: level == 1 ? 18 : level == 2 ? 16 : 14, weight: .semibold)
        case .code(let language, let code):
            CodeBlock(language: language, code: code)
        case .table(let table):
            // The table takes the column's width, its cells wrapping; a column that would fall under its floor sends it to the sideways scroll.
            ViewThatFits(in: .horizontal) {
                TableFit(columns: table.columns) {
                    ForEach(table.rows.indices, id: \.self) { r in
                        ForEach(0..<table.columns, id: \.self) { c in cell(table, r, c) }
                        if r < table.rows.count - 1 { Rectangle().fill(PardnerColor.line).frame(height: 1) }
                    }
                }
                ScrollView(.horizontal) {
                    Grid(alignment: .leading, horizontalSpacing: TableFit.spacing, verticalSpacing: TableFit.rowSpacing) {
                        ForEach(table.rows.indices, id: \.self) { r in
                            if r > 0 { Rectangle().fill(PardnerColor.line).frame(height: 1) }
                            GridRow {
                                ForEach(0..<table.columns, id: \.self) { c in cell(table, r, c) }
                            }
                        }
                    }
                }
            }
        case .rule:
            Rectangle().fill(PardnerColor.line).frame(height: 1).frame(maxWidth: .infinity)
        }
    }
}

/// A fenced block: a strip with its language and a button that copies the block, over the text wrapping at the box's width, a continuation
/// starting at the box's left edge (FA 3.2). The copy is the text as drawn, `[U+XXXX]` for an invisible character, as a selection of it.
struct CodeBlock: View {
    let language: String?
    let code: String
    var copy: (String) -> Void = { Clipboard.copy($0) }

    /// What the strip's button does: copies the block's text as drawn, never its wrapped lines.
    func copyCode() { copy(code) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 0) {
                if let language {
                    Text(verbatim: language).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
                Button { copyCode() } label: {
                    Image(systemName: "doc.on.doc").font(.system(size: 12)).foregroundStyle(PardnerColor.muted).frame(width: 20, height: 20).contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerStyle(.link).help("Copy code").accessibilityLabel("Copy code")
            }
            .frame(height: 20)
            Text(verbatim: code).font(PardnerFont.mono(size: 12.5, weight: .regular)).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(PardnerColor.raised, in: RoundedRectangle(cornerRadius: 6))
    }
}

/// A table's cells in row-major order, one rule after every row but the last, laid out in the width it is given (FA 3.3): its ideal width
/// is its columns' floors, so `ViewThatFits` keeps it while the floors fit; given the natural widths it keeps them, given less it shares the
/// width by natural width, a column held at its floor.
struct TableFit: Layout {
    let columns: Int
    static let spacing: CGFloat = 16
    static let rowSpacing: CGFloat = 6
    /// About 12 characters of Inter 14.
    static let floorWidth: CGFloat = 90

    /// Each column's natural width (its widest cell unwrapped) and floor (the lesser of that and `floorWidth`), measured once per set of cells.
    struct Cache {
        var natural: [CGFloat] = []
        var floors: [CGFloat] = []
    }

    private func isRule(_ index: Int) -> Bool { index % (columns + 1) == columns }

    func makeCache(subviews: Subviews) -> Cache {
        var natural = [CGFloat](repeating: 0, count: columns)
        for (i, subview) in subviews.enumerated() where !isRule(i) {
            natural[i % (columns + 1)] = max(natural[i % (columns + 1)], subview.sizeThatFits(.unspecified).width)
        }
        return Cache(natural: natural, floors: natural.map { min($0, Self.floorWidth) })
    }

    /// The width of `widths` side by side with the gaps between them: the ideal width when they are the floors.
    static func extent(of widths: [CGFloat]) -> CGFloat { widths.reduce(0, +) + spacing * CGFloat(max(widths.count - 1, 0)) }

    /// The columns' widths in `width` (nil: the ideal, the floors). The natural widths when they fit; else each in proportion to its natural
    /// width, a column that would fall under its floor held there and the rest shared again.
    static func widths(natural: [CGFloat], floors: [CGFloat], in width: CGFloat?) -> [CGFloat] {
        guard let width else { return floors }
        let available = width - spacing * CGFloat(max(natural.count - 1, 0))
        // A half point of slack: `placeSubviews` can be handed bounds a rounding narrower than the width `sizeThatFits` answered.
        if natural.reduce(0, +) <= available + 0.5 { return natural }
        var fitted = natural
        var held = [Bool](repeating: false, count: natural.count)
        var remaining = max(available, 0)
        for _ in natural.indices {
            let free = natural.indices.filter { !held[$0] }
            let sum = free.reduce(0) { $0 + natural[$1] }
            guard sum > 0 else { break }
            for i in free { fitted[i] = remaining * natural[i] / sum }
            let under = free.filter { fitted[$0] < floors[$0] }
            if under.isEmpty { break }
            for i in under {
                fitted[i] = floors[i]
                held[i] = true
                remaining = max(remaining - floors[i], 0)
            }
        }
        return fitted
    }

    private func rowHeights(_ subviews: Subviews, _ widths: [CGFloat]) -> [CGFloat] {
        (0..<(subviews.count + 1) / (columns + 1)).map { r in
            (0..<columns).map { c in subviews[r * (columns + 1) + c].sizeThatFits(ProposedViewSize(width: widths[c], height: nil)).height }.max() ?? 0
        }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        let widths = Self.widths(natural: cache.natural, floors: cache.floors, in: proposal.width)
        let heights = rowHeights(subviews, widths)
        // A row, the space under it, its rule, and the space under the rule.
        let total = heights.reduce(0, +) + CGFloat(max(heights.count - 1, 0)) * (2 * Self.rowSpacing + 1)
        return CGSize(width: Self.extent(of: widths), height: total)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        let widths = Self.widths(natural: cache.natural, floors: cache.floors, in: bounds.width)
        let heights = rowHeights(subviews, widths)
        let total = Self.extent(of: widths)
        var y = bounds.minY
        for (r, height) in heights.enumerated() {
            var x = bounds.minX
            for c in 0..<columns {
                subviews[r * (columns + 1) + c].place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(width: widths[c], height: nil))
                x += widths[c] + Self.spacing
            }
            y += height + Self.rowSpacing
            if r < heights.count - 1 {
                subviews[r * (columns + 1) + columns].place(at: CGPoint(x: bounds.minX, y: y), anchor: .topLeading, proposal: ProposedViewSize(width: total, height: 1))
                y += 1 + Self.rowSpacing
            }
        }
    }
}
