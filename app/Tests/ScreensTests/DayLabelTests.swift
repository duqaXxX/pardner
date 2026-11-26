// The day separators' words (window redesign, unit 1b): Today, Yesterday, else the date, over a fixed calendar and time zone.
import Foundation
@testable import Screens
import XCTest

final class DayLabelTests: XCTestCase {
    private let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(secondsFromGMT: 0)!
        c.locale = Locale(identifier: "en_US")
        return c
    }()

    /// A moment of `day` in November 2026 (UTC) at `hour`.
    private func at(_ day: Int, hour: Int = 12, year: Int = 2026, month: Int = 11) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
    }

    func testTheDaySaysTodayYesterdayOrTheDate() {
        let now = at(22, hour: 9)
        XCTAssertEqual(Naming.day(at(22, hour: 0), now: now, calendar: calendar), "Today")
        XCTAssertEqual(Naming.day(at(21, hour: 23), now: now, calendar: calendar), "Yesterday")
        XCTAssertEqual(Naming.day(at(20), now: now, calendar: calendar), "Nov 20, 2026")
    }

    func testAYearsChangeShowsTheOlderYear() {
        let now = at(2, month: 1)
        XCTAssertEqual(Naming.day(at(1, month: 1), now: now, calendar: calendar), "Yesterday")
        XCTAssertEqual(Naming.day(at(31, year: 2025, month: 12), now: now, calendar: calendar), "Dec 31, 2025")
    }

    func testOneSeparatorFollowsEachChangeOfDay() {
        let now = at(22)
        let times: [Date?] = [at(20, hour: 8), at(20, hour: 9), nil, at(21, hour: 23), at(22, hour: 0), at(22, hour: 5)]
        XCTAssertEqual(Naming.dayLabels(times, now: now, calendar: calendar), ["Nov 20, 2026", nil, nil, "Yesterday", "Today", nil])
    }

    func testTheSameMessagesReadYesterdayOnceTheDayChanges() {
        let times: [Date?] = [at(22, hour: 8)]
        XCTAssertEqual(Naming.dayLabels(times, now: at(22, hour: 23), calendar: calendar), ["Today"])
        XCTAssertEqual(Naming.dayLabels(times, now: at(23, hour: 1), calendar: calendar), ["Yesterday"])
    }
}

final class TimeOfDayTests: XCTestCase {
    private func time(_ hour: Int, _ minute: Int, locale: String) -> String {
        let utc = TimeZone(secondsFromGMT: 0)!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        let date = calendar.date(from: DateComponents(year: 2026, month: 11, day: 26, hour: hour, minute: minute))!
        return Naming.time(date, locale: Locale(identifier: locale), timeZone: utc)
    }

    func testTheHourHasTwoDigitsWhereTheMacCountsIn24Hours() {
        XCTAssertEqual(time(0, 34, locale: "en_GB"), "00:34")
        XCTAssertEqual(time(1, 58, locale: "en_GB"), "01:58")
        XCTAssertEqual(time(17, 5, locale: "en_GB"), "17:05")
        XCTAssertEqual(time(1, 53, locale: "en_IT"), "01:53", "the system's short style wrote 1:53 there")
    }

    func testTheHourKeepsTwoDigitsInTheTwelveHourClockToo() {
        XCTAssertTrue(time(1, 58, locale: "en_US").hasPrefix("01:58"), time(1, 58, locale: "en_US"))
        XCTAssertTrue(time(0, 34, locale: "en_US").hasPrefix("12:34"), time(0, 34, locale: "en_US"))
    }
}
