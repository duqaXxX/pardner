// What the message's text view draws that the text system does not (#194, unit 2): the code card, the quote bars, the rule, the inline code ground and the
// mention's chip, each where the block path draws it and under a selection; the copy buttons of a code block and its fold footer. Rendered offscreen on macOS
// 27 (this Mac); the positions of the grounds rest on that system's TextKit 2 layout, which CI's macOS 15 and 26.7 check by these same assertions.
import AppKit
@testable import Conversation
import DesignSystem
import Foundation
@testable import Screens
import SwiftUI
import XCTest

@MainActor
final class MessageGroundsTests: XCTestCase {
    private let themes: [(name: NSAppearance.Name, dark: Bool)] = [(.aqua, false), (.darkAqua, true)]
    private var swatches: [String: [CGFloat]] = [:]
    private let long = (1...31).map { "line \($0)" }.joined(separator: "\n")

    private func textView(in view: NSView) -> MessageTextView? {
        (view as? MessageTextView) ?? view.subviews.lazy.compactMap(textView).first
    }

    /// `root` laid out in a window, in the appearance `name`, and the bitmap of what it draws.
    private func shown(_ root: some View, _ name: NSAppearance.Name, size: CGSize = CGSize(width: 400, height: 320)) -> (host: NSHostingView<AnyView>, window: NSWindow) {
        _ = NSApplication.shared
        PardnerFonts.register()
        let host = NSHostingView(rootView: AnyView(root.designLines().fixedSize(horizontal: false, vertical: true).frame(width: size.width, height: size.height, alignment: .topLeading).background(PardnerColor.bg)))
        host.appearance = NSAppearance(named: name)
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        return (host, window)
    }

    private func bitmap(_ view: NSView) throws -> NSBitmapImageRep {
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        return rep
    }

    /// The colour a token comes out as in a bitmap of a hosting view (the display's profile moves every colour, a dark one most), by drawing a swatch of it
    /// on the window's ground and reading the bitmap back, so that a ground is compared in the colour it is rendered in.
    private func token(_ name: String, dark: Bool) -> [CGFloat] {
        let key = "\(name) \(dark)"
        if let known = swatches[key] { return known }
        func sRGB(_ token: String, alpha: Bool) -> Color {
            let v = dark ? Tokens.pairs[token]!.dark : Tokens.pairs[token]!.light
            return Color(.sRGB, red: v.red, green: v.green, blue: v.blue, opacity: alpha ? v.alpha : 1)
        }
        let (host, _) = shown(ZStack { sRGB("bg", alpha: false); sRGB(name, alpha: true) }, dark ? .darkAqua : .aqua, size: CGSize(width: 8, height: 8))
        let rep = try! bitmap(host)
        let c = rep.colorAt(x: 4, y: 4)!.usingColorSpace(.sRGB)!
        swatches[key] = [c.redComponent, c.greenComponent, c.blueComponent]
        return swatches[key]!
    }

