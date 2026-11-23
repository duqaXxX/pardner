// What the sidebar's sections read and do (sidebar sections design 4, 6, 7): the shown tree over the reading model, the acts through the
// controller, the folds kept on this Mac, and a channel made from a section moved there once it shows. No view lives here.
import Conversation
import Foundation
import Observation
import Relay

@MainActor @Observable
public final class SectionsModel {
    /// A section as the sidebar draws it: only the channels this device holds, in the content's order. An empty one stays.
    public struct Group: Equatable, Identifiable {
        public let id: String
        public let name: String
        public let channels: [Data]
    }

    /// The sidebar's rows: the sections, then the "Channels" group (held channels no section lists, in today's order).
    public struct Tree: Equatable {
        public let sections: [Group]
        public let rest: [Data]
    }

    public enum Direction { case up, down }

    /// Makes one act through the controller; the answer lands in `finish`.
    public typealias Arranger = @MainActor (SectionAct) async throws -> SendOutcome

    static let foldedKey = "sections.folded"

    /// The sections whose rows are folded, by id; kept in the defaults of this Mac and never sent.
    public private(set) var folded: Set<String>
    public private(set) var problem: String?
    public private(set) var working = false

    private let conversation: ConversationModel
    private let arrange: Arranger
    private let defaults: UserDefaults
    /// Channels made from a section and not yet moved there: kept in memory only (design 7), so a quit leaves them under "Channels".
    private var waiting: [Data: String] = [:]
    /// The waiting channels whose move is asked and not answered: a settle in between makes no second move.
    private var moving: Set<Data> = []

    public init(conversation: ConversationModel, channels: ChannelsModel, defaults: UserDefaults = .standard, arrange: @escaping Arranger) {
        (self.conversation, self.arrange, self.defaults) = (conversation, arrange, defaults)
        folded = Set(defaults.stringArray(forKey: Self.foldedKey) ?? [])
        conversation.onReading = { [weak self] in self?.settle() }
        channels.onCreated = { [weak self] channel, section in
            self?.waiting[channel] = section
            self?.settle()
        }
    }

    // MARK: what the sidebar draws

    /// The tree the sidebar draws; with no arrangement it is every held channel under "Channels".
    public var tree: Tree {
        let reading = conversation.reading
        let held = Set(reading.channels.keys)
        let sections = (reading.arrangement.sections ?? []).map { Group(id: $0.id, name: $0.name, channels: $0.channels.filter(held.contains)) }
        let listed = Set(sections.flatMap(\.channels))
        return Tree(sections: sections, rest: MainWindow.ordered(reading).filter { !listed.contains($0) })
    }

    /// Every section act is offered only while the device has read everything (design 4.1).
    public var current: Bool { conversation.reading.arrangement.current }
    /// A copy of a kind 17 is still to come: the line says the sections of the other devices are being read.
    public var behind: Bool { conversation.reading.arrangement.behind }
    /// The device's own tree took no part when read back: the line says why.
    public var notApplied: Bool { conversation.reading.arrangement.notApplied }

    public func canMove(section: String, _ direction: Direction) -> Bool { canMove(tree.sections.map(\.id), section, direction) }

    /// A channel moves up or down among the channels its section shows; "Channels" has no order of its own.
    public func canMove(channel: Data, _ direction: Direction) -> Bool {
        guard let siblings = siblings(of: channel) else { return false }
        return canMove(siblings, channel, direction)
    }

    // MARK: the acts

    /// Each act is refused here, with nothing called, while the device is not current or an act is in flight.
    public func newSection(name: String, channel: Data? = nil) { run(.newSection(name: name, channel: channel)) }
    public func rename(section: String, to name: String) { run(.renameSection(section: section, name: name)) }
    public func remove(section: String) { run(.removeSection(section: section)) }

    public func move(section: String, _ direction: Direction) {
        let ids = tree.sections.map(\.id)
        guard canMove(ids, section, direction) else { return }
        run(.moveSection(section: section, before: before(ids, section, direction)))
    }

