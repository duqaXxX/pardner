import AppKit
import Conversation
import DesignSystem
import os
import Screens
import SwiftUI

/// The app's theme: Light or Dark, the app's own setting (design system, section 7, decision 1).
enum Theme: String, CaseIterable {
    case light = "Light", dark = "Dark"

    // One setting for every window, sheet and menu the app draws, rather than a colour scheme per window.
    func apply() { NSApplication.shared.appearance = NSAppearance(named: self == .dark ? .darkAqua : .aqua) }
}

@main
struct PardnerApp: App {
    @AppStorage("theme") private var theme = Theme.light.rawValue

    init() {
        let log = Logger(subsystem: "io.github.duqaxxx.pardner", category: "fonts")
        for failure in PardnerFonts.register() { log.error("a font did not register: \(failure.description, privacy: .public)") }
        // Before the first window, so that it never draws once in the system's appearance.
        (Theme(rawValue: UserDefaults.standard.string(forKey: "theme") ?? "") ?? .light).apply()
    }

    var body: some Scene {
        WindowGroup("Pardner") {
            // No device is paired yet (step-6 plan, screen 3.9): the window shows its empty state.
            MainWindow(model: ReadingModel())
                .frame(minWidth: MainWindow.minimumWidth, minHeight: 560)
                .onChange(of: theme) { _, value in (Theme(rawValue: value) ?? .light).apply() }
        }
        .commands {
            CommandGroup(after: .toolbar) {
                Picker("Appearance", selection: $theme) {
                    ForEach(Theme.allCases, id: \.rawValue) { Text($0.rawValue).tag($0.rawValue) }
                }
            }
        }
    }
}
