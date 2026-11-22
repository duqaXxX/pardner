// The Devices sheet (device pairing design 3.1, 3.4, 3.6, 3.9): the list of devices, the form that adds one and the confirmation that
// removes some, as three pages of one sheet over the main window. Colours, radii and the gap are the design system's tokens; every
// control carries an accessibility label.
import AppKit
import DesignSystem
import Relay
import SwiftUI

enum Clipboard {
    @MainActor static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

public struct DevicesSheet: View {
    @Bindable var model: DevicesModel
    /// Renames this Mac (names design 4.3); nil where the window has no pairing.
    let renameThisMac: (() -> Void)?

    public init(model: DevicesModel, renameThisMac: (() -> Void)? = nil) { (self.model, self.renameThisMac) = (model, renameThisMac) }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(PardnerColor.line)
            ScrollView {
                VStack(alignment: .leading, spacing: PardnerMetrics.gap * 2) {
                    switch model.page {
                    case .list: DeviceList(model: model, rename: renameThisMac)
                    case .add: AddDevice(model: model)
                    case .remove: RemoveDevices(model: model)
                    }
                }
                .padding(PardnerMetrics.gap * 2.5).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(width: 600, height: 640)
        .background(PardnerColor.bg)
        .foregroundStyle(PardnerColor.text)
        .font(PardnerFont.ui(size: 14, weight: .regular))
    }

    private var header: some View {
        HStack {
            Text(title).font(PardnerFont.display(size: 20, weight: .bold)).accessibilityAddTraits(.isHeader)
            Spacer()
            if model.page == .list {
                Button("Done") { model.close() }
                    .keyboardShortcut(.cancelAction).buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Close the devices")
            } else {
                Button("Back") { model.back() }
                    .keyboardShortcut(.cancelAction).buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Back to the devices")
            }
        }
        .padding(.horizontal, PardnerMetrics.gap * 2.5).frame(height: 56)
    }

    private var title: String {
        switch model.page {
        case .list: "Devices"
        case .add: "Add a device"
        case .remove: "Remove devices"
        }
    }
}

/// A name that came from another device, drawn in a `Text` of its own between its own quotes: the app's words never run into it, and the
/// middle of a long name is cut, never the closing quote (design 3.4). A name that holds quotes of its own cannot end the app's sentence.
struct NameText: View {
    let name: String
    var font = PardnerFont.ui(size: 14, weight: .semibold)

    var body: some View {
        HStack(spacing: 0) {
            Text("\u{201C}").fixedSize()
            Text(name).lineLimit(1).truncationMode(.middle)
            Text("\u{201D}").fixedSize()
        }
        .font(font).accessibilityElement(children: .ignore).accessibilityLabel(DevicesModel.quoted(name))
    }
}

/// One device: its name or kind, "This Mac", its short form, who added it, its position and when this Mac first read the add.
struct DeviceInfo: View {
    let model: DevicesModel
    let row: DeviceRow

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: PardnerMetrics.gap) {
                if let label = row.label {
                    NameText(name: label)
                } else {
                    Text(DevicesModel.kindName(row.kind)).font(PardnerFont.ui(size: 14, weight: .semibold))
                }
                if row.isThisMac { Pill(text: "This Mac", ground: PardnerColor.brandSoft, ink: PardnerColor.brandText) }
                if row.label != nil { Pill(text: DevicesModel.kindName(row.kind), ground: PardnerColor.raised, ink: PardnerColor.muted) }
                if row.addedWhileRemoving { Pill(text: "added while you were removing", ground: PardnerColor.agentSoft, ink: PardnerColor.agentText) }
            }
            Text(row.shortForm).font(PardnerFont.mono(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted).textSelection(.enabled)
            HStack(spacing: 0) {
                switch model.adder(row) {
                case .firstDevice?: Text("the first device, ")
                case .removedDevice?: Text("added by a removed device, ")
                case .unknown?: Text("added by a device, ")
                case .shortForm(let short)?: Text("added by \(short), ")
                case .label(let name)?:
                    Text("added by ")
                    NameText(name: name, font: PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.text)
                    Text(", ")
                case nil: EmptyView()
                }
                Text("position \(row.position)")
            }
            .font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
            if let seen = row.seenAt {
                Text("seen by this Mac on \(seen.formatted(date: .abbreviated, time: .shortened))")
                    .font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
            }
        }
    }
}

struct Pill: View {
    let text: String
    let ground: Color
    let ink: Color

