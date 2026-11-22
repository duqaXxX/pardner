// The screens of a recovery with the recovery key (recovery design 2.1 to 2.7): the form, the key field, the two questions, the waits, the list of
// earlier keys that opening the past asks for, done and the refusals. Words come from `RecoveryScreenWords`; every action is one the controller takes.
import AppKit
import DesignSystem
import Relay
import SwiftUI

/// The three public values of the recovery key, pasted or typed.
struct RecoveryForm: View {
    @Bindable var model: PairingModel

    var body: some View {
        Page(title: RecoveryScreenWords.choice, showsMark: false) {
            Text(RecoveryScreenWords.formHint).foregroundStyle(PardnerColor.muted)
            if model.formErasesOldKeys { Text(RecoveryScreenWords.eraseOnContinue).foregroundStyle(PardnerColor.agentText) }
            Button("Paste") { model.paste(NSPasteboard.general.string(forType: .string) ?? "") }
                .buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Paste the public part of the recovery key")
            Field(title: "Person id", hint: "64 hexadecimal characters.", error: model.refused == .person ? "The person id is 64 hexadecimal characters." : nil) {
                TextField("", text: $model.recoverPerson).font(PardnerFont.mono(size: 12, weight: .regular)).accessibilityLabel("Person id")
            }
            Field(title: "Relay address", hint: "As host:port.", error: model.refused == .address ? "Enter host:port, with a port from 1 to 65535. No scheme, no path." : nil) {
                TextField("relay.example.net:7443", text: $model.recoverAddress).accessibilityLabel("Relay address")
            }
            Field(title: "Relay public key", hint: "130 hexadecimal characters.",
                  error: model.refused == .relayKey ? "The relay key must be 130 hexadecimal characters that make a P-256 public key." : nil) {
                TextField("04…", text: $model.recoverKey).font(PardnerFont.mono(size: 12, weight: .regular)).accessibilityLabel("Relay public key")
            }
            if let problem = model.problem { Text(problem).foregroundStyle(PardnerColor.delText).font(PardnerFont.ui(size: 13, weight: .regular)) }
            HStack {
                Button("Back") { model.back() }.buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Back")
                Button("Continue") { model.recover() }.buttonStyle(PardnerButton(prominent: true)).disabled(model.working)
                    .keyboardShortcut(.defaultAction).accessibilityLabel("Continue with these values")
            }
        }
        .onChange(of: model.recoverPerson) { model.edited() }
        .onChange(of: model.recoverAddress) { model.edited() }
        .onChange(of: model.recoverKey) { model.edited() }
    }
}

/// The screen of each step of a recovery.
struct RecoveryFlow: View {
    let model: PairingModel

    var body: some View {
        switch model.recoveryStep {
        case .starting?, nil: wait(RecoveryScreenWords.preparingTitle, RecoveryScreenWords.preparing, cancel: false)
        case .typeKey?: if let entry = model.entry { KeyEntry(model: model, entry: entry) }
        case .reading?: wait(RecoveryScreenWords.readingTitle, RecoveryScreenWords.reading, cancel: true)
        case .askDevices?: question(RecoveryScreenWords.devicesTitle, nil, [
            (RecoveryScreenWords.devicesNo, RecoveryScreenWords.devicesNoLine, true, { model.answerDevices(someoneElse: false) }),
            (RecoveryScreenWords.devicesYes, RecoveryScreenWords.devicesYesLine, false, { model.answerDevices(someoneElse: true) })])
        case .askNewKey?: question(RecoveryScreenWords.newKeyTitle, RecoveryScreenWords.newKeyLine, [
            (RecoveryScreenWords.makeNewKey, RecoveryScreenWords.makeNewKeyLine, true, { model.answerNewKey(make: true) }),
            (RecoveryScreenWords.keepMyKey, RecoveryScreenWords.keepMyKeyLine, false, { model.answerNewKey(make: false) })])
        case .sending?: Page(title: RecoveryScreenWords.sendingTitle) { text(RecoveryScreenWords.sending); keep }
        case .placed?: Page(title: RecoveryScreenWords.placedTitle) { text(RecoveryScreenWords.placed); keep }
        case .opening(let progress)?: Opening(model: model, progress: progress)
        case .done(let done)?: Done(model: model, done: done)
        case .refused(let why)?: Refusal(model: model, why: why)
        }
    }

