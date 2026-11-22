import AppKit
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

/// Holds the pairing model, ends the controller on quit (which runs whether or not a window is open) and keeps the standard Mac
/// behaviour of a main window: closing it leaves the app running, and the Dock icon opens it again. A single `Window` scene would quit
/// the app when it closed, so the delegate says otherwise. A window with the recovery sheet attached does not close (`performClose`
/// does nothing while a sheet is attached), so a sheet on screen is never lost to a close; the model and the sheet outlive a closed window.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// How long a quit waits for the connection to end: a hung shutdown replies anyway.
    static let quitDeadline: Duration = .seconds(5)

    let pairing = PairingModel.live()
    /// Set by the scene's view (SwiftUI's `openWindow(id:)` is the documented way to show a `Window` again).
    var showWindow: (() -> Void)?
    private var replied = false

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // A click on the Dock icon with no window on screen: the scene's own window is shown again.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows { showWindow?() }
        return true
    }

    // The controller shuts down first, off the main actor: it marks itself shut down and only then declines a sheet on screen, so a
    // declined setup leaves its cleaning to the next launch instead of erasing while the process exits. The view's sheet is closed
    // (its buffers wiped) on the main thread when the reply is given. The reply is queued on the main run loop in the common modes,
    // which a terminate called from a main-actor job still runs (AppKit waits in a nested modal loop that does not run main-queue
    // work, so a hop to the main actor would never arrive). A deadline replies if the shutdown hangs: one answer, whichever comes first.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let pairing = pairing
        Task.detached {
            await pairing.endConnectionForQuit()
            self.replyThroughRunLoop()
        }
        Task.detached {
            try? await Task.sleep(for: Self.quitDeadline)
            self.replyThroughRunLoop()
        }
        return .terminateLater
    }

    private nonisolated func replyThroughRunLoop() {
        RunLoop.main.perform(inModes: [.common]) { MainActor.assumeIsolated { self.reply() } }
    }

    private func reply() {
        guard !replied else { return }
        replied = true
        pairing.closeSheetForQuit()
        NSApplication.shared.reply(toApplicationShouldTerminate: true)
    }
}

@main
struct PardnerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @AppStorage("theme") private var theme = Theme.light.rawValue
    @Environment(\.openWindow) private var openWindow

    init() {
        let log = Logger(subsystem: "io.github.duqaxxx.pardner", category: "fonts")
        for failure in PardnerFonts.register() { log.error("a font did not register: \(failure.description, privacy: .public)") }
        // Before the first window, so that it never draws once in the system's appearance.
        (Theme(rawValue: UserDefaults.standard.string(forKey: "theme") ?? "") ?? .light).apply()
    }

    var body: some Scene {
        // One window: the pairing model and the recovery sheet are single, and a second window over them would share one entry and one
        // secure-input flag. The scene has no New Window command.
        Window("Pardner", id: "main") {
            // The pairing screens until this Mac is paired; then the main window over what the link delivered.
            PairingRoot(model: delegate.pairing) { LiveMainWindow(conversation: delegate.pairing.conversation, devices: delegate.pairing.devices, channels: delegate.pairing.channels, composers: delegate.pairing.composers) }
                .frame(minHeight: MainWindow.leastHeight)
                .task { delegate.pairing.start() }
                .onAppear { delegate.showWindow = { openWindow(id: "main") } }
                .onChange(of: theme) { _, value in (Theme(rawValue: value) ?? .light).apply() }
        }
        // Room for the three columns at their first-launch widths and a thread open.
        .defaultSize(width: 1280, height: 800)
        .commands {
            // The Devices sheet and the new channel's sheet over the main window, once this Mac is paired and while no sheet is up.
            CommandGroup(after: .newItem) {
                let pairing = delegate.pairing
                let paired = pairing.screen == .paired
                Button("New Channel…") {
                    // The menu item is off while a sheet is up; the rule is read again at the act, as a key can arrive before the menu redraws.
                    guard Menus.canMakeChannel(paired: pairing.screen == .paired, devices: pairing.devices, channels: pairing.channels) else { return }
                    pairing.channels.openNew()
                    delegate.showWindow?()
                }
                .keyboardShortcut("n", modifiers: .command).disabled(!Menus.canMakeChannel(paired: paired, devices: pairing.devices, channels: pairing.channels))
                Button("Devices…") {
                    guard Menus.canOpenDevices(paired: pairing.screen == .paired, devices: pairing.devices, channels: pairing.channels) else { return }
                    pairing.devices.open()
                    delegate.showWindow?() // the window may be closed: the sheet opens over the window the Dock would show
                }
                .keyboardShortcut("d", modifiers: [.command, .shift]).disabled(!Menus.canOpenDevices(paired: paired, devices: pairing.devices, channels: pairing.channels))
            }
            CommandGroup(after: .toolbar) {
                Picker("Appearance", selection: $theme) {
                    ForEach(Theme.allCases, id: \.rawValue) { Text($0.rawValue).tag($0.rawValue) }
                }
            }
        }
    }
}
