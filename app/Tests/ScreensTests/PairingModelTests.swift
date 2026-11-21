// What the pairing model decides between the controller's phases (device pairing design 3.5, 3.10, 4.1): the screen and the one
// action of each phase, a sheet closed when the phase moves on, the cancel's notes and where the first screen starts, and when the
// secrets are dropped. Over fixed-phase models and the outcomes the model's own methods take; no controller runs.
import Foundation
import Platform
@testable import Relay
@testable import Screens
import XCTest

@MainActor
final class PairingModelTests: XCTestCase {
    private func request() -> RecoverySheetRequest {
        let secret = UnsafeMutableRawBufferPointer.allocate(byteCount: 32, alignment: 1)
        secret.initializeMemory(as: UInt8.self, repeating: 7)
        return RecoverySheetRequest(context: "Person: 00", secret: UnsafeRawBufferPointer(secret), gate: SheetGate())
    }

    private func declined(_ request: RecoverySheetRequest) -> Bool { request.withSecret { _ in 0 } == nil }

    // MARK: the screen and the action of each phase

    func testEachPhaseDrawsItsScreenWithTheActionTheControllerAllows() {
        let sheet = request()
        let table: [(PairingPhase, PairingModel.Screen, PairingModel.Exit?)] = [
            (.starting, .starting, nil),
            (.unpaired(nil), .first, nil),
            (.unpaired(.staleSheet), .first, nil),
            (.settingUp, .settingUp, nil),
            (.showingSheet(sheet), .settingUp, nil),
            (.enrolling(asksSecret: false), .enrolling, nil),
            (.enrolling(asksSecret: true), .enrolling, nil),
            (.joining(JoiningInfo(pairingString: "00", shortForm: "0000-0000-0000-0000")), .joining, nil),
            (.paired, .paired, nil),
            (.removed, .removed, .pairAgain),
            (.keysMissing, .keysMissing, .pairAgain),
            (.putBack(PairingPhase.putBackAdvice), .putBack, .pairAgain),
            (.linkFaulted(PairingPhase.linkFaultAdvice), .linkFaulted, .pairAgain),
            (.fault(.malformedStore, PairingPhase.malformedStoreWarning), .malformedStore, .pairAgain),
            (.fault(.newerStore, PairingPhase.newerStoreAdvice), .newerStore, nil),
            (.fault(.keysWithoutStore, "x"), .needsNewPairing, .pairAgain),
            (.fault(.joinMismatch, "x"), .needsNewPairing, .pairAgain),
            (.fault(.joinUnmade, PairingPhase.joinUnmadeAdvice), .joinUnmade, .pairAgain),
            (.fault(.failed, "x"), .failed, .retry),
        ]
        for (phase, screen, exit) in table {
            let model = PairingModel(phase: phase)
            XCTAssertEqual(model.screen, screen, "\(phase)")
            XCTAssertEqual(model.exit, exit, "\(phase)")
        }
        XCTAssertEqual(PairingModel(phase: .unpaired(nil), form: true).screen, .form)
        XCTAssertEqual(PairingModel(phase: .unpaired(nil), join: true).screen, .joinForm)
    }

    // MARK: joining as a new device

    func testTheJoinFormStartsAtTheFirstPageWhenThePhaseMovesOn() {
        let model = PairingModel(phase: .removed, join: true)
        model.apply(.unpaired(nil)) // Pair again
        XCTAssertEqual(model.screen, .first)
        model.showJoin = true
        model.back()
        XCTAssertEqual(model.screen, .first)
        let stopped = PairingModel(phase: .settingUp, join: true)
        stopped.apply(.unpaired(nil)) // a join that was stopped stays on its form, with its message
        stopped.finishJoin(nil, unpaired: true)
        XCTAssertEqual(stopped.screen, .joinForm)
        XCTAssertNotNil(stopped.problem)
    }