    private func text(_ line: String) -> some View { Text(line).foregroundStyle(PardnerColor.muted) }
    private var keep: some View { Text(RecoveryScreenWords.keepKeys).font(PardnerFont.ui(size: 13, weight: .semibold)).foregroundStyle(PardnerColor.agentText) }

    private func wait(_ title: String, _ line: String, cancel: Bool) -> some View {
        Page(title: title) {
            text(line)
            if cancel { Button("Cancel") { model.cancel() }.buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Cancel the recovery") }
        }
    }

    /// A question with its answers, each with the line that says what it does; Cancel is the controller's, while nothing is sent.
    private func question(_ title: String, _ line: String?, _ answers: [(String, String, Bool, () -> Void)]) -> some View {
        Page(title: title) {
            if let line { text(line) }
            ForEach(answers.indices, id: \.self) { i in
                FirstScreen.Choice(title: answers[i].0, prominent: answers[i].2, line: answers[i].1, action: answers[i].3)
            }
            if let problem = model.problem { Text(problem).foregroundStyle(PardnerColor.delText).font(PardnerFont.ui(size: 13, weight: .regular)) }
            Button("Cancel") { model.cancel() }.buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Cancel the recovery")
        }
    }
}

/// The recovery key typed into a field that never shows it; a wrong check symbol is refused here.
struct KeyEntry: View {
    let model: PairingModel
    let entry: RecoveryEntryModel

    var body: some View {
        Page(title: model.typingEarlier ? RecoveryScreenWords.typeEarlierTitle : RecoveryScreenWords.typeKeyTitle) {
            Text(RecoveryScreenWords.typeKeyLine).foregroundStyle(PardnerColor.muted)
            KeyCapture(model: entry, label: "Type the recovery key").frame(maxWidth: .infinity, minHeight: 64, maxHeight: 64, alignment: .leading).padding(PardnerMetrics.gap * 1.5).card()
            Text("\(entry.typed) of \(RecoveryEntryModel.symbolCount) characters.").font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
            if entry.checkFailed { Text(RecoveryScreenWords.checkFailed).foregroundStyle(PardnerColor.delText).font(PardnerFont.ui(size: 13, weight: .regular)) }
            HStack {
                Button("Cancel") { entry.decline() }.buttonStyle(PardnerButton(prominent: false)).keyboardShortcut(.cancelAction).accessibilityLabel("Cancel typing the key")
                Button("Use this key") { entry.submit() }.buttonStyle(PardnerButton(prominent: true)).disabled(!entry.reads)
                    .keyboardShortcut(.defaultAction).accessibilityLabel("Use this recovery key")
            }
        }
        .background(WindowGuard())
    }
}

/// The earlier recovery keys that opening the past still asks for, and `I no longer have this key` after a confirmation.
struct Opening: View {
    let model: PairingModel
    let progress: RecoveryProgress

    var body: some View {
        Page(title: RecoveryScreenWords.placedTitle) {
            if progress.refusedKey { Text(RecoveryScreenWords.refusedKey).foregroundStyle(PardnerColor.delText).font(PardnerFont.ui(size: 13, weight: .regular)) }
            if progress.waiting.isEmpty { Text(RecoveryScreenWords.sealing).foregroundStyle(PardnerColor.muted) }
            if progress.asksEarlierKey { Text(RecoveryWords.sealedToEarlier).foregroundStyle(PardnerColor.muted) }
            ForEach(progress.waiting, id: \.key) { missing in row(missing) }
            Text(RecoveryScreenWords.keepKeys).font(PardnerFont.ui(size: 13, weight: .semibold)).foregroundStyle(PardnerColor.agentText)
        }
    }

