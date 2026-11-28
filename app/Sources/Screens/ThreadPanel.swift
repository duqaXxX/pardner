// The thread panel on the right: the opening message, then the thread's entries in order. An answer shows as
// it is written; a question or an approval is a card with its controls (requests design 2); Stop and the mode menu are in the header.
import Conversation
import DesignSystem
import AppKit
import SwiftUI

struct ThreadPanel: View {
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
    /// The ids of the lines of the folds the owner opened (`CallFold.isOpen`): a rebuild that changes the run's first line keeps the fold open.
    @State private var opened: Set<String> = []
    /// The devices the device log names bots: a notice of one is a system event even before its profile is read (#177).
    @Environment(\.botDevices) private var botDevices
    private static let end = "end"

    var body: some View {
        let _ = redraw // read, so that a change draws the day words again
        let queued = thread.queued
        // The day word before the root and each later entry that opens a day, a bot's answer by the time of its first part.
        let rows = ThreadRows.build(thread, isSystem: { model.isSystemEvent($0, bots: botDevices) }, isOpen: OpenBlocks.shared.isOpen)
        let days = Naming.dayLabels([thread.root?.time] + rows.map(\.time), now: Date(), calendar: .current)
        VStack(spacing: 0) {
            HStack(spacing: PardnerMetrics.gap) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: thread.sessionTitle ?? "Thread").font(PardnerFont.title).lineLimit(1)
                    if let bot = thread.bot {
                        Text([Naming.sender(bot, in: model), thread.state.pill].compactMap { $0 }.joined(separator: " · "))
                            .font(PardnerFont.secondary).foregroundStyle(PardnerColor.muted).lineLimit(1)
                    }
                }
                Spacer()
                if let composer { SessionControls(composer: composer, state: thread.state) }
                Button(action: close) { Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).frame(width: 30, height: 30).contentShape(Rectangle()) }
                    .buttonStyle(.clickable).foregroundStyle(PardnerColor.muted)
                    .accessibilityLabel("Close the thread")
            }
            .padding(.leading, PardnerMetrics.margin).padding(.trailing, 12).frame(height: PardnerMetrics.headerHeight)
            .movesWindow()
            .overlay(alignment: .bottom) { Rectangle().fill(PardnerColor.line).frame(height: 1) }
            SessionRow(model: model, thread: thread)
            Divider().overlay(PardnerColor.line)
            ScrollView {
                // Lazy, as the conversation is: a turn of hundreds of lines and a diff of thousands build the rows on screen alone.
                LazyVStack(alignment: .leading, spacing: ThreadRow.stack) {
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
                        Group {
                            switch row.content {
                            case .message(let m): entry(m, row: row, queued: queued)
                            case .unreadable(let count, let first): UnreadableRow(model: model, icons: icons, message: first, count: count, joins: row.joins, duration: row.duration)
                            case .segment(let a): AnswerRow(model: model, icons: icons, answer: a, whole: thread.text(of: a), joins: row.joins, duration: row.duration)
                            case .line(let l) where row.showsHead:
                                HeadedLine(model: model, icons: icons, line: l, duration: row.duration) {
                                    LineRow(line: l, state: thread.state(of: l), indent: 0, place: place, folder: folder, images: thread.images[l.ref] ?? [])
                                }
                            case .line(let l): LineRow(line: l, state: thread.state(of: l), place: place, folder: folder, images: thread.images[l.ref] ?? [])
                            case .fold(let f) where row.showsHead:
                                HeadedLine(model: model, icons: icons, line: f.lines[0], duration: row.duration) {
                                    foldRow(f, indent: 0)
                                }
                            case .fold(let f): foldRow(f)
                            case .body(let l, let i): LineBodyRow(line: l, index: i, stack: ThreadRow.stack, place: place)
                            }
                        }
                        .padding(.top, row.offset)
                    }
                    if let composer { PendingRows(model: composer, mark: .thread) }
                    // The end of the thread, the row the scroll position names while the view follows it; its spacing is the room under the last row, one point more than before.
                    Color.clear.frame(height: 1).id(Self.end)
                }
                .scrollTargetLayout()
                .padding(.horizontal, PardnerMetrics.margin).padding(.top, PardnerMetrics.listEnd)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            // One identity per thread: the anchor is read when the scroll view is made, so a thread opened after another would keep its offset.
            .id(thread.key)
            .scrollPosition(id: $scrolledID, anchor: .bottom)
            .onChange(of: thread.key) { scrolledID = Self.end }
            // The newest entry in view, and a short thread starting under its header.
            .defaultScrollAnchor(.bottom)
            .defaultScrollAnchor(.top, for: .alignment)
            if let composer {
                if let bot = thread.bot {
                    // A click on a task of the list brings its line into view through the scroll position, which stops following the end.
                    ActivityRow(model: model, icons: icons, bot: bot, state: thread.state, tasks: thread.openLines.filter(\.fields.task), composer: composer) {
                        scrolledID = ThreadRows.id(of: $0)
                    }
                }
                ComposerView(model: composer)
            }
        }
        .background(PardnerColor.panel)
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in redraw += 1 }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemTimeZoneDidChange)) { _ in redraw += 1 }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemClockDidChange)) { _ in redraw += 1 }
    }

    /// A fold's row: its calls drawn as the thread draws a call, indented under it while the owner has it open.
    private func foldRow(_ fold: CallFold, indent: CGFloat = MessageRow.Mark.thread.size + MessageRow.Mark.thread.gap) -> some View {
        FoldRow(fold: fold, isOpen: fold.isOpen(in: opened), toggle: { opened = fold.toggled(opened) }, indent: indent) { l in
            LineRow(line: l, state: thread.state(of: l), indent: 0, place: place, folder: folder, images: thread.images[l.ref] ?? [])
        }
    }

    @ViewBuilder
    private func entry(_ m: Message, row: ThreadRow, queued: Set<MessageRef>) -> some View {
        // Cards and lines hang on the text's column, after the avatar.
        let indent = MessageRow.Mark.thread.indent
        if thread.isRunLine(m), case .run(let at)? = m.sessionText {
            Text(verbatim: Naming.runLine(at: at)).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted).padding(.leading, indent)
        } else if case .request(let title, _, _) = m.body {
            Group {
                if let composer {
                    RequestCardView(card: composer.card(for: m), focus: $focus)
                } else {
                    RequestRow(title: title, status: thread.requests[m.ref] ?? .open)
                }
            }
            .padding(.leading, indent)
        } else {
            MessageRow(model: model, icons: icons, message: m, queued: queued.contains(m.ref), mark: .thread, place: place, joins: row.joins, duration: row.duration, compactNotices: true)
        }
    }

    private var place: FilePlace? { channel.map { FilePlace(channel: $0, thread: thread.key) } }
    /// The folder the channel is bound to, which a call's path is written from.
    private var folder: String? { channel.flatMap { model.channels[$0]?.bound?.bind.folder } }
}