    var body: some View {
        Text(text).font(PardnerFont.ui(size: 11, weight: .medium)).foregroundStyle(ink)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(ground, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
    }
}

/// A line the screen says on its own account: a card in `agent-soft` with `agent-text`, as the pairing screens' notes (P5). A name, when
/// there is one, sits between two Texts of the app's and is drawn apart from them.
struct Note: View {
    let lead: String
    var name: String?
    var rest: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(lead)
            if let name { NameText(name: name).foregroundStyle(PardnerColor.text) }
            if let rest { Text(rest) }
        }
        .foregroundStyle(PardnerColor.agentText).fixedSize(horizontal: false, vertical: true)
            .padding(PardnerMetrics.gap * 1.5).frame(maxWidth: .infinity, alignment: .leading)
            .background(PardnerColor.agentSoft, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
    }
}

struct DeviceList: View {
    let model: DevicesModel
    var rename: (() -> Void)?

    var body: some View {
        if let notice = model.state.notice {
            VStack(alignment: .leading, spacing: 4) {
                Text(notice.headline)
                if case .label(let name) = notice.subject { NameText(name: name).foregroundStyle(PardnerColor.text) } else if let words = notice.subjectWords { Text(words) }
                if let detail = notice.detail { Text(detail) }
            }
            .foregroundStyle(PardnerColor.delText).font(PardnerFont.ui(size: 13, weight: .regular))
        }
        if let removing = model.removingLine {
            Note(lead: "\(removing). Pardner keeps going until none of the chosen devices is active, also after a restart.")
        }
        if model.isAdding {
            Note(lead: model.addingName == nil ? "Adding a device" : "Adding this device", name: model.addingName, rest: "Pardner waits until the log shows it.")
        }
        if !model.ready {
            Text("Pardner is still reading your devices.").foregroundStyle(PardnerColor.muted)
        }
        if model.state.seenTogether {
            Text("This Mac read part of the log in one go, so some of the times below are one moment, not the moments the devices were added.")
                .font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted).fixedSize(horizontal: false, vertical: true)
        }
        ForEach(model.rows) { row in
            HStack(alignment: .top) {
                DeviceInfo(model: model, row: row)
                Spacer(minLength: PardnerMetrics.gap)
                if !row.isThisMac {
                    Button("Remove") { model.askRemoval(clicked: row.id) }
                        .buttonStyle(PardnerButton(prominent: false)).disabled(!model.canRemove(row))
                        .accessibilityLabel("Remove \(DevicesModel.title(row))")
                } else if let rename {
                    Button("Rename…") { rename() }
                        .buttonStyle(PardnerButton(prominent: false)).disabled(!model.ready).accessibilityLabel("Rename this Mac")
                }
            }
            .padding(PardnerMetrics.gap * 1.5).card()
        }
        Button("Add a device") { model.showAdd() }
            .buttonStyle(PardnerButton(prominent: true)).disabled(!model.canAdd).accessibilityLabel("Add a device")
    }
}

struct AddDevice: View {
    @Bindable var model: DevicesModel

    var body: some View {
        Text("On the new device, give these three values. pardner setup asks for them as RELAY_ADDRESS, RELAY_KEY and RELAY_OWNER; a Mac asks for them once you choose I already use Pardner on another device on its first screen.")
            .foregroundStyle(PardnerColor.muted).fixedSize(horizontal: false, vertical: true)
        if let handoff = model.handoff {
            Value(title: "Relay address", variable: "RELAY_ADDRESS", value: handoff.relayAddress)
            Value(title: "Relay public key", variable: "RELAY_KEY", value: handoff.relayKey)
            Value(title: "Person id", variable: "RELAY_OWNER", value: handoff.person)
        }
        Field(title: "Pairing string", hint: "The new device shows it when its values are set. Paste it here.", error: model.refusal.flatMap(Self.fieldError)) {
            TextField("", text: $model.pasted).font(PardnerFont.mono(size: 12, weight: .regular)).accessibilityLabel("Pairing string")
        }
        .onChange(of: model.pasted) { model.edited() }
        if let refusal = model.refusal, Self.fieldError(refusal) == nil {
            Text(refusal.message).foregroundStyle(PardnerColor.delText).font(PardnerFont.ui(size: 13, weight: .regular))
        }
        if let candidate = model.candidate {
            Candidate(candidate: candidate)
            HStack {
                Button("Cancel") { model.back() }.buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Cancel adding the device")
                Button("Add") { model.confirmAdd() }
                    .buttonStyle(PardnerButton(prominent: true)).disabled(model.working).keyboardShortcut(.defaultAction).accessibilityLabel("Add this device")
            }
        } else {
            Button("Check") { model.check() }
                .buttonStyle(PardnerButton(prominent: true)).disabled(model.working || model.pasted.isEmpty)
                .keyboardShortcut(.defaultAction).accessibilityLabel("Check the pairing string")
        }
    }