    func testAJoinRefusedForAFieldNamesTheFieldAndKeepsTheForm() {
        let model = PairingModel(phase: .unpaired(nil), join: true)
        model.joinPerson = "ab"
        model.finishJoin(PairingInputError.person, unpaired: true)
        XCTAssertEqual(model.refused, .person)
        XCTAssertEqual(model.joinPerson, "ab")
        XCTAssertFalse(model.working)
        model.finishJoin(PairingInputError.notReady, unpaired: true)
        XCTAssertNotNil(model.problem)
        model.finishJoin(CocoaError(.fileWriteUnknown), unpaired: true)
        XCTAssertTrue(model.problem?.hasPrefix("Joining could not finish: ") == true)
        XCTAssertTrue(model.problem?.hasSuffix(". Check the three values and try again.") == true, "the reason, then the next step")
        model.edited()
        XCTAssertNil(model.refused)
    }

    func testLeavingThePairingResetsTheDevicesSheet() {
        let devices = DevicesModel(state: DevicesState(), page: .add, pasted: "00")
        devices.isOpen = true
        let model = PairingModel(phase: .paired, devices: devices)
        model.apply(.removed)
        XCTAssertFalse(devices.isOpen)
        XCTAssertEqual(devices.pasted, "")
    }

    func testTheMessageIsTheControllersText() {
        XCTAssertEqual(PairingModel(phase: .linkFaulted(PairingPhase.linkFaultAdvice)).message, PairingPhase.linkFaultAdvice)
        XCTAssertEqual(PairingModel(phase: .fault(.newerStore, PairingPhase.newerStoreAdvice)).message, PairingPhase.newerStoreAdvice)
        XCTAssertNil(PairingModel(phase: .removed).message)
    }

    func testAJoiningStringThatCannotBeMadeOffersRetryToo() {
        XCTAssertTrue(PairingModel(phase: .fault(.joinUnmade, "x")).offersRetryToo)
        XCTAssertFalse(PairingModel(phase: .fault(.joinUnmade, "x"), storesOpen: false).offersRetryToo)
        XCTAssertFalse(PairingModel(phase: .fault(.joinMismatch, "x")).offersRetryToo)
    }

    func testNoRetryWhereNoControllerExists() {
        XCTAssertEqual(PairingModel(phase: .fault(.failed, "x"), storesOpen: false).exit, nil)
    }

    // MARK: the sheet follows the phase

    func testASheetIsClosedWhenThePhaseMovesOn() {
        let first = request()
        let model = PairingModel(phase: .settingUp)
        model.apply(.showingSheet(first))
        let sheet = try! XCTUnwrap(model.sheet)
        model.apply(.enrolling(asksSecret: false))
        XCTAssertTrue(sheet.isClosed)
        XCTAssertTrue(declined(first))
        XCTAssertNil(model.sheet)
    }

    func testANewSheetClosesTheOneItReplaces() {
        let (first, second) = (request(), request())
        let model = PairingModel(phase: .settingUp)
        model.apply(.showingSheet(first))
        let old = try! XCTUnwrap(model.sheet)
        model.apply(.showingSheet(second))
        XCTAssertTrue(old.isClosed)
        XCTAssertTrue(declined(first))
        XCTAssertFalse(model.sheet!.isClosed)
        XCTAssertFalse(declined(second))
    }

    // MARK: the first screen and the notes

    func testAnyReturnToTheFirstScreenStartsAtItsFirstPage() {
        let model = PairingModel(phase: .removed, form: true)
        model.apply(.unpaired(nil))
        XCTAssertFalse(model.showForm)
        XCTAssertEqual(model.screen, .first)
        model.showForm = true
        model.apply(.unpaired(.staleSheet)) // the same kind of phase: the form stays
        XCTAssertTrue(model.showForm)
    }

    func testASetupThatEndsUnpairedStaysOnTheFormWithItsProblem() {
        let model = PairingModel(phase: .settingUp, form: true)
        model.apply(.unpaired(nil))
        model.finishSetUp(nil, unpaired: true)
        XCTAssertEqual(model.screen, .form)
        XCTAssertNotNil(model.problem)
        let sheet = PairingModel(phase: .showingSheet(request()), form: true)
        sheet.apply(.unpaired(nil)) // the sheet declined
        XCTAssertEqual(sheet.screen, .form)
        let removed = PairingModel(phase: .removed, form: true)
        removed.apply(.unpaired(nil)) // Pair again
        XCTAssertEqual(removed.screen, .first)
    }

