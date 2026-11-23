// The channel's panel, "Channel Settings…" (channel folder design, 2): a sheet with the channel's bot, folder and the folder's state from the
// bot's latest `/bind` answer, the answer's text under it, and Change Folder…. Colours, radii and the gap are the design system's tokens.
import Conversation
import DesignSystem
import SwiftUI

/// What the panel shows once the channel holds a bind field.
struct ChannelPanel: Equatable {
    let bot: Data
    let folder: String
    /// The state in words.
    let state: String
    /// The bot's answer, as written.
    let text: String

    /// The panel's content from the channel's latest bind answer; nil while there is none ("Not known yet.").
    init?(channel: Channel) {
        guard let answer = channel.bound else { return nil }
        self.init(bot: answer.bot, folder: answer.bind.folder, state: Self.words(answer.bind.state), text: answer.text)
    }

    init(bot: Data, folder: String, state: String, text: String) { (self.bot, self.folder, self.state, self.text) = (bot, folder, state, text) }

    static func words(_ state: Bind.State) -> String {
        switch state {
        case .usable: "Usable"
        case .untrusted: "Not trusted in Claude Code: open the folder in Claude Code once and accept the trust prompt"
        case .missing: "The folder is missing"
        case .unreadable: "The folder cannot be read"
        }
    }
}

/// The panel's sheet for the channel `id`; a channel the reading no longer holds shows as not known yet, with Done.
public struct ChannelPanelView: View {
    let model: ReadingModel
    let channels: ChannelsModel
    let id: Data

    /// The panel of channel `id` over `model`.
    public init(model: ReadingModel, channels: ChannelsModel, id: Data) { (self.model, self.channels, self.id) = (model, channels, id) }

    public var body: some View {
        let channel = model.channels[id]
        let panel = channel.flatMap(ChannelPanel.init(channel:))
        VStack(alignment: .leading, spacing: PardnerMetrics.gap * 2) {
            Text("Channel Settings").font(PardnerFont.display(size: 20, weight: .bold)).accessibilityAddTraits(.isHeader)
            if let panel {
                row("Bot", Naming.sender(panel.bot, in: model))
                row("Folder", panel.folder, mono: true)
                row("State", panel.state)
                Text(verbatim: panel.text).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.muted)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            } else {
                Text("Not known yet.").foregroundStyle(PardnerColor.muted)
            }
            HStack {
                Button("Change Folder…") { channels.closeForBind(bot: panel?.bot ?? channel.flatMap(ChannelsModel.bot(of:))) }
                    .buttonStyle(PardnerButton(prominent: false)).disabled(!channels.canBind(id))
                Spacer()
                Button("Done") { channels.close() }
                    .keyboardShortcut(.cancelAction).buttonStyle(PardnerButton(prominent: true)).accessibilityLabel("Close the channel settings")
            }
        }
        .padding(PardnerMetrics.gap * 2.5)
        .frame(width: 480)
        .background(PardnerColor.bg)
        .foregroundStyle(PardnerColor.text)
        .font(PardnerFont.ui(size: 14, weight: .regular))
    }

    private func row(_ title: String, _ value: String, mono: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(PardnerFont.ui(size: 12, weight: .semibold)).foregroundStyle(PardnerColor.muted)
            Text(verbatim: value).font(mono ? PardnerFont.mono(size: 12, weight: .regular) : PardnerFont.ui(size: 14, weight: .regular))
                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }
}
