// The composer under a conversation (composer design 2): a field two lines high that grows to eight, a label and the bot list for a channel's, the line
// under it for what it refused, and the rows of the messages on their way. The decisions are `ComposerModel`'s; this draws them and passes keys.
import AppKit
import Conversation
import DesignSystem
import SwiftUI

/// The field: an `NSTextView` in a scroll view, since Return, Shift-Return, marked text, a paste or drop of a file and Backspace at the start are its
/// events. It holds rich text and the model holds its Markdown (`ComposerMarkdown`). The view is made again for each composer (`.id` at its use), so
/// that no undo history carries one composer's text into another's.
struct ComposerField: NSViewRepresentable {
    let model: ComposerModel
    @Binding var height: CGFloat
    /// How far the field is scrolled, which the chip over its first line follows.
    @Binding var scroll: CGFloat
    /// The room of the bot's chip, which the first line of the text starts after.
    var indent: CGFloat = 0

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        let view = ComposerTextView()
        view.delegate = context.coordinator
        view.coordinator = context.coordinator
        view.firstLineIndent = indent
        model.format = { [weak view, weak coordinator = context.coordinator] format, url in
            guard let view, let coordinator, view.isEditable else { return }
            view.window?.makeFirstResponder(view)
            view.apply(format, url: url)
            coordinator.refreshActive(view)
        }
        view.drawsBackground = false
        view.isRichText = true
        view.importsGraphics = false
        // No Font menu, and no font panel to carry a font or a colour in: the field's marks are its tools'.
        view.usesFontPanel = false
        view.allowsUndo = true
        // Inter 14, as the messages above it.
        view.typingAttributes = ComposerMarkdown.base(firstLineIndent: indent)
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
        scroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(context.coordinator, selector: #selector(Coordinator.clipMoved(_:)), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
        return scroll
    }

    static func dismantleNSView(_ scroll: NSScrollView, coordinator: Coordinator) {
        coordinator.parent.model.hasMarkedText = false
        NotificationCenter.default.removeObserver(coordinator)
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let view = scroll.documentView as? NSTextView else { return }
        context.coordinator.parent = self
        view.isEditable = model.availability == .ready
        let coordinator = context.coordinator
        // The Markdown the view holds is what it last told the model or what the model last gave it, so that no pass turns a text into rich text and back.
        if model.text != coordinator.synced, !view.hasMarkedText() {
            let wasEmpty = view.string.isEmpty
            coordinator.synced = model.text
            view.textStorage?.setAttributedString(model.textRestored ? ComposerMarkdown.restored(from: model.text) : ComposerMarkdown.plain(model.text))
            coordinator.restyle(view)
            // The text took the empty field (the guess, a restore): the caret is after it.
            if wasEmpty { view.setSelectedRange(NSRange(location: (view.string as NSString).length, length: 0)) }
            // The model replaced the text (a send, a pick, a restore): what was typed before is no longer what an undo would undo.
            view.undoManager?.removeAllActions(withTarget: view)
            view.undoManager?.removeAllActions()
        }
        (view as? ComposerTextView)?.firstLineIndent = indent
        if coordinator.restyled != indent { coordinator.restyle(view) }
        let ink = NSColor(PardnerColor.text)
        if view.textColor != ink { view.textColor = ink }
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
        /// The Markdown the view and the model last agreed on.
        var synced = ""
        /// The chip's room the text is styled for.
        var restyled: CGFloat = 0
        init(_ parent: ComposerField) { self.parent = parent }

        /// Tells the view how far the text is scrolled, so that the chip over its first line goes with it.
        /// The notification comes while the scroll view lays out, where SwiftUI state is not written: `measure` defers its height the same way.
        @MainActor @objc func clipMoved(_ notification: Notification) {
            let offset = (notification.object as? NSClipView)?.bounds.origin.y ?? 0
            DispatchQueue.main.async { [self] in scrolled(to: offset) }
        }

        func scrolled(to offset: CGFloat) {
            if parent.scroll != offset { parent.scroll = offset }
        }

        /// Styles the text for the chip's room, and an empty field's typing attributes with it, which a deleted text resets.
        @MainActor func restyle(_ view: NSTextView) {
            guard let storage = view.textStorage, !view.hasMarkedText() else { return }
            restyled = parent.indent
            ComposerMarkdown.style(storage, firstLineIndent: parent.indent)
            if storage.length == 0 { view.typingAttributes = ComposerMarkdown.base(firstLineIndent: parent.indent) }
            // A marker or a bar is drawn from the whole text, so that an edit renumbers the items below it.
            view.needsDisplay = true
        }

        /// The row's tools that are on at the caret.
        @MainActor func refreshActive(_ view: NSTextView) {
            guard let view = view as? ComposerTextView else { return }
            let now = view.activeFormats()
            if now != parent.model.active { parent.model.active = now }
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            if let view = notification.object as? NSTextView { refreshActive(view) }
        }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            restyle(view)
            if let storage = view.textStorage { synced = ComposerMarkdown.markdown(from: storage) }
            parent.model.edited(synced)
            refreshActive(view)
            parent.model.hasMarkedText = view.hasMarkedText()
            measure(view)
        }

