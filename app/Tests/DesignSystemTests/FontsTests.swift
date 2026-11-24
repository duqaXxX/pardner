// The fonts: registered once without failure, each family found by name, each weight on the font's wght axis, and
// the bundled files the ones recorded: all but the Inter italic by PROVENANCE.md of the 2026-11-19 download; the italic
// comes from rsms/inter release v4.1 (Inter-4.1.zip), added 2026-11-24, whose InterVariable.ttf is byte-identical to the bundled one.
import CoreText
import CryptoKit
import XCTest
@testable import DesignSystem

final class FontsTests: XCTestCase {
    /// SHA-256 of the kept files: the download's provenance record (2026-11-19), and for the italic the v4.1 release (2026-11-24).
    static let digests = [
        "InterVariable.ttf": "4989b125924991b90d05b2d16e0e388c48f7d5bb8b30539bbf9c755278d0ccaf",
        "InterVariable-Italic.ttf": "d6f1f6a172d9e588438db9f986fd5cfad7b30f644374080a8a9d4d91e344586f",
        "SpaceGrotesk[wght].ttf": "acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72",
        "JetBrainsMono[wght].ttf": "662a196d58f1183bf2d77428b6d5283fe3f45161ab021bea4036bc98e5cac016",
    ]

    func testRegistrationSucceedsAndIsIdempotent() {
        XCTAssertEqual(PardnerFonts.register(), [])
        XCTAssertEqual(PardnerFonts.register(), [])
    }

    /// Registration is synchronous, with no wait on a callback: called on the main thread, it
    /// returns its result there. A hang would be caught by the test run's own timeout.
    @MainActor
    func testRegistrationReturnsOnTheMainThread() {
        XCTAssertTrue(Thread.isMainThread)
        XCTAssertEqual(PardnerFonts.register(), [])
    }

    func testEachFamilyResolvesByName() {
        PardnerFonts.register()
        for family in ["Inter Variable", "Space Grotesk", "JetBrains Mono"] {
            let found = CTFontDescriptorCreateWithAttributes([kCTFontFamilyNameAttribute: family] as CFDictionary)
            let font = CTFontCreateWithFontDescriptor(found, 12, nil)
            XCTAssertEqual(CTFontCopyFamilyName(font) as String, family)
        }
    }

    /// The `wght` value and the family a font reports. CoreText leaves an axis at its default out of the variation
    /// dictionary, so a missing entry reads as the axis default.
    private func report(_ font: CTFont) -> (family: String, wght: Double?) {
        let variation = CTFontCopyVariation(font) as? [Int: Double]
        let axes = CTFontCopyVariationAxes(font) as? [[String: Any]] ?? []
        let standard = axes.first { ($0[kCTFontVariationAxisIdentifierKey as String] as? Int) == PardnerFont.weightAxis }
        let fallback = standard?[kCTFontVariationAxisDefaultValueKey as String] as? Double
        return (CTFontCopyFamilyName(font) as String, variation?[PardnerFont.weightAxis] ?? fallback)
    }

    func testEveryWeightTheDesignUsesReachesTheAxis() {
        PardnerFonts.register()
        for w in InterWeight.allCases {
            let r = report(PardnerFont.ctFont(file: "InterVariable.ttf", size: 13, weight: w.rawValue))
            XCTAssertEqual(r.family, "Inter Variable")
            XCTAssertEqual(r.wght, w.rawValue)
        }
        for w in InterWeight.allCases {
            let r = report(PardnerFont.ctFont(file: "InterVariable-Italic.ttf", size: 13, weight: w.rawValue))
            XCTAssertEqual(r.family, "Inter Variable")
            XCTAssertEqual(r.wght, w.rawValue)
            XCTAssertTrue(CTFontGetSymbolicTraits(PardnerFont.ctFont(file: "InterVariable-Italic.ttf", size: 13, weight: w.rawValue)).contains(.traitItalic))
        }
        for w in DisplayWeight.allCases {
            let r = report(PardnerFont.ctFont(file: "SpaceGrotesk[wght].ttf", size: 18, weight: w.rawValue))
            XCTAssertEqual(r.family, "Space Grotesk")
            XCTAssertEqual(r.wght, w.rawValue)
        }
        for w in MonoWeight.allCases {
            let r = report(PardnerFont.ctFont(file: "JetBrainsMono[wght].ttf", size: 12, weight: w.rawValue))
            XCTAssertEqual(r.family, "JetBrains Mono")
            XCTAssertEqual(r.wght, w.rawValue)
        }
        // The public entry points build without trapping.
        _ = PardnerFont.ui(size: 13, weight: .semibold)
        _ = PardnerFont.ui(size: 13, weight: .semibold, italic: true)
        _ = PardnerFont.display(size: 18, weight: .bold)
        _ = PardnerFont.mono(size: 12, weight: .regular)
    }

    func testAFontIsBuiltOncePerFileSizeAndWeight() {
        PardnerFonts.register()
        let a = PardnerFont.ctFont(file: "InterVariable-Italic.ttf", size: 14, weight: 600)
        XCTAssertTrue(a === PardnerFont.ctFont(file: "InterVariable-Italic.ttf", size: 14, weight: 600))
        XCTAssertFalse(a === PardnerFont.ctFont(file: "InterVariable-Italic.ttf", size: 14, weight: 700))
    }

    func testBundledFilesAreTheRecordedOnes() throws {
        let dir = Bundle.module.resourceURL!.appendingPathComponent("Fonts")
        for (name, digest) in Self.digests {
            let data = try Data(contentsOf: dir.appendingPathComponent(name))
            XCTAssertEqual(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), digest, name)
        }
        for licence in ["LICENSE-Inter.txt", "OFL-SpaceGrotesk.txt", "OFL-JetBrainsMono.txt"] {
            XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent(licence).path), licence)
        }
    }
}
