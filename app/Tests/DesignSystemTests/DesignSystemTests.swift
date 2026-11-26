// The tokens: every one parses, resolves in both appearances to the JSON value, and the text-on-ground pairs keep AA.
import AppKit
import SwiftUI
import XCTest
@testable import DesignSystem

final class DesignSystemTests: XCTestCase {
    /// Each static member with the JSON name it must resolve.
    static let members: [(String, Color)] = [
        ("bg", PardnerColor.bg), ("side", PardnerColor.side), ("panel", PardnerColor.panel),
        ("surface", PardnerColor.surface), ("raised", PardnerColor.raised), ("line", PardnerColor.line),
        ("text", PardnerColor.text), ("muted", PardnerColor.muted), ("rail", PardnerColor.rail),
        ("brand", PardnerColor.brand), ("brand-ink", PardnerColor.brandInk),
        ("brand-soft", PardnerColor.brandSoft), ("brand-text", PardnerColor.brandText),
        ("agent", PardnerColor.agent), ("agent-ink", PardnerColor.agentInk),
        ("agent-soft", PardnerColor.agentSoft), ("agent-text", PardnerColor.agentText),
        ("ok-text", PardnerColor.okText), ("ok-soft", PardnerColor.okSoft),
        ("add-bg", PardnerColor.addBg), ("add-text", PardnerColor.addText),
        ("del-bg", PardnerColor.delBg), ("del-text", PardnerColor.delText),
        ("badge", PardnerColor.badge), ("badge-ink", PardnerColor.badgeInk),
        ("select", PardnerColor.select), ("hover", PardnerColor.hover), ("code-bg", PardnerColor.codeBg),
    ]

    func testTwentyEightTokensEachWithBothValues() {
        XCTAssertEqual(Tokens.pairs.count, 28)
        XCTAssertEqual(Set(Self.members.map(\.0)), Set(Tokens.pairs.keys))
    }

    /// The light palette of the reference (#174, 4b) and the bands and the code ground the later units draw.
    func testTheLightPaletteIsTheReferences() {
        let want = ["bg": "#F1F3F7", "panel": "#F1F3F7", "side": "#E4E8EF", "surface": "#FBFCFD", "raised": "#D6DDE9", "line": "#C8D0DD",
                    "muted": "#4F5B70", "brand-soft": "#D9E4F6", "agent-soft": "#F5E6C6", "ok-soft": "#D5ECDF", "add-bg": "#D8EEE1",
                    "del-bg": "#F6DADA", "select": "#DFE8F6", "hover": "#F5F7FA", "code-bg": "#F2F5FA"]
        for (name, hex) in want { XCTAssertEqual(Tokens.pairs[name]?.light, RGBA(hex), name) }
        XCTAssertEqual(Tokens.pairs["select"]?.dark, RGBA("rgba(127,169,240,.1)"))
        XCTAssertEqual(Tokens.pairs["hover"]?.dark, RGBA("rgba(255,255,255,.04)"))
        XCTAssertEqual(Tokens.pairs["code-bg"]?.dark, RGBA("#232323"))
    }

    func testParser() {
        XCTAssertEqual(RGBA("#FF8000")?.green ?? 0, 128.0 / 255, accuracy: 1e-9)
        XCTAssertEqual(RGBA("rgba(127,169,240,.18)")?.alpha, 0.18)
        XCTAssertNil(RGBA("red"))
        XCTAssertNil(RGBA("#FFF"))
        XCTAssertNil(RGBA("rgba(1,2,3)"))
    }

    private func resolve(_ color: Color, _ name: NSAppearance.Name) -> NSColor {
        var out = NSColor.clear
        NSAppearance(named: name)!.performAsCurrentDrawingAppearance {
            out = NSColor(color).usingColorSpace(.sRGB)!
        }
        return out
    }

    func testResolvedColoursEqualTheJSONInBothAppearances() {
        let tol = 1.0 / 255
        for (name, color) in Self.members {
            let pair = Tokens.pairs[name]!
            for (appearance, want) in [(NSAppearance.Name.aqua, pair.light), (.darkAqua, pair.dark)] {
                let got = resolve(color, appearance)
                let label = "\(name) \(appearance.rawValue)"
                XCTAssertEqual(got.redComponent, want.red, accuracy: tol, label)
                XCTAssertEqual(got.greenComponent, want.green, accuracy: tol, label)
                XCTAssertEqual(got.blueComponent, want.blue, accuracy: tol, label)
                XCTAssertEqual(got.alphaComponent, want.alpha, accuracy: tol, label)
            }
        }
    }

    // The pairs and the method of actions/scripts/2026-11-19-design-extract/contrast.py.
    static let pairs = [
        ("text", "bg"), ("muted", "bg"), ("muted", "side"), ("muted", "raised"), ("text", "side"),
        ("brand-ink", "brand"), ("brand-text", "brand-soft"), ("brand-text", "bg"), ("agent-ink", "agent"),
        ("agent-text", "agent-soft"), ("ok-text", "ok-soft"), ("add-text", "add-bg"), ("del-text", "del-bg"),
        ("badge-ink", "badge"),
    ]

    private func over(_ f: RGBA, _ b: [Double]) -> [Double] {
        [f.red, f.green, f.blue].enumerated().map { ($0.element * f.alpha + b[$0.offset] * (1 - f.alpha)) }
    }

    private func luminance(_ c: [Double]) -> Double {
        let l = c.map { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
        return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]
    }

    func testTextOnGroundPairsKeepAAInBothThemes() {
        XCTAssertEqual(Self.pairs.count, 14)
        for theme in ["light", "dark"] {
            let pick = { (n: String) in theme == "light" ? Tokens.pairs[n]!.light : Tokens.pairs[n]!.dark }
            let base = [pick("bg").red, pick("bg").green, pick("bg").blue]
            for (fg, bg) in Self.pairs {
                let ground = over(pick(bg), base)
                let ink = over(pick(fg), ground)
                let (a, b) = (luminance(ink), luminance(ground))
                let ratio = (max(a, b) + 0.05) / (min(a, b) + 0.05)
                XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(fg) on \(bg), \(theme): \(ratio)")
            }
        }
    }
}

final class MetricsTests: XCTestCase {
    func testTheRadiiAndTheGapAreDecisionFivesValues() {
        XCTAssertEqual(PardnerMetrics.controlRadius, 7)
        XCTAssertEqual(PardnerMetrics.containerRadius, 12)
        XCTAssertEqual(PardnerMetrics.gap, 8)
    }

    func testABotsAnswerIsReadAtMost680Wide() {
        XCTAssertEqual(PardnerMetrics.answerWidth, 680)
    }
}

final class LayoutMetricsTests: XCTestCase {
    func testTheRowsAndTheRhythmAreTheIssuesValues() {
        XCTAssertEqual([PardnerMetrics.headerHeight, PardnerMetrics.subheaderHeight, PardnerMetrics.margin, PardnerMetrics.listEnd], [56, 40, 20, 16])
        XCTAssertEqual([PardnerMetrics.rowHeight, PardnerMetrics.userRowHeight], [30, 40])
        XCTAssertEqual([PardnerMetrics.messageGap, PardnerMetrics.groupGap, PardnerMetrics.cardGap], [20, 4, 10])
    }

    func testTheTypeScaleKeepsItsLineHeights() {
        XCTAssertEqual([PardnerFont.titleLine, PardnerFont.textLine, PardnerFont.secondaryLine, PardnerFont.codeLine], [22, 21, 16, 20])
    }
}
