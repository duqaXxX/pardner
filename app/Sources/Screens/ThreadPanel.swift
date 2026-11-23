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
        let entries: [Date?] = [thread.root?.time] + thread.items.map { if case .message(let m) = $0 { m.time } else if case .answer(let a) = $0 { a.time } else { nil } }
        let days = Naming.dayLabels(entries, now: Date(), calendar: .current)
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
                VStack(alignment: .leading, spacing: PardnerMetrics.gap * 2) {
                    if let day = days[0] { DaySeparator(label: day) }
                    if let root = thread.root {
                        MessageRow(model: model, icons: icons, message: root, queued: queued.contains(root.ref), mark: .thread)
                        // The count of replies between the opening message and the replies, as the conversation's summary says it; none while
                        // nothing has answered.
                        if thread.replies > 0 {
                            HStack(spacing: 10) {
                                Text(Naming.replies(thread.replies)).font(PardnerFont.ui(size: 12, weight: .semibold)).foregroundStyle(PardnerColor.muted)
                                Rectangle().fill(PardnerColor.line).frame(height: 1)
                            }
                            .accessibilityElement(children: .ignore).accessibilityLabel(Naming.replies(thread.replies))
                        }
                    }
                    ForEach(Array(thread.items.enumerated()), id: \.offset) { index, item in
                        switch item {
                        case .message(let m):
                            if let day = days[index + 1] { DaySeparator(label: day) }
                            entry(m, queued: queued)
                        case .answer(let a):
                            if let day = days[index + 1] { DaySeparator(label: day) }
                            AnswerRow(model: model, icons: icons, answer: a)
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

    var body: some View {
        let name = Naming.sender(answer.ref.device, in: model)
        let mark = MessageRow.Mark.thread
        HStack(alignment: .top, spacing: mark.gap) {
            Avatar(name: name, isBot: true, icon: icons[answer.ref.device], size: mark.size)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: PardnerMetrics.gap) {
                    Text(name).font(PardnerFont.ui(size: 14, weight: .semibold))
                    BotBadge()
                    Text(Naming.time(answer.time)).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                        .help(Naming.dateTime(answer.time))
                    if !answer.done {
                        Text("Writing…").font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                    }
                }
                .designLines()
                // Spans are read once the answer has landed; while parts come it is drawn as written (#73, section 7).
                Text(answer.done ? CodeSpans.styled(answer.markdown) : AttributedString(answer.markdown)).designLines().textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        }
        .contextMenu { Button("Copy") { Clipboard.copy(answer.markdown) } }
    }
}

/// Stop while the session runs or waits, and the menu of the session's mode: each sends its word as a prompt in the thread (requests design 2.3 and 2.4),
/// through the composer, with the field as it is. Both are off for a session whose bot was removed.
struct SessionControls: View {
    let composer: ComposerModel
    let state: SessionState

    var body: some View {
        HStack(spacing: PardnerMetrics.gap) {
            if state != .idle { StopButton(composer: composer) }
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

/// Sends `/stop` to the session's bot.
struct StopButton: View {
    let composer: ComposerModel

    var body: some View {
        Button("Stop") { composer.command("/stop") }
            .buttonStyle(PardnerButton(prominent: false)).disabled(!composer.canCommand).accessibilityLabel("Stop the session")
    }
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
