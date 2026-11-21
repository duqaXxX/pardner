// A request's card (requests design 2.1 and 2.2): the bot's own words, drawn as text, and the controls of its type. The decisions are
// `RequestCardModel`'s; this draws them and passes the keys of a focused card.
import Conversation
import DesignSystem
import SwiftUI

struct RequestCardView: View {
    let card: RequestCardModel
    var focus: FocusState<MessageRef?>.Binding
    /// The Other field that has the keyboard, if any: its Return and Escape are the field's own.
    @FocusState private var field: Int?

    var body: some View {
        let phase = card.phase
        VStack(alignment: .leading, spacing: PardnerMetrics.gap) {
            Text(verbatim: heading).font(PardnerFont.ui(size: 14, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
            switch phase {
            case .ended(let status):
                Text(status.words).font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.muted).fixedSize(horizontal: false, vertical: true)
            case .asking(let notes):
                content(enabled: true)
                buttons(enabled: true)
                ForEach(Array(notes.enumerated()), id: \.offset) { _, note in line(note, PardnerColor.delText) }
            case .sending:
                content(enabled: false).disabled(true)
                buttons(enabled: false)
                line("Sending\u{2026}", PardnerColor.muted)
            }
        }
        .requestFrame(open: !isEnded(phase))
        .focusable()
        .focused(focus, equals: card.request.ref)
        .onTapGesture { if field == nil { focus.wrappedValue = card.request.ref } }
        .onKeyPress(.return) { focus.wrappedValue == card.request.ref && card.returnPressed(fieldFocused: field != nil) ? .handled : .ignored }
        .onKeyPress(.escape) { focus.wrappedValue == card.request.ref && card.escapePressed(fieldFocused: field != nil) ? .handled : .ignored }
    }

    private func isEnded(_ phase: RequestPhase) -> Bool {
        if case .ended = phase { true } else { false }
    }

    private var title: String {
        if case .request(let title, _, _) = card.request.body { title } else { "" }
    }

    private var heading: String {
        switch card.owner {
        case .setup?: "Set up this session"
        case .shell?: "Run this command?"
        default: title
        }
    }

    private func line(_ text: String, _ color: Color) -> some View {
        Text(verbatim: text).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(color).fixedSize(horizontal: false, vertical: true)
    }

    private func mono(_ text: String) -> some View {
        Text(verbatim: text).font(PardnerFont.mono(size: 12, weight: .regular)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            .padding(PardnerMetrics.gap).frame(maxWidth: .infinity, alignment: .leading)
            .background(PardnerColor.surface, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
    }

    // MARK: what each type shows

    @ViewBuilder
    private func content(enabled: Bool) -> some View {
        switch card.owner {
        case .setup(let request)?: setupControls(request, enabled: enabled)
        case .permission(let p)?:
            line(p.toolName, PardnerColor.muted)
            if let description = p.description { line(description, PardnerColor.text) }
            if let shown = card.shownText {
                mono(shown.text)
                if shown.cut { Button("Show all") { card.showAll = true }.buttonStyle(.plain).font(PardnerFont.ui(size: 12, weight: .medium)).foregroundStyle(PardnerColor.agentText) }
            }
        case .question(let asked)?:
            ForEach(Array(asked.enumerated()), id: \.offset) { index, question in questionView(index, question) }
        case .shell(let command, let folder)?:
            mono(command)
            line("in \(folder)", PardnerColor.muted)
        case .hold(let link)?: line(link, PardnerColor.text)
        case .terminal, nil: EmptyView()
        }
    }

    @ViewBuilder
    private func setupControls(_ request: SetupRequest, enabled: Bool) -> some View {
        if let setup = card.setup {
            if !setup.modelOptions.isEmpty {
                Picker("Model", selection: Binding(get: { card.setup?.shownModel ?? "" }, set: { card.setup?.choose(model: $0) })) {
                    ForEach(setup.modelOptions, id: \.value) { Text(verbatim: $0.name).tag($0.value) }
                }
            }
            if !setup.effortOptions.isEmpty {
                Picker("Effort", selection: Binding(get: { card.setup?.effort ?? "" }, set: { card.setup?.effort = $0 })) {
                    ForEach(setup.effortOptions, id: \.self) { Text(verbatim: $0 == SetupChoice.default ? "Default" : $0).tag($0) }
                }
            }
            if request.bypassOffered {
                Toggle("Bypass", isOn: Binding(get: { card.setup?.bypass ?? false }, set: { card.setup?.bypass = $0 })).toggleStyle(.switch)
            }
        }
    }

    private func questionView(_ index: Int, _ question: RequestQuestion) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if !question.header.isEmpty { line(question.header, PardnerColor.muted) }
            Text(verbatim: question.text).font(PardnerFont.ui(size: 13, weight: .medium)).fixedSize(horizontal: false, vertical: true)
            ForEach(Array(question.options.enumerated()), id: \.offset) { _, option in
                let picked = card.questions.indices.contains(index) && card.questions[index].picked.contains(option.label)
                Button { card.pick(question: index, option.label) } label: {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: question.multiSelect ? (picked ? "checkmark.square.fill" : "square") : (picked ? "largecircle.fill.circle" : "circle"))
                            .foregroundStyle(picked ? PardnerColor.agentText : PardnerColor.muted)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(verbatim: option.label).font(PardnerFont.ui(size: 13, weight: .regular))
                            if let description = option.description { line(description, PardnerColor.muted) }
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            TextField("Other", text: Binding(get: { card.questions.indices.contains(index) ? card.questions[index].other : "" }, set: { card.setOther(question: index, $0) }))
                .focused($field, equals: index)
                .textFieldStyle(.plain).padding(.horizontal, PardnerMetrics.gap).padding(.vertical, 5)
                .background(PardnerColor.surface, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
                .overlay(RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius).stroke(PardnerColor.line))
        }
    }

    @ViewBuilder
    private func buttons(enabled: Bool) -> some View {
        if let controls = card.controls {
            HStack(spacing: PardnerMetrics.gap) {
                Button(controls.primary.title) { card.primary() }
                    .buttonStyle(PardnerButton(prominent: true)).disabled(!enabled || !controls.primary.enabled)
                if let second = controls.secondary {
                    Button(second.title) { card.secondary() }
                        .buttonStyle(PardnerButton(prominent: false)).disabled(!enabled || !second.enabled)
                }
            }
        } else if enabled {
            line("Waiting for you", PardnerColor.agentText)
        }
    }
}
