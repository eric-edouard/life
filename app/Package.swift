// swift-tools-version: 6.0
// Life.app: the menu-bar app that runs Life's helper (`scripts/app.ts` assembles the bundle around this binary).
import PackageDescription

let package = Package(
  name: "LifeApp",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(name: "LifeApp", path: "Sources/LifeApp")
  ]
)
