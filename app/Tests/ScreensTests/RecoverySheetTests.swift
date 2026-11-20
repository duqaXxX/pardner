// The recovery sheet's logic apart from its drawing (device pairing design 3.8): when Confirm is possible, the answer given from
// inside `withSecret`, the wipe on every way of closing, and the rules of the secure-input flag.
import Foundation
import Platform
@testable import Screens
import XCTest

/// Stands in for the controller's request with the same contract: `withSecret` is nil once answered; the first answer stands.
private final class FakeSource: RecoverySource {
    let context = "Person: 00\nRelay: relay.example.net:7443\nRelay key: 04"
    private let bytes: [UInt8]
    private(set) var answers: [Bool] = []
    private var answered: Bool? { answers.first }

    init(bytes: [UInt8] = (0..<32).map { UInt8($0 &* 7 &+ 1) }) { self.bytes = bytes }

    func withSecret<T>(_ body: (UnsafeRawBufferPointer) -> T) -> T? {
        guard answered == nil else { return nil }
        return bytes.withUnsafeBytes(body)
    }

    func answer(_ confirmed: Bool) { answers.append(confirmed) }
    var first: Bool? { answers.first }

    /// The shown form of the secret, as the person would write it down (a test's own `String` is fine: it is not the app's).
    var written: [UniChar] {
        let secret = SecretBuffer(count: 32)
        secret.withUnsafeMutableBytes { $0.copyBytes(from: bytes) }
        var out = [UniChar](repeating: 0, count: RecoveryText.displayCount)
        out.withUnsafeMutableBufferPointer { RecoveryText.write(secret, into: $0) }
        return out
    }
}

@MainActor
final class RecoverySheetTests: XCTestCase {
    private func make(_ source: FakeSource = FakeSource()) -> (RecoverySheetModel, FakeSource, Switch) {
        let sw = Switch()
        let model = RecoverySheetModel(source: source, secureInput: SecureInputGuard(enable: { sw.on += 1 }, disable: { sw.off += 1 }))
        return (model, source, sw)
    }

    private func type(_ text: [UniChar], into model: RecoverySheetModel) { text.forEach { model.key($0) } }

    func testConfirmIsPossibleOnlyForAFullMatchingText() {
        let (model, source, _) = make()
        let written = source.written
        type(Array(written.prefix(40)), into: model)
        XCTAssertFalse(model.matches, "a short text never matches")
        model.confirm()
        XCTAssertNil(source.first, "Confirm does nothing before a match")
        type(Array(written.dropFirst(40)), into: model)
        XCTAssertEqual(model.typed, RecoveryText.symbolCount, "dashes are ignored")
        XCTAssertTrue(model.matches)
    }

    func testAWrongSymbolNeverMatches() {
        let (model, source, _) = make()
        var written = source.written
        let i = written.firstIndex(of: 0x2D)! + 1 // the first symbol of the second group
        written[i] = written[i] == 0x30 ? 0x31 : 0x30
        type(written, into: model)
        XCTAssertEqual(model.typed, RecoveryText.symbolCount)
        XCTAssertFalse(model.matches, "the check symbol or the bytes differ")
        model.confirm()
        XCTAssertNil(source.first)
        XCTAssertFalse(model.isClosed)
    }

    func testTypingReadsCaseAndSeparatorsAsTheEntryDoes() {
        let (model, source, _) = make()
        type(source.written.map { $0 >= 0x41 && $0 <= 0x5A ? $0 + 0x20 : $0 }, into: model)
        XCTAssertTrue(model.matches, "lower case reads the same")
        XCTAssertFalse(model.key(0x21), "a character outside the alphabet is refused")
        model.deleteLast()
        XCTAssertFalse(model.matches)
        XCTAssertEqual(model.typed, RecoveryText.symbolCount - 1)
    }

    func testConfirmAnswersTrueFromInsideTheSecretAndWipes() {
        let (model, source, _) = make()
        XCTAssertFalse(model.buffers.isZero, "the key is in the draw buffers while the sheet is open")
        type(source.written, into: model)
        model.confirm()
        XCTAssertEqual(source.first, true, "the first answer stands; the close's decline after it changes nothing")
        XCTAssertTrue(model.isClosed)
        XCTAssertTrue(model.buffers.isZero)
        XCTAssertEqual(model.typed, 0)
        XCTAssertNil(source.withSecret { _ in 1 })
    }

    func testCancelAndEveryOtherCloseDeclineAndWipe() {
        let (model, source, _) = make()
        type(Array(source.written.prefix(20)), into: model)
        model.close() // Cancel, a closed window, a quit: the same call
        XCTAssertEqual(source.answers, [false])
        XCTAssertTrue(model.buffers.isZero)
        XCTAssertEqual(model.typed, 0)
        model.close()
        XCTAssertEqual(source.answers, [false], "closing again answers nothing more")
        XCTAssertFalse(model.key(0x41), "a closed sheet takes no key")
        XCTAssertNil(model.withDrawing { _, _, _ in 1 })
    }

    func testSecureInputIsOnOnlyWhileFieldWindowAndAppAllow() {
        let (model, _, sw) = make()
        let g = model.secureInput
        g.firstResponder = true
        g.windowKey = true
        XCTAssertEqual(sw.on, 0, "the app is not active yet")
        g.appActive = true
        XCTAssertTrue(sw.on == 1 && sw.off == 0)
        g.appActive = true // no change: no second enable
        XCTAssertEqual(sw.on, 1)
        g.appActive = false
        XCTAssertTrue(sw.on == 1 && sw.off == 1)
        g.appActive = true
        g.firstResponder = false
        g.firstResponder = true
        g.windowKey = false
        XCTAssertEqual(sw.on - sw.off, 0, "every enable has its disable")
        g.windowKey = true
        XCTAssertEqual(sw.on - sw.off, 1)
        model.close()
        XCTAssertEqual(sw.on - sw.off, 0, "closing turns it off")
        g.firstResponder = false
        g.firstResponder = true
        XCTAssertEqual(sw.on - sw.off, 0, "and never on again")
    }
}

private final class Switch: @unchecked Sendable {
    var on = 0, off = 0
}
