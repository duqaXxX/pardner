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
    /// The card that has the keyboard, by its request's reference: only a click or Tab gives it, and a card that ends leaves it to no other.
    @FocusState private var focus: MessageRef?
    /// Only makes the view draw again when the day, the time zone or the clock changes; the day words are computed from the moment of drawing.
    @State private var redraw = 0

    var body: some View {
        let _ = redraw // read, so that a change draws the day words again
        let queued = thread.queued
        // The day word before the root and each later entry that opens a day, a bot's answer by the time of its first part.
        let rows = ThreadRows.build(thread)
        let days = Naming.dayLabels([thread.root?.time] + rows.map(\.time), now: Date(), calendar: .current)
        VStack(spacing: 0) {
            HStack(spacing: PardnerMetrics.gap) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Thread").font(PardnerFont.ui(size: 15, weight: .semibold))
                    if let bot = thread.bot {
                        Text([Naming.sender(bot, in: model), thread.state.pill].compactMap { $0 }.joined(separator: " · "))
                            .font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted).lineLimit(1)
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
                LazyVStack(alignment: .leading, spacing: PardnerMetrics.gap * 2) {
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
                        case .line(let l): LineRow(line: l, state: thread.state(of: l))
                        case .body(let l, let i): LineBodyRow(line: l, index: i)
                        }
                    }
                    if let composer { PendingRows(model: composer, mark: .thread) }
                }
                .padding(PardnerMetrics.gap * 2)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            // One identity per thread: the anchor is read when the scroll view is made, so a thread opened after another would keep its offset.
            .id(thread.key)
            // The newest entry in view, and a short thread starting under its header.
            .defaultScrollAnchor(.bottom)
            .defaultScrollAnchor(.top, for: .alignment)
            if let composer {
                if let bot = thread.bot { ActivityRow(model: model, icons: icons, bot: bot, state: thread.state, composer: composer) }
                ComposerView(model: composer)
            }
        }
        .background(PardnerColor.panel)
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in redraw += 1 }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemTimeZoneDidChange)) { _ in redraw += 1 }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemClockDidChange)) { _ in redraw += 1 }
    }

    @ViewBuilder
    private func entry(_ m: Message, queued: Set<MessageRef>) -> some View {
        if case .request(let title, _, _) = m.body {
            if let composer {
                RequestCardView(card: composer.card(for: m), focus: $focus)
            } else {
                RequestRow(title: title, status: thread.requests[m.ref] ?? .open)
            }
        } else {
            MessageRow(model: model, icons: icons, message: m, queued: queued.contains(m.ref), mark: .thread)
        }
    }
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
                // Spans are read once the answer has landed; while parts come it is drawn as written (#73, section 7).
                Text(answer.done ? CodeSpans.styled(answer.shown) : AttributedString(answer.shown)).designLines().textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
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

/// The session's activity above the composer while it runs or waits: the bot, what it does (the word pulses) and Stop.
struct ActivityRow: View {
    let model: ReadingModel
    let icons: [Data: NSImage]
    let bot: Data
    let state: SessionState
    let composer: ComposerModel

    var body: some View {
        if let words = state.activityWords {
            let name = Naming.sender(bot, in: model)
            HStack(spacing: PardnerMetrics.gap) {
                Avatar(name: name, isBot: true, icon: icons[bot], size: 20).accessibilityHidden(true)
                Text(verbatim: name).font(PardnerFont.ui(size: 13, weight: .semibold)).lineLimit(1)
                Text(verbatim: words).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.muted).pulses(true)
                StopButton(composer: composer, blinks: false)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16).padding(.vertical, 4)
        }
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