    /// The refusals about the pasted text itself show under its field; the others (not ready, an entry pending) say something else.
    static func fieldError(_ refusal: DeviceRefusal) -> String? {
        switch refusal {
        case .notAPairingString, .badName, .otherPerson, .alreadyAdded: refusal.message
        default: nil
        }
    }

    private struct Value: View {
        let title: String, variable: String, value: String

        var body: some View {
            VStack(alignment: .leading, spacing: 4) {
                Text("\(title) (\(variable))").font(PardnerFont.ui(size: 13, weight: .semibold))
                HStack(alignment: .top) {
                    Text(value).font(PardnerFont.mono(size: 11, weight: .regular)).textSelection(.enabled)
                        .lineLimit(3).truncationMode(.middle).frame(maxWidth: .infinity, alignment: .leading)
                    Button("Copy") { Clipboard.copy(value) }
                        .buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Copy the \(title.lowercased())")
                }
                .padding(PardnerMetrics.gap * 1.25).card()
            }
        }
    }

    /// What the string says, for the person to match against the new device's screen.
    private struct Candidate: View {
        let candidate: DeviceCandidate

        var body: some View {
            VStack(alignment: .leading, spacing: PardnerMetrics.gap) {
                HStack(spacing: PardnerMetrics.gap) {
                    Text(DevicesModel.kindName(candidate.kind)).font(PardnerFont.ui(size: 11, weight: .semibold)).foregroundStyle(PardnerColor.muted)
                    NameText(name: candidate.name, font: PardnerFont.ui(size: 16, weight: .semibold))
                }
                Text(candidate.shortForm).font(PardnerFont.mono(size: 18, weight: .medium)).textSelection(.enabled)
                Text("Check that the device shows this name and this short form").font(PardnerFont.ui(size: 13, weight: .semibold))
            }
            .padding(PardnerMetrics.gap * 1.5).frame(maxWidth: .infinity, alignment: .leading).card()
        }
    }
}

struct RemoveDevices: View {
    let model: DevicesModel

    var body: some View {
        Text("Choose the devices you do not recognise. The one you clicked is chosen. Pardner removes it first, then the others, newest first.")
            .foregroundStyle(PardnerColor.muted).fixedSize(horizontal: false, vertical: true)
        ForEach(model.choices) { choice in
            Toggle(isOn: Binding(get: { model.chosen.contains(choice.id) }, set: { _ in model.toggle(choice.id) })) {
                VStack(alignment: .leading, spacing: 4) {
                    DeviceInfo(model: model, row: choice.row)
                    if choice.row.onlyHolderEpochs > 0 {
                        Text("Only this device holds the keys to some earlier messages. If you remove it, only your recovery key will open them.")
                            .font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.agentText)
                    }
                }
            }
            .toggleStyle(.checkbox).accessibilityLabel("Remove \(DevicesModel.title(choice.row))")
            .padding(PardnerMetrics.gap * 1.5).frame(maxWidth: .infinity, alignment: .leading).card()
        }
        if !model.onlyHolders.isEmpty {
            Note(lead: "\(model.onlyHolders.count == 1 ? "A device" : "\(model.onlyHolders.count) devices") you chose alone \(model.onlyHolders.count == 1 ? "holds" : "hold") the keys to some earlier messages. Only your recovery key will open them after the removal. The removal goes on either way.")
        }
        if let problem = model.removalProblem {
            Text(problem.message).foregroundStyle(PardnerColor.delText).font(PardnerFont.ui(size: 13, weight: .regular))
        }
        HStack {
            Button("Cancel") { model.back() }.buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Cancel the removal")
            Button(model.chosen.count > 1 ? "Remove \(model.chosen.count) devices" : "Remove") { model.confirmRemoval() }
                .buttonStyle(PardnerButton(prominent: true)).disabled(!model.canConfirmRemoval).keyboardShortcut(.defaultAction)
                .accessibilityLabel("Remove the chosen devices")
        }
    }
}
