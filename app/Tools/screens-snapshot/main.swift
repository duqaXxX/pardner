// Renders the main window over the synthetic conversation and the pairing screens, in Light and Dark, to PNG files: the
// screenshots of the screens' decisions documents. Usage: swift run screens-snapshot <out dir>. Offscreen: no window shows.
// Everything drawn is synthetic: a relay at relay.example.net, made-up keys, and a recovery key that opens nothing.
import AppKit
import DesignSystem
import Platform
import Relay
import Screens
import SwiftUI

let out = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? ".")
_ = NSApplication.shared
for failure in PardnerFonts.register() { FileHandle.standardError.write(Data("font: \(failure)\n".utf8)) }

/// The sheet's source with a made-up secret: the screenshot's only copy of a key, never a real one.
final class SyntheticKey: RecoverySource {
    // Patterned hex, so that none of it can be mistaken for a real key.
    let context = "Person: \(String(repeating: "0123456789abcdef", count: 4))\nRelay: relay.example.net:7443\nRelay key: 04\(String(repeating: "abcd", count: 32))"
    private let bytes = (0..<32).map { UInt8(($0 * 37 + 11) & 0xFF) }
    func withSecret<T>(_ body: (UnsafeRawBufferPointer) -> T) -> T? { bytes.withUnsafeBytes(body) }
    func answer(_ confirmed: Bool) {}

    /// What the person would type for the first `count` symbols.
    func typed(_ count: Int) -> [UniChar] {
        let secret = SecretBuffer(count: 32)
        secret.withUnsafeMutableBytes { $0.copyBytes(from: bytes) }
        var shown = [UniChar](repeating: 0, count: RecoveryText.displayCount)
        shown.withUnsafeMutableBufferPointer { RecoveryText.write(secret, into: $0) }
        return Array(shown.filter { $0 != 0x2D }.prefix(count))
    }
}

@MainActor
func render<V: View>(_ name: NSAppearance.Name, _ view: V, size: NSSize?, to file: String) throws {
    let hosting = NSHostingView(rootView: view)
    hosting.appearance = NSAppearance(named: name)
    let size = size ?? hosting.fittingSize
    let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: name)
    window.contentView = hosting
    hosting.frame = NSRect(origin: .zero, size: size)
    hosting.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.5)) // let SwiftUI lay out and draw once
    guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { throw CocoaError(.fileWriteUnknown) }
    hosting.cacheDisplay(in: hosting.bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
    try png.write(to: out.appendingPathComponent(file))
}

MainActor.assumeIsolated {
    do {
        let themes: [(NSAppearance.Name, String)] = [(.aqua, "light"), (.darkAqua, "dark")]
        let page = NSSize(width: 1050, height: 640)
        let screens: [(String, () -> PairingModel)] = [
            ("first", { PairingModel(phase: .unpaired(nil)) }),
            ("first-stale-sheet", { PairingModel(phase: .unpaired(.staleSheet)) }),
            ("form", { PairingModel(phase: .unpaired(nil), form: true) }),
            ("form-errors", {
                let m = PairingModel(phase: .unpaired(nil), form: true, refused: .relayKey)
                m.address = "relay.example.net:7443"
                m.relayKey = "04a1b2c3"
                return m
            }),
            ("setting-up", { PairingModel(phase: .settingUp) }),
            ("enrolling", { PairingModel(phase: .enrolling(asksSecret: false)) }),
            ("enrolling-waits", { PairingModel(phase: .enrolling(asksSecret: false), note: .waitForAnswer) }),
            ("enrolling-asks-secret", { PairingModel(phase: .enrolling(asksSecret: true)) }),
            ("enrolling-confirm-cancel", { PairingModel(phase: .enrolling(asksSecret: false), note: .confirmUnreachable) }),
            ("removed", { PairingModel(phase: .removed) }),
            ("keys-missing", { PairingModel(phase: .keysMissing) }),
            ("keys-without-store", { PairingModel(phase: .fault(.keysWithoutStore, "This Mac holds device keys that no pairing owns. Pair again makes it a new device; remove the old one from another device.")) }),
            ("put-back", { PairingModel(phase: .putBack(PairingPhase.putBackAdvice)) }),
            ("fault-retry", { PairingModel(phase: .fault(.failed, "the relay's address did not resolve")) }),
            ("link-faulted", { PairingModel(phase: .linkFaulted(PairingPhase.linkFaultAdvice)) }),
            ("malformed-store", { PairingModel(phase: .fault(.malformedStore, PairingPhase.malformedStoreWarning)) }),
            ("newer-store", { PairingModel(phase: .fault(.newerStore, PairingPhase.newerStoreAdvice)) }),
        ]
        for (appearance, theme) in themes {
            let sample = Samples.model()
            try render(appearance, MainWindow(model: sample.model, channel: sample.channel, thread: sample.thread), size: NSSize(width: 1280, height: 800), to: "window-\(theme).png")
            for (name, make) in screens { try render(appearance, PairingScreen(model: make()), size: page, to: "\(name)-\(theme).png") }
            let source = SyntheticKey()
            let empty = RecoverySheetModel(source: source)
            try render(appearance, RecoverySheetView(model: empty), size: nil, to: "recovery-sheet-\(theme).png")
            let partial = RecoverySheetModel(source: source)
            source.typed(31).forEach { partial.key($0) }
            try render(appearance, RecoverySheetView(model: partial), size: nil, to: "recovery-sheet-typing-\(theme).png")
            let full = RecoverySheetModel(source: source)
            source.typed(53).forEach { full.key($0) }
            try render(appearance, RecoverySheetView(model: full), size: nil, to: "recovery-sheet-matched-\(theme).png")
        }
    } catch {
        FileHandle.standardError.write(Data("\(error)\n".utf8))
        exit(1)
    }
}
