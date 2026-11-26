// The sidebar's usage boxes (visual pass, #174): the listed bots grouped by the login they run under, one box per account, each with its
// 5-hour and 7-day windows. The words are the app's own; the numbers are the newest `usage` the bots of the account wrote.
import Foundation

/// One box of the sidebar: an account, or a bot that has no login to share.
public struct UsageBox: Equatable, Sendable {
    /// One window's line: its words, its share (for the bar) and when it resets, when that is ahead.
    public struct Row: Equatable, Sendable {
        public let label: String
        public let percent: Double
        public let resets: String?
    }

    /// The login's email, or the bot's name when the box is the bot's own.
    public let title: String
    /// The account's plan; `API` for a bot with no plan.
    public let plan: String
    /// The newest usage of the account that carries a window; nil for an API box and for a plan whose windows are not read yet.
    public let usage: SessionUsage?

    public init(title: String, plan: String, usage: SessionUsage?) { (self.title, self.plan, self.usage) = (title, plan, usage) }

    /// The boxes of `bots` in their order: those with a plan grouped by `account` (a bot with no account on its own, titled by its name), a
    /// bot with no plan that wrote a cost (`apiBots`) as an `API` box, a bot whose profile is not read, or has neither, in none.
    public static func boxes(bots: [(id: Data, name: String, profile: BotProfile?)], windows: [Data: SessionUsage], apiBots: Set<Data>) -> [UsageBox] {
        var order: [String] = []
        var found: [String: UsageBox] = [:]
        for bot in bots {
            guard let profile = bot.profile else { continue }
            let key: String, box: UsageBox
            if let plan = profile.plan {
                // The id keeps two bots with no login apart from each other, and from a login named like a bot.
                key = profile.account.map { "account:\($0)" } ?? "bot:\(bot.id.base64EncodedString())"
                // The plan is that of the bot whose usage the box draws, the newest by `at`; with no usage yet, the first bot listed.
                let mine = windows[bot.id]
                if let kept = found[key], !(mine.map { $0.at > kept.usage?.at ?? -.infinity } ?? false) {
                    box = kept
                } else {
                    box = UsageBox(title: profile.account ?? bot.name, plan: plan, usage: mine)
                }
            } else if apiBots.contains(bot.id) {
                key = "bot:\(bot.id.base64EncodedString())"
                box = UsageBox(title: bot.name, plan: "API", usage: nil)
            } else {
                continue
            }
            if found[key] == nil { order.append(key) }
            found[key] = box
        }
        return order.compactMap { found[$0] }
    }

    /// A row for each window the usage knows, the 5-hour one first; the reset is left out when it has passed or is unknown.
    public func rows(now: Date) -> [Row] {
        guard let usage else { return [] }
        let nowMs = now.timeIntervalSince1970 * 1000
        return [("5 hours", usage.session), ("7 days", usage.week)].compactMap { name, window in
            window.map { w in
                Row(label: "\(name) · \(Int(w.percent.rounded()))%", percent: w.percent,
                    resets: w.resetsAt.flatMap { $0 > nowMs ? "Resets in " + UsageLine.until($0 - nowMs) : nil })
            }
        }
    }
}
