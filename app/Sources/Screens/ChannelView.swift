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
            HStack(spacing: 10) {
                Text(Naming.channel(channel.id, in: model)).font(PardnerFont.display(size: 17, weight: .semibold)).lineLimit(1).layoutPriority(1)
                Spacer(minLength: 0)
                // The channel's bot, as a fact and not a button.
                if let bot = ChannelsModel.bot(of: channel) {
                    BotChip(name: Naming.sender(bot, in: model), icon: icons[bot])
                }
                if let channels {
                    Menu { ChannelActions(model: model, channels: channels, channel: channel) } label: { Image(systemName: "ellipsis").frame(width: 30, height: 30) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).pointerStyle(.link).fixedSize().accessibilityLabel("Channel actions")
                }
            }
            .padding(.horizontal, 24).padding(.top, 10).padding(.bottom, 6).frame(minHeight: 58)
            .movesWindow()
            if let line = channels?.faultLine(channel.id) {
                Text(line).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.delText)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 24).padding(.bottom, PardnerMetrics.gap)
            }
            HStack(spacing: 4) {
                ForEach(MainWindow.Tab.allCases, id: \.self) { item in tabButton(item, count: item == .sessions ? Self.sessionsCount(channel) : nil) }
                Spacer()
            }
            .padding(.horizontal, PardnerMetrics.gap * 2)
            Divider().overlay(PardnerColor.line)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
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
                                if t.state != .idle, let composers { StopButton(composer: composers.composer(channel: channel.id, thread: t.key), blinks: true) }
                            }
                        }
                    }
                    if tab == .conversation, let composers { PendingRows(model: composers.composer(channel: channel.id)) }
                }
                // Room under the tabs before the first message; the sides line the text up with the header's title.
                .padding(.top, 20).padding(.horizontal, 24).padding(.bottom, 8)
            }
            // One identity per channel and tab: the anchor is read when the scroll view is made, so without it a channel or a tab opened after
            // another would keep the offset of the one before.
            .id(channel.id.base64EncodedString() + tab.rawValue)
            // The conversation opens at its newest message and follows a new one; one shorter than the view starts under the tabs, never at the
            // bottom. The Sessions tab starts at the top.
            .defaultScrollAnchor(tab == .conversation ? .bottom : .top)
            .defaultScrollAnchor(.top, for: .alignment)
            if tab == .conversation, let composers {
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
                            .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18).background(PardnerColor.raised, in: Capsule())
                    }
                }
                .foregroundStyle(chosen ? PardnerColor.text : PardnerColor.muted)
                .padding(.horizontal, 8).frame(height: 32)
                Rectangle().fill(chosen ? PardnerColor.brand : .clear).frame(height: 2)
            }
            .fixedSize().contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerStyle(.link)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    /// One message with what stands under it, as one item of the list: a word's answer, or the note of an unsettled prompt and the thread's summary.
    /// The block of the thread the panel shows is tinted; the tint reaches past the block's padding, so that the text does not move.
    @ViewBuilder
    private func block(_ m: Message, queued: Set<MessageRef>) -> some View {
        let t = channel.threads[m.ref.hex]
        let tinted = t.map { !$0.isWord && $0.key == thread } ?? false
        VStack(alignment: .leading, spacing: 6) {
            MessageRow(model: model, icons: icons, message: m, queued: queued.contains(m.ref), tinted: tinted)
            if let t {
                if t.isWord {
                    // A word or a refused prompt: a message with the bot's lines under it, no session.
                    Answered(model: model, icons: icons, thread: t, prompt: m, place: FilePlace(channel: channel.id, thread: t.key)).padding(.leading, MessageRow.inset)
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
        .padding(.vertical, 4)
        .background {
            RoundedRectangle(cornerRadius: PardnerMetrics.containerRadius).fill(tinted ? PardnerColor.agentSoft : .clear)
                .padding(.horizontal, -12).padding(.vertical, -6)
        }
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
        Button("Channel Settings…") { channels.openSettings(channel: channel.id) }
        Button("Bind to a folder…") { channels.openBind(channel: channel.id, bot: ChannelsModel.bot(of: channel)) }.disabled(!on.bind)
    }
}

/// The word `Bot` beside a bot's name in the thread panel.
struct BotBadge: View {
    var body: some View {
        Text("Bot").font(PardnerFont.ui(size: 11, weight: .semibold)).foregroundStyle(PardnerColor.agentText)
            .padding(.horizontal, 6).frame(height: 16).background(PardnerColor.agentSoft, in: RoundedRectangle(cornerRadius: 8))
    }
}

/// The channel's bot in the header, as a fact and not a button: its mark and its name, as wide as the name up to `nameMost`, cut after.
struct BotChip: View {
    static let nameMost: CGFloat = 180

    let name: String
    let icon: NSImage?

    var body: some View {
        HStack(spacing: 6) {
            Avatar(name: name, isBot: true, icon: icon, size: 20).accessibilityHidden(true)
            Text(name).font(PardnerFont.ui(size: 13, weight: .medium)).lineLimit(1).truncationMode(.tail)
                .modifier(MostWidth(most: Self.nameMost))
        }
        .padding(.leading, 5).padding(.trailing, 10).frame(height: 30)
        .background(PardnerColor.surface, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(PardnerColor.line))
        .accessibilityElement(children: .ignore).accessibilityLabel("Bot \(name)")
    }
}

/// Caps a view's width at `most` while keeping it as narrow as its content: a `frame(maxWidth:)` takes all the width it is offered,
/// and a `fixedSize()` after it lays the content out at its whole width past the cap.
struct MostWidth: ViewModifier {
    let most: CGFloat

    func body(content: Content) -> some View {
        MostWidthLayout(most: most) { content }
    }
}

private struct MostWidthLayout: Layout {
    let most: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let view = subviews.first else { return .zero }
        return view.sizeThatFits(ProposedViewSize(width: min(proposal.width ?? .infinity, most), height: proposal.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}

extension View {
    /// A block of 14 point text with the design's 21 point lines (`MessageRow.lineSpacing`).
    func designLines() -> some View {
        lineSpacing(MessageRow.lineSpacing).padding(.vertical, MessageRow.lineSpacing / 2)
    }

    /// The empty part of a header under the hidden title bar moves the window as a title bar would, from an inactive window too.
    func movesWindow() -> some View {
        background { Color.clear.contentShape(Rectangle()).gesture(WindowDragGesture()).allowsWindowActivationEvents(true) }
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
func mentioned(_ mention: String?, _ text: String) -> Text {
    let body = Text(verbatim: text).foregroundStyle(PardnerColor.text)
    guard let mention else { return body }
    return Text(verbatim: mention + " ").font(PardnerFont.ui(size: 14, weight: .semibold)).foregroundStyle(PardnerColor.agentText) + body
}

/// One message: its sender's mark, name and time, then its text as written.
struct MessageRow: View {
    /// A mark's side and its gap to the text: the conversation's, and the thread panel's smaller one.
    struct Mark {
        let size: CGFloat
        let gap: CGFloat
        /// Whether a bot's name carries the `Bot` badge, as the thread panel draws it.
        let badgesBots: Bool
        static let conversation = Mark(size: 36, gap: 12, badgesBots: false)
        static let thread = Mark(size: 32, gap: 10, badgesBots: true)
    }
    /// What a block under a conversation's message is indented by to line up with its text.
    static let inset = Mark.conversation.size + Mark.conversation.gap
    /// What a 14 point line lacks to be the design's 21 points high, as CSS's `line-height` makes it: added between lines, and half above and
    /// half below a block, so that a single line is as high as one of many.
    static let lineSpacing: CGFloat = {
        let font = PardnerFont.uiCT(size: 14, weight: .regular)
        return max(0, 21 - (CTFontGetAscent(font) + CTFontGetDescent(font) + CTFontGetLeading(font)))
    }()

    let model: ReadingModel
    let icons: [Data: NSImage]
    let message: Message
    /// A prompt behind one that still runs (`MessageThread.queued`).
    var queued = false
    var mark = Mark.conversation
    /// The message stands in the tinted block of the open thread: a person's mark is drawn on `surface` there, as the design does.
    var tinted = false
    /// Where a file row opens its file; nil where the window has no pairing.
    var place: FilePlace?
    @Environment(FileOpener.self) private var opener: FileOpener?

    var body: some View {
        let name = Naming.sender(message.sender, in: model)
        // Only a bot publishes a profile (a kind no app device may send), so it says who is a bot; a text's `say` field does not, since
        // a person's app could write one.
        let isBot = model.profiles[message.sender] != nil
        HStack(alignment: .top, spacing: mark.gap) {
            Avatar(name: name, isBot: isBot, icon: icons[message.sender], size: mark.size, plate: tinted ? PardnerColor.surface : nil)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: PardnerMetrics.gap) {
                    Text(name).font(PardnerFont.ui(size: 14, weight: .semibold))
                    if isBot && mark.badgesBots { BotBadge() }
                    Text(Naming.time(message.time)).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                        .help(Naming.dateTime(message.time))
                }
                .designLines()
                Group {
                    if message.body == .unreadable {
                        // A lock before the words, as the design marks a message this device cannot open.
                        HStack(spacing: 6) {
                            Image(systemName: "lock").font(.system(size: 12, weight: .medium)).accessibilityHidden(true)
                            Text(verbatim: message.shown)
                        }
                        .foregroundStyle(PardnerColor.muted)
                    } else if case .file(let title) = message.body {
                        FileRow(title: title, message: message, place: place, opener: opener)
                    } else if isBot {
                        // A bot's text is read as Markdown, any other body of a bot keeps its code spans only; a person's stays exactly as typed (#73, 5.2).
                        if MarkdownView.reads(message.body) { MarkdownView(text: message.shown, copy: { Clipboard.copy(message.shown) }) } else { Text(CodeSpans.styled(message.shown)) }
                    } else {
                        mentioned(Naming.mention(of: message, in: model), message.shown)
                    }
                }
                .designLines()
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
    var place: FilePlace?

    var body: some View {
        VStack(alignment: .leading, spacing: PardnerMetrics.gap) {
            // The same rows as the thread panel, with their stable identities: a row's own state stays with it when an answer replaces its segments.
            ForEach(ThreadRows.build(thread)) { row in
                switch row.content {
                case .message(let line) where thread.isFooter(line):
                    if case .footer(let duration?, _, _)? = line.sessionText {
                        Text(verbatim: duration).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                    }
                case .message(let line): MessageRow(model: model, icons: icons, message: line, place: place)
                case .unreadable(let count, let first): UnreadableRow(model: model, icons: icons, message: first, count: count, mark: .conversation)
                case .line(let line): LineRow(line: line, state: thread.state(of: line), indent: 0, place: place)
                case .body(let line, let index): LineBodyRow(line: line, index: index, indent: 0)
                case .segment(let answer):
                    // Read at each part that reaches it: a structure half written is drawn half written until a later part (#73, 2.1).
                    MarkdownView(text: answer.shown, copy: { Clipboard.copy(thread.text(of: answer)) }).designLines()
                        .contextMenu { Button("Copy") { Clipboard.copy(thread.text(of: answer)) } }
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
                // In the conversation the root's first line stands right above: only the session's own title is new there.
                else if let title = thread.sessionTitle { Text(verbatim: title).font(PardnerFont.ui(size: 13, weight: .semibold)).lineLimit(1) }
                HStack(spacing: 10) {
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
            // In the conversation the bot's mark sits close to the left edge and a state pill close to the right one.
            .padding(.leading, showsTitle || thread.bot == nil ? 10 : 6).padding(.trailing, !showsTitle && thread.bot != nil && thread.state.pill != nil ? 6 : 10)
            .padding(.vertical, showsTitle ? PardnerMetrics.gap : 4)
            .frame(minHeight: 36)
            .frame(maxWidth: showsTitle ? .infinity : nil, alignment: .leading)
            .background(PardnerColor.surface, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(PardnerColor.line))
        }
        .buttonStyle(.plain).pointerStyle(.link)
        .accessibilityLabel(Self.spoken(model: model, thread: thread, showsTitle: showsTitle))
    }

    /// What the summary says to a screen reader: the title when it is drawn, then the bot, the replies, the last reply and the state word, when there are any.
    static func spoken(model: ReadingModel, thread: MessageThread, showsTitle: Bool) -> String {
        let bot = thread.bot.map { Naming.sender($0, in: model) }
        let state = thread.bot == nil ? nil : thread.state.pill
        return [showsTitle ? thread.title : thread.sessionTitle, bot, Naming.replies(thread.replies), thread.lastReplyWords, state].compactMap { $0 }.joined(separator: ", ")
    }

    private func pill(_ word: String) -> some View {
        let waiting = thread.state == .waiting
        return HStack(spacing: 6) {
            if waiting { Circle().fill(PardnerColor.badge).frame(width: 7, height: 7) }
            Text(word).font(PardnerFont.ui(size: 12, weight: .semibold)).lineLimit(1).fixedSize()
        }
        .foregroundStyle(waiting ? PardnerColor.agentText : PardnerColor.brandText)
        .padding(.horizontal, 8).frame(height: 22)
        .background(waiting ? PardnerColor.agentSoft : PardnerColor.brandSoft, in: Capsule())
    }
}
