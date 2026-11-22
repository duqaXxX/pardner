// Renders the app icon to the asset catalog's AppIcon set: the ten PNGs of the 16 to 512 point sizes at 1x and 2x.
// Usage: swift run icon-render [<AppIcon.appiconset dir>] (default: Shell/Assets.xcassets/AppIcon.appiconset, from app/).
import AppKit
import DesignSystem
import Screens
import SwiftUI

let out = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "Shell/Assets.xcassets/AppIcon.appiconset")
_ = NSApplication.shared
NSApp.appearance = NSAppearance(named: .aqua) // the tokens' colours are dynamic: the icon is the Light pair
for failure in PardnerFonts.register() { FileHandle.standardError.write(Data("font: \(failure)\n".utf8)) }

@MainActor
func render(pixels: Int, to file: String) throws {
    let renderer = ImageRenderer(content: AppIcon(size: CGFloat(pixels)))
    renderer.scale = 1
    guard let image = renderer.cgImage else { throw CocoaError(.fileWriteUnknown) }
    guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
    try png.write(to: out.appendingPathComponent(file))
}

try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
var images: [String] = []
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = "icon_\(points)x\(points)@\(scale)x.png"
        try render(pixels: points * scale, to: name)
        images.append(#"    { "filename" : "\#(name)", "idiom" : "mac", "scale" : "\#(scale)x", "size" : "\#(points)x\#(points)" }"#)
    }
}
let contents = "{\n  \"images\" : [\n" + images.joined(separator: ",\n") + "\n  ],\n  \"info\" : { \"author\" : \"xcode\", \"version\" : 1 }\n}\n"
try contents.write(to: out.appendingPathComponent("Contents.json"), atomically: true, encoding: .utf8)
