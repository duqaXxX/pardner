// Draws a message's text, a bot's or a person's: as `CodeSpans.styled` draws a text the bounds refuse, else one row per piece of `MarkdownBlocks` in a
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
    /// `tabular` gives the digits one width, as a column of numbers is set.
    static func styled(_ text: AttributedString, size: CGFloat, weight: InterWeight, tabular: Bool = false) -> AttributedString {
        var out = text
        for run in text.runs where run.font == nil {
            let intent = run.inlinePresentationIntent ?? []
            let heavier: InterWeight = weight == .regular ? .semibold : .bold
            out[run.range].font = PardnerFont.ui(
                size: size, weight: intent.contains(.stronglyEmphasized) ? heavier : weight, italic: intent.contains(.emphasized), tabular: tabular)
            if intent.contains(.strikethrough) { out[run.range].strikethroughStyle = .single }
        }
        return out
    }
}

struct MarkdownView: View {
    let text: String
    /// What the row's `Copy` does; a piece with a link offers it as its own menu (design 2.7).
    var copy: (() -> Void)?
    /// The bot's `@name` a person's message opens with: a chip before the first paragraph's text, or on a line of its own when the text opens with
    /// anything else (a heading, a list, a block) or with a link, which AppKit draws and a chip cannot join.
    var mention: String?
    /// The size of a paragraph and of a table's cells; a system event's is smaller than a text's.
    var size: CGFloat = 14
    /// The ground of an inline code span: `surface` on the selected band, where `codeInline` would blend with it (#174, section 8).
    var codeGround = PardnerColor.codeInline
    /// The message or answer the text is of, which names its code blocks for their open state (`LongBlock.key`); nil draws every block whole.
    var foldKey: String?
    var blocks: OpenBlocks = .shared

    @State private var confirming: LinkConfirmation?
    /// One list step (the bullet hangs at its left, the text starts one step in), and one quote bar with the room between it and its text.
    static let listStep = PardnerMetrics.listIndent
    static let barWidth = PardnerMetrics.quoteBar
    static let barGap = PardnerMetrics.quotePad
    /// The room at each side of a table's cells, inside its card.
    private static let tablePad: CGFloat = 12

    var body: some View {
        content
            .environment(\.openURL, OpenURLAction { url in
                open(url)
                return .handled
            })
            .tint(PardnerColor.brandText)
            .alert("Open this link?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), presenting: confirming) { link in
                Button("Open") { NSWorkspace.shared.open(link.url) }
                Button("Cancel", role: .cancel) {}
            } message: { link in
                Text(verbatim: link.message)
            }
    }

    @ViewBuilder private var content: some View {
        // A person's text Markdown reads as no piece (a link reference definition, an HTML comment) is drawn as typed, so that the chip does not stand alone.
        if case .read(let pieces, _) = MarkdownBlocks.read(text), !(pieces.isEmpty && mention != nil) {
            let joined = pieces.first.map(Self.opens) ?? false
            VStack(alignment: .leading, spacing: 0) {
                if let mention, !joined { MentionedText(mention: mention).padding(.bottom, PardnerMetrics.paragraphGap) }
                ForEach(pieces.indices, id: \.self) {
                    row(pieces[$0], gaps: Self.gaps(from: $0 > 0 ? pieces[$0 - 1] : nil, to: pieces[$0]), mention: $0 == 0 && joined ? mention : nil, index: $0)
                }
            }
        } else {
            InlineCodeText(text: CodeSpans.styled(text, ground: codeGround), mention: mention)
        }
    }

    /// Whether a mention can stand in `piece`'s first line: a paragraph at the column holding no link.
    static func opens(_ piece: MarkdownBlocks.Piece) -> Bool {
        guard piece.depth == 0, piece.marker == nil, case .paragraph(let text) = piece.body else { return false }
        return !text.runs.contains { $0.link != nil }
    }

    /// The space above piece `b` after piece `a`, the first rule that holds (FA 3.4, the reading pass): before a heading 16, after one 6, around a code block, a
    /// table and a quote 12, between two list items 4, any other pair 10.
    static func gap(from a: MarkdownBlocks.Piece, to b: MarkdownBlocks.Piece) -> CGFloat {
        func isHeading(_ piece: MarkdownBlocks.Piece) -> Bool { if case .heading = piece.body { true } else { false } }
        func isBlock(_ piece: MarkdownBlocks.Piece) -> Bool {
            switch piece.body {
            case .code, .table: true
            default: false
            }
        }
        if isHeading(b) { return PardnerMetrics.headingBefore }
        if isHeading(a) { return PardnerMetrics.headingAfter }
        // A quote begins where `b` has a bar `a` has not, and ends where `a` has one `b` has not.
        if isBlock(a) || isBlock(b) || a.bars != b.bars { return PardnerMetrics.blockGap }
        if b.marker != nil, a.depth > a.bars { return PardnerMetrics.itemGap }
        return PardnerMetrics.paragraphGap
    }

