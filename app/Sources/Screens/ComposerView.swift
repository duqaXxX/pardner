// The composer under a conversation (composer design 2): a field two lines high that grows to eight, a label and the bot list for a channel's, the line
// under it for what it refused, and the rows of the messages on their way. The decisions are `ComposerModel`'s; this draws them and passes keys.
import AppKit
import Conversation
import DesignSystem
import SwiftUI

/// The field: an `NSTextView` in a scroll view, since Return, Shift-Return, marked text, a paste or drop of a file and Backspace at the start are its
/// events. The view is made again for each composer (`.id` at its use), so that no undo history carries one composer's text into another's.
struct ComposerField: NSViewRepresentable {
    let model: ComposerModel
    @Binding var height: CGFloat

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        let view = ComposerTextView()
        view.delegate = context.coordinator
        view.coordinator = context.coordinator
        view.drawsBackground = false
        view.isRichText = false
        view.allowsUndo = true
        // Inter 14, as the messages above it.
        view.font = PardnerFont.uiCT(size: 14, weight: .regular) as NSFont
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        view.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        view.registerForDraggedTypes([.fileURL])
        model.hasMarkedText = false
        scroll.documentView = view
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        return scroll
    }

    static func dismantleNSView(_ scroll: NSScrollView, coordinator: Coordinator) { coordinator.parent.model.hasMarkedText = false }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let view = scroll.documentView as? NSTextView else { return }
        context.coordinator.parent = self
        view.isEditable = model.availability == .ready
        if view.string != model.text, !view.hasMarkedText() {
            view.string = model.text
            // The model replaced the text (a send, a pick, a restore): what was typed before is no longer what an undo would undo.
            view.undoManager?.removeAllActions(withTarget: view)
            view.undoManager?.removeAllActions()
        }
        view.textColor = NSColor(PardnerColor.text)
        if model.focusRequested {
            // After the update: the request is cleared in the model, which this pass must not change. A second pass before it runs queues a
            // second block, which finds the request gone and does nothing, so the palette opens once.
            DispatchQueue.main.async {
                guard model.focusRequested else { return }
                let palette = model.paletteRequested
                model.focusTaken()
                view.window?.makeFirstResponder(view)
                if palette {
                    // The emoji button: the system palette types where the caret or the selection is.
                    NSApp.orderFrontCharacterPalette(view)
                } else {
                    view.setSelectedRange(NSRange(location: (view.string as NSString).length, length: 0))
                }
            }
        }
        DispatchQueue.main.async { context.coordinator.measure(view) }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerField
        init(_ parent: ComposerField) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            parent.model.edited(view.string)
            parent.model.hasMarkedText = view.hasMarkedText()
            measure(view)
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            let model = parent.model
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                let shift = NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false
                return model.returnPressed(shift: shift, marked: textView.hasMarkedText())
            case #selector(NSResponder.moveUp(_:)) where model.picking:
                model.movePick(-1)
                return true
            case #selector(NSResponder.moveDown(_:)) where model.picking:
                model.movePick(1)
                return true
            case #selector(NSResponder.insertTab(_:)) where model.picking:
                return model.pickHighlighted()
            case #selector(NSResponder.cancelOperation(_:)) where model.picking:
                model.closePicker()
                return true
            case #selector(NSResponder.deleteBackward(_:)):
                return textView.selectedRange() == NSRange(location: 0, length: 0) && model.backspaceAtStart()
            default:
                return false
            }
        }

        /// The field's height: two lines at rest, its lines up to eight, then the scroll view scrolls.
        func measure(_ view: NSTextView) {
            guard let layout = view.layoutManager, let container = view.textContainer else { return }
            layout.ensureLayout(for: container)
            let line = layout.defaultLineHeight(for: view.font ?? NSFont.systemFont(ofSize: 14))
            let wanted = min(max(layout.usedRect(for: container).height, line * 2), line * 8)
            if abs(parent.height - wanted) > 0.5 { parent.height = wanted }
        }
    }
}

/// An `NSTextView` that refuses a pasted or dropped file, and a pasted image, and says so.
final class ComposerTextView: NSTextView {
    weak var coordinator: ComposerField.Coordinator?

    /// A file URL on a pasteboard (Finder also puts the file's name there as a string), or an image with no text beside it.
    static func holdsFile(_ board: NSPasteboard) -> Bool {
        board.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
            || (board.availableType(from: [.png, .tiff]) != nil && board.string(forType: .string) == nil)
    }

    override func resignFirstResponder() -> Bool {
        coordinator?.parent.model.hasMarkedText = false
        return super.resignFirstResponder()
    }

    override func paste(_ sender: Any?) {
        if Self.holdsFile(.general) {
            coordinator?.parent.model.pasteRefused()
            return
        }
        pasteAsPlainText(sender)
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        Self.holdsFile(sender.draggingPasteboard) ? [] : super.draggingEntered(sender)
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        if Self.holdsFile(sender.draggingPasteboard) {
            coordinator?.parent.model.pasteRefused()
            return true
        }
        return super.performDragOperation(sender)
    }
}