/// A bot's answer: drawn from its parts while it is written, whole once it lands.
struct AnswerRow: View {
    let model: ReadingModel
    let icons: [Data: NSImage]
    let answer: AnswerGroup
    /// The whole answer, which Copy puts on the pasteboard whichever segment it is chosen on.
    let whole: String
    /// It stands under the head of the message above, of the same author: no avatar, name or time.
    var joins = false
    /// The length of the work this answer ended, which stands beside its time.
    var duration: String?

    var body: some View {
        let name = Naming.sender(answer.ref.device, in: model)
        let mark = MessageRow.Mark.thread
        // `Writing…` stands on the last segment of an answer that is not done.
        let writing = !answer.done && answer.last
        // A segment that continues its answer, or follows a message of the same bot, stands under the header above it, in the same column.
        let headless = answer.continues || joins
        HStack(alignment: .top, spacing: mark.gap) {
            if headless { Color.clear.frame(width: mark.size, height: 0) } else { Avatar(name: name, isBot: true, icon: icons[answer.ref.device], size: mark.size) }
            VStack(alignment: .leading, spacing: 4) {
                if !headless {
                    HStack(alignment: .firstTextBaseline, spacing: PardnerMetrics.gap) {
                        Text(name).font(PardnerFont.ui(size: 14, weight: .semibold))
                        BotBadge()
                        Text(Naming.time(answer.time) + (duration.map { " \u{B7} " + Naming.worked($0) } ?? "")).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                            .help(Naming.dateTime(answer.time))
                        if writing {
                            Text("Writing…").font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                        }
                    }
                    .designLines()
                }
                // Read at each part that reaches it: a structure half written is drawn half written until a later part (#73, 2.1).
                MarkdownView(text: answer.shown, copy: { Clipboard.copy(whole) }, foldKey: LongBlock.key(of: answer), wholeSelection: true).designLines()
                    .frame(maxWidth: PardnerMetrics.answerWidth, alignment: .leading)
                if writing && headless {
                    Text("Writing…").font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                }
            }
        }
        .contextMenu { Button("Copy as Markdown") { Clipboard.copy(whole) } }
    }
}

/// A call that opens the bot's reply, under the bot's head: its avatar, name, badge and time, as an answer's head draws them.
struct HeadedLine<Line: View>: View {
    let model: ReadingModel
    let icons: [Data: NSImage]
    let line: WorkLine
    var duration: String?
    @ViewBuilder let content: () -> Line

