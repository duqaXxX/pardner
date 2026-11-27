// The app's three font families, bundled in Fonts/ (SIL OFL 1.1; the licence texts sit beside the files). Inter has an
// upright and an italic file. All are variable fonts: a weight reaches the font's `wght` axis through a variation, since a named instance does not
// exist for every weight the design uses (Space Grotesk has no 600).
import CoreText
import Foundation
import Synchronization
import SwiftUI

/// Registers the bundled font files for the process.
public enum PardnerFonts {
    /// A font file CoreText refused, with the reason it gave.
    public struct Failure: Error, Equatable, CustomStringConvertible, Sendable {
        /// The file that was not registered.
        public let file: String
        /// CoreText's description of the error.
        public let reason: String
        public var description: String { "\(file): \(reason)" }
    }

    /// The bundled files, relative to the module's resources.
    static let files = [
        "Fonts/InterVariable.ttf", "Fonts/InterVariable-Italic.ttf", "Fonts/SpaceGrotesk[wght].ttf",
        "Fonts/JetBrainsMono[wght].ttf",
    ]

    private static let outcome: [Failure] = {
        var failures: [Failure] = []
        for file in files {
            let url = Bundle.module.resourceURL!.appendingPathComponent(file)
            var error: Unmanaged<CFError>?
            if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) { continue }
            guard let error = error?.takeRetainedValue() else {
                failures.append(Failure(file: url.lastPathComponent, reason: "registration refused"))
                continue
            }
            // A file already registered by this process is not a failure.
            if CFErrorGetDomain(error) as String == kCTFontManagerErrorDomain as String,
                CFErrorGetCode(error) == CTFontManagerError.alreadyRegistered.rawValue { continue }
            failures.append(Failure(file: url.lastPathComponent, reason: CFErrorCopyDescription(error) as String))
        }
        return failures
    }()

    /// Registers the three families once per process; later calls return the first outcome. The list holds the files
    /// CoreText refused (empty on success): the caller decides whether a missing font is fatal.
    @discardableResult
    public static func register() -> [Failure] { outcome }
}

/// The weights Inter is used at.
public enum InterWeight: Double, CaseIterable, Sendable {
    case regular = 400, medium = 500, semibold = 600, bold = 700
}

/// The weights Space Grotesk is used at.
public enum DisplayWeight: Double, CaseIterable, Sendable {
    case semibold = 600, bold = 700
}

/// The weights JetBrains Mono is used at.
public enum MonoWeight: Double, CaseIterable, Sendable {
    case regular = 400, medium = 500
}

/// The three uses of type in the design, each a font at a size and a weight. Call `PardnerFonts.register()` first.
public enum PardnerFont {
    /// Inter: lists, messages, controls. A variable font built from a `CTFont` has no bold or italic face SwiftUI can
    /// derive, so emphasis asks for the weight and the italic file here. `tabular` gives every digit one width, for a column of numbers.
    public static func ui(size: CGFloat, weight: InterWeight, italic: Bool = false, tabular: Bool = false) -> Font {
        Font(ctFont(file: interFile(italic: italic), size: size, weight: weight.rawValue, tabular: tabular))
    }

    /// Space Grotesk: the name, the activity figures.
    public static func display(size: CGFloat, weight: DisplayWeight) -> Font {
        Font(ctFont(file: "SpaceGrotesk[wght].ttf", size: size, weight: weight.rawValue))
    }

    /// JetBrains Mono: file names, branches, paths, diffs.
    public static func mono(size: CGFloat, weight: MonoWeight) -> Font {
        Font(ctFont(file: "JetBrainsMono[wght].ttf", size: size, weight: weight.rawValue))
    }

    /// Inter as a `CTFont`, for an AppKit view that draws text by itself (the composer's field, a link's text view).
    public static func uiCT(size: CGFloat, weight: InterWeight, italic: Bool = false, tabular: Bool = false) -> CTFont {
        ctFont(file: interFile(italic: italic), size: size, weight: weight.rawValue, tabular: tabular)
    }

    /// JetBrains Mono as a `CTFont`, for drawing glyphs by hand (the recovery key is never given to a `Text`).
    public static func monoCT(size: CGFloat, weight: MonoWeight) -> CTFont {
        ctFont(file: "JetBrainsMono[wght].ttf", size: size, weight: weight.rawValue)
    }

    private static func interFile(italic: Bool) -> String { italic ? "InterVariable-Italic.ttf" : "InterVariable.ttf" }

    /// The `wght` axis identifier, the four characters of the tag.
    static let weightAxis = 0x7767_6874

    private struct Key: Hashable {
        let file: String
        let size: CGFloat
        let weight: Double
        let tabular: Bool
    }

    /// Fonts already built. Reading a font file costs about 90 microseconds, and a long table asks for a font per cell at every
    /// redraw. A lock guards it: `uiCT` and `monoCT` may be called off the main actor.
    private static let built = Mutex<[Key: CTFont]>([:])

    /// The font of a bundled file with its `wght` axis set, built once per file, size and weight; the file's own descriptor names
    /// the family, so no name lookup can land on another face.
    static func ctFont(file: String, size: CGFloat, weight: Double, tabular: Bool = false) -> CTFont {
        let key = Key(file: file, size: size, weight: weight, tabular: tabular)
        return built.withLock { cache in
            if let font = cache[key] { return font }
            let url = Bundle.module.resourceURL!.appendingPathComponent("Fonts/\(file)")
            guard let base = (CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor])?.first
            else { fatalError("DesignSystem: \(file) is missing or unreadable") }
            var attributes: [CFString: Any] = [kCTFontVariationAttribute: [weightAxis: weight]]
            if tabular {
                // Inter's `tnum` OpenType feature, asked by its tag.
                attributes[kCTFontFeatureSettingsAttribute] = [[kCTFontOpenTypeFeatureTag: "tnum", kCTFontOpenTypeFeatureValue: 1]]
            }
            let varied = CTFontDescriptorCreateCopyWithAttributes(base, attributes as CFDictionary)
            let font = CTFontCreateWithFontDescriptor(varied, size, nil)
            cache[key] = font
            return font
        }
    }
}

/// The type scale of the visual pass (#174, section 5): each use a font and the line height it is set on.
public extension PardnerFont {
    /// Pardner, the channel and the thread: Space Grotesk 600, 17 on 22.
    static var title: Font { display(size: 17, weight: .semibold) }
    static let titleLine: CGFloat = 22
    /// Messages and lists: Inter 14 on 22.
    static var text: Font { ui(size: 14, weight: .regular) }
    static let textLine: CGFloat = 22
    /// A heading inside a message, semibold: level 1 is Inter 16 on 24, the others 14 on 22.
    static let headingSize1: CGFloat = 16
    static let headingLine1: CGFloat = 24
    static let headingSize: CGFloat = 14
    static let headingLine: CGFloat = 22
    /// A tool's row (a call, a fold): Inter 12.5, muted, the verb alone semibold.
    static let toolSize: CGFloat = 12.5
    /// Times, notes and the session's data: Inter 12 on 16.
    static var secondary: Font { ui(size: 12, weight: .regular) }
    static let secondaryLine: CGFloat = 16
    /// A section's label, drawn upper case: Inter 11.
    static var sectionLabel: Font { ui(size: 11, weight: .semibold) }
    /// Code: JetBrains Mono 12.5 on 20.
    static var code: Font { mono(size: 12.5, weight: .regular) }
    static let codeLine: CGFloat = 20
}
