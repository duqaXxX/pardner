// The thumbnails under a call's line (step E2 design 3.1): how a returned image is decoded and bounded, which types are drawn, the fetch kept by
// blob id (once, from the first time a thumbnail is asked for, and again only after the cache dropped it), and the click's window.
@testable import Conversation
import CoreGraphics
import Foundation
import ImageIO
import ProtocolHost
@testable import Relay
@testable import Screens
import UniformTypeIdentifiers
import XCTest

/// The 64x32 PNG of `test/fixtures/sdk/read-image.jsonl` (113 bytes, synthetic).
private let flag = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAOElEQVR4nO3PsQkAAAzDsPz/dHpFliLwbFCaTBvvu94DAAAAAAAAAAAAAAAAAAAAAAAAAAAAPAQcOkv4asq/aw0AAAAASUVORK5CYII=")!

/// A solid-colour image of `width` x `height` written as `type` (a type ImageIO can write).
private func encoded(_ width: Int, _ height: Int, as type: UTType) -> Data {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.setFillColor(red: 0.8, green: 0.1, blue: 0.1, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let out = NSMutableData()
    let destination = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    precondition(CGImageDestinationFinalize(destination))
    return out as Data
}

/// What a `@Sendable` fetch stand-in counts and hands out; past its script the relay lacks the blob.
private final class Script: @unchecked Sendable {
    private let lock = NSLock()
    private var outcomes: [FetchOutcome]
    private(set) var calls = 0
    init(_ outcomes: [FetchOutcome]) { self.outcomes = outcomes }
    private func take() -> FetchOutcome {
        lock.lock(); defer { lock.unlock() }
        calls += 1
        return outcomes.isEmpty ? .gone : outcomes.removeFirst()
    }

    func next() async -> FetchOutcome { take() }
}

/// A fetch stand-in whose answer the test changes while it runs.
private final class Switch: @unchecked Sendable {
    private let lock = NSLock()
    private var outcome: FetchOutcome
    private var count = 0
    init(_ outcome: FetchOutcome) { self.outcome = outcome }
    var calls: Int { lock.lock(); defer { lock.unlock() }; return count }
    func answer(_ next: FetchOutcome) { lock.lock(); outcome = next; lock.unlock() }
    private func take() -> FetchOutcome { lock.lock(); defer { lock.unlock() }; count += 1; return outcome }
    func next() async -> FetchOutcome { take() }
}

@MainActor
final class LineImagesViewTests: XCTestCase {
    private let channel = Data(repeating: 0x3F, count: 32)
    private let blob = Data(repeating: 7, count: 32)

    /// Waits until `condition` holds, polling for at most `timeout` seconds; false when it never did.
    private func until(timeout: Double = 5, _ condition: () -> Bool) async -> Bool {
        let end = ContinuousClock.now + .seconds(timeout)
        while !condition(), ContinuousClock.now < end { try? await Task.sleep(for: .milliseconds(5)) }
        return condition()
    }

    private func opener(_ script: Script) -> FileOpener {
        let o = FileOpener(conversation: ConversationModel(), devices: DevicesModel(state: DevicesState()), send: { _, _ in .ended }, fetch: { _, _ in await script.next() })
        o.retryAfter = .milliseconds(10)
        return o
    }

    // MARK: decoding

    func testAPngIsDecodedAtItsSize() throws {
        let thumb = try XCTUnwrap(Thumbnail.make(from: flag))
        XCTAssertEqual([thumb.image.width, thumb.image.height], [64, 32])
    }

    func testALargeImageIsBoundedTo320PixelsOnItsLongSide() throws {
        let thumb = try XCTUnwrap(Thumbnail.make(from: encoded(2000, 1000, as: .png)))
        XCTAssertEqual([thumb.image.width, thumb.image.height], [320, 160])
        let tall = try XCTUnwrap(Thumbnail.make(from: encoded(500, 1500, as: .jpeg)))
        XCTAssertEqual(tall.image.height, 320)
        XCTAssertLessThanOrEqual(tall.image.width, 320)
    }

    func testPngJpegAndGifAreDrawnAndNothingElseIs() {
        for type in [UTType.png, .jpeg, .gif] { XCTAssertNotNil(Thumbnail.make(from: encoded(40, 20, as: type)), type.identifier) }
        for type in [UTType.tiff, .bmp] { XCTAssertNil(Thumbnail.make(from: encoded(40, 20, as: type)), "\(type.identifier) is refused") }
        XCTAssertNil(Thumbnail.make(from: Data("not an image".utf8)))
        XCTAssertNil(Thumbnail.make(from: Data(flag.prefix(40))), "a truncated image that does not decode")
        XCTAssertNil(Thumbnail.make(from: Data()))
    }

    // MARK: the fetch kept by blob id

    func testAThumbnailIsFetchedOnceWhoeverAsksAndHoweverOften() async throws {
        let script = Script([.file(flag)])
        let o = opener(script)
        let (channel, blob) = (channel, blob)
        let first = Task { await o.thumbnail(channel: channel, blob: blob) }
        let second = Task { await o.thumbnail(channel: channel, blob: blob) }
        let (a, b) = (await first.value, await second.value)
        XCTAssertNotNil(a)
        XCTAssertTrue(a === b, "the two askers share one fetch")
        let again = await o.thumbnail(channel: channel, blob: blob)
        XCTAssertTrue(again === a, "a row that comes back finds the thumbnail kept")
        XCTAssertEqual(script.calls, 1)
    }

    func testAThumbnailTheCacheDroppedIsFetchedAgain() async throws {
        let script = Script([.file(flag), .file(flag)])
        let o = opener(script)
        _ = await o.thumbnail(channel: channel, blob: blob)
        o.dropThumbnails()
        let again = await o.thumbnail(channel: channel, blob: blob)
        XCTAssertNotNil(again)
        XCTAssertEqual(script.calls, 2)
    }

    func testABlobTheRelayLacksOrAnImageThatDoesNotReadIsUnreadableAndAskedOnce() async throws {
        let script = Script([.gone, .file(Data("not an image".utf8))])
        let o = opener(script)
        let other = Data(repeating: 8, count: 32)
        let gone = await o.thumbnail(channel: channel, blob: blob)
        let refused = await o.thumbnail(channel: channel, blob: other)
        XCTAssertNil(gone)
        XCTAssertNil(refused)
        let goneAgain = await o.thumbnail(channel: channel, blob: blob)
        let refusedAgain = await o.thumbnail(channel: channel, blob: other)
        XCTAssertNil(goneAgain)
        XCTAssertNil(refusedAgain)
        XCTAssertEqual(script.calls, 2, "a verdict is kept: a row that comes back starts nothing")
    }

    func testAFetchTheConnectionCouldNotMakeIsAskedAgainUntilItAnswers() async throws {
        let script = Script([.ended, .ended, .file(flag)])
        let o = opener(script)
        let thumb = await o.thumbnail(channel: channel, blob: blob)
        XCTAssertNotNil(thumb)
        XCTAssertEqual(script.calls, 3)
    }

    func testAFetchTheConnectionCannotMakeIsNotAskedAgainOnceNoViewWaitsForIt() async throws {
        let relay = Switch(.ended)
        let o = FileOpener(conversation: ConversationModel(), devices: DevicesModel(state: DevicesState()), send: { _, _ in .ended }, fetch: { _, _ in await relay.next() })
        o.retryAfter = .milliseconds(10)
        let (channel, blob) = (channel, blob)
        let first = Task { await o.thumbnail(channel: channel, blob: blob) }
        let second = Task { await o.thumbnail(channel: channel, blob: blob) }
        // Waits for what is expected, so a loaded machine slows the test but cannot fail it.
        let asked = await until { relay.calls > 2 }
        XCTAssertTrue(asked, "a thumbnail on screen is asked again")
        first.cancel() // its view left: the other still waits
        let whileOneWaits = relay.calls
        let stillAsked = await until { relay.calls > whileOneWaits + 1 }
        XCTAssertTrue(stillAsked, "one view still waits")
        second.cancel()
        _ = await until(timeout: 0.3) { false } // a fetch already started may still answer
        let atTheEnd = relay.calls
        _ = await until(timeout: 0.3) { false }
        XCTAssertEqual(relay.calls, atTheEnd, "no view waits: nothing is asked")
        // A view that comes back starts it again; the first answer was no verdict.
        relay.answer(.file(flag))
        let back = await o.thumbnail(channel: channel, blob: blob)
        XCTAssertNotNil(back)
    }

    // MARK: the words and the click

    func testTheWordsOfAnImageThatCannotBeRead() {
        XCTAssertEqual(ThumbnailWords.unreadable, "This image can no longer be read.")
    }

    func testAClickOpensTheFileWindowOnThatImageOfTheLinesBot() {
        let file = FileInfo(blob: blob, size: 113, type: "image/png", name: "image-2.png")
        let bot = Data(repeating: 3, count: 32)
        let at = Date(timeIntervalSince1970: 1_700_000_000)
        let content = ThumbnailRow.content(of: file, place: FilePlace(channel: channel, thread: "t"), bot: bot, at: at)
        XCTAssertEqual(content, FileWindowContent(channel: channel, thread: "t", bot: bot, source: .sent(blob: blob, name: "image-2.png", size: 113, type: "image/png", at: at)))
    }
}
