// What the sections model decides (sidebar sections design 4, 6, 7): the tree over the held channels, the act each command makes and its
// `before`, the refusals, the outcome sentences, the folds and a channel made from a section. A fake arranger records the acts; no controller runs.
import Conversation
import Foundation
import ProtocolHost
@testable import Relay
@testable import Screens
import XCTest

@MainActor
final class SectionsModelTests: XCTestCase {
    private static func id(_ byte: UInt8) -> Data { Data(repeating: byte, count: 32) }
    private static func hex(_ byte: UInt8) -> String { id(byte).map { String(format: "%02x", $0) }.joined() }

    private final class MemoryDefaults: UserDefaults {
        private var values: [String: Any] = [:]
        init() { super.init(suiteName: nil)! }
        override func set(_ value: Any?, forKey key: String) { values[key] = value }
        override func stringArray(forKey key: String) -> [String]? { values[key] as? [String] }
    }

    private final class Calls {
        var acts: [SectionAct] = []
        var answer: SendOutcome = .queued(name: Data([1]))
        /// While true the arranger does not answer until `release` is called.
        var holding = false
        var release: CheckedContinuation<Void, Never>?
    }

    private struct Rig {
        let conversation: ConversationModel
        let channels: ChannelsModel
        let model: SectionsModel
        let calls: Calls
    }

    private func readDevices() -> DevicesModel {
        var state = DevicesState()
        state.rows = [DeviceRow(id: Self.id(1), kind: .app, label: nil, shortForm: "", adder: .none, position: 0, active: true, isThisMac: true, seenAt: nil,
                                onlyHolderEpochs: 0, addedWhileRemoving: false)]
        return DevicesModel(state: state)
    }

    private func rig(defaults: UserDefaults = MemoryDefaults()) -> Rig {
        let conversation = ConversationModel(), channels = ChannelsModel(devices: readDevices()), calls = Calls()
        let model = SectionsModel(conversation: conversation, channels: channels, defaults: defaults) { act in
            calls.acts.append(act)
            if calls.holding { await withCheckedContinuation { calls.release = $0 } }
            return calls.answer
        }
        return Rig(conversation: conversation, channels: channels, model: model, calls: calls)
    }

    private func hold(_ rig: Rig, _ bytes: UInt8...) {
        for (position, byte) in bytes.enumerated() {
            rig.conversation.apply(.delivered(.object([
                "do": .string("message"), "position": .number(Double(position)), "channel": .bytes(Self.id(byte)), "sender": .bytes(Self.id(9)),
                "name": .bytes(Data([byte])), "time": .number(0), "kind": .number(2),
            ])))
        }
    }

    /// `layout`: each section's id byte, name and channel bytes.
    private func tell(_ rig: Rig, _ layout: [(UInt8, String, [UInt8])]?, current: Bool = true, behind: Bool = false, notApplied: Bool = false) {
        let sections: HostValue = layout.map { .array($0.map { .object(["id": .string(Self.hex($0.0)), "name": .string($0.1), "channels": .array($0.2.map { .string(Self.hex($0)) })]) }) } ?? .null
        rig.conversation.apply(.arrangement(.object(["sections": sections, "current": .bool(current), "behind": .bool(behind), "notApplied": .bool(notApplied)])))
    }

    /// Waits until `condition` holds, polling for at most `timeout` seconds; false when it never did. A test that expects something waits for it,
    /// so the count cannot depend on scheduling; one that expects nothing waits a short time and can only pass wrongly, never fail wrongly.
    private func until(timeout: Double = 2, _ condition: () -> Bool) async -> Bool {
        let end = ContinuousClock.now + .seconds(timeout)
        while !condition(), ContinuousClock.now < end { try? await Task.sleep(for: .milliseconds(5)) }
        return condition()
    }

    private func acts(_ r: Rig, _ count: Int) async { _ = await until { r.calls.acts.count >= count } }
    private func quiet(_ r: Rig) async { _ = await until(timeout: 0.15) { false } }

