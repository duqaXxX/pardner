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
        .library(name: "DesignSystem", targets: ["DesignSystem"]),
    ],
    targets: [
        .target(name: "Platform"),
        .target(name: "ProtocolHost", dependencies: ["Platform"]),
        // The colour tokens (one JSON resource, read at first use) and the three bundled font families.
        .target(name: "DesignSystem", resources: [.copy("tokens.json"), .copy("Fonts")]),
        // Test-only: `seal` for Node to open (the other direction of the cross-engine check).
        .executableTarget(name: "vector-tool", dependencies: ["Platform"], path: "Tools/vector-tool"),
        // Test-only code (the software key store, importKey, withSecret) lives here and ships in no module.
        .testTarget(name: "VectorTests", dependencies: ["Platform", "ProtocolHost"], path: "Tests", exclude: ["DesignSystemTests"]),
        .testTarget(name: "DesignSystemTests", dependencies: ["DesignSystem"]),
    ]
)
