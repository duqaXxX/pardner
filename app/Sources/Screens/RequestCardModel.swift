// What a request's card decides (requests design 2.1 and 2.2): the controls of each type and the answer they build, the keys, and where the card stands
// after a reply. One model per request, kept by its thread's `ComposerModel`, which sends the reply (a kind 10) through the outbox and binds it by name.
import Conversation
import Foundation
import Observation

/// A button of a card.
public struct RequestControl: Equatable {
    public let title: String
    public let enabled: Bool
}

/// What a card shows besides the request: its controls (and what went wrong with the last attempt), a reply on its way, or where the request ended.
public enum RequestPhase: Equatable {
    /// The controls show, with these lines in `danger` under them: the bot's reason for the last reply, or `Not sent.` and why, or `Not delivered.`.
    case asking(notes: [String])
    case sending
    case ended(RequestStatus)
}

/// A setup's controls and what they send (the core reads the selection against the models it offered: `choiceOf`, src/core/setup.ts).
struct SetupChoice: Equatable {
    let request: SetupRequest
    var model: String
    var effort: String
    var bypass: Bool

    static let `default` = "default"

    init(_ request: SetupRequest) {
        (self.request, model, effort, bypass) = (request, request.selection.model, request.selection.effort, request.selection.bypass)
        if !effortOptions.contains(effort) { effort = Self.default }
    }

    private var defaultEntry: SetupModel? { request.models.first { $0.isDefault } }

    /// The models the picker lists: the request's, with a leading Default when none of them stands for the default. Empty when the agent lists none.
    var modelOptions: [(value: String, name: String)] {
        guard !request.models.isEmpty else { return [] }
        let listed = request.models.map { (value: $0.value, name: $0.displayName) }
        return defaultEntry == nil ? [(Self.default, "Default")] + listed : listed
    }

    /// The picker's selection: `default` is the entry that stands for the default.
    var shownModel: String { model == Self.default ? defaultEntry?.value ?? Self.default : model }

    private var entry: SetupModel? { model == Self.default ? defaultEntry : request.models.first { $0.value == model } }

    /// `Default` first, then the levels the chosen model takes, or the request's when it lists no model; none for a model without effort.
    var effortOptions: [String] {
        let levels = request.models.isEmpty ? request.efforts : (entry.flatMap { $0.supportsEffort ? $0.supportedEffortLevels : nil } ?? [])
        return levels.isEmpty ? [] : [Self.default] + levels
    }

    /// A model chosen; an effort it does not take goes back to Default.
    mutating func choose(model new: String) {
        model = defaultEntry?.value == new ? Self.default : new
        if !effortOptions.contains(effort) { effort = Self.default }
    }

    var answer: [String: Any] { ["type": "setup", "selection": ["model": model, "effort": effort, "bypass": bypass]] }
}

/// The choices of one question: its picked labels and what the owner typed as another answer.
struct QuestionChoice: Equatable {
    var picked: [String] = []
    var other = ""

    private var typed: String { other.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The answer by the question's kind, or nil while there is none: a single choice is a string, Other's text replacing it; a multiple one is an array of
    /// the labels in the question's order, Other's text one more entry.
    func answer(_ question: RequestQuestion) -> Any? {
        if question.multiSelect {
            let all = question.options.map(\.label).filter(picked.contains) + (typed.isEmpty ? [] : [typed])
            return all.isEmpty ? nil : all
        }
        return typed.isEmpty ? picked.first : typed
    }
}

@MainActor @Observable
public final class RequestCardModel {
    /// The request's message (kind 9).
    public let request: Message
    /// The request decoded, or nil when this device cannot read it or does not know its type.
    public let owner: OwnerRequest?
    var setup: SetupChoice?
    var questions: [QuestionChoice] = []
    /// Whether the whole input is shown, past `limit` characters.
    public var showAll = false
    @ObservationIgnored private weak var composer: ComposerModel?

    /// A permission's input or plan is cut here until Show all.
    static let limit = 4_000

    init(request: Message, composer: ComposerModel) {
        (self.request, self.composer) = (request, composer)
        owner = request.ownerRequest
        switch owner {
        case .setup(let s): setup = SetupChoice(s)
        case .question(let q): questions = Array(repeating: QuestionChoice(), count: q.count)
        default: break
        }
    }

    // MARK: what the card shows

    private var thread: MessageThread? {
        guard let composer, let key = composer.thread else { return nil }
        return composer.reading.channels[composer.channel]?.threads[key]
    }

    /// The request's status in the reading, `open` until it says otherwise.
    var status: RequestStatus { thread?.requests[request.ref] ?? .open }

    public var phase: RequestPhase {
        guard status == .open else { return .ended(status) }
        switch composer?.replyState(request.ref) {
        case .sending: return .sending
        case .notSent(let why): return .asking(notes: ["Not sent.", why])
        case .notDelivered: return .asking(notes: ["Not delivered."])
        case nil:
            let reason = composer?.thisDevice.flatMap { thread?.reason(of: request.ref, from: $0) }
            return .asking(notes: reason.map { [$0] } ?? [])
        }
    }

    /// What an ended card says: the owner's answer while it goes to the bot and once the bot took it, else the status's words. A setup the
    /// bot took is rewritten by the bot itself (`Set: …`).
    public var endedWords: String {
        guard status == .replied || status == .answered, let owner, let json = thread?.answers[request.ref] else { return status.words }
        return Self.words(answer: json, to: owner) ?? status.words
    }

