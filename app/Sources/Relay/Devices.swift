// What the Devices screen reads and what its acts answer (device pairing design 3.3, 3.4, 3.6, 3.9). Values only: the logic
// is in PairingController+Devices.swift, and no view lives here.
import Foundation
import ProtocolHost

public enum DeviceKind: String, Sendable, Equatable { case app, bot }

/// Who added a device (design 3.9): the log names the signer of the add; a removed signer is shown as such.
public enum DeviceAdder: Sendable, Equatable {
    /// Entry 0's device, and a device a reset named: no device added it.
    case none
    case device(Data)
    /// "Added by a removed device."
    case removedDevice
}

/// One device the log names (design 3.9).
public struct DeviceRow: Sendable, Equatable, Identifiable {
    public let id: Data
    public let kind: DeviceKind
    /// The name its pairing string gave it, kept by this Mac alone (design 3.3); nil shows the kind and the short form.
    public let label: String?
    /// The device id's first 8 bytes in four groups of four hex digits (design 3.2).
    public let shortForm: String
    public let adder: DeviceAdder
    /// The position of the entry that named it.
    public let position: Int
    public let active: Bool
    /// "This Mac": the Devices screen offers no Remove for it (design 3.9).
    public let isThisMac: Bool
    /// When this Mac first read the add: device entries carry no time (design 3.9).
    public let seenAt: Date?
    /// How many epochs this device is the only active holder of: a removal loses them (design 3.9).
    public let onlyHolderEpochs: Int
    /// The device joined a removal in progress because it was added while the person was removing (design 3.9, step 3).
    public let addedWhileRemoving: Bool

    /// The controller builds every row; the package's own tools build one for a made-up device, no code outside it can.
    package init(id: Data, kind: DeviceKind, label: String?, shortForm: String, adder: DeviceAdder, position: Int, active: Bool, isThisMac: Bool, seenAt: Date?,
                onlyHolderEpochs: Int, addedWhileRemoving: Bool) {
        (self.id, self.kind, self.label, self.shortForm, self.adder, self.position) = (id, kind, label, shortForm, adder, position)
        (self.active, self.isThisMac, self.seenAt, self.onlyHolderEpochs, self.addedWhileRemoving) = (active, isThisMac, seenAt, onlyHolderEpochs, addedWhileRemoving)
    }
}

/// The device a notice is about: a name the person gave it, else the kind and short form, else nothing known. Only `.label` came from a
/// pairing string; the views draw it apart from the app's own words.
public enum DeviceSubject: Sendable, Equatable {
    case label(String)
    case shortForm(DeviceKind, String)
    case unknown
}

/// A word to the person about an act that did not end as asked.
public enum DevicesNotice: Sendable, Equatable {
    /// The log refused the add of the device.
    case addRefused(DeviceSubject)
    /// The log refused the removal of the device: it leaves the act.
    case removeRefused(DeviceSubject)
    /// The entry could not be sent at all.
    case entryInvalid(DeviceSubject)
}

/// The Devices screen's state: every device newest first, and what is in progress.
public struct DevicesState: Sendable, Equatable {
    public var rows: [DeviceRow] = []
    /// An entry is kept and not yet read back: the add of a device waits (design 3.6).
    public var pendingEntry = false
    /// The name of the device the pending entry adds; nil when the entry is a removal's or none is kept.
    public var pendingAddName: String?
    /// The devices of the removal in progress that are still active, in the order they go (design 3.9).
    public var removing: [Data] = []
    /// Several adds were first read at the same moment, as when this Mac reads the log in one go: their times say nothing of when they were made (design 3.9).
    public var seenTogether = false
    public var notice: DevicesNotice?

    public init() {}

    /// The confirmation a Remove opens (design 3.9): every active device but this Mac, newest first, the clicked one chosen. A screen
    /// holding the last published state asks the same question as the controller.
    public func removalChoices(clicked: Data) -> [RemovalChoice] {
        rows.filter { $0.active && !$0.isThisMac }.map { RemovalChoice(id: $0.id, row: $0, chosen: $0.id == clicked) }
    }
}

/// The three values the person gives a new device (design 3.1), as the text to copy.
public struct PairingHandoff: Sendable, Equatable {
    public let relayAddress: String
    public let relayKey: String
    public let person: String

    package init(relayAddress: String, relayKey: String, person: String) { (self.relayAddress, self.relayKey, self.person) = (relayAddress, relayKey, person) }
}

/// A pasted pairing string that passed the checks of design 3.4: the person confirms the kind, the name and the short form.
public struct DeviceCandidate: Sendable, Equatable {
    public let kind: DeviceKind
    public let name: String
    public let shortForm: String
    let device: HostValue
    let proof: Data

    /// Only the controller makes a candidate from a checked string; the package's own tools make one for a made-up device.
    package init(kind: DeviceKind, name: String, shortForm: String, device: HostValue, proof: Data) {
        (self.kind, self.name, self.shortForm, self.device, self.proof) = (kind, name, shortForm, device, proof)
    }
}

/// Why a pairing string or an add was refused. `message` is what the person reads.
public enum DeviceRefusal: Error, Sendable, Equatable {
    case notAPairingString
    case badName
    case otherPerson
    case alreadyAdded
    /// The log is not read to its end yet, or no connection runs.
    case notReady
    /// An entry is kept and not read back: adding waits for it (design 3.6).
    case entryPending
    /// A removal is in progress: a stolen Mac goes at once, so an add waits for it (design 3.9).
    case removalRunning
    case failed(String)

    public var message: String {
        switch self {
        case .notAPairingString: "This is not a pairing string. Copy it again from the new device."
        case .badName: "The name in this string cannot be used. Make a new string on the device with another name."
        case .otherPerson: "This string was made for another person id. Check the values you gave the device."
        case .alreadyAdded: "This device was already added once. Make a new string on it."
        case .notReady: "Pardner is still reading your devices. Try again in a moment."
        case .entryPending: "A change to your devices is still being confirmed. Try again in a moment."
        case .removalRunning: "Finish removing first. A device is being removed, and an add waits for it."
        case .failed(let why): "The device could not be added: \(why)."
        }
    }
}

/// Why a removal was not started.
public enum RemovalRefusal: Error, Sendable, Equatable {
    case nothingChosen
    /// This Mac never removes itself (design 3.9).
    case thisMac
    /// A chosen device is not an active device of the log.
    case notActive
    /// A removal is in progress: it ends before another begins.
    case running
    case notReady
    /// The act could not be written to the pairing store.
    case failed(String)
}

/// One device of the confirmation a Remove opens (design 3.9): every active device but this Mac, newest first.
public struct RemovalChoice: Sendable, Equatable, Identifiable {
    public let id: Data
    public let row: DeviceRow
    /// The device whose Remove was clicked is chosen; the person chooses the others.
    public let chosen: Bool
}
