// Long conversations hosted in a real window, for the tests that measure what a scroll view draws after rows are added.
import AppKit
import Conversation
import ProtocolHost
import SwiftUI
import XCTest

/// A channel with one bot and one person, to which messages are added the way the relay delivers them.
struct ScrollFixture {
    let channel = Data(repeating: 1, count: 32)
    let alice = Data(repeating: 2, count: 32)
    let bot = Data(repeating: 3, count: 32)
    private(set) var position = 1
    private(set) var model = ReadingModel()
    /// The last message put, as the reading was handed it: what a conversation model takes as delivered.
    private(set) var lastView: HostValue?

    @discardableResult
    mutating func put(_ kind: Int, _ sender: Data, _ body: [String: Any]?, to: Data? = nil, re: MessageRef? = nil, name: Data? = nil) -> MessageRef {
        let at = position
        position += 1
        let messageName = name ?? Data(repeating: UInt8(at & 0xFF), count: 16)
        let view = HostValue.object([
            "do": .string("message"), "position": .number(Double(at)), "channel": .bytes(channel), "sender": .bytes(sender),
            "name": .bytes(messageName), "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(1_700_000_000_000 + Double(at) * 1000),
            "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null, "blobs": .array([]), "files": .array([]),
            "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null,
            "text": body.map { .string(String(decoding: try! JSONSerialization.data(withJSONObject: $0), as: UTF8.self)) } ?? .null, "again": .bool(false),
        ])
        model.take(view: view)
        lastView = view
        return MessageRef(device: sender, name: messageName)
    }

    /// About 3,600 characters of Markdown: headings, links, lists, a code block and a table.
    static func markdown(_ n: Int) -> String {
        var s = "## Section \(n): findings\n\n"
        for p in 0..<6 {
            s += "Paragraph \(p) of answer \(n) explains the **result** with [link one](https://example.com/a\(n)/\(p)) and [link two](https://example.com/b/\(p)) and `code span` plus more words to wrap across the line width of the panel, repeated for length. "
            s += "Another sentence with [a third link](https://example.org/c) and *emphasis* continues here so that it wraps onto several lines in the narrow column.\n\n"
            if p % 2 == 0 { s += "### Subheading \(p)\n\n- first **bullet** with [a link](https://example.com/x\(p)) and a long tail of words to wrap around\n- second bullet with `inline code` and more text that is long enough to wrap onto two lines of the panel\n- third bullet\n\n" }
        }
        s += "```swift\nfunc example() {\n    let x = 1\n    print(x)\n}\n```\n\n| Name | Value | Note |\n|---|---|---|\n| a | 1 | first |\n| b | 2 | second |\n\n"
        return s
    }
}

/// What the scroll view of a hosted view shows.
struct ScrollMeasure {
    let documentHeight: CGFloat
    let visible: CGRect
    /// Pixels of the scroll view's area that differ from its background.
    let drawn: Int
}

@MainActor
enum ScrollHost {
    static let size = NSSize(width: 950, height: 1000)

    /// Hosts `root` in an offscreen window; the window is closed by the caller through the returned view's window.
    static func host<V: View>(_ root: V) -> NSHostingView<V> {
        let hosting = NSHostingView(rootView: root)
        let window = NSWindow(contentRect: NSRect(origin: NSPoint(x: -3000, y: -3000), size: size), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = hosting
        hosting.frame = NSRect(origin: .zero, size: size)
        window.orderFront(nil)
        return hosting
    }

    static func spin(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

    static func scrollView(in view: NSView) -> NSScrollView? {
        if let scroll = view as? NSScrollView { return scroll }
        return view.subviews.lazy.compactMap { scrollView(in: $0) }.first
    }

    /// Renders the view and counts the pixels of its scroll view that differ from the background beside it.
    static func measure(_ hosting: NSView) -> ScrollMeasure? {
        hosting.layoutSubtreeIfNeeded()
        guard let scroll = scrollView(in: hosting), let document = scroll.documentView,
              let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { return nil }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        var area = scroll.convert(scroll.bounds, to: hosting)
        let scale = CGFloat(rep.pixelsWide) / hosting.bounds.width
        if !hosting.isFlipped { area.origin.y = hosting.bounds.height - area.maxY }
        let (x0, x1, y0, y1) = (Int(area.minX * scale), Int(area.maxX * scale), Int(area.minY * scale), Int(area.maxY * scale))
        guard let background = rep.colorAt(x: x0 + 2, y: Int(area.midY * scale))?.usingColorSpace(.sRGB) else { return nil }
        var drawn = 0
        for y in y0..<y1 {
            for x in x0..<x1 {
                guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                if abs(c.redComponent - background.redComponent) + abs(c.greenComponent - background.greenComponent)
                    + abs(c.blueComponent - background.blueComponent) > 0.03 { drawn += 1 }
            }
        }
        return ScrollMeasure(documentHeight: document.frame.height, visible: scroll.documentVisibleRect, drawn: drawn)
    }
}
