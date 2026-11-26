// A bot's text with its code spans in the monospace font, everything else exactly as written. Only code spans are read (the owner,
// 2026-11-23): the rest of Markdown waits for the thread rendering design (#73), and Foundation's parser would also eat backslash
// escapes and turn `__x__` bold, so a path in an answer would differ from what the bot wrote. A fenced code block is drawn as
// written, since CommonMark never reads one as spans.
import DesignSystem
import SwiftUI

enum CodeSpans {
    /// A piece of a text: as written, or the inside of a code span.
    enum Piece: Equatable {
        case plain(String)
        case code(String)
    }

    /// CommonMark's ASCII punctuation (2.1), the characters a backslash escapes.
    private static let punctuation = Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".unicodeScalars)

    /// The longest text read for spans; a longer one is drawn as written (#73, section 7).
    static let most = 16_000

    /// `text` cut into plain pieces and code spans, by CommonMark's rules (0.31.2): fenced code blocks (4.5) and blank lines end the
    /// runs of text spans are looked for in, a backslash before a punctuation character makes it text (2.4), and in a run of text a
    /// string of backticks opens a span that the next string of the same length closes (6.1), counted by code point. Inside a span a
    /// line ending becomes a space, one space is dropped at each end when both ends have one and the inside is not only spaces, and an
    /// invisible or control code point is shown as its number (`CodeMarks`).
    static func pieces(_ text: String) -> [Piece] {
        var pieces: [Piece] = []
        func add(_ piece: Piece) {
            if case .plain(let s) = piece, case .plain(let before)? = pieces.last {
                pieces[pieces.count - 1] = .plain(before + s)
            } else {
                pieces.append(piece)
            }
        }
        var paragraph = ""
        var block = ""
        var fence: (mark: Character, length: Int)?
        func endParagraph() {
            for piece in inline(paragraph) { add(piece) }
            paragraph = ""
        }
        for (line, whole) in lines(text) {
            if let open = fence {
                block += whole
                if closes(line, open) {
                    add(.plain(block))
                    block = ""
                    fence = nil
                }
            } else if let open = opening(line) {
                endParagraph()
                fence = open
                block = whole
            } else if line.allSatisfy({ $0 == " " || $0 == "\t" }) {
                endParagraph()
                add(.plain(whole))
            } else {
                paragraph += whole
            }
        }
        endParagraph()
        if !block.isEmpty { add(.plain(block)) } // a fence never closed runs to the end
        return pieces
    }

    /// The fence a line opens: up to three spaces, then three or more backticks or tildes; a backtick fence's info has no backtick.
    private static func opening(_ line: String) -> (mark: Character, length: Int)? {
        let rest = line.drop { $0 == " " }
        guard line.count - rest.count <= 3, let mark = rest.first, mark == "`" || mark == "~" else { return nil }
        let length = rest.prefix { $0 == mark }.count
        guard length >= 3 else { return nil }
        if mark == "`", rest.dropFirst(length).contains("`") { return nil }
        return (mark, length)
    }

    /// Whether `line` closes `fence`: up to three spaces, at least as many of its marks, then only spaces.
    private static func closes(_ line: String, _ fence: (mark: Character, length: Int)) -> Bool {
        let rest = line.drop { $0 == " " }
        guard line.count - rest.count <= 3 else { return false }
        let length = rest.prefix { $0 == fence.mark }.count
        return length >= fence.length && rest.dropFirst(length).allSatisfy { $0 == " " || $0 == "\t" }
    }

    /// `text`'s lines, each without and with its own ending (CommonMark 2.1: "\r\n", "\n" or a lone "\r"), so that the endings join
    /// back into the text exactly.
    private static func lines(_ text: String) -> [(line: String, whole: String)] {
        var out: [(String, String)] = []
        var line = String.UnicodeScalarView()
        var ending = String.UnicodeScalarView()
        let scalars = Array(text.unicodeScalars)
        var i = 0
        while i < scalars.count {
            let c = scalars[i]
            if c == "\n" || c == "\r" {
                ending.append(c)
                if c == "\r", i + 1 < scalars.count, scalars[i + 1] == "\n" {
                    ending.append(scalars[i + 1])
                    i += 1
                }
                out.append((String(line), String(line) + String(ending)))
                line = String.UnicodeScalarView()
                ending = String.UnicodeScalarView()
            } else {
                line.append(c)
            }
            i += 1
        }
        if !line.isEmpty || out.isEmpty { out.append((String(line), String(line))) }
        return out
    }

    /// The spans of one run of text that holds no blank line and no fence, scanned by code point: a backtick that a combining mark
    /// follows still counts as one.
    private static func inline(_ text: String) -> [Piece] {
        let chars = Array(text.unicodeScalars)
        var pieces: [Piece] = []
        var plain = String.UnicodeScalarView()
        var i = 0
        func run(at start: Int) -> Int {
            var end = start
            while end < chars.count, chars[end] == "`" { end += 1 }
            return end - start
        }
        while i < chars.count {
            // A backslash and the ASCII punctuation it escapes are text, so `\\` lets a backtick after it open a span.
            if chars[i] == "\\", i + 1 < chars.count, Self.punctuation.contains(chars[i + 1]) {
                plain.append(chars[i])
                plain.append(chars[i + 1])
                i += 2
                continue
            }
            guard chars[i] == "`" else {
                plain.append(chars[i])
                i += 1
                continue
            }
            let length = run(at: i)
            // The closing string: the next string of exactly `length` backticks.
            var j = i + length
            var close: Int?
            while j < chars.count {
                if chars[j] == "`" {
                    let other = run(at: j)
                    if other == length {
                        close = j
                        break
                    }
                    j += other
                } else {
                    j += 1
                }
            }
            guard let close else {
                plain.append(contentsOf: chars[i..<(i + length)])
                i += length
                continue
            }
            var inside = String.UnicodeScalarView()
            var k = i + length
            while k < close {
                // A line ending, "\r\n" counted once, becomes a space.
                if chars[k] == "\r", k + 1 < close, chars[k + 1] == "\n" { k += 1 }
                inside.append(chars[k] == "\n" || chars[k] == "\r" ? " " : chars[k])
                k += 1
            }
            if inside.count >= 2, inside.first == " ", inside.last == " ", inside.contains(where: { $0 != " " }) {
                inside = String.UnicodeScalarView(inside.dropFirst().dropLast())
            }
            if !plain.isEmpty { pieces.append(.plain(String(plain))) }
            plain = String.UnicodeScalarView()
            pieces.append(.code(CodeMarks.shown(String(inside))))
            i = close + length
        }
        if !plain.isEmpty { pieces.append(.plain(String(plain))) }
        return pieces
    }

    /// `text` with its code spans in JetBrains Mono on `ground` (`raised`, or `surface` on the selected band), as the design draws them; a text over `most` as written.
    static func styled(_ text: String, ground: Color = PardnerColor.raised) -> AttributedString {
        guard text.count <= most else { return AttributedString(text) }
        var out = AttributedString()
        for piece in pieces(text) {
            switch piece {
            case .plain(let s):
                out += AttributedString(s)
            case .code(let s):
                var code = AttributedString(s)
                code.font = PardnerFont.mono(size: 12.5, weight: .regular)
                code.backgroundColor = ground
                out += code
            }
        }
        return out
    }
}