    func testANoteDoesNotSurviveAPhaseChange() {
        let model = PairingModel(phase: .enrolling(asksSecret: false), note: .waitForAnswer)
        model.apply(.enrolling(asksSecret: false))
        XCTAssertEqual(model.cancelNote, .waitForAnswer)
        model.apply(.enrolling(asksSecret: true)) // a refusal moved the screen on
        XCTAssertNil(model.cancelNote)
    }

    func testACancelOutcomeIsNotedOnlyInThePhaseItWasAskedIn() {
        let model = PairingModel(phase: .enrolling(asksSecret: true))
        model.finishCancel(.waitForAnswer, calledIn: .enrolling(asksSecret: false))
        XCTAssertNil(model.cancelNote)
        model.finishCancel(.failed("disk"), calledIn: .enrolling(asksSecret: true))
        XCTAssertEqual(model.cancelNote, .failed("disk"))
        model.apply(.unpaired(nil))
        model.apply(.enrolling(asksSecret: false))
        XCTAssertNil(model.cancelNote, "a failed erase does not reappear on a later enrolling screen")
    }

    // MARK: the secrets

    func testBackDropsTheSecret() {
        let model = PairingModel(phase: .unpaired(nil), form: true)
        model.enrolmentSecret = "ab"
        model.back()
        XCTAssertEqual(model.enrolmentSecret, "")
        XCTAssertFalse(model.showForm)
    }

    func testARefusalOfTheAddressKeepsTheSecretAndOfTheSecretDropsIt() {
        let model = PairingModel(phase: .unpaired(nil), form: true)
        model.enrolmentSecret = "ab"
        model.finishSetUp(PairingInputError.address, unpaired: true)
        XCTAssertEqual(model.enrolmentSecret, "ab")
        XCTAssertEqual(model.refused, .address)
        model.finishSetUp(PairingInputError.enrolmentSecret, unpaired: true)
        XCTAssertEqual(model.enrolmentSecret, "")
        XCTAssertEqual(model.refused, .enrolmentSecret)
    }

    func testTheSecretIsDroppedOnceSetUpHasConsumedIt() {
        let model = PairingModel(phase: .unpaired(nil), form: true)
        model.enrolmentSecret = "ab"
        model.finishSetUp(nil, unpaired: false)
        XCTAssertEqual(model.enrolmentSecret, "")
        model.enrolmentSecret = "cd"
        model.finishSetUp(CocoaError(.fileWriteUnknown), unpaired: true)
        XCTAssertEqual(model.enrolmentSecret, "")
        XCTAssertNotNil(model.problem)
    }

    func testTheRetypedSecretIsDroppedWhenTheScreenLeavesEnrolling() {
        let model = PairingModel(phase: .enrolling(asksSecret: true))
        model.retypedSecret = "ab"
        model.apply(.enrolling(asksSecret: false))
        XCTAssertEqual(model.retypedSecret, "ab", "still enrolling")
        model.apply(.unpaired(nil))
        XCTAssertEqual(model.retypedSecret, "")
    }

    func testRetypeSaysWhenNothingIsWaitingForTheSecret() {
        let model = PairingModel(phase: .enrolling(asksSecret: true))
        model.finishRetype(.failure(PairingInputError.notReady))
        XCTAssertEqual(model.retypeProblem, "Pardner is not waiting for the secret now.")
        model.finishRetype(.failure(PairingInputError.enrolmentSecret))
        XCTAssertEqual(model.retypeProblem, "The enrolment secret is 64 hexadecimal characters.")
    }

    // MARK: the Devices screen follows the pairing

    func testTheDevicesSurviveAFaultAndRetryBecauseTheControllerPublishesOnlyAChange() {
        var list = DevicesState()
        list.rows = [DeviceRow(id: Data(repeating: 1, count: 32), kind: .app, label: nil, shortForm: "0101-0101-0101-0101", adder: .none, position: 0, active: true,
                               isThisMac: true, seenAt: nil, onlyHolderEpochs: 0, addedWhileRemoving: false),
                     DeviceRow(id: Data(repeating: 2, count: 32), kind: .bot, label: nil, shortForm: "0202-0202-0202-0202", adder: .device(Data(repeating: 1, count: 32)), position: 2,
                               active: true, isThisMac: false, seenAt: nil, onlyHolderEpochs: 0, addedWhileRemoving: false)]
        let model = PairingModel(phase: .paired, devices: DevicesModel(state: list))
        model.devices.isOpen = true
        model.apply(.fault(.failed, "the relay's address did not resolve"))
        XCTAssertFalse(model.devices.isOpen, "the sheet does not outlive the pairing")
        model.apply(.paired) // Retry: the same list, so the controller publishes nothing
        XCTAssertEqual(model.devices.rows.count, 2)
        XCTAssertTrue(model.devices.canAdd)
        XCTAssertTrue(model.devices.canRemove(list.rows[1]))
    }

