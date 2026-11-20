// swift-tools-version: 6.0
// The lowest tools version with `.macOS(.v15)`: CI keeps the runner image's default Xcode, older than
// the one on the development Mac. The floor is macOS 15 for `String(validating:as:)` in utf8Decode.
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
    ],
    targets: [
        .target(name: "Platform"),
        .target(name: "ProtocolHost", dependencies: ["Platform"]),
        // The app's connection to the relay: Network.framework under the shared `Link` that ProtocolHost runs.
        .target(name: "Relay", dependencies: ["Platform", "ProtocolHost"]),
        // The reading model: the link's deliveries folded into channels, threads and sessions (app data design, 6).
        .target(name: "Conversation", dependencies: ["ProtocolHost"]),
        // The colour tokens (one JSON resource, read at first use) and the three bundled font families.
        .target(name: "DesignSystem", resources: [.copy("tokens.json"), .copy("Fonts")]),
        // Test-only: `seal` for Node to open (the other direction of the cross-engine check).
        .executableTarget(name: "vector-tool", dependencies: ["Platform"], path: "Tools/vector-tool"),
        // Test-only code (the software key store, importKey, withSecret) lives here and ships in no module.
        .testTarget(name: "VectorTests", dependencies: ["Platform", "ProtocolHost", "Relay"], path: "Tests", exclude: ["DesignSystemTests", "ConversationTests"]),
        .testTarget(name: "DesignSystemTests", dependencies: ["DesignSystem"]),
        .testTarget(name: "ConversationTests", dependencies: ["Conversation", "ProtocolHost"]),
    ]
)
