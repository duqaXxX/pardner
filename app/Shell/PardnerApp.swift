import AppKit
import DesignSystem
import os
import Screens
import SwiftUI

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
    /// The main window, found from its view: a Dock click shows it when it is not visible, whatever other window is.
    weak var mainWindow: NSWindow?
    private var replied = false

    func showMainWindowIfHidden() { if !(mainWindow?.isVisible ?? false) { showWindow?() } }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // A click on the Dock icon while the main window is not on screen (Settings or a form may be): the scene's own window is shown again.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        showMainWindowIfHidden()
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
    @AppStorage(Theme.storageKey) private var theme = Theme.fallback.rawValue
    @Environment(\.openWindow) private var openWindow

    init() {
        let log = Logger(subsystem: "io.github.duqaxxx.pardner", category: "fonts")
        for failure in PardnerFonts.register() { log.error("a font did not register: \(failure.description, privacy: .public)") }
        // Before the first window, so that it never draws once in the system's appearance.
        (Theme(rawValue: UserDefaults.standard.string(forKey: Theme.storageKey) ?? "") ?? Theme.fallback).apply()
    }

    var body: some Scene {
        // One window: the pairing model and the recovery sheet are single, and a second window over them would share one entry and one
        // secure-input flag. The scene has no New Window command.
        Window("Pardner", id: "main") {
            // The pairing screens until this Mac is paired; then the main window over what the link delivered.
            PairingRoot(model: delegate.pairing) { LiveMainWindow(conversation: delegate.pairing.conversation, devices: delegate.pairing.devices, settings: delegate.pairing.settings, channels: delegate.pairing.channels, sections: delegate.pairing.sections, composers: delegate.pairing.composers) }
                .frame(minHeight: MainWindow.leastHeight)
                .environment(delegate.pairing.files)
                .task { delegate.pairing.start() }
                .background(WindowReader { delegate.mainWindow = $0 })
                .onAppear {
                    delegate.showWindow = { openWindow(id: "main") }
                    delegate.pairing.settings.present = { openWindow(id: WindowID.settings) }
                    delegate.pairing.channels.present = { openWindow(id: WindowID.form) }
                    delegate.pairing.onLeftPaired = { [weak delegate] in delegate?.showMainWindowIfHidden() }
                }
                .onChange(of: theme) { _, value in (Theme(rawValue: value) ?? Theme.fallback).apply() }
        }
        // Room for the three columns at their first-launch widths and a thread open.
        .defaultSize(width: 1280, height: 800)
        // No title bar: the sidebar runs the window's height (its own "Pardner" is the name on screen) and the traffic lights stay.
        .windowStyle(.hiddenTitleBar)
        .commands {
            // The Settings window (Devices is one of its panes) and the form window, once this Mac is paired. An open window comes forward.
            CommandGroup(replacing: .appSettings) {
                let pairing = delegate.pairing
                Button("Settings…") { if pairing.screen == .paired { pairing.settings.open(.general) } }
                    .keyboardShortcut(",", modifiers: .command).disabled(pairing.screen != .paired)
            }
            CommandGroup(after: .newItem) {
                let pairing = delegate.pairing
                let paired = pairing.screen == .paired
                Button("New Channel…") {
                    // The item is off until the channels are ready; the rule is read again at the act, as a key can arrive before the menu redraws.
                    guard Menus.canMakeChannel(paired: pairing.screen == .paired, channels: pairing.channels) else { return }
                    pairing.channels.openNew()
                }
                .keyboardShortcut("n", modifiers: .command).disabled(!Menus.canMakeChannel(paired: paired, channels: pairing.channels))
                Button("Devices…") { if pairing.screen == .paired { pairing.settings.open(.devices) } }
                    .keyboardShortcut("d", modifiers: [.command, .shift]).disabled(!paired)
            }
            CommandGroup(after: .toolbar) {
                Picker("Appearance", selection: $theme) {
                    ForEach(Theme.allCases, id: \.rawValue) { Text($0.rawValue).tag($0.rawValue) }
                }
            }
        }
        // Settings and the forms are windows of their own, closed by the window's controls (app windows design 3). The Window menu would list
        // them and open them empty, so they carry no commands; nothing is restored at launch.
        Window("Settings", id: WindowID.settings) {
            LiveSettingsWindow(conversation: delegate.pairing.conversation, settings: delegate.pairing.settings, channels: delegate.pairing.channels)
        }
        .windowStyle(.hiddenTitleBar).windowResizability(.contentSize).restorationBehavior(.disabled).commandsRemoved()
        Window("Form", id: WindowID.form) {
            LiveFormWindow(conversation: delegate.pairing.conversation, channels: delegate.pairing.channels)
        }
        .windowStyle(.hiddenTitleBar).windowResizability(.contentSize).restorationBehavior(.disabled).commandsRemoved()
        // A reply read whole (turn work C1, 3.4): one window per reply, closed by the window's controls.
        WindowGroup("Reply", id: WindowID.reply, for: ReplyContent.self) { $content in
            ReplyWindow(content: content)
        }
        .defaultSize(width: 640, height: 520).restorationBehavior(.disabled).commandsRemoved()
        // A file read whole (file-content design, 3.7): one window per path and thread, closed by the window's controls.
        WindowGroup("File", id: WindowID.file, for: FileWindowContent.self) { $content in
            FileWindow(content: content, opener: delegate.pairing.files)
        }
        .defaultSize(width: 760, height: 600).restorationBehavior(.disabled).commandsRemoved()
    }
}

/// Hands the window that holds the view to `found`.
private struct WindowReader: NSViewRepresentable {
    let found: (NSWindow) -> Void

    /// Reports each window it lands in, so a main window made again after a close is found too.
    final class Anchor: NSView {
        var found: ((NSWindow) -> Void)?
        override func viewDidMoveToWindow() { if let window { found?(window) } }
    }

    func makeNSView(context: Context) -> NSView {
        let view = Anchor()
        view.found = found
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {}
}
