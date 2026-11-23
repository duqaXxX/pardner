// The Settings panel's state (settings design 2.1): which pane is open, nil while the window is closed. The panes' own state stays in their models.
import Foundation
import Observation
import Relay

@MainActor @Observable
public final class SettingsModel {
    public enum Pane: String, CaseIterable, Identifiable {
        case general = "General", profile = "Profile", devices = "Devices", bots = "Bots"
        public var id: String { rawValue }
    }

    /// The pane shown; nil while the window is closed.
    public private(set) var pane: Pane?
    /// The Devices model, the Devices pane's own state: choosing another pane leaves it open, so a pairing string being checked is still there on
    /// return; the window closes it with itself, and a phase change resets it through `reset()`.
    let devices: DevicesModel
    /// The Profile pane's edit, kept through a change of pane as Devices' is, and cleared with the window.
    let profile: ProfileModel

    public init(devices: DevicesModel, controller: PairingController? = nil) { (self.devices, profile) = (devices, ProfileModel(controller: controller)) }

    /// Shows the Settings window, set once from the main scene. `open` calls it on every request: an open window comes to the front. While it
    /// is nil (the main scene has not appeared) `open` changes nothing, so no pane is held with no window to show it.
    @ObservationIgnored public var present: (() -> Void)?

    /// Shows `pane`, opening the window when it is closed. Every change of pane goes through here.
    public func open(_ pane: Pane) {
        guard let present else { return }
        if self.pane == nil { epoch += 1 }
        self.pane = pane
        if pane == .devices { devices.open() }
        present()
    }

    /// Which showing of the window this is: it changes when a pane opens over none.
    private(set) var epoch = 0

    /// The window closed: ends the pane it showed, and not a newer one opened since.
    func close(ifEpoch shown: Int) {
        if shown == epoch { close() }
    }

    /// Closes the window, and Devices with it (back to its list); Profile's edit goes.
    public func close() {
        pane = nil
        devices.close()
        profile.clear()
    }

    /// Escape in the window: a Devices page other than its list goes back, anything else closes the window.
    public func escape() {
        if pane == .devices, devices.page != .list { devices.back() } else { close() }
    }

    /// The pairing ended or the Mac is not paired: the window's pane and the Devices model's half-made acts go.
    func reset() {
        pane = nil
        devices.reset()
        profile.reset()
    }
}