        /// A click on a link in the field is no opening of it: the link is text being edited.
        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool { true }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            let model = parent.model
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                let shift = NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false
                if model.returnPressed(shift: shift, marked: textView.hasMarkedText()) { return true }
                // Shift-Return: the field's own newline carries a list item or a code line on; the cases it does not are the field's to handle.
                guard !textView.hasMarkedText(), (textView as? ComposerTextView)?.insertLineInBlock() == true else { return false }
                refreshActive(textView)
                return true
            case #selector(NSResponder.moveUp(_:)) where model.picking:
                model.movePick(-1)
                return true
            case #selector(NSResponder.moveDown(_:)) where model.picking:
                model.movePick(1)
                return true
            case #selector(NSResponder.insertTab(_:)) where model.picking:
                return model.pickHighlighted()
            // The bot's guess at the next prompt takes the empty field, which has no caret to move.
            case #selector(NSResponder.insertTab(_:)), #selector(NSResponder.moveRight(_:)):
                return model.takeSuggestion()
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
            let line = layout.defaultLineHeight(for: ComposerMarkdown.font(strong: false, emphasis: false, code: false, block: nil))
            let wanted = min(max(layout.usedRect(for: container).height, line * 2), line * 8)
            if abs(parent.height - wanted) > 0.5 { parent.height = wanted }
            // A field made again for another composer starts at the top, with no notice of it.
            scrolled(to: view.enclosingScrollView?.contentView.bounds.origin.y ?? 0)
        }
    }
}

/// An `NSTextView` that refuses a pasted or dropped file, and a pasted image, and says so.
final class ComposerTextView: NSTextView {
    weak var coordinator: ComposerField.Coordinator?
    /// The room the first line of the text leaves for the bot's chip, which a tool needs to write a paragraph's style.
    var firstLineIndent: CGFloat = 0

    override func drawBackground(in rect: NSRect) {
        super.drawBackground(in: rect)
        drawBlockMarks()
    }