    // MARK: the tree

    func testTheTreeKeepsHeldChannelsInContentOrderAndTheRestInIdOrder() {
        let r = rig()
        hold(r, 5, 3, 4, 6)
        tell(r, [(0xA1, "Work", [6, 7, 3]), (0xA2, "Empty", []), (0xA3, "Gone", [8])])
        XCTAssertEqual(r.model.tree, .init(sections: [
            .init(id: Self.hex(0xA1), name: "Work", channels: [Self.id(6), Self.id(3)]), // 7 is not held: dropped; content order kept
            .init(id: Self.hex(0xA2), name: "Empty", channels: []),
            .init(id: Self.hex(0xA3), name: "Gone", channels: []),
        ], rest: [Self.id(4), Self.id(5)]))
    }

    func testNoArrangementPutsEveryChannelUnderChannels() {
        let r = rig()
        hold(r, 5, 3)
        XCTAssertEqual(r.model.tree, .init(sections: [], rest: [Self.id(3), Self.id(5)]), "never told")
        tell(r, nil)
        XCTAssertEqual(r.model.tree, .init(sections: [], rest: [Self.id(3), Self.id(5)]), "null")
    }

    func testTheLinesAreTold() {
        let r = rig()
        XCTAssertFalse(r.model.current)
        tell(r, [], current: false, behind: true, notApplied: true)
        XCTAssertEqual([r.model.current, r.model.behind, r.model.notApplied], [false, true, true])
    }

    func testANewConnectionForgetsTheArrangement() {
        let r = rig()
        hold(r, 3)
        tell(r, [(0xA1, "Work", [3])])
        r.conversation.apply(.reset)
        XCTAssertFalse(r.model.current)
        XCTAssertEqual(r.model.tree, .init(sections: [], rest: []))
    }

    // MARK: the acts

    /// The act `body` makes, or nil when it makes none.
    private func act(_ r: Rig, expecting: Bool = true, _ body: () -> Void) async -> SectionAct? {
        r.calls.acts = []
        body()
        if expecting { await acts(r, 1); _ = await until { !r.model.working } } else { await quiet(r) }
        return r.calls.acts.first
    }

    func testEachActIsMadeAsTheLinkTakesIt() async {
        let r = rig()
        hold(r, 3, 4)
        tell(r, [(0xA1, "Work", [3]), (0xA2, "Home", [])])
        var made = await act(r) { r.model.newSection(name: "New") }
        XCTAssertEqual(made, .newSection(name: "New", channel: nil))
        made = await act(r) { r.model.newSection(name: "New", channel: Self.id(4)) }
        XCTAssertEqual(made, .newSection(name: "New", channel: Self.id(4)))
        made = await act(r) { r.model.rename(section: Self.hex(0xA1), to: "Job") }
        XCTAssertEqual(made, .renameSection(section: Self.hex(0xA1), name: "Job"))
        made = await act(r) { r.model.remove(section: Self.hex(0xA1)) }
        XCTAssertEqual(made, .removeSection(section: Self.hex(0xA1)))
        made = await act(r) { r.model.move(channel: Self.id(4), into: Self.hex(0xA2)) }
        XCTAssertEqual(made, .moveChannel(channel: Self.id(4), section: Self.hex(0xA2), before: nil))
        made = await act(r) { r.model.move(channel: Self.id(3), into: nil) }
        XCTAssertEqual(made, .moveChannel(channel: Self.id(3), section: nil, before: nil))
    }

