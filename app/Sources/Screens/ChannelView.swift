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
    /// The composers; nil where the window has no pairing.
    var composers: Composers?
    @Binding var tab: MainWindow.Tab
    @Binding var thread: String?
    /// Only makes the view draw again when the day, the time zone or the clock changes; the day words are computed from the moment of drawing.
    @State private var redraw = 0

    var body: some View {
        let _ = redraw // read, so that a change draws the day words again
        // The channel's own messages by position, found once per drawing rather than by a scan per row.
        let byPosition = Dictionary(uniqueKeysWithValues: channel.messages.map { ($0.position, $0) })
        let queued = channel.threads.values.reduce(into: Set<MessageRef>()) { $0.formUnion($1.queued) }
        // The day word of each message that opens a day, by position.
        let ordered = channel.timeline.compactMap { byPosition[$0] }
        let days = Dictionary(uniqueKeysWithValues: zip(ordered.map(\.position), Naming.dayLabels(ordered.map(\.time), now: Date(), calendar: .current)))
        VStack(spacing: 0) {
            HStack(spacing: PardnerMetrics.gap * 2) {
                Text(Naming.channel(channel.id, in: model)).font(PardnerFont.display(size: 17, weight: .semibold)).lineLimit(1).layoutPriority(1)
                Spacer(minLength: 0)
                // The channel's bot, as a fact and not a button.
                if let bot = ChannelsModel.bot(of: channel) {
                    HStack(spacing: PardnerMetrics.gap) {
                        Avatar(name: Naming.sender(bot, in: model), isBot: true, icon: icons[bot], size: 20).accessibilityHidden(true)
                        Text(Naming.sender(bot, in: model)).font(PardnerFont.ui(size: 13, weight: .medium)).lineLimit(1).frame(maxWidth: 180)
                    }
                    .padding(.horizontal, PardnerMetrics.gap).padding(.vertical, 3)
                    .background(PardnerColor.surface, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
                    .overlay(RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius).stroke(PardnerColor.line))
                    .accessibilityElement(children: .ignore).accessibilityLabel("Bot \(Naming.sender(bot, in: model))")
                }
                if let channels {
                    Menu { ChannelActions(model: model, channels: channels, channel: channel) } label: { Image(systemName: "ellipsis").frame(width: 22, height: 22) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).pointerStyle(.link).fixedSize().accessibilityLabel("Channel actions")
                }
            }
            .padding(.horizontal, PardnerMetrics.gap * 2).frame(height: 48)
            if let line = channels?.faultLine(channel.id) {
                Text(line).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.delText)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, PardnerMetrics.gap * 2).padding(.bottom, PardnerMetrics.gap)
            }
            HStack(spacing: PardnerMetrics.gap * 2.5) {
                ForEach(MainWindow.Tab.allCases, id: \.self) { item in tabButton(item, count: item == .sessions ? Self.sessionsCount(channel) : nil) }
                Spacer()
            }
            .padding(.horizontal, PardnerMetrics.gap * 2)
            Divider().overlay(PardnerColor.line)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: PardnerMetrics.gap * 2) {
                    switch tab {
                    case .conversation:
                        ForEach(channel.timeline, id: \.self) { position in
                            if let m = byPosition[position] {
                                if let day = days[m.position] ?? nil { DaySeparator(label: day) }
                                block(m, queued: queued)
                            }
                        }
                    case .sessions:
                        ForEach(channel.sessions, id: \.key) { t in
                            HStack(spacing: PardnerMetrics.gap) {
                                Summary(model: model, icons: icons, thread: t, open: { thread = t.key }, showsTitle: true)
                                if t.state != .idle, let composers { StopButton(composer: composers.composer(channel: channel.id, thread: t.key)) }
                            }
                        }
                    }
                    if tab == .conversation, let composers { PendingRows(model: composers.composer(channel: channel.id)) }
                }
                .padding(PardnerMetrics.gap * 2)
            }
            // One identity per channel and tab: the anchor is read when the scroll view is made, so without it a channel or a tab opened after
            // another would keep the offset of the one before.
            .id(channel.id.base64EncodedString() + tab.rawValue)
            // The conversation opens at its newest message and follows a new one; a short one sits at the bottom. The Sessions tab starts at the top.
            .defaultScrollAnchor(tab == .conversation ? .bottom : .top)
            if tab == .conversation, let composers {
                Divider().overlay(PardnerColor.line)
                ComposerView(model: composers.composer(channel: channel.id))
            }
        }
        .background(PardnerColor.bg)
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in redraw += 1 }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemTimeZoneDidChange)) { _ in redraw += 1 }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemClockDidChange)) { _ in redraw += 1 }
    }

    /// The Sessions tab's count: the channel's sessions, nil while it has none. Counted, not sorted as `sessions` does.
    static func sessionsCount(_ channel: Channel) -> Int? {
        let count = channel.threads.values.filter(\.isSession).count
        return count == 0 ? nil : count
    }

    /// A tab of the row under the title: the chosen one in `text` over a rule in `brand`, the other in `muted`; the count of sessions in a pill.
    private func tabButton(_ item: MainWindow.Tab, count: Int?) -> some View {
        let chosen = tab == item
        return Button { tab = item } label: {
            VStack(spacing: 0) {
                HStack(spacing: 6) {
                    Text(item.rawValue).font(PardnerFont.ui(size: 13, weight: .semibold))
                    if let count {
                        Text("\(count)").font(PardnerFont.ui(size: 11, weight: .semibold)).foregroundStyle(PardnerColor.text)
                            .padding(.horizontal, 6).padding(.vertical, 1).background(PardnerColor.raised, in: Capsule())
                    }
                }
                .foregroundStyle(chosen ? PardnerColor.text : PardnerColor.muted)
                .padding(.vertical, 8)
                Rectangle().fill(chosen ? PardnerColor.brand : .clear).frame(height: 2)
            }
            .fixedSize().contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerStyle(.link)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    /// One message with what stands under it, as one item of the list: a word's answer, or the note of an unsettled prompt and the thread's summary.
    /// The block of the thread the panel shows is tinted, its inset kept so that the text does not move.
    @ViewBuilder
    private func block(_ m: Message, queued: Set<MessageRef>) -> some View {
        let t = channel.threads[m.ref.hex]
        let tinted = t.map { !$0.isWord && $0.key == thread } ?? false
        VStack(alignment: .leading, spacing: 6) {
            MessageRow(model: model, icons: icons, message: m, queued: queued.contains(m.ref))
            if let t {
                if t.isWord {
                    // A word or a refused prompt: a message with the bot's lines under it, no session.
                    Answered(model: model, icons: icons, thread: t, prompt: m).padding(.leading, MessageRow.inset)
                } else if t.showsSummary(openedBy: m.kind) {
                    // No sign yet keeps the summary, which opens the thread: a first turn with no text can be reached.
                    VStack(alignment: .leading, spacing: 6) {
                        if let note = t.unsettledNote(of: m.ref) {
                            Text(note).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                        }
                        Summary(model: model, icons: icons, thread: t, open: { thread = t.key })
                    }
                    .padding(.leading, MessageRow.inset)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(PardnerMetrics.gap)
        .background(tinted ? PardnerColor.agentSoft : .clear, in: RoundedRectangle(cornerRadius: PardnerMetrics.containerRadius))
        .padding(-PardnerMetrics.gap)
    }
}

/// A channel's acts, as the header's menu and a sidebar row's context menu list them; which are on comes from `Menus`.
struct ChannelActions: View {
    let model: ReadingModel
    let channels: ChannelsModel
    let channel: Channel

    var body: some View {
        let on = Menus.channelEntries(channels, channel.id)
        Button("Rename…") { channels.openRename(.channel(channel.id), current: model.names.channels[channel.id]) }.disabled(!on.rename)
        Button("Bind to a folder…") { channels.openBind(channel: channel.id, bot: ChannelsModel.bot(of: channel)) }.disabled(!on.bind)
    }
}

/// A day's word centred between two rules, before the first message of the day.
struct DaySeparator: View {
    let label: String

    var body: some View {
        HStack(spacing: PardnerMetrics.gap * 1.5) {
            Rectangle().fill(PardnerColor.line).frame(height: 1)
            Text(label).font(PardnerFont.ui(size: 12, weight: .semibold)).foregroundStyle(PardnerColor.muted)
            Rectangle().fill(PardnerColor.line).frame(height: 1)
        }
        .accessibilityElement(children: .ignore).accessibilityLabel(label)
    }
}

/// A prompt's text as one selectable text: the bot's `@name` in `agentText`, semibold, then the text as written. Without a mention, the text alone.
func mentioned(_ mention: String?, _ text: String, muted: Bool = false) -> Text {
    let body = Text(verbatim: text).foregroundStyle(muted ? PardnerColor.muted : PardnerColor.text)
    guard let mention else { return body }
    return Text(verbatim: mention + " ").font(PardnerFont.ui(size: 14, weight: .semibold)).foregroundStyle(PardnerColor.agentText) + body
}

/// One message: its sender's mark, name and time, then its text as written.
struct MessageRow: View {
    /// A mark's side in a message, and what a block under the message is indented by to line up with its text.
    static let markSize: CGFloat = 36
    static let inset = markSize + PardnerMetrics.gap * 1.5

    let model: ReadingModel
    let icons: [Data: NSImage]
    let message: Message
    /// A prompt behind one that still runs (`MessageThread.queued`).
    var queued = false

    var body: some View {
        let name = Naming.sender(message.sender, in: model)
        let profile = model.profiles[message.sender]
        HStack(alignment: .top, spacing: PardnerMetrics.gap * 1.5) {
            Avatar(name: name, isBot: profile != nil, icon: icons[message.sender], size: Self.markSize)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: PardnerMetrics.gap) {
                    Text(name).font(PardnerFont.ui(size: 14, weight: .semibold))
                    Text(Naming.time(message.time)).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                        .help(Naming.dateTime(message.time))
                }
                mentioned(Naming.mention(of: message, in: model), message.shown, muted: message.body == .unreadable)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if queued { Text("Queued").font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted) }
            }
        }
        .contextMenu { Button("Copy") { Clipboard.copy(message.shown) } }
    }
}

/// What stands under a prompt that opened no session: its state when it never ran or was cut, then the bot's lines and what its thread holds, in order.
struct Answered: View {
    let model: ReadingModel
    let icons: [Data: NSImage]
    let thread: MessageThread
    let prompt: Message

    var body: some View {
        VStack(alignment: .leading, spacing: PardnerMetrics.gap) {
            ForEach(Array(thread.items.enumerated()), id: \.offset) { _, item in
                switch item {
                case .message(let line): MessageRow(model: model, icons: icons, message: line)
                case .answer(let answer):
                    Text(verbatim: answer.markdown).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        .contextMenu { Button("Copy") { Clipboard.copy(answer.markdown) } }
                }
            }
            if let state { Text(state).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted) }
        }
    }

    // A cut after a sign of a word is an interruption; a not-read, the only way to settle as never run, is a prompt the bot never ran.
    private var state: String? {
        switch thread.prompts[prompt.ref] {
        case .cut: "Interrupted"
        case .notRead: "Not run"
        default: nil
        }
    }
}