    /// Where the pixels of each token's colour are, as the bounding rectangle in points, and how many there are. With `solid`, only a pixel that is in a run of five
    /// or more along its row and along its column counts (`thin`: a run of fourteen along one of them, a bar's or a rule's): the antialiased edge of a glyph on the
    /// ground has a few pixels of every colour, in short runs or along a stem.
    private func found(_ rep: NSBitmapImageRep, _ tokens: [String], dark: Bool, in area: CGRect? = nil, solid: Bool = true, thin: Bool = false, tolerance: CGFloat = 0.03) -> [String: (box: CGRect, count: Int)] {
        let width = rep.pixelsWide, height = rep.pixelsHigh
        let factor = CGFloat(width) / CGFloat(rep.size.width)
        var out: [String: (box: CGRect, count: Int)] = [:]
        for name in tokens {
            let c = token(name, dark: dark)
            var grid = [Bool](repeating: false, count: width * height)
            for y in 0..<height {
                for x in 0..<width {
                    if let area, !area.contains(CGPoint(x: CGFloat(x) / factor, y: CGFloat(y) / factor)) { continue }
                    guard let p = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB), p.alphaComponent > 0.99 else { continue }
                    grid[y * width + x] = abs(p.redComponent - c[0]) + abs(p.greenComponent - c[1]) + abs(p.blueComponent - c[2]) < tolerance
                }
            }
            // The length of the run of matching pixels each one is in, along a row and along a column.
            func runs(_ outer: Int, _ inner: Int, _ at: (Int, Int) -> Int) -> [Int] {
                var out = [Int](repeating: 0, count: width * height)
                for a in 0..<outer {
                    var start = 0
                    for b in 0...inner where b == inner || !grid[at(a, b)] {
                        for k in start..<b { out[at(a, k)] = b - start }
                        start = b + 1
                    }
                }
                return out
            }
            let along = runs(height, width) { $0 * width + $1 }, down = runs(width, height) { $1 * width + $0 }
            let kept = (0..<width * height).map { i in !solid ? grid[i] : thin ? max(along[i], down[i]) >= 14 : min(along[i], down[i]) >= 5 }
            for y in 0..<height {
                for x in 0..<width where kept[y * width + x] {
                    let box = CGRect(x: CGFloat(x) / factor, y: CGFloat(y) / factor, width: 1 / factor, height: 1 / factor)
                    out[name] = (out[name]?.box.union(box) ?? box, (out[name]?.count ?? 0) + 1)
                }
            }
        }
        return out
    }

    private func assertSame(_ a: CGRect?, _ b: CGRect?, _ label: String, accuracy: CGFloat = 1.5, file: StaticString = #filePath, line: UInt = #line) {
        guard let a, let b else { return XCTFail("a ground is missing: \(label)", file: file, line: line) }
        for (name, x, y) in [("minX", a.minX, b.minX), ("minY", a.minY, b.minY), ("maxX", a.maxX, b.maxX), ("maxY", a.maxY, b.maxY)] {
            XCTAssertEqual(x, y, accuracy: accuracy, "\(label): \(name) of \(a) against \(b)", file: file, line: line)
        }
    }

    /// The colour at a point, in points, of `rep`.
    private func colour(_ rep: NSBitmapImageRep, _ point: CGPoint) -> [CGFloat] {
        let factor = CGFloat(rep.pixelsWide) / CGFloat(rep.size.width)
        let c = rep.colorAt(x: Int(point.x * factor), y: Int(point.y * factor))?.usingColorSpace(.sRGB)
        return [c?.redComponent ?? -1, c?.greenComponent ?? -1, c?.blueComponent ?? -1]
    }

    /// The grounds of `tokens` in a message drawn by the block path and by the text view, in both themes: where each starts and ends must agree, and so must the
    /// colour just outside the first one's box at its left and its top edge (a card's border).
    private func compare(_ text: String, mention: String? = nil, tokens: [String], foldKey: String? = nil, thin: Bool = false, area: CGRect? = nil, edges: Bool = false, file: StaticString = #filePath, line: UInt = #line) throws {
        for (name, dark) in themes {
            let oldRep = try bitmap(shown(MarkdownView(text: text, mention: mention, foldKey: foldKey, blocks: OpenBlocks()), name).host)
            let newRep = try bitmap(shown(MessageText(text: text, mention: mention, foldKey: foldKey, blocks: OpenBlocks(), open: { _ in }), name).host)
            let old = found(oldRep, tokens, dark: dark, in: area, thin: thin), new = found(newRep, tokens, dark: dark, in: area, thin: thin)
            for token in tokens {
                XCTAssertNotNil(old[token], "the block path draws \(token): \(text.prefix(30)) \(name.rawValue)", file: file, line: line)
                assertSame(old[token]?.box, new[token]?.box, "\(token) of \(text.prefix(30).debugDescription) \(name.rawValue)", file: file, line: line)
            }
            if edges, let box = old[tokens[0]]?.box {
                for point in [CGPoint(x: box.minX - 0.5, y: box.midY), CGPoint(x: box.midX, y: box.minY - 0.5)] {
                    for (a, b) in zip(colour(oldRep, point), colour(newRep, point)) {
                        XCTAssertEqual(a, b, accuracy: 0.02, "the card's edge at \(point) \(name.rawValue): \(text.prefix(30).debugDescription)", file: file, line: line)
                    }
                }
            }
        }
    }

    func testACodeCardIsDrawnWhereTheBlockPathDrawsIt() throws {
        for text in ["```swift\nlet x = 1\nlet y = 2\n```", "```\nbare\n```", "before\n\n```swift\ncode\n```\n\nafter", "> quoted\n\n```\nplain\n```", "```\n\(long)\n```", "```swift\n\(long)\n```"] {
            try compare(text, tokens: ["code-bg"], foldKey: "m", edges: true)
        }
    }

    func testQuoteBarsAndARuleAreDrawnWhereTheBlockPathDrawsThem() throws {
        try compare("> quoted one\n>\n> quoted two\n\n> > deeper\n\nlast", tokens: ["line"], thin: true, area: CGRect(x: 0, y: 0, width: 16, height: 320))
        // A code card below makes the view as wide as it is given, as the block path's rule is (a rule alone does not, G7); the area leaves the card out.
        try compare("above\n\n---\n\nbelow\n\n```\nx\n```", tokens: ["line"], thin: true, area: CGRect(x: 0, y: 0, width: 400, height: 45))
    }

    func testAnInlineCodeGroundAndTheMentionsChipAreDrawnWhereTheBlockPathDrawsThem() throws {
        try compare("a `code` b and `more code` here", tokens: ["code-inline"])
        try compare("a long line of words that wraps onto a second line with `a code span that wraps` and then goes on and on to a third", tokens: ["code-inline"])
        try compare("`first` word", tokens: ["code-inline"])
        try compare("hello `code` there", mention: "@mini", tokens: ["mention-bg", "code-inline"])
        try compare("# Title", mention: "@mini", tokens: ["mention-bg"])
    }

    /// R4 and R5 of the design: a ground drawn by the text view lies under the selection. Count the ground's pixels in a line before and after select all.
    func testASelectionShowsOverACodeCardAnInlineCodeSpanAndTheChip() throws {
        let text = "intro with `code` here\n\n```swift\nlet x = 1\n```"
        for (name, dark) in themes {
            let (host, window) = shown(MessageText(text: text, mention: "@mini", open: { _ in }), name)
            let view = try XCTUnwrap(textView(in: host))
            let layout = try XCTUnwrap(view.textLayoutManager)
            layout.ensureLayout(for: layout.documentRange)
            func area(_ word: String, around: CGFloat) throws -> CGRect {
                let range = (view.string as NSString).range(of: word)
                let from = try XCTUnwrap(layout.location(layout.documentRange.location, offsetBy: range.location))
                var frame = CGRect.null
                layout.enumerateTextSegments(in: try XCTUnwrap(NSTextRange(location: from, end: layout.location(from, offsetBy: range.length))), type: .standard, options: []) { _, rect, _, _ in
                    frame = frame.union(rect)
                    return true
                }
                return frame.insetBy(dx: -around, dy: 0)
            }
            let shift = host.convert(NSPoint.zero, from: view)
            let spots = [("code-inline", try area("code", around: 0)), ("mention-bg", try area("@mini", around: 4)), ("code-bg", try area("let x", around: 0))].map { ($0.0, $0.1.offsetBy(dx: shift.x, dy: shift.y)) }
            let before = spots.map { found(try! bitmap(host), [$0.0], dark: dark, in: $0.1)[$0.0]?.count ?? 0 }
            XCTAssertTrue(window.makeFirstResponder(view))
            view.selectAll(nil)
            let after = spots.map { found(try! bitmap(host), [$0.0], dark: dark, in: $0.1)[$0.0]?.count ?? 0 }
            for (i, spot) in spots.enumerated() {
                XCTAssertGreaterThan(before[i], 20, "\(spot.0) is drawn (\(name.rawValue))")
                XCTAssertLessThan(after[i], before[i] / 3, "a selection shows over \(spot.0) (\(name.rawValue)): \(before[i]) ground pixels before, \(after[i]) after")
            }
        }
    }

    func testTheCodeGroundIsAViewPropertyAChangeOfItRedrawsAndTheViewDrawsIt() throws {
        let (host, window) = shown(MessageText(text: "a `code` b", open: { _ in }), .aqua)
        // On a Display P3 screen the bitmap is P3, where the same red has other components.
        window.colorSpace = .displayP3
        let view = try XCTUnwrap(textView(in: host))
        view.displayIfNeeded()
        XCTAssertFalse(view.needsDisplay)
        view.codeGround = NSColor(srgbRed: 1, green: 0, blue: 0, alpha: 1)
        XCTAssertTrue(view.needsDisplay, "a change of the ground marks the view for display")
        // The bitmap is converted to sRGB, whose components are then read as they are: `colorAt` hands a P3 bitmap's numbers on as calibrated RGB, which
        // `usingColorSpace` would shift again.
        let rep = try XCTUnwrap(try bitmap(view).converting(to: .sRGB, renderingIntent: .relativeColorimetric))
        var drawn = 0
        for y in 0..<rep.pixelsHigh { for x in 0..<rep.pixelsWide where rep.colorAt(x: x, y: y).map({ $0.redComponent > 0.95 && $0.greenComponent < 0.05 }) ?? false { drawn += 1 } }
        XCTAssertGreaterThan(drawn, 50, "the code span stands on the new ground")
    }

    /// AppKit's own redraw on a change of theme is not relied on (the grounds read the theme's colours as they are drawn): the view marks itself.
    func testAChangeOfThemeMarksTheViewForDisplayAndTheGroundsAreTheThemesOwn() throws {
        let (host, _) = shown(MessageText(text: "```\ncode\n```", open: { _ in }), .aqua)
        let view = try XCTUnwrap(textView(in: host))
        view.displayIfNeeded()
        XCTAssertFalse(view.needsDisplay)
        view.viewDidChangeEffectiveAppearance()
        XCTAssertTrue(view.needsDisplay)
        host.appearance = NSAppearance(named: .darkAqua)
        XCTAssertGreaterThan(found(try bitmap(host), ["code-bg"], dark: true)["code-bg"]?.count ?? 0, 100, "the card is the dark theme's")
    }

    /// The copy button of a code block with a language sits at its header's right end, a block with none has one in the card's corner; both copy the block.
    func testACodeBlocksCopyButtonIsInItsHeaderOrItsCornerAndCopiesTheBlock() throws {
        for (fence, x, y) in [("```swift", 400 - 12 - 20, 4), ("```", 400 - 6 - 20, 6)] as [(String, CGFloat, CGFloat)] {
            let (host, _) = shown(MessageText(text: "\(fence)\nlet x = 1\n```", open: { _ in }), .aqua)
            let view = try XCTUnwrap(textView(in: host))
            let buttons = view.subviews.compactMap { $0 as? CopyButton }
            XCTAssertEqual(buttons.count, 1, fence)
            let button = try XCTUnwrap(buttons.first)
            // The card's ground starts a point inside its border, and the view a little below the window's top.
            let card = try XCTUnwrap(found(try bitmap(host), ["code-bg"], dark: false)["code-bg"]?.box).offsetBy(dx: 0, dy: -host.convert(NSPoint.zero, from: view).y - 1)
            XCTAssertEqual(button.frame.size, CGSize(width: 20, height: 20))
            XCTAssertEqual(button.frame.minX, x, accuracy: 1, "\(fence): in from the card's right edge")
            XCTAssertEqual(button.frame.minY, card.minY + y, accuracy: 1.5, "\(fence): down from the card's top")
            XCTAssertEqual(button.toolTip, "Copy code")
            XCTAssertTrue(button.refusesFirstResponder, "a click on the button leaves the message's selection and focus alone")
            XCTAssertEqual(button.accessibilityLabel(), "Copy code")
            XCTAssertTrue(view.hitTest(view.convert(NSPoint(x: button.frame.midX, y: button.frame.midY), to: view.superview)) === button, "\(fence): a click reaches the button, not the text")
            var copied: [String] = []
            view.copyCode = { copied.append($0) }
            button.performClick(nil)
            XCTAssertEqual(copied, ["let x = 1"], fence)
        }
    }

    func testTheCopyButtonsShowThePointingHandAndFollowALongerBlock() throws {
        let (host, _) = shown(MessageText(text: "```swift\na\n```\n\n```\nb\n```", open: { _ in }), .aqua)
        let view = try XCTUnwrap(textView(in: host))
        let buttons = view.subviews.compactMap { $0 as? CopyButton }
        XCTAssertEqual(buttons.count, 2, "one button for each block")
        XCTAssertLessThan(buttons[0].frame.minY, buttons[1].frame.minY)
        for button in buttons {
            XCTAssertTrue(button.trackingAreas.contains { $0.options.contains(.cursorUpdate) }, "the button asks for cursorUpdate itself, since a cursor rect alone ends as the text view's I-beam")
            NSCursor.iBeam.set()
            button.cursorUpdate(with: try XCTUnwrap(NSEvent.mouseEvent(with: .mouseMoved, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 0, pressure: 0)))
            XCTAssertTrue(NSCursor.current === NSCursor.pointingHand)
        }
    }

    func testAClickOnTheFoldFooterOpensAndClosesTheBlock() throws {
        let blocks = OpenBlocks()
        let key = LongBlock.key(message: "m", block: 0)
        let (host, _) = shown(MessageText(text: "```\n\(long)\n```", foldKey: "m", blocks: blocks, open: { _ in }), .aqua)
        let view = try XCTUnwrap(textView(in: host))
        let at = (view.string as NSString).range(of: "Show all").location
        let link = try XCTUnwrap(view.textStorage?.attribute(.link, at: at, effectiveRange: nil) as? URL)
        XCTAssertEqual(link.scheme, "pardner-action")
        let delegate = try XCTUnwrap(view.delegate as? MessageText.Coordinator)
        XCTAssertTrue(delegate.textView(view, clickedOnLink: link, at: at))
        XCTAssertTrue(blocks.isOpen(key))
        XCTAssertTrue(delegate.textView(view, clickedOnLink: link, at: at))
        XCTAssertFalse(blocks.isOpen(key), "a second click closes it")
    }

    /// A link is the brand colour and the footer, which is a link run too, is the muted one (the layout manager's rendering attributes).
    func testALinkIsTheBrandColourWithTheHandAndTheFoldFooterIsMuted() throws {
        for (name, dark) in themes {
            let (host, _) = shown(MessageText(text: "[linked words and more linked words](https://example.com/x)", open: { _ in }), name, size: CGSize(width: 300, height: 60))
            let view = try XCTUnwrap(textView(in: host))
            XCTAssertEqual(view.linkTextAttributes?[.cursor] as? NSCursor, NSCursor.pointingHand)
            let ink = found(try bitmap(host), ["brand-text", "muted"], dark: dark, solid: false, tolerance: 0.1)
            XCTAssertGreaterThan(ink["brand-text"]?.count ?? 0, 5, "a link is the brand colour (\(name.rawValue))")
            XCTAssertEqual(ink["muted"]?.count ?? 0, 0)
            let (folded, _) = shown(MessageText(text: "```\n\(long)\n```", foldKey: "m", blocks: OpenBlocks(), open: { _ in }), name, size: CGSize(width: 400, height: 640))
            let all = found(try bitmap(folded), ["brand-text", "muted"], dark: dark, solid: false, tolerance: 0.1)
            XCTAssertEqual(all["brand-text"]?.count ?? 0, 0, "the footer is no brand colour (\(name.rawValue))")
            XCTAssertGreaterThan(all["muted"]?.count ?? 0, 5, "the footer is muted (\(name.rawValue))")
        }
    }

    /// I2: a link has no underline, as the block path draws it: the ink of its brand colour fills the same box.
    func testALinkIsDrawnAsTheBlockPathDrawsItWithNoUnderline() throws {
        let text = "see [linked words](https://example.com/x) here"
        for (name, dark) in themes {
            let size = CGSize(width: 300, height: 60)
            let old = found(try bitmap(shown(MarkdownView(text: text, mention: nil, foldKey: nil, blocks: OpenBlocks()), name, size: size).host), ["brand-text"], dark: dark, solid: false, tolerance: 0.1)["brand-text"]
            let new = found(try bitmap(shown(MessageText(text: text, open: { _ in }), name, size: size).host), ["brand-text"], dark: dark, solid: false, tolerance: 0.1)["brand-text"]
            assertSame(old?.box, new?.box, "the link's ink \(name.rawValue)")
            XCTAssertEqual(Double(new?.count ?? 0), Double(old?.count ?? 1), accuracy: Double(old?.count ?? 1) * 0.15, "the link's ink pixels \(name.rawValue): no underline")
        }
    }

    // MARK: fix round 1 of the review

    /// G2: a quote's bar is as high as a quoted code card, from the padding above a card with no header to what the card leaves under its last line.
    func testAQuoteBarReachesTheFullHeightOfAQuotedCodeCard() throws {
        let bars = CGRect(x: 0, y: 0, width: MarkdownView.barWidth, height: 320)
        for text in ["> text\n>\n> ```\n> code\n> ```", "> ```\n> x\n> ```", "> ```swift\n> x\n> ```", "> ```\n> x\n> ```\n>\n> after", "> ```\n> x\n> ```\n\nafter", "> ```swift\n> x\n> ```\n\nafter", "> text\n>\n> ```\n> code\n> ```\n\nafter"] {
            try compare(text, tokens: ["line"], thin: true, area: bars)
        }
    }

    /// G3: a rule in a quote or a list item starts at the paragraph's head indent, after the bars and the steps, as the block path's does (the code card, left out of
    /// the area, makes the view as wide as the block path's rule; G7).
    func testARuleInAQuoteOrAListItemStartsAtTheParagraphsIndent() throws {
        let step = MarkdownView.barWidth + MarkdownView.barGap
        for (text, start) in [("> a\n>\n> ---\n>\n> b\n\n```\nx\n```", step), ("> > a\n> >\n> > ---\n> >\n> > b\n\n```\nx\n```", 2 * step), ("- a\n\n  ---\n\n  b\n\n```\nx\n```", MarkdownView.listStep)] as [(String, CGFloat)] {
            for (name, dark) in themes {
                let area = CGRect(x: start - 4, y: 0, width: 400, height: 45)
                let old = found(try bitmap(shown(MarkdownView(text: text, mention: nil, foldKey: nil, blocks: OpenBlocks()), name).host), ["line"], dark: dark, in: area, thin: true)["line"]?.box
                let new = found(try bitmap(shown(MessageText(text: text, open: { _ in }), name).host), ["line"], dark: dark, in: area, thin: true)["line"]?.box
                XCTAssertEqual(old?.minX ?? -1, start, accuracy: 1.5, "the block path starts the rule at \(start): \(text.debugDescription) \(name.rawValue)")
                XCTAssertEqual(new?.minX ?? -1, old?.minX ?? -2, accuracy: 1.5, "the rule's left end: \(text.debugDescription) \(name.rawValue)")
                XCTAssertEqual(new?.minY ?? -1, old?.minY ?? -2, accuracy: 1.5, "the rule's height: \(text.debugDescription) \(name.rawValue)")
            }
        }
    }

    /// G7: a rule does not make the view as wide as it is given, so that no empty area right of a short line takes a click; it is drawn across the width the view has.
    /// G7, accepted as a case: a message with a rule takes the whole width, so the rule is as long as the block path's; the empty area right of its short
    /// lines belongs to the text view.
    func testARuleTakesTheWholeWidthAsTheBlockPathsDoes() throws {
        for (name, dark) in themes {
            let (host, _) = shown(MessageText(text: "above\n\n---\n\nbelow", open: { _ in }), name)
            let view = try XCTUnwrap(textView(in: host))
            XCTAssertGreaterThan(view.frame.width, 300, "the view takes the width it is given (\(name.rawValue))")
            let rule = try XCTUnwrap(found(try bitmap(host), ["line"], dark: dark, thin: true)["line"]?.box, "a rule is drawn (\(name.rawValue))")
            XCTAssertEqual(rule.minX, 0, accuracy: 1.5)
            XCTAssertEqual(rule.maxX, view.frame.width, accuracy: 1.5, "across the view (\(name.rawValue))")
            let old = try XCTUnwrap(found(try bitmap(shown(MarkdownView(text: "above\n\n---\n\nbelow", mention: nil, foldKey: nil, blocks: OpenBlocks()), name).host), ["line"], dark: dark, thin: true)["line"]?.box)
            XCTAssertEqual(rule.minY, old.minY, accuracy: 1.5, "at the block path's height (\(name.rawValue))")
            XCTAssertEqual(rule.maxX, old.maxX, accuracy: 1.5, "as long as the block path's (\(name.rawValue))")
            print("G7 \(name.rawValue): rule \(rule.minX)...\(rule.maxX) in a view \(view.frame.width) wide; the block path's \(old.minX)...\(old.maxX)")
        }
    }

    /// G4: inline code right after the mention's chip starts where the block path draws it: the ground's left edge is half the kern the mention's space has.
    func testInlineCodeAfterTheMentionIsDrawnWhereTheBlockPathDrawsIt() throws {
        try compare("`npm test` fails", mention: "@mini", tokens: ["code-inline", "mention-bg"])
    }

    /// M3: a code card's left edge is the paragraph's indent, not where its first line's glyphs start (a line of right-to-left text starts at the right).
    func testACodeCardsLeftEdgeDoesNotFollowItsFirstLinesGlyphs() throws {
        try compare("```\nשלום עולם זה טקסט\nlet x = 1\n```", tokens: ["code-bg"], foldKey: "m", edges: true)
        try compare("> ```swift\n> שלום\n> ```", tokens: ["code-bg"], foldKey: "m")
    }

    /// I1: in a long message the copy button sits on its card at every scroll position: the document is laid out before the button is placed, not estimated.
    func testACopyButtonSitsOnItsCardInALongMessageAtEveryScrollPosition() throws {
        let words = (1...60).map { "Paragraph line \($0) with some words." }.joined(separator: "\n\n")
        for (header, offset) in [("```swift", 3), ("```", 5)] as [(String, CGFloat)] {
            _ = NSApplication.shared
            PardnerFonts.register()
            let root = ScrollView { MessageText(text: "\(words)\n\n\(header)\nlet bottom = 1\n```", open: { _ in }).fixedSize(horizontal: false, vertical: true) }
            let host = NSHostingView(rootView: AnyView(root.designLines().frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).background(PardnerColor.bg)))
            host.appearance = NSAppearance(named: .aqua)
            host.frame = NSRect(x: 0, y: 0, width: 400, height: 300)
            let window = NSWindow(contentRect: host.frame, styleMask: [.titled, .resizable], backing: .buffered, defer: false)
            window.contentView = host
            host.layoutSubtreeIfNeeded()
            let view = try XCTUnwrap(textView(in: host))
            let scroll = try XCTUnwrap(view.enclosingScrollView)
            let button = try XCTUnwrap(view.subviews.compactMap { $0 as? CopyButton }.first)
            for fraction in [0, 0.5, 1] as [CGFloat] {
                scroll.contentView.scroll(to: NSPoint(x: 0, y: max(view.frame.height - 300, 0) * fraction))
                scroll.reflectScrolledClipView(scroll.contentView)
                host.layoutSubtreeIfNeeded()
                window.displayIfNeeded()
                let card = try XCTUnwrap(found(try bitmap(view), ["code-bg"], dark: false)["code-bg"]?.box.minY)
                XCTAssertGreaterThan(card, 1000, "the card is far down the message")
                XCTAssertEqual(button.frame.minY, card + offset, accuracy: 2, "\(header) at \(fraction) of the scroll: the button sits on its card")
                XCTAssertTrue(view.hitTest(view.convert(NSPoint(x: button.frame.midX, y: button.frame.midY), to: view.superview)) === button, "\(header) at \(fraction): a click on the card's corner reaches the button")
            }
        }
    }

    // MARK: fix round 2 of the review

    /// A scrolling message in a window, its scroll view and its text view, laid out.
    private func scrolling(_ text: String, width: CGFloat = 400) throws -> (host: NSHostingView<AnyView>, window: NSWindow, scroll: NSScrollView, view: MessageTextView) {
        _ = NSApplication.shared
        PardnerFonts.register()
        let blocks = OpenBlocks()
        let root = ScrollView { MessageText(text: text, foldKey: "m", blocks: blocks, open: { _ in }).fixedSize(horizontal: false, vertical: true) }
        let host = NSHostingView(rootView: AnyView(root.designLines().frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).background(PardnerColor.bg)))
        host.appearance = NSAppearance(named: .aqua)
        host.frame = NSRect(x: 0, y: 0, width: width, height: 300)
        let window = NSWindow(contentRect: host.frame, styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        let view = try XCTUnwrap(textView(in: host))
        return (host, window, try XCTUnwrap(view.enclosingScrollView), view)
    }

    /// I4: a scroll step lays the view out again and places the copy buttons no more, since it changes neither the width nor the text (placing them lays the
    /// whole document out, up to 37 ms a step deep in a 3,000-line opened block). The test counts placements, which holds on any machine; its block has 300
    /// lines, since a message over `CodeSpans.most` characters is not read as blocks at all. A width change and a fold toggle do place them, and the buttons follow.
    func testAScrollStepDoesNotPlaceTheCopyButtonsAgainButAWidthChangeAndAFoldToggleDo() throws {
        let words = (1...20).map { "Paragraph line \($0) with some words." }.joined(separator: "\n\n")
        let code = (1...300).map { "let value\($0) = compute(\($0)) // a comment" }.joined(separator: "\n")
        let text = "\(words)\n\n```swift\n\(code)\n```\n\n\(words)\n\n```\nlet bottom = 1\n```"
        let (host, window, scroll, view) = try scrolling(text)
        let blocks = try XCTUnwrap((view.delegate as? MessageText.Coordinator)?.blocks)
        let message = MessageText(text: text, foldKey: "m", blocks: blocks, open: { _ in })
        let coordinator = try XCTUnwrap(view.delegate as? MessageText.Coordinator)
        // A click on the block's fold footer; SwiftUI asks for the update when the open blocks change, and the offscreen window is not always updated in
        // time, so the test asks.
        func toggle() throws {
            var footer: (url: URL, at: Int)?
            view.textStorage?.enumerateAttribute(.link, in: NSRange(location: 0, length: view.string.count)) { value, range, stop in
                if let url = value as? URL, url.scheme == MessageText.action { footer = (url, range.location); stop.pointee = true }
            }
            let (url, at) = try XCTUnwrap(footer)
            XCTAssertTrue(coordinator.textView(view, clickedOnLink: url, at: at))
            message.apply(to: view, coordinator: coordinator)
            host.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
        }
        let closed = view.string.count
        try toggle()
        XCTAssertGreaterThan(view.string.count, closed + 5000, "the block is open")
        let buttons = view.subviews.compactMap { $0 as? CopyButton }
        XCTAssertEqual(buttons.count, 2)
        let placed = view.placements
        for step in 1...20 {
            scroll.contentView.scroll(to: NSPoint(x: 0, y: CGFloat(step) * 300))
            scroll.reflectScrolledClipView(scroll.contentView)
            host.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
        }
        XCTAssertEqual(view.placements, placed, "a scroll step places no button")
        let before = buttons.map(\.frame.origin)
        host.frame.size.width = 300
        host.layoutSubtreeIfNeeded()
        XCTAssertGreaterThan(view.placements, placed, "a width change places the buttons")
        for (button, old) in zip(buttons, before) { XCTAssertEqual(button.frame.minX, old.x - 100, accuracy: 1, "the button follows the right edge") }
        let afterWidth = view.placements, narrow = buttons[1].frame.minY
        try toggle()
        XCTAssertLessThan(view.string.count, closed + 100, "the block is closed")
        XCTAssertGreaterThan(view.placements, afterWidth, "a fold toggle places the buttons")
        XCTAssertLessThan(buttons[1].frame.minY, narrow - 1000, "the second block's button moved up with the closed block")
    }
}
