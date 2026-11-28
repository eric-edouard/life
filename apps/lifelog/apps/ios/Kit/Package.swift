// swift-tools-version: 6.2
import PackageDescription

// Platform-independent logic lives here so it builds and tests fast on macOS.
let settings: [SwiftSetting] = [.treatAllWarnings(as: .error)]

let package = Package(
    name: "LifelogKit",
    platforms: [.iOS("27.0"), .macOS("27.0"), .watchOS("27.0")],
    products: [
        .library(name: "PendantProtocol", targets: ["PendantProtocol"]),
        .library(name: "SourceStore", targets: ["SourceStore"]),
        .library(name: "Capture", targets: ["Capture"]),
        .library(name: "Timeline", targets: ["Timeline"]),
        .library(name: "Incidents", targets: ["Incidents"]),
        .library(name: "OwnerSettings", targets: ["OwnerSettings"]),
        // The one module the Watch needs: no Bluetooth, storage or audio.
        .library(name: "Glance", targets: ["Glance"]),
        .library(name: "Library", targets: ["Library"]),
        .library(name: "Export", targets: ["Export"]),
        .library(name: "AudioPipeline", targets: ["AudioPipeline"]),
        .library(name: "ServerAPI", targets: ["ServerAPI"]),
        // The Mac link (iroh), dynamic: the app and its extensions share one copy of IrohLib. Never on the Watch.
        .library(name: "MacLinkFramework", type: .dynamic, targets: ["MacLink"]),
        .library(name: "Upload", targets: ["Upload"]),
        .library(name: "Health", targets: ["Health"]),
        // Life's connector: the phone's one client of Life (OAuth, MCP, the reads' models and states).
        .library(name: "LifeConnector", targets: ["LifeConnector"]),
        // A card's context as blocks to draw: the one reader of Markdown, apart so the Watch and extensions skip it.
        .library(name: "ContextMarkdown", targets: ["ContextMarkdown"]),
    ],
    // Apple's own Markdown parser (the context sheet's spec, decision 81) and iroh (the Mac link): the only packages from
    // outside the repo.
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-markdown.git", exact: "0.9.0"),
        .package(url: "https://github.com/n0-computer/iroh-ffi.git", exact: "1.2.0"),
    ],
    targets: [
        .target(name: "PendantProtocol", exclude: ["PROVENANCE.md"], swiftSettings: settings),
        .target(name: "SourceStore", dependencies: ["Timeline"], swiftSettings: settings),
        .target(
            name: "Capture", dependencies: ["PendantProtocol", "SourceStore", "Timeline"], swiftSettings: settings),
        .target(name: "Timeline", swiftSettings: settings),
        .target(name: "Glance", swiftSettings: settings),
        .target(name: "Incidents", dependencies: ["Capture", "Glance"], swiftSettings: settings),
        .target(name: "OwnerSettings", dependencies: ["Incidents"], swiftSettings: settings),
        .testTarget(
            name: "OwnerSettingsTests", dependencies: ["OwnerSettings", "Incidents"], swiftSettings: settings),
        .testTarget(name: "SourceStoreTests", dependencies: ["SourceStore"], swiftSettings: settings),
        .testTarget(
            name: "PendantProtocolTests", dependencies: ["PendantProtocol"], resources: [.copy("Fixtures")],
            swiftSettings: settings),
        .testTarget(
            name: "CaptureTests", dependencies: ["Capture", "PendantProtocol", "SourceStore", "Timeline", "Upload"],
            swiftSettings: settings),
        .testTarget(name: "TimelineTests", dependencies: ["Timeline"], swiftSettings: settings),
        .testTarget(
            name: "IncidentsTests", dependencies: ["Incidents", "Capture", "Glance", "PendantProtocol"],
            swiftSettings: settings),
        .target(name: "Library", dependencies: ["SourceStore", "Timeline"], swiftSettings: settings),
        .target(
            name: "Export", dependencies: ["AudioPipeline", "Library", "SourceStore", "Timeline"],
            swiftSettings: settings),
        .testTarget(
            name: "LibraryTests", dependencies: ["Library", "SourceStore", "Timeline"], swiftSettings: settings),
        .testTarget(
            name: "ExportTests", dependencies: ["Export", "AudioPipeline", "Library", "SourceStore", "Timeline"],
            swiftSettings: settings),
        .target(
            name: "AudioPipeline", dependencies: ["PendantProtocol", "SourceStore", "Timeline"],
            exclude: ["Resources/SILERO.md"], resources: [.copy("Resources/silero-vad-unified-v6.0.0.mlmodelc")],
            swiftSettings: settings),
        .testTarget(
            name: "AudioPipelineTests", dependencies: ["AudioPipeline", "PendantProtocol", "SourceStore", "Timeline"],
            resources: [.copy("Fixtures")], swiftSettings: settings),
        // The server's API, for every store that talks to it: one file per domain, as in `apps/server/src/routes`.
        .target(
            name: "ServerAPI", dependencies: ["Glance", "Library", "MacLink", "Timeline"], swiftSettings: settings),
        // How the phone reaches the Mac from anywhere: the pairing link, and requests over iroh to a Mac with a key.
        .target(
            name: "MacLink", dependencies: [.product(name: "IrohLib", package: "iroh-ffi")], swiftSettings: settings),
        .testTarget(name: "MacLinkTests", dependencies: ["MacLink"], swiftSettings: settings),
        // The phone's side after capture: the scanned timeline, its facts, blocks and their uploader, edit replay.
        .target(
            name: "Upload",
            dependencies: ["AudioPipeline", "Capture", "Library", "ServerAPI", "SourceStore", "Timeline"],
            swiftSettings: settings),
        .testTarget(
            name: "UploadTests",
            dependencies: [
                "AudioPipeline", "Capture", "Library", "LifeConnector", "MacLink", "PendantProtocol", "ServerAPI",
                "SourceStore", "Timeline", "Upload",
            ],
            swiftSettings: settings),
        .target(name: "Health", dependencies: ["Capture", "Incidents", "PendantProtocol"], swiftSettings: settings),
        .testTarget(
            name: "HealthTests", dependencies: ["Health", "Capture", "PendantProtocol"], swiftSettings: settings),
        // Library for `UnknownTolerant`; MacLink for the pairing link and the one session maker.
        .target(name: "LifeConnector", dependencies: ["Library", "MacLink"], swiftSettings: settings),
        .testTarget(
            name: "LifeConnectorTests", dependencies: ["LifeConnector", "Library", "MacLink"], swiftSettings: settings),
        .target(
            name: "ContextMarkdown", dependencies: [.product(name: "Markdown", package: "swift-markdown")],
            swiftSettings: settings),
        .testTarget(name: "ContextMarkdownTests", dependencies: ["ContextMarkdown"], swiftSettings: settings),
    ]
)
