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
}
