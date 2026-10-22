// swift-tools-version: 6.0
// Life.app: the menu-bar app that runs Life's helper (updated by Sparkle), and life-eventkit, Apple Reminders and
// Calendar through EventKit (`scripts/app.ts` assembles the bundle around them).
import PackageDescription

let package = Package(
  name: "LifeApp",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "LifeApp", targets: ["LifeApp"]),
    .executable(name: "life-eventkit", targets: ["LifeEventKit"]),
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
  ]
)
