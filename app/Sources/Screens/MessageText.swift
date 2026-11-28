// A whole message, a bot's or a person's, in one non-editable `NSTextView` on TextKit 2, so that one selection runs across its paragraphs, lists,
// quotes and code (#194, design 10.1). The string is `MessageString`'s; a click on a link, the focus and the copy are this view's own. `LinkText`
// stays for a block that keeps its own view (a table's cell).
import AppKit
import DesignSystem
import SwiftUI

struct MessageText: NSViewRepresentable {
    /// The scheme of a link that is a button of the text (`pardner-action:fold:<n>`), which opens nothing.
    static let action = "pardner-action"

    let text: String
    /// The bot's `@name` a person's message opens with.
    var mention: String?
    var size: CGFloat = 14
    /// The message or answer the text is of, which names its code blocks for their open state (`LongBlock.key`); nil draws every block whole.
    var foldKey: String?
    var blocks: OpenBlocks = .shared
    /// The ground of an inline code span: `surface` on the selected band, where `codeInline` would blend with it. The view reads it when it draws.
    var codeGround = PardnerColor.codeInline
    /// Called with the `pardner-link:<n>` url of a clicked link.
    let open: (URL) -> Void
    /// Called with the piece index of a table whose preview was clicked.
    var openTable: (Int) -> Void = { _ in }
    /// What `Copy as Markdown` does, and what a link in a table's cell copies: the row's own `Copy`, the message's source. Nil: the row has no menu.
    var copy: (() -> Void)?

    func makeCoordinator() -> Coordinator { Coordinator(open: open, copy: copy) }

    func makeNSView(context: Context) -> MessageTextView {
        let view = MessageTextView(usingTextLayoutManager: true)
        LinkText.configure(view)
        view.delegate = context.coordinator
        view.textLayoutManager?.delegate = view
        apply(to: view, context: context)
        return view
    }

    func updateNSView(_ view: MessageTextView, context: Context) {
        context.coordinator.open = open
        context.coordinator.copy = copy
        apply(to: view, context: context)
    }

    /// The table's card reads the row's line spacing, which only the representable's context holds.
    private func apply(to view: MessageTextView, context: Context) {
        view.tableEnvironment = TableEnvironment(lineSpacing: context.environment.lineSpacing, size: size, codeGround: codeGround, open: open, openTable: openTable, copy: copy)
        apply(to: view, coordinator: context.coordinator)
    }

