// The screens of the app before it is paired (device pairing design 3.5, 3.10, 4.1): one view per state, over `PairingModel`.
// Colours, radii and the gap are the design system's tokens; every control carries an accessibility label.
import DesignSystem
import Relay
import SwiftUI

/// The pairing screens until the device is paired, then `paired`'s content (the main window).
public struct PairingRoot<Paired: View>: View {
    let model: PairingModel
    let paired: Paired

    public init(model: PairingModel, @ViewBuilder paired: () -> Paired) { (self.model, self.paired) = (model, paired()) }

    public var body: some View {
        if case .paired = model.phase {
            paired
        } else {
            PairingScreen(model: model)
        }
    }
}

/// The screen of the controller's phase; the recovery sheet opens over it.
public struct PairingScreen: View {
    let model: PairingModel

    public init(model: PairingModel) { self.model = model }

    public var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(PardnerColor.bg)
            .font(PardnerFont.ui(size: 14, weight: .regular))
            .foregroundStyle(PardnerColor.text)
            .sheet(item: Binding(get: { model.sheet.flatMap { $0.isClosed ? nil : $0 } }, set: { if $0 == nil { model.sheet?.close() } })) { sheet in
                RecoverySheetView(model: sheet).interactiveDismissDisabled()
            }
    }

    @ViewBuilder private var content: some View {
        let text = model.message ?? ""
        switch model.screen {
        case .starting:
            Page(title: "Pardner") { Text("Starting…").foregroundStyle(PardnerColor.muted) }
        case .first:
            if case .unpaired(let note) = model.phase { FirstScreen(model: model, note: note) }
        case .form:
            RelayForm(model: model)
        case .settingUp:
            SettingUp(model: model)
        case .enrolling:
            if case .enrolling(let asksSecret) = model.phase { Enrolling(model: model, asksSecret: asksSecret) }
        case .paired:
            EmptyView()
        case .removed:
            notice("This Mac was removed from your devices",
                   "Another device of yours removed this Mac. Nothing on it has been erased yet. Pair again erases this Mac's device keys and starts from the first screen.")
        case .keysMissing:
            notice("This Mac's keys are missing",
                   "Pardner remembers a pairing, but the device keys that belong to it are gone, as after a restore from a backup. Pair again makes this Mac a new device; remove the old entry from another device of yours.")
        case .putBack:
            notice("Your relay was put back", text)
        case .linkFaulted:
            notice("The relay connection faulted", text)
        case .malformedStore:
            notice("The pairing file cannot be read", text)
        case .newerStore:
            notice("Update Pardner", text)
        case .needsNewPairing:
            notice("This Mac needs a new pairing", text)
        case .failed:
            notice("Something went wrong", text)
        }
    }

    /// A notice with the action the model offers for the phase, if any.
    private func notice(_ title: String, _ text: String) -> Notice {
        switch model.exit {
        case .pairAgain?: Notice(title: title, text: text, action: ("Pair again", model.pairAgain))
        case .retry?: Notice(title: title, text: text, action: ("Retry", model.retry))
        case nil: Notice(title: title, text: text, action: nil)
        }
    }
}

/// The page every screen shares: the mark and the name over a column no wider than 480 points.
struct Page<Content: View>: View {
    let title: String
    var showsMark = true
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: PardnerMetrics.gap * 2) {
            if showsMark {
                HStack(spacing: PardnerMetrics.gap) {
                    Logo(size: 32)
                    Text("Pardner").font(PardnerFont.display(size: 18, weight: .bold))
                }
            }
            Text(title).font(PardnerFont.display(size: 24, weight: .bold)).accessibilityAddTraits(.isHeader)
            content
        }
        .frame(maxWidth: 480, alignment: .leading)
        .padding(PardnerMetrics.gap * 4)
    }
}

struct FirstScreen: View {
    let model: PairingModel
    let note: UnpairedNote?

    var body: some View {
        Page(title: "Pardner needs a relay of your own") {
            Text("The relay is a small server you run yourself. It carries your messages, encrypted, between your devices and your bots. Pair this Mac with a new relay to start.")
                .foregroundStyle(PardnerColor.muted)
            if note == .staleSheet {
                Text("The recovery key from the attempt that stopped opens nothing: its secret lived in memory only. Setting up again makes a new key.")
                    .padding(PardnerMetrics.gap * 1.5).frame(maxWidth: .infinity, alignment: .leading)
                    .background(PardnerColor.agentSoft, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
                    .foregroundStyle(PardnerColor.agentText)
            }
            Button("Set up a new relay") { model.showForm = true }
                .buttonStyle(PardnerButton(prominent: true)).accessibilityLabel("Set up a new relay")
        }
    }
}

struct RelayForm: View {
    @Bindable var model: PairingModel

