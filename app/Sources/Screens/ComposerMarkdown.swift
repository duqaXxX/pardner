// The composer's rich text and the Markdown it is sent as (#129, composer formatting design). The field holds attributed text and the model holds
// Markdown: this is the one place that turns one into the other. Neither Foundation nor AppKit writes Markdown, so the writer is ours; the reader is
// `AttributedString(markdown:)`, whose intents this maps back to the field's attributes. The subset is bold, italic, strikethrough, inline code, a link,
// a heading, a bulleted or numbered list item, a quote and a code block; whatever else a text holds (a table, an image) reads as plain paragraphs.
import AppKit
import DesignSystem
import Foundation
import SwiftUI

extension NSAttributedString.Key {
    /// The semantic marks of the field's text. The font is derived from them (`ComposerMarkdown.style`): Inter is a variable font with no bold or
    /// italic trait to read back, so the marks, never the font, say what the Markdown is.
    static let composerStrong = NSAttributedString.Key("pardner.composer.strong")
    static let composerEmphasis = NSAttributedString.Key("pardner.composer.emphasis")
    static let composerCode = NSAttributedString.Key("pardner.composer.code")
    /// A paragraph's block, the raw value of a `ComposerMarkdown.Block` on every character of it, its line end included; none is a plain paragraph.
    static let composerBlock = NSAttributedString.Key("pardner.composer.block")
}

enum ComposerMarkdown {
    enum Block: String, CaseIterable {
        case h1, h2, h3, bullet, number, quote, code

        /// The room a block's marker or bar takes at the left of its text.
        var indent: CGFloat {
            switch self {
            case .bullet, .number: PardnerMetrics.listIndent
            case .quote: PardnerMetrics.quoteBar + PardnerMetrics.quotePad
            default: 0
            }
        }
    }

    // MARK: attributes

    /// The font of a run: Inter 14, a heading at the sizes the messages draw it, code in JetBrains Mono; strong one step heavier.
    static func font(strong: Bool, emphasis: Bool, code: Bool, block: Block?) -> NSFont {
        if code || block == .code { return PardnerFont.monoCT(size: 12.5, weight: strong ? .medium : .regular) as NSFont }
        let heading = block == .h1 || block == .h2 || block == .h3
        let size = block == .h1 ? PardnerFont.headingSize1 : PardnerFont.headingSize
        let weight: InterWeight = heading ? (strong ? .bold : .semibold) : (strong ? .semibold : .regular)
        return PardnerFont.uiCT(size: size, weight: weight, italic: emphasis) as NSFont
    }

