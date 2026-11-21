// The channel as a conversation, oldest at the top, with a thread's summary under the message that opened it,
// and the Sessions tab ordered by the bot's last reply (first-screens decision 8).
import Conversation
import DesignSystem
import AppKit
import SwiftUI

struct ChannelView: View {
    let model: ReadingModel
    let icons: [Data: NSImage]
    let channel: Channel
    /// The channel acts; nil where the window has no pairing.
    var channels: ChannelsModel?
    @Binding var tab: MainWindow.Tab
    @Binding var thread: String?

    var body: some View {
        // The channel's own messages by position, found once per drawing rather than by a scan per row.
        let byPosition = Dictionary(uniqueKeysWithValues: channel.messages.map { ($0.position, $0) })
        VStack(spacing: 0) {
            HStack(spacing: PardnerMetrics.gap * 2) {
                Text(Naming.channel(channel.id)).font(PardnerFont.ui(size: 15, weight: .semibold))
                Picker("", selection: $tab) {
                    ForEach(MainWindow.Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden().fixedSize()
                Spacer()
                if let channels {
                    Menu {
                        Button("Bind to a folder…") { channels.openBind(channel: channel.id, bot: ChannelsModel.bot(of: channel)) }.disabled(!channels.canBind(channel.id))
                    } label: { Image(systemName: "ellipsis").frame(width: 22, height: 22) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().accessibilityLabel("Channel actions")
                }
            }
            .padding(.horizontal, PardnerMetrics.gap * 2).frame(height: 52)
            if let line = channels?.faultLine(channel.id) {
                Text(line).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.delText)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, PardnerMetrics.gap * 2).padding(.bottom, PardnerMetrics.gap)
            }
            Divider().overlay(PardnerColor.line)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: PardnerMetrics.gap * 2) {
                    switch tab {
                    case .conversation:
                        ForEach(channel.timeline, id: \.self) { position in
                            if let m = byPosition[position] {
                                MessageRow(model: model, icons: icons, message: m)
                                if let t = channel.threads[m.ref.hex], m.kind == 2 || !t.items.isEmpty {
                                    Summary(model: model, thread: t, open: { thread = t.key })
                                        .padding(.leading, 32 + PardnerMetrics.gap * 1.5)
                                }
                            }
                        }
                    case .sessions:
                        ForEach(channel.sessions, id: \.key) { t in
                            Summary(model: model, thread: t, open: { thread = t.key }, showsTitle: true)
                        }
                    }
                }
                .padding(PardnerMetrics.gap * 2)
            }
        }
        .background(PardnerColor.bg)
    }
}

/// One message: its sender's mark, name and time, then its text as written.
struct MessageRow: View {
    let model: ReadingModel
    let icons: [Data: NSImage]
    let message: Message

    var body: some View {
        let name = Naming.sender(message.sender, in: model)
        let profile = model.profiles[message.sender]
        HStack(alignment: .top, spacing: PardnerMetrics.gap * 1.5) {
            Avatar(name: name, isBot: profile != nil, icon: icons[message.sender])
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: PardnerMetrics.gap) {
                    Text(name).font(PardnerFont.ui(size: 14, weight: .semibold))
                    if let to = message.to, message.kind == 2 {
                        Text("@" + Naming.sender(to, in: model))
                            .font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.agentText)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(PardnerColor.agentSoft, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
                    }
                    Text(Naming.time(message.time)).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                }
                Text(verbatim: message.shown)
                    .foregroundStyle(message.body == .unreadable ? PardnerColor.muted : PardnerColor.text)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A thread's summary: in the conversation under the message that opened it, alone in the Sessions tab.
struct Summary: View {
    let model: ReadingModel
    let thread: MessageThread
    let open: () -> Void
    var showsTitle = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: PardnerMetrics.gap) {
                if let bot = thread.bot {
                    Circle().fill(dot).frame(width: 8, height: 8)
                    VStack(alignment: .leading, spacing: 2) {
                        if showsTitle { Text(verbatim: thread.title).font(PardnerFont.ui(size: 14, weight: .semibold)).lineLimit(1) }
                        Text("\(Naming.sender(bot, in: model)) · \(thread.state.label) · \(replies)\(last)")
                            .font(PardnerFont.ui(size: 12, weight: .medium))
                            .foregroundStyle(thread.state == .waiting ? PardnerColor.agentText : PardnerColor.muted)
                    }
                } else {
                    Text("\(replies)\(last)").font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.brandText)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(PardnerColor.muted)
            }
            .padding(.horizontal, PardnerMetrics.gap * 1.5).padding(.vertical, PardnerMetrics.gap)
            .background(PardnerColor.surface, in: RoundedRectangle(cornerRadius: PardnerMetrics.containerRadius))
            .overlay(RoundedRectangle(cornerRadius: PardnerMetrics.containerRadius).stroke(PardnerColor.line))
        }
        .buttonStyle(.plain)
    }

    private var replies: String { thread.replies == 1 ? "1 reply" : "\(thread.replies) replies" }
    private var last: String { thread.lastTime.map { " · last \(Naming.time($0))" } ?? "" }
    private var dot: Color {
        switch thread.state {
        case .running: PardnerColor.agent
        case .waiting: PardnerColor.badge
        case .idle: PardnerColor.okText
        }
    }
}
