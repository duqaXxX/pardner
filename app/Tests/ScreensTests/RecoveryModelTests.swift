// What the recovery screens' model decides (recovery design 2.2 to 2.7): the screen of each phase, the public part pasted, the key field that
// refuses a wrong check symbol and keeps the person there, the confirmation of giving up a key, and the words. No controller runs.
import AppKit
import Foundation
import Platform
@testable import Relay
@testable import Screens
import XCTest

@MainActor
final class RecoveryModelTests: XCTestCase {
    private let secret = Data((1...32).map { UInt8($0) })

    private func entryRequest() -> RecoveryEntryRequest { RecoveryEntryRequest(gate: SheetGate()) }

    /// What the person types for `bytes`: the display characters, in order.
    private func symbols(_ bytes: Data) -> [UniChar] {
        let buffer = SecretBuffer(count: 32)
        buffer.withUnsafeMutableBytes { $0.copyBytes(from: bytes) }
        var shown = [UniChar](repeating: 0, count: RecoveryText.displayCount)
        shown.withUnsafeMutableBufferPointer { RecoveryText.write(buffer, into: $0) }
        buffer.wipe()
        return shown.filter { $0 != 0x2D && $0 != 0 }
    }

    func testEachRecoveryPhaseDrawsTheRecoveryScreen() {
        let steps: [RecoveryStep] = [.starting, .reading, .askDevices(others: 2), .askNewKey, .sending, .placed, .refused(.notCurrent),
                                     .opening(RecoveryProgress(waiting: [], unsealed: 1)), .done(RecoveryDone(destroyable: [], keep: nil))]
        for step in steps { XCTAssertEqual(PairingModel(phase: .recovering(step)).screen, .recovery, "\(step)") }
        XCTAssertEqual(PairingModel(phase: .unpaired(nil)).screen, .first)
    }

    func testTheRecoverFormIsTheFirstScreensFourthPage() {
        let model = PairingModel(phase: .unpaired(nil))
        model.openRecover()
        XCTAssertEqual(model.screen, .recoverForm)
        model.back()
        XCTAssertEqual(model.screen, .first)
    }

    func testThePublicPartAsCopyGaveItFillsTheThreeFields() {
        let model = PairingModel(phase: .unpaired(nil))
        model.paste("Person: \(String(repeating: "ab", count: 32))\nRelay: relay.example.net:7443\nRelay key: 04\(String(repeating: "cd", count: 64))\n")
        XCTAssertEqual(model.recoverPerson, String(repeating: "ab", count: 32))
        XCTAssertEqual(model.recoverAddress, "relay.example.net:7443")
        XCTAssertEqual(model.recoverKey, "04" + String(repeating: "cd", count: 64))
        XCTAssertNil(model.problem)
        model.paste("hello")
        XCTAssertEqual(model.problem, RecoveryScreenWords.notPasted)
        XCTAssertEqual(model.recoverAddress, "relay.example.net:7443", "text that does not read changes nothing")
    }

    /// An IPv6 relay is written with brackets wherever its address is printed for the person to copy, and the paste takes it back.
    func testAnIPv6RelayIsCopiedAndPastedWithItsBrackets() throws {
        let relay = PairingRelay(host: "fd00::1", port: 7443, key: Data(repeating: 4, count: 65))
        XCTAssertEqual(relay.address, "[fd00::1]:7443")
        XCTAssertEqual(PairingRelay(host: "relay.example.net", port: 7443, key: relay.key).address, "relay.example.net:7443")
        let model = PairingModel(phase: .unpaired(nil))
        model.paste("Person: \(String(repeating: "ab", count: 32))\nRelay: \(relay.address)\nRelay key: 04\(String(repeating: "cd", count: 64))")
        XCTAssertEqual(model.recoverAddress, "[fd00::1]:7443")
    }

    func testASuccessfulPasteTakesBackAnEarlierFieldError() {
        let model = PairingModel(phase: .unpaired(nil))
        model.finishRecover(PairingInputError.address, unpaired: false)
        XCTAssertEqual(model.refused, .address)
        model.paste("Person: \(String(repeating: "ab", count: 32))\nRelay: relay.example.net:7443\nRelay key: 04\(String(repeating: "cd", count: 64))")
        XCTAssertNil(model.refused)
    }

    func testARecoveryStoppedBeforeItFinishedSaysSoLikeSetupAndJoinDo() {
        let model = PairingModel(phase: .unpaired(nil))
        model.finishRecover(nil, unpaired: true)
        XCTAssertEqual(model.problem, "The recovery was stopped before it finished. Nothing was kept; start again.")
    }

