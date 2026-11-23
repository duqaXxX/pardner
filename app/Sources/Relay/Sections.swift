// The act of the person on the sidebar's sections, as the link's `arrange` takes it (sidebar sections design 3, 4.1).
import Foundation
import ProtocolHost

/// One act on the sections. A channel is its id; a section is the lowercase hex id the `arrangement` effect shows it under, since only
/// the link makes section ids. `nil` is "last" for a `before` and "no section" for a channel's `section`.
public enum SectionAct: Sendable, Equatable {
    case newSection(name: String, channel: Data? = nil)
    case renameSection(section: String, name: String)
    case moveSection(section: String, before: String?)
    case removeSection(section: String)
    case moveChannel(channel: Data, section: String?, before: Data?)

    /// The act as the link reads it (`ArrangeAct`): ids in lowercase hex, `type` the design's word.
    var hostValue: HostValue {
        func hex(_ id: Data) -> HostValue { .string(id.map { String(format: "%02x", $0) }.joined()) }
        func text(_ id: String?) -> HostValue { id.map { .string($0) } ?? .null }
        switch self {
        case .newSection(let name, let channel):
            var fields: [String: HostValue] = ["type": .string("section-new"), "name": .string(name)]
            if let channel { fields["channel"] = hex(channel) }
            return .object(fields)
        case .renameSection(let section, let name): return .object(["type": .string("section-rename"), "section": .string(section), "name": .string(name)])
        case .moveSection(let section, let before): return .object(["type": .string("section-move"), "section": .string(section), "before": text(before)])
        case .removeSection(let section): return .object(["type": .string("section-remove"), "section": .string(section)])
        case .moveChannel(let channel, let section, let before):
            return .object(["type": .string("channel-move"), "channel": hex(channel), "section": text(section), "before": before.map(hex) ?? .null])
        }
    }
}
