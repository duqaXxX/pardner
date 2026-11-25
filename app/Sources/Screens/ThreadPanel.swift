// The thread panel on the right: the opening message, then the thread's entries in order. An answer shows as
// it is written; a question or an approval is a card with its controls (requests design 2); Stop and the mode menu are in the header.
import Conversation
import DesignSystem
import AppKit
import SwiftUI

struct ThreadPanel: View {
    /// The space between the thread's rows.
    static let rowSpacing = PardnerMetrics.gap * 2
    let model: ReadingModel
    let icons: [Data: NSImage]
    let thread: MessageThread
    let close: () -> Void
    /// This thread's composer; nil where the window has no pairing.
    var composer: ComposerModel?
    /// The channel the thread is in, where its calls' paths and file rows open their files; nil where the window has no pairing.
    var channel: Data?
    /// The card that has the keyboard, by its request's reference: only a click or Tab gives it, and a card that ends leaves it to no other.
    @FocusState private var focus: MessageRef?
    /// Only makes the view draw again when the day, the time zone or the clock changes; the day words are computed from the moment of drawing.
    @State private var redraw = 0
    /// The row the scroll view keeps in view; the end of the thread until the owner scrolls away. A lazy stack counts the rows it has not built
    /// with an estimate, so `defaultScrollAnchor` alone leaves the view over rows never built when rows are added to a long thread.
    @State private var scrolledID: String? = ThreadPanel.end
    private static let end = "end"

