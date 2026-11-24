// A piece of a bot's text that holds a kept link, drawn by a non-editable, selectable `NSTextView` (#73, step B2, design 2.4): SwiftUI's
// `Text` shows no pointing hand over a link run and no documented API gives it one, where `linkTextAttributes` does. The link
// attribute stays `pardner-link:<n>`, so a click reaches no address but through the view's own handler.
import AppKit
import DesignSystem
import SwiftUI

struct LinkText: NSViewRepresentable {
    let text: AttributedString
    let size: CGFloat
    let weight: InterWeight
    /// Called with the `pardner-link:<n>` url of a clicked link.
    let open: (URL) -> Void
    /// What the row's own `Copy` does (design 2.7): the one item of this view's menu.
    var copy: (() -> Void)?

    /// The text as AppKit draws it, with what `MarkdownFonts.styled` and the row give a `Text`: Inter at `size` and `weight` (strong one
    /// step heavier, emphasized in the italic file), a code span in JetBrains Mono on `raised`, strikethrough, the theme's text colour,
    /// and the design's line spacing.
    static func attributed(_ text: AttributedString, size: CGFloat, weight: InterWeight) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = MessageRow.lineSpacing
        let out = NSMutableAttributedString()
        for run in text.runs {
            let intent = run.inlinePresentationIntent ?? []
            var attributes: [NSAttributedString.Key: Any] = [
                .foregroundColor: NSColor(PardnerColor.text), .paragraphStyle: paragraph,
            ]
            if run.font != nil {
                attributes[.font] = PardnerFont.monoCT(size: 12.5, weight: .regular) as NSFont
                attributes[.backgroundColor] = NSColor(PardnerColor.raised)
            } else {
                let heavier: InterWeight = weight == .regular ? .semibold : .bold
                attributes[.font] = PardnerFont.uiCT(
                    size: size, weight: intent.contains(.stronglyEmphasized) ? heavier : weight, italic: intent.contains(.emphasized)) as NSFont
                if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            }
            if let link = run.link { attributes[.link] = link }
            out.append(NSAttributedString(string: String(text[run.range].characters), attributes: attributes))
        }
        return out
    }

    func makeCoordinator() -> Coordinator { Coordinator(open: open, copy: copy) }

    func makeNSView(context: Context) -> NSTextView {
        let view = Self.makeTextView()
        view.delegate = context.coordinator
        apply(to: view, coordinator: context.coordinator)
        return view
    }

    /// The text view with no editing, no background, no insets and no link detection, whose links show the pointing hand. Its container
    /// follows the frame SwiftUI gives it; no measuring touches it.
    static func makeTextView() -> NSTextView {
        let view = NSTextView(usingTextLayoutManager: false)
        view.isEditable = false
        view.isSelectable = true
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        view.isVerticallyResizable = false
        view.isHorizontallyResizable = false
        view.isAutomaticLinkDetectionEnabled = false
        view.isAutomaticDataDetectionEnabled = false
        view.displaysLinkToolTips = false
        view.linkTextAttributes = [.foregroundColor: NSColor.linkColor, .cursor: NSCursor.pointingHand]
        return view
    }

    func updateNSView(_ view: NSTextView, context: Context) {
        context.coordinator.open = open
        context.coordinator.copy = copy
        apply(to: view, coordinator: context.coordinator)
    }

    /// Sets the text unless the source is the one already set, so a redraw keeps the selection (the stored text differs from a fresh
    /// conversion once AppKit fixes its attributes, so the two are never compared). SwiftUI may ask the size before it updates the view.
    func apply(to view: NSTextView, coordinator: Coordinator) {
        let source = Coordinator.Source(text: text, size: size, weight: weight)
        guard coordinator.source != source else { return }
        coordinator.source = source
        view.textStorage?.setAttributedString(Self.attributed(text, size: size, weight: weight))
    }

    /// The size the text takes at the proposed width: as wide as its longest line, as high as its lines, as a `Text` that is fixed
    /// vertically. Measured on the coordinator's own text stack, never on the view, whose container follows its frame.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView view: NSTextView, context: Context) -> CGSize? {
        let coordinator = context.coordinator
        apply(to: view, coordinator: coordinator)
        return coordinator.measure(Self.attributed(text, size: size, weight: weight), width: proposal.width)
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        struct Source: Equatable {
            let text: AttributedString
            let size: CGFloat
            let weight: InterWeight
        }

        var open: (URL) -> Void
        var copy: (() -> Void)?
        /// The source the view's text was last set from.
        var source: Source?
        private let storage = NSTextStorage()
        private let layout = NSLayoutManager()
        private let container = NSTextContainer()

        init(open: @escaping (URL) -> Void, copy: (() -> Void)?) {
            self.open = open
            self.copy = copy
            container.lineFragmentPadding = 0
            storage.addLayoutManager(layout)
            layout.addTextContainer(container)
        }

        /// `text` laid out at `width` (nil: on one line, its natural width), on a stack of its own.
        func measure(_ text: NSAttributedString, width: CGFloat?) -> CGSize {
            storage.setAttributedString(text)
            let limit = min(width ?? 100_000, 100_000)
            // The layout manager's used width is the container's, so the widest line comes from the text's own bounds.
            let natural = ceil(min(storage.boundingRect(with: NSSize(width: limit, height: .greatestFiniteMagnitude), options: .usesLineFragmentOrigin).width, limit))
            container.containerSize = NSSize(width: width == nil ? natural : limit, height: .greatestFiniteMagnitude)
            layout.ensureLayout(for: container)
            return CGSize(width: natural, height: ceil(layout.usedRect(for: container).height))
        }

        /// The row's menu and nothing else (design 2.7): one `Copy` that copies what the row's `Copy` copies. The standard menu would
        /// offer Copy Link, which copies `pardner-link:<n>`, and Share and Writing Tools besides.
        func textView(_ view: NSTextView, menu: NSMenu, for event: NSEvent, at charIndex: Int) -> NSMenu? {
            let own = NSMenu()
            if copy != nil {
                let item = NSMenuItem(title: "Copy", action: #selector(copyAnswer(_:)), keyEquivalent: "")
                item.target = self
                own.addItem(item)
            }
            return own
        }

        @objc func copyAnswer(_ sender: Any?) { copy?() }

        /// Hands a link's `pardner-link:<n>` url to the view's handler; true, so AppKit opens nothing itself.
        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            if let url = link as? URL ?? (link as? String).flatMap({ URL(string: $0) }) { open(url) }
            return true
        }
    }
}
