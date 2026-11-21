// The errors a screen can show (issue #61): each reads as a clause a person understands, never a case name or a bridged "The operation
// couldn't be completed" alone, and no screen or controller puts a raw error into its text.
import Foundation
import Network
import Platform
@testable import ProtocolHost
@testable import Relay
import XCTest

final class ProblemTests: XCTestCase {
    /// One of every error the app's code throws or meets on the way to a screen.
    private let errors: [Error] = [
        HostError.scriptUnavailable, HostError.faulted("the link answered neither a result nor a refusal"), HostError.foreignHandle,
        Failure.badInput, Failure.noSuchKey, Failure.keyExists, Failure.openFailed, Failure.ioFailed,
        Fault(message: "a key blob is empty"), EntryRefused(reason: "no-such-key"), RecoveryRefused(reason: "key-exists"), RelayError.invalidItem,
        RecoveryTextError.wrongLength, RecoveryTextError.badCharacter, RecoveryTextError.outOfRange, RecoveryTextError.wrongCheck,
        StoreError(description: "the store's folder cannot be created: Permission denied"), StoreBusy(), StoreClaimed(),
        PairingFault(description: "the pairing file is not JSON"), PairingStateRefused(description: "the state has no person"),
        LinkStoreMismatch(description: "the link's store belongs to other keys or another relay"),
        NWError.posix(.ECONNREFUSED), NWError.dns(-65554), NWError.tls(-9806),
        CocoaError(.fileReadNoPermission), URLError(.timedOut), POSIXError(.ENOSPC),
    ]

    func testEveryErrorReadsAsAClause() {
        for error in errors {
            let reason = Problem.reason(error)
            XCTAssertTrue(reason.contains(" "), "\(error): \(reason) is a code, not words")
            XCTAssertFalse(reason.contains("couldn\u{2019}t be completed") || reason.contains("couldn't be completed"), "\(error): \(reason)")
            XCTAssertFalse(reason.hasSuffix("."), "\(error): the sentence around it ends it")
            XCTAssertTrue(reason.hasPrefix("Pardner") || String(reason.prefix(1)) == reason.prefix(1).lowercased(), "\(error): it follows a colon")
        }
    }

    func testAnNSErrorGivesItsOwnSentenceNeverADump() {
        let said = NSError(domain: "com.apple.LocalAuthentication", code: -2, userInfo: [NSLocalizedDescriptionKey: "Authentication was canceled."])
        XCTAssertEqual(Problem.reason(said), "authentication was canceled")
        XCTAssertEqual(Problem.reason(NSError(domain: "kCFErrorDomainCFNetwork", code: 310)), "a system error (kCFErrorDomainCFNetwork 310)")
        XCTAssertEqual(Problem.reason(NSError(domain: "x", code: 1, userInfo: [NSLocalizedDescriptionKey: "SSL error has occurred."])), "SSL error has occurred",
                       "an acronym keeps its capitals")
    }

    func testASentenceNamesWhatFailedTheReasonAndTheNextStep() {
        XCTAssertEqual(Problem.sentence("Setup could not finish", Failure.ioFailed, next: "Try again."),
                       "Setup could not finish: the disk could not be read or written. Try again.")
        XCTAssertEqual(Problem.sentence("Setup could not finish", HostError.scriptUnavailable, next: "Check the relay's values and try again."),
                       "Setup could not finish: this copy of Pardner lacks its protocol script, so it is incomplete. Install Pardner again from a complete build.",
                       "the step only one fix helps replaces the screen's own")
    }

    func testNoScreenPutsARawErrorInItsText() throws {
        var app = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { app.deleteLastPathComponent() }
        let sources = app.appendingPathComponent("Sources")
        let files = try XCTUnwrap(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)).compactMap { $0 as? URL }
            .filter { ($0.path.contains("/Sources/Screens/") || $0.path.contains("/Sources/Relay/")) && $0.pathExtension == "swift" }
        XCTAssertFalse(files.isEmpty)
        for file in files where file.lastPathComponent != "Problem.swift" {
            for (number, line) in try String(contentsOf: file, encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                // A log line may describe the error: what reaches a screen goes through `Problem`.
                if line.contains("log.") { continue }
                XCTAssertFalse(line.contains("\\(error)") || line.contains("error.localizedDescription"),
                               "\(file.lastPathComponent):\(number + 1) puts a raw error into a text: use Problem.reason or Problem.sentence")
            }
        }
    }
}
