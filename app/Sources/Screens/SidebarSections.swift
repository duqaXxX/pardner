// The sidebar's sections (sidebar sections design 7): a section's header with its menu, its name field, the lines that say why the commands are off,
// and the channel's entries for moving. The decisions live in `SectionsModel`; what a menu offers and what a line says are the functions of
// `SectionsMenu`, so that a test can ask them.
import Conversation
import DesignSystem
import SwiftUI

/// What the sidebar's name field is for.
enum SectionEdit: Equatable {
    /// A new section, with a channel to put in it when the field was opened from the channel's menu.
    case new(channel: Data?)
    case rename(section: String)
}

/// The rules behind the section menus and the sidebar's lines.
@MainActor
enum SectionsMenu {
    /// What a section's menu offers: Move Up and Move Down only where the move is possible, every command off while the device is not current,
    /// New Channel… also off until the channels are ready.
    struct Entries: Equatable { let enabled: Bool, newChannel: Bool, up: Bool, down: Bool }

    static func entries(_ sections: SectionsModel, channelsReady: Bool, section id: String) -> Entries {
        Entries(enabled: sections.current, newChannel: sections.current && channelsReady, up: sections.canMove(section: id, .up), down: sections.canMove(section: id, .down))
    }

    /// The muted line under the sidebar's header: why the commands are off, or that the device's last change took no part.
    static func line(current: Bool, behind: Bool, notApplied: Bool) -> String? {
        if !current { return behind ? "Your sections from your other devices are still being read." : "Reading your sections…" }
        return notApplied ? "A change to your sections was not applied: another device changed them first." : nil
    }

    /// The field that stays open: a rename of a section that is no longer shown closes.
    static func kept(_ edit: SectionEdit?, in tree: SectionsModel.Tree) -> SectionEdit? {
        if case .rename(let id)? = edit, !tree.sections.contains(where: { $0.id == id }) { return nil }
        return edit
    }

    /// The sessions of a section's channels that wait for the person: the sum of what each row shows, nil while none does.
    static func waiting(_ group: SectionsModel.Group, in model: ReadingModel) -> Int? {
        let count = group.channels.compactMap { model.channels[$0].flatMap(Sidebar.waitingCount) }.reduce(0, +)
        return count > 0 ? count : nil
    }
}

/// The count of sessions waiting for the person, in a pill.
struct WaitingBadge: View {
    let count: Int

    var body: some View {
        Text("\(count)").font(PardnerFont.ui(size: 11, weight: .bold)).foregroundStyle(PardnerColor.badgeInk)
            .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18).background(PardnerColor.badge, in: Capsule())
            .accessibilityLabel("\(count) waiting for you")
    }
}

/// The `…` button of a header, with the same entries as its context menu.
struct EllipsisMenu<Items: View>: View {
    let label: String
    @ViewBuilder let items: Items

    var body: some View {
        Menu { items } label: { Image(systemName: "ellipsis").frame(width: 22, height: 22) }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).clickable().fixedSize().accessibilityLabel(label)
    }
}

/// A section's header: its name, which folds and unfolds the rows on a click, the count of waiting sessions while folded, and the `…` button under the pointer.
struct SectionHeader: View {
    let sections: SectionsModel
    let channels: ChannelsModel?
    let group: SectionsModel.Group
    let waiting: Int?
    let rename: () -> Void
    @State private var hovered = false

