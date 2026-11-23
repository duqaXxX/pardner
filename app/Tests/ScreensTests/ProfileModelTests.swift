// The Profile pane's state (person profile design 8.2, name part): the field shows the live name until edited, Save is offered for a new name
// once the log is read, each answer says something plain, and the window's closing drops the edit and any late answer. No controller runs.
import Foundation
@testable import Relay
@testable import Screens
import XCTest

@MainActor
final class ProfileModelTests: XCTestCase {
    func testTheFieldShowsTheLiveNameUntilEdited() {
        let model = ProfileModel(controller: nil)
        XCTAssertEqual(model.text(live: nil), "")
        XCTAssertEqual(model.text(live: "Ada"), "Ada")
        model.edited = "Ada L"
        XCTAssertEqual(model.text(live: "Grace"), "Ada L", "an edit stays over a name changed on another device")
    }

    func testSaveIsOfferedForANewTrimmedNameOnceTheLogIsRead() {
        let model = ProfileModel(controller: nil)
        XCTAssertFalse(model.canSave(live: "Ada", ready: true), "nothing edited")
        model.edited = " Ada "
        XCTAssertFalse(model.canSave(live: "Ada", ready: true), "the ends are trimmed before the comparison")
        model.edited = "   "
        XCTAssertFalse(model.canSave(live: nil, ready: true), "an empty name is not saved")
        model.edited = "Ada Lovelace"
        XCTAssertTrue(model.canSave(live: "Ada", ready: true))
        XCTAssertTrue(model.canSave(live: nil, ready: true))
        XCTAssertFalse(model.canSave(live: "Ada", ready: false), "not before the log is read")
    }

    func testEachAnswerSaysSomethingPlain() {
        let model = ProfileModel(controller: nil)
        model.edited = "Ada"
        model.finish(.refused("bad-input"), sent: "Ada")
        XCTAssertEqual(model.problem, "Use up to 64 characters, with no hidden characters and no @.")
        model.finish(.refused("not-ready"), sent: "Ada")
        XCTAssertEqual(model.problem, "Pardner is still reading your devices. Try again in a moment.")
        model.finish(.refused("something-new"), sent: "Ada")
        XCTAssertEqual(model.problem, "Pardner could not set the name. Try again in a moment.")
        model.finish(.notSaved, sent: "Ada")
        XCTAssertEqual(model.problem, "Pardner could not save the name. Try again.")
        model.finish(.ended, sent: "Ada")
        XCTAssertEqual(model.problem, "Pardner is not connected. Try again in a moment.")
        XCTAssertEqual(model.edited, "Ada", "a refusal keeps the edit")
        model.finish(.queued(name: Data(repeating: 1, count: 16)), sent: "Ada")
        XCTAssertNil(model.edited)
        XCTAssertNil(model.problem)
    }

    func testClosingTheWindowDropsTheEditAndALateAnswer() {
        let settings = SettingsModel(devices: DevicesModel())
        settings.present = {}
        settings.open(.profile)
        settings.profile.edited = "Ada"
        let asked = settings.profile.ticket
        settings.open(.devices)
        XCTAssertEqual(settings.profile.edited, "Ada", "another pane keeps the edit")
        settings.close()
        XCTAssertNil(settings.profile.edited)
        settings.profile.finish(.refused("bad-input"), sent: "Ada", for: asked)
        XCTAssertNil(settings.profile.problem, "the answer belongs to a closed window")
        settings.profile.edited = "Ada"
        settings.reset()
        XCTAssertNil(settings.profile.edited, "a phase change drops it too")
    }

    /// The device shows a name only once it reads it back: until then the field shows the one queued, and Save stays off for it.
    func testANameQueuedShowsUntilItIsReadBack() {
        let model = ProfileModel(controller: nil)
        model.edited = "Ada Lovelace"
        model.finish(.queued(name: Data(repeating: 1, count: 16)), sent: "Ada Lovelace", over: "Ada")
        XCTAssertEqual(model.text(live: "Ada"), "Ada Lovelace")
        XCTAssertFalse(model.canSave(live: "Ada", ready: true), "nothing new to send")
        XCTAssertEqual(model.text(live: "Ada Lovelace"), "Ada Lovelace")
        XCTAssertEqual(model.text(live: "Grace"), "Grace", "any later name read stands, even with the pane off screen at the read-back")
    }

    /// A name saved back over the one still queued (the unbuilt item is replaced, so the device never shows the first): the next name read stands.
    func testANameSavedBackOverAQueuedOneLeavesNothingStuck() {
        let model = ProfileModel(controller: nil)
        model.finish(.queued(name: Data(repeating: 1, count: 16)), sent: "Bob", over: "Ada")
        model.finish(.queued(name: Data(repeating: 2, count: 16)), sent: "Ada", over: "Ada")
        XCTAssertEqual(model.text(live: "Ada"), "Ada")
        XCTAssertEqual(model.text(live: "Grace"), "Grace")
    }

    func testTextTypedWhileASaveIsOnItsWayStays() {
        let model = ProfileModel(controller: nil)
        model.edited = "Ada L"
        model.finish(.queued(name: Data(repeating: 1, count: 16)), sent: "Ada", over: nil)
        XCTAssertEqual(model.edited, "Ada L")
        XCTAssertTrue(model.canSave(live: nil, ready: true))
    }

    /// A late answer after the window closed still shows the name it queued, and one from before a reset shows nothing.
    func testALateAnswerQueuesItsNameOnlyInItsPairing() {
        let settings = SettingsModel(devices: DevicesModel())
        let asked = settings.profile.ticket
        settings.close()
        settings.profile.finish(.queued(name: Data(repeating: 1, count: 16)), sent: "Ada", over: nil, for: asked, pairing: 0)
        XCTAssertEqual(settings.profile.text(live: nil), "Ada")
        settings.reset()
        XCTAssertEqual(settings.profile.text(live: nil), "")
        settings.profile.finish(.queued(name: Data(repeating: 1, count: 16)), sent: "Grace", over: nil, for: asked, pairing: 0)
        XCTAssertEqual(settings.profile.text(live: nil), "", "the answer belongs to the pairing that ended")
    }
}
