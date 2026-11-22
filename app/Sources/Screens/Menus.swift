// What the menu commands and the context menus offer. The shell has no test target, so each rule a command reads is a function here.
import Foundation

/// The rules behind the File menu's commands and the channel's menus.
@MainActor
public enum Menus {
    /// A sheet is up while the Devices sheet or the channel or name sheet is open, or the name sheet waits for the Devices sheet to go: a menu command fires while a sheet is up, and a second sheet over the first must never be asked for.
    public static func sheetIsUp(devices: DevicesModel, channels: ChannelsModel) -> Bool { devices.isOpen || devices.renamePending || channels.sheet != nil }

    /// `New Channel…`: this Mac is paired, the channels are ready and no sheet is up.
    public static func canMakeChannel(paired: Bool, devices: DevicesModel, channels: ChannelsModel) -> Bool {
        paired && channels.ready && !sheetIsUp(devices: devices, channels: channels)
    }

    /// `Devices…`: this Mac is paired and no sheet is up.
    public static func canOpenDevices(paired: Bool, devices: DevicesModel, channels: ChannelsModel) -> Bool {
        paired && !sheetIsUp(devices: devices, channels: channels)
    }

    /// Which entries of a channel's menu are on, for the header's menu and the sidebar row's alike.
    struct ChannelEntries: Equatable { let rename: Bool, bind: Bool }

    static func channelEntries(_ channels: ChannelsModel, _ channel: Data) -> ChannelEntries {
        ChannelEntries(rename: channels.canRename(channel), bind: channels.canBind(channel))
    }
}