    /// The answer a reply's body (`{answer}`) gives, in the words of the button that sent it; nil for a setup and a body it cannot read.
    static func words(answer json: String, to owner: OwnerRequest) -> String? {
        guard let reply = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any], let body = reply["answer"] as? [String: Any] else { return nil }
        func either(_ key: String, _ yes: String, _ no: String) -> String? { (body[key] as? Bool).map { $0 ? yes : no } }
        switch owner {
        case .setup: return nil
        case .permission: return either("allow", "Allowed", "Denied")
        case .shell: return either("run", "Ran", "Not run")
        case .hold: return either("send", "Sent anyway", "Not sent")
        case .terminal: return either("go", "Sent here", "Not sent")
        case .question(let asked):
            if body["answers"] is NSNull { return "Skipped" }
            guard let answers = body["answers"] as? [String: Any] else { return nil }
            let each = asked.compactMap { question -> String? in
                switch answers[question.text] {
                case let one as String: one
                case let many as [String]: many.joined(separator: ", ")
                default: nil
                }
            }
            return each.isEmpty ? nil : "Answered: " + each.joined(separator: "; ")
        }
    }

    /// The input of a permission, or its plan in place of it, cut at `limit` characters unless `showAll`.
    public var shownText: (text: String, cut: Bool)? {
        guard case .permission(let p)? = owner else { return nil }
        let text = p.plan ?? p.input
        return showAll || text.count <= Self.limit ? (text, false) : (String(text.prefix(Self.limit)), true)
    }

    // MARK: the controls

    /// The two buttons of the card, or nil where it has none (a request this device cannot read, a bot removed, a request that is no longer open).
    public var controls: (primary: RequestControl, secondary: RequestControl?)? {
        guard composer?.canCommand == true, composer?.sessionBotID == request.sender, status == .open else { return nil }
        switch owner {
        case .setup?: return (RequestControl(title: "Start", enabled: true), nil)
        case .permission?: return (RequestControl(title: "Allow", enabled: true), RequestControl(title: "Deny", enabled: true))
        case .question(let asked)?:
            let done = zip(asked, questions).allSatisfy { $1.answer($0) != nil }
            return (RequestControl(title: "Answer", enabled: done), RequestControl(title: "Skip", enabled: true))
        case .shell?: return (RequestControl(title: "Run", enabled: true), RequestControl(title: "Don\u{2019}t run", enabled: true))
        case .hold?: return (RequestControl(title: "Send anyway", enabled: true), RequestControl(title: "Don\u{2019}t send", enabled: true))
        case .terminal?: return (RequestControl(title: "Go", enabled: true), RequestControl(title: "Cancel", enabled: true))
        case nil: return nil
        }
    }

    /// The first button: Start, Allow, Answer, Run, Send anyway, Go. Nil when it is not enabled or a reply is on its way.
    @discardableResult
    public func primary() -> Task<Void, Never>? {
        guard controls?.primary.enabled == true, let owner else { return nil }
        switch owner {
        case .setup: return reply(setup?.answer ?? [:])
        case .permission: return reply(["type": "permission", "allow": true])
        case .question(let asked):
            var answers: [String: Any] = [:]
            for (q, choice) in zip(asked, questions) { answers[q.text] = choice.answer(q) }
            return reply(["type": "question", "answers": answers, "notes": [String: String]()])
        case .shell: return reply(["type": "shell", "run": true])
        case .hold: return reply(["type": "hold", "send": true])
        case .terminal: return reply(["type": "terminal", "go": true])
        }
    }

    /// The second button: Deny, Skip, Don't run, Don't send, Cancel. Nil where the card has none.
    @discardableResult
    public func secondary() -> Task<Void, Never>? {
        guard controls?.secondary?.enabled == true, let owner else { return nil }
        switch owner {
        case .setup: return nil
        case .permission: return reply(["type": "permission", "allow": false])
        case .question: return reply(["type": "question", "answers": NSNull(), "notes": [String: String]()])
        case .shell: return reply(["type": "shell", "run": false])
        case .hold: return reply(["type": "hold", "send": false])
        case .terminal: return reply(["type": "terminal", "go": false])
        }
    }

    /// Return, once the owner focused the card: its first button. True when it was taken.
    /// `fieldFocused`: a field inside the card has the keyboard, and its keys are its own.
    public func returnPressed(fieldFocused: Bool = false) -> Bool { !fieldFocused && primary() != nil }

    /// Escape, once the owner focused the card: its second button, where it has one. True when it was taken.
    public func escapePressed(fieldFocused: Bool = false) -> Bool { !fieldFocused && secondary() != nil }

    private func reply(_ answer: [String: Any]) -> Task<Void, Never>? { composer?.answer(request, answer) }

    // MARK: a question's choices

    /// Picks an option of question `index`: a single choice replaces the pick and Other's text, a multiple one toggles.
    public func pick(question index: Int, _ label: String) {
        guard case .question(let asked)? = owner, asked.indices.contains(index) else { return }
        if asked[index].multiSelect {
            if let at = questions[index].picked.firstIndex(of: label) { questions[index].picked.remove(at: at) } else { questions[index].picked.append(label) }
        } else {
            questions[index].picked = [label]
            questions[index].other = ""
        }
    }

    /// The text of question `index`'s Other field.
    public func setOther(question index: Int, _ text: String) {
        guard questions.indices.contains(index) else { return }
        questions[index].other = text
    }
}
