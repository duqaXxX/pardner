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

/// Forgets what an earlier render saved (the split view's widths and the first-launch flags), so that every window draws as a first launch.
func forgetSavedColumns() { UserDefaults.standard.removePersistentDomain(forName: Bundle.main.bundleIdentifier ?? ProcessInfo.processInfo.processName) }

/// The split view under `view`, if the window has one.
@MainActor
func splitView(in view: NSView) -> NSSplitView? {
    if let split = view as? NSSplitView { return split }
    return view.subviews.lazy.compactMap { splitView(in: $0) }.first
}

@MainActor
func render<V: View>(_ name: NSAppearance.Name, _ view: V, size: NSSize?, to file: String) throws {
    forgetSavedColumns()
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

/// A second bot for the picker.
func sampleBot(_ byte: UInt8) -> DeviceRow {
    DeviceRow(id: Data(repeating: byte, count: 32), kind: .bot, label: nil, shortForm: "", adder: .none, position: 3, active: true, isThisMac: false, seenAt: nil,
              onlyHolderEpochs: 0, addedWhileRemoving: false)
}

let handoff = PairingHandoff(relayAddress: "relay.example.net:7443", relayKey: "04" + String(repeating: "abcd", count: 32), person: String(repeating: "0123456789abcdef", count: 4))
let candidate = DeviceCandidate(kind: .app, name: "Laptop", shortForm: "aaaa-bbbb-cccc-dddd", device: .null, proof: Data())
let hostileCandidate = DeviceCandidate(kind: .app, name: "A\u{201D}, position 0, \u{201C}B and a name that goes on past the edge of the card", shortForm: "aaaa-bbbb-cccc-dddd", device: .null, proof: Data())
let studio = Data(repeating: 0x3c, count: 32)
// A name that tries to close the app's sentence and add its own, and one too long for the card: both are drawn in a Text of their own.
let hostile = "A\u{201D}, position 0, \u{201C}B"
let tooLong = "Studio Mac of the third floor, the one with the broken fan and the sticker on the lid, Room 4 (old)"

/// The thread panel of `window` alone: the window drawn tall, and the panel's drawn width kept.
@MainActor
func renderPanel<V: View>(_ name: NSAppearance.Name, _ view: V, height: CGFloat, to file: String) throws {
    forgetSavedColumns()
    let size = NSSize(width: 1280, height: height)
    let hosting = NSHostingView(rootView: view)
    hosting.appearance = NSAppearance(named: name)
    let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: name)
    window.contentView = hosting
    hosting.frame = NSRect(origin: .zero, size: size)
    hosting.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.5))
    guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { throw CocoaError(.fileWriteUnknown) }
    hosting.cacheDisplay(in: hosting.bounds, to: rep)
    let scale = CGFloat(rep.pixelsWide) / size.width
    guard let panel = splitView(in: hosting)?.arrangedSubviews.last, panel.frame.width > 0 else { throw CocoaError(.fileWriteUnknown) }
    guard let whole = rep.cgImage, let part = whole.cropping(to: CGRect(x: (size.width - panel.frame.width) * scale, y: 0, width: panel.frame.width * scale, height: size.height * scale)),
          let png = NSBitmapImageRep(cgImage: part).representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
    try png.write(to: out.appendingPathComponent(file))
}

/// The cards of requests (requests design 4): each type open, sending, answered and refused in one session's panel, and Stop in a running session's header.
@MainActor
func requestShots(_ appearance: NSAppearance.Name, _ theme: String) throws {
    for (stage, name) in [(Samples.RequestStage.open, "open"), (.sending, "sending"), (.answered, "answered"), (.refused, "refused")] {
        let sample = Samples.requests(stage)
        var state = DevicesState()
        func row(_ id: Data, _ kind: DeviceKind, _ mac: Bool) -> DeviceRow {
            DeviceRow(id: id, kind: kind, label: nil, shortForm: "", adder: .none, position: 1, active: true, isThisMac: mac, seenAt: nil, onlyHolderEpochs: 0, addedWhileRemoving: false)
        }
        state.rows = [row(sample.me, .app, true), row(sample.bot, .bot, false)]
        let devices = DevicesModel(state: state)
        let hub = Composers(conversation: ConversationModel(reading: sample.model), devices: devices) { _, _ in .ended }
        var outboxes = ChannelsState()
        outboxes.outboxes[sample.channel] = sample.outbox
        hub.take(outboxes)
        let window = MainWindow(model: sample.model, devices: DevicesModel(), channels: ChannelsModel(devices: devices), composers: hub, channel: sample.channel, thread: sample.thread)
        try renderPanel(appearance, window, height: 1700, to: "requests-\(name)-\(theme).png")
    }
}

