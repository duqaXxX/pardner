// A message as the one attributed string its text view draws (#194, design 10.2): the pieces of `MarkdownBlocks` one after the other, each
// piece owning its trailing line end, so that a piece's range runs from its start to the next piece's start and a change of one piece
// never touches the characters of another. The gaps, the indents and the code's room are paragraph styles.
import AppKit
import DesignSystem
import Foundation

/// A table in the string: one attachment character, which a copy writes as the table's rows and the text view hosts the card of (`MessageTable.swift`).
final class TableAttachment: NSTextAttachment {
    let table: MarkdownBlocks.Table
    /// The place of the table among the message's pieces, which the table's window is opened from.
    let piece: Int
    let selection = TableSelection()

    init(_ table: MarkdownBlocks.Table, piece: Int) {
        self.table = table
        self.piece = piece
        super.init(data: nil, ofType: nil)
    }

    required init?(coder: NSCoder) { nil }
}

/// A code block's card, on every character of its header, lines and footer: what the text view draws the ground and the copy button from. Equal by value, so
/// that a piece built twice is the same string.
final class CodeBlockCard: NSObject {
    let code: String
    let named: Bool
    /// What the card leaves under its last line: the last paragraph's spacing is not in its fragment's frame (measured on macOS 27.2.1), so the card carries it.
    let below: CGFloat

    init(code: String, named: Bool, below: CGFloat) {
        self.code = code
        self.named = named
        self.below = below
    }

    override func isEqual(_ object: Any?) -> Bool { (object as? CodeBlockCard).map { $0.code == code && $0.named == named && $0.below == below } ?? false }
    override var hash: Int { code.hashValue ^ (named ? 1 : 0) }
}

@MainActor enum MessageString {
    /// The mention's run.
    static let mentionRun = NSAttributedString.Key("pardner.mention")
    /// A run a copy leaves out: a code block's header and its fold footer, which are drawn and are no text of the message.
    static let notCopied = NSAttributedString.Key("pardner.notCopied")
    /// The runs the text view draws a ground or a mark for: a code block's card, the number of a paragraph's quote bars, a rule's line, an inline code span.
    static let codeCard = NSAttributedString.Key("pardner.codeCard")
    static let quoteBars = NSAttributedString.Key("pardner.quoteBars")
    static let ruleMark = NSAttributedString.Key("pardner.rule")
    static let codeSpan = NSAttributedString.Key("pardner.codeSpan")
    /// On a piece's line end: a copy puts one more line end there, a blank line between the piece and the next.
    static let separated = NSAttributedString.Key("pardner.separated")

    struct Built {
        let string: NSAttributedString
        /// Where each piece starts; piece `i` runs to `starts[i + 1]`, the last to the end.
        let starts: [Int]
        /// Whether a code block or a rule makes the message as wide as it is given: a card and a rule take the whole width, as on the block path.
        let fillsWidth: Bool
        /// The room above the first line and under the last: the text view lays out none (measured), so they are the view's own.
        let top: CGFloat
        let bottom: CGFloat
    }

    /// What a code block's text leaves at each side inside its card, at the right of its first line under no header (the corner button), and the header's height.
    static let codePad: CGFloat = 12, headerHeight: CGFloat = 28
    /// The font of a table's line, as small as a text's can be.
    static let tableFont = NSFont.systemFont(ofSize: 1)
    /// On a table's character and its line end: the message's font, which a copy gives the rows and the blank line under them in place of `tableFont`.
    static let rowFont = NSAttributedString.Key("pardner.rowFont")
    private static let cornerRoom: CGFloat = 34