    /// A paragraph's style: its block's room at the left, and `first` more on its first line (the room of the chip the field's first line starts after).
    static func paragraphStyle(_ block: Block?, first: CGFloat) -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.firstLineHeadIndent = first + (block?.indent ?? 0)
        style.headIndent = block?.indent ?? 0
        return style
    }

    /// What typed text carries in an empty field.
    static func base(firstLineIndent: CGFloat) -> [NSAttributedString.Key: Any] {
        [.font: font(strong: false, emphasis: false, code: false, block: nil), .foregroundColor: NSColor(PardnerColor.text),
         .paragraphStyle: paragraphStyle(nil, first: firstLineIndent)]
    }

    /// The ranges of `text`'s paragraphs, line ends left out: one more than there are line ends, so a trailing line end leaves an empty last one.
    static func paragraphs(of text: NSString) -> [NSRange] {
        var out: [NSRange] = []
        var start = 0
        while true {
            let end = text.range(of: "\n", range: NSRange(location: start, length: text.length - start)).location
            out.append(NSRange(location: start, length: (end == NSNotFound ? text.length : end) - start))
            if end == NSNotFound { return out }
            start = end + 1
        }
    }

    /// The block of the paragraph starting at `location`: read on its first character, or on its line end when it is empty.
    static func block(in text: NSAttributedString, at location: Int) -> Block? {
        guard location < text.length else { return nil }
        return (text.attribute(.composerBlock, at: location, effectiveRange: nil) as? String).flatMap(Block.init)
    }

    /// The attributes the field's text may carry: its marks, and what `style` derives from them.
    private static let kept: Set<NSAttributedString.Key> = [
        .font, .foregroundColor, .backgroundColor, .paragraphStyle, .strikethroughStyle, .link,
        .composerStrong, .composerEmphasis, .composerCode, .composerBlock,
    ]

    /// Sets the font and the paragraph style of every run from its marks and its block, and the first paragraph's first-line indent. Only what differs is written.
    static func style(_ text: NSMutableAttributedString, firstLineIndent: CGFloat) {
        let length = (text.string as NSString).length
        text.beginEditing()
        defer { text.endEditing() }
        for (index, range) in paragraphs(of: text.string as NSString).enumerated() {
            let whole = NSRange(location: range.location, length: min(range.length + 1, length - range.location))
            guard whole.length > 0 else { continue }
            let block = block(in: text, at: range.location)
            let paragraph = paragraphStyle(block, first: index == 0 ? firstLineIndent : 0)
            if text.attribute(.paragraphStyle, at: whole.location, effectiveRange: nil) as? NSParagraphStyle != paragraph {
                text.addAttribute(.paragraphStyle, value: paragraph, range: whole)
            }
            var edits: [(NSRange, NSFont, NSColor?, [NSAttributedString.Key])] = []
            text.enumerateAttributes(in: whole) { attributes, run, _ in
                let code = attributes[.composerCode] != nil
                let font = font(strong: attributes[.composerStrong] != nil, emphasis: attributes[.composerEmphasis] != nil, code: code, block: block)
                // What the field has no mark for (an underline, a stroke, a kern) came in from outside: a drop or the Font menu.
                edits.append((run, font, code || block == .code ? NSColor(PardnerColor.codeInline) : nil, attributes.keys.filter { !kept.contains($0) }))
            }
            for (run, font, ground, foreign) in edits {
                for key in foreign { text.removeAttribute(key, range: run) }
                text.addAttribute(.font, value: font, range: run)
                text.addAttribute(.foregroundColor, value: NSColor(PardnerColor.text), range: run)
                if let ground { text.addAttribute(.backgroundColor, value: ground, range: run) } else { text.removeAttribute(.backgroundColor, range: run) }
            }
        }
    }

    // MARK: to Markdown

    /// A span's delimiters. A run's marks open in this order, so that two runs with the same first marks keep them open between them.
    private enum Mark: Equatable {
        case link(URL), strike, strong, emphasis
        /// The opening delimiter; the closing one is its reverse.
        case code(String)

        var open: String {
            switch self {
            case .link: "["
            case .strike: "~~"
            case .strong: "**"
            case .emphasis: "*"
            case .code(let fence): fence
            }
        }

        /// Whether the delimiter reads as one only when it flanks the text (CommonMark's left- and right-flanking rules): not a link's brackets or a code fence.
        var flanks: Bool {
            switch self {
            case .strike, .strong, .emphasis: true
            case .link, .code: false
            }
        }

        var close: String {
            if case .link(let url) = self { return "](\(url.absoluteString.replacingOccurrences(of: ")", with: "%29")))" }
            return String(open.reversed())
        }
    }

    /// The Markdown of `text`. A plain run goes out as typed, never escaped, so that the bot reads what was typed (`__init__.py`).
    static func markdown(from text: NSAttributedString) -> String {
        let ns = text.string as NSString
        var groups: [(block: Block?, ranges: [NSRange])] = []
        for range in paragraphs(of: ns) {
            let block = block(in: text, at: range.location)
            if let last = groups.last, last.block == block { groups[groups.count - 1].ranges.append(range) } else { groups.append((block, [range])) }
        }
        return groups.map { group in
            let lines = group.ranges.map { ns.substring(with: $0) }
            switch group.block {
            case .code:
                let fence = String(repeating: "`", count: max(3, backticks(in: lines.joined()) + 1))
                return ([fence] + lines + [fence]).joined(separator: "\n")
            default:
                return group.ranges.enumerated().map { index, range in
                    let prefix: String
                    switch group.block {
                    case .h1: prefix = "# "
                    case .h2: prefix = "## "
                    case .h3: prefix = "### "
                    case .bullet: prefix = "- "
                    case .number: prefix = "\(index + 1). "
                    case .quote: prefix = "> "
                    default: prefix = ""
                    }
                    return prefix + inline(text, range)
                }.joined(separator: "\n")
            }
        }.joined(separator: "\n\n")
    }

    /// What the reader counts as punctuation (probed on macOS 27, 2026-11-27): the ASCII punctuation and the Unicode P categories. A symbol outside ASCII
    /// (an emoji, `€`, `→`, `©`) is a letter to it.
    private static func punctuation(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .connectorPunctuation, .dashPunctuation, .openPunctuation, .closePunctuation, .initialPunctuation, .finalPunctuation, .otherPunctuation: true
        default: scalar.isASCII && scalar.value > 32 && scalar.value < 127 && !scalar.properties.isAlphabetic && !(48...57).contains(scalar.value)
        }
    }

    /// What the reader counts as a blank: a space, a tab, a line end or any Unicode space separator (`\u{3000}`, `\u{A0}`); U+2028 is a letter to it.
    private static func blank(_ character: Character) -> Bool {
        character.unicodeScalars.allSatisfy { $0 == "\t" || $0 == "\n" || $0 == "\r" || $0 == "\u{C}" || $0.properties.generalCategory == .spaceSeparator }
    }

    /// Whether `scalar` is neither a blank nor punctuation, which is what CommonMark's flanking rules call anything else; none (the paragraph's end) is a blank.
    private static func letter(_ scalar: Unicode.Scalar?) -> Bool { scalar.map { !blank(Character($0)) && !punctuation($0) } ?? false }

    /// The scalar a run puts at one end of its text in the Markdown, which is what the reader looks at: a code span's fence is a backtick.
    private static func edge(_ run: (string: String, marks: [Mark], code: Bool), last: Bool) -> Unicode.Scalar? {
        run.code ? "`" : last ? run.string.unicodeScalars.last : run.string.unicodeScalars.first
    }

    /// The length of the longest run of backticks in `string`.
    private static func backticks(in string: String) -> Int {
        var (longest, run) = (0, 0)
        for character in string {
            run = character == "`" ? run + 1 : 0
            longest = max(longest, run)
        }
        return longest
    }

    private static func marks(_ attributes: [NSAttributedString.Key: Any], _ string: String) -> [Mark] {
        var marks: [Mark] = []
        if let url = (attributes[.link] as? URL) ?? (attributes[.link] as? String).flatMap(URL.init(string:)) { marks.append(.link(url)) }
        if (attributes[.strikethroughStyle] as? Int ?? 0) != 0 { marks.append(.strike) }
        if attributes[.composerCode] != nil {
            // A span holding backticks opens with one more than its longest run, and a space inside each end; so does one with a space at both ends,
            // which a reader strips one of unless the span is all spaces.
            let longest = backticks(in: string)
            let padded = longest > 0 || (string.hasPrefix(" ") && string.hasSuffix(" ") && string.contains { $0 != " " })
            marks.append(.code(String(repeating: "`", count: longest + 1) + (padded ? " " : "")))
        } else {
            if attributes[.composerStrong] != nil { marks.append(.strong) }
            if attributes[.composerEmphasis] != nil { marks.append(.emphasis) }
        }
        return marks
    }

    /// One paragraph's runs. A mark stays open across the runs that share it. The blanks at the ends of a run stay outside the marks the next run does not share,
    /// where a delimiter next to a blank would not read as one.
    private static func inline(_ text: NSAttributedString, _ range: NSRange) -> String {
        var runs: [(string: String, marks: [Mark], code: Bool)] = []
        text.enumerateAttributes(in: range) { attributes, run, _ in
            let string = (text.string as NSString).substring(with: run)
            runs.append((string, marks(attributes, string), attributes[.composerCode] != nil))
        }
        var out = ""
        var open: [Mark] = []
        func move(to wanted: [Mark]) {
            var common = 0
            while common < min(open.count, wanted.count), open[common] == wanted[common] { common += 1 }
            out += open[common...].reversed().map(\.close).joined() + wanted[common...].map(\.open).joined()
            open = wanted
        }
        /// The marks two neighbours both carry, from the outermost.
        func shared(_ a: [Mark], _ b: [Mark]) -> [Mark] {
            var common = 0
            while common < min(a.count, b.count), a[common] == b[common] { common += 1 }
            return Array(a[..<common])
        }
        for (index, run) in runs.enumerated() {
            // The marks of the next run that has text: a run of blanks has no delimiter of its own, and one that closed after a blank would read as none.
            let next = runs[(index + 1)...].first { $0.code || !$0.string.allSatisfy(blank) }?.marks ?? []
            let chars = Array(run.string)
            var (start, end) = (0, chars.count)
            while start < end, blank(chars[start]) { start += 1 }
            while end > start, blank(chars[end - 1]) { end -= 1 }
            if !run.code, start < end {
                // A delimiter next to punctuation reads as one only when a blank or punctuation is on its other side. Where a letter is, the punctuation at the
                // end of the run stays outside the mark, and a run of nothing else loses it.
                let before = start > 0 ? chars[start - 1].unicodeScalars.last : index > 0 ? Self.edge(runs[index - 1], last: true) : nil
                let after = end < chars.count ? chars[end].unicodeScalars.first : index + 1 < runs.count ? Self.edge(runs[index + 1], last: false) : nil
                let opens = run.marks[shared(open, run.marks).count...].contains(where: \.flanks)
                let closes = run.marks[shared(run.marks, next).count...].contains(where: \.flanks)
                if opens, Self.punctuation(chars[start].unicodeScalars.first!), Self.letter(before) { start += 1 }
                if closes, start < end, Self.punctuation(chars[end - 1].unicodeScalars.last!), Self.letter(after) { end -= 1 }
            }
            let (lead, core, trail) = (String(chars[..<start]), String(chars[start..<end]), String(chars[end...]))
            if run.code {
                move(to: run.marks)
                out += run.string
            } else if core.isEmpty {
                move(to: shared(open, next))
                out += run.string
            } else {
                if !lead.isEmpty { move(to: shared(open, run.marks)) }
                out += lead
                move(to: run.marks)
                out += core
                if !trail.isEmpty { move(to: shared(run.marks, next)) }
                out += trail
            }
        }
        move(to: [])
        return out
    }

    // MARK: from Markdown

    /// The field's text for `text` as it was typed: no Markdown in it is read.
    static func plain(_ text: String) -> NSAttributedString { NSAttributedString(string: text, attributes: base(firstLineIndent: 0)) }

    /// The field's text for a Markdown the model gives back: read as Markdown when writing it again gives the same text, else as typed.
    static func restored(from markdown: String) -> NSAttributedString {
        let read = attributed(from: markdown)
        return self.markdown(from: read) == markdown ? read : plain(markdown)
    }

    /// The field's text for `markdown`, styled. A text Foundation refuses to read stays as typed.
    static func attributed(from markdown: String) -> NSAttributedString {
        guard let source = try? AttributedString(markdown: markdown, options: .init(interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible))
        else { return plain(markdown) }
        let out = NSMutableAttributedString()
        var key: Int?
        var current: Block?
        func closeBlock() {
            // A code block's text ends with the fence's line end, which is no line of it.
            if current == .code, out.string.hasSuffix("\n") { out.deleteCharacters(in: NSRange(location: out.length - 1, length: 1)) }
        }
        for run in source.runs {
            let components = run.presentationIntent?.components ?? []
            let block = Self.block(of: components)
            if out.length > 0, components.first?.identity != key {
                closeBlock()
                out.append(NSAttributedString(string: "\n", attributes: current.map { [.composerBlock: $0.rawValue] } ?? [:]))
            }
            (key, current) = (components.first?.identity, block)
            let intent = run.inlinePresentationIntent ?? []
            var string = String(source[run.range].characters)
            if intent.contains(.softBreak) || intent.contains(.lineBreak) { string = "\n" }
            // Foundation gives an image with no alt text the object replacement character as its text.
            if run.imageURL != nil, string == "\u{FFFC}" { string = "" }
            var attributes: [NSAttributedString.Key: Any] = [:]
            if let block { attributes[.composerBlock] = block.rawValue }
            if intent.contains(.stronglyEmphasized) { attributes[.composerStrong] = true }
            if intent.contains(.emphasized) { attributes[.composerEmphasis] = true }
            if intent.contains(.code) { attributes[.composerCode] = true }
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let url = run.link { attributes[.link] = url }
            out.append(NSAttributedString(string: string, attributes: attributes))
        }
        closeBlock()
        style(out, firstLineIndent: 0)
        return out
    }

    /// The innermost block of a run's intent: a code block, a heading, a list item or a quote; a heading deeper than three reads as the third.
    private static func block(of components: [PresentationIntent.IntentType]) -> Block? {
        for (index, component) in components.enumerated() {
            switch component.kind {
            case .codeBlock: return .code
            case .header(let level): return [Block.h1, .h2, .h3][min(max(level, 1), 3) - 1]
            case .listItem:
                if index + 1 < components.count, case .orderedList = components[index + 1].kind { return .number }
                return .bullet
            case .blockQuote: return .quote
            default: continue
            }
        }
        return nil
    }
}
