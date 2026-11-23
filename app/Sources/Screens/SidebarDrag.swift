// The drag in the sidebar (sidebar sections design 7, "The drag"): what a drop makes, from the shown order alone, and the drop zones that
// ask it. The sidebar is a custom stack, not a `List`, so no row reports a position between two rows (design 13): each row is a zone that
// reads `DropInfo.location` against its own height, its upper half meaning before this row and its lower half before the row below.
import DesignSystem
import Foundation
import Observation
import Relay
import SwiftUI
import UniformTypeIdentifiers

enum SidebarDrag {
    /// Private to the app and declared in the Info.plist (`app/Shell/Info.plist`): no other app's drag fits it, and the provider is
    /// registered with the own-process visibility, so a drag never leaves the window.
    static let type = UTType(exportedAs: "io.github.duqaxxx.pardner.sidebar-item", conformingTo: .data)

    /// What is dragged, and the data of its provider.
    enum Item: Codable, Equatable {
        case channel(Data)
        case section(String)

        var isSection: Bool { if case .section = self { true } else { false } }
        var data: Data { (try? JSONEncoder().encode(self)) ?? Data() }
        init(data: Data) throws { self = try JSONDecoder().decode(Item.self, from: data) }

        var provider: NSItemProvider {
            let provider = NSItemProvider()
            provider.registerDataRepresentation(for: SidebarDrag.type, visibility: .ownProcess) { done in done(data, nil); return nil }
            return provider
        }
    }

    /// What is hovered; `below` is the lower half of the zone.
    enum Place: Equatable {
        case header(String, below: Bool)
        case row(Data, below: Bool)
        case channels
        /// An empty section's `No channels` row.
        case empty(String)

        var isBelow: Bool {
            switch self {
            case .header(_, let below), .row(_, let below): below
            case .channels, .empty: false
            }
        }
    }

    /// A drop zone's kind: what its place is, given where in it the pointer is.
    enum Zone: Equatable {
        case header(String)
        case row(Data)
        case channels
        /// An empty section's `No channels` row: a channel dropped on it goes into the section; a section is refused, as its line would
        /// show inside the section.
        case empty(String)

        /// Whether the zone's two halves mean different places: a row's always (a channel goes before it or before the row below), a header's
        /// only for a dragged section; a channel dropped on a header goes last, and "Channels" is one place.
        func halves(_ item: Item) -> Bool {
            switch self {
            case .row: true
            case .header: item.isSection
            case .channels, .empty: false
            }
        }

        /// The place the pointer at `y` in a zone `height` high stands for.
        func place(_ item: Item, y: CGFloat, height: CGFloat) -> Place {
            let below = halves(item) && y > height / 2
            switch self {
            case .header(let id): return .header(id, below: below)
            case .row(let id): return .row(id, below: below)
            case .channels: return .channels
            case .empty(let id): return .empty(id)
            }
        }
    }

    /// Where the insertion line or the outline shows: the zone's id, and the edge, nil for an outline.
    struct Mark: Equatable { let id: String; let below: Bool? }

    /// The act a drop makes, nil for a refusal or a drop where the item already is: nothing is then sent and nothing highlights.
    static func act(dragging item: Item, onto place: Place, in tree: SectionsModel.Tree, current: Bool) -> SectionAct? {
        guard current else { return nil }
        switch item {
        case .section(let id):
            let ids = tree.sections.map(\.id)
            guard ids.contains(id) else { return nil }
            let before: String?
            switch place {
            case .channels: before = nil
            case .header(let header, let below): before = below ? next(after: header, in: ids) : header
            case .row, .empty: return nil
            }
            return changes(ids, id, before: before) ? .moveSection(section: id, before: before) : nil
        case .channel(let channel):
            guard (tree.sections.flatMap(\.channels) + tree.rest).contains(channel) else { return nil }
            let target: SectionsModel.Group?, before: Data?
            switch place {
            case .channels: (target, before) = (nil, nil)
            case .header(let header, _), .empty(let header):
                guard let group = tree.sections.first(where: { $0.id == header }) else { return nil }
                (target, before) = (group, nil)
            case .row(let row, let below):
                if let group = tree.sections.first(where: { $0.channels.contains(row) }) {
                    (target, before) = (group, below ? next(after: row, in: group.channels) : row)
                } else { return nil }
            }
            // "Channels" has no order of its own: a channel already there stays.
            guard let target else { return tree.rest.contains(channel) ? nil : .moveChannel(channel: channel, section: nil, before: nil) }
            return changes(target.channels, channel, before: before) ? .moveChannel(channel: channel, section: target.id, before: before) : nil
        }
    }

