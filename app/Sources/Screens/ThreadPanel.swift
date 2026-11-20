// The thread panel on the right: the opening message, then the thread's entries in order. An answer shows as
// it is written; a question or an approval shows its title and where it stands (its controls are screen 3.5's).
import Conversation
import DesignSystem
import AppKit
import SwiftUI

struct ThreadPanel: View {
    let model: ReadingModel
    let icons: [Data: NSImage]
    let thread: MessageThread
    let close: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: PardnerMetrics.gap) {
                Text("Thread").font(PardnerFont.ui(size: 15, weight: .semibold))
                if let bot = thread.bot {
                    Text("\(Naming.sender(bot, in: model)) · \(thread.state.label)")
                        .font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.muted)
                }
                Spacer()
                Button(action: close) { Image(systemName: "xmark").font(.system(size: 12, weight: .semibold)) }
                    .buttonStyle(.plain).foregroundStyle(PardnerColor.muted)
                    .accessibilityLabel("Close the thread")
            }
            .padding(.horizontal, PardnerMetrics.gap * 2).frame(height: 52)
            Divider().overlay(PardnerColor.line)
            ScrollView {
                VStack(alignment: .leading, spacing: PardnerMetrics.gap * 2) {
                    if let root = thread.root { MessageRow(model: model, icons: icons, message: root) }
                    ForEach(Array(thread.items.enumerated()), id: \.offset) { _, item in
                        switch item {
                        case .message(let m): entry(m)
                        case .answer(let a): AnswerRow(model: model, icons: icons, answer: a)
                        }
                    }
                }
                .padding(PardnerMetrics.gap * 2)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(PardnerColor.panel)
    }

    @ViewBuilder
    private func entry(_ m: Message) -> some View {
        if case .request(let title, _, _) = m.body {
            RequestRow(title: title, status: thread.requests[m.ref] ?? .open)
        } else {
            MessageRow(model: model, icons: icons, message: m)
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

/// A question or an approval, with where it stands.
struct RequestRow: View {
    let title: String
    let status: RequestStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: title).font(PardnerFont.ui(size: 14, weight: .semibold))
            Text(words).font(PardnerFont.ui(size: 12, weight: .medium))
                .foregroundStyle(status == .open ? PardnerColor.agentText : PardnerColor.muted)
        }
        .padding(PardnerMetrics.gap * 1.5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(status == .open ? PardnerColor.agentSoft : PardnerColor.surface, in: RoundedRectangle(cornerRadius: PardnerMetrics.containerRadius))
        .overlay(RoundedRectangle(cornerRadius: PardnerMetrics.containerRadius).stroke(status == .open ? PardnerColor.agent : PardnerColor.line))
    }

    private var words: String {
        switch status {
        case .open: "Waiting for you"
        case .replied, .answered: "Answered"
        case .withdrawn: "Withdrawn"
        case .rewritten(let markdown): markdown
        }
    }
}