    /// The gap as padding: on `b`'s marker and text together, so a marker stays on its text's first line, and on each bar of `b` that `a`
    /// has not (a quote starting at `b`); a bar both have runs through the gap. The first piece has none.
    static func gaps(from a: MarkdownBlocks.Piece?, to b: MarkdownBlocks.Piece) -> (content: CGFloat, bars: [CGFloat]) {
        guard let a else { return (0, [CGFloat](repeating: 0, count: b.bars)) }
        let gap = gap(from: a, to: b)
        return (gap, (0..<b.bars).map { $0 < a.bars ? 0 : gap })
    }

    private func row(_ piece: MarkdownBlocks.Piece, gaps: (content: CGFloat, bars: [CGFloat]), mention: String?, index: Int) -> some View {
        let lists = max(piece.depth - piece.bars, 0)
        return HStack(alignment: .top, spacing: 0) {
            ForEach(0..<piece.bars, id: \.self) { bar in
                Rectangle().fill(PardnerColor.line).frame(width: Self.barWidth).padding(.top, gaps.bars[bar]).padding(.trailing, Self.barGap)
            }
            if lists > 0 {
                Color.clear.frame(width: CGFloat(lists - 1) * Self.listStep, height: 0)
                // A marker such as `100.` keeps its width and pushes the text, where a fixed frame would cut it.
                Text(verbatim: piece.marker ?? "").fixedSize().padding(.trailing, 6).frame(minWidth: Self.listStep, alignment: .leading).padding(.top, gaps.content)
            }
            body(of: piece.body, mention: mention, index: index).padding(.top, gaps.content)
        }
    }

    /// A run of inline text: SwiftUI's `Text`, or `LinkText` when it holds a kept link, since only AppKit gives a link the pointing hand (2.4).
    @ViewBuilder private func inline(_ text: AttributedString, size: CGFloat, weight: InterWeight, color: Color = PardnerColor.text, codeSize: CGFloat = 12.5,
                                     tabular: Bool = false, lineSpacing: CGFloat = MessageRow.lineSpacing, mention: String? = nil) -> some View {
        let text = Self.grounded(text, on: codeGround)
        if text.runs.contains(where: { $0.link != nil }) {
            LinkText(text: text, size: size, weight: weight, color: color, codeSize: codeSize, lineSpacing: lineSpacing, tabular: tabular, open: { open($0) }, copy: copy)
        } else {
            InlineCodeText(text: MarkdownFonts.styled(text, size: size, weight: weight, tabular: tabular), mention: mention)
        }
    }

    /// `text` with the ground of its code spans set to `ground`.
    static func grounded(_ text: AttributedString, on ground: Color) -> AttributedString {
        var out = text
        for run in text.runs where run.backgroundColor != nil { out[run.range].backgroundColor = ground }
        return out
    }

    /// Asks before a `pardner-link:<n>` url opens anything: the one path from a link to an address.
    private func open(_ url: URL) {
        if case .read(_, let links) = MarkdownBlocks.read(text) { confirming = LinkConfirmation(url, links: links) }
    }

    /// A cell: the header row small, semibold and grey, a body row at one point under the text; a code span keeps its monospace face but not its ground (#174).
    /// A cell of a column of numbers sets its digits at one width, so that the figures line up under each other.
    private func cell(_ table: MarkdownBlocks.Table, _ row: Int, _ column: Int, tabular: Bool) -> some View {
        var text = table.rows[row][column]
        for run in text.runs where run.backgroundColor != nil { text[run.range].backgroundColor = nil }
        // A code span of the header is as small as the header's words.
        if row == 0 { for run in text.runs where run.font != nil { text[run.range].font = PardnerFont.mono(size: 12, weight: .regular) } }
        return inline(text, size: row == 0 ? 12 : size - 1, weight: row == 0 ? .semibold : .regular, color: row == 0 ? PardnerColor.muted : PardnerColor.text,
                      codeSize: row == 0 ? 12 : 12.5, tabular: tabular)
            .foregroundStyle(row == 0 ? PardnerColor.muted : PardnerColor.text)
    }