    func testASecondClickOnAnAnsweredQuestionShowsNothingAndAProblemDoesNotOutliveItsStep() {
        let model = PairingModel(phase: .recovering(.askNewKey))
        model.finishAnswer(PairingInputError.notReady)
        XCTAssertNil(model.problem)
        model.finishAnswer(PairingInputError.person)
        XCTAssertNotNil(model.problem)
        model.apply(.recovering(.sending))
        XCTAssertNil(model.problem, "the step moved on")
    }

    func testAGiveUpConfirmationEndsWhenItsKeyIsNoLongerWaiting() {
        let earlier = Data(repeating: 2, count: 32)
        let waiting = RecoveryProgress(waiting: [.init(key: earlier, epochs: [])], unsealed: 0)
        let model = PairingModel(phase: .recovering(.opening(waiting)))
        model.askToGiveUp(earlier)
        model.apply(.recovering(.opening(waiting)))
        XCTAssertEqual(model.givingUp, earlier, "still waiting: it stands")
        model.apply(.recovering(.opening(RecoveryProgress(waiting: [], unsealed: 1))))
        XCTAssertNil(model.givingUp)
    }

    func testNothingToDestroyMakesNoSentence() {
        XCTAssertNil(RecoveryScreenWords.destroyable([]))
        XCTAssertEqual(RecoveryScreenWords.destroyable(["1a2b"]), "You can destroy this recovery key: 1a2b.")
    }

    /// Once an answer stands the buffer is not the field's: a key typed after the controller's decline is refused and nothing stays in it.
    func testNothingTypedAfterAnAnswerStandsReachesTheBuffer() {
        let request = entryRequest()
        let field = RecoveryEntryModel(request: request)
        symbols(secret).prefix(10).forEach { field.key($0) }
        request.answer(false) // the controller's decline, from its own executor
        XCTAssertEqual(request.entry.count, 0)
        XCTAssertFalse(field.key(0x31))
        field.deleteLast()
        XCTAssertEqual(request.entry.count, 0, "a symbol typed after the wipe stayed in a buffer nobody wipes")
        XCTAssertEqual(field.typed, 0)
    }

    func testAKeyThatReadsIsHandedOverAndAWrongCheckSymbolIsRefusedInTheField() async throws {
        let request = entryRequest()
        let field = RecoveryEntryModel(request: request)
        var typed = symbols(secret)
        XCTAssertEqual(typed.count, RecoveryEntryModel.symbolCount)
        let last = typed.removeLast()
        typed.forEach { field.key($0) }
        XCTAssertFalse(field.reads, "one symbol short")
        field.key(last == 0x30 ? 0x31 : 0x30) // a wrong check symbol
        XCTAssertTrue(field.checkFailed)
        field.submit()
        XCTAssertFalse(field.isClosed, "the person stays in the field")
        field.deleteLast()
        field.key(last)
        XCTAssertTrue(field.reads)
        field.submit()
        XCTAssertTrue(field.isClosed)
        XCTAssertEqual(request.entry.count, RecoveryEntryModel.symbolCount, "handed over, not wiped: the host thread reads it")
    }

    func testDecliningWipesTheTypedKeyAndTheFirstAnswerStands() {
        let gate = SheetGate()
        let request = RecoveryEntryRequest(gate: gate)
        let field = RecoveryEntryModel(request: request)
        symbols(secret).forEach { field.key($0) }
        field.decline()
        XCTAssertEqual(request.entry.count, 0)
        XCTAssertEqual(field.typed, 0)
        field.submit()
        XCTAssertTrue(field.isClosed)
        XCTAssertFalse(gate.wait(), "the decline is the answer that stands")
    }

    func testGivingUpAsksForAConfirmationAndNeverForTheCurrentKey() {
        let (earlier, current) = (Data(repeating: 2, count: 32), Data(repeating: 3, count: 32))
        let progress = RecoveryProgress(waiting: [.init(key: earlier, epochs: []), .init(key: current, epochs: [], isCurrent: true)], unsealed: 0)
        let model = PairingModel(phase: .recovering(.opening(progress)))
        model.askToGiveUp(current)
        XCTAssertNil(model.givingUp, "the current key is asked for, never given up")
        model.askToGiveUp(earlier)
        XCTAssertEqual(model.givingUp, earlier)
        model.cancelGiveUp()
        XCTAssertNil(model.givingUp)
    }

