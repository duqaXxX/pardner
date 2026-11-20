// Renders the main window over the synthetic conversation, the pairing screens and the Devices screens, in Light and Dark, to PNG files: the
// screenshots of the screens' decisions documents. Usage: swift run screens-snapshot <out dir>. Offscreen: no window shows.
// Everything drawn is synthetic: a relay at relay.example.net, made-up keys, and a recovery key that opens nothing.
import AppKit
import DesignSystem
import Conversation
import Platform
import ProtocolHost
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

/// The devices of a synthetic person: this Mac, its bot, a Mac named "Studio Mac" and a device added by a removed one. Newest first.
@MainActor
func sampleDevices(seenTogether: Bool = true, pending: Bool = false, addName: String? = nil, removing: [Data] = [], onlyHolder: Int = 0, notice: DevicesNotice? = nil,
                   studio: String = "Studio Mac") -> DevicesState {
    func id(_ byte: UInt8) -> Data { Data(repeating: byte, count: 32) }
    func short(_ byte: UInt8) -> String { Array(repeating: String(format: "%02x%02x", byte, byte), count: 4).joined(separator: "-") }
    let day = Date(timeIntervalSince1970: 1_763_600_000) // 2025-11-20, the samples' Thursday
    func row(_ byte: UInt8, _ kind: DeviceKind, _ label: String?, _ adder: DeviceAdder, _ position: Int, mac: Bool = false, held: Int = 0, hours: Double, whileRemoving: Bool = false) -> DeviceRow {
        DeviceRow(id: id(byte), kind: kind, label: label, shortForm: short(byte), adder: adder, position: position, active: true, isThisMac: mac, seenAt: day.addingTimeInterval(hours * 3600),
                  onlyHolderEpochs: held, addedWhileRemoving: whileRemoving)
    }
    var state = DevicesState()
    state.rows = [
        row(0x5a, .app, nil, .removedDevice, 6, held: onlyHolder, hours: 0, whileRemoving: !removing.isEmpty),
        row(0x3c, .app, studio, .device(id(0x11)), 4, hours: 0),
        row(0x2b, .bot, nil, .device(id(0x11)), 2, hours: 0),
        row(0x11, .app, "Work Mac", .none, 0, mac: true, hours: 0),
    ]
    (state.pendingEntry, state.pendingAddName, state.removing, state.seenTogether, state.notice) = (pending, addName, removing, seenTogether, notice)
    return state
}

