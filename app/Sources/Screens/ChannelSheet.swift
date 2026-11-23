// The form that makes a channel (New channel) or binds one to a folder (Bind to a folder…): a folder, the bot when the person has more
// than one, and the answer of the last try (new channel design 5). Colours, radii and the gap are the design system's tokens.
import DesignSystem
import SwiftUI

public struct ChannelSheet: View {
    @Bindable var model: ChannelsModel
    /// The bots' names from the reading model's profiles.
    let names: [Data: String]
    /// The names the person's channels show, for the warning that two share one.
    let channelNames: [Data: String]

    public init(model: ChannelsModel, names: [Data: String], channelNames: [Data: String] = [:]) { (self.model, self.names, self.channelNames) = (model, names, channelNames) }

    private var isBind: Bool { if case .bind = model.sheet { true } else { false } }

    public var body: some View {
        VStack(alignment: .leading, spacing: PardnerMetrics.gap * 2) {
            Text(isBind ? "Bind to a folder" : "New channel")
                .font(PardnerFont.display(size: 20, weight: .bold)).accessibilityAddTraits(.isHeader)
            Field(title: "Folder", hint: isBind ? "Pardner sends /bind with this folder to the bot." : "Pardner sends /bind with this folder in the new channel.", error: nil) {
                TextField("", text: $model.folder, prompt: Text("A folder under the bot's allowed root, as /bind takes it"))
                    .font(PardnerFont.mono(size: 12, weight: .regular)).accessibilityLabel("Folder")
            }
            .onChange(of: model.folder) { model.edited() }
            if !isBind {
                Field(title: "Channel name", hint: "Lowercase letters, digits, - and _. It follows the folder until you type one; leave it empty for none.", error: nil) {
                    TextField("", text: $model.nameText).accessibilityLabel("Channel name")
                }
                .onChange(of: model.nameText) { model.channelNameEdited() }
                NameLines(note: model.nameNote, warning: model.duplicateWarning(channels: channelNames))
            }
            if model.showsBotPicker(names: names) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Bot").font(PardnerFont.ui(size: 13, weight: .semibold))
                    Picker("Bot", selection: Binding(get: { model.resolvedBot(names: names) }, set: { model.pick($0) })) {
                        ForEach(model.choices(names: names)) { Text(verbatim: $0.shown).tag(Optional($0.id)) }
                    }
                    .labelsHidden().accessibilityLabel("Bot")
                }
            }
            if let problem = model.problem {
                Text(problem).font(PardnerFont.ui(size: 13, weight: .regular)).foregroundStyle(PardnerColor.delText).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button(isBind ? "Bind" : "Create") { model.submit(names: names) }
                    .buttonStyle(PardnerButton(prominent: true)).disabled(!model.canSubmit(names: names))
                    .keyboardShortcut(.defaultAction).accessibilityLabel(isBind ? "Bind the channel to the folder" : "Create the channel")
            }
        }
        .padding(PardnerMetrics.gap * 2.5)
        .frame(width: 480)
        .background(PardnerColor.bg)
        .foregroundStyle(PardnerColor.text)
        .font(PardnerFont.ui(size: 14, weight: .regular))
    }
}
