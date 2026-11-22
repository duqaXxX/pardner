// The two views of the recovery sheet that touch the secret (device pairing design 3.8), kept apart from SwiftUI's text: the key is
// drawn glyph by glyph from caller-owned buffers with `CTFontDrawGlyphs`, and the typed-back key is taken by a view that appends each
// key to a buffer. Neither gives the accessibility API the key itself.
import AppKit
import CoreText
import DesignSystem
import Platform
import SwiftUI

/// Where each of the 14 groups of the shown key sits: 7 to a row.
enum KeyLayout {
    static let groupsPerRow = 7
    static let groupGap: CGFloat = 16
    static let rowHeight: CGFloat = 38
    static let groups = (RecoveryText.symbolCount + 3) / 4

    /// The characters of group `g` in the display form: four, then a hyphen (the last group is the check symbol alone).
    static func range(_ g: Int) -> Range<Int> {
        let start = g * 5
        return start..<min(start + 4, RecoveryText.displayCount)
    }

    static func size(advance: CGFloat) -> CGSize {
        CGSize(width: CGFloat(groupsPerRow) * 4 * advance + CGFloat(groupsPerRow - 1) * groupGap, height: rowHeight * 2)
    }

    static func origin(group g: Int, symbol j: Int, advance: CGFloat) -> CGPoint {
        CGPoint(x: CGFloat(g % groupsPerRow) * (4 * advance + groupGap) + CGFloat(j) * advance, y: CGFloat(g / groupsPerRow) * rowHeight)
    }
}

/// Draws the key from the model's buffers; it holds no text and answers accessibility with a fixed label.
final class SecretDrawView: NSView {
    private let model: RecoverySheetModel
    private let font = PardnerFont.monoCT(size: 22, weight: .medium)
    private let advance: CGFloat

    init(model: RecoverySheetModel) {
        self.model = model
        var glyph = CGGlyph(0)
        var zero: UniChar = 0x30
        CTFontGetGlyphsForCharacters(font, &zero, &glyph, 1)
        var width = CGSize.zero
        CTFontGetAdvancesForGlyphs(font, .horizontal, &glyph, &width, 1)
        advance = width.width
        super.init(frame: NSRect(origin: .zero, size: KeyLayout.size(advance: width.width)))
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Recovery key, shown on screen")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var intrinsicContentSize: NSSize { frame.size }
    override func accessibilityValue() -> Any? { nil }
    override func accessibilityChildren() -> [Any]? { [] }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        effectiveAppearance.performAsCurrentDrawingAppearance { context.setFillColor(NSColor(PardnerColor.text).cgColor) }
        let top = bounds.height
        let font = font, advance = advance
        _ = model.withDrawing { characters, glyphs, ready in
            if !ready {
                CTFontGetGlyphsForCharacters(font, characters, glyphs, DrawBuffers.count)
                ready = true
            }
            for g in 0..<KeyLayout.groups {
                let range = KeyLayout.range(g)
                var positions = range.indices.map { _ in CGPoint.zero }
                for (n, _) in range.enumerated() {
                    let o = KeyLayout.origin(group: g, symbol: n, advance: advance)
                    positions[n] = CGPoint(x: o.x, y: top - o.y - 26)
                }
                CTFontDrawGlyphs(font, glyphs + range.lowerBound, &positions, range.count, context)
            }
        }
    }
}

/// What a typed key's field reads and does: the sheet's typed-back key and the key typed to recover.
@MainActor
protocol TypedKey: AnyObject {
    var typed: Int { get }
    var secureInput: SecureInputGuard { get }
    @discardableResult func key(_ character: UniChar) -> Bool
    func deleteLast()
}

extension RecoverySheetModel: TypedKey {}
extension RecoveryEntryModel: TypedKey {}

/// Takes the typed-back key one key at a time into the model and shows only how many symbols there are.
final class KeyCaptureView: NSView {
    var model: any TypedKey // set again by the representable when the field's model is another one
    private let label: String

