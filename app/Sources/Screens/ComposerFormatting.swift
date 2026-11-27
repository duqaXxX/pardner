// What the composer's formatting tools do to the field (#129): an inline mark toggles on the selection or on the typing attributes, a block on the
// paragraphs the selection touches, a link asks its address in the row's popover. The Markdown is not touched here: the field's `textDidChange` styles the
// text and tells the model, as it does for a key.
import AppKit
import DesignSystem

/// A tool of the row, and what the field says is on at its caret.
enum ComposerFormat: Hashable {
    case strong, emphasis, strike, code, link
    /// A paragraph style (`nil` is Normal), or a list, a quote or a code block, which the same tool takes away when the paragraph already is one.
    case block(ComposerMarkdown.Block?)

    /// The address a person typed, as a link may carry it: `http` or `https` with a host; a bare `example.com` takes `https://`.
    static func address(_ typed: String) -> URL? {
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed.contains("://") ? trimmed : "https://" + trimmed), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host(percentEncoded: false)?.isEmpty == false else { return nil }
        return url
    }

    fileprivate var mark: (key: NSAttributedString.Key, value: Any)? {
        switch self {
        case .strong: (.composerStrong, true)
        case .emphasis: (.composerEmphasis, true)
        case .code: (.composerCode, true)
        case .strike: (.strikethroughStyle, NSUnderlineStyle.single.rawValue)
        case .link, .block: nil
        }
    }
}

extension ComposerTextView {
    /// Runs a tool. A link is set to `url`, or taken away when `url` is nil.
    func apply(_ format: ComposerFormat, url: URL? = nil) {
        switch format {
        case .link: setLink(url)
        case .block(let block): setBlock(block)
        default: toggle(format)
        }
    }

    private func toggle(_ format: ComposerFormat) {
        guard let (key, value) = format.mark, let storage = textStorage else { return }
        let range = selectedRange()
        guard range.length > 0 else {
            // No selection: the next typed text carries the mark, or no longer does.
            typingAttributes[key] = typingAttributes[key] == nil ? value : nil
            return
        }
        guard shouldChangeText(in: range, replacementString: nil) else { return }
        if allCarry(key, in: range) { storage.removeAttribute(key, range: range) } else { storage.addAttribute(key, value: value, range: range) }
        didChangeText()
    }

    private func allCarry(_ key: NSAttributedString.Key, in range: NSRange) -> Bool {
        var all = true
        textStorage?.enumerateAttribute(key, in: range) { value, _, stop in
            if value == nil { (all, stop.pointee) = (false, true) }
        }
        return all
    }

    private func carriesAny(_ key: NSAttributedString.Key, in range: NSRange) -> Bool {
        var found = false
        textStorage?.enumerateAttribute(key, in: range) { value, _, stop in
            if value != nil { (found, stop.pointee) = (true, true) }
        }
        return found
    }

    private func setLink(_ url: URL?) {
        guard let storage = textStorage else { return }
        var range = selectedRange()
        if range.length == 0 {
            if let url {
                // No selection: the address is the link's text.
                var attributes = typingAttributes
                attributes[.link] = url
                guard shouldChangeText(in: range, replacementString: url.absoluteString) else { return }
                storage.replaceCharacters(in: range, with: NSAttributedString(string: url.absoluteString, attributes: attributes))
                didChangeText()
                setSelectedRange(NSRange(location: range.location + (url.absoluteString as NSString).length, length: 0))
                return
            }
            // A caret inside a link takes the whole link away.
            guard let run = linkRun(at: range.location) else { return }
            range = run
        }
        guard shouldChangeText(in: range, replacementString: nil) else { return }
        if let url { storage.addAttribute(.link, value: url, range: range) } else { storage.removeAttribute(.link, range: range) }
        didChangeText()
    }

    /// The whole link a caret at `location` is in or at the end of (the one the row shows), whatever styles it holds.
    private func linkRun(at location: Int) -> NSRange? {
        guard let storage = textStorage, location > 0, location <= storage.length else { return nil }
        var run = NSRange()
        guard storage.attribute(.link, at: location - 1, longestEffectiveRange: &run, in: NSRange(location: 0, length: storage.length)) != nil else { return nil }
        return run
    }

    /// The block of the paragraph starting at `location`: its characters', or the typing attributes' for the empty last one, which has none yet.
    private func block(at location: Int) -> ComposerMarkdown.Block? {
        guard let storage = textStorage else { return nil }
        return location < storage.length ? ComposerMarkdown.block(in: storage, at: location)
            : (typingAttributes[.composerBlock] as? String).flatMap(ComposerMarkdown.Block.init)
    }

    /// The paragraphs a selection touches: the caret's, or each one the selection reaches into (not the one it only ends at the start of, nor the one it
    /// starts at the line end of).
    private func touched() -> [NSRange] {
        let selection = selectedRange()
        return ComposerMarkdown.paragraphs(of: string as NSString).filter {
            selection.length == 0 ? $0.location <= selection.location && selection.location <= $0.upperBound
                : $0.location < selection.upperBound && selection.location <= $0.upperBound && !($0.length > 0 && selection.location == $0.upperBound && selection.length > 1)
        }
    }