    /// The pieces as one string and where each starts. No `NSTextList`: on TextKit 2 it adds its own marker and an empty line to each item (measured 2026-11-28);
    /// the marker is text here.
    static func build(_ pieces: [MarkdownBlocks.Piece], mention: String?, size: CGFloat, foldKey: String?, blocks: OpenBlocks) -> Built {
        let out = NSMutableAttributedString()
        var starts: [Int] = []
        // A mention joins the first paragraph's line, else it has a line of its own.
        let joined = pieces.first.map(MarkdownView.opens) ?? false
        let alone = mention != nil && !joined
        if let mention, alone {
            let line = label(mention, size: size)
            apply(indented(), to: line, before: 0)
            out.append(line)
            out.append(NSAttributedString(string: "\n", attributes: [.font: font(size, .semibold), .paragraphStyle: indented()]))
        }
        for (i, piece) in pieces.enumerated() {
            starts.append(out.length)
            let wanted = i == 0 && alone ? PardnerMetrics.paragraphGap : MarkdownView.gaps(from: i > 0 ? pieces[i - 1] : nil, to: piece).content
            // The text view puts the line spacing above every line but the first of the text, so a gap is that much less, never less than none.
            let atTop = i == 0 && !alone
            func space(_ wanted: CGFloat, _ lineSpacing: CGFloat) -> CGFloat { atTop ? wanted : max(wanted - lineSpacing, 0) }
            let base = style(of: piece)
            let text: NSMutableAttributedString
            switch piece.body {
            case .paragraph(let words):
                text = inline(words, size: size, weight: .regular, lineSpacing: base.lineSpacing, marker: piece.marker)
                if i == 0, joined, let mention {
                    text.insert(NSAttributedString(string: " ", attributes: [.kern: MentionedText.side + (words.runs.first?.backgroundColor != nil ? InlineCodeText.inset : 0)]), at: 0)
                    text.insert(label(mention, size: size), at: 0)
                    base.firstLineHeadIndent = MentionedText.side
                }
                apply(base, to: text, before: space(wanted, base.lineSpacing))
            case .heading(let level, let words):
                let (headSize, line) = MarkdownView.heading(level)
                base.lineSpacing = MessageRow.spacing(size: headSize, line: line)
                text = inline(words, size: headSize, weight: .semibold, lineSpacing: base.lineSpacing, marker: piece.marker)
                apply(base, to: text, before: space(wanted, base.lineSpacing))
            case .code(let language, let body):
                text = codeBlock(language: language, text: body, base: base, wanted: wanted, space: space, key: foldKey.map { LongBlock.key(message: $0, block: i) }, index: i, blocks: blocks)
            case .table(let table):
                let attachment = TableAttachment(table, piece: i)
                base.lineSpacing = 0
                text = NSMutableAttributedString(attachment: attachment)
                // The line is as high as the card: the card's bounds reach down to this font's descent (`TableViewProvider`), which is all the line holds under it.
                text.addAttributes([.font: tableFont, rowFont: font(size, .regular)], range: NSRange(location: 0, length: text.length))
                apply(base, to: text, before: wanted)
            case .rule:
                base.lineSpacing = 0
                base.minimumLineHeight = 1
                base.maximumLineHeight = 1
                text = NSMutableAttributedString(string: " ", attributes: [.font: NSFont.systemFont(ofSize: 1), notCopied: true, ruleMark: true])
                apply(base, to: text, before: wanted)
            }
            if piece.bars > 0 { text.addAttribute(quoteBars, value: piece.bars, range: NSRange(location: 0, length: text.length)) }
            out.append(text)
            if i < pieces.count - 1 {
                // The line end has the paragraph's own look, and nothing of a run (a link, a ground, the attachment).
                var attributes = text.length > 0 ? text.attributes(at: text.length - 1, effectiveRange: nil).filter { [.font, .foregroundColor, .paragraphStyle, quoteBars, rowFont].contains($0.key) } : [.paragraphStyle: base]
                // A rule's own line is not copied, nor is its line end; the blank line either side of it is the neighbours'.
                if case .rule = piece.body { attributes[notCopied] = true } else if MarkdownView.gap(from: piece, to: pieces[i + 1]) != PardnerMetrics.itemGap { attributes[separated] = true }
                out.append(NSAttributedString(string: "\n", attributes: attributes))
            }
        }
        let room = (above: edge(of: out, at: 0, \.paragraphSpacingBefore), under: edge(of: out, at: out.length - 1, \.paragraphSpacing))
        return Built(string: out, starts: starts, fillsWidth: pieces.contains { switch $0.body { case .code, .rule: true; default: false } }, top: room.above, bottom: room.under)
    }

