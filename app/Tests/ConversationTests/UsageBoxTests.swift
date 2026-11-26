// The sidebar's usage boxes (visual pass, #174, unit A): the listed bots grouped by the login they run under, and the words of one box.
// Synthetic accounts, shaped as a bot's profile and usage reach the reading model.
@testable import Conversation
import Foundation
import XCTest

final class UsageBoxTests: XCTestCase {
    private func bot(_ byte: UInt8, _ name: String, account: String? = nil, plan: String? = nil, read: Bool = true) -> (id: Data, name: String, profile: BotProfile?) {
        (Data(repeating: byte, count: 32), name, read ? BotProfile(name: name, account: account, plan: plan, icon: nil) : nil)
    }

    private func usage(at: Double, session: Double? = nil, week: Double? = nil, resets: Double? = nil, cost: Double? = nil) -> SessionUsage {
        SessionUsage(at: at, session: session.map { UsageWindow(percent: $0, resetsAt: resets) }, week: week.map { UsageWindow(percent: $0, resetsAt: nil) }, cost: cost)
    }

    func testTwoBotsOnOneAccountShareABoxThatDrawsTheNewestUsage() {
        let (mini, studio) = (bot(1, "mini", account: "owner@example.com", plan: "Claude Max"), bot(2, "studio", account: "owner@example.com", plan: "Claude Max"))
        let boxes = UsageBox.boxes(bots: [mini, studio], windows: [mini.id: usage(at: 2_000, session: 80), studio.id: usage(at: 3_000, session: 5)], apiBots: [])
        XCTAssertEqual(boxes.count, 1)
        XCTAssertEqual(boxes[0].title, "owner@example.com")
        XCTAssertEqual(boxes[0].plan, "Claude Max")
        XCTAssertEqual(boxes[0].usage?.session?.percent, 5, "the newest by `at`, whichever bot wrote it")
    }

    func testTheSharedBoxTakesThePlanOfTheBotWhoseUsageItDraws() {
        let (mini, studio) = (bot(1, "mini", account: "owner@example.com", plan: "Claude Pro"), bot(2, "studio", account: "owner@example.com", plan: "Claude Max"))
        let drawn = UsageBox.boxes(bots: [mini, studio], windows: [mini.id: usage(at: 2_000, session: 80), studio.id: usage(at: 3_000, session: 5)], apiBots: [])
        XCTAssertEqual(drawn.map(\.plan), ["Claude Max"], "the later-listed bot wrote the newer usage")
        let older = UsageBox.boxes(bots: [mini, studio], windows: [mini.id: usage(at: 3_000, session: 80), studio.id: usage(at: 2_000, session: 5)], apiBots: [])
        XCTAssertEqual(older.map(\.plan), ["Claude Pro"], "the first-listed bot wrote the newer usage")
        let none = UsageBox.boxes(bots: [mini, studio], windows: [:], apiBots: [])
        XCTAssertEqual(none.map(\.plan), ["Claude Pro"], "no usage: the first bot listed")
    }

    func testTwoAccountsAreTwoBoxesInTheBotsOrder() {
        let boxes = UsageBox.boxes(bots: [bot(1, "mini", account: "b@example.com", plan: "Claude Pro"), bot(2, "studio", account: "a@example.com", plan: "Claude Max")], windows: [:], apiBots: [])
        XCTAssertEqual(boxes.map(\.title), ["b@example.com", "a@example.com"])
        XCTAssertNil(boxes[0].usage, "a plan with no window read yet: the box with no bars")
    }

    func testABotWithAPlanAndNoAccountHasABoxNamedByTheBot() {
        let boxes = UsageBox.boxes(bots: [bot(1, "mini", plan: "Claude Max"), bot(2, "studio", plan: "Claude Max")], windows: [:], apiBots: [])
        XCTAssertEqual(boxes.map(\.title), ["mini", "studio"], "no shared login to group by")
    }

    func testABotWithNoPlanThatCostedGetsAnAPIBoxWithNoBars() {
        let api = bot(1, "mini")
        let boxes = UsageBox.boxes(bots: [api], windows: [api.id: usage(at: 1, session: 10)], apiBots: [api.id])
        XCTAssertEqual(boxes, [UsageBox(title: "mini", plan: "API", usage: nil)])
    }

    func testABotWithNoPlanAndNoCostHasNoBox() {
        XCTAssertEqual(UsageBox.boxes(bots: [bot(1, "mini")], windows: [:], apiBots: []), [])
    }

    func testABotWhoseProfileIsNotReadHasNoBox() {
        let unread = bot(1, "mini", read: false)
        XCTAssertEqual(UsageBox.boxes(bots: [unread], windows: [unread.id: usage(at: 1, session: 10)], apiBots: [unread.id]), [])
    }

    func testNoBotsNoBoxes() {
        XCTAssertEqual(UsageBox.boxes(bots: [], windows: [:], apiBots: []), [])
    }

    private let now = Date(timeIntervalSince1970: 1_764_000_000)

    func testTheRowsNameEachKnownWindowWithItsResetWhenItIsAhead() {
        let box = UsageBox(title: "owner@example.com", plan: "Claude Max", usage: usage(at: 1_763_999_820_000, session: 39.6, week: 35, resets: 1_764_007_500_000))
        XCTAssertEqual(box.rows(now: now), [
            UsageBox.Row(label: "5 hours \u{B7} 40%", percent: 39.6, resets: "Resets in 2h"),
            UsageBox.Row(label: "7 days \u{B7} 35%", percent: 35, resets: nil),
        ])
    }

    func testAResetThatHasPassedAndAnUnknownWindowAreLeftOut() {
        let box = UsageBox(title: "owner@example.com", plan: "Claude Max", usage: usage(at: 1_763_999_820_000, session: 10, resets: 1_763_990_000_000))
        XCTAssertEqual(box.rows(now: now), [UsageBox.Row(label: "5 hours \u{B7} 10%", percent: 10, resets: nil)])
        XCTAssertEqual(UsageBox(title: "mini", plan: "API", usage: nil).rows(now: now), [])
    }

    func testAsOfFollowsWhenTheDrawnUsageIsMoreThanTenMinutesOld() {
        let box = UsageBox(title: "owner@example.com", plan: "Claude Max", usage: usage(at: 1_763_999_820_000, session: 40))
        let utc = TimeZone(identifier: "UTC")!
        XCTAssertNil(box.asOf(now: now, timeZone: utc), "three minutes old")
        XCTAssertEqual(box.asOf(now: Date(timeIntervalSince1970: 1_764_000_600.001), timeZone: utc), "as of 15:57")
        XCTAssertNil(UsageBox(title: "mini", plan: "API", usage: nil).asOf(now: now, timeZone: utc))
    }
}
