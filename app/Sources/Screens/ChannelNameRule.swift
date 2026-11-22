// How a channel's name is typed (decided 2026-11-22): Slack's rule, here strictly ASCII (`a-z 0-9 - _`, 1 to 80). The field changes what is
// typed or pasted: uppercase to lowercase, a space or a run of spaces to one `-`, an accented letter to its base letter, any other character
// is not inserted and the line says what is allowed, and a paste is cut at 80 with a notice. The protocol checks the same rule for kind 14.
import Foundation

enum ChannelNameRule {
    static let limit = 80

    static let notAllowed = "Only a to z, 0 to 9, - and _ are allowed in a channel name."
    static let cut = "A channel name has at most \(limit) characters: the rest was cut."

    /// The name `typed` becomes, and the line to show when something was left out or cut.
    static func normalise(_ typed: String) -> (text: String, note: String?) {
        var out = ""
        var dropped = false
        var spaced = false
        for character in typed.folding(options: .diacriticInsensitive, locale: nil).lowercased() {
            if character.isWhitespace {
                if !spaced { out.append("-") }
                spaced = true
                continue
            }
            if let ascii = character.asciiValue, (97...122).contains(ascii) || (48...57).contains(ascii) || ascii == 45 || ascii == 95 {
                out.append(character)
                spaced = false
            } else {
                dropped = true
            }
        }
        if out.count > limit {
            out = String(out.prefix(limit))
            return (out, cut)
        }
        return (out, dropped ? notAllowed : nil)
    }

    /// The name a folder suggests: its last component, as the rule makes it.
    static func suggestion(forFolder folder: String) -> String {
        normalise(folder.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "/").last.map(String.init) ?? "").text
    }
}
