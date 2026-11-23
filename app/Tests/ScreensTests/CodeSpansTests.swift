// Code spans in a bot's text (CommonMark 0.31.2, 6.1): what is read as code and what stays exactly as written.
@testable import Screens
import XCTest

final class CodeSpansTests: XCTestCase {
    func testASpanIsCutOutOfTheText() {
        XCTAssertEqual(CodeSpans.pieces("Bound to `~/demo`. Next."), [.plain("Bound to "), .code("~/demo"), .plain(". Next.")])
    }

    func testATextWithoutBackticksIsOnePlainPiece() {
        XCTAssertEqual(CodeSpans.pieces("**bold** and __x__ and a\\b"), [.plain("**bold** and __x__ and a\\b")])
    }

    func testAnUnclosedRunStaysAsWritten() {
        XCTAssertEqual(CodeSpans.pieces("a ` b"), [.plain("a ` b")])
        XCTAssertEqual(CodeSpans.pieces("``a`"), [.plain("``a`")])
    }

    func testOnlyARunOfTheSameLengthCloses() {
        XCTAssertEqual(CodeSpans.pieces("``a ` b``"), [.code("a ` b")])
        XCTAssertEqual(CodeSpans.pieces("`a``b`"), [.code("a``b")])
    }

    func testOneSpaceIsDroppedAtEachEndOnlyWhenBothHaveOne() {
        XCTAssertEqual(CodeSpans.pieces("`` `x` ``"), [.code("`x`")])
        XCTAssertEqual(CodeSpans.pieces("` a`"), [.code(" a")])
        XCTAssertEqual(CodeSpans.pieces("`  `"), [.code("  ")])
    }

    func testALineEndingInsideASpanIsASpace() {
        XCTAssertEqual(CodeSpans.pieces("`a\nb`"), [.code("a b")])
    }

    func testTheStyledTextKeepsEveryPlainCharacter() {
        let text = "Run `npm test` then *done*"
        XCTAssertEqual(String(CodeSpans.styled(text).characters), "Run npm test then *done*")
    }

    func testAFencedBlockStaysAsWritten() {
        let text = "Run this:\n```sh\nnpm install\nnpm test\n```\nDone `x`."
        XCTAssertEqual(CodeSpans.pieces(text), [.plain("Run this:\n```sh\nnpm install\nnpm test\n```\nDone "), .code("x"), .plain(".")])
    }

    func testAnUnclosedFenceRunsToTheEndAsWritten() {
        XCTAssertEqual(CodeSpans.pieces("a\n~~~\n`b`"), [.plain("a\n~~~\n`b`")])
    }

    func testASpanDoesNotCrossABlankLine() {
        let text = "Don't use ` here.\n\nStep 3 uses `x`."
        XCTAssertEqual(CodeSpans.pieces(text), [.plain("Don't use ` here.\n\nStep 3 uses "), .code("x"), .plain(".")])
    }

    func testAnEscapedBacktickOpensNoSpan() {
        XCTAssertEqual(CodeSpans.pieces("Use \\`a` and `b`"), [.plain("Use \\`a"), .code("and"), .plain("b`")])
    }

    func testDirectionAndZeroWidthMarksShowInsideASpan() {
        XCTAssertEqual(CodeSpans.pieces("`rm \u{202E}cod\u{200B}.sh`"), [.code("rm [U+202E]cod[U+200B].sh")])
    }

    func testALongTextIsNotRead() {
        let text = String(repeating: "a", count: CodeSpans.most) + " `x`"
        XCTAssertEqual(String(CodeSpans.styled(text).characters), text)
    }

    func testAnEscapedBackslashLetsTheBacktickOpenASpan() {
        XCTAssertEqual(CodeSpans.pieces("a \\\\`code` b"), [.plain("a \\\\"), .code("code"), .plain(" b")])
    }

    func testEveryInvisibleCodePointShowsInsideASpan() {
        XCTAssertEqual(CodeSpans.pieces("`rm\u{00AD} -rf\u{E0041}\u{3164}`"), [.code("rm[U+00AD] -rf[U+E0041][U+3164]")])
    }

    func testABacktickWithACombiningMarkStillCounts() {
        XCTAssertEqual(CodeSpans.pieces("`x`\u{0301} then `y`"), [.code("x"), .plain("\u{0301} then "), .code("y")])
    }

    func testALoneCarriageReturnEndsALine() {
        XCTAssertEqual(CodeSpans.pieces("`a\r\rb`"), [.plain("`a\r\rb`")])
        XCTAssertEqual(CodeSpans.pieces("```\r`a`\r```\rafter `b`"), [.plain("```\r`a`\r```\rafter "), .code("b")])
    }
}
