// What the menu commands and the context menus offer. The shell has no test target, so each rule a command reads is a function here.
import Foundation

/// The rules behind the menu commands and the channel's menus.
@MainActor
public enum Menus {
    /// A sheet is up while the Settings panel (Devices is a pane of it) or the channel or name sheet is open, or the name sheet waits for the panel to go: a menu command fires while a sheet is up, and a second sheet over the first must never be asked for.
    public static func sheetIsUp(settings: SettingsModel, channels: ChannelsModel) -> Bool { settings.holdsSheet || channels.sheet != nil }

    /// Escape closes the open thread panel: a thread is open and no sheet is up. The composer's `@` list and a text field take Escape first
    /// (the handler that asks this runs when the key has travelled up unanswered), and a request card's `onKeyPress` runs before it. The models are nil in the samples, which have no sheet.
    public static func escapeClosesThread(threadOpen: Bool, settings: SettingsModel?, channels: ChannelsModel?) -> Bool {
        threadOpen && !(settings?.holdsSheet ?? false) && channels?.sheet == nil
    }

    /// `New Channel…`: this Mac is paired, the channels are ready and no sheet is up.
    public static func canMakeChannel(paired: Bool, settings: SettingsModel, channels: ChannelsModel) -> Bool {
        paired && channels.ready && !sheetIsUp(settings: settings, channels: channels)
    }

    /// `Settings…` and `Devices…`: this Mac is paired and no sheet is up.
    public static func canOpenSettings(paired: Bool, settings: SettingsModel, channels: ChannelsModel) -> Bool {
        paired && !sheetIsUp(settings: settings, channels: channels)
    }

    /// `Devices…` follows the rule of `Settings…`.
    public static func canOpenDevices(paired: Bool, settings: SettingsModel, channels: ChannelsModel) -> Bool { canOpenSettings(paired: paired, settings: settings, channels: channels) }

    /// Which entries of a channel's menu are on, for the header's menu and the sidebar row's alike.
    struct ChannelEntries: Equatable { let rename: Bool, bind: Bool }

    static func channelEntries(_ channels: ChannelsModel, _ channel: Data) -> ChannelEntries {
        ChannelEntries(rename: channels.canRename(channel), bind: channels.canBind(channel))
    }
}