    /// Sets the string unless the source is the one already set, and then from the first piece that changed on (design 10.5), so that a message that grows keeps
    /// the selection above what is being written. SwiftUI may ask the size before it updates the view.
    func apply(to view: MessageTextView, coordinator: Coordinator) {
        view.codeGround = NSColor(codeGround)
        coordinator.blocks = blocks
        let opened = foldKey.map { key in Set(blocks.keys.filter { $0.hasPrefix(key + "#") }) } ?? []
        let source = Coordinator.Source(text: text, mention: mention, size: size, foldKey: foldKey, opened: opened)
        guard coordinator.source != source else { return }
        let was = coordinator.source
        coordinator.source = source
        guard case .read(let pieces, _) = MarkdownBlocks.read(text), !(pieces.isEmpty && mention != nil) else {
            coordinator.pieces = nil
            view.fillsWidth = false
            view.room = (0, 0)
            view.replace(from: 0, with: MessageString.plain(text, mention: mention, size: size))
            return
        }
        let built = MessageString.build(pieces, mention: mention, size: size, foldKey: foldKey, blocks: blocks)
        view.fillsWidth = built.fillsWidth
        view.room = (built.top, built.bottom)
        let first = coordinator.firstChange(to: pieces, source: source, was: was)
        let old = coordinator.starts
        (coordinator.pieces, coordinator.starts) = (pieces, built.starts)
        guard let first else { return }
        // A piece owns its trailing line end, which the last piece has not: the replacement starts at the line end of the piece before the first changed one only when
        // that line end changes (a paragraph "1" that becomes a list item makes it a separator), so a table there keeps its card while the next piece grows, and at
        // the end of the text when that piece is new. The selection is kept up to the changed piece's start.
        let end = view.textStorage?.length ?? 0
        let cut = first == 0 ? 0 : first < old.count ? old[first] : end
        let ownEnd = first > 0 && first < old.count
            && (view.textStorage?.attribute(MessageString.separated, at: cut - 1, effectiveRange: nil) != nil)
            == (built.string.attribute(MessageString.separated, at: built.starts[first] - 1, effectiveRange: nil) != nil)
        let from = first == 0 ? 0 : first < old.count ? (ownEnd ? cut : cut - 1) : end
        let skip = first == 0 ? 0 : ownEnd ? built.starts[first] : built.starts[first] - 1
        view.replace(from: from, keepingSelectionTo: cut, with: built.string.attributedSubstring(from: NSRange(location: skip, length: built.string.length - skip)))
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView view: MessageTextView, context: Context) -> CGSize? {
        apply(to: view, context: context)
        return view.fit(width: proposal.width)
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        struct Source: Equatable {
            let text: String
            let mention: String?
            let size: CGFloat
            /// Without it, a block has no footer to open.
            let foldKey: String?
            /// The keys of this message's code blocks that are open.
            let opened: Set<String>
        }

        var open: (URL) -> Void
        var copy: (() -> Void)?
        /// The source the view's text was last set from, the pieces it was read into (nil: drawn as one run) and where each starts in the storage.
        var source: Source?
        var pieces: [MarkdownBlocks.Piece]?
        var starts: [Int] = []
        var blocks: OpenBlocks?

        init(open: @escaping (URL) -> Void, copy: (() -> Void)? = nil) {
            self.open = open
            self.copy = copy
        }

        /// The first piece the text must be replaced from: 0 when the pieces before it cannot be trusted (nothing was set, the mention, the size or the
        /// message changed, or the text got shorter), nil when no piece changed. Pieces are compared, never attributes, which differ between two builds
        /// of the same text (design R1); a code block whose open state changed is a changed piece.
        func firstChange(to pieces: [MarkdownBlocks.Piece], source: Source, was old: Source?) -> Int? {
            guard let old, let before = self.pieces, old.mention == source.mention, old.size == source.size, old.foldKey == source.foldKey, pieces.count >= before.count else { return 0 }
            func isOpen(_ source: Source, _ i: Int) -> Bool { source.foldKey.map { source.opened.contains(LongBlock.key(message: $0, block: i)) } ?? false }
            for i in before.indices {
                if case .code = pieces[i].body, isOpen(old, i) != isOpen(source, i) { return i }
                if pieces[i] != before[i] { return i }
            }
            return pieces.count > before.count ? before.count : nil
        }

        /// The row's menu in place of the text view's (which offers `Copy Link`, the placeholder of a link): `Copy` of the selection, as Cmd-C copies it, when
        /// there is one, and `Copy as Markdown`, the whole message's source. A row with no copy has no menu.
        func textView(_ view: NSTextView, menu: NSMenu, for event: NSEvent, at charIndex: Int) -> NSMenu? {
            let own = NSMenu()
            guard copy != nil else { return own }
            if view.selectedRanges.contains(where: { $0.rangeValue.length > 0 }) {
                own.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: ""))
                own.items[0].target = view
            }
            let markdown = NSMenuItem(title: "Copy as Markdown", action: #selector(copyMarkdown(_:)), keyEquivalent: "")
            markdown.target = self
            own.addItem(markdown)
            return own
        }

        @objc func copyMarkdown(_ sender: Any?) { copy?() }

        func textViewDidChangeSelection(_ notification: Notification) { (notification.object as? MessageTextView)?.markSelectedTables() }

        /// Hands a link's `pardner-link:<n>` url to the view's handler, and opens or closes the block a `pardner-action:fold:<n>` footer belongs to; true, so
        /// AppKit opens nothing itself.
        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            guard let url = link as? URL ?? (link as? String).flatMap({ URL(string: $0) }) else { return true }
            if url.scheme == MessageText.action {
                if let foldKey = source?.foldKey, let block = url.absoluteString.split(separator: ":").last.flatMap({ Int($0) }) { blocks?.toggle(LongBlock.key(message: foldKey, block: block)) }
            } else {
                open(url)
            }
            return true
        }
    }
}

/// The copy icon of a code block, in its header or its card's corner. A button of its own, so that the pointing hand is its `cursorUpdate`: a cursor rect
/// alone hands the event on to the text view, and the cursor ends as the I-beam (design R3-1).
final class CopyButton: NSButton {
    var code = ""

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 20, height: 20))
        image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 12, weight: .regular))
        imagePosition = .imageOnly
        isBordered = false
        // A click on the button copies; it leaves the message's focus and selection as they are.
        refusesFirstResponder = true
        contentTintColor = NSColor(PardnerColor.muted)
        toolTip = "Copy code"
        setAccessibilityLabel("Copy code")
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.cursorUpdate, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    required init?(coder: NSCoder) { nil }

    override func cursorUpdate(with event: NSEvent) { NSCursor.pointingHand.set() }
}

