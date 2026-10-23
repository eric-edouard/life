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
        .library(name: "Upload", targets: ["Upload"]),
        .library(name: "Health", targets: ["Health"]),
    ],
    targets: [
        .target(name: "PendantProtocol", exclude: ["PROVENANCE.md"], swiftSettings: settings),
        .target(name: "SourceStore", dependencies: ["Timeline"], swiftSettings: settings),
        .target(
            name: "Capture", dependencies: ["PendantProtocol", "SourceStore", "Timeline"], swiftSettings: settings),
        .target(name: "Timeline", swiftSettings: settings),
        .target(name: "Glance", swiftSettings: settings),
        .testTarget(name: "GlanceTests", dependencies: ["Glance"], swiftSettings: settings),
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
            exclude: ["Golden"],
            swiftSettings: settings),
        .target(
            name: "AudioPipeline", dependencies: ["PendantProtocol", "SourceStore", "Timeline"],
            exclude: ["Resources/SILERO.md"], resources: [.copy("Resources/silero-vad-unified-v6.0.0.mlmodelc")],
            swiftSettings: settings),
        .testTarget(
            name: "AudioPipelineTests", dependencies: ["AudioPipeline", "PendantProtocol", "SourceStore", "Timeline"],
            resources: [.copy("Fixtures")], swiftSettings: settings),
        // The server's API, for every store that talks to it: one file per domain, as in `apps/voice/src/routes`.
        .target(name: "ServerAPI", dependencies: ["Glance", "Library", "Timeline"], swiftSettings: settings),
        // The phone's side after capture: the scanned timeline, its facts, blocks and their uploader, edit replay.
        .target(
            name: "Upload",
            dependencies: ["AudioPipeline", "Capture", "Library", "ServerAPI", "SourceStore", "Timeline"],
            swiftSettings: settings),
        .testTarget(
            name: "UploadTests",
            dependencies: [
                "AudioPipeline", "Capture", "Library", "PendantProtocol", "ServerAPI",
                "SourceStore", "Timeline", "Upload",
            ],
            swiftSettings: settings),
        .target(name: "Health", dependencies: ["Capture", "Incidents", "PendantProtocol"], swiftSettings: settings),
        .testTarget(
            name: "HealthTests", dependencies: ["Health", "Capture", "PendantProtocol"], swiftSettings: settings),
    ]
)
