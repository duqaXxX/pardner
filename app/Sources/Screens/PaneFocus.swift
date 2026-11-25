// Which pane of the main window the person last acted in, and the scroll bar that shows only in that pane (step F design FB, 3.3).
import AppKit
import SwiftUI

/// The pane the person last acted in, and whether the window is key: two values kept apart, so that a window that comes back to the front
/// gives the bar back to the pane it left with no click. `ColumnsController` owns it and hands it to the three hosts.
@MainActor @Observable
final class PaneFocus {
    enum Pane { case sidebar, conversation, panel }

    /// The pane last acted in; a click on a divider or a first responder outside every pane leaves it.
    private(set) var pane: Pane?
    /// Whether the main window is the key window.
    var key = false

    /// A pane has the focus while the window is key and it is the one last acted in.
    func focused(_ mine: Pane) -> Bool { key && pane == mine }

    /// A mouse-down or a first responder in `pane`; nil, an act in no pane, changes nothing.
    func acted(in pane: Pane?) {
        if let pane, pane != self.pane { self.pane = pane }
    }

    /// The pane whose frame holds `point`, the frames of the sidebar, the conversation and the panel in one coordinate space.
    nonisolated static func pane(at point: CGPoint, in frames: [CGRect]) -> Pane? {
        for (frame, pane) in zip(frames, [Pane.sidebar, .conversation, .panel]) where frame.contains(point) { return pane }
        return nil
    }
}

/// A scroll view that shows its vertical indicator while its pane has the focus. `.never` and not `.hidden`: a legacy scroller stays under
/// `.hidden`. While a legacy bar is hidden over content that overflows, its width stays as an empty margin, so that a change of focus does not
/// rewrap the pane's lines; content that fits has no bar to leave room for.
struct FocusedScrollbar: ViewModifier {
    let pane: PaneFocus.Pane
    /// The scroller style to assume; nil follows the system's (a test sets it, since a process cannot be put in the legacy style).
    var legacyStyle: Bool?
    @Environment(PaneFocus.self) private var focus: PaneFocus?
    @State private var legacy = NSScroller.preferredScrollerStyle == .legacy
    @State private var overflows = false

    /// The room the scroller's width keeps while its bar is hidden under the legacy style over content that overflows; an overlay bar takes none.
    static func margin(shown: Bool, legacy: Bool, overflows: Bool) -> CGFloat {
        !shown && legacy && overflows ? NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy) : 0
    }

    func body(content: Content) -> some View {
        // With no focus object (a view outside the main window) there is no pane to follow: the system's bar.
        let shown = focus?.focused(pane) ?? true
        content
            .onScrollGeometryChange(for: Bool.self, of: { $0.contentSize.height > $0.containerSize.height }) { _, new in overflows = new }
            // The vertical axis alone: a table's or a code block's own sideways scroll keeps its bar.
            .scrollIndicators(shown ? .automatic : .never, axes: .vertical)
            .padding(.trailing, Self.margin(shown: shown, legacy: legacyStyle ?? legacy, overflows: overflows))
            // Plugging a mouse in or out changes the style, and with it whether the margin is owed.
            .onReceive(NotificationCenter.default.publisher(for: NSScroller.preferredScrollerStyleDidChangeNotification)) { _ in
                legacy = NSScroller.preferredScrollerStyle == .legacy
            }
    }
}

extension View {
    func focusedScrollbar(_ pane: PaneFocus.Pane, legacy: Bool? = nil) -> some View { modifier(FocusedScrollbar(pane: pane, legacyStyle: legacy)) }
}
