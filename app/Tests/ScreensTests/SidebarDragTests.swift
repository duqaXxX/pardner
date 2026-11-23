// Where a drop lands (sidebar sections design 7, "The drag"): the act each dragged item and hovered place make, from the shown order alone.
import Foundation
@testable import Relay
@testable import Screens
import XCTest

final class SidebarDragTests: XCTestCase {
    private static func id(_ byte: UInt8) -> Data { Data([byte]) }
    private let a = id(1), b = id(2), c = id(3), d = id(4)
    /// Section "s1" holds a, b; "s2" holds c; "Channels" holds d.
    private var tree: SectionsModel.Tree {
        SectionsModel.Tree(sections: [.init(id: "s1", name: "One", channels: [a, b]), .init(id: "s2", name: "Two", channels: [c])], rest: [d])
    }

    private func act(_ item: SidebarDrag.Item, _ place: SidebarDrag.Place, current: Bool = true) -> SectionAct? {
        SidebarDrag.act(dragging: item, onto: place, in: tree, current: current)
    }

    func testChannelOnAHeaderGoesLastInTheSection() {
        XCTAssertEqual(act(.channel(d), .header("s1", below: false)), .moveChannel(channel: d, section: "s1", before: nil))
        XCTAssertEqual(act(.channel(a), .header("s1", below: true)), .moveChannel(channel: a, section: "s1", before: nil))
        XCTAssertNil(act(.channel(b), .header("s1", below: false)), "already last")
    }

    func testChannelBetweenRowsLandsBeforeTheRowBelow() {
        XCTAssertEqual(act(.channel(c), .row(a, below: false)), .moveChannel(channel: c, section: "s1", before: a))
        XCTAssertEqual(act(.channel(c), .row(a, below: true)), .moveChannel(channel: c, section: "s1", before: b))
        XCTAssertEqual(act(.channel(c), .row(b, below: true)), .moveChannel(channel: c, section: "s1", before: nil), "below the last row: last")
        XCTAssertEqual(act(.channel(b), .row(a, below: false)), .moveChannel(channel: b, section: "s1", before: a))
    }

    func testAChannelWhereItAlreadyIsDoesNothing() {
        XCTAssertNil(act(.channel(a), .row(a, below: false)))
        XCTAssertNil(act(.channel(a), .row(a, below: true)))
        XCTAssertNil(act(.channel(a), .row(b, below: false)), "directly above b already")
        XCTAssertNil(act(.channel(b), .row(b, below: true)))
        XCTAssertNil(act(.channel(d), .channels), "already under Channels")
    }

    func testAChannelLeavesItsSectionOnChannelsHeaderOrRows() {
        XCTAssertEqual(act(.channel(a), .channels), .moveChannel(channel: a, section: nil, before: nil))
    }

    func testAChannelFromChannelsGoesIntoASection() {
        XCTAssertEqual(act(.channel(d), .row(c, below: false)), .moveChannel(channel: d, section: "s2", before: c))
    }

    func testSectionsReorderOnHeaders() {
        XCTAssertEqual(act(.section("s2"), .header("s1", below: false)), .moveSection(section: "s2", before: "s1"))
        XCTAssertEqual(act(.section("s1"), .header("s2", below: true)), .moveSection(section: "s1", before: nil))
        XCTAssertEqual(act(.section("s1"), .channels), .moveSection(section: "s1", before: nil))
        XCTAssertNil(act(.section("s2"), .channels), "already last")
    }

    func testASectionOnItselfOrWhereItIsDoesNothing() {
        XCTAssertNil(act(.section("s1"), .header("s1", below: false)))
        XCTAssertNil(act(.section("s1"), .header("s1", below: true)))
        XCTAssertNil(act(.section("s1"), .header("s2", below: false)), "directly above s2 already")
    }

    func testASectionIsRefusedOnARow() {
        XCTAssertNil(act(.section("s1"), .row(c, below: false)))
    }

    func testNothingWhileNotCurrentOrForAnUnknownItem() {
        XCTAssertNil(act(.channel(d), .header("s1", below: false), current: false))
        XCTAssertNil(act(.section("s2"), .header("s1", below: false), current: false))
        XCTAssertNil(act(.channel(Self.id(9)), .channels))
        XCTAssertNil(act(.section("gone"), .channels))
    }

    /// The place a zone makes of the pointer's height: the path where a row's lower half once landed before the row.
    func testARowsHalvesPickBeforeItOrBeforeTheRowBelow() {
        let zone = SidebarDrag.Zone.row(a)
        XCTAssertEqual(zone.place(.channel(c), y: 5, height: 30), .row(a, below: false))
        XCTAssertEqual(zone.place(.channel(c), y: 25, height: 30), .row(a, below: true))
        XCTAssertEqual(act(.channel(c), zone.place(.channel(c), y: 25, height: 30)), .moveChannel(channel: c, section: "s1", before: b))
        XCTAssertEqual(act(.channel(c), SidebarDrag.Zone.row(b).place(.channel(c), y: 25, height: 30)), .moveChannel(channel: c, section: "s1", before: nil))
    }

    func testAHeadersHalvesCountForASectionOnly() {
        let zone = SidebarDrag.Zone.header("s1")
        XCTAssertEqual(zone.place(.section("s2"), y: 25, height: 30), .header("s1", below: true))
        XCTAssertEqual(zone.place(.section("s2"), y: 5, height: 30), .header("s1", below: false))
        XCTAssertEqual(zone.place(.channel(c), y: 25, height: 30), .header("s1", below: false))
        XCTAssertTrue(SidebarDrag.Zone.row(a).halves(.channel(c)))
        XCTAssertFalse(SidebarDrag.Zone.channels.halves(.section("s1")))
        XCTAssertEqual(SidebarDrag.Zone.channels.place(.channel(a), y: 25, height: 30), .channels)
    }

    /// An empty section's `No channels` row takes a channel into the section, on either half, and refuses a section, whose line would
    /// show inside the section.
    func testAnEmptySectionsRowTakesAChannelAndRefusesASection() {
        let empty = SectionsModel.Tree(sections: [.init(id: "s1", name: "One", channels: [a]), .init(id: "s3", name: "Empty", channels: [])], rest: [d])
        let zone = SidebarDrag.Zone.empty("s3")
        XCTAssertFalse(zone.halves(.section("s1")))
        XCTAssertEqual(zone.place(.channel(d), y: 25, height: 30), .empty("s3"))
        XCTAssertEqual(SidebarDrag.act(dragging: .channel(d), onto: zone.place(.channel(d), y: 5, height: 30), in: empty, current: true),
                       .moveChannel(channel: d, section: "s3", before: nil))
        XCTAssertEqual(SidebarDrag.act(dragging: .channel(a), onto: .empty("s3"), in: empty, current: true), .moveChannel(channel: a, section: "s3", before: nil))
        XCTAssertNil(SidebarDrag.act(dragging: .section("s1"), onto: zone.place(.section("s1"), y: 5, height: 30), in: empty, current: true))
        XCTAssertNil(SidebarDrag.act(dragging: .channel(d), onto: .empty("s3"), in: empty, current: false))
    }

    func testTheItemSurvivesItsProvider() throws {
        for item in [SidebarDrag.Item.channel(a), .section("s1")] { XCTAssertEqual(try SidebarDrag.Item(data: item.data), item) }
        XCTAssertThrowsError(try SidebarDrag.Item(data: Data("x".utf8)))
    }
}