    func testTheNoLineSaysWhichEarlierKeysStayActive() {
        XCTAssertEqual(RecoveryScreenWords.noLine(.notActive), RecoveryScreenWords.devicesNoLine)
        XCTAssertEqual(RecoveryScreenWords.noLine(.unnamed),
                       RecoveryScreenWords.devicesNoLine + " Your earlier keys on this Mac may still be active; remove them in Devices if so.")
        XCTAssertEqual(RecoveryScreenWords.noLine(.named("5e5e 5e5e 5e5e 5e5e")),
                       RecoveryScreenWords.devicesNoLine + " Your earlier keys on this Mac (5e5e 5e5e 5e5e 5e5e) stay active until you remove them in Devices.")
        XCTAssertEqual(RecoveryScreenWords.earlierKeysMark, "This Mac's earlier keys")
    }

    func testEveryRefusalHasItsWordsAndNoneSaysSheet() {
        let all: [RecoveryRefusal] = [.unknownPerson, .notCurrent, .madeEarlier, .notTheStartKey, .yourNewKey, .notTyped, .noLongerCurrent, .personGone]
        for why in all {
            let words = RecoveryScreenWords.refusal(why)
            XCTAssertFalse(words.title.isEmpty || words.text.isEmpty)
            XCTAssertFalse((words.title + words.text).lowercased().contains("sheet"), "\(why)")
        }
        XCTAssertEqual(RecoveryScreenWords.refusal(.yourNewKey).text.hasPrefix("This is your new recovery key."), true)
        XCTAssertTrue(RecoveryScreenWords.missing("1a2b", isCurrent: true).contains("current recovery key"))
    }

    /// The dead ends offer the recovery beside Pair again; the form opens over them and Back returns to the notice.
    func testTheDeadEndsOpenTheRecoveryFormAndBackReturns() {
        for phase in [PairingPhase.removed, .keysMissing] {
            let model = PairingModel(phase: phase)
            let notice = model.screen
            model.openRecover()
            XCTAssertEqual(model.screen, .recoverForm, "\(phase)")
            model.back()
            XCTAssertEqual(model.screen, notice)
        }
    }

    /// The sheet of a new recovery key says when the key opens the history; the setup's sheet is unchanged.
    func testTheSheetOfARecoveryKnowsItIsOne() {
        let model = PairingModel(phase: .unpaired(nil))
        let secret = UnsafeMutableRawBufferPointer.allocate(byteCount: 32, alignment: 1)
        secret.initializeMemory(as: UInt8.self, repeating: 7)
        let request = RecoverySheetRequest(context: "Person: 00", secret: UnsafeRawBufferPointer(secret), gate: SheetGate())
        model.apply(.recovering(.starting))
        model.apply(.showingSheet(request))
        XCTAssertEqual(model.sheet?.isRecovery, true)
        XCTAssertEqual(model.screen, .recovery, "the recovery page stays behind the sheet")
        let setup = PairingModel(phase: .settingUp)
        setup.apply(.showingSheet(request))
        XCTAssertEqual(setup.sheet?.isRecovery, false)
    }

    /// A key asked for after the past began to open is an earlier one.
    func testAKeyAskedForWhileOpeningIsAnEarlierOne() {
        let model = PairingModel(phase: .unpaired(nil))
        model.apply(.recovering(.starting))
        XCTAssertFalse(model.typingEarlier)
        let earlier = RecoveryProgress(waiting: [.init(key: Data(repeating: 2, count: 32), epochs: [])], unsealed: 0)
        model.apply(.recovering(.opening(earlier)))
        model.apply(.recovering(.starting))
        XCTAssertTrue(model.typingEarlier)
        let onlyCurrent = RecoveryProgress(waiting: [.init(key: Data(repeating: 3, count: 32), epochs: [], isCurrent: true)], unsealed: 0)
        model.apply(.recovering(.opening(onlyCurrent)))
        XCTAssertFalse(model.typingEarlier, "the current key is asked for, not an earlier one")
        XCTAssertFalse(onlyCurrent.asksEarlierKey)
        XCTAssertTrue(earlier.asksEarlierKey)
        model.apply(.unpaired(nil))
        XCTAssertFalse(model.typingEarlier)
    }

