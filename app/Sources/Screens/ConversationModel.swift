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

    func apply(_ event: ReadingEvent) {
        switch event {
        case .delivered(let view): reading.take(view: view)
        case .profile(let profile): reading.take(profile: profile)
        case .reset: reading = ReadingModel()
        }
    }
}