    init(model: any TypedKey, label: String) {
        self.model = model
        self.label = label
        super.init(frame: NSRect(x: 0, y: 0, width: 500, height: 56))
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(label)
        setAccessibilityHelp("Type the characters of the key you wrote down. Case and dashes do not matter.")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var acceptsFirstResponder: Bool { true }
    override var intrinsicContentSize: NSSize { frame.size }
    /// The count only: never a character.
    override func accessibilityValue() -> Any? { "\(model.typed) of \(RecoveryText.symbolCount) characters typed" }

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { model.secureInput.firstResponder = true; needsDisplay = true }
        return accepted
    }

    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted { model.secureInput.firstResponder = false; needsDisplay = true }
        return accepted
    }

    override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self) }

    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command) || event.modifierFlags.contains(.control) { return super.keyDown(with: event) }
        switch event.keyCode {
        case 51, 117: model.deleteLast() // delete, forward delete
        case 36, 76, 53, 48: return super.keyDown(with: event) // return, enter, escape belong to the sheet's buttons; tab and shift-tab leave the field
        default: for unit in (event.characters ?? "").utf16 { model.key(unit) }
        }
        needsDisplay = true
        NSAccessibility.post(element: self, notification: .valueChanged)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        NotificationCenter.default.removeObserver(self)
        guard let window else {
            model.secureInput.windowKey = false
            return
        }
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(keyChanged), name: NSWindow.didBecomeKeyNotification, object: window)
        center.addObserver(self, selector: #selector(keyChanged), name: NSWindow.didResignKeyNotification, object: window)
        center.addObserver(self, selector: #selector(keyChanged), name: NSApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(keyChanged), name: NSApplication.didResignActiveNotification, object: nil)
        keyChanged()
        DispatchQueue.main.async { [weak self] in self?.window?.makeFirstResponder(self) }
    }

    @objc private func keyChanged() {
        model.secureInput.windowKey = window?.isKeyWindow ?? false
        model.secureInput.appActive = NSApplication.shared.isActive
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let count = RecoveryText.symbolCount, typed = model.typed
        let dot: CGFloat = 9, step: CGFloat = 13, groupGap: CGFloat = 8, columns = 7
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let ink = NSColor(PardnerColor.text).cgColor, line = NSColor(PardnerColor.muted).cgColor
            // Typed step by step: one mixed Int and CGFloat expression is past an older compiler's type-check budget.
            let groupWidth: CGFloat = 4 * step + groupGap
            for i in 0..<count {
                let group = i / 4
                let column = CGFloat(group % columns), row = CGFloat(group / columns), place = CGFloat(i % 4)
                let x: CGFloat = column * groupWidth + place * step + 2
                let y: CGFloat = bounds.height - row * 24 - dot - 4
                let rect = CGRect(x: x, y: y, width: dot, height: dot)
                if i < typed {
                    context.setFillColor(ink)
                    context.fillEllipse(in: rect)
                } else {
                    context.setStrokeColor(line)
                    context.setLineWidth(1)
                    context.strokeEllipse(in: rect.insetBy(dx: 0.5, dy: 0.5))
                }
            }
        }
    }
}

/// The sheet's window must not be shared or captured, as far as AppKit allows (design 3.8: best effort).
final class WindowGuardView: NSView {
    private var kept: (window: NSWindow, sharing: NSWindow.SharingType)?

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        restore() // the window is shared again as it was when the guard leaves it: it may be the app's main window
        super.viewWillMove(toWindow: newWindow)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let window else { return }
        kept = (window, window.sharingType)
        window.sharingType = .none
    }

    private func restore() {
        guard let kept else { return }
        kept.window.sharingType = kept.sharing
        self.kept = nil
    }

}

struct SecretText: NSViewRepresentable {
    let model: RecoverySheetModel
    func makeNSView(context: Context) -> SecretDrawView { SecretDrawView(model: model) }
    func updateNSView(_ view: SecretDrawView, context: Context) {}
}

struct KeyCapture: NSViewRepresentable {
    let model: any TypedKey
    var label = "Type the recovery key back"
    func makeNSView(context: Context) -> KeyCaptureView { KeyCaptureView(model: model, label: label) }
    func updateNSView(_ view: KeyCaptureView, context: Context) {
        view.model = model // a new field's model: keys never go to a declined one
        _ = model.typed // redraws when the count changes
        view.needsDisplay = true
    }
}

struct WindowGuard: NSViewRepresentable {
    func makeNSView(context: Context) -> WindowGuardView { WindowGuardView() }
    func updateNSView(_ view: WindowGuardView, context: Context) {}
}
