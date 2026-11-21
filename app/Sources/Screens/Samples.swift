// A synthetic conversation for the screenshots of the decisions document and for previews: alice with her
// bot `mini`, bob with his bot `studio` (first-screens decision 8 asks the boards to draw a second person).
// Built through the same views the link delivers, so it exercises the reading model; never shown as real.
import Conversation
import Foundation
import ProtocolHost
import Relay

public enum Samples {
    static let channel = Data(repeating: 0x3F, count: 32)
    static let alice = Data([0xA1, 0x1C, 0xE0, 0x01] + Array(repeating: 1, count: 28))
    static let bob = Data([0xB0, 0xB0, 0x00, 0x02] + Array(repeating: 2, count: 28))
    static let mini = Data([0x4D, 0x14, 0x10, 0x03] + Array(repeating: 3, count: 28))
    static let studio = Data([0x57, 0x0D, 0x10, 0x04] + Array(repeating: 4, count: 28))

    /// The conversation, read as the link would deliver it; the first session's key, to open in the panel.
    public static func model() -> (model: ReadingModel, channel: Data, thread: String, queuedThread: String) {
        var m = ReadingModel()
        var position = 1
        let start = 1_763_600_000_000.0 // a Thursday morning, 2025-11-20
        @discardableResult
        func put(_ kind: Int, _ sender: Data, _ body: [String: Any], to: Data? = nil, re: MessageRef? = nil, minutes: Double, name: Data? = nil) -> MessageRef {
            let at = position
            position += 1
            let n = name ?? Data(repeating: UInt8(at), count: 16)
            let text = String(decoding: try! JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]), as: UTF8.self)
            m.take(view: .object([
                "do": .string("message"), "position": .number(Double(at)), "channel": .bytes(channel), "sender": .bytes(sender),
                "name": .bytes(n), "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(start + minutes * 60_000),
                "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null, "blobs": .array([]), "files": .array([]),
                "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null,
                "text": .string(text), "again": .bool(false),
            ]))
            return MessageRef(device: sender, name: n)
        }
        func profile(_ bot: Data, _ name: String, _ account: String) {
            m.take(profile: .object(["do": .string("profile"), "bot": .bytes(bot),
                                     "profile": .object(["name": .string(name), "account": .object(["name": .string(account), "plan": .string("max")])])]))
        }
        profile(mini, "mini", "alice@example.com")
        profile(studio, "studio", "bob@example.com")

        let hello = put(1, bob, ["markdown": "Morning. I moved the release to Friday, the docs are not ready."], minutes: 0)
        put(1, alice, ["markdown": "Fine by me. I'll ask mini to look at the failing test.", "thread": hello.hex], minutes: 2)

        let fix = put(2, alice, ["text": "The relay test fails on a restart. Find why and fix it."], to: mini, minutes: 5)
        put(3, mini, [:], re: fix, minutes: 5.1)
        let answer = Data(repeating: 0xA0, count: 16)
        put(4, mini, ["thread": fix.hex, "markdown": "The test kills the relay before its journal is flushed. "], re: MessageRef(device: mini, name: answer), minutes: 6)
        put(4, mini, ["thread": fix.hex, "markdown": "I made it wait for the flush and ran the suite: 6,236 pass."], re: MessageRef(device: mini, name: answer), minutes: 9)
        put(5, mini, ["thread": fix.hex, "markdown": "The test kills the relay before its journal is flushed. I made it wait for the flush and ran the suite: 6,236 pass."], re: fix, minutes: 9.2, name: answer)

        let docs = put(2, alice, ["text": "Update the setup guide for the new store folder."], to: mini, minutes: 12)
        put(3, mini, [:], re: docs, minutes: 12.1)
        put(9, mini, ["thread": docs.hex, "title": "Allow Edit of docs/setup.md?", "request": ["type": "permission"]], re: docs, minutes: 14)
        // A prompt sent while the session runs: the bot started it and queued it behind the first.
        let typos = put(2, alice, ["text": "Then fix the typos in it.", "thread": docs.hex], to: mini, minutes: 14.5)
        put(3, mini, [:], re: typos, minutes: 14.6)

        let release = put(2, bob, ["text": "Draft the release notes for 0.18.0."], to: studio, minutes: 15)
        put(3, studio, [:], re: release, minutes: 15.1)
        put(4, studio, ["thread": release.hex, "markdown": "Reading the changelog since 0.17.0…"], re: MessageRef(device: studio, name: Data(repeating: 0xB0, count: 16)), minutes: 16)
        return (m, channel, fix.hex, docs.hex)
    }

    /// Where the owner's replies to the sample requests stand.
    public enum RequestStage: Sendable { case open, sending, answered, refused }

    /// A session of alice's with `mini` that holds one request of each type, for the cards' screenshots: the owner's replies and the bot's words on them
    /// are those of `stage`. `outbox` holds the replies not read back yet; the person's devices are alice's Mac (`me`) and the bot (`bot`).
    public static func requests(_ stage: RequestStage) -> (model: ReadingModel, channel: Data, thread: String, me: Data, bot: Data, outbox: [OutboxItemRow]) {
        var m = ReadingModel()
        var position = 1
        let start = 1_763_600_000_000.0
        @discardableResult
        func put(_ kind: Int, _ sender: Data, _ body: [String: Any], to: Data? = nil, re: MessageRef? = nil, minutes: Double) -> MessageRef {
            let at = position
            position += 1
            let n = Data(repeating: UInt8(at), count: 16)
            let text = String(decoding: try! JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]), as: UTF8.self)
            m.take(view: .object([
                "do": .string("message"), "position": .number(Double(at)), "channel": .bytes(channel), "sender": .bytes(sender),
                "name": .bytes(n), "epoch": .bytes(Data(repeating: 9, count: 32)), "time": .number(start + minutes * 60_000),
                "kind": .number(Double(kind)), "to": to.map { .bytes($0) } ?? .null, "blobs": .array([]), "files": .array([]),
                "re": re.map { .object(["device": .bytes($0.device), "name": .bytes($0.name)]) } ?? .null,
                "text": .string(text), "again": .bool(false),
            ]))
            return MessageRef(device: sender, name: n)
        }
        m.take(profile: .object(["do": .string("profile"), "bot": .bytes(mini), "profile": .object(["name": .string("mini"), "account": .object(["name": .string("alice@example.com"), "plan": .string("max")])])]))
        let root = put(2, alice, ["text": "Prepare the 0.18.0 release."], to: mini, minutes: 0)
        put(3, mini, [:], re: root, minutes: 0.1)
        func model(_ value: String, _ name: String, isDefault: Bool, levels: [String]) -> [String: Any] {
            ["value": value, "isDefault": isDefault, "resolvedModel": NSNull(), "displayName": name, "description": NSNull(), "supportsEffort": !levels.isEmpty, "supportedEffortLevels": levels]
        }
        let requests: [(title: String, body: [String: Any], answer: [String: Any])] = [
            ("Set up this session", ["type": "setup", "bypassOffered": true, "efforts": [String](), "selection": ["model": "default", "effort": "default", "bypass": false],
                                     "models": [model("sonnet", "Sonnet", isDefault: true, levels: ["low", "medium", "high"]), model("opus", "Opus", isDefault: false, levels: ["high"]),
                                                model("haiku", "Haiku", isDefault: false, levels: [])]],
             ["type": "setup", "selection": ["model": "default", "effort": "default", "bypass": false]]),
            ("Allow Edit of docs/setup.md?", ["type": "permission", "toolName": "Edit", "title": NSNull(), "description": "Edit a file in the repository", "plan": NSNull(),
                                              "input": ["file_path": "docs/setup.md", "old_string": "~/.config/allaboard", "new_string": "~/.config/pardner"]],
             ["type": "permission", "allow": true]),
            ("Two questions before the release", ["type": "question", "title": NSNull(), "questions": [
                ["header": "Version", "text": "Which version number should the release carry?", "multiSelect": false,
                 "options": [["label": "0.18.0", "description": "The next minor version", "preview": NSNull()], ["label": "0.17.1", "description": "A patch release", "preview": NSNull()]]],
                ["header": "Docs", "text": "Which documents should be checked?", "multiSelect": true,
                 "options": [["label": "CHANGELOG", "description": NSNull(), "preview": NSNull()], ["label": "features", "description": NSNull(), "preview": NSNull()]]],
            ]], ["type": "question", "answers": ["Which version number should the release carry?": "0.18.0", "Which documents should be checked?": ["CHANGELOG"]], "notes": [String: String]()]),
            ("Run this command?", ["type": "shell", "command": "npm run check\nnpm test", "folder": "pardner-workspace"], ["type": "shell", "run": true]),
            ("Another session is working in this folder", ["type": "hold", "other": ["channel": "c", "thread": "t"], "link": "the session that started at 09:12"], ["type": "hold", "send": true]),
            ("This session is open in a terminal", ["type": "terminal", "state": "open", "running": NSNull(), "command": "claude --resume 7f3a9c"], ["type": "terminal", "go": true]),
        ]
        var outbox: [OutboxItemRow] = []
        for (index, r) in requests.enumerated() {
            let minutes = 1 + Double(index)
            let asked = put(9, mini, ["thread": root.hex, "request": r.body, "title": r.title], re: root, minutes: minutes)
            let content = String(decoding: try! JSONSerialization.data(withJSONObject: ["answer": r.answer], options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
            func replyItem(_ state: OutboxItemState) {
                outbox.append(OutboxItemRow(name: Data(repeating: UInt8(0xD0 + index), count: 16), kind: 10, to: mini, re: MessageReference(device: asked.device, name: asked.name),
                                            content: content, state: state))
            }
            switch stage {
            case .open: break
            case .sending: replyItem(.waiting)
            case .answered:
                let reply = put(10, alice, ["answer": r.answer], to: mini, re: asked, minutes: minutes + 0.2)
                if index == 0 {
                    put(11, mini, ["thread": root.hex, "markdown": "Set: default model, default effort, bypass off"], re: asked, minutes: minutes + 0.3)
                    put(5, mini, ["thread": "", "markdown": ""], re: reply, minutes: minutes + 0.4)
                } else {
                    put(11, mini, ["thread": root.hex, "withdrawn": true], re: asked, minutes: minutes + 0.3)
                    put(5, mini, ["thread": "", "markdown": ""], re: reply, minutes: minutes + 0.4)
                }
            case .refused:
                switch index {
                case 0: put(7, mini, [:], re: put(10, alice, ["answer": r.answer], to: mini, re: asked, minutes: minutes + 0.2), minutes: minutes + 0.3)
                case 1: put(5, mini, ["thread": "", "markdown": "The bot is no longer waiting for this answer."], re: put(10, alice, ["answer": r.answer], to: mini, re: asked, minutes: minutes + 0.2), minutes: minutes + 0.3)
                case 2: put(5, mini, ["thread": "", "markdown": "The bot could not take this answer."], re: put(10, alice, ["answer": r.answer], to: mini, re: asked, minutes: minutes + 0.2), minutes: minutes + 0.3)
                default: replyItem(.refused)
                }
            }
        }
        return (m, channel, root.hex, alice, mini, outbox)
    }
}
