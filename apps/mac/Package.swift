// swift-tools-version: 6.0
// Life.app: the menu-bar app that runs Life's helper (updated by Sparkle); life-eventkit, the permissions helper an
// access card checks and asks through, and the Past calendar on an Apple calendar through EventKit; and
// life-foundation-model, Apple's on-device model for the arrival reader (`scripts/app.ts` assembles the bundle).
import PackageDescription

let package = Package(
  name: "LifeApp",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "LifeApp", targets: ["LifeApp"]),
    .executable(name: "life-eventkit", targets: ["LifeEventKit"]),
    .executable(name: "life-foundation-model", targets: ["LifeFoundationModel"]),
  ],
  targets: [
    // Sparkle's release build, fetched and checked by `scripts/app.ts` (SwiftPM's own download stalls here).
    .binaryTarget(name: "Sparkle", path: "Frameworks/Sparkle.xcframework"),
    .executableTarget(
      name: "LifeApp", dependencies: ["Sparkle"], path: "Sources/LifeApp",
      linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]),
    // A one-shot command: its top-level state is single-threaded.
    .executableTarget(
      name: "LifeEventKit", path: "Sources/LifeEventKit",
      swiftSettings: [.swiftLanguageMode(.v5)]),
    // One request per stdin line, answered in order.
    .executableTarget(
      name: "LifeFoundationModel", path: "Sources/LifeFoundationModel",
      swiftSettings: [.swiftLanguageMode(.v5)]),
  ]
)
