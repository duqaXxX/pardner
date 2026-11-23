// What the main window reads (app data design, 6): the controller's deliveries and profiles folded, in order, into the reading model.
// The controller owns the connection; this owns nothing but the model the views draw.
import Conversation
import Foundation
import Observation
import Relay

@MainActor @Observable
public final class ConversationModel {
    public private(set) var reading: ReadingModel
    @ObservationIgnored private let controller: PairingController?
    @ObservationIgnored private var watching: Task<Void, Never>?

    public init(controller: PairingController) { (self.controller, reading) = (controller, ReadingModel()) }

    /// A model with no controller, for a preview or a test: it draws `reading` as given.
    public init(reading: ReadingModel = ReadingModel()) { (controller, self.reading) = (nil, reading) }

    /// Follows the controller's readings until they finish (the app quits).
    func start() {
        guard let controller, watching == nil else { return }
        let readings = controller.readings
        watching = Task { [weak self] in
            for await event in readings { self?.apply(event) }
        }
    }

    /// The person's own app devices, from the Devices list: their replies to a request count even where they never prompted.
    public func setOwnDevices(_ ids: Set<Data>) {
        own = ids
        reading.setOwnDevices(ids)
    }
    // Kept across a reset: the list and the readings come by two streams, so a new connection's list can arrive before its reset.
    @ObservationIgnored private var own: Set<Data> = []

    /// Asked after each event is folded in: the sections' model settles a channel made from a section once it shows. One slot: one `SectionsModel` per model is assumed.
    @ObservationIgnored var onReading: (() -> Void)?

    func apply(_ event: ReadingEvent) {
        defer { onReading?() }
        switch event {
        case .delivered(let view): reading.take(view: view)
        case .profile(let profile): reading.take(profile: profile)
        case .names(let names): reading.take(names: names)
        case .arrangement(let sections): reading.take(arrangement: sections)
        case .reset:
            reading = ReadingModel()
            reading.setOwnDevices(own)
        }
    }
}