MainActor.assumeIsolated {
    do {
        if ProcessInfo.processInfo.environment["SNAPSHOT_ONLY"] == "requests" {
            for (appearance, theme) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] { try requestShots(appearance, theme) }
            let live = Samples.model()
            var composing = DevicesState()
            composing.rows = [Data([0x4D, 0x14, 0x10, 0x03] + Array(repeating: 3, count: 28))].map {
                DeviceRow(id: $0, kind: .bot, label: nil, shortForm: "", adder: .none, position: 1, active: true, isThisMac: false, seenAt: nil, onlyHolderEpochs: 0, addedWhileRemoving: false)
            }
            let devices = DevicesModel(state: composing)
            for (appearance, theme) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
                let hub = Composers(conversation: ConversationModel(reading: live.model), devices: devices) { _, _ in .ended }
                let window = MainWindow(model: live.model, devices: DevicesModel(), channels: ChannelsModel(devices: devices), composers: hub, channel: live.channel, thread: live.queuedThread)
                try render(appearance, window, size: NSSize(width: 1280, height: 800), to: "stop-header-\(theme).png")
            }
            // A session that runs: the activity row says `Working…` and the header's and the row's Stop are drawn.
            var running = DevicesState()
            running.rows = [Data([0x57, 0x0D, 0x10, 0x04] + Array(repeating: 4, count: 28))].map {
                DeviceRow(id: $0, kind: .bot, label: nil, shortForm: "", adder: .none, position: 1, active: true, isThisMac: false, seenAt: nil, onlyHolderEpochs: 0, addedWhileRemoving: false)
            }
            let runningDevices = DevicesModel(state: running)
            let runningThread = live.model.channels[live.channel]?.sessions.first { $0.state == .running }?.key
            for (appearance, theme) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
                let hub = Composers(conversation: ConversationModel(reading: live.model), devices: runningDevices) { _, _ in .ended }
                let window = MainWindow(model: live.model, devices: DevicesModel(), channels: ChannelsModel(devices: runningDevices), composers: hub, channel: live.channel, thread: runningThread)
                try render(appearance, window, size: NSSize(width: 1280, height: 800), to: "activity-running-\(theme).png")
            }
            exit(0)
        }
        if ProcessInfo.processInfo.environment["SNAPSHOT_ONLY"] == "band" {
            // The selected message and the thread summary row (#174, units D): a session with a long title, and a bot's text with a code span in its band.
            var live = Samples.model()
            let mini = Data([0x4D, 0x14, 0x10, 0x03] + Array(repeating: 3, count: 28)), alice = Data([0xA1, 0x1C, 0xE0, 0x01] + Array(repeating: 1, count: 28))
            var position = 100
            @discardableResult
            func put(_ kind: Int, _ sender: Data, _ body: [String: Any], name: UInt8, to: Data? = nil, re: MessageRef? = nil, minutes: Double) -> MessageRef {
                position += 1
                let text = String(decoding: try! JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]), as: UTF8.self)
                live.model.take(view: .object([
                    "do": .string("message"), "position": .number(Double(position)), "channel": .bytes(live.channel), "sender": .bytes(sender),
                    "name": .bytes(Data(repeating: name, count: 16)), "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(1_763_600_000_000 + minutes * 60_000),
                    "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null, "blobs": .array([]), "files": .array([]),
                    "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null, "text": .string(text), "again": .bool(false),
                ]))
                return MessageRef(device: sender, name: Data(repeating: name, count: 16))
            }
            put(1, mini, ["thread": live.queuedThread, "say": "title", "markdown": "Update the setup guide for the new store folder and the migration notes of the previous release"], name: 0xE1, minutes: 12.5)
            let root = put(1, mini, ["markdown": "Here is what `ls -la` shows in the `docs` folder."], name: 0xE2, minutes: 20)
            put(1, alice, ["thread": root.hex, "markdown": "Thanks"], name: 0xE3, minutes: 21)
            put(1, mini, ["thread": root.hex, "say": "title", "markdown": "ls -la command"], name: 0xE4, minutes: 21.5)
            for (appearance, theme) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
                for (name, thread, width) in [("docs", live.queuedThread, 1280.0), ("bot", root.hex, 1280.0), ("narrow", live.queuedThread, 1000.0)] {
                    let window = MainWindow(model: live.model, devices: DevicesModel(), channel: live.channel, thread: thread)
                    try render(appearance, window, size: NSSize(width: width, height: 800), to: "band-\(name)-\(theme).png")
                }
            }
            exit(0)
        }
        if ProcessInfo.processInfo.environment["SNAPSHOT_ONLY"] == "sections" {
            // The sidebar's sections (sidebar sections design 7): grouped, then each line that says why the commands are off.
            final class NoDefaults: UserDefaults {
                init() { super.init(suiteName: nil)! }
                override func set(_ value: Any?, forKey key: String) {}
                override func stringArray(forKey key: String) -> [String]? { nil }
            }
            func hex(_ byte: UInt8) -> String { String(repeating: String(format: "%02x", byte), count: 32) }
            let base = Samples.model()
            var reading = base.model
            let named: [(UInt8, String)] = [(0x61, "api"), (0x62, "web"), (0x63, "ops")]
            for (position, item) in named.enumerated() {
                reading.take(view: .object([
                    "do": .string("message"), "position": .number(Double(900 + position)), "channel": .bytes(Data(repeating: item.0, count: 32)), "sender": .bytes(Data(repeating: 0x71, count: 32)),
                    "name": .bytes(Data(repeating: UInt8(position + 1), count: 16)), "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(1_763_600_000_000),
                    "kind": .number(1), "to": .null, "blobs": .array([]), "files": .array([]), "re": .null, "again": .bool(false), "text": .string(#"{"markdown":"Hi."}"#),
                ]))
            }
            reading.take(names: .object(["do": .string("names"), "names": .array(named.map { .object(["kind": .number(14), "target": .bytes(Data(repeating: $0.0, count: 32)), "name": .string($0.1)]) }
                + [.object(["kind": .number(14), "target": .bytes(base.channel), "name": .string("docs")])])]))
            let layout: HostValue = .array([
                .object(["id": .string(hex(0xA1)), "name": .string("Work"), "channels": .array([.string(hex(0x61)), .string(hex(0x62))])]),
                .object(["id": .string(hex(0xA2)), "name": .string("Writing"), "channels": .array([.string(hex(base.channel[0]))])]),
                .object(["id": .string(hex(0xA3)), "name": .string("Ideas"), "channels": .array([])]),
            ])
            for (appearance, theme) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
                for (name, current, behind, notApplied, fold) in [("grouped", true, false, false, false), ("folded", true, false, false, true), ("reading", false, false, false, false),
                                                                 ("behind", false, true, false, false), ("not-applied", true, false, true, false)] {
                    var shown = reading
                    shown.take(arrangement: .object(["sections": layout, "current": .bool(current), "behind": .bool(behind), "notApplied": .bool(notApplied)]))
                    let devices = DevicesModel()
                    let channels = ChannelsModel(devices: devices)
                    let sections = SectionsModel(conversation: ConversationModel(reading: shown), channels: channels, defaults: NoDefaults()) { _ in .ended }
                    if fold { sections.toggleFold(hex(0xA2)) }
                    try render(appearance, MainWindow(model: shown, devices: devices, channels: channels, sections: sections, channel: base.channel),
                               size: NSSize(width: 1280, height: 800), to: "sections-\(name)-\(theme).png")
                }
            }
            exit(0)
        }
        let themes: [(NSAppearance.Name, String)] = [(.aqua, "light"), (.darkAqua, "dark")]
        let page = NSSize(width: 1050, height: 640)
        let screens: [(String, () -> PairingModel)] = [
            ("first", { PairingModel(phase: .unpaired(nil)) }),
            ("first-stale-sheet", { PairingModel(phase: .unpaired(.staleSheet)) }),
            ("first-stale-recovery-key", { PairingModel(phase: .unpaired(.staleRecoveryKey)) }),
            ("recover-form", {
                let m = PairingModel(phase: .unpaired(nil))
                m.openRecover()
                return m
            }),
            ("recover-form-errors", {
                let m = PairingModel(phase: .unpaired(nil), refused: .relayKey)
                m.openRecover()
                (m.recoverPerson, m.recoverAddress, m.recoverKey) = (String(repeating: "0123456789abcdef", count: 4), "relay.example.net:7443", "04a1b2c3")
                return m
            }),
            ("recover-type-key", {
                let request = RecoveryEntryRequest()
                let m = PairingModel(phase: .recovering(.typeKey(request)))
                for c in SyntheticKey().typed(21) { m.entry?.key(c) }
                return m
            }),
            ("recover-reading", { PairingModel(phase: .recovering(.reading)) }),
            ("recover-ask-devices", { PairingModel(phase: .recovering(.askDevices(others: 2))) }),
            ("recover-ask-new-key", { PairingModel(phase: .recovering(.askNewKey)) }),
            ("recover-sending", { PairingModel(phase: .recovering(.sending)) }),
            ("recover-opening", {
                let channel = Data(repeating: 0xC1, count: 32)
                let missing = RecoveryProgress.Missing(key: Data(repeating: 2, count: 32), epochs: [.init(channel: channel, epoch: Data(repeating: 9, count: 32))])
                let current = RecoveryProgress.Missing(key: Data(repeating: 3, count: 32), epochs: [], isCurrent: true)
                return PairingModel(phase: .recovering(.opening(RecoveryProgress(waiting: [missing, current], unsealed: 0))))
            }),
            ("recover-done", { PairingModel(phase: .recovering(.done(RecoveryDone(destroyable: [Data(repeating: 2, count: 32)], keep: Data(repeating: 1, count: 32))))) }),
            ("recover-refused", { PairingModel(phase: .recovering(.refused(.notCurrent))) }),
            ("recover-refused-stored", { PairingModel(phase: .recovering(.refused(.noLongerCurrent))) }),
            ("recover-opening-current-only", {
                let current = RecoveryProgress.Missing(key: Data(repeating: 3, count: 32), epochs: [], isCurrent: true)
                return PairingModel(phase: .recovering(.opening(RecoveryProgress(waiting: [current], unsealed: 0))))
            }),
            ("recover-form-dead-end", {
                let m = PairingModel(phase: .removed)
                m.openRecover()
                return m
            }),
            ("recover-refused-new-key", { PairingModel(phase: .recovering(.refused(.yourNewKey))) }),
            ("form", { let m = PairingModel(phase: .unpaired(nil), form: true); m.setupName = "Ada Lovelace"; return m }),
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
            for (name, make) in sheets {
                // Open already, so that `open(.devices)` keeps the page the sample was made on.
                let devices = make()
                devices.isOpen = true
                let settings = SettingsModel(devices: devices)
                settings.present = {}
                settings.open(.devices)
                try render(appearance, SettingsPanel(model: settings), size: NSSize(width: 760, height: 560), to: "\(name)-\(theme).png")
            }
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
            // The device list read: with no bot the window says to add one; with a bot whose profile no channel carries yet, it lists the
            // bot by its label and says to make a channel.
            var macOnly = sampleDevices()
            macOnly.rows = macOnly.rows.filter { $0.kind == .app }
            try render(appearance, MainWindow(model: ReadingModel(), devices: DevicesModel(state: macOnly)), size: NSSize(width: 1280, height: 800), to: "window-empty-no-bot-\(theme).png")
            var withBot = macOnly
            withBot.rows.append(DeviceRow(id: Data(repeating: 0x2b, count: 32), kind: .bot, label: "mini-dev", shortForm: "", adder: .none, position: 2, active: true,
                                           isThisMac: false, seenAt: nil, onlyHolderEpochs: 0, addedWhileRemoving: false))
            try render(appearance, MainWindow(model: ReadingModel(), devices: DevicesModel(state: withBot)), size: NSSize(width: 1280, height: 800), to: "window-empty-bot-\(theme).png")
            var waiting = joining
            waiting.waiting = true
            try render(appearance, PairingScreen(model: PairingModel(phase: .joining(waiting))), size: page, to: "joining-waits-\(theme).png")
            try render(appearance, PairingScreen(model: PairingModel(phase: .fault(.joinMismatch, PairingPhase.joinMismatchAdvice))), size: page, to: "join-mismatch-\(theme).png")
            try render(appearance, PairingScreen(model: PairingModel(phase: .fault(.joinUnmade, PairingPhase.joinUnmadeAdvice))), size: page, to: "join-unmade-\(theme).png")
            let channelSample = Samples.model()
            let busy = sampleDevices()
            // The sheet over a person with two bots: the picker shows. The names are the profiles' names.
            var twoBots = busy
            twoBots.rows.insert(sampleBot(0x2c), at: 1)
            let botNames = [Data(repeating: 0x2b, count: 32): "mini", Data(repeating: 0x2c, count: 32): "studio"]
            let sheetStates: [(String, ChannelsModel)] = [
                ("channel-sheet", ChannelsModel(devices: DevicesModel(state: twoBots), sheet: .create, folder: "projects/docs")),
                ("channel-sheet-empty", ChannelsModel(devices: DevicesModel(state: busy), sheet: .create)),
                ("channel-sheet-not-saved", ChannelsModel(devices: DevicesModel(state: twoBots), sheet: .create, folder: "projects/docs",
                                                          problem: "Pardner could not save the new channel. Try again.")),
                ("channel-sheet-busy", ChannelsModel(devices: DevicesModel(state: busy), sheet: .create, folder: "projects/docs", problem: "Another channel is being created.")),
                ("channel-sheet-bind", ChannelsModel(devices: DevicesModel(state: busy), sheet: .bind(channel: channelSample.channel), folder: "projects/docs")),
            ]
            for (name, model) in sheetStates { try render(appearance, ChannelSheet(model: model, names: botNames), size: nil, to: "\(name)-\(theme).png") }
            // The channel's panel (channel folder design, 2): a usable folder, an untrusted one, and a channel with no bind field yet.
            func boundModel(_ state: String?) -> ReadingModel {
                var model = ReadingModel()
                let (alice, bot) = (Data(repeating: 0x2a, count: 32), Data(repeating: 0x2b, count: 32))
                func put(_ at: Int, kind: Int, sender: Data, json: [String: Any], to: Data? = nil, re: Data? = nil) {
                    model.take(view: .object([
                        "do": .string("message"), "position": .number(Double(at)), "channel": .bytes(channelSample.channel), "sender": .bytes(sender),
                        "name": .bytes(Data(repeating: UInt8(at), count: 16)), "epoch": .bytes(Data(repeating: 9, count: 32)),
                        "time": .number(1_763_600_000_000.0 + Double(at) * 60_000), "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null,
                        "blobs": .array([]), "files": .array([]), "again": .bool(false),
                        "re": re.map { .object(["device": .bytes(alice), "name": .bytes(Data(repeating: UInt8($0[0]), count: 16))]) } ?? .null,
                        "text": .string(String(decoding: try! JSONSerialization.data(withJSONObject: json), as: UTF8.self)),
                    ]))
                }
                put(1, kind: 2, sender: alice, json: ["text": "/bind /srv/code/demo"], to: bot)
                var answer: [String: Any] = ["say": "notice", "markdown": "Bound this channel to `/srv/code/demo`."]
                if let state { answer["bind"] = ["folder": "/srv/code/demo", "state": state] }
                put(2, kind: 1, sender: bot, json: answer, re: Data([1]))
                return model
            }
            for (name, state) in [("channel-panel", "usable"), ("channel-panel-untrusted", "untrusted"), ("channel-panel-unknown", nil)] as [(String, String?)] {
                let reading = boundModel(state)
                let channels = ChannelsModel(devices: DevicesModel(state: busy), sheet: .settings(channel: channelSample.channel))
                try render(appearance, ChannelPanelView(model: reading, channels: channels, id: channelSample.channel), size: nil, to: "\(name)-\(theme).png")
            }
            // The name sheets (names design 4.1 and 4.3), and the window with the names the link shows.
            let nameSheets: [(String, ChannelsModel.NameTarget, String, String?)] = [
                ("name-sheet-channel", .channel(channelSample.channel), "docs", nil),
                ("name-sheet-channel-refused", .channel(channelSample.channel), "Docs & Notes", "Use only lowercase letters, digits, - and _, up to 80 characters."),
                ("name-sheet-device", .device, "Mac mini", nil),
            ]
            for (name, target, text, problem) in nameSheets {
                let model = ChannelsModel(devices: DevicesModel(state: busy), sheet: .rename(target), problem: problem)
                model.nameText = text
                try render(appearance, NameSheet(model: model), size: nil, to: "\(name)-\(theme).png")
            }
            // The channel's name at its creation, with what the field left out and the warning that another channel has the name.
            let sameName = ChannelsModel(devices: DevicesModel(state: busy), sheet: .create, folder: "projects/docs")
            sameName.nameText = "docs"
            let leftOut = ChannelsModel(devices: DevicesModel(state: busy), sheet: .create, folder: "projects/docs")
            leftOut.nameText = "docs"
            leftOut.nameText = "docs!"
            leftOut.channelNameEdited()
            for (name, model) in [("channel-sheet-name-duplicate", sameName), ("channel-sheet-name-left-out", leftOut)] {
                try render(appearance, ChannelSheet(model: model, names: botNames, channelNames: [Data(repeating: 0x33, count: 32): "docs"]), size: nil, to: "\(name)-\(theme).png")
            }
            var shown = channelSample.model
            let (me, thisMac) = (Data(repeating: 0x11, count: 32), Data(repeating: 0x12, count: 32))
            shown.take(names: .object(["do": .string("names"), "names": .array([
                .object(["kind": .number(14), "target": .bytes(channelSample.channel), "name": .string("docs")]),
                .object(["kind": .number(15), "target": .bytes(me), "name": .string("Ada Lovelace")]),
                .object(["kind": .number(16), "target": .bytes(thisMac), "name": .string("Mac mini")]),
            ])]))
            try render(appearance, MainWindow(model: shown, devices: DevicesModel(), channels: ChannelsModel(state: ChannelsState(), devices: DevicesModel(state: busy)),
                                              channel: channelSample.channel), size: NSSize(width: 1280, height: 800), to: "window-names-\(theme).png")
            var creating = ChannelsState()
            creating.creating = PendingChannel(channel: Data(repeating: 0x77, count: 32), bot: Data(repeating: 0x2b, count: 32), folder: "projects/docs")
            var refused = ChannelsState()
            refused.refusal = CreationRefusal(channel: Data(repeating: 0x77, count: 32), code: 7)
            var faulted = ChannelsState()
            faulted.faulted = [channelSample.channel]
            for (name, state) in [("window-creating", creating), ("window-refused", refused), ("window-faulted", faulted), ("window-channels", ChannelsState())] {
                try render(appearance, MainWindow(model: channelSample.model, devices: DevicesModel(), channels: ChannelsModel(state: state, devices: DevicesModel(state: busy)),
                                                  channel: channelSample.channel), size: NSSize(width: 1280, height: 800), to: "\(name)-\(theme).png")
            }
            // The composer (composer design 4): over the same conversation, with this person's two bots as devices.
            let live = Samples.model()
            let miniID = Data([0x4D, 0x14, 0x10, 0x03] + Array(repeating: 3, count: 28)), studioID = Data([0x57, 0x0D, 0x10, 0x04] + Array(repeating: 4, count: 28))
            var composing = DevicesState()
            composing.rows = [miniID, studioID].enumerated().map { index, id in
                DeviceRow(id: id, kind: .bot, label: nil, shortForm: "", adder: .none, position: index + 1, active: true, isThisMac: false, seenAt: nil, onlyHolderEpochs: 0, addedWhileRemoving: false)
            }
            let composingDevices = DevicesModel(state: composing)
            @MainActor func hub() -> Composers { Composers(conversation: ConversationModel(reading: live.model), devices: composingDevices) { _, _ in .ended } }
            func item(_ n: UInt8, _ state: OutboxItemState, _ text: String) -> OutboxItemRow {
                OutboxItemRow(name: Data(repeating: n, count: 16), kind: 1, to: nil, re: nil, content: "{\"markdown\":\"\(text)\"}", state: state)
            }
            let big = NSSize(width: 1280, height: 800)
            @MainActor func window(_ hub: Composers, thread: String? = nil) -> MainWindow {
                MainWindow(model: live.model, devices: DevicesModel(), channels: ChannelsModel(devices: composingDevices), composers: hub, channel: live.channel, thread: thread)
            }
            let labelled = hub()
            labelled.composer(channel: live.channel).edited("@")
            labelled.composer(channel: live.channel).pick(miniID)
            labelled.composer(channel: live.channel).edited("Run the failing relay test again and tell me which line breaks.")
            try render(appearance, window(labelled), size: big, to: "composer-label-\(theme).png")
            let listing = hub()
            listing.composer(channel: live.channel).edited("@")
            try render(appearance, window(listing), size: big, to: "composer-bot-list-\(theme).png")
            let sending = hub()
            var queuedState = ChannelsState()
            queuedState.outboxes[live.channel] = [item(0xC1, .waiting, "I will look at it after lunch.")]
            sending.take(queuedState)
            try render(appearance, window(sending), size: big, to: "composer-sending-\(theme).png")
            let refusedHub = hub()
            var refusedState = ChannelsState()
            refusedState.outboxes[live.channel] = [item(0xC2, .refused, "I will look at it after lunch.")]
            refusedHub.take(refusedState)
            try render(appearance, window(refusedHub), size: big, to: "composer-not-delivered-\(theme).png")
            let threaded = hub()
            threaded.composer(channel: live.channel, thread: live.queuedThread).edited("And add the new folder to the guide.")
            try render(appearance, window(threaded, thread: live.queuedThread), size: big, to: "composer-thread-queued-\(theme).png")
            let sample = Samples.model()
            let paired = DevicesModel()
            try render(appearance, MainWindow(model: sample.model, devices: paired, settings: SettingsModel(devices: paired), channel: sample.channel, thread: sample.thread), size: NSSize(width: 1280, height: 800), to: "window-devices-\(theme).png")
            try render(appearance, MainWindow(model: sample.model, devices: paired, settings: SettingsModel(devices: paired), channel: sample.channel, thread: sample.thread), size: NSSize(width: 1900, height: 1050), to: "window-wide-\(theme).png")
            let settings = SettingsModel(devices: paired)
            settings.present = {}
            settings.open(.general)
            try render(appearance, SettingsPanel(model: settings), size: NSSize(width: 760, height: 560), to: "settings-general-\(theme).png")
            settings.open(.profile)
            try render(appearance, SettingsPanel(model: settings, personName: "Ada Lovelace"), size: NSSize(width: 760, height: 560), to: "settings-profile-\(theme).png")
            settings.present = {}
            settings.open(.bots)
            // The samples' two bots carry a profile; a third, with a label alone, has not been seen in a channel yet.
            let profiles = Samples.model().model.profiles
            let unseenBot = Data(repeating: 0x2c, count: 32)
            var threeBots = sampleDevices()
            threeBots.rows = threeBots.rows.filter { $0.kind == .app }
            for (n, botId) in (profiles.keys.sorted { $0.lexicographicallyPrecedes($1) } + [unseenBot]).enumerated() {
                threeBots.rows.append(DeviceRow(id: botId, kind: .bot, label: botId == unseenBot ? "studio-dev" : nil, shortForm: "", adder: .none, position: (threeBots.rows.map(\.position).max() ?? 0) + 1 + n, active: true, isThisMac: false,
                                                seenAt: nil, onlyHolderEpochs: 0, addedWhileRemoving: false))
            }
            let listed = DevicesModel(state: threeBots).listedBots(profiles: profiles)
            let icons = profiles.compactMapValues { $0.icon.flatMap(NSImage.init(data:)) }
            try render(appearance, SettingsPanel(model: settings, bots: listed, icons: icons), size: NSSize(width: 760, height: 560), to: "settings-bots-\(theme).png")
        }
        for (appearance, theme) in themes {
            let sample = Samples.model()
            // The usage boxes (visual pass, #174): each bot's thread ends a work with its account's numbers, the studio's read 25 minutes ago.
            var shown = sample.model
            // A fixed clock, so that `Resets in` reads the same in every run.
            let now = Date(timeIntervalSince1970: 1_764_000_000), nowMs = now.timeIntervalSince1970 * 1000
            let botIDs = [Data([0x4D, 0x14, 0x10, 0x03] + Array(repeating: 3, count: 28)), Data([0x57, 0x0D, 0x10, 0x04] + Array(repeating: 4, count: 28))]
            for (n, (bot, minutesAgo, session, week)) in [(botIDs[0], 3.0, 40.0, 35.0), (botIDs[1], 25.0, 62.0, 18.0)].enumerated() {
                guard let thread = shown.channels[sample.channel]?.threads.sorted(by: { $0.key < $1.key }).map(\.value).first(where: { $0.bot == bot }), let root = thread.root else { continue }
                let usage: [String: Any] = ["at": nowMs - minutesAgo * 60_000, "session": ["percent": session, "resetsAt": nowMs + 2.5 * 3_600_000] as [String: Any],
                                            "week": ["percent": week, "resetsAt": nowMs + 87 * 3_600_000] as [String: Any]]
                let body: [String: Any] = ["thread": root.ref.hex, "say": "footer", "markdown": "9s", "usage": usage,
                                           "session": "Sonnet \u{B7} effort low \u{B7} main (+0,-0) \u{B7} ctx 7% \u{B7} 457.4k tokens"]
                shown.take(view: .object([
                    "do": .string("message"), "position": .number(Double(2000 + n)), "channel": .bytes(sample.channel), "sender": .bytes(bot), "name": .bytes(Data(repeating: UInt8(0xE0 + n), count: 16)),
                    "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(nowMs), "kind": .number(1), "to": .null, "blobs": .array([]), "files": .array([]),
                    "re": .null, "again": .bool(false), "text": .string(String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)),
                ]))
            }
            // The thread's content column (visual pass #174, unit B): calls with a path inside and outside the bound folder, a stopped call, a failed one, an
            // agent's reply with markup, a system event, a denied permission, and two messages of one author.
            let alice = Data([0xA1, 0x1C, 0xE0, 0x01] + Array(repeating: 1, count: 28)), mini = botIDs[0]
            guard let fixRoot = shown.channels[sample.channel]?.threads[sample.thread]?.root?.ref else { fatalError("the sample thread has a root") }
            var next = 3000
            @discardableResult
            func put(_ kind: Int, _ sender: Data, _ body: [String: Any], to: Data? = nil, re: MessageRef? = nil, seconds: Double) throws -> MessageRef {
                next += 1
                let name = Data(repeating: UInt8(next & 0xFF), count: 16)
                shown.take(view: .object([
                    "do": .string("message"), "position": .number(Double(next)), "channel": .bytes(sample.channel), "sender": .bytes(sender), "name": .bytes(name),
                    "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(nowMs + seconds * 1000), "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null,
                    "blobs": .array([]), "files": .array([]), "again": .bool(false),
                    "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null,
                    "text": .string(String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)),
                ]))
                return MessageRef(device: sender, name: name)
            }
            // The channel's folder, as the bot's answer to `/bind` says it.
            let bind = try put(2, alice, ["text": "/bind /srv/example/project"], to: mini, seconds: 1)
            try put(1, mini, ["markdown": "Bound.", "say": "notice", "bind": ["folder": "/srv/example/project", "state": "usable"]], re: bind, seconds: 2)
            func call(_ title: String, status: String = "complete", path: String? = nil, output: String? = nil, message: Bool = false, agent: String? = nil, preview: [String: Any]? = nil, seconds: Double) throws {
                var task: [String: Any] = ["title": title, "status": status, "details": NSNull(), "output": output as Any? ?? NSNull(), "task": false, "message": message, "calls": 0,
                                           "preview": preview ?? NSNull(), "startedAt": NSNull()]
                if let path { task["path"] = path }
                if let agent { task["agent"] = agent }
                try put(1, mini, ["thread": fixRoot.hex, "say": "task", "task": task], re: fixRoot, seconds: seconds)
            }
            try call("Read: /srv/example/project/src/relay.ts", path: "/srv/example/project/src/relay.ts", seconds: 10)
            try call("Read: /srv/example/other/notes.md", path: "/srv/example/other/notes.md", seconds: 11)
            try call("Bash: sleep 180", status: "error", output: "Stopped", seconds: 12)
            try call("Bash: cat missing.txt", status: "error", output: "cat: missing.txt: No such file or directory", seconds: 13)
            try call("Agent(look)", output: "**Counts**: 3 files\nthe rest", message: true, agent: "look", seconds: 14)
            // An Edit's diff as the daemon writes it (`<sign><square> <number> <text>`), and an answer with every component of the visual pass (unit C).
            let diff = ["    5 node cli.js Alex", "-\u{1F7E5} 6 old line", "+\u{1F7E9} 6 ", "+\u{1F7E9} 7 Test of November 25"].joined(separator: "\n")
            try call("Edit: /srv/example/project/README.md", path: "/srv/example/project/README.md", preview: ["title": "Update(README.md)", "summary": "Added 2 lines, removed 1 line", "body": diff,
                                                                                                          "language": "diff", "plain": false, "record": false], seconds: 14.5)
            let answer = ["Here is what I found in [Example link](https://example.com/docs), run by @mini:", "", "## Results", "",
                          "| Name | Type | Size | Modified |", "|---|---|---:|---|", "| `README.md` | file | 100 B | Nov 26 00:31 |", "| `cli.js` | file | 2.4 KB | Nov 25 23:55 |",
                          "| `test` | directory | \u{2014} | Oct 29 22:41 |", "", "```swift", "let x = 1", "```", "", "```", "127.0.0.1 localhost", "```"].joined(separator: "\n")
            try put(5, mini, ["thread": fixRoot.hex, "markdown": answer], re: fixRoot, seconds: 14.7)
            try put(1, mini, ["thread": fixRoot.hex, "say": "notice", "markdown": "Background command completed"], seconds: 15)
            let asked = try put(9, mini, ["thread": fixRoot.hex, "title": "Allow Bash?", "request": ["type": "permission", "toolName": "Bash", "title": NSNull(), "description": NSNull(), "plan": NSNull(),
                                                                                            "input": ["command": "mkdir deny-test"]]], re: fixRoot, seconds: 16)
            let denied = try put(10, alice, ["answer": ["type": "permission", "allow": false]], to: mini, re: asked, seconds: 17)
            try put(5, mini, ["thread": "", "markdown": ""], re: denied, seconds: 18)
            try put(2, alice, ["text": "Thanks. Run it once more.", "thread": fixRoot.hex], to: mini, seconds: 30)
            try put(2, alice, ["text": "And tell me when it ends.", "thread": fixRoot.hex], to: mini, seconds: 31)
            try render(appearance, MainWindow(model: shown, channel: sample.channel, thread: sample.thread), size: NSSize(width: 1280, height: 800), to: "window-\(theme).png")
            // The same window with this person's two bots as devices: both composers, the person's row and the boxes.
            var bots = DevicesState()
            bots.rows = botIDs.enumerated().map { index, id in
                DeviceRow(id: id, kind: .bot, label: nil, shortForm: "", adder: .none, position: index + 1, active: true, isThisMac: false, seenAt: nil, onlyHolderEpochs: 0, addedWhileRemoving: false)
            }
            let botDevices = DevicesModel(state: bots)
            let boxesHub = Composers(conversation: ConversationModel(reading: shown), devices: botDevices) { _, _ in .ended }
            try render(appearance, MainWindow(model: shown, devices: botDevices, channels: ChannelsModel(devices: botDevices), composers: boxesHub, channel: sample.channel, thread: sample.thread, now: now),
                       size: NSSize(width: 1280, height: 800), to: "window-boxes-\(theme).png")
            // Tall, so that the whole thread shows: the diff, the answer's table and its code blocks (unit C).
            try render(appearance, MainWindow(model: shown, devices: botDevices, channels: ChannelsModel(devices: botDevices), composers: boxesHub, channel: sample.channel, thread: sample.thread, now: now),
                       size: NSSize(width: 1280, height: 1500), to: "window-tall-\(theme).png")
            for (name, make) in screens { try render(appearance, PairingScreen(model: make()), size: page, to: "\(name)-\(theme).png") }
            let source = SyntheticKey()
            let empty = RecoverySheetModel(source: source)
            try render(appearance, RecoverySheetView(model: empty), size: nil, to: "recovery-sheet-\(theme).png")
            let recovering = RecoverySheetModel(source: source)
            recovering.isRecovery = true
            try render(appearance, RecoverySheetView(model: recovering), size: nil, to: "recovery-sheet-recovery-\(theme).png")
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