final class MessageTextView: NSTextView, @preconcurrency NSTextLayoutManagerDelegate {
    /// The ground of an inline code span, read when the view draws.
    var codeGround = NSColor(PardnerColor.codeInline) {
        didSet { if codeGround != oldValue { needsDisplay = true } }
    }
    /// What a code block's copy button does with the block's text.
    var copyCode: (String) -> Void = { Clipboard.copy($0) }
    private var copyButtons: [CopyButton] = []
    /// Whether the message holds a code block or a rule, which take the whole width it is given, as on the block path.
    var fillsWidth = false
    /// The room above the first line and under the last (a code card's padding), which TextKit 2 does not lay out as paragraph spacing.
    var room: (top: CGFloat, bottom: CGFloat) = (0, 0) {
        didSet { textContainerInset = NSSize(width: 0, height: room.top) }
    }

    /// How many times the text was set, and how many times the copy buttons were placed (a test reads it): a scroll step lays the view out again and places none.
    var textEpoch = 0
    private(set) var placements = 0
    private var placedFor: (width: CGFloat, epoch: Int)?

    /// Sets the text from `start` to its end to `text`. The text system drops the selection a replacement covers (measured on macOS 27.2.1), so it is put back
    /// as it was, each range cut at `cut` (the start of the first piece that changed, `start` or one after it): one that ends after it ends there, one that
    /// begins at or after it is empty.
    func replace(from start: Int, keepingSelectionTo cut: Int? = nil, with text: NSAttributedString) {
        guard let storage = textStorage else { return }
        let cut = cut ?? start
        let saved = selectedRanges.map(\.rangeValue)
        storage.replaceCharacters(in: NSRange(location: start, length: storage.length - start), with: text)
        setSelectedRanges(saved.map { NSValue(range: NSRange(location: min($0.location, cut), length: max(min($0.upperBound, cut) - min($0.location, cut), 0))) }, affinity: .downstream, stillSelecting: false)
        textEpoch += 1
        needsDisplay = true
        needsLayout = true
    }

    /// A code block's copy button after each layout when the width or the text changed, one for each card: in the header's right end when it has a language, else in the card's corner.
    override func layout() {
        super.layout()
        // Laying the whole document out costs up to 37 ms a step deep in a 3,000-line opened block, and a scroll step changes neither the width nor the text.
        if let placed = placedFor, placed.width == bounds.width, placed.epoch == textEpoch { return }
        placedFor = (bounds.width, textEpoch)
        placements += 1
        guard let storage = textStorage, let layout = textLayoutManager else { return }
        // The segments of a range far down the text are an estimate until the text is laid out: a button placed from one floats over other text.
        layout.ensureLayout(for: layout.documentRange)
        var cards: [(card: CodeBlockCard, range: NSRange)] = []
        storage.enumerateAttribute(MessageString.codeCard, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            if let card = value as? CodeBlockCard { cards.append((card, range)) }
        }
        while copyButtons.count > cards.count { copyButtons.removeLast().removeFromSuperview() }
        while copyButtons.count < cards.count {
            let button = CopyButton()
            button.target = self
            button.action = #selector(copyBlock(_:))
            addSubview(button)
            copyButtons.append(button)
        }
        for (button, (card, range)) in zip(copyButtons, cards) {
            // A card that has no line laid out has no place: its button is hidden, not left at the corner.
            let top = segments(range).first?.rect.minY
            button.isHidden = top == nil
            guard let top else { continue }
            button.code = card.code
            let side = card.named ? MessageString.codePad : 6
            button.frame.origin = CGPoint(x: bounds.width - side - 20, y: card.named ? top + (MessageString.headerHeight - 20) / 2 : top - MessageString.codePad + 6)
        }
    }

    @objc private func copyBlock(_ sender: CopyButton) { copyCode(sender.code) }

