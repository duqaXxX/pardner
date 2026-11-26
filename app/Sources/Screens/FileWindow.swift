// The window a file opens in (file-content design, 3.7): the path or the name, what the bot answered or the fetch is doing, and the file as
// Markdown, as monospace text or by its name, type and size. A real window closed by its controls, never a sheet (app windows design).
import AppKit
import Conversation
import DesignSystem
import SwiftUI

/// Where a thread's rows open files from: the thread the click belongs to.
struct FilePlace {
    let channel: Data
    let thread: String
}

public struct FileWindow: View {
    let content: FileWindowContent?
    let opener: FileOpener
    @Environment(\.dismiss) private var dismiss
    /// The showing of the session this window was drawn for: its close ends that one only.
    @State private var showing: Int?

    /// The window of `content` over the opener that holds its session; nil, or a content with none, closes itself.
    public init(content: FileWindowContent?, opener: FileOpener) { (self.content, self.opener) = (content, opener) }

    public var body: some View {
        if let content, opener.showing(of: content) != nil {
            let state = opener.state(of: content)
            VStack(alignment: .leading, spacing: 0) {
                switch state {
                case .waiting(let bot): Self.status("Waiting for \(bot)\u{2026}")
                case .opening(let name): Self.status("Opening \(name)\u{2026}")
                case .message(let sentence): Self.status(sentence)
                case .unreadable: Self.status(FileWords.unreadable)
                case .file(let shown): FileBody(shown: shown)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(PardnerColor.bg)
            .background(Button("", action: { dismiss() }).keyboardShortcut(.cancelAction).opacity(0).frame(width: 0, height: 0).accessibilityHidden(true))
            .navigationTitle(Self.title(content))
            .windowMinimizeBehavior(.disabled)
            .task(id: opener.wanted(content)) { await opener.fetchWanted(content) }
            .onAppear { showing = opener.showing(of: content) }
            .onChange(of: opener.showing(of: content)) { _, new in if let new { showing = new } }
            .onDisappear { if let showing { opener.close(content, showing: showing) } }
        } else {
            // A restored or stray window is not left empty (as `ReplyWindow`).
            Color.clear.onAppear { dismiss() }
        }
    }

    static func title(_ content: FileWindowContent) -> String {
        switch content.source {
        case .path(let path): path.split(separator: "/").last.map(String.init) ?? path
        case .sent(_, let name, _, _, _): name
        }
    }

    private static func status(_ words: String) -> some View {
        Text(verbatim: words).font(PardnerFont.ui(size: 14, weight: .regular)).foregroundStyle(PardnerColor.muted)
            .frame(maxWidth: .infinity, maxHeight: .infinity).padding(PardnerMetrics.gap * 2)
    }
}

/// The file with its header: the path, the size, when it was read, and a note when it changed after the call.
private struct FileBody: View {
    let shown: FileShown

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: shown.title).font(PardnerFont.mono(size: 12, weight: .regular)).textSelection(.enabled)
                Text(verbatim: "\(ByteCountFormatter.string(fromByteCount: Int64(shown.size), countStyle: .file)) \u{00B7} Read at \(Naming.time(shown.readAt))")
                    .font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                if let changed = shown.changed {
                    Text(verbatim: "Changed after this call (modified \(Naming.time(changed)))")
                        .font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.agentText)
                }
            }
            .padding(PardnerMetrics.gap * 1.5).frame(maxWidth: .infinity, alignment: .leading)
            Divider()
            switch shown.content {
            case .markdown(let text):
                ScrollView {
                    MarkdownView(text: text, copy: { Clipboard.copy(text) }).designLines()
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(PardnerMetrics.gap * 2)
                }
            case .text(let text): MonospaceTextView(text: text)
            case .other:
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: shown.name).font(PardnerFont.ui(size: 14, weight: .semibold))
                    Text(verbatim: "\(shown.type) \u{00B7} \(ByteCountFormatter.string(fromByteCount: Int64(shown.size), countStyle: .file))")
                        .font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.muted)
                }
                .padding(PardnerMetrics.gap * 2).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }
}

/// Text in a monospace font in a scroll view that lays out lazily: 30 MB in one SwiftUI `Text` would block the main actor. Not editable, selectable.
struct MonospaceTextView: NSViewRepresentable {
    let text: String

    final class Coordinator { var shown = "" }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        context.coordinator.shown = text
        return Self.scroll(text)
    }

    static func scroll(_ text: String) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        guard let view = scroll.documentView as? NSTextView else { return scroll }
        view.isEditable = false
        view.isSelectable = true
        view.drawsBackground = false
        view.font = PardnerFont.monoCT(size: 12, weight: .regular) as NSFont
        view.textColor = NSColor(PardnerColor.text)
        view.textContainerInset = NSSize(width: PardnerMetrics.gap * 1.5, height: PardnerMetrics.gap)
        view.string = text
        scroll.drawsBackground = false
        return scroll
    }

    /// A view SwiftUI keeps for another file takes that file's text; the same text is left as it is (a redraw must not reset the scroll).
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard context.coordinator.shown != text, let view = scroll.documentView as? NSTextView else { return }
        context.coordinator.shown = text
        view.string = text
    }
}

/// A file a bot sent into a thread (`/open` typed, `share_file`): its name and size, and a click opens it in a window. Every member reads it.
struct FileRow: View {
    let title: String
    let message: Message
    let place: FilePlace?
    let opener: FileOpener?
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let size = message.files.first.map { ByteCountFormatter.string(fromByteCount: Int64($0.size), countStyle: .file) }
        if let opener, let place, let file = message.files.first {
            Button {
                let content = FileWindowContent(channel: place.channel, thread: place.thread, bot: message.sender,
                                                source: .sent(blob: file.blob, name: file.name, size: file.size, type: file.type, at: message.time))
                opener.open(content)
                openWindow(id: WindowID.file, value: content)
            } label: { label(size) }
            .buttonStyle(.clickable)
        } else {
            label(size)
        }
    }

    private func label(_ size: String?) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "doc.text").font(.system(size: 12, weight: .medium)).accessibilityHidden(true)
            Text(verbatim: title).font(PardnerFont.mono(size: 13, weight: .regular))
            if let size { Text(verbatim: size).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted) }
        }
    }
}
