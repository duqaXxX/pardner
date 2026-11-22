// The Settings panel's state (settings design 2.1): which pane is open, nil while the panel is closed. The panes' own state stays in their models.
import Foundation
import Observation

@MainActor @Observable
public final class SettingsModel {
    public enum Pane: String, CaseIterable, Identifiable {
        case general = "General", devices = "Devices", bots = "Bots"
        public var id: String { rawValue }
    }

    /// The pane shown; nil while the panel is closed.
    public private(set) var pane: Pane?
    /// The Devices model, the Devices pane's own state: choosing another pane leaves it open, so a pairing string being checked is still there on
    /// return; the panel closes it with itself, and a phase change resets it through `reset()`.
    let devices: DevicesModel

    public init(devices: DevicesModel) { self.devices = devices }

    /// Shows `pane`, opening the panel when it is closed. Every change of pane goes through here.
    public func open(_ pane: Pane) {
        self.pane = pane
        if pane == .devices { devices.open() }
    }

    /// Closes the panel, and Devices with it (back to its list).
    public func close() {
        pane = nil
        devices.close()
    }

    /// This Mac's rename was asked from the Devices pane: the panel closes and the name sheet opens once it is gone, not in the same tick.
    public func closeForRename() {
        pane = nil
        devices.closeForRename()
    }

    /// The panel's dismissal asks whether a rename waits; true once, then the name sheet is the one to open. The rename is kept in the Devices
    /// model (`renamePending`), which `holdsSheet` reads.
    public func takeRename() -> Bool { devices.takeRename() }

    /// The pairing ended or the Mac is not paired: the panel and the Devices model's half-made acts go.
    func reset() {
        pane = nil
        devices.reset()
    }

    /// A sheet of this model is up: the panel (Devices is a pane of it), or the name sheet waiting for the panel to go. A menu command fires while a
    /// sheet is up, and a second sheet over the first must never be asked for.
    public var holdsSheet: Bool { pane != nil || devices.isOpen || devices.renamePending }
}