    /// A heading's size and the line it is set on: level 1 is 16 on 24, the others 14 on 22.
    static func heading(_ level: Int) -> (size: CGFloat, line: CGFloat) {
        level == 1 ? (PardnerFont.headingSize1, PardnerFont.headingLine1) : (PardnerFont.headingSize, PardnerFont.headingLine)
    }

    @ViewBuilder private func body(of body: MarkdownBlocks.Body, mention: String?, index: Int) -> some View {
        switch body {
        case .paragraph(let text):
            inline(text, size: size, weight: .regular, mention: mention)
        case .heading(let level, let text):
            let (size, line) = Self.heading(level)
            let spacing = MessageRow.spacing(size: size, line: line)
            inline(text, size: size, weight: .semibold, lineSpacing: spacing).lineSpacing(spacing)
        case .code(let language, let code):
            CodeBlock(language: language, code: code, key: foldKey.map { LongBlock.key(message: $0, block: index) }, blocks: blocks)
        case .table(let table):
            // The table takes the column's width, its cells wrapping; a column that would fall under its floor sends it to the sideways scroll. A card
            // on `container` with a hairline border and a faint ground behind the header row, a column of numbers aligned right.
            let numeric = (0..<table.columns).map { table.isNumeric(column: $0) }
            ViewThatFits(in: .horizontal) {
                TableFit(columns: table.columns, numeric: numeric, bleed: Self.tablePad) {
                    // The header's ground, the first child: drawn under the cells and across the card's padding.
                    PardnerColor.tableHead
                    ForEach(table.rows.indices, id: \.self) { r in
                        ForEach(0..<table.columns, id: \.self) { c in cell(table, r, c, tabular: numeric[c]) }
                        if r < table.rows.count - 1 { Rectangle().fill(PardnerColor.line).frame(height: 1) }
                    }
                }
                .padding(.horizontal, Self.tablePad)
                ScrollView(.horizontal) {
                    Grid(alignment: .leading, horizontalSpacing: TableFit.spacing, verticalSpacing: TableFit.rowSpacing) {
                        ForEach(table.rows.indices, id: \.self) { r in
                            if r > 0 { Rectangle().fill(PardnerColor.line).frame(height: 1) }
                            GridRow {
                                ForEach(0..<table.columns, id: \.self) { c in
                                    // A cell fills its column, and the header's ground reaches half the gap each side (the card's padding at the ends): one band.
                                    cell(table, r, c, tabular: numeric[c]).padding(.vertical, TableFit.rowPadding).frame(minHeight: TableFit.rowHeight)
                                        .frame(maxWidth: .infinity, alignment: numeric[c] ? .trailing : .leading)
                                        .background {
                                            if r == 0 {
                                                PardnerColor.tableHead.padding(.leading, c == 0 ? -Self.tablePad : -TableFit.spacing / 2)
                                                    .padding(.trailing, c == table.columns - 1 ? -Self.tablePad : -TableFit.spacing / 2)
                                            }
                                        }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, Self.tablePad)
                }
            }
            .background(PardnerColor.container, in: RoundedRectangle(cornerRadius: 8))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(PardnerColor.line))
        case .rule:
            Rectangle().fill(PardnerColor.line).frame(height: 1).frame(maxWidth: .infinity)
        }
    }
}

/// A fenced block on the code ground with a hairline border: a 28 point header with its language and a button that copies the block, over the text
/// wrapping at the box's width, a continuation starting at the box's left edge (FA 3.2). A block with no language has no header, so no empty first
/// line (#168): its copy button sits in the top right corner. The copy is the text as drawn, `[U+XXXX]` for an invisible character, as a selection of it.
struct CodeBlock: View {
    let language: String?
    let code: String
    var copy: (String) -> Void = { Clipboard.copy($0) }
    /// What the block's open state is kept by (`LongBlock.key`); nil draws it whole, as a file window's text is.
    var key: String?
    var blocks: OpenBlocks = .shared

    private static let shape = RoundedRectangle(cornerRadius: 8)

    /// What the copy button does: copies the block's text as drawn, never its wrapped lines, and all of it when the block is closed.
    func copyCode() { copy(code) }

    private var named: Bool { language?.isEmpty == false }

    private var copyButton: some View {
        Button { copyCode() } label: {
            Image(systemName: "doc.on.doc").font(.system(size: 12)).foregroundStyle(PardnerColor.muted).frame(width: 20, height: 20).contentShape(Rectangle())
        }
        .buttonStyle(.clickable).help("Copy code").accessibilityLabel("Copy code")
    }

    var body: some View {
        let total = LongBlock.count(of: code)
        let open = key.map(blocks.isOpen) ?? true
        let footer = key.flatMap { key in LongBlock.footer(total: total, open: open).map { (key, $0) } }
        VStack(alignment: .leading, spacing: 0) {
            if let language, named {
                HStack(spacing: 0) {
                    Text(verbatim: language).font(PardnerFont.secondary).foregroundStyle(PardnerColor.muted).lineLimit(1)
                    Spacer(minLength: 0)
                    copyButton
                }
                .padding(.horizontal, 12).frame(height: 28)
            }
            // Without a header the corner button takes the room the text leaves at the right of its first line.
            Text(verbatim: footer != nil && !open ? LongBlock.head(of: code) : code).font(PardnerFont.code).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 12).padding(.trailing, named ? 12 : 34).padding(.top, named ? 2 : 12).padding(.bottom, footer == nil ? 12 : 6)
            if let (key, label) = footer {
                LongBlockFooter(label: label, toggle: { blocks.toggle(key) }).padding(.leading, 12).padding(.bottom, 10)
            }
        }
        .background(PardnerColor.codeBg, in: Self.shape)
        .overlay(Self.shape.strokeBorder(PardnerColor.line))
        .overlay(alignment: .topTrailing) { if !named { copyButton.padding(6) } }
    }
}

/// A table's header ground, then its cells in row-major order, one rule after every row but the last, laid out in the width it is given (FA 3.3): its ideal width
/// is its columns' floors, so `ViewThatFits` keeps it while the floors fit; given the natural widths it keeps them, given less it shares the
/// width by natural width, a column held at its floor.
struct TableFit: Layout {
    let columns: Int
    /// Whether each column is aligned right (a column of numbers).
    var numeric: [Bool] = []
    /// How far the header's ground reaches beyond the cells at each side: the card's padding.
    var bleed: CGFloat = 0
    static let spacing: CGFloat = 16
    static let rowSpacing: CGFloat = 0
    /// A row is at least this high, its cells centred; one that wraps takes its tallest cell and 12 points more (`rowPadding` each side).
    static let rowHeight: CGFloat = 32
    /// The room above and under a cell's text, in the fitted table and in the one that scrolls.
    static let rowPadding: CGFloat = 6
    /// About 12 characters of Inter 14.
    static let floorWidth: CGFloat = 90

