// The frames of a get, gathered in order (file-content design, 3.6): the link resumes a drop from the last offset, so the next frame
// continues where the bytes end.
import Foundation
import XCTest
@testable import Relay

final class BlobGathererTests: XCTestCase {
    func testFramesInOrderMakeTheWholeAndAResumeContinuesAtTheLastOffset() {
        var g = BlobGatherer()
        XCTAssertTrue(g.take(offset: 0, chunk: Data([1, 2, 3])))
        XCTAssertTrue(g.take(offset: 3, chunk: Data([4, 5])), "the first frame after a drop starts where the last one ended")
        XCTAssertEqual(g.data, Data([1, 2, 3, 4, 5]))
    }

    func testAFrameOutOfOrderIsRefusedAndAddsNothing() {
        var g = BlobGatherer()
        XCTAssertTrue(g.take(offset: 0, chunk: Data([1, 2])))
        XCTAssertFalse(g.take(offset: 0, chunk: Data([9])), "a repeat")
        XCTAssertFalse(g.take(offset: 5, chunk: Data([9])), "a gap")
        XCTAssertEqual(g.data, Data([1, 2]))
    }

    func testAnOutOfOrderFrameEndsTheGetAsGoneAndLaterFramesAreIgnored() async {
        let fetches = Fetches()
        let outcome = await withCheckedContinuation { (c: CheckedContinuation<FetchOutcome, Never>) in
            fetches.add(1, Fetches.Get(channel: Data(), blob: Data(), c))
            fetches.take(request: 1, offset: 0, chunk: Data([1]))
            fetches.take(request: 1, offset: 7, chunk: Data([2]))
            fetches.take(request: 1, offset: 1, chunk: Data([3]))
        }
        XCTAssertEqual(outcome, .gone)
        XCTAssertNil(fetches.end(1))
    }

    func testEndAllEndsEveryGet() async {
        let fetches = Fetches()
        let outcome = await withCheckedContinuation { (c: CheckedContinuation<FetchOutcome, Never>) in
            fetches.add(2, Fetches.Get(channel: Data(), blob: Data(), c))
            fetches.endAll()
        }
        XCTAssertEqual(outcome, .ended)
    }
}
