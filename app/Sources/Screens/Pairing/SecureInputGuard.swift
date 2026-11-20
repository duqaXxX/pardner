// Secure event input for the typed-back recovery key (device pairing design 3.8). The API keeps a count and asks to be off while the
// app is inactive (`CarbonEventsCore.h`), so one flag guards a single on/off pair: on only while the field is first responder, its
// window key and the app active; off as soon as one of them stops, and for good once the sheet is closed.
import Carbon.HIToolbox

@MainActor
final class SecureInputGuard {
    private let enable: () -> Void
    private let disable: () -> Void
    /// Whether this guard has turned secure input on and not yet off: the one flag.
    private(set) var isOn = false

    var firstResponder = false { didSet { update() } }
    var windowKey = false { didSet { update() } }
    var appActive = false { didSet { update() } }
    private var closed = false

    init(enable: @escaping () -> Void = { EnableSecureEventInput() }, disable: @escaping () -> Void = { DisableSecureEventInput() }) {
        (self.enable, self.disable) = (enable, disable)
    }

    /// Off, and never on again.
    func close() {
        closed = true
        update()
    }

    private func update() {
        let wanted = firstResponder && windowKey && appActive && !closed
        guard wanted != isOn else { return }
        isOn = wanted
        wanted ? enable() : disable()
    }
}