    var body: some View {
        let folded = sections.isFolded(group.id)
        HStack(spacing: 4) {
            Button { sections.toggleFold(group.id) } label: {
                HStack(spacing: 4) {
                    Image(systemName: folded ? "chevron.right" : "chevron.down").font(.system(size: 8, weight: .bold)).frame(width: 10)
                    Text(verbatim: group.name.uppercased()).font(PardnerFont.ui(size: 11, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.clickable).accessibilityLabel(Text(verbatim: "\(folded ? "Unfold" : "Fold") \(group.name)"))
            EllipsisMenu(label: "Section actions") { SectionActions(sections: sections, channels: channels, group: group, rename: rename) }
                .opacity(hovered ? 1 : 0).allowsHitTesting(hovered)
            if folded, let waiting { WaitingBadge(count: waiting) }
        }
        .foregroundStyle(PardnerColor.sideMuted)
        .padding(.horizontal, PardnerMetrics.gap).padding(.bottom, 4)
        .onHover { hovered = $0 }
        .contextMenu { SectionActions(sections: sections, channels: channels, group: group, rename: rename) }
    }
}

/// A section's menu: the entries of design 7's table.
struct SectionActions: View {
    let sections: SectionsModel
    let channels: ChannelsModel?
    let group: SectionsModel.Group
    let rename: () -> Void

    var body: some View {
        let on = SectionsMenu.entries(sections, channelsReady: channels?.ready ?? false, section: group.id)
        Button("New Channel…") { channels?.openNew(in: group.id) }.disabled(!on.newChannel)
        Button("Rename…", action: rename).disabled(!on.enabled)
        if on.up { Button("Move Up") { sections.move(section: group.id, .up) }.disabled(!on.enabled) }
        if on.down { Button("Move Down") { sections.move(section: group.id, .down) }.disabled(!on.enabled) }
        Button("Remove Section") { sections.remove(section: group.id) }.disabled(!on.enabled)
    }
}

/// The entries a channel's menu gains: Move to Section (each section, "Channels", New Section…) and, inside a section, Move Up and Move Down.
struct ChannelSectionActions: View {
    let sections: SectionsModel
    let channel: Data
    let newSection: () -> Void

    var body: some View {
        let tree = sections.tree
        let home = tree.sections.first { $0.channels.contains(channel) }?.id
        Menu("Move to Section") {
            ForEach(tree.sections) { group in
                Button { sections.move(channel: channel, into: group.id) } label: { Text(verbatim: group.name) }.disabled(group.id == home)
            }
            Button("Channels") { sections.move(channel: channel, into: nil) }.disabled(home == nil)
            Divider()
            Button("New Section…", action: newSection)
        }
        .disabled(!sections.current)
        if sections.canMove(channel: channel, .up) { Button("Move Up") { sections.move(channel: channel, .up) }.disabled(!sections.current) }
        if sections.canMove(channel: channel, .down) { Button("Move Down") { sections.move(channel: channel, .down) }.disabled(!sections.current) }
    }
}

/// The name field of New Section… and Rename…: Return sends, Esc sends nothing and closes. It stays open while the act is in flight and when the
/// model refused the name, with the model's sentence under it.
struct SectionNameField: View {
    let sections: SectionsModel
    let edit: SectionEdit
    let done: () -> Void
    @State private var text: String
    @State private var sent = false
    @FocusState private var focused: Bool

    init(sections: SectionsModel, edit: SectionEdit, current: String = "", done: @escaping () -> Void) {
        (self.sections, self.edit, self.done) = (sections, edit, done)
        _text = State(initialValue: current)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField("Section name", text: $text)
                .textFieldStyle(.plain).focused($focused).onSubmit(send).onExitCommand(perform: done)
                .padding(.horizontal, PardnerMetrics.gap).frame(height: 28)
                .background(PardnerColor.sideSurface, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
                .overlay(RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius).stroke(PardnerColor.sideLine))
                .accessibilityLabel("Section name").disabled(!sections.current)
            if let problem = sections.problem {
                Text(problem).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.sideDelText).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .onAppear {
            sections.clearProblem()
            focused = true
        }
        .onChange(of: sections.working) {
            guard sent, !sections.working else { return }
            if sections.queued { done() } else { sent = false }
        }
    }

    private func send() {
        guard sections.current, !sections.working else { return }
        sent = true
        switch edit {
        case .new(let channel): sections.newSection(name: text, channel: channel)
        case .rename(let section): sections.rename(section: section, to: text)
        }
    }
}