    func testTheNewChannelSheetSurvivesAFaultedWriteAndRetryButNotAnUnpairing() {
        var list = DevicesState()
        list.rows = [DeviceRow(id: Data(repeating: 2, count: 32), kind: .bot, label: nil, shortForm: "0202-0202-0202-0202", adder: .none, position: 2,
                               active: true, isThisMac: false, seenAt: nil, onlyHolderEpochs: 0, addedWhileRemoving: false)]
        let model = PairingModel(phase: .paired, devices: DevicesModel(state: list))
        model.channels.openNew()
        model.channels.folder = "/work/app"
        // A failed write ends the connection with this fault: the sheet and the typed folder wait for Retry and the answer.
        model.apply(.fault(.failed, "Pardner could not save what it is sending"))
        model.apply(.paired)
        model.channels.finishCreate(.notSaved)
        XCTAssertEqual(model.channels.sheet, .create)
        XCTAssertEqual(model.channels.folder, "/work/app")
        XCTAssertEqual(model.channels.problem, "Pardner could not save the new channel. Try again.")
        for phase: PairingPhase in [.removed, .unpaired(nil)] {
            model.apply(.paired)
            model.apply(phase)
            XCTAssertNil(model.channels.sheet, "\(phase)")
            XCTAssertEqual(model.channels.folder, "")
            model.apply(.paired)
            model.channels.openNew()
            model.channels.folder = "/work/app"
        }
    }

    // MARK: the join form

    func testTheComputersNameIsCutThenTrimmedAndAnEmptyOneLeavesTheField() {
        XCTAssertEqual(PairingModel.fitName("  Studio Mac \n"), "Studio Mac")
        XCTAssertEqual(PairingModel.fitName(String(repeating: "a", count: 63) + " b"), String(repeating: "a", count: 63), "cut at 64 bytes, then the space at the end goes")
        XCTAssertEqual(PairingModel.fitName(String(repeating: "a", count: 63) + "\u{E9}"), String(repeating: "a", count: 63), "a letter of two bytes is not cut in half")
        XCTAssertEqual(PairingModel.fitName(String(repeating: "a", count: 64)).utf8.count, 64)
        XCTAssertEqual(PairingModel.fitName("   "), "")
    }

    func testTheComputersNameIsReadWhenTheJoinFormOpensAndKeepsWhatWasTyped() {
        let model = PairingModel(phase: .unpaired(nil))
        XCTAssertEqual(model.joinName, "", "nothing is read at launch")
        model.computerName = { "  Mac A " }
        model.openJoin()
        XCTAssertTrue(model.showJoin)
        XCTAssertEqual(model.joinName, "Mac A")
        model.joinName = "My Mac"
        model.back()
        model.computerName = { "Mac B" }
        model.openJoin()
        XCTAssertEqual(model.joinName, "My Mac", "a name the person typed stays")
        model.joinName = ""
        model.back()
        model.openJoin()
        XCTAssertEqual(model.joinName, "Mac B")
        model.joinName = ""
        model.back()
        model.computerName = { "   " }
        model.openJoin()
        XCTAssertEqual(model.joinName, "", "the placeholder shows")
    }

    func testTheSetupOfAJoinIsToldApartFromTheSetupOfAFirstDevice() {
        XCTAssertTrue(PairingModel(phase: .settingUp, join: true).isJoinSetUp)
        XCTAssertFalse(PairingModel(phase: .settingUp, form: true).isJoinSetUp)
        XCTAssertFalse(PairingModel(phase: .showingSheet(request())).isJoinSetUp)
        XCTAssertFalse(PairingModel(phase: .unpaired(nil), join: true).isJoinSetUp, "the form is not the setup")
    }
}