    var body: some View {
        let _ = redraw // read, so that a change draws the day words again
        let queued = thread.queued
        // The day word before the root and each later entry that opens a day, a bot's answer by the time of its first part.
        let rows = ThreadRows.build(thread)
        let days = Naming.dayLabels([thread.root?.time] + rows.map(\.time), now: Date(), calendar: .current)
        VStack(spacing: 0) {
            HStack(spacing: PardnerMetrics.gap) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: thread.sessionTitle ?? "Thread").font(PardnerFont.ui(size: 15, weight: .semibold)).lineLimit(1)
                    if let bot = thread.bot {
                        Text([Naming.sender(bot, in: model), thread.state.pill].compactMap { $0 }.joined(separator: " · "))
                            .font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted).lineLimit(1)
                    }
                    // The session's values at its newest work's end; the whole line is the help tag when it is cut.
                    if let session = thread.session {
                        Text(verbatim: session).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                            .lineLimit(1).truncationMode(.tail).help(session)
                    }
                }
                Spacer()
                if let composer { SessionControls(composer: composer, state: thread.state) }
                Button(action: close) { Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).frame(width: 30, height: 30).contentShape(Rectangle()) }
                    .buttonStyle(.plain).pointerStyle(.link).foregroundStyle(PardnerColor.muted)
                    .accessibilityLabel("Close the thread")
            }
            .padding(.leading, 16).padding(.trailing, 12).padding(.vertical, 10).frame(minHeight: 58)
            .movesWindow()
            Divider().overlay(PardnerColor.line)
            ScrollView {
                // Lazy, as the conversation is: a turn of hundreds of lines and a diff of thousands build the rows on screen alone.
                LazyVStack(alignment: .leading, spacing: Self.rowSpacing) {
                    if let day = days[0] { DaySeparator(label: day) }
                    if let root = thread.root {
                        MessageRow(model: model, icons: icons, message: root, queued: queued.contains(root.ref), mark: .thread)
                        // The count of replies between the opening message and the replies, as the conversation's summary says it; none while
                        // nothing has answered.
                        if !rows.isEmpty {
                            HStack(spacing: 10) {
                                if let words = Naming.dividerWords(thread.replies) {
                                    Text(words).font(PardnerFont.ui(size: 12, weight: .semibold)).foregroundStyle(PardnerColor.muted)
                                }
                                Rectangle().fill(PardnerColor.line).frame(height: 1)
                            }
                            .accessibilityElement(children: .ignore).accessibilityLabel(Naming.dividerWords(thread.replies) ?? "")
                        }
                    }
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        if let day = days[index + 1] { DaySeparator(label: day) }
                        switch row.content {
                        case .message(let m): entry(m, queued: queued)
                        case .unreadable(let count, let first): UnreadableRow(model: model, icons: icons, message: first, count: count)
                        case .segment(let a): AnswerRow(model: model, icons: icons, answer: a, whole: thread.text(of: a))
                        case .line(let l): LineRow(line: l, state: thread.state(of: l), place: place, images: thread.images[l.ref] ?? [])
                        case .body(let l, let i): LineBodyRow(line: l, index: i, firstTop: LineBodyRow.top(underStackOf: Self.rowSpacing))
                        }
                    }
                    if let composer { PendingRows(model: composer, mark: .thread) }
                    // The end of the thread, the row the scroll position names while the view follows it; its spacing is the room under the last row, one point more than before.
                    Color.clear.frame(height: 1).id(Self.end)
                }
                .scrollTargetLayout()
                .padding([.horizontal, .top], PardnerMetrics.gap * 2)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            // One identity per thread: the anchor is read when the scroll view is made, so a thread opened after another would keep its offset.
            .id(thread.key)
            .scrollPosition(id: $scrolledID, anchor: .bottom)
            .onChange(of: thread.key) { scrolledID = Self.end }
            // The newest entry in view, and a short thread starting under its header.
            .defaultScrollAnchor(.bottom)
            .defaultScrollAnchor(.top, for: .alignment)
            .focusedScrollbar(.panel)
            if let composer {
                if let bot = thread.bot {
                    // A click on a task of the list brings its line into view through the scroll position, which stops following the end.
                    ActivityRow(model: model, icons: icons, bot: bot, state: thread.state, tasks: thread.openLines.filter(\.fields.task), composer: composer) {
                        scrolledID = ThreadRows.id(of: $0)
                    }
                }
                ComposerView(model: composer)
                if let bot = thread.bot { AccountLine(model: model, thread: thread, bot: bot) }
            }
        }
        .background(PardnerColor.panel)
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in redraw += 1 }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemTimeZoneDidChange)) { _ in redraw += 1 }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemClockDidChange)) { _ in redraw += 1 }
    }

    @ViewBuilder
    private func entry(_ m: Message, queued: Set<MessageRef>) -> some View {
        if thread.isFooter(m), case .footer(let duration?, _, _)? = m.sessionText {
            Text(verbatim: duration).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
        } else if thread.isRunLine(m), case .run(let at)? = m.sessionText {
            Text(verbatim: Naming.runLine(at: at)).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
        } else if case .request(let title, _, _) = m.body {
            if let composer {
                RequestCardView(card: composer.card(for: m), focus: $focus)
            } else {
                RequestRow(title: title, status: thread.requests[m.ref] ?? .open)
            }
        } else {
            MessageRow(model: model, icons: icons, message: m, queued: queued.contains(m.ref), mark: .thread, place: place)
        }
    }

    private var place: FilePlace? { channel.map { FilePlace(channel: $0, thread: thread.key) } }
}

/// A bot's answer: drawn from its parts while it is written, whole once it lands.
struct AnswerRow: View {
    let model: ReadingModel
    let icons: [Data: NSImage]
    let answer: AnswerGroup
    /// The whole answer, which Copy puts on the pasteboard whichever segment it is chosen on.
    let whole: String

    var body: some View {
        let name = Naming.sender(answer.ref.device, in: model)
        let mark = MessageRow.Mark.thread
        // `Writing…` stands on the last segment of an answer that is not done.
        let writing = !answer.done && answer.last
        HStack(alignment: .top, spacing: mark.gap) {
            // A segment that continues its answer stands under the header above it, in the same column.
            if answer.continues { Color.clear.frame(width: mark.size, height: 0) } else { Avatar(name: name, isBot: true, icon: icons[answer.ref.device], size: mark.size) }
            VStack(alignment: .leading, spacing: 4) {
                if !answer.continues {
                    HStack(alignment: .firstTextBaseline, spacing: PardnerMetrics.gap) {
                        Text(name).font(PardnerFont.ui(size: 14, weight: .semibold))
                        BotBadge()
                        Text(Naming.time(answer.time)).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                            .help(Naming.dateTime(answer.time))
                        if writing {
                            Text("Writing…").font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                        }
                    }
                    .designLines()
                }
                // Read at each part that reaches it: a structure half written is drawn half written until a later part (#73, 2.1).
                MarkdownView(text: answer.shown, copy: { Clipboard.copy(whole) }).designLines()
                    .frame(maxWidth: PardnerMetrics.answerWidth, alignment: .leading)
                if writing && answer.continues {
                    Text("Writing…").font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                }
            }
        }
        .contextMenu { Button("Copy") { Clipboard.copy(whole) } }
    }
}

