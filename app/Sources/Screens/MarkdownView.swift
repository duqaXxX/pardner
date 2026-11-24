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
            VStack(alignment: .leading, spacing: 6) {
                ForEach(pieces.indices, id: \.self) { row(pieces[$0]) }
            }
        } else {
            Text(CodeSpans.styled(text)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func row(_ piece: MarkdownBlocks.Piece) -> some View {
        let lists = max(piece.depth - piece.bars, 0)
        return HStack(alignment: .top, spacing: 0) {
            ForEach(0..<piece.bars, id: \.self) { _ in
                Rectangle().fill(PardnerColor.line).frame(width: Self.barWidth).padding(.trailing, Self.barGap)
            }
            if lists > 0 {
                Color.clear.frame(width: CGFloat(lists - 1) * Self.step, height: 0)
                // A marker such as `100.` keeps its width and pushes the text, where a fixed frame would cut it.
                Text(verbatim: piece.marker ?? "").fixedSize().padding(.trailing, 6).frame(minWidth: Self.step, alignment: .leading)
            }
            body(of: piece.body)
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

    @ViewBuilder private func body(of body: MarkdownBlocks.Body) -> some View {
        switch body {
        case .paragraph(let text):
            inline(text, size: 14, weight: .regular)
        case .heading(let level, let text):
            inline(text, size: level == 1 ? 18 : level == 2 ? 16 : 14, weight: .semibold)
        case .code(let language, let code):
            VStack(alignment: .leading, spacing: 4) {
                if let language {
                    Text(verbatim: language).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted).lineLimit(1)
                }
                ScrollView(.horizontal) {
                    Text(verbatim: code).font(PardnerFont.mono(size: 12.5, weight: .regular)).textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: true).padding(8)
                }
                .background(PardnerColor.raised, in: RoundedRectangle(cornerRadius: 6))
            }
        case .table(let table):
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                    ForEach(table.rows.indices, id: \.self) { r in
                        if r > 0 { Rectangle().fill(PardnerColor.line).frame(height: 1) }
                        GridRow {
                            ForEach(0..<table.columns, id: \.self) { c in
                                inline(table.rows[r][c], size: 14, weight: r == 0 ? .semibold : .regular)
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