    private func setBlock(_ block: ComposerMarkdown.Block?) {
        guard let storage = textStorage else { return }
        let paragraphs = touched()
        let target = paragraphs.allSatisfy { self.block(at: $0.location) == block } ? nil : block
        // A paragraph with no character yet, the last of the text, has nothing to carry the block: the typing attributes do.
        let written = paragraphs.filter { $0.location < storage.length }.map { NSRange(location: $0.location, length: min($0.length + 1, storage.length - $0.location)) }
        if let first = written.first, let last = written.last {
            let all = NSRange(location: first.location, length: last.upperBound - first.location)
            guard shouldChangeText(in: all, replacementString: nil) else { return }
            for range in written {
                if let target { storage.addAttribute(.composerBlock, value: target.rawValue, range: range) } else { storage.removeAttribute(.composerBlock, range: range) }
            }
            didChangeText()
        }
        if paragraphs.last.map({ $0.location >= storage.length }) == true {
            typingAttributes[.composerBlock] = target?.rawValue
            typingAttributes[.paragraphStyle] = ComposerMarkdown.paragraphStyle(target, first: paragraphs.last?.location == 0 ? firstLineIndent : 0)
        }
    }

    /// The tools that are on at the caret (the typing attributes) or all through the selection.
    func activeFormats() -> Set<ComposerFormat> {
        guard let storage = textStorage else { return [] }
        let range = selectedRange()
        var out: Set<ComposerFormat> = []
        for format in [ComposerFormat.strong, .emphasis, .code, .strike] {
            guard let key = format.mark?.key else { continue }
            if range.length == 0 ? typingAttributes[key] != nil : allCarry(key, in: range) { out.insert(format) }
        }
        let linked = range.length == 0 ? linkRun(at: range.location) != nil : carriesAny(.link, in: range)
        if linked { out.insert(.link) }
        let start = (string as NSString).paragraphRange(for: NSRange(location: range.location, length: 0)).location
        out.insert(.block(block(at: start)))
        return out
    }

    /// Shift-Return where the field's own newline is not enough: an empty list or quote line ends the list or the quote, and a new line after a heading is a
    /// plain paragraph. True when it took the key; any other line carries its block on to the next, as the typing attributes do.
    func insertLineInBlock() -> Bool {
        guard let storage = textStorage else { return false }
        let range = selectedRange()
        let paragraph = (string as NSString).paragraphRange(for: NSRange(location: range.location, length: 0))
        let text = paragraph.length - ((string as NSString).substring(with: paragraph).hasSuffix("\n") ? 1 : 0)
        switch block(at: paragraph.location) {
        case .bullet, .number, .quote:
            guard text == 0, range.length == 0 else { return false }
            setBlock(nil)
        case .h1, .h2, .h3:
            guard range.length == 0, range.location == paragraph.location + text else { return false }
            insertText("\n", replacementRange: range)
            // The line end the heading had now ends the new paragraph, which is plain.
            let end = NSRange(location: range.location + 1, length: 1)
            if end.upperBound <= storage.length, (string as NSString).substring(with: end) == "\n", shouldChangeText(in: end, replacementString: nil) {
                storage.removeAttribute(.composerBlock, range: end)
                didChangeText()
            }
            typingAttributes = ComposerMarkdown.base(firstLineIndent: 0)
        default:
            return false
        }
        return true
    }

    /// The marker of each list item and the bar of each quote, in the room their paragraph leaves at its left; the text carries neither.
    func drawBlockMarks() {
        guard let layout = layoutManager, let storage = textStorage, let container = textContainer else { return }
        var number = 0
        for range in ComposerMarkdown.paragraphs(of: storage.string as NSString) where range.location < storage.length {
            let block = ComposerMarkdown.block(in: storage, at: range.location)
            number = block == .number ? number + 1 : 0
            guard block == .bullet || block == .number || block == .quote,
                  let style = storage.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle else { continue }
            let glyphs = layout.glyphRange(forCharacterRange: NSRange(location: range.location, length: max(range.length, 1)), actualCharacterRange: nil)
            let rect = layout.boundingRect(forGlyphRange: glyphs, in: container)
            if block == .quote {
                NSColor(PardnerColor.line).setFill()
                NSRect(x: style.headIndent - ComposerMarkdown.Block.quote.indent, y: rect.minY, width: PardnerMetrics.quoteBar, height: rect.height).fill()
                continue
            }
            let marker = NSAttributedString(string: block == .bullet ? "\u{2022}" : "\(number).", attributes: [
                .font: ComposerMarkdown.font(strong: false, emphasis: false, code: false, block: nil), .foregroundColor: NSColor(PardnerColor.muted)])
            let first = layout.lineFragmentRect(forGlyphAt: glyphs.location, effectiveRange: nil)
            marker.draw(at: NSPoint(x: style.firstLineHeadIndent - 6 - marker.size().width, y: first.minY))
        }
    }
}