    /// A text the bounds refuse, as one run: `CodeSpans.styled`'s, with the mention before it.
    static func plain(_ text: String, mention: String?, size: CGFloat) -> NSAttributedString {
        let out = markCodeSpans(LinkText.attributed(CodeSpans.styled(text), size: size, weight: .regular))
        if let mention {
            // The first paragraph starts a side in, as the mention's room is the indent of the first line; the label and the space, which have no
            // style of their own, take the paragraph's.
            let style = (out.length > 0 ? out.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle : nil)?.mutableCopy() as? NSMutableParagraphStyle ?? indented()
            style.firstLineHeadIndent = MentionedText.side
            // A text that opens with a code span has its inset in the space's kern too, as `build` gives it.
            let opensWithSpan = out.length > 0 && out.attribute(codeSpan, at: 0, effectiveRange: nil) != nil
            out.insert(NSAttributedString(string: " ", attributes: [.kern: MentionedText.side + (opensWithSpan ? InlineCodeText.inset : 0)]), at: 0)
            out.insert(label(mention, size: size), at: 0)
            out.addAttribute(.paragraphStyle, value: style, range: (out.string as NSString).paragraphRange(for: NSRange(location: 0, length: 0)))
        }
        return out
    }

    // MARK: pieces

    private static func font(_ size: CGFloat, _ weight: InterWeight) -> NSFont { PardnerFont.uiCT(size: size, weight: weight) as NSFont }

    /// The mention's label (`mentionLabel`): its room before it is the first line's indent, and the room after it a kern on the space that follows.
    private static func label(_ name: String, size: CGFloat) -> NSMutableAttributedString {
        NSMutableAttributedString(string: name, attributes: [.font: font(size, .semibold), .foregroundColor: NSColor(PardnerColor.mentionText), mentionRun: true])
    }

