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
            // The name sheets (names design 4.1 to 4.3), and the window with the names the link shows.
            let nameSheets: [(String, ChannelsModel.NameTarget, String, String?)] = [
                ("name-sheet-person", .person, "Ada Lovelace", nil),
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
            try render(appearance, MainWindow(model: sample.model, devices: DevicesModel(), channel: sample.channel, thread: sample.thread), size: NSSize(width: 1280, height: 800), to: "window-devices-\(theme).png")
        }
        for (appearance, theme) in themes {
            let sample = Samples.model()
            try render(appearance, MainWindow(model: sample.model, channel: sample.channel, thread: sample.thread), size: NSSize(width: 1280, height: 800), to: "window-\(theme).png")
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
