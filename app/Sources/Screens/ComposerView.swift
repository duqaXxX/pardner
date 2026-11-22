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
            // After the update: the request is cleared in the model, which this pass must not change.
            DispatchQueue.main.async {
                view.window?.makeFirstResponder(view)
                view.setSelectedRange(NSRange(location: (view.string as NSString).length, length: 0))
                model.focusTaken()
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
                HStack(alignment: .top, spacing: PardnerMetrics.gap) {
                    if let label = model.label {
                        Text("@" + model.name(of: label))
                            .font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.agentText)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(PardnerColor.agentSoft, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
                    }
                    ZStack(alignment: .topLeading) {
                        if model.text.isEmpty {
                            Text(model.thread == nil ? "Message the channel, or type @ to mention a bot" : "Reply in the thread")
                                .foregroundStyle(PardnerColor.muted).allowsHitTesting(false)
                        }
                        ComposerField(model: model, height: $height).id("\(model.channel.base64EncodedString())/\(model.thread ?? "")").frame(height: height)
                    }
                }
                .padding(PardnerMetrics.gap)
                Rectangle().fill(PardnerColor.line).frame(height: 1)
                // The hint goes first when the box is wide enough for it; the buttons stay. Files are refused (`pasteRefused`), so there is no attach button.
                ViewThatFits(in: .horizontal) {
                    buttons(hint: true)
                    buttons(hint: false)
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
        .padding(PardnerMetrics.gap * 2)
    }
}

extension ComposerView {
    /// The row under the field: the mention button at the left, then at the right the hint when `hint` and the send button.
    private func buttons(hint: Bool) -> some View {
        HStack(spacing: PardnerMetrics.gap) {
            // A thread's `@` is plain text, so only a channel's composer has the button.
            if model.thread == nil {
                Button { model.startMention() } label: { Image(systemName: "at").frame(width: 30, height: 30).contentShape(Rectangle()) }
                    .buttonStyle(.plain).foregroundStyle(PardnerColor.muted).pointerStyle(model.canMention ? .link : nil).disabled(!model.canMention)
                    .help("Mention a bot").accessibilityLabel("Mention a bot")
            }
            Spacer(minLength: 0)
            if hint {
                Text("Return to send, Shift-Return for a new line").font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted).lineLimit(1).fixedSize()
            }
            Button { model.submit() } label: {
                Image(systemName: "arrow.up").font(.system(size: 13, weight: .semibold)).foregroundStyle(PardnerColor.brandInk)
                    .frame(width: 38, height: 30).background(PardnerColor.brand, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
                    .opacity(model.sendOff ? 0.4 : 1).contentShape(Rectangle())
            }
            .buttonStyle(.plain).pointerStyle(model.sendOff ? nil : .link).disabled(model.sendOff).help("Send").accessibilityLabel("Send")
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

    var body: some View {
        ForEach(model.rows()) { row in
            HStack(alignment: .top, spacing: PardnerMetrics.gap * 1.5) {
                Avatar(name: "You", isBot: false, icon: nil, size: MessageRow.markSize)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: PardnerMetrics.gap) {
                        Text("You").font(PardnerFont.ui(size: 14, weight: .semibold))
                    }
                    mentioned(row.to.map { "@" + model.name(of: $0) }, row.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
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
