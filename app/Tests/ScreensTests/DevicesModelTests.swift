// What the Devices model decides between the controller's states (device pairing design 3.4, 3.6, 3.9): which acts it offers, the add
// flow's states, the removal's choices and warning, and the words a row carries. Over fixed states and the outcomes the model's own
// methods take; no controller runs.
import Conversation
import Foundation
import ProtocolHost
@testable import Relay
@testable import Screens
import XCTest

@MainActor
final class DevicesModelTests: XCTestCase {
    private static func id(_ byte: UInt8) -> Data { Data(repeating: byte, count: 32) }

    private func row(_ byte: UInt8, kind: DeviceKind = .app, label: String? = nil, adder: DeviceAdder = .none, position: Int, active: Bool = true,
                     thisMac: Bool = false, onlyHolder: Int = 0, seen: Date? = nil) -> DeviceRow {
        DeviceRow(id: Self.id(byte), kind: kind, label: label, shortForm: Array(repeating: String(repeating: "\(byte)", count: 4), count: 4).joined(separator: "-"),
                  adder: adder, position: position, active: active, isThisMac: thisMac, seenAt: seen, onlyHolderEpochs: onlyHolder, addedWhileRemoving: false)
    }

    /// This Mac (1), the bot (2), a Mac named "Studio" (3), a removed device (4) and a Mac added by the bot (5): newest first.
    private func state(pending: Bool = false, removing: [Data] = [], onlyHolder: Int = 0, addName: String? = nil) -> DevicesState {
        var s = DevicesState()
        s.rows = [
            row(5, adder: .device(Self.id(2)), position: 5, onlyHolder: onlyHolder), row(4, label: "Old", position: 4, active: false),
            row(3, label: "Studio", adder: .device(Self.id(1)), position: 3), row(2, kind: .bot, adder: .device(Self.id(1)), position: 2),
            row(1, position: 0, thisMac: true),
        ]
        (s.pendingEntry, s.removing, s.pendingAddName) = (pending, removing, addName)
        return s
    }

    private func candidate() -> DeviceCandidate {
        DeviceCandidate(kind: .app, name: "Laptop", shortForm: "aaaa-bbbb-cccc-dddd", device: .null, proof: Data())
    }

    // MARK: the acts offered match the controller's

    func testTheActsOfferedAreTheOnesTheControllerAllows() {
        // (state, add, remove of another device, remove of this Mac): confirmAdd refuses while an entry is pending (design 3.6),
        // confirmRemoval while a removal runs and for this Mac (3.9); every act refuses before the log is read.
        let table: [(String, DevicesState, Bool, Bool, Bool)] = [
            ("log not read", DevicesState(), false, false, false),
            ("quiet", state(), true, true, false),
            ("an add pending", state(pending: true), false, true, false),
            ("a removal running", state(pending: true, removing: [Self.id(5)]), false, false, false),
        ]
        for (name, s, add, remove, own) in table {
            let model = DevicesModel(state: s)
            XCTAssertEqual(model.canAdd, add, name)
            XCTAssertEqual(model.canRemove(self.row(3, position: 3)), remove && !s.rows.isEmpty, name)
            XCTAssertEqual(model.canRemove(self.row(1, position: 0, thisMac: true)), own, name)
        }
    }

    func testTheListHoldsTheActiveDevicesNewestFirst() {
        let model = DevicesModel(state: state())
        XCTAssertEqual(model.rows.map(\.position), [5, 3, 2, 0])
    }

    // MARK: the words of a row

    func testARowShowsItsLabelInQuotesElseItsKind() {
        XCTAssertEqual(DevicesModel.title(row(3, label: "Studio", position: 3)), "\u{201C}Studio\u{201D}")
        XCTAssertEqual(DevicesModel.title(row(2, kind: .bot, position: 2)), "Bot")
        XCTAssertEqual(DevicesModel.title(row(5, position: 5)), "App")
    }