    var body: some View {
        Page(title: "Pair this Mac with your relay", showsMark: false) {
            Field(title: "Relay address", hint: "The address pardner relay serve listens on, as host:port.",
                  error: model.refused == .address ? "Enter host:port, with a port from 1 to 65535. No scheme, no path." : nil) {
                TextField("relay.example.net:7443", text: $model.address).accessibilityLabel("Relay address")
            }
            Field(title: "Relay public key", hint: "pardner relay init prints it: 130 hexadecimal characters.",
                  error: model.refused == .relayKey ? "The relay key must be 130 hexadecimal characters that make a P-256 public key." : nil) {
                TextField("04…", text: $model.relayKey).font(PardnerFont.mono(size: 12, weight: .regular)).accessibilityLabel("Relay public key")
            }
            Field(title: "Enrolment secret", hint: "pardner relay init prints it too: 64 hexadecimal characters. It is used once and never stored.",
                  error: model.refused == .enrolmentSecret ? "The enrolment secret must be 64 hexadecimal characters." : nil) {
                SecureField("", text: $model.enrolmentSecret).accessibilityLabel("Enrolment secret")
            }
            if let problem = model.problem {
                Text(problem).foregroundStyle(PardnerColor.delText).font(PardnerFont.ui(size: 13, weight: .regular))
            }
            HStack {
                Button("Back") { model.back() }
                    .buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Back to the first screen")
                Button("Set up") { model.setUp() }
                    .buttonStyle(PardnerButton(prominent: true)).disabled(model.working)
                    .keyboardShortcut(.defaultAction).accessibilityLabel("Set up with this relay")
            }
        }
        .onChange(of: model.address) { model.edited() }
        .onChange(of: model.relayKey) { model.edited() }
        // Not when the model itself empties the field after the controller has had the secret: that would take back the error it just set.
        .onChange(of: model.enrolmentSecret) { if !model.enrolmentSecret.isEmpty { model.edited() } }
    }

    private struct Field<Control: View>: View {
        let title: String, hint: String, error: String?
        @ViewBuilder let control: Control

        var body: some View {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(PardnerFont.ui(size: 13, weight: .semibold))
                control.textFieldStyle(.plain)
                    .padding(.horizontal, PardnerMetrics.gap * 1.25).padding(.vertical, 7)
                    .background(PardnerColor.surface, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
                    .overlay(RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius).stroke(error == nil ? PardnerColor.line : PardnerColor.delText))
                if let error {
                    Text(error).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.delText)
                } else {
                    Text(hint).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                }
            }
        }
    }
}

/// Keys, the recovery key and entry 0 are being made, then the sheet waits for the person.
struct SettingUp: View {
    let model: PairingModel

    var body: some View {
        Page(title: "Setting up") {
            Text("Making this Mac's keys and your recovery key. The recovery sheet opens when they are ready.").foregroundStyle(PardnerColor.muted)
            Button("Cancel") { model.cancel() }
                .buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Cancel the setup")
        }
    }
}

struct Enrolling: View {
    @Bindable var model: PairingModel
    let asksSecret: Bool

    var body: some View {
        Page(title: asksSecret ? "The relay did not take the enrolment secret" : "Waiting for your relay") {
            if asksSecret {
                Text("Either the secret was mistyped or the relay already has an owner. Type the enrolment secret again; your keys and recovery key stay as they are.")
                    .foregroundStyle(PardnerColor.muted)
                SecureField("Enrolment secret, 64 hexadecimal characters", text: $model.retypedSecret)
                    .textFieldStyle(.plain).accessibilityLabel("Enrolment secret")
                    .padding(.horizontal, PardnerMetrics.gap * 1.25).padding(.vertical, 7)
                    .background(PardnerColor.surface, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
                    .overlay(RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius).stroke(model.retypeProblem == nil ? PardnerColor.line : PardnerColor.delText))
                if let problem = model.retypeProblem {
                    Text(problem).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.delText)
                }
                Button("Send the secret") { model.retype() }
                    .buttonStyle(PardnerButton(prominent: true)).disabled(model.working)
                    .keyboardShortcut(.defaultAction).accessibilityLabel("Send the enrolment secret again")
            } else {
                Text("Connecting to your relay. This Mac sends your first entry on every connection until the relay places it.")
                    .foregroundStyle(PardnerColor.muted)
            }
            cancelPart
        }
        .onChange(of: model.retypedSecret) { if !model.retypedSecret.isEmpty { model.retypeEdited() } }
    }

    @ViewBuilder private var cancelPart: some View {
        switch model.cancelNote {
        case nil:
            cancelButton
        case .waitForAnswer?:
            Text("The relay can be reached and has not answered yet. You can cancel once it answers.")
                .foregroundStyle(PardnerColor.muted).font(PardnerFont.ui(size: 13, weight: .regular))
            cancelButton
        case .confirmUnreachable?:
            VStack(alignment: .leading, spacing: PardnerMetrics.gap) {
                Text("The relay does not answer.").font(PardnerFont.ui(size: 14, weight: .semibold))
                Text(PairingController.unreachableWarning).foregroundStyle(PardnerColor.agentText)
                HStack {
                    Button("Keep waiting") { model.keepWaiting() }
                        .buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Keep waiting for the relay")
                    Button("Erase and cancel") { model.cancel(confirmedUnreachable: true) }
                        .buttonStyle(PardnerButton(prominent: true)).accessibilityLabel("Erase this setup and cancel")
                }
            }
            .padding(PardnerMetrics.gap * 1.5)
            .background(PardnerColor.agentSoft, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
        case .failed(let message)?:
            Text("The setup could not be erased: \(message)").foregroundStyle(PardnerColor.delText).font(PardnerFont.ui(size: 13, weight: .regular))
            cancelButton
        }
    }

    private var cancelButton: some View {
        Button("Cancel") { model.cancel() }
            .buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Cancel the setup")
    }
}

/// A state with a message and, where the controller allows one, a single action.
struct Notice: View {
    let title: String
    let text: String
    let action: (label: String, run: () -> Void)?

    var body: some View {
        Page(title: title) {
            Text(text).foregroundStyle(PardnerColor.muted)
            if let action {
                Button(action.label, action: action.run)
                    .buttonStyle(PardnerButton(prominent: true)).accessibilityLabel(action.label)
            }
        }
    }
}
