// The pointing hand over what can be clicked (#133), from one place: a button takes it from its style, any other control from `clickable`.
// A disabled element keeps the arrow, and a text field keeps the text cursor. `ClickableTests` fails on a `.plain` button style or a
// `pointerStyle` written anywhere else in the screens.
import SwiftUI

/// SwiftUI's plain button with the pointing hand while the button is enabled.
struct ClickableButtonStyle: PrimitiveButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        Button(configuration).buttonStyle(PlainButtonStyle()).clickable(enabled)
    }
}

extension PrimitiveButtonStyle where Self == ClickableButtonStyle {
    /// The plain style of a button drawn by its own label, with the pointing hand.
    static var clickable: ClickableButtonStyle { ClickableButtonStyle() }
}

extension View {
    /// The pointing hand over a control that is no button of ours (a menu, a picker, a toggle, a system button) while `on`: the caller passes
    /// the control's own enabled state, since a modifier outside `disabled` does not see it.
    func clickable(_ on: Bool = true) -> some View { pointerStyle(on ? .link : nil) }
}