/// A thread's summary: in the conversation inside its message's block, as wide as its content; in the Sessions tab under its title, filling the row.
struct Summary: View {
    let model: ReadingModel
    let icons: [Data: NSImage]
    let thread: MessageThread
    let open: () -> Void
    var showsTitle = false

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 2) {
                if showsTitle { Text(verbatim: thread.title).font(PardnerFont.ui(size: 14, weight: .semibold)).lineLimit(1) }
                HStack(spacing: PardnerMetrics.gap) {
                    if let bot = thread.bot { Avatar(name: Naming.sender(bot, in: model), isBot: true, icon: icons[bot], size: 22).accessibilityHidden(true) }
                    Text(Naming.replies(thread.replies)).font(PardnerFont.ui(size: 13, weight: .semibold)).foregroundStyle(PardnerColor.brandText).lineLimit(1)
                    if let last = thread.lastReplyWords { Text(last).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.muted).lineLimit(1) }
                    // A thread between people has no bot, so no state to write.
                    if thread.bot != nil, let word = thread.state.pill { pill(word) }
                    if showsTitle {
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(PardnerColor.muted)
                    }
                }
            }
            .padding(.horizontal, PardnerMetrics.gap * 1.5).padding(.vertical, PardnerMetrics.gap)
            .frame(maxWidth: showsTitle ? .infinity : nil, alignment: .leading)
            .background(PardnerColor.surface, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
            .overlay(RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius).stroke(PardnerColor.line))
        }
        .buttonStyle(.plain).pointerStyle(.link)
        .accessibilityLabel(Self.spoken(model: model, thread: thread, showsTitle: showsTitle))
    }

    /// What the summary says to a screen reader: the title when it is drawn, then the bot, the replies, the last reply and the state word, when there are any.
    static func spoken(model: ReadingModel, thread: MessageThread, showsTitle: Bool) -> String {
        let bot = thread.bot.map { Naming.sender($0, in: model) }
        let state = thread.bot == nil ? nil : thread.state.pill
        return [showsTitle ? thread.title : nil, bot, Naming.replies(thread.replies), thread.lastReplyWords, state].compactMap { $0 }.joined(separator: ", ")
    }

    private func pill(_ word: String) -> some View {
        let waiting = thread.state == .waiting
        return HStack(spacing: 5) {
            if waiting { Circle().fill(PardnerColor.badge).frame(width: 7, height: 7) }
            Text(word).font(PardnerFont.ui(size: 11, weight: .semibold)).lineLimit(1).fixedSize()
        }
        .foregroundStyle(waiting ? PardnerColor.agentText : PardnerColor.brandText)
        .padding(.horizontal, 8).padding(.vertical, 2)
        .background(waiting ? PardnerColor.agentSoft : PardnerColor.brandSoft, in: Capsule())
    }
}
