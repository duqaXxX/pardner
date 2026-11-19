// The app's three font families, bundled in Fonts/ (SIL OFL 1.1; the licence texts sit beside the files). All three
// are variable fonts: a weight reaches the font's `wght` axis through a variation, since a named instance does not
// exist for every weight the design uses (Space Grotesk has no 600).
import CoreText
import Foundation
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
        "Fonts/InterVariable.ttf", "Fonts/SpaceGrotesk[wght].ttf", "Fonts/JetBrainsMono[wght].ttf",
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
    /// Inter: lists, messages, controls.
    public static func ui(size: CGFloat, weight: InterWeight) -> Font {
        Font(ctFont(file: "InterVariable.ttf", size: size, weight: weight.rawValue))
    }

    /// Space Grotesk: the name, the activity figures, avatar initials.
    public static func display(size: CGFloat, weight: DisplayWeight) -> Font {
        Font(ctFont(file: "SpaceGrotesk[wght].ttf", size: size, weight: weight.rawValue))
    }

    /// JetBrains Mono: file names, branches, paths, diffs.
    public static func mono(size: CGFloat, weight: MonoWeight) -> Font {
        Font(ctFont(file: "JetBrainsMono[wght].ttf", size: size, weight: weight.rawValue))
    }

    /// The `wght` axis identifier, the four characters of the tag.
    static let weightAxis = 0x7767_6874

    /// The font of a bundled file with its `wght` axis set; the file's own descriptor names the family, so no name
    /// lookup can land on another face.
    static func ctFont(file: String, size: CGFloat, weight: Double) -> CTFont {
        let url = Bundle.module.resourceURL!.appendingPathComponent("Fonts/\(file)")
        guard let base = (CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor])?.first
        else { fatalError("DesignSystem: \(file) is missing or unreadable") }
        let varied = CTFontDescriptorCreateCopyWithAttributes(
            base, [kCTFontVariationAttribute: [weightAxis: weight]] as CFDictionary)
        return CTFontCreateWithFontDescriptor(varied, size, nil)
    }
}