    /// Command-B and Command-I, which the field's text has no menu item for.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // Caps Lock, the numeric pad and the function key are no part of the shortcut.
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
        guard isEditable, window?.firstResponder === self, flags == .command,
              let format = [("b", ComposerFormat.strong), ("i", .emphasis)].first(where: { $0.0 == event.charactersIgnoringModifiers?.lowercased() })?.1
        else { return super.performKeyEquivalent(with: event) }
        coordinator?.parent.model.format(format, nil)
        return true
    }

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
        pasteAsPlainText(sender)
    }

    override func pasteAsRichText(_ sender: Any?) {
        pasteAsPlainText(sender)
    }

    /// The text of a paste or a drop without the U+FFFC a picture stands for, so that the bot never gets that character; nil for a picture alone.
    static func withoutPictures(_ text: String) -> String? {
        guard text.contains("\u{FFFC}") else { return text }
        let rest = text.replacingOccurrences(of: "\u{FFFC}", with: "")
        return rest.contains(where: { !$0.isWhitespace }) ? rest : nil
    }

    /// Every paste is plain text as typed: a file or a picture alone is refused. A text with a picture in it goes in without the picture, through the
    /// field's own change cycle as one undo step, and with no automatic substitution, as a paste does.
    override func pasteAsPlainText(_ sender: Any?) {
        let board = NSPasteboard.general
        guard !Self.holdsFile(board) else {
            coordinator?.parent.model.pasteRefused()
            return
        }
        guard let string = board.string(forType: .string), string.contains("\u{FFFC}"), let storage = textStorage else {
            super.pasteAsPlainText(sender)
            return
        }
        guard let text = Self.withoutPictures(string) else {
            coordinator?.parent.model.pasteRefused()
            return
        }
        let range = selectedRange()
        guard shouldChangeText(in: range, replacementString: text) else { return }
        breakUndoCoalescing()
        storage.replaceCharacters(in: range, with: NSAttributedString(string: text, attributes: typingAttributes))
        didChangeText()
        undoManager?.setActionName("Paste")
        setSelectedRange(NSRange(location: range.location + (text as NSString).length, length: 0))
        scrollRangeToVisible(selectedRange())
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        Self.holdsFile(sender.draggingPasteboard) ? [] : super.draggingEntered(sender)
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        if Self.holdsFile(sender.draggingPasteboard) {
            coordinator?.parent.model.pasteRefused()
            return true
        }
        // Text from another view goes in as plain text at the drop point, with none of the formatting it carries but the block it lands in; a drag inside
        // the field is its own.
        if let storage = textStorage, sender.draggingSource as AnyObject? !== self, let string = sender.draggingPasteboard.string(forType: .string) {
            guard let text = Self.withoutPictures(string) else {
                coordinator?.parent.model.pasteRefused()
                return true
            }
            let range = NSRange(location: characterIndexForInsertion(at: convert(sender.draggingLocation, from: nil)), length: 0)
            guard shouldChangeText(in: range, replacementString: text) else { return false }
            let dropped = NSMutableAttributedString(attributedString: ComposerMarkdown.plain(text))
            // At the end the drop point is the last paragraph: its block when it has text, the caret's only when the caret is there too.
            let end = range.location == storage.length
            let lastHasText = end && storage.length > 0 && (storage.string as NSString).character(at: storage.length - 1) != 0x0A
            let block = !end ? ComposerMarkdown.block(in: storage, at: range.location)
                : lastHasText ? ComposerMarkdown.block(in: storage, at: storage.length - 1)
                : selectedRange().location == storage.length ? (typingAttributes[.composerBlock] as? String).flatMap(ComposerMarkdown.Block.init) : nil
            if let block { dropped.addAttribute(.composerBlock, value: block.rawValue, range: NSRange(location: 0, length: dropped.length)) }
            storage.replaceCharacters(in: range, with: dropped)
            didChangeText()
            setSelectedRange(NSRange(location: range.location + (text as NSString).length, length: 0))
            return true
        }
        return super.performDragOperation(sender)
    }
}

/// The grey text in an empty field: the bot's suggestion on up to the field's two lines (step F design FB, 3.2), the placeholder on one. The suggestion is
/// set in italic with a `Tab` key cap after it, so that it does not read as the placeholder; `indent` keeps the first line after the bot's chip.
struct ComposerHint: View {
    let suggestion: String?
    let placeholder: String
    var indent: CGFloat = 0

    var body: some View {
        HStack(alignment: .lastTextBaseline, spacing: 6) {
            // An empty image of the chip's width: the one way a `Text` indents its first line alone.
            (indent > 0 ? Text(Image(nsImage: NSImage(size: NSSize(width: indent, height: 1)))) : Text(verbatim: ""))
                + (suggestion.map { Text(verbatim: $0).font(PardnerFont.ui(size: 14, weight: .regular, italic: true)) } ?? Text(verbatim: placeholder))
            if suggestion != nil {
                Text("Tab").font(PardnerFont.ui(size: 11, weight: .medium)).padding(.horizontal, 5).padding(.vertical, 1)
                    .background(PardnerColor.raised, in: RoundedRectangle(cornerRadius: 4))
                    .overlay(RoundedRectangle(cornerRadius: 4).stroke(PardnerColor.line))
            }
        }
        .foregroundStyle(PardnerColor.muted).lineLimit(suggestion == nil ? 1 : 2).allowsHitTesting(false)
    }
}