let handoff = PairingHandoff(relayAddress: "relay.example.net:7443", relayKey: "04" + String(repeating: "abcd", count: 32), person: String(repeating: "0123456789abcdef", count: 4))
let candidate = DeviceCandidate(kind: .app, name: "Laptop", shortForm: "aaaa-bbbb-cccc-dddd", device: .null, proof: Data())
let hostileCandidate = DeviceCandidate(kind: .app, name: "A\u{201D}, position 0, \u{201C}B and a name that goes on past the edge of the card", shortForm: "aaaa-bbbb-cccc-dddd", device: .null, proof: Data())
let studio = Data(repeating: 0x3c, count: 32)
// A name that tries to close the app's sentence and add its own, and one too long for the card: both are drawn in a Text of their own.
let hostile = "A\u{201D}, position 0, \u{201C}B"
let tooLong = "Studio Mac of the third floor, the one with the broken fan and the sticker on the lid, Room 4 (old)"

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
        let sheets: [(String, () -> DevicesModel)] = [
            ("devices-list", { DevicesModel(state: sampleDevices()) }),
            ("devices-list-adding", { DevicesModel(state: sampleDevices(seenTogether: false, pending: true, addName: "Laptop")) }),
            ("devices-list-removing", { DevicesModel(state: sampleDevices(seenTogether: false, pending: true, removing: [Data(repeating: 0x5a, count: 32), studio])) }),
            ("devices-list-notice", { DevicesModel(state: sampleDevices(notice: .addRefused(.label("Laptop")))) }),
            ("devices-list-notice-unnamed", { DevicesModel(state: sampleDevices(notice: .addRefused(.shortForm(.app, "2b2b-2b2b-2b2b-2b2b")))) }),
            ("devices-list-hostile", { DevicesModel(state: sampleDevices(seenTogether: false, pending: true, addName: tooLong, notice: .addRefused(.label(hostile)), studio: hostile)) }),
            ("devices-list-long-name", { DevicesModel(state: sampleDevices(seenTogether: false, studio: tooLong)) }),
            ("devices-list-reading", { DevicesModel() }),
            ("devices-add", { DevicesModel(state: sampleDevices(), handoff: handoff, page: .add) }),
            ("devices-add-refused", { DevicesModel(state: sampleDevices(), handoff: handoff, page: .add, pasted: "0a1b2c", refusal: .otherPerson) }),
            ("devices-add-candidate", { DevicesModel(state: sampleDevices(), handoff: handoff, page: .add, pasted: "0a1b2c3d", candidate: candidate) }),
            ("devices-add-candidate-hostile", { DevicesModel(state: sampleDevices(), handoff: handoff, page: .add, pasted: "0a1b2c3d", candidate: hostileCandidate) }),
            ("devices-remove", { DevicesModel(state: sampleDevices(seenTogether: false), page: .remove, clicked: studio) }),
            ("devices-remove-warning", { DevicesModel(state: sampleDevices(seenTogether: false, onlyHolder: 3), page: .remove, clicked: Data(repeating: 0x5a, count: 32)) }),
        ]
        let joining = JoiningInfo(pairingString: "0a" + String(repeating: "3f9c1d", count: 40) + "5761726d", shortForm: "aaaa-bbbb-cccc-dddd", name: "Studio Mac")
        for (appearance, theme) in themes {
            for (name, make) in sheets { try render(appearance, DevicesSheet(model: make()), size: NSSize(width: 600, height: 640), to: "\(name)-\(theme).png") }
            let joinForm = PairingModel(phase: .unpaired(nil), join: true)
            (joinForm.joinAddress, joinForm.joinName) = ("relay.example.net:7443", "Studio Mac")
            try render(appearance, PairingScreen(model: joinForm), size: page, to: "join-form-\(theme).png")
            let joinErrors = PairingModel(phase: .unpaired(nil), join: true, refused: .person)
            (joinErrors.joinAddress, joinErrors.joinKey, joinErrors.joinPerson, joinErrors.joinName) = ("relay.example.net:7443", "04" + String(repeating: "abcd", count: 32), "0123abcd", "Studio Mac")
            try render(appearance, PairingScreen(model: joinErrors), size: page, to: "join-form-errors-\(theme).png")
            try render(appearance, PairingScreen(model: PairingModel(phase: .unpaired(nil))), size: page, to: "first-join-\(theme).png")
            try render(appearance, PairingScreen(model: PairingModel(phase: .joining(joining))), size: page, to: "joining-\(theme).png")
            try render(appearance, PairingScreen(model: PairingModel(phase: .settingUp, join: true)), size: page, to: "setting-up-join-\(theme).png")
            try render(appearance, MainWindow(model: ReadingModel(), devices: DevicesModel()), size: NSSize(width: 1280, height: 800), to: "window-empty-\(theme).png")
            var waiting = joining
            waiting.waiting = true
            try render(appearance, PairingScreen(model: PairingModel(phase: .joining(waiting))), size: page, to: "joining-waits-\(theme).png")
            try render(appearance, PairingScreen(model: PairingModel(phase: .fault(.joinMismatch, PairingPhase.joinMismatchAdvice))), size: page, to: "join-mismatch-\(theme).png")
            try render(appearance, PairingScreen(model: PairingModel(phase: .fault(.joinUnmade, PairingPhase.joinUnmadeAdvice))), size: page, to: "join-unmade-\(theme).png")
            let sample = Samples.model()
            try render(appearance, MainWindow(model: sample.model, devices: DevicesModel(), channel: sample.channel, thread: sample.thread), size: NSSize(width: 1280, height: 800), to: "window-devices-\(theme).png")
        }
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
