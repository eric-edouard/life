// swift-tools-version: 6.0
// Life.app: the menu-bar app that runs Life's helper, and life-eventkit, Apple Reminders and Calendar through EventKit
// (`scripts/app.ts` assembles the bundle around them).
import PackageDescription

let package = Package(
  name: "LifeApp",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "LifeApp", targets: ["LifeApp"]),
    .executable(name: "life-eventkit", targets: ["LifeEventKit"]),
  ],
  targets: [
    .executableTarget(name: "LifeApp", path: "Sources/LifeApp"),
    // A one-shot command: its top-level state is single-threaded.
    .executableTarget(
      name: "LifeEventKit", path: "Sources/LifeEventKit",
      swiftSettings: [.swiftLanguageMode(.v5)]),
  ]
)