    func testMoveSectionUpAndDownAreTurnedIntoBefore() async {
        let r = rig()
        tell(r, [(0xA1, "a", []), (0xA2, "b", []), (0xA3, "c", []), (0xA4, "d", [])])
        let (a, b, c, d) = (Self.hex(0xA1), Self.hex(0xA2), Self.hex(0xA3), Self.hex(0xA4))
        XCTAssertFalse(r.model.canMove(section: a, .up))
        XCTAssertTrue(r.model.canMove(section: a, .down))
        XCTAssertTrue(r.model.canMove(section: d, .up))
        XCTAssertFalse(r.model.canMove(section: d, .down))
        var made = await act(r, expecting: false) { r.model.move(section: a, .up) }
        XCTAssertNil(made, "up on the first is not offered")
        made = await act(r) { r.model.move(section: c, .up) }
        XCTAssertEqual(made, .moveSection(section: c, before: b))
        made = await act(r) { r.model.move(section: a, .down) }
        XCTAssertEqual(made, .moveSection(section: a, before: c), "the id two below")
        made = await act(r) { r.model.move(section: c, .down) }
        XCTAssertEqual(made, .moveSection(section: c, before: nil), "one below is the last: nil is last")
        made = await act(r, expecting: false) { r.model.move(section: d, .down) }
        XCTAssertNil(made, "down on the last is not offered")
    }

    func testMoveChannelUpAndDownUseTheShownNeighbours() async {
        let r = rig()
        hold(r, 3, 4, 5) // 7 is in the content and not held
        tell(r, [(0xA1, "Work", [3, 7, 4, 5])])
        let s = Self.hex(0xA1)
        XCTAssertFalse(r.model.canMove(channel: Self.id(3), .up))
        XCTAssertFalse(r.model.canMove(channel: Self.id(5), .down))
        var made = await act(r) { r.model.move(channel: Self.id(4), .up) }
        XCTAssertEqual(made, .moveChannel(channel: Self.id(4), section: s, before: Self.id(3)))
        made = await act(r) { r.model.move(channel: Self.id(3), .down) }
        XCTAssertEqual(made, .moveChannel(channel: Self.id(3), section: s, before: Self.id(5)), "two below among the shown, the unheld one skipped")
        made = await act(r) { r.model.move(channel: Self.id(4), .down) }
        XCTAssertEqual(made, .moveChannel(channel: Self.id(4), section: s, before: nil))
        made = await act(r, expecting: false) { r.model.move(channel: Self.id(3), .up) }
        XCTAssertNil(made)
    }

    func testAChannelUnderChannelsHasNoOrder() {
        let r = rig()
        hold(r, 3, 4)
        tell(r, [])
        XCTAssertFalse(r.model.canMove(channel: Self.id(3), .down))
        XCTAssertFalse(r.model.canMove(channel: Self.id(4), .up))
    }

    func testNoActIsCalledWhileNotCurrent() async {
        let r = rig()
        hold(r, 3)
        tell(r, [(0xA1, "a", [3]), (0xA2, "b", [])], current: false)
        r.model.newSection(name: "x")
        r.model.rename(section: Self.hex(0xA1), to: "y")
        r.model.remove(section: Self.hex(0xA1))
        r.model.move(section: Self.hex(0xA1), .down)
        r.model.move(channel: Self.id(3), into: nil)
        await quiet(r)
        XCTAssertTrue(r.calls.acts.isEmpty)
        XCTAssertFalse(r.model.working)
    }

    func testAnActInFlightTakesNoSecond() async {
        let r = rig()
        tell(r, [])
        r.model.newSection(name: "a")
        r.model.newSection(name: "b")
        await acts(r, 1)
        await quiet(r)
        XCTAssertEqual(r.calls.acts, [.newSection(name: "a", channel: nil)])
    }

    // MARK: the outcomes

    func testOnlyAQueuedAnswerCountsAsMade() {
        let r = rig()
        let named = SectionAct.newSection(name: "x")
        r.model.finish(.queued(name: Data([1])), for: named)
        XCTAssertTrue(r.model.queued)
        r.model.finish(.refused("not-ready"), for: named)
        XCTAssertFalse(r.model.queued, "a name field keeps its text on not-ready")
    }

    func testAProblemCanBeCleared() {
        let r = rig()
        r.model.finish(.ended, for: .newSection(name: "x"))
        XCTAssertNotNil(r.model.problem)
        r.model.clearProblem()
        XCTAssertNil(r.model.problem)
    }

