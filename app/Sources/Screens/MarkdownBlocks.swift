// A bot's text read as Markdown into a flat list of pieces the thread draws one row each (#73, step B2). Foundation's parser
// reads it, after bounds that keep a hostile text from costing more than a few milliseconds, and nothing it reads runs or loads:
// a link becomes a numbered placeholder the view resolves behind a confirm, an image becomes its text. A text the bounds refuse is
// drawn as `CodeSpans.styled` draws it today.
import DesignSystem
import Foundation

/// Invisible and control code points of a code text, written as their numbers.
enum CodeMarks {
    /// `code` with every code point that draws with no width or acts as a control (Default_Ignorable, U+3164, U+FFA0, general
    /// category Cc but tab, line feed and carriage return, or Cf) written as `[U+XXXX]`: monospace reads as an exact command, so
    /// what is drawn must be what a selection copies (#73, section 7).
    static func shown(_ code: String) -> String {
        var out = ""
        for scalar in code.unicodeScalars {
            let category = scalar.properties.generalCategory
            let control = category == .control && scalar != "\t" && scalar != "\n" && scalar != "\r"
            if scalar.properties.isDefaultIgnorableCodePoint || scalar.value == 0x3164 || scalar.value == 0xFFA0
                || control || category == .format {
                out += String(format: "[U+%04X]", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
        return out
    }
}

enum MarkdownBlocks {
    /// What a text reads as: the pieces and the real addresses of its links (a link's attribute is `pardner-link:<n>`, n an index
    /// into `links`), or a refusal, which the caller draws as `CodeSpans.styled`.
    enum Decision: Equatable {
        case refused
        case read(pieces: [Piece], links: [URL])
    }

    /// One row of the thread. `depth` counts the lists' items and the block quotes around it (`bars` of them quotes), both capped
    /// at `deepest`; past it the text of a paragraph or heading is opened by `…`. `marker` is on the first piece of a list item.
    struct Piece: Equatable {
        var depth: Int
        var bars: Int
        var marker: String?
        var body: Body
    }

    enum Body: Equatable {
        case paragraph(AttributedString)
        case heading(level: Int, AttributedString)
        /// The info string's first word, and the body as drawn: marks applied, the fence's final line end dropped.
        case code(language: String?, text: String)
        case table(Table)
        case rule
    }

    /// A table as a grid: `rows[0]` is the header, every row has `columns` cells, a cell or row Foundation gave no run is empty.
    struct Table: Equatable {
        var columns: Int
        var rows: [[AttributedString]]

        /// Whether the column's body cells all read as a number, with a sign, separators and a short unit (`1,204`, `12.5%`, `2.4 MB`), a cell of
        /// nothing or of dashes being no objection: it is aligned right, by what it holds and not by its header's word (#174).
        func isNumeric(column: Int) -> Bool {
            let cells = rows.dropFirst().map { String($0[column].characters).trimmingCharacters(in: .whitespaces) }
            let filled = cells.filter { !$0.isEmpty && !$0.allSatisfy { "-\u{2013}\u{2014}".contains($0) } }
            return !filled.isEmpty && filled.allSatisfy { $0.wholeMatch(of: /[+\-\u{2212}]?[$\u{20AC}\u{A3}]?\d[\d,._]*\s?[%A-Za-z]{0,3}/) != nil }
        }
    }

    /// The deepest nesting drawn (2.3); the same for lists and quotes.
    static let deepest = 8
    /// The most drawn pieces a text may hold (2.2, step 4): provisional, the owner's.
    static let most = 1_000
    /// The most columns a table may have (2.2, step 2).
    static let widest = 20

    /// The cached decision for `text` (2.6): the parse costs a few milliseconds and a row is built again each time it scrolls in.
    @MainActor static func read(_ text: String) -> Decision {
        // Step 1 is a count: only a refusal of step 2, 3 or 4 is worth a cache entry (2.6).
        guard text.count <= CodeSpans.most else { return .refused }
        let key = text as NSString
        if let hit = cache.object(forKey: key) { return hit.decision }
        let decision = parse(text)
        cache.setObject(Box(decision), forKey: key)
        return decision
    }

    private final class Box {
        let decision: Decision
        init(_ decision: Decision) { self.decision = decision }
    }

    @MainActor private static let cache: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.countLimit = 500
        return cache
    }()

    /// `text` through the bounds of 2.2 in order, then mapped to pieces; any bound that fails is `.refused`.
    static func parse(_ text: String) -> Decision {
        guard text.count <= CodeSpans.most, !hasWideDelimiterRow(text),
              let source = try? AttributedString(
                  markdown: text, options: .init(interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible)),
              let (pieces, links) = try? pieces(of: source)
        else { return .refused }
        return .read(pieces: pieces, links: links)
    }

    // MARK: the pre-scan

    /// Whether some line is a table's delimiter row of more than `widest` cells. The parser's cost follows the delimiter row, and a
    /// quote's `>` and a lone `\r` end do not hide one (round 1, F3 and F4), so the lines are cut by scalar and a leading run of
    /// `>`, spaces and tabs is dropped. A line inside a fence counts too: the text is then drawn as today (accepted case).
    private static func hasWideDelimiterRow(_ text: String) -> Bool {
        var line = String.UnicodeScalarView()
        var previous: Unicode.Scalar?
        func wide() -> Bool {
            defer { line = String.UnicodeScalarView() }
            return cells(ofDelimiterRow: line).map { $0 > widest } ?? false
        }
        for scalar in text.unicodeScalars {
            if scalar == "\n" || scalar == "\r" {
                if scalar == "\n", previous == "\r" { previous = scalar; continue }
                if wide() { return true }
            } else {
                line.append(scalar)
            }
            previous = scalar
        }
        return wide()
    }

    /// The number of cells of `line` when it is a delimiter row (only `|`, `-`, `:`, spaces and tabs, with a `-` and a `|`), counted
    /// as GFM counts them: split on `|`, an empty first and last cell dropped.
    private static func cells(ofDelimiterRow line: String.UnicodeScalarView) -> Int? {
        let blank: Set<Unicode.Scalar> = [" ", "\t", "\u{0B}", "\u{0C}"]
        var body = Array(line.drop { $0 == ">" || blank.contains($0) })
        while let last = body.last, blank.contains(last) { body.removeLast() }
        let allowed: Set<Unicode.Scalar> = ["|", "-", ":", " ", "\t", "\u{0B}", "\u{0C}"]
        guard body.allSatisfy(allowed.contains), body.contains("-"), body.contains("|") else { return nil }
        let parts = body.split(separator: "|", omittingEmptySubsequences: false)
        var count = parts.count
        if parts.first?.isEmpty == true { count -= 1 }
        if parts.count > 1, parts.last?.isEmpty == true { count -= 1 }
        return count
    }

    // MARK: the pieces

    private struct TooMany: Error {}

    /// The runs of `source` grouped by the block each belongs to, in order, and the kept links. Throws `TooMany` once the drawn
    /// pieces pass `most`, before a table's grid is built.
    private static func pieces(of source: AttributedString) throws -> ([Piece], [URL]) {
        var reader = Reader(source: source)
        var pieces: [Piece] = []
        var drawn = 0
        var items = Set<Int>()
        var open: Draft?

        func finish() throws {
            guard let draft = open else { return }
            open = nil
            drawn += draft.count
            if drawn > most { throw TooMany() }
            pieces.append(reader.piece(draft))
        }

        for run in source.runs {
            let components = run.presentationIntent?.components ?? []
            // A table's identity is among a cell's first three components (cell, row, table): no scan of a deep quote's depth.
            let key = components.prefix(3).first { if case .table = $0.kind { true } else { false } }?.identity
                ?? components.first?.identity
            if key == nil || key != open?.key {
                try finish()
                open = Draft(key: key, components: components, items: &items)
            }
            open?.add(run, components: components)
            if key == nil { try finish() }
        }
        try finish()
        return (pieces, reader.links)
    }

    /// The runs of one block, collected until the block's identity changes.
    private struct Draft {
        enum Kind {
            case paragraph, rule
            case heading(Int)
            case code(String?)
            case table(columns: Int)
        }

        var key: Int?
        var kind: Kind = .paragraph
        var depth = 0
        var bars = 0
        var marker: String?
        var runs: [AttributedString.Runs.Run] = []
        var cells: [Int: [Int: [AttributedString.Runs.Run]]] = [:]
        var lastRow = 0

        /// The cells the draft draws: one for a block, the grid's for a table (2.2, step 4).
        var count: Int {
            if case .table(let columns) = kind { return columns * (lastRow + 1) }
            return 1
        }

        init(key: Int?, components: [PresentationIntent.IntentType], items: inout Set<Int>) {
            self.key = key
            for (index, component) in components.enumerated() {
                switch component.kind {
                case .paragraph: break
                case .header(let level): kind = .heading(level)
                case .codeBlock(let hint):
                    kind = .code(hint?.split(whereSeparator: \.isWhitespace).first.map(String.init))
                case .thematicBreak: kind = .rule
                case .table(let columns): kind = .table(columns: columns.count)
                case .blockQuote:
                    depth += 1
                    bars += 1
                case .listItem(let ordinal):
                    depth += 1
                    // The innermost item's marker, on its first piece alone (by the item's identity).
                    let first = items.insert(component.identity).inserted
                    guard marker == nil, first else { continue }
                    var ordered = false
                    if index + 1 < components.count, case .orderedList = components[index + 1].kind { ordered = true }
                    marker = ordered ? "\(ordinal)." : "•"
                default: break
                }
            }
        }

        mutating func add(_ run: AttributedString.Runs.Run, components: [PresentationIntent.IntentType]) {
            guard case .table(let columns) = kind else {
                runs.append(run)
                return
            }
            var row = 0
            var column = 0
            for component in components {
                switch component.kind {
                case .tableRow(let index): row = index
                case .tableCell(let index): column = index
                default: break
                }
            }
            guard column < columns else { return }
            lastRow = max(lastRow, row)
            cells[row, default: [:]][column, default: []].append(run)
        }
    }

    /// Foundation's runs turned into what the view draws, and the links they keep.
    private struct Reader {
        let source: AttributedString
        var links: [URL] = []

        mutating func piece(_ draft: Draft) -> Piece {
            let opened = draft.depth > deepest
            func opening(_ text: AttributedString) -> AttributedString {
                opened ? AttributedString("…") + text : text
            }
            let body: Body
            switch draft.kind {
            case .paragraph:
                // A run with no block intent (block HTML) arrives with its own trailing line end.
                body = .paragraph(opening(trimmed(inline(draft.runs))))
            case .heading(let level):
                body = .heading(level: level, opening(inline(draft.runs)))
            case .rule:
                body = .rule
            case .code(let language):
                var text = draft.runs.map { String(source[$0.range].characters) }.joined()
                if text.last?.isNewline == true { text.removeLast() }
                body = .code(language: language, text: CodeMarks.shown(text))
            case .table(let columns):
                let rows = (0...draft.lastRow).map { row in
                    (0..<columns).map { column in inline(draft.cells[row]?[column] ?? []) }
                }
                body = .table(Table(columns: columns, rows: rows))
            }
            return Piece(depth: min(draft.depth, deepest), bars: min(draft.bars, deepest), marker: draft.marker, body: body)
        }

        private func trimmed(_ text: AttributedString) -> AttributedString {
            var text = text
            if text.characters.last?.isNewline == true { text.characters.removeLast() }
            return text
        }

        /// `runs` as styled text: emphasis, strong and strikethrough kept, a code span as `CodeSpans` draws it, a soft break as a
        /// line break, an image as `alt (url)`, a link by 2.4.
        private mutating func inline(_ runs: [AttributedString.Runs.Run]) -> AttributedString {
            var out = AttributedString()
            var image: URL?
            func closeImage() {
                if let image { out += AttributedString(" (\(image.absoluteString))") }
                image = nil
            }
            for run in runs {
                if run.imageURL != image {
                    closeImage()
                    image = run.imageURL
                }
                let intent = run.inlinePresentationIntent ?? []
                var text = String(source[run.range].characters)
                // Foundation gives an image with no alt text the object replacement character as its text.
                if image != nil, text == "\u{FFFC}" { text = "" }
                if intent.contains(.softBreak) { text = "\n" }
                var piece: AttributedString
                if intent.contains(.code) {
                    piece = AttributedString(CodeMarks.shown(text))
                    piece.font = PardnerFont.mono(size: 12.5, weight: .regular)
                    piece.backgroundColor = PardnerColor.codeInline
                } else {
                    piece = AttributedString(text)
                    let styles = intent.intersection([.emphasized, .stronglyEmphasized, .strikethrough])
                    if !styles.isEmpty { piece.inlinePresentationIntent = styles }
                }
                if let url = run.link, Self.isKept(url) {
                    if links.firstIndex(of: url) == nil { links.append(url) }
                    piece.link = links.firstIndex(of: url).flatMap { URL(string: "pardner-link:\($0)") }
                }
                out += piece
            }
            closeImage()
            return out
        }

        // MARK: links (2.4)

        /// Whether a link's address may be offered: `http` or `https`, no user or password, and a host that is a domain name
        /// (ASCII letters, digits, `-` and `.`, a dot, no empty label, a last label of letters or `xn--` and then letters, digits
        /// and `-`, and not `localhost`). Anything else, an IP address in any spelling a browser reads included, is drawn as text.
        static func isKept(_ url: URL) -> Bool {
            guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
                  url.user == nil, url.password == nil,
                  let host = url.host(percentEncoded: false)?.lowercased()
            else { return false }
            let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789-.")
            guard host.allSatisfy(allowed.contains) else { return false }
            let labels = host.split(separator: ".", omittingEmptySubsequences: false)
            guard labels.count >= 2, labels.allSatisfy({ !$0.isEmpty }), let last = labels.last, last != "localhost"
            else { return false }
            return last.count >= 2 && last.allSatisfy { $0 >= "a" && $0 <= "z" }
                || last.hasPrefix("xn--") && last.count > 4
        }
    }
}
