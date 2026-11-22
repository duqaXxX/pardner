// The Settings panel (settings design 2): one sheet over the main window, 600 by 640 points as the Devices sheet it replaced was, with a row of
// pane buttons at the top and the chosen pane under it. Colours, radii and the gap are the design system's tokens.
import DesignSystem
import SwiftUI

public struct SettingsPanel: View {
    @Bindable var model: SettingsModel
    /// Renames this Mac (names design 4.3); nil where the window has no pairing.
    let renameThisMac: (() -> Void)?
    /// The Bots pane's bots, from `MainWindow.listedBots`, and their icons decoded once for the window.
    let bots: [DevicesModel.ListedBot]
    let icons: [Data: NSImage]

    public init(model: SettingsModel, bots: [DevicesModel.ListedBot] = [], icons: [Data: NSImage] = [:], renameThisMac: (() -> Void)? = nil) {
        (self.model, self.bots, self.icons, self.renameThisMac) = (model, bots, icons, renameThisMac)
    }

    /// What each pane's `Done` does: closes the panel, and Devices with it. The view and its test both take it from here.
    static func done(_ model: SettingsModel) -> () -> Void { { model.close() } }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                ForEach(SettingsModel.Pane.allCases) { pane in
                    Button(pane.rawValue) { model.open(pane) }
                        .buttonStyle(.plain).pointerStyle(.link)
                        .font(PardnerFont.ui(size: 14, weight: model.pane == pane ? .semibold : .regular))
                        .padding(.horizontal, PardnerMetrics.gap + 2).frame(height: 30)
                        .background(model.pane == pane ? PardnerColor.raised : .clear, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
                        .accessibilityAddTraits(model.pane == pane ? .isSelected : [])
                }
                Spacer()
            }
            .padding(.horizontal, PardnerMetrics.gap * 1.5).frame(height: 44).background(PardnerColor.side)
            Divider().overlay(PardnerColor.line)
            switch model.pane {
            case .general?: GeneralPane(close: Self.done(model))
            case .devices?: DevicesPane(model: model.devices, done: Self.done(model), renameThisMac: renameThisMac)
            case .bots?: BotsPane(bots: bots, icons: icons, listRead: model.devices.ready, close: Self.done(model))
            case nil: EmptyView()
            }
        }
        .frame(width: 600, height: 640)
        .background(PardnerColor.bg)
        .foregroundStyle(PardnerColor.text)
        .font(PardnerFont.ui(size: 14, weight: .regular))
    }
}

/// A pane's header: its title and `Done`, the cancel action, which closes the panel.
struct PaneHeader: View {
    let title: String
    let done: () -> Void

    var body: some View {
        HStack {
            Text(title).font(PardnerFont.display(size: 20, weight: .bold)).accessibilityAddTraits(.isHeader)
            Spacer()
            Button("Done", action: done).keyboardShortcut(.cancelAction).buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Close the settings")
        }
        .padding(.horizontal, PardnerMetrics.gap * 2.5).frame(height: 56)
    }
}

/// General: Appearance, the setting the View menu's picker writes too.
struct GeneralPane: View {
    let close: () -> Void
    @AppStorage(Theme.storageKey) private var theme = Theme.fallback.rawValue

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader(title: "General", done: close)
            Divider().overlay(PardnerColor.line)
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

/// Bots: each active bot of the person by its mark, its name and its account, or its label and `Not seen yet` until a channel carries its profile.
struct BotsPane: View {
    let bots: [DevicesModel.ListedBot]
    let icons: [Data: NSImage]
    /// The device list is read: before that the bots are not known, and an empty list says nothing about them.
    let listRead: Bool
    let close: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader(title: "Bots", done: close)
            Divider().overlay(PardnerColor.line)
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