struct ComposerView: View {
    let model: ComposerModel
    @State private var height: CGFloat = 34
    @State private var chipWidth: CGFloat = 0
    @State private var scroll: CGFloat = 0

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
                    FormattingRow(model: model)
                    Rectangle().fill(PardnerColor.line).frame(height: 1)
                }
                // The chip is laid over the field, and the text's first line starts after it and its next lines under it (#167).
                let indent = model.label == nil ? 0 : chipWidth + PardnerMetrics.gap
                ZStack(alignment: .topLeading) {
                    if model.text.isEmpty {
                        ComposerHint(suggestion: model.suggestion, placeholder: model.placeholder, indent: indent)
                    }
                    ComposerField(model: model, height: $height, scroll: $scroll, indent: indent).id("\(model.channel.base64EncodedString())/\(model.thread ?? "")").frame(height: height)
                    if let label = model.label {
                        Text("@" + model.name(of: label))
                            .font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.agentText)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(PardnerColor.agentSoft, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
                            .onGeometryChange(for: CGFloat.self, of: \.size.width) { chipWidth = $0 }
                            .offset(y: -scroll)
                            .allowsHitTesting(false)
                    }
                }
                .clipped()
                .padding(.vertical, 12).padding(.horizontal, 14)
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
        // A card standing on its own under the messages, with no rule above it, the same in the conversation and in the thread panel so that the
        // two cards' lower borders sit at one height. The top keeps a scrolled message off the card's border.
        .padding(.horizontal, PardnerMetrics.margin).padding(.top, 8).padding(.bottom, PardnerMetrics.margin)
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
                Text("Return to send").font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted).lineLimit(1).fixedSize()
                    .padding(.horizontal, 6)
            }
            Button { model.submit() } label: {
                // Filled in the brand colour while Return would send, a grey chip while it would not.
                Image(systemName: "arrow.up").font(.system(size: 13, weight: .semibold)).foregroundStyle(model.sendOff ? PardnerColor.muted : PardnerColor.brandInk)
                    .frame(width: 38, height: 30).background(model.sendOff ? PardnerColor.raised : PardnerColor.brand, in: RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.clickable).disabled(model.sendOff).help("Send").accessibilityLabel("Send")
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
            // A tool that is not there yet is drawn as the others are (#174); its help says why it does nothing.
            icon.help(reason)
                .accessibilityElement(children: .ignore).accessibilityAddTraits(.isButton).accessibilityLabel(label).accessibilityHint(reason)
        } else {
            Button(action: action) { icon }
                .buttonStyle(.clickable).disabled(off != nil).opacity(off != nil ? 0.45 : 1)
                .help(label).accessibilityLabel(label)
        }
    }

    /// Outlined, in the one grey. The system's `face.smiling` is drawn filled in the dark appearance (offscreen render, 2026-11-26, in the dark
    /// appearance only), so the emoji's outline is drawn by `EmojiOutline`, as the reference draws it.
    @ViewBuilder private var glyph: some View {
        if symbol == "face.smiling" {
            EmojiOutline().stroke(style: StrokeStyle(lineWidth: 1.2, lineCap: .round)).frame(width: 14, height: 14)
        } else {
            Image(systemName: symbol).font(.system(size: 14, weight: .regular))
        }
    }

    var icon: some View {
        glyph
            .foregroundStyle(PardnerColor.muted)
            .frame(width: 28, height: 28)
            .background(chosen ? PardnerColor.raised : .clear, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
            .contentShape(Rectangle())
    }
}

/// A face in a circle on the reference's 16 point grid: the circle, the smile and two eyes.
struct EmojiOutline: Shape {
    func path(in rect: CGRect) -> Path {
        let k = min(rect.width, rect.height) / 16
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * k, y: rect.minY + y * k) }
        var path = Path()
        path.addEllipse(in: CGRect(origin: point(2, 2), size: CGSize(width: 12 * k, height: 12 * k)))
        path.addArc(center: point(8, 7.84), radius: 3 * k, startAngle: .degrees(33.6), endAngle: .degrees(146.4), clockwise: false)
        for x in [6, 10] as [CGFloat] {
            path.move(to: point(x, 6.3))
            path.addLine(to: point(x, 6.7))
        }
        return path
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