    /// The grounds are drawn from the theme's colours as the view is drawn, so a change of theme only has to draw it again.
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    /// A message that loses focus shows no selection, so that only one does.
    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned {
            setSelectedRange(NSRange(location: 0, length: 0))
            markSelectedTables()
        }
        return resigned
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became { markSelectedTables() }
        return became
    }

    /// What the card of each table reads (`TableViewProvider` takes it when the card is loaded and measured, `tableEnvironmentChanged` hands the cards that are
    /// loaded the new one).
    var tableEnvironment = TableEnvironment() {
        didSet { tableEnvironmentChanged(from: oldValue) }
    }

    /// The selection moves while the mouse is down too (`stillSelecting`), which posts no notification: a table is marked after every set.
    override func setSelectedRanges(_ ranges: [NSValue], affinity: NSSelectionAffinity, stillSelecting stillSelectingFlag: Bool) {
        super.setSelectedRanges(ranges, affinity: affinity, stillSelecting: stillSelectingFlag)
        markSelectedTables()
    }

    /// A table the selection covers draws the selection over its card, in the colour the text itself has: the active one while the window is key and this view
    /// is the first responder, the unemphasized one otherwise. Called when the selection, the first responder or the window's key state changes.
    func markSelectedTables() {
        guard let storage = textStorage else { return }
        let selected = selectedRanges.map(\.rangeValue).filter { $0.length > 0 }
        let emphasized = window?.isKeyWindow == true && window?.firstResponder === self
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            guard let table = value as? TableAttachment else { return }
            // Each assignment publishes to the card, changed or not.
            let covered = selected.contains { NSIntersectionRange($0, range).length > 0 }
            if table.selection.selected != covered { table.selection.selected = covered }
            if table.selection.emphasized != emphasized { table.selection.emphasized = emphasized }
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        for name in [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification] {
            NotificationCenter.default.removeObserver(self, name: name, object: nil)
            if let window { NotificationCenter.default.addObserver(self, selector: #selector(windowKeyChanged), name: name, object: window) }
        }
        markSelectedTables()
    }

    @objc private func windowKeyChanged(_ notification: Notification) { markSelectedTables() }

    /// The size the text takes at `width` (nil: on its own lines): as wide as its longest line, or as given when a code card is in it, and as high
    /// as its lines, measured on the view's own stack. As wide as its line, so that no empty area right of a short line takes the I-beam or a click.
    func fit(width: CGFloat?) -> CGSize? {
        guard let layout = textLayoutManager, let container = textContainer else { return nil }
        let limit = min(width ?? 100_000, 100_000)
        container.size = NSSize(width: limit, height: 0)
        layout.ensureLayout(for: layout.documentRange)
        var widest: CGFloat = 0
        layout.enumerateTextLayoutFragments(from: layout.documentRange.location, options: [.ensuresLayout]) { fragment in
            for line in fragment.textLineFragments { widest = max(widest, fragment.layoutFragmentFrame.minX + line.typographicBounds.maxX) }
            return true
        }
        return CGSize(width: ceil(fillsWidth && width != nil ? limit : min(widest, limit)), height: ceil(room.top + layout.usageBoundsForTextContainer.height + room.bottom))
    }

    /// Cmd-C and Edit > Copy: the selection as text, RTF and the plain string. `copy:` asks for RTFD, RTF and the legacy string type, so an
    /// override of the one-type method would never run (design R6).
    override func writeSelection(to pboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool {
        guard let storage = textStorage else { return false }
        // Each range of the selection, one line end between two as AppKit joins them, and none when what is selected is all left out (a code header).
        let copy = NSMutableAttributedString()
        for range in selectedRanges.map(\.rangeValue) where range.length > 0 {
            let part = Self.copyText(of: storage.attributedSubstring(from: range))
            guard part.length > 0 else { continue }
            if copy.length > 0 { copy.append(NSAttributedString(string: "\n")) }
            copy.append(part)
        }
        guard copy.length > 0, let rtf = copy.rtf(from: NSRange(location: 0, length: copy.length), documentAttributes: [:]) else { return false }
        pboard.declareTypes([.rtf, .string], owner: nil)
        return pboard.setData(rtf, forType: .rtf) && pboard.setString(copy.string, forType: .string)
    }

    /// `selection` as it is copied: without the runs that are drawn and no text of the message, a table as its rows (each row's cells joined by a
    /// tab), a blank line where the block path leaves a gap, and no link, colour, ground or kern, which would paste as `pardner-link:<n>`, as the dark
    /// theme's white text and as wider gaps round an inline code span.
    static func copyText(of selection: NSAttributedString) -> NSAttributedString {
        let copy = NSMutableAttributedString(attributedString: selection)
        var edits: [(NSRange, NSAttributedString)] = []
        copy.enumerateAttributes(in: NSRange(location: 0, length: copy.length)) { attributes, range, _ in
            if attributes[MessageString.notCopied] != nil {
                edits.append((range, NSAttributedString()))
            } else if let table = attributes[.attachment] as? TableAttachment {
                let rows = table.table.rows.map { $0.map { String($0.characters) }.joined(separator: "\t") }.joined(separator: "\n")
                edits.append((range, NSAttributedString(string: rows, attributes: attributes.filter { $0.key == MessageString.rowFont })))
            } else if attributes[MessageString.separated] != nil, range.upperBound < copy.length {
                edits.append((NSRange(location: range.upperBound, length: 0), NSAttributedString(string: String(repeating: "\n", count: range.length), attributes: attributes)))
            }
        }
        for (range, text) in edits.reversed() { copy.replaceCharacters(in: range, with: text) }
        // The table's 1 pt font is drawn, not the message's: the rows and the line end under them are in the message's own.
        copy.enumerateAttribute(MessageString.rowFont, in: NSRange(location: 0, length: copy.length)) { value, range, _ in
            if let font = value as? NSFont { copy.addAttribute(.font, value: font, range: range) }
        }
        for key in [NSAttributedString.Key.link, .foregroundColor, .backgroundColor, .kern, MessageString.rowFont] { copy.removeAttribute(key, range: NSRange(location: 0, length: copy.length)) }
        return copy
    }

    // MARK: grounds

    /// What the text system does not draw, from the text's own layout: drawn by the view itself and before its subviews, so that it lies under the selection (a
    /// ground of a layout fragment would hide it, design R4 and R5).
    override func draw(_ dirtyRect: NSRect) {
        drawGrounds()
        super.draw(dirtyRect)
    }

    /// The lines `range` is laid out on, in the view's coordinates, each with its baseline's distance from its top.
    private func segments(_ range: NSRange) -> [(rect: CGRect, baseline: CGFloat)] {
        guard let layout = textLayoutManager, let start = location(range.location), let end = location(range.upperBound), let text = NSTextRange(location: start, end: end) else { return [] }
        var out: [(rect: CGRect, baseline: CGFloat)] = []
        layout.enumerateTextSegments(in: text, type: .standard, options: []) { _, frame, baseline, _ in
            out.append((frame.offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y), baseline))
            return true
        }
        return out
    }

    private func location(_ offset: Int) -> NSTextLocation? { textLayoutManager.flatMap { $0.location($0.documentRange.location, offsetBy: offset) } }

    /// Where the paragraph at `offset` starts its lines: the style's head indent, which a line of right-to-left text does not follow as its glyphs do.
    private func indent(at offset: Int) -> CGFloat {
        textContainerOrigin.x + ((textStorage?.attribute(.paragraphStyle, at: offset, effectiveRange: nil) as? NSParagraphStyle)?.headIndent ?? 0)
    }

    /// The glyphs' own box in a line: from the font's ascent to its descent, as a run's typographic bounds are, where the line is as high as its tallest font.
    private func glyphs(_ segment: (rect: CGRect, baseline: CGFloat), _ font: NSFont) -> CGRect {
        CGRect(x: segment.rect.minX, y: segment.rect.minY + segment.baseline - font.ascender, width: segment.rect.width, height: font.ascender - font.descender)
    }

    private func drawGrounds() {
        guard let storage = textStorage, let layout = textLayoutManager else { return }
        layout.ensureLayout(for: layout.documentRange)
        let all = NSRange(location: 0, length: storage.length)
        func rounded(_ rect: CGRect, _ radius: CGFloat, fill: NSColor) {
            fill.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
        }
        // A quote's bar runs from its first line to its last, and through the gap to the next paragraph that has it too; a code card in it is as high as
        // the card is, which has room above its first line (when it has no header) and under its last.
        var previous: (bars: Int, bottom: CGFloat)?
        storage.enumerateAttribute(MessageString.quoteBars, in: all) { value, range, _ in
            let lines = segments(range)
            guard let bars = value as? Int, var top = lines.first?.rect.minY, var bottom = lines.last?.rect.maxY else { return previous = nil }
            if let card = storage.attribute(MessageString.codeCard, at: range.location, effectiveRange: nil) as? CodeBlockCard, !card.named { top -= MessageString.codePad }
            // The range ends on its line end, which has no card: the card is looked up at the last character before it.
            let end = range.upperBound - 1 - (range.length > 1 && (storage.string as NSString).character(at: range.upperBound - 1) == 10 ? 1 : 0)
            var run = NSRange()
            if let card = storage.attribute(MessageString.codeCard, at: end, longestEffectiveRange: &run, in: range) as? CodeBlockCard, let last = segments(run).last?.rect.maxY { bottom = last + card.below }
            NSColor(PardnerColor.line).setFill()
            for bar in 0..<bars {
                let from = (previous?.bars ?? 0) > bar ? previous?.bottom ?? top : top
                NSRect(x: CGFloat(bar) * (MarkdownView.barWidth + MarkdownView.barGap), y: from, width: MarkdownView.barWidth, height: bottom - from).fill()
            }
            previous = (bars, bottom)
        }
        // A code card runs from its header's top (a block with no header: the first line's, less the padding) to what its last line leaves under it (measured
        // on macOS 27.2.1: a text segment holds neither that room nor the paragraph spacing, so the card's `below` carries it).
        storage.enumerateAttribute(MessageString.codeCard, in: all) { value, range, _ in
            let lines = segments(range)
            guard let card = value as? CodeBlockCard, let first = lines.first?.rect, let last = lines.last?.rect else { return }
            let left = indent(at: range.location) - MessageString.codePad, top = first.minY - (card.named ? 0 : MessageString.codePad)
            let rect = CGRect(x: left, y: top, width: bounds.width - left, height: last.maxY + card.below - top)
            rounded(rect, 8, fill: NSColor(PardnerColor.codeBg))
            NSColor(PardnerColor.line).setStroke()
            NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 7.5, yRadius: 7.5).stroke()
        }
        storage.enumerateAttribute(MessageString.ruleMark, in: all) { value, range, _ in
            guard value != nil, let line = segments(range).first?.rect else { return }
            NSColor(PardnerColor.line).setFill()
            let left = indent(at: range.location)
            NSRect(x: left, y: line.minY, width: bounds.width - left, height: 1).fill()
        }
        storage.enumerateAttribute(MessageString.codeSpan, in: all) { value, range, _ in
            let lines = segments(range)
            guard value != nil, let font = storage.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont else { return }
            // The text system splits a kern between the two characters it lies between (measured on macOS 27.2.1): a span's segment holds half the room before it
            // and half its own, so that the glyphs start half a kern in and a run's bounds, which hold its whole kern, end half a kern after the segment.
            let half = InlineCodeText.inset / 2
            // The room before a span is the kern of the character before it (the inset, or more after the mention's space), which counts when that character is on
            // the span's first line.
            let kern = range.location > 0 ? storage.attribute(.kern, at: range.location - 1, effectiveRange: nil) as? CGFloat : nil
            let before = kern != nil ? segments(NSRange(location: range.location - 1, length: 1)).last : nil
            let spaced = before != nil && lines.first.map { abs(before!.rect.midY - $0.rect.midY) < 1 } ?? false
            var fragments = lines.enumerated().map { n, line in
                var box = glyphs(line, font)
                if n == 0, spaced, let kern { box.origin.x += kern / 2; box.size.width -= kern / 2 }
                if n == lines.count - 1 { box.size.width += half }
                return [InlineCodeText.Fragment(rect: box, ground: .clear)]
            }
            if spaced, let before { fragments[0].insert(InlineCodeText.Fragment(rect: before.rect, ground: nil), at: 0) }
            for box in InlineCodeText.boxes(fragments) { rounded(box.rect, PardnerMetrics.codeRadius, fill: codeGround) }
        }
        storage.enumerateAttribute(MessageString.mentionRun, in: all) { value, range, _ in
            guard value != nil, let font = storage.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont else { return }
            for line in segments(range) {
                rounded(glyphs(line, font).insetBy(dx: -MentionedText.side, dy: -MentionedText.edge), MentionedText.radius, fill: NSColor(PardnerColor.mentionBg))
            }
        }
    }

    /// The fold footer, a link run, is muted where any other link is the brand colour.
    func textLayoutManager(_ manager: NSTextLayoutManager, renderingAttributesForLink link: Any, at location: any NSTextLocation, defaultAttributes: [NSAttributedString.Key: Any]) -> [NSAttributedString.Key: Any]? {
        let url = link as? URL ?? (link as? String).flatMap { URL(string: $0) }
        let own = linkTextAttributes ?? defaultAttributes
        return url?.scheme == MessageText.action ? own.merging([.foregroundColor: NSColor(PardnerColor.muted)]) { $1 } : own
    }
}
