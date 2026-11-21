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

    var body: some View {
        let queued = thread.queued
        VStack(spacing: 0) {
            HStack(spacing: PardnerMetrics.gap) {
                Text("Thread").font(PardnerFont.ui(size: 15, weight: .semibold))
                if let bot = thread.bot {
                    Text("\(Naming.sender(bot, in: model)) · \(thread.state.label)")
                        .font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.muted)
                }
                Spacer()
                if let composer { SessionControls(composer: composer, state: thread.state) }
                Button(action: close) { Image(systemName: "xmark").font(.system(size: 12, weight: .semibold)) }
                    .buttonStyle(.plain).pointerStyle(.link).foregroundStyle(PardnerColor.muted)
                    .accessibilityLabel("Close the thread")
            }
            .padding(.horizontal, PardnerMetrics.gap * 2).frame(height: 52)
            Divider().overlay(PardnerColor.line)
            ScrollView {
                VStack(alignment: .leading, spacing: PardnerMetrics.gap * 2) {
                    if let root = thread.root { MessageRow(model: model, icons: icons, message: root, queued: queued.contains(root.ref)) }
                    ForEach(Array(thread.items.enumerated()), id: \.offset) { _, item in
                        switch item {
                        case .message(let m): entry(m, queued: queued)
                        case .answer(let a): AnswerRow(model: model, icons: icons, answer: a)
                        }
                    }
                    if let composer { PendingRows(model: composer) }
                }
                .padding(PardnerMetrics.gap * 2)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let composer {
                Divider().overlay(PardnerColor.line)
                ComposerView(model: composer)
            }
        }
        .background(PardnerColor.panel)
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
            MessageRow(model: model, icons: icons, message: m, queued: queued.contains(m.ref))
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
        HStack(alignment: .top, spacing: PardnerMetrics.gap * 1.5) {
            Avatar(name: name, isBot: true, icon: icons[answer.ref.device])
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: PardnerMetrics.gap) {
                    Text(name).font(PardnerFont.ui(size: 14, weight: .semibold))
                    if !answer.done {
                        Text("Writing…").font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                    }
                }
                Text(verbatim: answer.markdown).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
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
            if state != .idle { StopButton(composer: composer) }
            Menu {
                Button("Bypass on") { composer.command("/bypass on") }
                Button("Bypass off") { composer.command("/bypass off") }
                Divider()
                Button("Plan mode on") { composer.command("/plan on") }
                Button("Plan mode off") { composer.command("/plan off") }
            } label: { Image(systemName: "ellipsis").frame(width: 22, height: 22) }
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