    func testOutcomesBecomeSentencesOrNothing() {
        let r = rig()
        let named = SectionAct.newSection(name: "x"), moved = SectionAct.moveSection(section: "a", before: nil)
        r.model.finish(.queued(name: Data([1])), for: named)
        XCTAssertNil(r.model.problem)
        r.model.finish(.refused("not-ready"), for: named)
        XCTAssertNil(r.model.problem, "the person acts again once current")
        r.model.finish(.refused("too-many"), for: named)
        XCTAssertEqual(r.model.problem, "There are too many sections, or too many channels in sections. Remove some and try again.")
        r.model.finish(.refused("bad-input"), for: named)
        XCTAssertEqual(r.model.problem, "Use up to 64 characters, with no hidden characters.", "the device name's sentence")
        r.model.finish(.refused("bad-input"), for: .renameSection(section: "a", name: ""))
        XCTAssertEqual(r.model.problem, "Use up to 64 characters, with no hidden characters.")
        r.model.finish(.refused("bad-input"), for: moved)
        XCTAssertEqual(r.model.problem, "This section or channel changed on another device. Try again.")
        r.model.finish(.notSaved, for: moved)
        XCTAssertEqual(r.model.problem, "Pardner could not save the change. Try again.")
        r.model.finish(.ended, for: moved)
        XCTAssertEqual(r.model.problem, "Pardner is not connected. Try again in a moment.")
        XCTAssertFalse(r.model.working)
    }

    func testTheProblemGoesWithTheNextAct() async {
        let r = rig()
        tell(r, [])
        r.calls.answer = .refused("too-many")
        r.model.newSection(name: "a")
        _ = await until { r.model.problem != nil }
        XCTAssertNotNil(r.model.problem)
        r.calls.answer = .queued(name: Data([1]))
        r.model.newSection(name: "b")
        XCTAssertNil(r.model.problem)
    }

    // MARK: folds

    func testFoldsSurviveANewModelOnTheSameDefaults() {
        let defaults = MemoryDefaults()
        let first = rig(defaults: defaults).model
        first.toggleFold("a1")
        first.toggleFold("a2")
        first.toggleFold("a1")
        XCTAssertFalse(first.isFolded("a1"))
        let second = rig(defaults: defaults).model
        XCTAssertTrue(second.isFolded("a2"))
        XCTAssertFalse(second.isFolded("a1"))
    }

    func testAFoldSendsNothing() async {
        let r = rig()
        tell(r, [(0xA1, "a", [])])
        r.model.toggleFold(Self.hex(0xA1))
        await quiet(r)
        XCTAssertTrue(r.calls.acts.isEmpty)
    }

    // MARK: a channel made from a section

    func testNewChannelInASectionOpensTheSheetWithItAndOnlyThenMovesIt() async {
        let r = rig()
        tell(r, [(0xA1, "Work", [])])
        r.channels.present = {}
        r.channels.openNew(in: Self.hex(0xA1))
        r.channels.finishCreate(.created(channel: Self.id(3)))
        await quiet(r)
        XCTAssertTrue(r.calls.acts.isEmpty, "the channel is not in the reading yet")
        hold(r, 3)
        await acts(r, 1)
        XCTAssertEqual(r.calls.acts, [.moveChannel(channel: Self.id(3), section: Self.hex(0xA1), before: nil)])
        hold(r, 3)
        tell(r, [(0xA1, "Work", [3])])
        await quiet(r)
        XCTAssertEqual(r.calls.acts.count, 1, "once")
    }

    func testAChannelMadeWhileNotCurrentIsMovedOnceCurrent() async {
        let r = rig()
        tell(r, [(0xA1, "Work", [])], current: false)
        r.channels.present = {}
        r.channels.openNew(in: Self.hex(0xA1))
        r.channels.finishCreate(.created(channel: Self.id(3)))
        hold(r, 3)
        await quiet(r)
        XCTAssertTrue(r.calls.acts.isEmpty)
        tell(r, [(0xA1, "Work", [])], current: true)
        await acts(r, 1)
        XCTAssertEqual(r.calls.acts, [.moveChannel(channel: Self.id(3), section: Self.hex(0xA1), before: nil)])
    }

