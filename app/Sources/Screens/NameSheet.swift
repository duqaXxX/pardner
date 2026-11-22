// The sheet that sets a name (names design 4.1 to 4.3): a channel's, the person's or this Mac's. One field, the answer of the last try, Save and Cancel.
import DesignSystem
import SwiftUI

public struct NameSheet: View {
    @Bindable var model: ChannelsModel
    /// The names the person's channels show, for the warning that two share one.
    let channelNames: [Data: String]

    public init(model: ChannelsModel, channelNames: [Data: String] = [:]) { (self.model, self.channelNames) = (model, channelNames) }

    private var target: ChannelsModel.NameTarget? { if case .rename(let target)? = model.sheet { target } else { nil } }

    private var title: String {
        switch target {
        case .channel?: "Channel name"
        case .person?: "Your name"
        case .device?, nil: "This Mac's name"
        }
    }

    private var hint: String {
        switch target {
        case .channel?: "Lowercase letters, digits, - and _. A space becomes a -."
        case .person?: "The name your other devices show for you."
        case .device?, nil: "The name your other devices show for this Mac."
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: PardnerMetrics.gap * 2) {
            Text(title).font(PardnerFont.display(size: 20, weight: .bold)).accessibilityAddTraits(.isHeader)
            Field(title: "Name", hint: hint, error: nil) {
                TextField("", text: $model.nameText).accessibilityLabel(title)
            }
            .onChange(of: model.nameText) { if case .channel? = target { model.channelNameEdited() } else { model.edited() } }
            if case .channel? = target { NameLines(note: model.nameNote, warning: model.duplicateWarning(channels: channelNames)) }
            if let problem = model.problem {
                Text(problem).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.delText).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Cancel") { model.close() }
                    .keyboardShortcut(.cancelAction).buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Cancel")
                Button("Save") { model.saveName() }
                    .buttonStyle(PardnerButton(prominent: true)).disabled(!model.canSaveName)
                    .keyboardShortcut(.defaultAction).accessibilityLabel("Save the name")
            }
        }
        .padding(PardnerMetrics.gap * 2.5)
        .frame(width: 420)
        .background(PardnerColor.bg)
        .foregroundStyle(PardnerColor.text)
        .font(PardnerFont.ui(size: 14, weight: .regular))
    }
}

/// What the channel-name field left out, and the warning that another channel has the name: small lines under the field.
struct NameLines: View {
    let note: String?
    let warning: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let note { Text(note).foregroundStyle(PardnerColor.muted) }
            if let warning { Text(warning).foregroundStyle(PardnerColor.agentText) }
        }
        .font(PardnerFont.ui(size: 12, weight: .regular)).fixedSize(horizontal: false, vertical: true)
    }
}
