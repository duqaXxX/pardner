// Renders the main window over the synthetic conversation, in Light and Dark, to PNG files: the screenshots
// of the screens' decisions document. Usage: swift run screens-snapshot <out dir>. Offscreen: no window shows.
import AppKit
import DesignSystem
import Screens
import SwiftUI

let out = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? ".")
_ = NSApplication.shared
for failure in PardnerFonts.register() { FileHandle.standardError.write(Data("font: \(failure)\n".utf8)) }

@MainActor
func render(_ name: NSAppearance.Name, to file: String) throws {
    let sample = Samples.model()
    let view = NSHostingView(rootView: MainWindow(model: sample.model, channel: sample.channel, thread: sample.thread))
    view.appearance = NSAppearance(named: name)
    let size = NSSize(width: 1280, height: 800)
    let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: name)
    window.contentView = view
    view.frame = NSRect(origin: .zero, size: size)
    view.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.5)) // let SwiftUI lay out and draw once
    guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw CocoaError(.fileWriteUnknown) }
    view.cacheDisplay(in: view.bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
    try png.write(to: out.appendingPathComponent(file))
}

MainActor.assumeIsolated {
    do {
        try render(.aqua, to: "window-light.png")
        try render(.darkAqua, to: "window-dark.png")
    } catch {
        FileHandle.standardError.write(Data("\(error)\n".utf8))
        exit(1)
    }
}