    /// The form and what was typed in it do not outlive the recovery: a later removal shows its notice, not the old form.
    func testTheRecoveryFormDoesNotOutliveTheRecovery() {
        let model = PairingModel(phase: .unpaired(nil))
        model.openRecover()
        model.recoverPerson = "ab"
        model.apply(.recovering(.starting))
        model.apply(.recovering(.done(RecoveryDone(destroyable: [], keep: nil))))
        XCTAssertTrue(model.showRecover, "still inside the recovery")
        model.apply(.paired)
        model.apply(.removed)
        XCTAssertFalse(model.showRecover)
        XCTAssertEqual(model.recoverPerson, "")
        XCTAssertEqual(model.screen, .removed)
    }

    /// The guard takes the window out of screen sharing only while it is in the window, and puts it back as it was.
    func testTheWindowGuardRestoresTheSharingOfTheWindowItLeaves() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 100, height: 100), styleMask: [.titled], backing: .buffered, defer: true)
        window.sharingType = .readOnly
        let container = NSView(frame: window.contentView!.bounds)
        window.contentView = container
        let guardView = WindowGuardView()
        container.addSubview(guardView)
        XCTAssertEqual(window.sharingType, .none)
        guardView.removeFromSuperview()
        XCTAssertEqual(window.sharingType, .readOnly, "the main window stays out of screen sharing for the rest of the run")
    }

    /// Cancel only where the controller takes it; a stored recovery says plainly that nothing can be done.
    func testOnlyARefusalBeforeAResetOffersCancelAndTheStoredOnesSaySoPlainly() {
        XCTAssertEqual([RecoveryRefusal.unknownPerson, .notCurrent, .madeEarlier, .notTheStartKey, .yourNewKey, .notTyped, .noLongerCurrent, .personGone].filter(RecoveryScreenWords.canCancel),
                       [.unknownPerson, .notCurrent, .madeEarlier])
        XCTAssertEqual([RecoveryRefusal.unknownPerson, .notCurrent, .madeEarlier, .notTheStartKey, .yourNewKey, .notTyped, .noLongerCurrent, .personGone].filter(RecoveryScreenWords.canQuit),
                       [.noLongerCurrent, .personGone])
        XCTAssertEqual(RecoveryScreenWords.quitRecovery, "Quit recovery and keep this Mac as it is")
        XCTAssertFalse(RecoveryScreenWords.canTypeAgain(.noLongerCurrent))
        XCTAssertFalse(RecoveryScreenWords.canTypeAgain(.personGone))
        XCTAssertEqual(RecoveryScreenWords.refusal(.personGone).title, "Your relay no longer knows this person")
        XCTAssertFalse(RecoveryScreenWords.refusal(.personGone).text.contains("replaced"), "its cause is the person, not a replaced key")
        XCTAssertTrue(RecoveryScreenWords.cannotFinish.hasPrefix("Pardner cannot finish this recovery now. Quit Pardner"))
    }

    func testTheFormFromADeadEndSaysContinueErasesTheOldKeys() {
        XCTAssertTrue(PairingModel(phase: .removed).formErasesOldKeys)
        XCTAssertTrue(PairingModel(phase: .keysMissing).formErasesOldKeys)
        XCTAssertFalse(PairingModel(phase: .unpaired(nil)).formErasesOldKeys)
    }

    func testTheConfirmationsTypeTheKeyClosesItAndOpensTheField() {
        let earlier = Data(repeating: 2, count: 32)
        let model = PairingModel(phase: .recovering(.opening(RecoveryProgress(waiting: [.init(key: earlier, epochs: [])], unsealed: 0))))
        model.askToGiveUp(earlier)
        model.typeInstead()
        XCTAssertNil(model.givingUp)
    }

    /// A field that is given another model sends the keys to it: never to one that was declined.
    func testAKeyCaptureGivenANewModelTypesIntoTheNewOne() throws {
        let (first, second) = (RecoveryEntryModel(request: entryRequest()), RecoveryEntryModel(request: entryRequest()))
        let view = KeyCaptureView(model: first, label: "Type the recovery key")
        XCTAssertEqual(view.accessibilityLabel(), "Type the recovery key")
        view.model = second
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, characters: "1", charactersIgnoringModifiers: "1", isARepeat: false, keyCode: 18))
        view.keyDown(with: event)
        XCTAssertEqual(second.typed, 1)
        XCTAssertEqual(first.typed, 0)
        XCTAssertEqual(view.accessibilityValue() as? String, "1 of \(RecoveryText.symbolCount) characters typed")
    }

    func testTheNewKeyAnswersEachHaveALine() {
        XCTAssertFalse(RecoveryScreenWords.makeNewKeyLine.isEmpty)
        XCTAssertFalse(RecoveryScreenWords.keepMyKeyLine.isEmpty)
    }
}