struct ComposerView: View {
    let model: ComposerModel
    @State private var height: CGFloat = 34

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.picking {
                BotList(model: model)
            }
            if let line = model.disabledLine {
                Text(line).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
            }
            VStack(spacing: 0) {
                if model.formatting {
                    FormattingRow()
                    Rectangle().fill(PardnerColor.line).frame(height: 1)
                }
                HStack(alignment: .top, spacing: PardnerMetrics.gap) {
                    if let label = model.label {
                        Text("@" + model.name(of: label))
                            .font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.agentText)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(PardnerColor.agentSoft, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
                    }
                    ZStack(alignment: .topLeading) {
                        if model.text.isEmpty {
                            Text(model.placeholder).foregroundStyle(PardnerColor.muted).lineLimit(1).allowsHitTesting(false)
                        }
                        ComposerField(model: model, height: $height).id("\(model.channel.base64EncodedString())/\(model.thread ?? "")").frame(height: height)
                    }
                }
                .padding(.vertical, model.thread == nil ? 12 : 10).padding(.horizontal, model.thread == nil ? 14 : 12)
                Rectangle().fill(PardnerColor.line).frame(height: 1)
                // The hint goes first when the box is wide enough for it, then the Commands button's word; the buttons stay.
                ViewThatFits(in: .horizontal) {
                    buttons(hint: true, commandsWord: true)
                    buttons(hint: false, commandsWord: true)
                    buttons(hint: false, commandsWord: false)
                }
                .padding(.horizontal, PardnerMetrics.gap).padding(.vertical, 6)
            }
            .opacity(model.availability == .ready ? 1 : 0.5)
            .background(PardnerColor.surface, in: RoundedRectangle(cornerRadius: PardnerMetrics.containerRadius))
            .overlay(RoundedRectangle(cornerRadius: PardnerMetrics.containerRadius).stroke(PardnerColor.line))
            if let notice = model.notice {
                Text(notice).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.delText).fixedSize(horizontal: false, vertical: true)
            }
        }
        // A card standing on its own under the messages, with no rule above it: wider margins in the conversation than in the thread panel.
        // The top keeps a scrolled message off the card's border.
        .padding(.horizontal, model.thread == nil ? 24 : 16).padding(.top, 8).padding(.bottom, 20)
    }
}

extension ComposerView {
    /// The row under the field, as the design and the reference composer (#112) lay it out: attach, formatting, emoji, mention, video,
    /// audio and commands at the left, then the hint when `hint` and the send button. What does not work yet is drawn off, with the reason
    /// as its help, so that the row keeps its places as each one comes (#41, #42 and the issues #112 names).
    private func buttons(hint: Bool, commandsWord: Bool) -> some View {
        HStack(spacing: 2) {
            ComposerTool(symbol: "plus", label: "Attach a file", off: "Attachments are not available yet")
            ComposerTool(symbol: "textformat", label: model.formatting ? "Hide formatting" : "Show formatting", chosen: model.formatting) { model.formatting.toggle() }
            ComposerTool(symbol: "face.smiling", label: "Emoji", off: model.availability == .ready ? nil : "") { model.startEmoji() }
            // A thread's `@` is plain text, so only a channel's composer opens the bot list.
            ComposerTool(symbol: "at", label: "Mention a bot",
                         off: model.thread != nil ? "In a thread, @ is plain text" : model.canMention ? nil : "") { model.startMention() }
            ComposerTool(symbol: "video", label: "Record a video", off: "Video messages are not available yet")
            ComposerTool(symbol: "mic", label: "Record an audio message", off: "Audio messages are not available yet")
            CommandsButton(word: commandsWord)
            Spacer(minLength: PardnerMetrics.gap)
            if hint {
                Text("Return to send, Shift-Return for a new line").font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted).lineLimit(1).fixedSize()
                    .padding(.horizontal, 6)
            }
            Button { model.submit() } label: {
                Image(systemName: "arrow.up").font(.system(size: 13, weight: .semibold)).foregroundStyle(PardnerColor.brandInk)
                    .frame(width: 38, height: 30).background(PardnerColor.brand, in: RoundedRectangle(cornerRadius: 8))
                    .opacity(model.sendOff ? 0.4 : 1).contentShape(Rectangle())
            }
            .buttonStyle(.plain).pointerStyle(model.sendOff ? nil : .link).disabled(model.sendOff).help("Send").accessibilityLabel("Send")
        }
    }
}

/// One icon button of the composer: on with `action`; off while the composer cannot take it (an empty `off`); or, with a reason in
/// `off`, a tool that is not there yet, drawn as a dimmed icon with the reason as its help, since a disabled button may show no help.
struct ComposerTool: View {
    let symbol: String
    let label: String
    var off: String?
    var chosen = false
    var action: () -> Void = {}