    func testAdderIsALabelAShortFormARemovedDeviceOrTheFirstDevice() {
        let model = DevicesModel(state: state())
        XCTAssertEqual(model.adder(model.rows[0]), .shortForm(model.rows[2].shortForm), "the bot has no label: its short form")
        XCTAssertEqual(model.adder(model.rows[1]), .shortForm(model.rows[3].shortForm))
        XCTAssertEqual(model.adder(model.rows[3]), .firstDevice, "entry 0's device was added by no device")
        var labelled = state()
        labelled.rows[0] = row(5, adder: .device(Self.id(3)), position: 5)
        XCTAssertEqual(DevicesModel(state: labelled).adder(labelled.rows[0]), .label("Studio"), "the name is a value, not a joined sentence")
        var s = state()
        s.rows[2] = row(3, label: "Studio", adder: .removedDevice, position: 3)
        XCTAssertEqual(DevicesModel(state: s).adder(s.rows[2]), .removedDevice)
        s.rows[2] = row(3, label: "Studio", adder: .none, position: 3)
        XCTAssertNil(DevicesModel(state: s).adder(s.rows[2]), "a device a reset named, not the first: no line")
    }

    func testANameThatHoldsQuotesCannotFakePartOfTheAppsSentence() {
        let hostile = "A\u{201D}, position 0, \u{201C}B"
        let notices: [DevicesNotice] = [.addRefused(.label(hostile)), .removeRefused(.label(hostile)), .entryInvalid(.label(hostile))]
        for notice in notices {
            XCTAssertEqual(notice.subject, .label(hostile))
            XCTAssertNil(notice.subjectWords, "a name is drawn by the view, never as the app's own text: \(notice)")
            XCTAssertFalse(notice.headline.contains(hostile), "\(notice)")
            XCTAssertFalse((notice.detail ?? "").contains(hostile), "\(notice)")
            XCTAssertFalse(notice.headline.contains("\u{201C}"), "the app's words carry no quote of their own: \(notice)")
        }
        XCTAssertEqual(DevicesNotice.addRefused(.unknown).headline, "Adding this device failed")
        XCTAssertEqual(DevicesNotice.removeRefused(.unknown).headline, "Removing this device failed")
        XCTAssertEqual(DevicesNotice.entryInvalid(.unknown).headline, "A change to this device could not be sent")
    }

    func testADeviceWithNoNameIsNamedInTheAppsOwnWordsNeverAsAName() {
        XCTAssertEqual(DevicesNotice.addRefused(.shortForm(.app, "2b2b-2b2b-2b2b-2b2b")).subjectWords, "the app 2b2b-2b2b-2b2b-2b2b")
        XCTAssertEqual(DevicesNotice.removeRefused(.shortForm(.bot, "2b2b-2b2b-2b2b-2b2b")).subjectWords, "the bot 2b2b-2b2b-2b2b-2b2b")
        XCTAssertEqual(DevicesNotice.entryInvalid(.unknown).subjectWords, "a device")
        // A device that names itself like the app's fallback is still a label, drawn as a name.
        XCTAssertNil(DevicesNotice.addRefused(.label("Device 2b2b-2b2b-2b2b-2b2b")).subjectWords)
    }

    // MARK: the add flow

    func testAGoodStringShowsTheCandidateAndTypingTakesItBack() {
        let model = DevicesModel(state: state(), handoff: nil, page: .add, pasted: " aaaa ")
        model.finishCheck(.success(candidate()), text: "aaaa")
        XCTAssertEqual(model.candidate?.shortForm, "aaaa-bbbb-cccc-dddd")
        XCTAssertNil(model.refusal)
        model.pasted = "00"
        model.edited()
        XCTAssertNil(model.candidate)
    }

    func testARefusalStaysOnTheFormWithItsSentence() {
        let model = DevicesModel(state: state(), page: .add)
        model.finishCheck(.failure(.otherPerson), text: "")
        XCTAssertEqual(model.refusal, .otherPerson)
        XCTAssertNil(model.candidate)
        XCTAssertEqual(model.refusal?.message, "This string was made for another person id. Check the values you gave the device.")
        model.finishAdd(.entryPending, text: "")
        XCTAssertEqual(model.page, .add, "a refused add leaves the form where it is")
        XCTAssertEqual(model.refusal, .entryPending)
    }

