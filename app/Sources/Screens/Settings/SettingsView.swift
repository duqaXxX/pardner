// The Settings window (settings design 2, app windows design 3.1): 760 by 560 points, the panes listed at the left on `side` and the chosen pane
// at the right with its title, a line under it and its own action. Colours, radii and the gap are the design system's tokens.
import DesignSystem
import SwiftUI

public struct SettingsPanel: View {
    @Bindable var model: SettingsModel
    /// Renames this Mac (names design 4.3); nil where the window has no pairing.
    let renameThisMac: (() -> Void)?
    /// The Bots pane's bots, from `MainWindow.listedBots`, and their icons decoded once for the window.
    let bots: [DevicesModel.ListedBot]
    let icons: [Data: NSImage]
    /// The person's name as the device read it, for the Profile pane.
    let personName: String?

    public init(model: SettingsModel, bots: [DevicesModel.ListedBot] = [], icons: [Data: NSImage] = [:], personName: String? = nil, renameThisMac: (() -> Void)? = nil) {
        (self.model, self.bots, self.icons, self.personName, self.renameThisMac) = (model, bots, icons, personName, renameThisMac)
    }

    public var body: some View {
        HStack(spacing: 0) {
            side
            Divider().overlay(PardnerColor.line)
            Group {
                switch model.pane {
                case .general?: GeneralPane()
                case .profile?: ProfilePane(model: model.profile, live: personName, ready: model.devices.ready)
                case .devices?: DevicesPane(model: model.devices, renameThisMac: renameThisMac)
                case .bots?: BotsPane(bots: bots, icons: icons, listRead: model.devices.ready)
                case nil: EmptyView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: 760, height: 560)
        .background(PardnerColor.bg)
        .foregroundStyle(PardnerColor.text)
        .font(PardnerFont.ui(size: 14, weight: .regular))
    }

    /// The panes at the left, on `side` (the mock's 210 point column); the top clears the traffic lights over it.
    private var side: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Settings").font(PardnerFont.display(size: 17, weight: .bold)).accessibilityAddTraits(.isHeader)
                .padding(.horizontal, PardnerMetrics.gap * 1.5).padding(.bottom, PardnerMetrics.gap)
            ForEach(SettingsModel.Pane.allCases) { pane in
                Button { model.open(pane) } label: {
                    HStack(spacing: PardnerMetrics.gap) {
                        symbol(pane).frame(width: 18, height: 18)
                        Text(pane.rawValue)
                        Spacer()
                    }
                    .padding(.horizontal, PardnerMetrics.gap * 1.5).frame(height: 32).contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerStyle(.link)
                .font(PardnerFont.ui(size: 14, weight: model.pane == pane ? .semibold : .regular))
                .foregroundStyle(model.pane == pane ? PardnerColor.brandText : PardnerColor.text)
                .background(model.pane == pane ? PardnerColor.brandSoft : .clear, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
                .accessibilityAddTraits(model.pane == pane ? .isSelected : [])
            }
            Spacer()
        }
        .padding(.horizontal, PardnerMetrics.gap).padding(.top, 40)
        .frame(width: 210).frame(maxHeight: .infinity, alignment: .top).background(PardnerColor.side)
    }

    /// A pane's mark: a symbol, and for Bots the mark a bot has in the conversation.
    @ViewBuilder private func symbol(_ pane: SettingsModel.Pane) -> some View {
        switch pane {
        case .general: Image(systemName: "gearshape")
        case .profile: Image(systemName: "person.crop.circle")
        case .devices: Image(systemName: "laptopcomputer")
        case .bots: Avatar(name: "Bots", isBot: true, icon: nil, size: 16)
        }
    }
}

/// A pane's header: its title, a line under it, and the pane's own action at the right; the window's own controls close the window.
struct PaneHeader<Action: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder let action: Action

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(PardnerFont.display(size: 20, weight: .bold)).accessibilityAddTraits(.isHeader)
                if let subtitle { Text(subtitle).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.muted) }
            }
            Spacer()
            action
        }
        .padding(.horizontal, PardnerMetrics.gap * 2.5).padding(.top, PardnerMetrics.gap * 2.5).padding(.bottom, PardnerMetrics.gap * 1.5)
    }
}

/// General: Appearance, the setting the View menu's picker writes too.
struct GeneralPane: View {
    @AppStorage(Theme.storageKey) private var theme = Theme.fallback.rawValue

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader(title: "General", subtitle: "How Pardner looks.") {}
            HStack {
                Text("Appearance")
                Spacer()
                Picker("Appearance", selection: $theme) {
                    ForEach(Theme.allCases, id: \.rawValue) { Text($0.rawValue).tag($0.rawValue) }
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 180)
            }
            .padding(PardnerMetrics.gap * 2.5)
            Spacer()
        }
    }
}

/// Profile: the person's name, the same on every device of theirs; the picture comes with issue #96. Save is the pane's action, the default one.
struct ProfilePane: View {
    @Bindable var model: ProfileModel
    let live: String?
    let ready: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PaneHeader(title: "Profile", subtitle: "How you appear on every device of yours.") {
                Button("Save") { model.save(live: live, ready: ready) }
                    .buttonStyle(PardnerButton(prominent: true)).disabled(!model.canSave(live: live, ready: ready))
                    .keyboardShortcut(.defaultAction).accessibilityLabel("Save your name")
            }
            VStack(alignment: .leading, spacing: PardnerMetrics.gap) {
                Field(title: "Name", hint: "The name your other devices show for you.", error: nil) {
                    TextField("", text: Binding(get: { model.text(live: live) }, set: { model.edited = $0 }), prompt: Text("Set your name"))
                        .accessibilityLabel("Your name")
                }
                if !ready {
                    Text("Reading your devices…").font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.muted)
                }
                if let problem = model.problem {
                    Text(problem).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.delText).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, PardnerMetrics.gap * 2.5).padding(.top, PardnerMetrics.gap)
            Spacer()
        }
    }
}

/// Bots: each active bot of the person by its mark, its name and its account, or its label and `Not seen yet` until a channel carries its profile.
struct BotsPane: View {
    let bots: [DevicesModel.ListedBot]
    let icons: [Data: NSImage]
    /// The device list is read: before that the bots are not known, and an empty list says nothing about them.
    let listRead: Bool

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader(title: "Bots", subtitle: "The bots that hold your keys.") {}
            ScrollView {
                VStack(alignment: .leading, spacing: PardnerMetrics.gap * 1.5) {
                    if bots.isEmpty {
                        Text(listRead ? "No bots yet. Add one in Devices." : "Reading your devices…").foregroundStyle(PardnerColor.muted)
                    }
                    ForEach(bots) { bot in
                        HStack(spacing: PardnerMetrics.gap) {
                            Avatar(name: bot.name, isBot: true, icon: icons[bot.id], size: 32).accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 0) {
                                if let profile = bot.profile {
                                    Text(profile.name)
                                    if let account = profile.account {
                                        Text(account).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                                    }
                                } else {
                                    if let label = bot.label { NameText(name: label, font: PardnerFont.ui(size: 14, weight: .regular)) } else { Text(Naming.short(bot.id)) }
                                    // The profile comes with the first channel that carries the bot.
                                    Text("Not seen yet").font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                                }
                            }
                            Spacer()
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                .padding(PardnerMetrics.gap * 2.5).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}