    func testAMoveThatIsNotFinalIsTriedAgainAtTheNextSettle() async {
        for answer in [SendOutcome.refused("not-ready"), .notSaved, .ended] {
            let r = rig()
            tell(r, [(0xA1, "Work", [])])
            r.calls.answer = answer
            r.channels.present = {}
            r.channels.openNew(in: Self.hex(0xA1))
            r.channels.finishCreate(.created(channel: Self.id(3)))
            hold(r, 3)
            await acts(r, 1)
            await quiet(r)
            XCTAssertEqual(r.calls.acts.count, 1, "\(answer): no loop of its own")
            r.calls.answer = .queued(name: Data([1]))
            tell(r, [(0xA1, "Work", [])]) // current again
            await acts(r, 2)
            await quiet(r)
            XCTAssertEqual(r.calls.acts.count, 2, "\(answer): exactly one more, then forgotten")
            tell(r, [(0xA1, "Work", [3])])
            await quiet(r)
            XCTAssertEqual(r.calls.acts.count, 2)
        }
    }

    func testARefusalThatIsFinalForgetsTheChannel() async {
        for reason in ["bad-input", "too-many"] {
            let r = rig()
            tell(r, [(0xA1, "Work", [])])
            r.calls.answer = .refused(reason)
            r.channels.present = {}
            r.channels.openNew(in: Self.hex(0xA1))
            r.channels.finishCreate(.created(channel: Self.id(3)))
            hold(r, 3)
            await acts(r, 1)
            await quiet(r)
            tell(r, [(0xA1, "Work", [])])
            await quiet(r)
            XCTAssertEqual(r.calls.acts.count, 1, reason)
        }
    }

    func testASettleWhileAMoveIsInFlightMakesNoSecondMove() async {
        let r = rig()
        tell(r, [(0xA1, "Work", [])])
        r.calls.holding = true
        r.channels.present = {}
        r.channels.openNew(in: Self.hex(0xA1))
        r.channels.finishCreate(.created(channel: Self.id(3)))
        hold(r, 3)
        await acts(r, 1)
        tell(r, [(0xA1, "Work", [])]) // events before the move's answer
        tell(r, [(0xA1, "Work", [])])
        await quiet(r)
        XCTAssertEqual(r.calls.acts.count, 1)
        r.calls.holding = false
        r.calls.release?.resume()
        await quiet(r)
        tell(r, [(0xA1, "Work", [3])])
        await quiet(r)
        XCTAssertEqual(r.calls.acts.count, 1, "answered queued: done")
    }

    func testASectionGoneBeforeTheChannelShowsLeavesItUnderChannels() async {
        let r = rig()
        tell(r, [(0xA1, "Work", [])])
        r.channels.present = {}
        r.channels.openNew(in: Self.hex(0xA1))
        r.channels.finishCreate(.created(channel: Self.id(3)))
        tell(r, [])
        hold(r, 3)
        await quiet(r)
        XCTAssertTrue(r.calls.acts.isEmpty)
        tell(r, [(0xA1, "Work", [])]) // forgotten: a section by that id coming back does not claim it
        await quiet(r)
        XCTAssertTrue(r.calls.acts.isEmpty)
    }

    func testAChannelMadeOutsideASectionIsNotMoved() async {
        let r = rig()
        tell(r, [(0xA1, "Work", [])])
        r.channels.present = {}
        r.channels.openNew(in: Self.hex(0xA1))
        r.channels.close()
        r.channels.present = {}
        r.channels.openNew()
        r.channels.finishCreate(.created(channel: Self.id(3)))
        hold(r, 3)
        await quiet(r)
        XCTAssertTrue(r.calls.acts.isEmpty, "the section of a closed sheet is not carried to the next")
    }
}