    func testAWrittenAddReturnsToTheListAndTheLineFollowsTheControllersState() {
        let model = DevicesModel(state: state(), page: .add, pasted: "00", candidate: candidate())
        model.finishAdd(nil, text: "00")
        XCTAssertEqual(model.page, .list)
        XCTAssertEqual(model.pasted, "")
        XCTAssertNil(model.candidate)
        XCTAssertFalse(model.isAdding, "no entry pending is known yet")
        model.apply(state(pending: true, addName: "Laptop"))
        XCTAssertTrue(model.isAdding)
        XCTAssertEqual(model.addingName, "Laptop")
        model.apply(state(pending: false))
        XCTAssertFalse(model.isAdding)
        XCTAssertNil(model.addingName, "no name is kept once the entry is gone")
        model.apply(state(pending: true))
        XCTAssertTrue(model.isAdding, "an entry of unknown kind with no removal is an add")
        XCTAssertNil(model.addingName)
    }

    func testAnAddDuringARemovalShowsItsProgressAndARemovalsEntryDoesNot() {
        let model = DevicesModel(state: state(pending: true, removing: [Self.id(3)], addName: "Laptop"))
        XCTAssertTrue(model.isAdding, "decided on the pending add, not on whether a removal runs")
        XCTAssertEqual(model.addingName, "Laptop")
        let removal = DevicesModel(state: state(pending: true, removing: [Self.id(3)]))
        XCTAssertFalse(removal.isAdding)
    }

    func testACheckThatEndsAfterTheFieldChangedOrThePageLeftIsDropped() {
        let edited = DevicesModel(state: state(), page: .add, pasted: "abd")
        edited.finishCheck(.success(candidate()), text: "abc")
        XCTAssertNil(edited.candidate, "the string it was made for is not the one in the field")
        XCTAssertFalse(edited.working)
        let left = DevicesModel(state: state(), page: .add, pasted: "abc")
        left.back()
        left.finishCheck(.failure(.otherPerson), text: "abc")
        XCTAssertNil(left.refusal)
        let reopened = DevicesModel(state: state(), page: .add, pasted: "abc")
        reopened.open()
        reopened.finishCheck(.success(candidate()), text: "abc")
        XCTAssertNil(reopened.candidate)
        let same = DevicesModel(state: state(), page: .add, pasted: "  abc\n")
        same.finishCheck(.failure(.alreadyAdded), text: "abc")
        XCTAssertEqual(same.refusal, .alreadyAdded, "the trimmed field is the checked text")
    }

    func testAnAddThatEndsAfterTheFieldChangedOrThePageLeftShowsNoRefusal() {
        let edited = DevicesModel(state: state(), page: .add, pasted: "abd", candidate: candidate())
        edited.finishAdd(.entryPending, text: "abc")
        XCTAssertNil(edited.refusal)
        XCTAssertFalse(edited.working)
        let left = DevicesModel(state: state(), page: .add, pasted: "abc", candidate: candidate())
        left.back()
        left.finishAdd(.entryPending, text: "abc")
        XCTAssertNil(left.refusal)
    }

    func testAddOpensOnlyWhenTheControllerWouldTakeIt() {
        let model = DevicesModel(state: state(pending: true))
        model.showAdd()
        XCTAssertEqual(model.page, .list)
        let quiet = DevicesModel(state: state())
        quiet.showAdd()
        XCTAssertEqual(quiet.page, .add)
    }

    // MARK: the removal

    func testRemovalChoicesAreTheControllersRuleWithTheClickedOneChosen() {
        let s = state()
        let model = DevicesModel(state: s)
        model.askRemoval(clicked: Self.id(3))
        XCTAssertEqual(model.page, .remove)
        XCTAssertEqual(model.choices, s.removalChoices(clicked: Self.id(3)))
        XCTAssertEqual(model.choices.map(\.row.position), [5, 3, 2], "every active device but this Mac, newest first")
        XCTAssertEqual(model.chosen, [Self.id(3)])
        model.toggle(Self.id(5))
        model.toggle(Self.id(3))
        XCTAssertEqual(model.chosen, [Self.id(5)])
    }

    func testThisMacAndARunningRemovalCannotBeAsked() {
        let model = DevicesModel(state: state())
        model.askRemoval(clicked: Self.id(1))
        XCTAssertEqual(model.page, .list)
        let running = DevicesModel(state: state(pending: true, removing: [Self.id(3)]))
        running.askRemoval(clicked: Self.id(5))
        XCTAssertEqual(running.page, .list)
    }