/// Messages that cannot be opened on this device, one after another: one row with their count (turn work design 2.9).
struct UnreadableRow: View {
    let model: ReadingModel
    let icons: [Data: NSImage]
    let message: Message
    let count: Int
    var mark = MessageRow.Mark.thread

    var body: some View {
        if count == 1 {
            MessageRow(model: model, icons: icons, message: message, mark: mark)
        } else {
            HStack(spacing: 6) {
                Image(systemName: "lock").font(.system(size: 12, weight: .medium)).accessibilityHidden(true)
                Text(verbatim: Naming.unreadable(count))
            }
            .font(PardnerFont.ui(size: 14, weight: .regular)).foregroundStyle(PardnerColor.muted)
            .padding(.leading, mark.size + mark.gap)
        }
    }
}

/// Stop while the session runs or waits, and the menu of the session's mode: each sends its word as a prompt in the thread (requests design 2.3 and 2.4),
/// through the composer, with the field as it is. Both are off for a session whose bot was removed.
struct SessionControls: View {
    let composer: ComposerModel
    let state: SessionState

    var body: some View {
        HStack(spacing: PardnerMetrics.gap) {
            if state != .idle { StopButton(composer: composer, blinks: false) }
            Menu {
                Button("Bypass on") { composer.command("/bypass on") }
                Button("Bypass off") { composer.command("/bypass off") }
                Divider()
                Button("Plan mode on") { composer.command("/plan on") }
                Button("Plan mode off") { composer.command("/plan off") }
            } label: { Image(systemName: "ellipsis").frame(width: 30, height: 30) }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).pointerStyle(composer.canCommand ? .link : nil).fixedSize().disabled(!composer.canCommand).accessibilityLabel("Session mode")
        }
    }
}

/// Sends `/stop` to the session's bot: a red square, which blinks where nothing else on the row moves.
struct StopButton: View {
    let composer: ComposerModel
    let blinks: Bool

    var body: some View {
        Button { composer.command("/stop") } label: {
            Image(systemName: "stop.fill").font(.system(size: 13, weight: .semibold)).foregroundStyle(.red).frame(width: 30, height: 30).contentShape(Rectangle())
                .pulses(blinks)
        }
        .buttonStyle(.plain).pointerStyle(composer.canCommand ? .link : nil).disabled(!composer.canCommand)
        .accessibilityLabel("Stop the session").help("Stop")
    }
}

/// The account's line under the composer (step D3 design, 3.3): the usage of the thread's bot, in sight where the terminal keeps its status line.
/// A timeline of its own redraws the line alone each minute, so a reset's `↻` counts down and `as of` appears: the panel's `redraw` moves only
/// at a day's change.
struct AccountLine: View {
    let model: ReadingModel
    let thread: MessageThread
    let bot: Data

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let profile = model.profiles[bot]
            if let line = UsageLine.text(profileRead: profile != nil, plan: profile?.plan, windows: model.windows[bot], cost: thread.costUsage,
                                         apiSeen: model.apiBots.contains(bot), place: .composer, now: context.date, timeZone: .current) {
                Text(verbatim: line).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                    .lineLimit(1).truncationMode(.tail).help(line)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.bottom, 8)
            }
        }
    }
}

