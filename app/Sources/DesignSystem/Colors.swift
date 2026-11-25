// The app's colour tokens. The values live in tokens.json, the one copy; each token resolves to its light or
// dark value from the appearance it is drawn in. The module chooses no theme: the app does.
import AppKit
import SwiftUI

/// One colour as the JSON states it: sRGB components and alpha, each 0 to 1.
public struct RGBA: Equatable, Sendable {
    public let red: Double, green: Double, blue: Double, alpha: Double

    /// Parses `#RRGGBB` or `rgba(r,g,b,a)`; nil for anything else.
    public init?(_ text: String) {
        if text.hasPrefix("#"), text.count == 7, let v = UInt32(text.dropFirst(), radix: 16) {
            self.init(Double(v >> 16 & 255) / 255, Double(v >> 8 & 255) / 255, Double(v & 255) / 255, 1)
        } else if text.hasPrefix("rgba("), text.hasSuffix(")") {
            let inner = text.dropFirst(5).dropLast().split(separator: ",", omittingEmptySubsequences: false)
            let parts = inner.compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            guard inner.count == 4, parts.count == 4 else { return nil }
            let (r, g, b, a) = (parts[0], parts[1], parts[2], parts[3])
            self.init(r / 255, g / 255, b / 255, a)
        } else {
            return nil
        }
    }

    private init(_ r: Double, _ g: Double, _ b: Double, _ a: Double) {
        red = r; green = g; blue = b; alpha = a
    }
}

/// A token's two values.
public struct TokenPair: Equatable, Sendable {
    /// The value in the light appearance.
    public let light: RGBA
    /// The value in the dark appearance.
    public let dark: RGBA
}

/// The colour tokens of the app's design.
public enum Tokens {
    struct File: Decodable {
        struct Pair: Decodable { let light: String; let dark: String }
        let colors: [String: Pair]
        let radii: [String: Double]
        let spacing: [String: Double]
    }

    /// The module's `tokens.json`, read and decoded once.
    static let file: File = {
        guard let url = Bundle.module.url(forResource: "tokens", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(File.self, from: data)
        else { fatalError("DesignSystem: tokens.json is missing or unreadable") }
        return file
    }()

    /// Every token by its JSON name (`brand-ink`), parsed from the module's `tokens.json`.
    public static let pairs: [String: TokenPair] = {
        file.colors.mapValues { pair in
            guard let light = RGBA(pair.light), let dark = RGBA(pair.dark) else {
                fatalError("DesignSystem: a token value in tokens.json does not parse")
            }
            return TokenPair(light: light, dark: dark)
        }
    }()

    /// A dynamic colour that takes the token's light or dark value from the appearance it is drawn in.
    static func color(_ name: String) -> Color {
        guard let pair = pairs[name] else { fatalError("DesignSystem: no token named \(name)") }
        let native = NSColor(name: nil) { appearance in
            let v = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? pair.dark : pair.light
            return NSColor(srgbRed: v.red, green: v.green, blue: v.blue, alpha: v.alpha)
        }
        return Color(nsColor: native)
    }
}

/// The app's colours, one static member per token.
public enum PardnerColor {
    /// The window's ground.
    public static let bg = Tokens.color("bg")
    /// The sidebar.
    public static let side = Tokens.color("side")
    /// The right-hand panel.
    public static let panel = Tokens.color("panel")
    /// Cards and inputs.
    public static let surface = Tokens.color("surface")
    /// Selection, hover, a raised control.
    public static let raised = Tokens.color("raised")
    /// Separators and borders.
    public static let line = Tokens.color("line")
    /// Body text.
    public static let text = Tokens.color("text")
    /// Secondary text, times, counts.
    public static let muted = Tokens.color("muted")
    /// The workspace rail.
    public static let rail = Tokens.color("rail")
    /// Primary action, links, the person's own marks.
    public static let brand = Tokens.color("brand")
    /// Text on `brand`.
    public static let brandInk = Tokens.color("brand-ink")
    /// A tinted ground for brand marks.
    public static let brandSoft = Tokens.color("brand-soft")
    /// Brand-coloured text on a ground.
    public static let brandText = Tokens.color("brand-text")
    /// The bot: its marks and state.
    public static let agent = Tokens.color("agent")
    /// Text on `agent`.
    public static let agentInk = Tokens.color("agent-ink")
    /// A tinted ground for the bot's marks.
    public static let agentSoft = Tokens.color("agent-soft")
    /// Agent-coloured text on a ground.
    public static let agentText = Tokens.color("agent-text")
    /// Done, healthy.
    public static let okText = Tokens.color("ok-text")
    /// The ground of `okText`.
    public static let okSoft = Tokens.color("ok-soft")
    /// An added line of a diff.
    public static let addBg = Tokens.color("add-bg")
    /// The text of an added line.
    public static let addText = Tokens.color("add-text")
    /// A removed line of a diff.
    public static let delBg = Tokens.color("del-bg")
    /// The text of a removed line.
    public static let delText = Tokens.color("del-text")
    /// Unread and attention counts.
    public static let badge = Tokens.color("badge")
    /// Text on `badge`.
    public static let badgeInk = Tokens.color("badge-ink")
}

/// The radii, the base gap and the answer's width (first-screens decision 5), from the same `tokens.json`.
public enum PardnerMetrics {
    private static var file: Tokens.File { Tokens.file }

    private static func value(_ table: [String: Double], _ name: String) -> CGFloat {
        guard let v = table[name] else { fatalError("DesignSystem: no metric named \(name)") }
        return CGFloat(v)
    }

    /// Buttons, list rows, fields.
    public static let controlRadius = value(file.radii, "control")
    /// Session cards, the composer, the bot's box.
    public static let containerRadius = value(file.radii, "container")
    /// The one base gap; other gaps are multiples or halves of it.
    public static let gap = value(file.spacing, "gap")
    /// The widest a bot's text is read at: its column is capped here, and left-aligned in a panel wider than this.
    public static let answerWidth = value(file.spacing, "answer-width")
}