    private static func indented() -> NSMutableParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = MessageRow.lineSpacing
        style.firstLineHeadIndent = MentionedText.side
        return style
    }

    /// A paragraph or heading's text with a list item's marker, which is text, before it.
    private static func inline(_ words: AttributedString, size: CGFloat, weight: InterWeight, lineSpacing: CGFloat, marker: String?) -> NSMutableAttributedString {
        let out = NSMutableAttributedString()
        if let marker { out.append(NSAttributedString(string: marker + "\t", attributes: [.font: font(size, .regular), .foregroundColor: NSColor(PardnerColor.text)])) }
        out.append(markCodeSpans(LinkText.attributed(words, size: size, weight: weight, lineSpacing: lineSpacing)))
        return out
    }

    /// A code span's ground is the text view's to draw (`codeSpan`, in the colour it holds), so its run keeps no square `backgroundColor`; its room is a `kern` on
    /// the character before it and on its last, as `InlineCodeText.pieces` makes it.
    private static func markCodeSpans(_ text: NSAttributedString) -> NSMutableAttributedString {
        let out = NSMutableAttributedString(attributedString: text)
        var spans: [NSRange] = []
        out.enumerateAttribute(.backgroundColor, in: NSRange(location: 0, length: out.length)) { ground, range, _ in if ground != nil { spans.append(range) } }
        for span in spans {
            out.removeAttribute(.backgroundColor, range: span)
            out.addAttribute(codeSpan, value: true, range: span)
            out.addAttribute(.kern, value: InlineCodeText.inset, range: NSRange(location: span.upperBound - 1, length: 1))
            if span.location > 0 { out.addAttribute(.kern, value: InlineCodeText.inset, range: NSRange(location: span.location - 1, length: 1)) }
        }
        return out
    }

    /// The paragraph a piece is in: the quotes' bars and the lists' steps as the head indent, the marker hanging one step before it.
    private static func style(of piece: MarkdownBlocks.Piece) -> NSMutableParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = MessageRow.lineSpacing
        style.headIndent = CGFloat(piece.bars) * (MarkdownView.barWidth + MarkdownView.barGap) + CGFloat(max(piece.depth - piece.bars, 0)) * MarkdownView.listStep
        style.firstLineHeadIndent = piece.marker == nil ? style.headIndent : style.headIndent - MarkdownView.listStep
        if piece.marker != nil { style.tabStops = [NSTextTab(textAlignment: .left, location: style.headIndent)] }
        return style
    }

    /// `style` on the first paragraph of `text` with `before` above it, and on the later ones (a soft break, a code line) without the first-line indent, with
    /// `after` under the last.
    private static func apply(_ style: NSParagraphStyle, to text: NSMutableAttributedString, before: CGFloat, after: CGFloat = 0) {
        guard text.length > 0 else { return }
        let string = text.string as NSString
        let later = style.mutableCopy() as! NSMutableParagraphStyle
        later.firstLineHeadIndent = later.headIndent
        text.addAttribute(.paragraphStyle, value: later, range: NSRange(location: 0, length: text.length))
        let first = string.paragraphRange(for: NSRange(location: 0, length: 0))
        text.addAttribute(.paragraphStyle, value: style, range: first)
        for (range, change) in [(first, { (s: NSMutableParagraphStyle) in s.paragraphSpacingBefore = before }),
                                (string.paragraphRange(for: NSRange(location: string.length - 1, length: 0)), { (s: NSMutableParagraphStyle) in s.paragraphSpacing = after })] {
            let changed = (text.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as! NSParagraphStyle).mutableCopy() as! NSMutableParagraphStyle
            change(changed)
            text.addAttribute(.paragraphStyle, value: changed, range: range)
        }
    }

    /// What `key` is on the paragraph at `index`: the text view lays out no space above its first paragraph or under its last, so the view makes it. The
    /// string keeps it, so that a piece is the same characters whether or not it is the last.
    private static func edge(of text: NSAttributedString, at index: Int, _ key: KeyPath<NSParagraphStyle, CGFloat>) -> CGFloat {
        guard text.length > 0, let style = text.attribute(.paragraphStyle, at: index, effectiveRange: nil) as? NSParagraphStyle else { return 0 }
        return style[keyPath: key]
    }

    /// The header with the language, the lines (the head of a long block while it is closed) and the fold footer, each with the room today's card leaves.
    private static func codeBlock(language: String?, text: String, base: NSMutableParagraphStyle, wanted: CGFloat, space: (CGFloat, CGFloat) -> CGFloat, key: String?, index: Int, blocks: OpenBlocks) -> NSMutableAttributedString {
        let named = language?.isEmpty == false
        let firstLine: CGFloat = 2
        let open = key.map(blocks.isOpen) ?? true
        let footer = key.flatMap { _ in LongBlock.footer(total: LongBlock.count(of: text), open: open) }
        base.headIndent += codePad
        base.firstLineHeadIndent = base.headIndent
        base.tailIndent = named ? -codePad : -cornerRoom
        let out = NSMutableAttributedString()
        let card: [NSAttributedString.Key: Any] = [codeCard: CodeBlockCard(code: text, named: named, below: footer == nil ? codePad : 10)]
        if let language, named {
            let header = NSMutableParagraphStyle()
            header.headIndent = base.headIndent
            header.firstLineHeadIndent = base.headIndent
            // The first line under the header has the line spacing above it, where the card leaves 2 points: the header gives up the rest.
            header.minimumLineHeight = headerHeight - max(base.lineSpacing - firstLine, 0)
            header.maximumLineHeight = header.minimumLineHeight
            out.append(NSAttributedString(string: language + "\n", attributes: [.font: font(12, .regular), .foregroundColor: NSColor(PardnerColor.muted), notCopied: true].merging(card) { $1 }))
            apply(header, to: out, before: wanted)
        }
        let shown = footer != nil && !open ? LongBlock.head(of: text) : text
        let mono: [NSAttributedString.Key: Any] = [.font: PardnerFont.monoCT(size: 12.5, weight: .regular) as NSFont, .foregroundColor: NSColor(PardnerColor.text)].merging(card) { $1 }
        let lines = NSMutableAttributedString(string: shown, attributes: mono)
        // An empty body, and one that ends in a line end, has an empty last line: a space stands for it, which a copy leaves out. The text view would lay the
        // line out after the last line end with that line's own room above it, and none of a style of its own.
        if shown.isEmpty || shown.hasSuffix("\n") { lines.append(NSAttributedString(string: " ", attributes: mono.merging([notCopied: true]) { $1 })) }
        apply(base, to: lines, before: named ? max(firstLine - base.lineSpacing, 0) : space(wanted + codePad, base.lineSpacing), after: footer == nil ? codePad : 6)
        out.append(lines)
        if let footer {
            let tail = NSMutableParagraphStyle()
            tail.headIndent = base.headIndent
            tail.firstLineHeadIndent = base.headIndent
            // The line end before the footer closes the last line, and is no more copied than the footer.
            var end = lines.attributes(at: lines.length - 1, effectiveRange: nil)
            end[notCopied] = true
            out.append(NSAttributedString(string: "\n", attributes: end))
            let line = NSMutableAttributedString(string: footer, attributes: [.font: font(PardnerFont.toolSize, .regular), .foregroundColor: NSColor(PardnerColor.muted), notCopied: true, .link: URL(string: "pardner-action:fold:\(index)")!].merging(card) { $1 })
            apply(tail, to: line, before: 0, after: 10)
            out.append(line)
        }
        return out
    }
}