/// The session's activity above the composer while it runs or waits: the bot, what it does (the word pulses; a click on it lists the tasks that
/// run) and Stop.
struct ActivityRow: View {
    let model: ReadingModel
    let icons: [Data: NSImage]
    let bot: Data
    let state: SessionState
    /// The open lines that are tasks, oldest first.
    let tasks: [WorkLine]
    let composer: ComposerModel
    /// Brings a task's line into view.
    let show: (WorkLine) -> Void
    @State private var listed = false

    var body: some View {
        if let words = Naming.activityWords(state, tasks: tasks.count) {
            let name = Naming.sender(bot, in: model)
            HStack(spacing: PardnerMetrics.gap) {
                Avatar(name: name, isBot: true, icon: icons[bot], size: 20).accessibilityHidden(true)
                Text(verbatim: name).font(PardnerFont.ui(size: 13, weight: .semibold)).lineLimit(1)
                if tasks.isEmpty {
                    Text(verbatim: words).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.muted).pulses(true)
                } else {
                    Button { listed.toggle() } label: {
                        Text(verbatim: words).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.muted).pulses(true)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).pointerStyle(.link)
                    .popover(isPresented: $listed) {
                        TaskList(tasks: tasks) { line in
                            listed = false
                            show(line)
                        }
                    }
                }
                StopButton(composer: composer, blinks: false)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16).padding(.vertical, 4)
            // The button that carries the popover goes with the last task: a popover left open would show again with the next one.
            .onChange(of: tasks.isEmpty) { listed = false }
        }
    }
}

/// The tasks that run, oldest first: what each does and the time it has run; a click on one brings its line into view.
struct TaskList: View {
    let tasks: [WorkLine]
    let choose: (WorkLine) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(tasks, id: \.ref) { line in
                    Button { choose(line) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: Naming.taskName(line.fields)).font(PardnerFont.ui(size: 13, weight: .semibold)).lineLimit(2)
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                Text(verbatim: Naming.runningWords(since: line.fields.startedAt, now: context.date))
                            }
                            .font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.agentText)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 8).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).pointerStyle(.link)
                }
            }
        }
        .frame(width: 320).frame(maxHeight: 320).fixedSize(horizontal: false, vertical: true)
    }
}

/// Fades to a third of its opacity and back, 2.4 s a round, while `active`; still under Reduce Motion, which also stills a pulse already running.
private struct Pulse: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    func body(content: Content) -> some View {
        content.opacity(dim ? 0.35 : 1).onAppear(perform: start).onChange(of: reduceMotion) {
            if reduceMotion { withAnimation(.easeInOut(duration: 0.2)) { dim = false } } else { start() }
        }
    }

    private func start() {
        guard active, !reduceMotion else { return }
        withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { dim = true }
    }
}

extension View {
    func pulses(_ active: Bool) -> some View { modifier(Pulse(active: active)) }
}

/// The frame of a request: `agent` while it waits for the owner, `line` once it ended.
extension View {
    func requestFrame(open: Bool) -> some View {
        padding(PardnerMetrics.gap * 1.5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(open ? PardnerColor.agentSoft : PardnerColor.surface, in: RoundedRectangle(cornerRadius: PardnerMetrics.containerRadius))
            .overlay(RoundedRectangle(cornerRadius: PardnerMetrics.containerRadius).stroke(open ? PardnerColor.agent : PardnerColor.line))
    }
}

/// A question or an approval, with where it stands, for a window with no composer.
struct RequestRow: View {
    let title: String
    let status: RequestStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: title).font(PardnerFont.ui(size: 14, weight: .semibold))
            Text(status.words).font(PardnerFont.ui(size: 12, weight: .medium))
                .foregroundStyle(status == .open ? PardnerColor.agentText : PardnerColor.muted)
        }
        .requestFrame(open: status == .open)
    }
}

extension RequestStatus {
    /// What a request says of itself once it is not the owner's to answer, or while no card can answer it.
    var words: String {
        switch self {
        case .open: "Waiting for you"
        case .replied, .answered: "Answered"
        case .withdrawn: "Withdrawn"
        case .rewritten(let markdown): markdown
        }
    }
}
