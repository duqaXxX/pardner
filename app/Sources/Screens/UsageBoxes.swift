// The usage boxes at the foot of the sidebar (visual pass, #174): one per account, as the reference draws its Usage section.
import Conversation
import DesignSystem
import SwiftUI

struct UsageBoxes: View {
    let model: ReadingModel
    let bots: [(id: Data, name: String, profile: BotProfile?)]
    /// The clock the boxes count from; nil is the real one.
    var now: Date?

    var body: some View {
        // A timeline of its own redraws the boxes alone each minute, so a reset counts down. The boxes are worked out in it: each
        // window walks every thread, once a minute and again whenever this view is drawn again, which a streamed message does (`ReadingModel` is a value).
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let date = now ?? context.date
            let boxes = UsageBox.boxes(bots: bots, windows: model.windows, apiBots: model.apiBots)
            ForEach(Array(boxes.enumerated()), id: \.offset) { _, box in
                VStack(alignment: .leading, spacing: 6) {
                    // The plan on a line of its own, under the account, so a long email keeps the box's whole width.
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: box.title).font(PardnerFont.ui(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                        Text(verbatim: box.plan).foregroundStyle(PardnerColor.sideMuted).lineLimit(1)
                    }
                    ForEach(box.rows(now: date), id: \.label) { row in
                        HStack {
                            Text(verbatim: row.label)
                            Spacer()
                            if let resets = row.resets { Text(verbatim: resets).foregroundStyle(PardnerColor.sideMuted) }
                        }
                        Bar(fraction: row.percent / 100, fill: PardnerColor.sideBrand).accessibilityElement().accessibilityLabel("\(Int(row.percent.rounded())) percent used")
                    }
                }
                .font(PardnerFont.secondary).padding(.horizontal, 12).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
                .background(PardnerColor.sideSurface, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(PardnerColor.sideLine))
                .accessibilityElement(children: .contain).accessibilityLabel("Usage")
            }
        }
    }
}

/// A 6 point bar on `raised`, filled to `fraction` (0 to 1, clamped).
struct Bar: View {
    let fraction: Double
    let fill: Color

    var body: some View {
        RoundedRectangle(cornerRadius: 3).fill(PardnerColor.sideRaised).frame(height: 6)
            .overlay(alignment: .leading) {
                GeometryReader { geometry in RoundedRectangle(cornerRadius: 3).fill(fill).frame(width: geometry.size.width * min(max(fraction, 0), 1)) }
            }
    }
}
