// What the menu commands and the context menus offer. The shell has no test target, so each rule a command reads is a function here.
import Foundation

/// The rules behind the menu commands and the channel's menus.
@MainActor
public enum Menus {
    /// `New Channel…`: this Mac is paired and the channels are ready. With a form already open, `ChannelsModel.openNew` brings that form forward.
    public static func canMakeChannel(paired: Bool, channels: ChannelsModel) -> Bool { paired && channels.ready }

    /// Which entries of a channel's menu are on, for the header's menu and the sidebar row's alike.
    struct ChannelEntries: Equatable { let rename: Bool, bind: Bool }

    static func channelEntries(_ channels: ChannelsModel, _ channel: Data) -> ChannelEntries {
        ChannelEntries(rename: channels.canRename(channel), bind: channels.canBind(channel))
    }
}
