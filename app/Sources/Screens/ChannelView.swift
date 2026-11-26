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
        let joined = Self.joined(ordered, drawsBelow: { m in
            channel.threads[m.ref.hex].map { $0.isWord || $0.showsSummary(openedBy: m.kind) } ?? false
        }, isTinted: isTinted)
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text(Naming.channel(channel.id, in: model)).font(PardnerFont.title).lineLimit(1).layoutPriority(1)
                Spacer(minLength: 0)
                // The channel's bot, as a fact and not a button.
                if let bot = ChannelsModel.bot(of: channel) {
                    BotChip(name: Naming.sender(bot, in: model), icon: icons[bot])
                }
                if let channels {
                    Menu { ChannelActions(model: model, channels: channels, channel: channel) } label: { Image(systemName: "ellipsis").frame(width: 30, height: 30) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).clickable().fixedSize().accessibilityLabel("Channel actions")
                }
            }
            .padding(.horizontal, PardnerMetrics.margin).frame(height: PardnerMetrics.headerHeight)
            .movesWindow()
            .overlay(alignment: .bottom) { Rectangle().fill(PardnerColor.line).frame(height: 1) }
            if let line = channels?.faultLine(channel.id) {
                Text(line).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.delText)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, PardnerMetrics.margin).padding(.vertical, PardnerMetrics.gap)
            }
            HStack(spacing: 4) {
                ForEach(MainWindow.Tab.allCases, id: \.self) { item in tabButton(item, count: item == .sessions ? Self.sessionsCount(channel) : nil) }
                Spacer()
            }
            .padding(.horizontal, 10)
            Divider().overlay(PardnerColor.line)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: PardnerMetrics.messageGap) {
                    switch tab {
                    case .conversation:
                        ForEach(channel.timeline, id: \.self) { position in
                            if let m = byPosition[position] {
                                if let day = days[m.position] ?? nil { DaySeparator(label: day) }
                                block(m, queued: queued, joins: joined.contains(m.position))
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
                // Room under the tabs before the first message and under the last; the sides line the text up with the header's title.
                .padding(.top, PardnerMetrics.listEnd).padding(.horizontal, PardnerMetrics.margin).padding(.bottom, PardnerMetrics.listEnd)
            }
            // One identity per channel and tab: the anchor is read when the scroll view is made, so without it a channel or a tab opened after
            // another would keep the offset of the one before.
            .id(channel.id.base64EncodedString() + tab.rawValue)
            // The conversation opens at its newest message and follows a new one; one shorter than the view starts under the tabs, never at the
            // bottom. The Sessions tab starts at the top.
            .defaultScrollAnchor(tab == .conversation ? .bottom : .top)
            .defaultScrollAnchor(.top, for: .alignment)
            .focusedScrollbar(.conversation)
            if tab == .conversation, let composers {
                ComposerView(model: composers.composer(channel: channel.id))
            }
        }
        .background(PardnerColor.bg)
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in redraw += 1 }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemTimeZoneDidChange)) { _ in redraw += 1 }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemClockDidChange)) { _ in redraw += 1 }
    }

    /// The positions of the messages that join the one above (`Grouping`); `drawsBelow` says a summary or lines stand under a message,
    /// `isTinted` that its block is the open thread's, which always draws its own head and so neither joins nor is joined.
    static func joined(_ messages: [Message], drawsBelow: (Message) -> Bool, isTinted: (Message) -> Bool) -> Set<Int> {
        var out = Set<Int>()
        var above: Grouping.Head?
        for m in messages {
            let head = Grouping.Head(author: m.sender, time: m.time)
            if !isTinted(m), Grouping.joins(above, head) { out.insert(m.position) }
            above = drawsBelow(m) || isTinted(m) ? nil : head
        }
        return out
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
                .padding(.horizontal, 10).frame(height: PardnerMetrics.subheaderHeight - 2)
                Rectangle().fill(chosen ? PardnerColor.brand : .clear).frame(height: 2)
            }
            .fixedSize().contentShape(Rectangle())
        }
        .buttonStyle(.clickable)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    /// Whether `m` opens the thread the panel shows: the one message whose block is the selected band.
    private func isTinted(_ m: Message) -> Bool { Self.opens(m, in: channel, thread: thread) }

    static func opens(_ m: Message, in channel: Channel, thread: String?) -> Bool { channel.threads[m.ref.hex].map { !$0.isWord && $0.key == thread } ?? false }

    /// One message with what stands under it, as one item of the list: a word's answer, or the note of an unsettled prompt and the thread's summary.
    /// The block of the thread the panel shows is on the selected band (`MessageBand`).
    @ViewBuilder
    private func block(_ m: Message, queued: Set<MessageRef>, joins: Bool) -> some View {
        let t = channel.threads[m.ref.hex]
        let tinted = isTinted(m)
        VStack(alignment: .leading, spacing: 0) {
            MessageRow(model: model, icons: icons, message: m, queued: queued.contains(m.ref), tinted: tinted, joins: joins)
            if let t {
                if t.isWord {
                    // A word or a refused prompt: a message with the bot's lines under it, no session.
                    Answered(model: model, icons: icons, thread: t, prompt: m, place: FilePlace(channel: channel.id, thread: t.key), folder: channel.bound?.bind.folder)
                        .padding(.top, PardnerMetrics.cardGap).padding(.leading, MessageRow.inset)
                } else if t.showsSummary(openedBy: m.kind) {
                    // No sign yet keeps the summary, which opens the thread: a first turn with no text can be reached.
                    let note = t.unsettledNote(of: m.ref)
                    VStack(alignment: .leading, spacing: 6) {
                        if let note {
                            Text(note).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                        }
                        Summary(model: model, icons: icons, thread: t, open: { thread = t.key }, isOpen: tinted)
                    }
                    // The row stands 6 points under the text; a note keeps the card gap it had.
                    .padding(.top, note == nil ? 6 : PardnerMetrics.cardGap).padding(.leading, MessageRow.inset)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(MessageBand(selected: tinted, joins: joins))
        // The list's spacing is a message's 20; a message that joins the one above stands 4 under it.
        .padding(.top, joins ? PardnerMetrics.groupGap - PardnerMetrics.messageGap : 0)
    }
}

/// The band behind a message (#174, section 6): `select` while its thread is open, `hover` under the pointer, across the whole column and
/// 8 points above and below the message, with no border or radius. It is a background, so the text does not move. A message that joins the
/// one above stands 4 points from it, so its band reaches 4 above and never covers the text of the block above. The pointer reacts over the
/// band's whole shape, not only over the content.
struct MessageBand: ViewModifier {
    let selected: Bool
    var joins = false
    @State private var hovered = false

    static let overhang: CGFloat = 8

    /// The band's colour: a selected message keeps `select` under the pointer.
    static func ground(selected: Bool, hovered: Bool) -> Color { selected ? PardnerColor.select : hovered ? PardnerColor.hover : .clear }

    /// How far the band reaches above the message: the gap to the block above when the message joins it.
    static func top(joins: Bool) -> CGFloat { joins ? PardnerMetrics.groupGap : overhang }

    func body(content: Content) -> some View {
        content
            .padding(EdgeInsets(top: Self.top(joins: joins), leading: PardnerMetrics.margin, bottom: Self.overhang, trailing: PardnerMetrics.margin))
            .background(Self.ground(selected: selected, hovered: hovered))
            .contentShape(Rectangle())
            .onHover { hovered = $0 }
            // The padding that makes the band is taken back, so the band adds no space.
            .padding(EdgeInsets(top: -Self.top(joins: joins), leading: -PardnerMetrics.margin, bottom: -Self.overhang, trailing: -PardnerMetrics.margin))
            // No exit event comes when the block is selected, replaced or scrolled away under the pointer.
            .onChange(of: selected) { hovered = false }
            .onDisappear { hovered = false }
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

/// Lays its views out in a line, each after the one before with `spacing` between, and starts the next line where a view does not fit the width;
/// a view wider than the width is proposed the width, so a text wraps in place. The views of a line are centred on it.
private struct WrapRow: Layout {
    let spacing: CGFloat

    /// Each view's frame, in the order of the views, for the width the lines may take.
    private func frames(_ subviews: Subviews, width: CGFloat) -> [CGRect] {
        var out: [CGRect] = []
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0
        var line: [Int] = []
        func finish() {
            for i in line { out[i].origin.y = y + (lineHeight - out[i].height) / 2 }
            y += lineHeight + spacing
            x = 0
            lineHeight = 0
            line = []
        }
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: width, height: nil))
            if x > 0, x + size.width > width { finish() }
            out.append(CGRect(x: x, y: 0, width: size.width, height: size.height))
            line.append(out.count - 1)
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        finish()
        return out
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let frames = frames(subviews, width: proposal.width ?? .infinity)
        return CGSize(width: frames.map(\.maxX).max() ?? 0, height: max(0, (frames.map(\.maxY).max() ?? 0)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (view, frame) in zip(subviews, frames(subviews, width: bounds.width)) {
            view.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), proposal: ProposedViewSize(width: frame.width, height: frame.height))
        }
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
    /// A block of 14 point text with the design's 22 point lines (`MessageRow.lineSpacing`).
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

/// The bot's `@name` as a gold label: `mentionText`, semibold. Its `mentionBg` ground is drawn behind it by `mentioned`, rounded by 5 and padded
/// 6 at the sides and 1 above and below, as the design draws it: a `Text` run's own background is square and unpadded, and a padding of
/// characters would be copied with the prompt.
func mentionLabel(_ mention: String) -> AttributedString {
    var label = AttributedString(mention)
    label.font = PardnerFont.ui(size: 14, weight: .semibold)
    label.foregroundColor = PardnerColor.mentionText
    return label
}

/// A prompt's text as one selectable text: the bot's `@name` as its label, then the text as written. Without a mention, the text alone.
func mentioned(_ mention: String?, _ text: String) -> some View { MentionedText(mention: mention, text: text) }

/// The label's ground reads where the mention sits from the text's own layout (`Text.LayoutKey`): the run carries `MentionRun`, since a
/// layout's character indices are opaque. The space after the mention is widened by the side padding (`kern`, no character), so that the
/// ground ends a space before the text; at the start of the line the ground reaches 6 points left of the column, where the text stays.
struct MentionedText: View {
    let mention: String?
    let text: String

    /// The ground's padding beyond the run: at each side, and above and below.
    static let side: CGFloat = 6, edge: CGFloat = 1, radius: CGFloat = 5

    private struct MentionRun: TextAttribute {}

    private var joined: Text {
        let body = Text(verbatim: text).foregroundStyle(PardnerColor.text)
        guard let mention else { return body }
        var space = AttributedString(" ")
        space.kern = Self.side
        return Text(mentionLabel(mention)).customAttribute(MentionRun()) + Text(space) + body
    }

    /// The rectangles of the mention's runs, in the text's coordinates; a mention that wraps has one per line.
    static func grounds(_ layouts: [Text.LayoutKey.AnchoredLayout], in proxy: GeometryProxy) -> [CGRect] {
        layouts.flatMap { anchored in
            let origin = proxy[anchored.origin]
            return anchored.layout.flatMap { line in
                line.filter { $0[MentionRun.self] != nil }.map { run in
                    run.typographicBounds.rect.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: -side, dy: -edge)
                }
            }
        }
    }

    var body: some View {
        joined.backgroundPreferenceValue(Text.LayoutKey.self) { layouts in
            GeometryReader { proxy in
                ForEach(Array(Self.grounds(layouts, in: proxy).enumerated()), id: \.offset) { _, rect in
                    RoundedRectangle(cornerRadius: Self.radius).fill(PardnerColor.mentionBg)
                        .frame(width: rect.width, height: rect.height).position(x: rect.midX, y: rect.midY)
                }
            }
        }
    }
}

/// One message: its sender's mark, name and time, then its text as written.
struct MessageRow: View {
    /// A mark's side and its gap to the text: the conversation's, and the thread panel's smaller one.
    struct Mark {
        let size: CGFloat
        let gap: CGFloat
        /// Whether a bot's name carries the `Bot` badge, as the thread panel draws it.
        let badgesBots: Bool
        /// Whether any text of the row is read at most `answerWidth` wide, a person's as a bot's (the thread panel; the conversation caps a bot's alone).
        var capsText = false
        static let conversation = Mark(size: 36, gap: 12, badgesBots: false)
        static let thread = Mark(size: 32, gap: 10, badgesBots: true, capsText: true)
        /// What a row that hangs on the text (a card, a call, a system event) is indented by, so that the avatar column stays empty.
        var indent: CGFloat { size + gap }
    }
    /// What a block under a conversation's message is indented by to line up with its text.
    static let inset = Mark.conversation.size + Mark.conversation.gap
    /// What a 14 point line lacks to be the design's 22 points high, as CSS's `line-height` makes it: added between lines, and half above and
    /// half below a block, so that a single line is as high as one of many.
    static let lineSpacing = spacing(size: 14, line: PardnerFont.textLine)

    /// What a line of Inter at `size` lacks to be `line` points high.
    static func spacing(size: CGFloat, line: CGFloat) -> CGFloat {
        let font = PardnerFont.uiCT(size: size, weight: .regular)
        return max(0, line - (CTFontGetAscent(font) + CTFontGetDescent(font) + CTFontGetLeading(font)))
    }

    let model: ReadingModel
    let icons: [Data: NSImage]
    let message: Message
    /// A prompt behind one that still runs (`MessageThread.queued`).
    var queued = false
    var mark = Mark.conversation
    /// The message stands on the selected band of the open thread: a person's mark and a code span are drawn on `surface` there, as the design does.
    var tinted = false
    /// Where a file row opens its file; nil where the window has no pairing.
    var place: FilePlace?
    /// It stands under the head of the message above, of the same author: no avatar, name or time (`Grouping`).
    var joins = false
    /// The length of the work this bot's answer ended, which stands beside its time.
    var duration: String?
    /// A bot's notice is drawn as a compact system event: the thread panel's form; the conversation draws it as any text of the bot.
    var compactNotices = false
    @Environment(FileOpener.self) private var opener: FileOpener?
    @Environment(\.botDevices) private var botDevices

    var body: some View {
        if compactNotices, model.isSystemEvent(message, bots: botDevices) {
            SystemEvent(text: message.shown, indent: mark.indent).contextMenu { Button("Copy") { Clipboard.copy(message.shown) } }
        } else {
            text
        }
    }

    private var text: some View {
        let name = Naming.sender(message.sender, in: model)
        // The device log names a device's kind, and only a bot publishes a profile (a kind no app device may send); a text's `say` field
        // does not say it, since a person's app could write one. Either is enough: a bot whose profile is not read yet is still a bot (#106).
        let isBot = model.isBot(message.sender, bots: botDevices)
        return HStack(alignment: .top, spacing: mark.gap) {
            if joins { Color.clear.frame(width: mark.size, height: 0) } else {
                Avatar(name: name, isBot: isBot, icon: icons[message.sender], size: mark.size, plate: tinted ? PardnerColor.surface : nil)
            }
            VStack(alignment: .leading, spacing: 4) {
                if !joins {
                    HStack(alignment: .firstTextBaseline, spacing: PardnerMetrics.gap) {
                        Text(name).font(PardnerFont.ui(size: 14, weight: .semibold))
                        if isBot && mark.badgesBots { BotBadge() }
                        Text(Naming.time(message.time) + (duration.map { " \u{B7} " + Naming.worked($0) } ?? "")).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                            .help(Naming.dateTime(message.time))
                    }
                    .designLines()
                }
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
                        if MarkdownView.reads(message.body) {
                            MarkdownView(text: message.shown, copy: { Clipboard.copy(message.shown) }, codeGround: tinted ? PardnerColor.surface : PardnerColor.codeInline).frame(maxWidth: PardnerMetrics.answerWidth, alignment: .leading)
                        } else { InlineCodeText(text: CodeSpans.styled(message.shown, ground: tinted ? PardnerColor.surface : PardnerColor.codeInline)) }
                    } else {
                        mentioned(Naming.mention(of: message, in: model), message.shown)
                    }
                }
                .designLines()
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .modifier(MostWidth(most: mark.capsText ? PardnerMetrics.answerWidth : .infinity))
                if queued { Text("Queued").font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted) }
            }
        }
        .contextMenu { Button("Copy") { Clipboard.copy(message.shown) } }
    }
}

