// A request of the bot's as the cards read it (requests design 2.1): the core's `OwnerRequest` without its ids, decoded once from the kind 9
// body's JSON. A request this device cannot read, or of a type it does not know, decodes to nil and gets no controls.
import Foundation

/// One model of a setup request, with the effort levels it takes.
public struct SetupModel: Sendable, Equatable {
    /// What the answer names the model by.
    public let value: String
    /// Whether the entry stands for whichever model the agent picks when none is chosen.
    public let isDefault: Bool
    public let displayName: String
    public let supportsEffort: Bool
    public let supportedEffortLevels: [String]
}

/// What a setup's controls hold: a model and an effort by value, and bypass. `default` is a model or effort left to the agent.
public struct SetupSelection: Sendable, Equatable {
    public var model: String
    public var effort: String
    public var bypass: Bool
}

public struct SetupRequest: Sendable, Equatable {
    public let models: [SetupModel]
    /// The levels offered when no model is.
    public let efforts: [String]
    public let bypassOffered: Bool
    public let selection: SetupSelection
}

public struct PermissionRequest: Sendable, Equatable {
    public let toolName: String
    /// The tool's input as indented JSON with its keys sorted, ready to draw.
    public let input: String
    public let title: String?
    public let description: String?
    /// The plan a plan approval asks for, drawn in place of the input.
    public let plan: String?
}

public struct RequestOption: Sendable, Equatable {
    public let label: String
    public let description: String?
    public let preview: String?
}

public struct RequestQuestion: Sendable, Equatable {
    public let header: String
    /// The question, which also names it in the answer.
    public let text: String
    public let multiSelect: Bool
    public let options: [RequestOption]
}

public enum OwnerRequest: Sendable, Equatable {
    case setup(SetupRequest)
    case permission(PermissionRequest)
    case question([RequestQuestion])
    case shell(command: String, folder: String)
    case hold(link: String)
    case terminal(state: String, running: String?, command: String?)

    /// The request of a kind 9 body (`{thread, request, title}`), or nil when it does not read as one of the six types.
    public init?(json: String) {
        guard let body = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any],
              let r = body["request"] as? [String: Any], let type = r["type"] as? String else { return nil }
        func strings(_ value: Any?) -> [String]? { value as? [String] }
        switch type {
        case "setup":
            guard let models = r["models"] as? [[String: Any]], let efforts = strings(r["efforts"]), let bypass = r["bypassOffered"] as? Bool,
                  let s = r["selection"] as? [String: Any], let model = s["model"] as? String, let effort = s["effort"] as? String,
                  let selected = s["bypass"] as? Bool else { return nil }
            var listed: [SetupModel] = []
            for m in models {
                guard let value = m["value"] as? String, let name = m["displayName"] as? String, let levels = strings(m["supportedEffortLevels"]) else { return nil }
                listed.append(SetupModel(value: value, isDefault: m["isDefault"] as? Bool ?? false, displayName: name,
                                         supportsEffort: m["supportsEffort"] as? Bool ?? false, supportedEffortLevels: levels))
            }
            self = .setup(SetupRequest(models: listed, efforts: efforts, bypassOffered: bypass,
                                       selection: SetupSelection(model: model, effort: effort, bypass: selected)))
        case "permission":
            guard let tool = r["toolName"] as? String, let input = r["input"] as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: input, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) else { return nil }
            self = .permission(PermissionRequest(toolName: tool, input: String(decoding: data, as: UTF8.self), title: r["title"] as? String,
                                                 description: r["description"] as? String, plan: r["plan"] as? String))
        case "question":
            guard let asked = r["questions"] as? [[String: Any]] else { return nil }
            var questions: [RequestQuestion] = []
            for q in asked {
                guard let text = q["text"] as? String, let options = q["options"] as? [[String: Any]] else { return nil }
                var listed: [RequestOption] = []
                for o in options {
                    guard let label = o["label"] as? String else { return nil }
                    listed.append(RequestOption(label: label, description: o["description"] as? String, preview: o["preview"] as? String))
                }
                questions.append(RequestQuestion(header: q["header"] as? String ?? "", text: text, multiSelect: q["multiSelect"] as? Bool ?? false, options: listed))
            }
            self = .question(questions)
        case "shell":
            guard let command = r["command"] as? String, let folder = r["folder"] as? String else { return nil }
            self = .shell(command: command, folder: folder)
        case "hold":
            guard let link = r["link"] as? String else { return nil }
            self = .hold(link: link)
        case "terminal":
            guard let state = r["state"] as? String else { return nil }
            self = .terminal(state: state, running: r["running"] as? String, command: r["command"] as? String)
        default:
            return nil
        }
    }
}

extension Message {
    /// The request a kind 9 message carries, once decoded.
    public var ownerRequest: OwnerRequest? {
        if case .request(_, _, let json) = body { OwnerRequest(json: json) } else { nil }
    }
}
