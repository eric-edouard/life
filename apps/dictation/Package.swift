// swift-tools-version: 6.2
import PackageDescription

// The Mac helper: tells the server when the owner dictates to the Mac, so the phone leaves that audio out. And
// Lifelog Host, the app that runs the server and the helper on a Mac of one's own.
let settings: [SwiftSetting] = [.treatAllWarnings(as: .error)]

let package = Package(
    name: "MacQuiet",
    platforms: [.macOS("15.0")],
    targets: [
        .target(name: "QuietCore", swiftSettings: settings),
        .executableTarget(name: "lifelog-quiet", dependencies: ["QuietCore"], swiftSettings: settings),
        // Lifelog Host: the menu-bar app that runs the server and this helper on a Mac (scripts/host-app.ts).
        .executableTarget(name: "LifelogHost", dependencies: ["QuietCore"], swiftSettings: settings),
        .testTarget(name: "QuietCoreTests", dependencies: ["QuietCore"], swiftSettings: settings),
    ]
)