/// The formatting row: bold to code block, as the reference composer orders them. A tool runs on the field through `ComposerModel.format`; the ones on at its
/// caret are drawn chosen. Paragraph style is a menu, and a link asks its address in a popover.
struct FormattingRow: View {
    let model: ComposerModel
    @State private var linking = false

    private var off: String? { model.availability == .ready ? nil : "" }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            row
            ScrollView(.horizontal, showsIndicators: false) { row }
        }
        .padding(.horizontal, PardnerMetrics.gap).padding(.vertical, 4)
    }

    private func tool(_ symbol: String, _ label: String, _ format: ComposerFormat) -> some View {
        ComposerTool(symbol: symbol, label: label, off: off, chosen: model.active.contains(format)) { model.format(format, nil) }
    }

    private var row: some View {
        HStack(spacing: 2) {
            tool("bold", "Bold (\u{2318}B)", .strong)
            tool("italic", "Italic (\u{2318}I)", .emphasis)
            tool("strikethrough", "Strikethrough", .strike)
            paragraphMenu
            ComposerTool(symbol: "link", label: "Link", off: off, chosen: model.active.contains(.link)) { linking = true }
                .popover(isPresented: $linking) { LinkPopover(model: model) { linking = false } }
            tool("list.number", "Numbered list", .block(.number))
            tool("list.bullet", "Bulleted list", .block(.bullet))
            tool("text.quote", "Quote", .block(.quote))
            tool("chevron.left.forwardslash.chevron.right", "Code", .code)
            tool("curlybraces", "Code block", .block(.code))
            Spacer(minLength: 0)
        }
    }

    /// Normal and the three headings; the one the caret's paragraph is shows a check.
    private var paragraphMenu: some View {
        Menu {
            ForEach([("Normal", nil), ("Heading 1", .h1), ("Heading 2", .h2), ("Heading 3", .h3)] as [(String, ComposerMarkdown.Block?)], id: \.0) { title, block in
                Button { model.format(.block(block), nil) } label: {
                    if model.active.contains(.block(block)) { Label(title, systemImage: "checkmark") } else { Text(title) }
                }
            }
        } label: {
            ComposerTool(symbol: "paragraphsign", label: "Paragraph style").icon
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().disabled(off != nil).clickable(off == nil).help("Paragraph style").accessibilityLabel("Paragraph style")
    }
}

/// The address of a link, asked where the Link tool is. With the field's text selected the link is on it; with none, the address is typed as the link.
struct LinkPopover: View {
    let model: ComposerModel
    let done: () -> Void
    @State private var address = ""

    var body: some View {
        VStack(alignment: .leading, spacing: PardnerMetrics.gap) {
            TextField("Link address", text: $address).textFieldStyle(.roundedBorder).frame(width: 240).onSubmit(add)
            HStack {
                if model.active.contains(.link) {
                    Button("Remove link") { model.format(.link, nil); done() }.clickable()
                }
                Spacer(minLength: 0)
                Button("Add link", action: add).disabled(ComposerFormat.address(address) == nil).clickable(ComposerFormat.address(address) != nil).keyboardShortcut(.defaultAction)
            }
        }
        .padding(PardnerMetrics.gap)
    }

    private func add() {
        guard let url = ComposerFormat.address(address) else { return }
        model.format(.link, url)
        done()
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
                .buttonStyle(.clickable)
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
                    MarkdownView(text: row.text, mention: row.to.map { "@" + model.name(of: $0) }, wholeSelection: true).designLines().textSelection(.enabled)
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
                        .buttonStyle(.clickable).foregroundStyle(PardnerColor.muted).accessibilityLabel("Dismiss")
                }
            }
        }
    }

    private func line(_ text: String, _ color: Color) -> some View {
        Text(text).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(color)
    }
}