    func testTheWarningNamesTheChosenDevicesThatAloneHoldEpochs() {
        let model = DevicesModel(state: state(onlyHolder: 2))
        model.askRemoval(clicked: Self.id(3))
        XCTAssertTrue(model.onlyHolders.isEmpty, "the device that holds epochs is not chosen")
        model.toggle(Self.id(5))
        XCTAssertEqual(model.onlyHolders.map(\.position), [5])
        XCTAssertTrue(model.canConfirmRemoval, "the removal goes on either way")
    }

    func testNothingChosenCannotBeConfirmed() {
        let model = DevicesModel(state: state())
        model.askRemoval(clicked: Self.id(3))
        model.toggle(Self.id(3))
        XCTAssertFalse(model.canConfirmRemoval)
    }

    func testAStaleRemovalResultDoesNotActOnALaterSheet() {
        let model = DevicesModel(state: state())
        model.askRemoval(clicked: Self.id(3))
        model.back()
        model.finishRemoval(nil, for: Self.id(3))
        XCTAssertEqual(model.page, .list)
        model.askRemoval(clicked: Self.id(5))
        model.finishRemoval(.running, for: Self.id(3))
        XCTAssertEqual(model.page, .remove, "a result asked for another device leaves this sheet alone")
        XCTAssertNil(model.removalProblem)
        model.finishRemoval(nil, for: Self.id(5))
        XCTAssertEqual(model.page, .list)
    }

    func testOpeningAnOpenSheetKeepsTheFormInFlight() {
        let model = DevicesModel(state: state(), handoff: nil, page: .add, pasted: "abc")
        model.isOpen = true
        model.open()
        XCTAssertEqual(model.page, .add)
        XCTAssertEqual(model.pasted, "abc")
        model.close()
        model.open()
        XCTAssertEqual(model.page, .list, "a sheet that was closed comes back clean")
    }

    func testAStartedRemovalReturnsToTheListAndAProgressLineShows() {
        let model = DevicesModel(state: state())
        model.askRemoval(clicked: Self.id(3))
        model.finishRemoval(.running, for: Self.id(3))
        XCTAssertEqual(model.page, .remove)
        XCTAssertEqual(model.removalProblem, .running)
        model.finishRemoval(nil, for: Self.id(3))
        XCTAssertEqual(model.page, .list)
        XCTAssertTrue(model.chosen.isEmpty)
        model.apply(state(pending: true, removing: [Self.id(3), Self.id(5)]))
        XCTAssertEqual(model.removingLine, "Removing… 2 left")
        XCTAssertFalse(model.isAdding, "a pending remove is the removal's, not an add")
        model.apply(state())
        XCTAssertNil(model.removingLine)
    }

    func testADeviceThatGoesWhileTheConfirmationIsOpenIsNoLongerAChoice() {
        let model = DevicesModel(state: state())
        model.askRemoval(clicked: Self.id(3))
        model.toggle(Self.id(5))
        var gone = state()
        gone.rows[0] = row(5, position: 5, active: false)
        model.apply(gone)
        XCTAssertEqual(model.chosen, [Self.id(3)])
        gone.rows[2] = row(3, label: "Studio", position: 3, active: false)
        model.apply(gone)
        XCTAssertEqual(model.page, .list, "nothing left to remove")
    }

    func testUntickingTheClickedDeviceKeepsTheConfirmationOpen() {
        let model = DevicesModel(state: state())
        model.askRemoval(clicked: Self.id(3))
        model.toggle(Self.id(3))
        model.apply(state()) // any state the controller publishes next
        XCTAssertEqual(model.page, .remove, "no device went away")
        XCTAssertFalse(model.canConfirmRemoval)
    }

    func testOpeningTheSheetStartsOnAFreshList() {
        let model = DevicesModel(state: state(), page: .remove, pasted: "00", clicked: Self.id(3))
        model.open()
        XCTAssertTrue(model.isOpen)
        XCTAssertEqual(model.page, .list)
        XCTAssertEqual(model.pasted, "")
        XCTAssertTrue(model.chosen.isEmpty)
    }