    var body: some View {
        let name = Naming.sender(line.ref.device, in: model)
        let mark = MessageRow.Mark.thread
        HStack(alignment: .top, spacing: mark.gap) {
            Avatar(name: name, isBot: true, icon: icons[line.ref.device], size: mark.size)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: PardnerMetrics.gap) {
                    Text(name).font(PardnerFont.ui(size: 14, weight: .semibold))
                    BotBadge()
                    Text(Naming.time(line.time) + (duration.map { " \u{B7} " + Naming.worked($0) } ?? "")).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                        .help(Naming.dateTime(line.time))
                }
                .designLines()
                content()
            }
        }
    }
}

/// Messages that cannot be opened on this device, one after another: one row with their count (turn work design 2.9).
struct UnreadableRow: View {
    let model: ReadingModel
    let icons: [Data: NSImage]
    let message: Message
    let count: Int
    var mark = MessageRow.Mark.thread
    /// A single row is a message as any other: it may stand under the head above and carry a turn's length.
    var joins = false
    var duration: String?

    var body: some View {
        if count == 1 {
            MessageRow(model: model, icons: icons, message: message, mark: mark, joins: joins, duration: duration)
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
            .menuStyle(.borderlessButton).menuIndicator(.hidden).clickable(composer.canCommand).fixedSize().disabled(!composer.canCommand).accessibilityLabel("Session mode")
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
        .buttonStyle(.clickable).disabled(!composer.canCommand)
        .accessibilityLabel("Stop the session").help("Stop")
    }
}

/// The session's data under the header, in the 40 point row the conversation's tabs share: the values at its newest work's end, and the
/// session's cost when its account has no plan. The model and effort first, the branch with its diff in monospace, then the context with its
/// bar and the tokens, set apart on the right; one line, the branch cut first. The whole text is the help tag.
struct SessionRow: View {
    let model: ReadingModel
    let thread: MessageThread

    var body: some View {
        // The cost line reads no time: it has no window, so no reset to count down.
        let profile = thread.bot.flatMap { model.profiles[$0] }
        let cost = thread.costUsage == nil || profile?.plan != nil ? nil
            : UsageLine.text(profileRead: profile != nil, plan: nil, windows: nil, cost: thread.costUsage, apiSeen: true, place: .composer, now: .now)
        let line = [thread.session, cost].compactMap { $0 }.joined(separator: " · ")
        let facts = SessionFacts(line)
        HStack(spacing: 14) {
            // In the order the bot wrote them; the context and what follows it are set apart on the right.
            ForEach(Array(facts.parts.enumerated()), id: \.offset) { index, part in
                if index == facts.firstRight { Spacer(minLength: 0) }
                switch part {
                case .plain(let text): Text(verbatim: text).font(PardnerFont.ui(size: 12, weight: .regular)).lineLimit(1).layoutPriority(1)
                case .model(let text): Text(verbatim: text).font(PardnerFont.ui(size: 12, weight: .semibold)).foregroundStyle(PardnerColor.text).lineLimit(1).layoutPriority(1)
                case .branch(let branch):
                    (Text(verbatim: branch.name).foregroundStyle(PardnerColor.muted) + Text(verbatim: (branch.name.isEmpty ? "" : " ") + "+\(branch.added)").foregroundStyle(PardnerColor.addText)
                        + Text(verbatim: " \u{2212}\(branch.removed)").foregroundStyle(PardnerColor.delText))
                        .font(PardnerFont.mono(size: 12, weight: .regular)).lineLimit(1).truncationMode(.tail)
                case .context(let percent):
                    HStack(spacing: 6) {
                        Text(verbatim: "Context \(percent)%")
                        Capsule().fill(PardnerColor.raised).frame(width: 48, height: 5)
                            .overlay(alignment: .leading) { Capsule().fill(PardnerColor.agent).frame(width: max(4, 48 * CGFloat(min(percent, 100)) / 100), height: 5) }
                    }
                    .fixedSize().accessibilityElement(children: .ignore).accessibilityLabel("\(percent) percent of context used")
                case .tokens(let text): Text(verbatim: text).font(PardnerFont.ui(size: 12, weight: .semibold)).foregroundStyle(PardnerColor.text).lineLimit(1).fixedSize()
                }
            }
        }
        .font(PardnerFont.secondary).foregroundStyle(PardnerColor.muted).help(line)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, PardnerMetrics.margin).frame(height: PardnerMetrics.subheaderHeight).clipped()
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
                    .buttonStyle(.clickable)
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
                    .buttonStyle(.clickable)
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
            .background(open ? PardnerColor.agentSoft : PardnerColor.container, in: RoundedRectangle(cornerRadius: PardnerMetrics.containerRadius))
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
