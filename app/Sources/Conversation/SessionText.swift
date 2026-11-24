// The texts of the session's bot that carry no words of their own: a work's end and the session's title (step D2 design, 3.1 and 3.2).
import Foundation

/// A JSON number as a `Double`; nil for anything else, a boolean included (Foundation bridges `true` to 1).
func number(_ value: Any?) -> Double? {
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    return n.doubleValue
}

/// A limit window of the agent's login: the share used, and when it resets (epoch milliseconds), when that is known.
public struct UsageWindow: Sendable, Equatable {
    public let percent: Double
    public let resetsAt: Double?

    // Bounds a bot's numbers must keep, so that no value drawn later overflows an `Int`: a share up to
    // a million percent, and a moment before the year 10000.
    static let most = 1_000_000.0
    static let moments = 0.0...253_402_300_800_000.0

    /// A window of `percent` that resets at `resetsAt` (epoch milliseconds), when known.
    public init(percent: Double, resetsAt: Double?) { (self.percent, self.resetsAt) = (percent, resetsAt) }

    /// Nil for a value that is not `{ percent, resetsAt }` with a number or null reset.
    init?(_ value: Any) {
        guard let o = value as? [String: Any], let percent = number(o["percent"]), let reset = o["resetsAt"] else { return nil }
        guard reset is NSNull || number(reset) != nil, (0...UsageWindow.most).contains(percent) else { return nil }
        if let time = number(reset), !UsageWindow.moments.contains(time) { return nil }
        (self.percent, resetsAt) = (percent, number(reset))
    }
}

/// The account's values at a work's end: `at` is the bot's clock (epoch milliseconds), which orders them.
public struct SessionUsage: Sendable, Equatable {
    public let at: Double
    public let session: UsageWindow?
    public let week: UsageWindow?
    /// The session's estimated cost in US dollars, which the bot writes only for an account with no plan.
    public let cost: Double?

    // The most a cost can be and still draw: no more than a billion dollars.
    static let costs = 0.0...1_000_000_000.0

    /// Usage read at `at` (epoch milliseconds).
    public init(at: Double, session: UsageWindow?, week: UsageWindow?, cost: Double? = nil) { (self.at, self.session, self.week, self.cost) = (at, session, week, cost) }

    /// Nil unless `value` has a numeric `at`, and each window and the cost are null, absent or well formed, with at least one present.
    init?(_ value: Any?) {
        guard let o = value as? [String: Any], let at = number(o["at"]), UsageWindow.moments.contains(at) else { return nil }
        func window(_ key: String) -> UsageWindow?? {
            guard let v = o[key], !(v is NSNull) else { return .some(nil) }
            return UsageWindow(v).map { .some($0) }
        }
        func money() -> Double?? {
            guard let v = o["cost"], !(v is NSNull) else { return .some(nil) }
            guard let d = number(v), SessionUsage.costs.contains(d) else { return nil }
            return .some(d == 0 ? 0 : d) // -0 reads as 0, never `$-0.00`
        }
        guard let session = window("session"), let week = window("week"), let cost = money(), session != nil || week != nil || cost != nil else { return nil }
        (self.at, self.session, self.week, self.cost) = (at, session, week, cost)
    }

    /// Whether the usage carries a 5-hour or a weekly window.
    public var hasWindow: Bool { session != nil || week != nil }
}

/// What the app takes from a kind 1 of the session's bot with `say` `footer` or `title`; whether it counts is the thread's to decide.
public enum SessionText: Sendable, Equatable {
    /// A work's end: its length (nil when none is known), the session's line and the usage, each nil when absent or not of its shape.
    case footer(duration: String?, session: String?, usage: SessionUsage?)
    /// The session's title; nil when empty.
    case title(String?)

    init?(_ o: [String: Any], markdown: String) {
        switch o["say"] as? String {
        case "footer": self = .footer(duration: markdown.isEmpty ? nil : markdown, session: o["session"] as? String, usage: SessionUsage(o["usage"]))
        case "title": self = .title(markdown.isEmpty ? nil : markdown)
        default: return nil
        }
    }
}

/// The account's line, under a thread's composer and in Settings, Bots (step D3 design, 3.3): `Claude Max · 5h 40% ↻ 2h · 7d 24%`, or
/// `API · $1.84 this session` for an account with no plan.
public enum UsageLine {
    public enum Place: String, Sendable { case composer, bots }

    /// Nil for no line. `windows` is the bot's newest usage that carries a window, `cost` the thread's own newest that carries a cost, and
    /// `apiSeen` whether any usage of the bot carried one. Each part is left out when not known; a `↻` whose reset has passed is left out,
    /// and `as of` follows when the usage the line draws is more than 10 minutes old.
    public static func text(profileRead: Bool, plan: String?, windows: SessionUsage?, cost: SessionUsage?, apiSeen: Bool, place: Place, now: Date, timeZone: TimeZone) -> String? {
        guard profileRead else { return nil }
        let nowMs = now.timeIntervalSince1970 * 1000
        var parts: [String]
        var drawn: SessionUsage?
        if let plan {
            parts = [plan]
            drawn = windows
            if let windows {
                parts += [("5h", windows.session), ("7d", windows.week)].compactMap { name, window in
                    window.map { w -> String in
                        var out = "\(name) \(Int(w.percent.rounded()))%"
                        if let reset = w.resetsAt, reset > nowMs { out += " ↻ " + until(reset - nowMs) }
                        return out
                    }
                }
            }
        } else {
            // A profile is written with no account before the bot knows it: `API` needs a cost seen from that bot.
            guard apiSeen else { return nil }
            parts = ["API"]
            if place == .composer, let cost, let amount = cost.cost {
                parts.append(String(format: "$%.2f this session", amount))
                drawn = cost
            }
        }
        if let drawn, nowMs - drawn.at > 600_000 {
            let at = DateFormatter()
            (at.locale, at.timeZone, at.dateFormat) = (Locale(identifier: "en_US_POSIX"), timeZone, "HH:mm")
            parts.append("as of " + at.string(from: Date(timeIntervalSince1970: drawn.at / 1000)))
        }
        return parts.joined(separator: " · ")
    }

    /// The core's `formatUntil` (`src/core/footer.ts`): minutes under 60, hours under 48, then days and hours.
    static func until(_ delta: Double) -> String {
        let minutes = max(0, Int(delta / 60_000))
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 48 { return "\(hours)h" }
        return hours % 24 == 0 ? "\(hours / 24)d" : "\(hours / 24)d \(hours % 24)h"
    }
}
