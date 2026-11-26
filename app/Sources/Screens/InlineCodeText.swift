// A text with its inline code spans drawn as the design draws them (#27, the reading pass): the code ground rounded by 4 with no border, reaching 5 points
// beyond the text at each side (4 of room and 1) and 1 point above and below. A `Text` run's own `backgroundColor` is square and has no padding, and a padding of
// characters would be copied with the text, so the ground is drawn behind the text from its own layout (`Text.LayoutKey`, as the mention's label is,
// `MentionedText`): each code span is its own `Text` carrying a `TextAttribute`, which the layout hands back with the span's rectangle. The room is a
// `kern` on the character before the span and on its last character, an attribute and no character, so a copy of the text holds nothing of it.
import DesignSystem
import SwiftUI

struct InlineCodeText: View {
    /// The text with its code spans' fonts set; a run that carries a `backgroundColor` is a code span, and that colour its ground.
    let text: AttributedString

    /// How far a span's ground reaches beyond the room it holds: above and below its text, and at each side on top of the padding.
    static let edge: CGFloat = 1
    /// What a span's neighbours are widened by: the padding and the edge.
    static var inset: CGFloat { PardnerMetrics.codePad + edge }

    /// A stretch of the text: a code span with its ground, or what lies between two.
    struct Piece {
        var text: AttributedString
        let ground: Color?
    }

    private struct CodeRun: TextAttribute { let ground: Color }

    /// `text` cut into its code spans and the stretches between them. A span has no square ground, and it and the character before it are widened.
    static func pieces(_ text: AttributedString) -> [Piece] {
        var pieces: [Piece] = []
        for run in text.runs {
            var slice = AttributedString(text[run.range])
            let ground = run.backgroundColor
            slice.backgroundColor = nil
            // Runs that differ in a way that does not matter here (a font fallback) stay one span.
            if let last = pieces.last, (last.ground == nil) == (ground == nil), last.ground == ground {
                pieces[pieces.count - 1] = Piece(text: last.text + slice, ground: ground)
            } else {
                pieces.append(Piece(text: slice, ground: ground))
            }
        }
        for i in pieces.indices where pieces[i].ground != nil {
            if i > 0 { widenEnd(&pieces[i - 1].text) }
            widenEnd(&pieces[i].text)
        }
        return pieces
    }

    private static func widenEnd(_ text: inout AttributedString) {
        guard !text.characters.isEmpty else { return }
        let last = text.characters.index(before: text.characters.endIndex)
        text[last..<text.endIndex].kern = inset
    }

    /// A run of a line as the layout reports it: its bounds in the text's coordinates, and the ground of the span it belongs to (nil outside a span).
    struct Fragment {
        let rect: CGRect
        let ground: Color?
    }

    /// The rectangle of each span in the text's coordinates, with its ground; a span that wraps has one per line.
    private static func grounds(_ layouts: [Text.LayoutKey.AnchoredLayout], in proxy: GeometryProxy) -> [(rect: CGRect, ground: Color)] {
        layouts.flatMap { anchored in
            let origin = proxy[anchored.origin]
            return boxes(anchored.layout.map { line in
                line.map { Fragment(rect: $0.typographicBounds.rect.offsetBy(dx: origin.x, dy: origin.y), ground: $0[CodeRun.self]?.ground) }
            })
        }
    }

    /// The ground of each span's fragment on each line. The span's right room is its last character's `kern`, which its bounds already hold; its left room
    /// is the kern of the character before it, which they do not: a fragment adds it, unless it opens its line (a span that opens the text, or the part of a
    /// wrapped span on a later line), where nothing is before it and the room would stand outside the text. A fragment that wraps on has no `kern` at its
    /// end, so it adds its right room.
    static func boxes(_ lines: [[Fragment]]) -> [(rect: CGRect, ground: Color)] {
        var out: [(rect: CGRect, ground: Color)] = []
        for (n, line) in lines.enumerated() {
            var i = 0
            while i < line.count {
                guard let ground = line[i].ground else { i += 1; continue }
                var rect = line[i].rect
                let start = i
                i += 1
                while i < line.count, line[i].ground != nil {
                    rect = rect.union(line[i].rect)
                    i += 1
                }
                let wrapsOn = i == line.count && n + 1 < lines.count && lines[n + 1].first?.ground != nil
                let left = start == 0 ? 0 : inset, right = wrapsOn ? inset : 0
                out.append((rect: CGRect(x: rect.minX - left, y: rect.minY - edge, width: rect.width + left + right, height: rect.height + 2 * edge), ground: ground))
            }
        }
        return out
    }

    var body: some View {
        let pieces = Self.pieces(text)
        Group {
            if pieces.allSatisfy({ $0.ground == nil }) {
                Text(text)
            } else {
                pieces.map { piece in
                    piece.ground.map { Text(piece.text).customAttribute(CodeRun(ground: $0)) } ?? Text(piece.text)
                }
                .reduce(Text(verbatim: ""), +)
                .backgroundPreferenceValue(Text.LayoutKey.self) { layouts in
                    GeometryReader { proxy in
                        ForEach(Array(Self.grounds(layouts, in: proxy).enumerated()), id: \.offset) { _, box in
                            RoundedRectangle(cornerRadius: PardnerMetrics.codeRadius).fill(box.ground)
                                .frame(width: box.rect.width, height: box.rect.height).position(x: box.rect.midX, y: box.rect.midY)
                        }
                    }
                }
            }
        }
        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
    }
}
