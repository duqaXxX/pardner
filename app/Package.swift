// swift-tools-version: 6.0
// The lowest tools version with `.macOS(.v15)`: CI's Xcode is older than the one on the development Mac (the
// latest runner's default; 26.3 on the macOS 15 runner, whose default 16.4 does not compile the package). The
// floor is macOS 15 for `String(validating:as:)` in utf8Decode.
import PackageDescription

let package = Package(
    name: "Pardner",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "Platform", targets: ["Platform"]),
        .library(name: "ProtocolHost", targets: ["ProtocolHost"]),
        .library(name: "Relay", targets: ["Relay"]),
        .library(name: "DesignSystem", targets: ["DesignSystem"]),
        .library(name: "Conversation", targets: ["Conversation"]),
        .library(name: "Screens", targets: ["Screens"]),
    ],
    targets: [
        .target(name: "Platform"),
        .target(name: "ProtocolHost", dependencies: ["Platform"]),
        // The app's connection to the relay: Network.framework under the shared `Link` that ProtocolHost runs.
        .target(name: "Relay", dependencies: ["Platform", "ProtocolHost"]),
        // The reading model: the link's deliveries folded into channels, threads and sessions (app data design, 6).
        .target(name: "Conversation", dependencies: ["ProtocolHost"]),
        // The windows, in SwiftUI, over the reading model and the design system's tokens (step-6 plan, section 3).
        .target(name: "Screens", dependencies: ["Conversation", "DesignSystem", "ProtocolHost", "Platform", "Relay"]),
        // Renders the main window and the pairing screens in Light and Dark to PNG files, for the screens' decisions document.
        .executableTarget(name: "screens-snapshot", dependencies: ["Screens", "DesignSystem", "Platform", "ProtocolHost", "Relay", "Conversation"], path: "Tools/screens-snapshot"),
        // The colour tokens (one JSON resource, read at first use) and the three bundled font families.
        .target(name: "DesignSystem", resources: [.copy("tokens.json"), .copy("Fonts")]),
        // Test-only: `seal` for Node to open (the other direction of the cross-engine check).
        .executableTarget(name: "vector-tool", dependencies: ["Platform"], path: "Tools/vector-tool"),
        // Test-only code (the software key store, importKey, withSecret) lives here and ships in no module.
        .testTarget(name: "VectorTests", dependencies: ["Platform", "ProtocolHost", "Relay"], path: "Tests", exclude: ["DesignSystemTests", "ConversationTests", "ScreensTests"]),
        .testTarget(name: "DesignSystemTests", dependencies: ["DesignSystem"]),
        .testTarget(name: "ConversationTests", dependencies: ["Conversation", "ProtocolHost"]),
        .testTarget(name: "ScreensTests", dependencies: ["Screens", "Conversation", "DesignSystem", "Platform", "Relay", "ProtocolHost"]),
    ]
)
