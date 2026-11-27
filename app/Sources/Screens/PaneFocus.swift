// Which pane of the main window the person last acted in (step F design FB, 3.3). Nothing reads it yet: the scroll bars it served follow the system's setting.
import AppKit
import SwiftUI

/// The pane the person last acted in, and whether the window is key: two values kept apart, so that a window that comes back to the front
/// gives the focus back to the pane it left with no click. `ColumnsController` owns it and hands it to the three hosts.
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
