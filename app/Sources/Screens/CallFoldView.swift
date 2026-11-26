// A run of finished calls drawn as one muted line (#27): a check, the words the agent's terminal folds them by, and a chevron. A click opens the
// calls as their own rows under it, indented; a second click closes them. The words come from the module through the daemon (`LineFold`): the
// app knows no tool.
import Conversation
import DesignSystem
import SwiftUI

/// What the fold row looks like, apart from its view so that the values can be read without drawing it.
enum FoldLook {
    /// Inter at this size, as the mock the owner approved draws it: the size of every tool row.
    static let fontSize = PardnerFont.toolSize
    static let mark = "\u{2713}"
    static let chevron = "chevron.right"
    /// The chevron turns a quarter while the calls are open.
    static func rotation(open: Bool) -> Double { open ? 90 : 0 }
    /// What the open calls are indented by under the row, the width of the guide line along them and the room between the line and them.
    static let listIndent = PardnerMetrics.toolIndent
    static let listPadding: CGFloat = 10
    static let ruleWidth = PardnerMetrics.toolGuide
}

struct FoldRow<Calls: View>: View {
    let fold: CallFold
    let isOpen: Bool
    let toggle: () -> Void
    /// What the row is indented by to line up with a bot's text.
    var indent: CGFloat = MessageRow.Mark.thread.size + MessageRow.Mark.thread.gap
    /// One of the folded calls as its own row, drawn when the fold is open.
    @ViewBuilder let calls: (WorkLine) -> Calls
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: PardnerMetrics.callGap) {
            Button(action: toggle) {
                HStack(spacing: 6) {
                    Text(verbatim: FoldLook.mark).foregroundStyle(PardnerColor.okText).accessibilityHidden(true)
                    Text(verbatim: fold.words)
                    Image(systemName: FoldLook.chevron).font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(FoldLook.rotation(open: isOpen))).accessibilityHidden(true)
                }
                .font(PardnerFont.ui(size: FoldLook.fontSize, weight: .regular)).foregroundStyle(PardnerColor.muted)
                .padding(.leading, 2).padding(.trailing, 6).padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: 6).fill(hovering ? PardnerColor.hover : Color.clear))
                .contentShape(Rectangle())
            }
            .buttonStyle(.clickable)
            .onHover { hovering = $0 }
            .accessibilityLabel(fold.words).accessibilityValue(isOpen ? "Open" : "Closed")
            if isOpen {
                VStack(alignment: .leading, spacing: PardnerMetrics.callGap) {
                    ForEach(fold.lines, id: \.ref) { calls($0) }
                }
                .padding(.leading, FoldLook.listPadding)
                .overlay(alignment: .leading) { Rectangle().fill(PardnerColor.line).frame(width: FoldLook.ruleWidth) }
                .padding(.leading, FoldLook.listIndent)
            }
        }
        .padding(.leading, indent)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