    var body: some View {
        if let reason = off, !reason.isEmpty {
            icon.opacity(0.45).help(reason)
                .accessibilityElement(children: .ignore).accessibilityAddTraits(.isButton).accessibilityLabel(label).accessibilityHint(reason)
        } else {
            Button(action: action) { icon }
                .buttonStyle(.plain).disabled(off != nil).opacity(off != nil ? 0.45 : 1)
                .pointerStyle(off != nil ? nil : .link).help(label).accessibilityLabel(label)
        }
    }

    private var icon: some View {
        Image(systemName: symbol).font(.system(size: 14, weight: .regular)).foregroundStyle(PardnerColor.muted)
            .frame(width: 28, height: 28)
            .background(chosen ? PardnerColor.raised : .clear, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
            .contentShape(Rectangle())
    }
}

/// The Commands button: `/` and its word, a tool that is not there yet until the app has the bot's list of commands to show.
struct CommandsButton: View {
    let word: Bool

    var body: some View {
        HStack(spacing: 6) {
            Text("/").foregroundStyle(PardnerColor.muted)
            if word { Text("Commands") }
        }
        .font(PardnerFont.ui(size: 13, weight: .medium))
        .padding(.horizontal, word ? 10 : 9).frame(height: 28)
        .overlay(RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius).stroke(PardnerColor.line))
        .contentShape(Rectangle())
        .opacity(0.45)
        .help("The list of commands is not available yet")
        .accessibilityElement(children: .ignore).accessibilityAddTraits(.isButton)
        .accessibilityLabel("Commands").accessibilityHint("The list of commands is not available yet")
        .padding(.leading, 4)
    }
}

/// The formatting row: bold to code block, as the reference composer orders them, all off until the app renders Markdown (#73).
struct FormattingRow: View {
    private static let tools: [(String, String)] = [
        ("bold", "Bold"), ("italic", "Italic"), ("underline", "Underline"), ("strikethrough", "Strikethrough"), ("paragraphsign", "Paragraph style"),
        ("link", "Link"), ("list.number", "Numbered list"), ("list.bullet", "Bulleted list"), ("text.quote", "Quote"),
        ("chevron.left.forwardslash.chevron.right", "Code"), ("curlybraces", "Code block"),
    ]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            row(Self.tools)
            ScrollView(.horizontal, showsIndicators: false) { row(Self.tools) }
        }
        .padding(.horizontal, PardnerMetrics.gap).padding(.vertical, 4)
    }

    private func row(_ tools: [(String, String)]) -> some View {
        HStack(spacing: 2) {
            ForEach(tools, id: \.0) { tool in
                ComposerTool(symbol: tool.0, label: tool.1, off: "Formatting is not available yet")
            }
            Spacer(minLength: 0)
        }
    }
}

/// The person's active bots that match what follows the `@`, under the field, while it waits for a pick.
struct BotList: View {
    let model: ComposerModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(model.matches().enumerated()), id: \.element.id) { index, choice in
                Button { model.pick(choice.id) } label: {
                    Text(verbatim: choice.shown).frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, PardnerMetrics.gap).padding(.vertical, 6)
                        .background(index == model.pickIndex ? PardnerColor.raised : .clear)
                }
                .buttonStyle(.plain).pointerStyle(.link)
            }
        }
        .background(PardnerColor.surface, in: RoundedRectangle(cornerRadius: PardnerMetrics.containerRadius))
        .overlay(RoundedRectangle(cornerRadius: PardnerMetrics.containerRadius).stroke(PardnerColor.line))
    }
}

/// The messages on their way, in place at the end of the conversation or the thread.
struct PendingRows: View {
    let model: ComposerModel
    var mark = MessageRow.Mark.conversation

    var body: some View {
        ForEach(model.rows()) { row in
            HStack(alignment: .top, spacing: mark.gap) {
                Avatar(name: "You", isBot: false, icon: nil, size: mark.size)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: PardnerMetrics.gap) {
                        Text("You").font(PardnerFont.ui(size: 14, weight: .semibold))
                    }
                    .designLines()
                    mentioned(row.to.map { "@" + model.name(of: $0) }, row.text).designLines().textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    switch row.status {
                    case .sending: line("Sending\u{2026}", PardnerColor.muted)
                    case .sent: EmptyView()
                    case .notSent(let why):
                        line("Not sent.", PardnerColor.delText)
                        line(why, PardnerColor.delText)
                    case .notDelivered: line("Not delivered.", PardnerColor.delText)
                    }
                }
                if row.status.canDismiss {
                    Spacer(minLength: 0)
                    Button { model.dismiss(row.id) } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)) }
                        .buttonStyle(.plain).pointerStyle(.link).foregroundStyle(PardnerColor.muted).accessibilityLabel("Dismiss")
                }
            }
        }
    }

    private func line(_ text: String, _ color: Color) -> some View {
        Text(text).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(color)
    }
}
