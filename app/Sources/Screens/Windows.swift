// The Settings window and the form window (app windows design 3, 4): two `Window` scenes whose roots show what `SettingsModel` and
// `ChannelsModel` hold. The models stay the one source of what is open; a root closes its window when its model empties, and runs the
// model's `close()` when the person closes the window with the red button or Command-W.
import Conversation
import DesignSystem
import SwiftUI

/// The scene ids the models' `present` closures open.
public enum WindowID {
    public static let settings = "settings"
    public static let form = "form"
    /// One window per reply opened, by value (`ReplyContent`).
    public static let reply = "reply"
    /// One window per file opened, by value (`FileWindowContent`).
    public static let file = "file"
    /// One window per table opened, by value (`TableContent`).
    public static let table = "table"
}

/// What every window root shares (app windows design 4, 7.2): it dismisses itself when its model holds nothing (the Window menu is
/// removed, but a restored or stray window is not left empty), follows the model closing, runs `close` when the window goes, and takes
/// Escape through one invisible `cancelAction` that the model answers (`escape`). `opacity(0)` and a zero frame hide the button: `.hidden()` did not
/// reliably keep its shortcut.
struct WindowRoot: ViewModifier {
    let id: String
    let isOpen: Bool
    let title: String
    let escape: () -> Void
    /// Closes what the window showed; `epoch` says which showing that was, so a close arriving late never ends a newer one.
    let epoch: () -> Int
    let close: (Int) -> Void
    @State private var shown = 0
    @Environment(\.dismissWindow) private var dismissWindow

    func body(content: Content) -> some View {
        content
            .background(Button("", action: escape).keyboardShortcut(.cancelAction).opacity(0).frame(width: 0, height: 0).accessibilityHidden(true))
            .navigationTitle(title)
            .windowMinimizeBehavior(.disabled)
            .onAppear {
                shown = epoch()
                if !isOpen { dismissWindow(id: id) }
            }
            .onChange(of: isOpen) { _, open in if !open { dismissWindow(id: id) } }
            .onDisappear { close(shown) }
    }
}

/// The Settings window over the live models.
public struct LiveSettingsWindow: View {
    let conversation: ConversationModel
    let settings: SettingsModel
    let channels: ChannelsModel

    public init(conversation: ConversationModel, settings: SettingsModel, channels: ChannelsModel) { (self.conversation, self.settings, self.channels) = (conversation, settings, channels) }

    public var body: some View {
        let reading = conversation.reading
        let icons = reading.profiles.compactMapValues { $0.icon.flatMap(NSImage.init(data:)) }
        SettingsPanel(model: settings, bots: MainWindow.listedBots(devices: settings.devices, profiles: reading.profiles), usage: reading.windows, apiBots: reading.apiBots, icons: icons, personName: reading.personName, renameThisMac: {
            // Settings stays open under the form window.
            let this = settings.devices.rows.first(where: \.isThisMac)
            channels.openRename(.device, current: this.flatMap { reading.names.devices[$0.id] ?? $0.label })
        })
        .modifier(WindowRoot(id: WindowID.settings, isOpen: settings.pane != nil, title: "Settings", escape: settings.escape, epoch: { settings.epoch }, close: { settings.close(ifEpoch: $0) }))
    }
}

/// The form window: whatever `ChannelsModel.sheet` holds.
public struct LiveFormWindow: View {
    let conversation: ConversationModel
    let channels: ChannelsModel

    public init(conversation: ConversationModel, channels: ChannelsModel) { (self.conversation, self.channels) = (conversation, channels) }

    private var title: String {
        switch channels.sheet {
        case .create?: "New Channel"
        case .bind?: "Bind to a Folder"
        case .rename(.channel)?: "Rename Channel"
        case .rename(.device)?: "Rename This Mac"
        case .settings?: "Channel Settings"
        case nil: ""
        }
    }

    public var body: some View {
        let reading = conversation.reading
        Group {
            switch channels.sheet {
            case .rename?: NameSheet(model: channels, channelNames: reading.names.channels)
            case .settings(let id)?: ChannelPanelView(model: reading, channels: channels, id: id)
            case .create?, .bind?: ChannelSheet(model: channels, names: reading.profiles.mapValues(\.name), channelNames: reading.names.channels)
            case nil: EmptyView()
            }
        }
        // The title bar is hidden and its traffic lights sit over the first line: the room is inside the background.
        .padding(.top, 14)
        .background(PardnerColor.bg)
        .modifier(WindowRoot(id: WindowID.form, isOpen: channels.sheet != nil, title: title, escape: channels.close, epoch: { channels.epoch }, close: { channels.close(ifEpoch: $0) }))
    }
}
