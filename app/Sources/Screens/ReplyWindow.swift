// The window a reply opens in (turn work C1, design 3.4): an agent's reply, or a message line's body, read whole as a bot's text is
// drawn, with Copy. A real window closed by its controls, never a sheet (app windows design).
import Conversation
import DesignSystem
import SwiftUI

/// What a reply's window shows: its title and the whole `output`, its Markdown as written.
public struct ReplyContent: Codable, Hashable, Sendable {
    let title: String
    let output: String

    /// The window of a message line; nil for a line with no message or no output.
    init?(_ f: LineFields) {
        guard f.message, let output = f.output else { return nil }
        (title, self.output) = (LineForm(f).words ?? f.title, output)
    }
}

public struct ReplyWindow: View {
    let content: ReplyContent?
    @Environment(\.dismiss) private var dismiss

    public init(content: ReplyContent?) { self.content = content }

    public var body: some View {
        if let content {
            VStack(spacing: 0) {
                ScrollView {
                    MarkdownView(text: content.output, copy: { Clipboard.copy(content.output) }).designLines()
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(PardnerMetrics.gap * 2)
                }
                Divider()
                HStack {
                    Spacer()
                    Button("Copy") { Clipboard.copy(content.output) }.pointerStyle(.link)
                }
                .padding(PardnerMetrics.gap)
            }
            .background(PardnerColor.bg)
            .background(Button("", action: { dismiss() }).keyboardShortcut(.cancelAction).opacity(0).frame(width: 0, height: 0).accessibilityHidden(true))
            .navigationTitle(content.title)
            .windowMinimizeBehavior(.disabled)
        } else {
            // A restored or stray window is not left empty (as `WindowRoot`).
            Color.clear.onAppear { dismiss() }
        }
    }
}