    /// Each column's natural width (its widest cell unwrapped) and floor (the lesser of that and `floorWidth`), measured once per set of cells.
    struct Cache {
        var natural: [CGFloat] = []
        var floors: [CGFloat] = []
    }

    /// The subviews are the header's ground, then each row's cells and, but for the last row, its rule.
    private func isRule(_ index: Int) -> Bool { index % (columns + 1) == columns }
    private func cell(_ row: Int, _ column: Int) -> Int { 1 + row * (columns + 1) + column }

    func makeCache(subviews: Subviews) -> Cache {
        var natural = [CGFloat](repeating: 0, count: columns)
        for (i, subview) in subviews.enumerated() where i > 0 && !isRule(i - 1) {
            natural[(i - 1) % (columns + 1)] = max(natural[(i - 1) % (columns + 1)], subview.sizeThatFits(.unspecified).width)
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
        (0..<subviews.count / (columns + 1)).map { r in
            let tallest = (0..<columns).map { c in subviews[cell(r, c)].sizeThatFits(ProposedViewSize(width: widths[c], height: nil)).height }.max() ?? 0
            return max(Self.rowHeight, tallest + 2 * Self.rowPadding)
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
        subviews[0].place(at: CGPoint(x: bounds.minX - bleed, y: bounds.minY), anchor: .topLeading, proposal: ProposedViewSize(width: total + 2 * bleed, height: heights[0]))
        for (r, height) in heights.enumerated() {
            var x = bounds.minX
            for c in 0..<columns {
                let right = numeric.indices.contains(c) && numeric[c]
                subviews[cell(r, c)].place(at: CGPoint(x: right ? x + widths[c] : x, y: y + height / 2), anchor: right ? .trailing : .leading,
                                                      proposal: ProposedViewSize(width: widths[c], height: nil))
                x += widths[c] + Self.spacing
            }
            y += height + Self.rowSpacing
            if r < heights.count - 1 {
                subviews[cell(r, columns)].place(at: CGPoint(x: bounds.minX, y: y), anchor: .topLeading, proposal: ProposedViewSize(width: total, height: 1))
                y += 1 + Self.rowSpacing
            }
        }
    }
}