    /// Into `section` as its last channel, or out to "Channels" with nil.
    public func move(channel: Data, into section: String?) { run(.moveChannel(channel: channel, section: section, before: nil)) }

    public func move(channel: Data, _ direction: Direction) {
        guard let siblings = siblings(of: channel), canMove(siblings, channel, direction), let section = section(of: channel) else { return }
        run(.moveChannel(channel: channel, section: section, before: before(siblings, channel, direction)))
    }

    private func run(_ act: SectionAct) {
        guard current, !working else { return }
        (working, problem) = (true, nil)
        Task {
            do { finish(try await arrange(act), for: act) } catch { finishFailure(error) }
        }
    }

    func finish(_ outcome: SendOutcome, for act: SectionAct) {
        working = false
        switch outcome {
        case .queued: break
        case .notSaved: problem = "Pardner could not save the change. Try again."
        case .ended: problem = "Pardner is not connected. Try again in a moment."
        case .refused(let reason):
            switch (reason, act) {
            case ("not-ready", _): break // the reading moved between the check and the call: the act is not made, and the person acts again
            case ("too-many", _): problem = "There are too many sections, or too many channels in sections. Remove some and try again."
            case ("bad-input", .newSection), ("bad-input", .renameSection): problem = ChannelsModel.deviceNameRule
            case ("bad-input", _): problem = "This section or channel changed on another device. Try again."
            default: problem = "Pardner could not make this change. Try again in a moment."
            }
        }
    }

    func finishFailure(_ error: Error) {
        (working, problem) = (false, Problem.sentence("Pardner could not do this", error, next: "Try again."))
    }

    // MARK: Move Up and Move Down

    // Up and Down name a `before` among the shown neighbours. The protocol puts the moved channel directly before `before` in the whole
    // content, channels this device does not hold included (`applyAct`, `channel-move`), and drops those only afterwards: the shown order is
    // the content's order minus them, so a shown neighbour is always a right place, and the unheld ones between never show.
    private func canMove<T: Equatable>(_ items: [T], _ item: T, _ direction: Direction) -> Bool {
        guard let index = items.firstIndex(of: item) else { return false }
        return direction == .up ? index > 0 : index < items.count - 1
    }

    /// Up: the item above. Down: the item two below, which is directly after the one below; nil, last, when none is.
    private func before<T: Equatable>(_ items: [T], _ item: T, _ direction: Direction) -> T? {
        guard let index = items.firstIndex(of: item) else { return nil }
        if direction == .up { return items[index - 1] }
        return index + 2 < items.count ? items[index + 2] : nil
    }

    private func section(of channel: Data) -> String? { tree.sections.first { $0.channels.contains(channel) }?.id }
    private func siblings(of channel: Data) -> [Data]? { tree.sections.first { $0.channels.contains(channel) }?.channels }

    // MARK: folds

    public func isFolded(_ section: String) -> Bool { folded.contains(section) }

    /// Folds or unfolds a section on this Mac; nothing is sent.
    public func toggleFold(_ section: String) {
        if !folded.insert(section).inserted { folded.remove(section) }
        defaults.set(folded.sorted(), forKey: Self.foldedKey)
    }

    // MARK: a channel made from a section

    /// Asks the move of each waiting channel that the reading now holds, while the device is current. A section gone forgets the channel; an answer
    /// that is not final (`not-ready`, not saved, ended, a throw) keeps it for the next settle, as design 7 moves it once the device is current.
    func settle() {
        guard current else { return }
        let reading = conversation.reading
        for (channel, section) in waiting where reading.channels[channel] != nil && !moving.contains(channel) {
            guard reading.arrangement.sections?.contains(where: { $0.id == section }) == true else {
                waiting[channel] = nil
                continue
            }
            moving.insert(channel)
            Task { await move(channel, into: section) }
        }
    }

    private func move(_ channel: Data, into section: String) async {
        let outcome = try? await arrange(.moveChannel(channel: channel, section: section, before: nil))
        moving.remove(channel)
        switch outcome {
        case .queued, .refused("bad-input"), .refused("too-many"): waiting[channel] = nil // moved, or it no longer fits: it stays under "Channels"
        default: break
        }
    }
}
