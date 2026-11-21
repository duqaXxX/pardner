// The recovery sheet (device pairing design 3.8): the public part with Copy and Print, the secret drawn and typed back whole, and
// Confirm only for a match. Closing the sheet by any way declines (`onDisappear`), so the host thread is never left waiting.
import AppKit
import DesignSystem
import SwiftUI

public struct RecoverySheetView: View {
    let model: RecoverySheetModel

    public init(model: RecoverySheetModel) { self.model = model }

    public var body: some View {
        VStack(alignment: .leading, spacing: PardnerMetrics.gap * 2) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Write down your recovery key").font(PardnerFont.display(size: 22, weight: .bold))
                Text("If every device of yours is lost, this key opens your history. Write it down and keep it away from your Macs.")
                    .foregroundStyle(PardnerColor.muted)
            }
            publicPart
            secretPart
            typedBack
            if model.typed == RecoverySheetModel.symbolCount && !model.matches {
                Text("This does not match the key shown above. Check each character against what you wrote.")
                    .foregroundStyle(PardnerColor.delText).font(PardnerFont.ui(size: 13, weight: .regular))
            }
            HStack {
                Text("Recovery with this key comes in a later version of Pardner.")
                    .font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
                Spacer()
                Button("Cancel") { model.close() }
                    .keyboardShortcut(.cancelAction).buttonStyle(PardnerButton(prominent: false))
                    .accessibilityLabel("Cancel the setup")
                Button("Confirm") { model.confirm() }
                    .keyboardShortcut(.defaultAction).buttonStyle(PardnerButton(prominent: true))
                    .disabled(!model.matches).accessibilityLabel("Confirm the recovery key")
            }
        }
        .padding(PardnerMetrics.gap * 3)
        .frame(width: 600)
        .background(PardnerColor.bg)
        .background(WindowGuard())
        .foregroundStyle(PardnerColor.text)
        .font(PardnerFont.ui(size: 14, weight: .regular))
        .onDisappear { model.close() }
    }

    private var publicPart: some View {
        VStack(alignment: .leading, spacing: PardnerMetrics.gap) {
            Label("For your records (public, not secret)")
            Text(model.context)
                .font(PardnerFont.mono(size: 11, weight: .regular)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(PardnerMetrics.gap * 1.5).card()
            HStack(spacing: PardnerMetrics.gap) {
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(model.context, forType: .string)
                }
                .buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Copy the person id, relay address and relay key")
                Button("Print") { PublicPrint.run(model.context) }
                    .buttonStyle(PardnerButton(prominent: false)).accessibilityLabel("Print the person id, relay address and relay key")
            }
        }
    }

    private var secretPart: some View {
        VStack(alignment: .leading, spacing: PardnerMetrics.gap) {
            Label("Recovery key (secret: no copy, no print)")
            SecretText(model: model)
                .frame(maxWidth: .infinity, minHeight: KeyLayout.rowHeight * 2, alignment: .leading)
                .padding(PardnerMetrics.gap * 1.5).card()
            Text("Write it down now, with no screen sharing or recording running. The key is drawn on screen only; it is never copied, saved or printed.")
                .font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted).fixedSize(horizontal: false, vertical: true)
        }
    }

    private var typedBack: some View {
        VStack(alignment: .leading, spacing: PardnerMetrics.gap) {
            Label("Type it back")
            KeyCapture(model: model)
                .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                .padding(PardnerMetrics.gap * 1.5).card()
            Text("\(model.typed) of \(RecoverySheetModel.symbolCount) characters. Case and dashes do not matter.")
                .font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
        }
    }

    private struct Label: View {
        let text: String
        init(_ text: String) { self.text = text }
        var body: some View {
            Text(text.uppercased()).font(PardnerFont.ui(size: 11, weight: .semibold)).foregroundStyle(PardnerColor.muted)
        }
    }
}

/// Prints the public part alone: a text view of its lines.
enum PublicPrint {
    @MainActor static func run(_ text: String) {
        let view = NSTextView(frame: NSRect(x: 0, y: 0, width: 468, height: 200))
        view.string = text
        view.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        NSPrintOperation(view: view).run()
    }
}

extension View {
    /// A card: `surface` with a `line` border and the `container` radius (window decisions W7).
    func card() -> some View {
        background(PardnerColor.surface, in: RoundedRectangle(cornerRadius: PardnerMetrics.containerRadius))
            .overlay(RoundedRectangle(cornerRadius: PardnerMetrics.containerRadius).stroke(PardnerColor.line))
    }
}

/// A button in the design's colours: `brand` for the one action of a screen, `raised` for the rest; the pointing hand over it.
struct PardnerButton: ButtonStyle {
    let prominent: Bool
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(PardnerFont.ui(size: 14, weight: .medium))
            .foregroundStyle(prominent ? PardnerColor.brandInk : PardnerColor.text)
            .padding(.horizontal, PardnerMetrics.gap * 2).padding(.vertical, 7)
            .background(prominent ? PardnerColor.brand : PardnerColor.raised, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
            .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.4)
            .pointerStyle(enabled ? .link : nil)
    }
}