extension EnvironmentValues {
    /// The devices the device log names bots, for a row that decides how its sender is drawn; empty where the window has no pairing.
    @Entry var botDevices: Set<Data> = []
}

/// The daemon's own line of an event (`Stopped.`, `Background command completed`): an icon and its words, compact, on the text's column with no avatar.
struct SystemEvent: View {
    let text: String
    let indent: CGFloat

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: text.hasPrefix("Stopped") ? "stop.fill" : "info.circle").font(.system(size: 11)).frame(width: 14).accessibilityHidden(true)
            // Read as a bot's text is: a word answer holds a link, a quote or a folder in backticks (`/bind`).
            MarkdownView(text: text, copy: { Clipboard.copy(text) }, size: 13)
        }
        .foregroundStyle(PardnerColor.muted).textSelection(.enabled)
        .padding(.leading, indent).frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// What stands under a prompt that opened no session: its state when it never ran or was cut, then the bot's lines and what its thread holds, in order.
struct Answered: View {
    let model: ReadingModel
    let icons: [Data: NSImage]
    let thread: MessageThread
    let prompt: Message
    var place: FilePlace?
    /// The channel's bound folder, which a call's path is written from.
    var folder: String?
    /// The ids of the lines of the folds the owner opened (`CallFold.isOpen`).
    @State private var opened: Set<String> = []