    /// The conversations that stay unreadable without the key, by name. The link gives no dates, so none are shown.
    private func conversations(_ missing: RecoveryProgress.Missing) -> String {
        Array(Set(missing.epochs.map(\.channel))).map(Naming.channel).sorted().joined(separator: ", ")
    }

    @ViewBuilder private func row(_ missing: RecoveryProgress.Missing) -> some View {
        let id = Naming.short(missing.key)
        VStack(alignment: .leading, spacing: PardnerMetrics.gap) {
            Text(RecoveryScreenWords.missing(id, isCurrent: missing.isCurrent)).fixedSize(horizontal: false, vertical: true)
            if !missing.epochs.isEmpty { Text(conversations(missing)).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted) }
            if model.givingUp == missing.key {
                VStack(alignment: .leading, spacing: PardnerMetrics.gap) {
                    Text(RecoveryWords.unreadable(conversations(missing))).foregroundStyle(PardnerColor.agentText)
                    HStack {
                        Button(RecoveryWords.typeIt) { model.typeInstead() }.buttonStyle(PardnerButton(prominent: false))
                        Button(RecoveryWords.noLongerHaveIt) { model.giveUp() }.buttonStyle(PardnerButton(prominent: true))
                    }
                }
                .padding(PardnerMetrics.gap * 1.5).background(PardnerColor.agentSoft, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
            } else {
                HStack {
                    Button(RecoveryWords.typeIt) { model.typeEarlierKey() }.buttonStyle(PardnerButton(prominent: true)).accessibilityLabel("Type the recovery key \(id)")
                    if !missing.isCurrent {
                        Button(RecoveryWords.noLongerHaveIt) { model.askToGiveUp(missing.key) }.buttonStyle(PardnerButton(prominent: false))
                            .accessibilityLabel("I no longer have the recovery key \(id)")
                    }
                }
            }
        }
        .padding(PardnerMetrics.gap * 1.5).frame(maxWidth: .infinity, alignment: .leading).card()
    }
}

struct Done: View {
    let model: PairingModel
    let done: RecoveryDone

    var body: some View {
        Page(title: RecoveryScreenWords.doneTitle) {
            if let line = RecoveryScreenWords.destroyable(done.destroyable.map(Naming.short)) { Text(line) }
            if done.keep != nil { Text(RecoveryWords.keepTheStartKey).foregroundStyle(PardnerColor.agentText) }
            Button("Done") { model.finishRecovery() }.buttonStyle(PardnerButton(prominent: true)).keyboardShortcut(.defaultAction).accessibilityLabel("Finish the recovery")
        }
    }
}

/// A refusal, with the action the controller allows: another key, or a cancel while nothing is sent.
struct Refusal: View {
    let model: PairingModel
    let why: RecoveryRefusal

    var body: some View {
        let words = RecoveryScreenWords.refusal(why)
        Page(title: words.title) {
            Text(words.text).foregroundStyle(PardnerColor.muted)
            if RecoveryScreenWords.canTypeAgain(why) {
                Button(RecoveryWords.typeIt) { model.typeAnotherKey() }.buttonStyle(PardnerButton(prominent: true)).accessibilityLabel("Type a recovery key")
            }
            if RecoveryScreenWords.canCancel(why) {
                Button("Cancel") { model.cancel() }.buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Cancel the recovery")
            } else {
                // Nothing stops a stored recovery here; where nothing can be done, say so plainly.
                if why == .noLongerCurrent || why == .personGone { Text(RecoveryScreenWords.cannotFinish).foregroundStyle(PardnerColor.agentText) }
                Text(RecoveryScreenWords.keepKeys).font(PardnerFont.ui(size: 13, weight: .semibold)).foregroundStyle(PardnerColor.agentText)
            }
        }
    }
}