    private static func next<T: Equatable>(after item: T, in items: [T]) -> T? {
        items.firstIndex(of: item).flatMap { $0 + 1 < items.count ? items[$0 + 1] : nil }
    }

    /// Whether putting `item` directly before `before` (last for nil) changes `items`.
    private static func changes<T: Equatable>(_ items: [T], _ item: T, before: T?) -> Bool {
        if before == item { return false }
        var moved = items.filter { $0 != item }
        moved.insert(item, at: before.flatMap(moved.firstIndex(of:)) ?? moved.endIndex)
        return moved != items
    }

    /// What the zones share: the item being dragged (the provider is read at the drop) and where the insertion line shows.
    @MainActor @Observable
    final class Hover {
        var dragging: Item?
        var mark: Mark?
    }
}

/// A drop zone: asks `SidebarDrag.act` while the pointer moves, marks where the drop would land and makes the act on the drop.
struct DropZone: ViewModifier {
    let sections: SectionsModel
    let hover: SidebarDrag.Hover
    let id: String
    let zone: SidebarDrag.Zone
    @State private var height: CGFloat = 0

    func body(content: Content) -> some View {
        let mark = hover.mark?.id == id ? hover.mark : nil
        content
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            .overlay(alignment: mark?.below == false ? .top : .bottom) {
                if let mark {
                    if mark.below == nil { RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius).stroke(PardnerColor.text, lineWidth: 1.5) }
                    else { Capsule().fill(PardnerColor.text).frame(height: 2) }
                }
            }
            .onDrop(of: [SidebarDrag.type], delegate: Delegate(zone: self))
    }

    private struct Delegate: DropDelegate {
        let zone: DropZone

        /// Every drop is refused while the device is not current and while an act is in flight, like the menus.
        private var open: Bool { zone.sections.current && !zone.sections.working }

        func validateDrop(info: DropInfo) -> Bool { open && info.hasItemsConforming(to: [SidebarDrag.type]) }

        func dropUpdated(info: DropInfo) -> DropProposal? {
            guard let item = zone.hover.dragging else { return DropProposal(operation: .forbidden) }
            let place = zone.zone.place(item, y: info.location.y, height: zone.height)
            let act = SidebarDrag.act(dragging: item, onto: place, in: zone.sections.tree, current: open)
            zone.hover.mark = act == nil ? nil : SidebarDrag.Mark(id: zone.id, below: zone.zone.halves(item) ? place.isBelow : nil)
            return DropProposal(operation: act == nil ? .forbidden : .move)
        }

        /// Only this zone's own mark: a late exit of the zone left must not wipe the mark of the zone entered.
        func dropExited(info: DropInfo) { if zone.hover.mark?.id == zone.id { zone.hover.mark = nil } }

        func performDrop(info: DropInfo) -> Bool {
            let (zone, y) = (zone, info.location.y)
            // A drag always starts in `onDrag`, which sets `dragging` again, so the stale item of a drag that ended elsewhere is never read.
            zone.hover.mark = nil
            zone.hover.dragging = nil
            guard let provider = info.itemProviders(for: [SidebarDrag.type]).first else { return false }
            provider.loadDataRepresentation(forTypeIdentifier: SidebarDrag.type.identifier) { data, _ in
                Task { @MainActor in
                    guard let data, let item = try? SidebarDrag.Item(data: data) else { return }
                    let place = zone.zone.place(item, y: y, height: zone.height)
                    if let act = SidebarDrag.act(dragging: item, onto: place, in: zone.sections.tree, current: zone.sections.current && !zone.sections.working) { zone.sections.drop(act) }
                }
            }
            return true
        }
    }
}

extension View {
    /// The drop zone where the window has sections.
    @ViewBuilder func zoned(_ zone: DropZone?) -> some View { if let zone { modifier(zone) } else { self } }
}