    var body: some View {
        let rows = ThreadRows.build(thread, isSystem: { _ in false })
        VStack(alignment: .leading, spacing: PardnerMetrics.gap) {
            // The same rows as the thread panel, with their stable identities: a row's own state stays with it when an answer replaces its segments.
            ForEach(rows) { row in
                switch row.content {
                case .message(let line) where thread.isRunLine(line):
                    if case .run(let at)? = line.sessionText {
                        Text(verbatim: Naming.runLine(at: at)).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                    }
                case .message(let line): MessageRow(model: model, icons: icons, message: line, place: place, duration: row.duration)
                case .unreadable(let count, let first): UnreadableRow(model: model, icons: icons, message: first, count: count, mark: .conversation, duration: row.duration)
                case .line(let line): LineRow(line: line, state: thread.state(of: line), indent: 0, place: place, folder: folder, images: thread.images[line.ref] ?? [])
                case .fold(let fold):
                    FoldRow(fold: fold, isOpen: fold.isOpen(in: opened), toggle: { opened = fold.toggled(opened) }, indent: 0) { line in
                        LineRow(line: line, state: thread.state(of: line), indent: 0, place: place, folder: folder, images: thread.images[line.ref] ?? [])
                    }
                case .body(let line, let index): LineBodyRow(line: line, index: index, indent: 0, stack: PardnerMetrics.gap)
                case .segment(let answer):
                    // Read at each part that reaches it: a structure half written is drawn half written until a later part (#73, 2.1).
                    MarkdownView(text: answer.shown, copy: { Clipboard.copy(thread.text(of: answer)) }).designLines()
                        .frame(maxWidth: PardnerMetrics.answerWidth, alignment: .leading)
                        .contextMenu { Button("Copy") { Clipboard.copy(thread.text(of: answer)) } }
                }
            }
            // The length stands beside the time of a head this list draws (a text, a lone unreadable message); the head of a reply that starts
            // with a call, or with an answer's segment, is not drawn here, so the length stands on a line of its own under the reply.
            if let line = Self.workedLine(rows) {
                Text(verbatim: line).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
            }
            if let state { Text(state).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted) }
        }
    }

    /// The line that says how long the work took, when the row that carries the length draws no head of its own: a message and a lone
    /// unreadable row show it beside their time already.
    static func workedLine(_ rows: [ThreadRow]) -> String? {
        guard let row = rows.last(where: { $0.duration != nil }), let duration = row.duration else { return nil }
        switch row.content {
        case .message, .unreadable: return nil
        case .line, .fold, .segment, .body: return Naming.worked(duration, asLine: true)
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

/// A thread's summary: in the conversation a row with no ground under its message (#174, section 7); in the Sessions tab a card under its
/// title, filling the row.
struct Summary: View {
    let model: ReadingModel
    let icons: [Data: NSImage]
    let thread: MessageThread
    let open: () -> Void
    var showsTitle = false
    /// The summary is under the message whose thread the panel shows: the row says so to a screen reader; it draws no label of its own.
    var isOpen = false
    @State private var hovered = false

    var body: some View {
        Button(action: open) { if showsTitle { card } else { row } }
        .buttonStyle(.clickable)
        .onHover { hovered = $0 }
        .onChange(of: isOpen) { hovered = false }
        .onDisappear { hovered = false }
        .accessibilityLabel(Self.spoken(model: model, thread: thread, showsTitle: showsTitle))
        .accessibilityAddTraits(isOpen ? .isSelected : [])
    }

    @ViewBuilder private var mark: some View {
        if let bot = thread.bot { Avatar(name: Naming.sender(bot, in: model), isBot: true, icon: icons[bot], size: showsTitle ? 22 : 18).accessibilityHidden(true) }
    }

    /// The row: the bot's mark, the replies, the session's title when it has one, the last reply and the state word, wrapping
    /// onto a next line whole where they do not fit.
    private var row: some View {
        WrapRow(spacing: 8) {
            mark
            Text(Naming.replies(thread.replies)).font(PardnerFont.ui(size: 13, weight: .semibold)).foregroundStyle(PardnerColor.brandText).underline(hovered)
            if let title = thread.sessionTitle { Text(verbatim: title).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.text).multilineTextAlignment(.leading) }
            if let last = thread.lastReplyWords { Text(last).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted) }
            // A thread between people has no bot, so no state to write.
            if thread.bot != nil, let word = thread.state.pill { pill(word) }
        }
        .frame(minHeight: 24, alignment: .leading).contentShape(Rectangle())
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: thread.title).font(PardnerFont.ui(size: 14, weight: .semibold)).lineLimit(1)
            HStack(spacing: 10) {
                mark
                Text(Naming.replies(thread.replies)).font(PardnerFont.ui(size: 13, weight: .semibold)).foregroundStyle(PardnerColor.brandText).lineLimit(1)
                if let last = thread.lastReplyWords { Text(last).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.muted).lineLimit(1) }
                if thread.bot != nil, let word = thread.state.pill { pill(word) }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(PardnerColor.muted)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, PardnerMetrics.gap)
        .frame(minHeight: 36).frame(maxWidth: .infinity, alignment: .leading)
        .background(PardnerColor.surface, in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(PardnerColor.line))
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