    func testTheRenameHandoffIsPendingFromTheSheetClosingUntilItIsTaken() {
        let model = DevicesModel(state: state())
        model.isOpen = true
        model.closeForRename()
        XCTAssertFalse(model.isOpen)
        XCTAssertTrue(model.renamePending)
        XCTAssertTrue(model.takeRename())
        XCTAssertFalse(model.renamePending)
        XCTAssertFalse(model.takeRename(), "taken once")
    }

    func testAResetForgetsAPendingRename() {
        let model = DevicesModel(state: state())
        model.closeForRename()
        model.reset()
        XCTAssertFalse(model.renamePending)
    }

    func testAResetForgetsTheSheetAndKeepsTheControllersList() {
        let model = DevicesModel(state: state(), page: .add, pasted: "00")
        model.isOpen = true
        model.reset()
        XCTAssertFalse(model.isOpen)
        XCTAssertEqual(model.page, .list)
        XCTAssertEqual(model.pasted, "")
        XCTAssertEqual(model.rows.count, 4, "the controller publishes a change only: the list it last published stays")
        XCTAssertTrue(model.canAdd)
    }

    // MARK: the listed bots

    func testTheBotsPaneListsEveryActiveBotFromTheDeviceList() {
        var s = state()
        s.rows += [row(6, kind: .bot, label: "Zed", position: 6), row(7, kind: .bot, label: "Gone", position: 7, active: false),
                   row(8, kind: .bot, label: "Alpha", position: 8)]
        let model = DevicesModel(state: s)
        let read = BotProfile(name: "mini", account: "a@example.com", plan: nil, icon: nil)
        let bots = model.listedBots(profiles: [Self.id(8): read])
        XCTAssertEqual(bots.map(\.id), [Self.id(2), Self.id(8), Self.id(6)],
                       "by the name shown, as Finder sorts: the bot with neither by its short id, mini (its profile), Zed (its label); a removed bot and the apps are not listed")
        XCTAssertEqual(bots.map(\.name), model.activeBots(names: [Self.id(8): "mini"]).map(\.name), "the pickers name and order the bots as the Bots pane does")
        XCTAssertEqual(bots.first { $0.id == Self.id(8) }?.profile, read, "a read profile names the bot")
        XCTAssertEqual(bots.first { $0.id == Self.id(6) }?.label, "Zed")
        XCTAssertTrue(DevicesModel(state: DevicesState()).listedBots(profiles: [Self.id(8): read]).isEmpty, "a profile alone lists no bot before the device list is read")
    }

    func testThePaneAndTheHintReadTheSameBots() {
        var s = state()
        s.rows += [row(8, kind: .bot, label: "Alpha", position: 8)]
        let model = DevicesModel(state: s)
        let read = BotProfile(name: "mini", account: "a@example.com", plan: nil, icon: nil)
        let profiles = [Self.id(9): read]
        XCTAssertEqual(MainWindow.listedBots(devices: model, profiles: profiles), model.listedBots(profiles: profiles), "the device list once it is read")
        XCTAssertEqual(MainWindow.listedBots(devices: model, profiles: profiles).map(\.id), [Self.id(2), Self.id(8)], "a profile alone adds no bot to a read list")
        XCTAssertEqual(MainWindow.listedBots(devices: nil, profiles: profiles).map(\.id), [Self.id(9)], "the bots whose profile a channel carries, with no pairing")
        XCTAssertEqual(MainWindow.listedBots(devices: DevicesModel(state: DevicesState()), profiles: profiles).map(\.id), [Self.id(9)], "and before the list is read")
    }

    func testTheEmptyWindowSaysTheNextStep() {
        XCTAssertNil(MainWindow.emptyHint(devicesRead: false, hasBot: false, creating: false), "before the device list is read either line could be false")
        XCTAssertEqual(MainWindow.emptyHint(devicesRead: true, hasBot: false, creating: false),
                       "Add your bot first: in Devices…, Add a device takes the pairing string pardner setup printed on the bot's machine.")
        XCTAssertEqual(MainWindow.emptyHint(devicesRead: true, hasBot: true, creating: false), "Make one with + beside Channels: it binds a folder on your bot's machine.")
        XCTAssertNil(MainWindow.emptyHint(devicesRead: true, hasBot: true, creating: true), "the sidebar's Creating… row says it")
    }
}
