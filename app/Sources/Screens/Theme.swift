import AppKit

/// The app's theme: Light or Dark, the app's own setting (design system, section 7, decision 1). It is kept under `theme` in the app's
/// defaults, by the View menu's picker and the Settings panel's General pane alike.
public enum Theme: String, CaseIterable, Sendable {
    case light = "Light", dark = "Dark"

    /// The key under which the app's defaults keep the theme, and the theme before one is chosen.
    public static let storageKey = "theme"
    public static let fallback = Theme.light

    /// One setting for every window, sheet and menu the app draws, rather than a colour scheme per window.
    @MainActor public func apply() { NSApplication.shared.appearance = NSAppearance(named: self == .dark ? .darkAqua : .aqua) }
}
