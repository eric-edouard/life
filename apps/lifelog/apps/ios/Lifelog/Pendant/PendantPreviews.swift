#if DEBUG
    import Capture
    import Incidents
    import PendantProtocol
    import SourceStore
    import ServerAPI
    import SwiftUI
    import Timeline
    import Upload

    private let now = Date.now

    /// A connected Pendant, recording, confirmed 6 s ago, everything saved.
    private let healthy: CaptureStatus = {
        var status = CaptureStatus()
        status.connection = .ready(UUID())
        status.recording = .recording(confirmedAt: now.addingTimeInterval(-6))
        status.lastKnownRecording = Observed(.recording, at: now.addingTimeInterval(-6))
        status.sync = .caughtUp(at: now.addingTimeInterval(-30))
        status.backlog = Observed(Backlog(pages: 0, estimatedDuration: .zero), at: now.addingTimeInterval(-6))
        status.batteryPercent = Observed(82, at: now.addingTimeInterval(-6))
        status.storage = Observed(
            StorageState(oldestPage: 0, newestPage: 2_580, session: 1, freePages: 30_000, totalPages: 40_000),
            at: now.addingTimeInterval(-6))
        status.lastContact = now.addingTimeInterval(-6)
        status.lastReply = now.addingTimeInterval(-6)
        return status
    }()

    private func with(_ edit: (inout CaptureStatus) -> Void) -> CaptureStatus {
        var status = healthy
        edit(&status)
        return status
    }

    extension PendantActions {
        /// Against preview stores: nothing live, nothing saved.
        static func preview() -> PendantActions {
            let capture = CaptureStore.preview()
            return PendantActions(capture: capture, sync: .preview(capture: capture))
        }
    }

    /// Any state of the screen.
    private func pendant(
        _ status: CaptureStatus, connectionSince: Date = now.addingTimeInterval(-3_600),
        incidents: [IncidentItem] = [], uploads: UploadStatus? = UploadStatus(sentThrough: now, heardThrough: now),
        known: Bool = true, pairedKind: DeviceKind = .limitless, actions: PendantActions = .preview()
    ) -> some View {
        Color.clear.sheet(isPresented: .constant(true)) {
            PendantScreen(
                capture: CaptureFacts(
                    status: status, context: CaptureContext(hasKnownPendant: known, connectionSince: connectionSince),
                    lastCaughtUp: now.addingTimeInterval(-30), lastSaved: now.addingTimeInterval(-40),
                    phoneFreeBytes: 52_000_000_000, archiveBytes: 1_300_000_000, incidents: incidents,
                    recordingSince: status.recordingSince([
                        RecordingChange(.resumed, at: CaptureInstant(now.addingTimeInterval(-1_920)))
                    ]),
                    // Learned while recording; paused not seen enough yet.
                    batteryLife: BatteryLife(recording: 6), pairedKind: pairedKind, uploads: uploads),
                actions: actions)
        }
        .previewSync()
        .environment(CaptureStore.preview())
        .preferredColorScheme(.dark)
    }

    #Preview("Settings") {
        NavigationStack {
            SettingsView(
                permissions: PermissionsStore(notifications: .allowed, location: .denied), allowNotifications: {},
                close: {})
        }
        .previewSync()
        .environment(CaptureStore.preview())
        .preferredColorScheme(.dark)
    }

    #Preview("Settings, large text") {
        NavigationStack {
            SettingsView(
                permissions: PermissionsStore(notifications: .notAsked, location: .allowed), allowNotifications: {},
                close: {})
        }
        .previewSync()
        .environment(CaptureStore.preview())
        .dynamicTypeSize(.accessibility2)
        .preferredColorScheme(.dark)
    }

    #Preview("Parts: battery") {
        HStack(spacing: 18) {
            BatteryGlyph(percent: 82)
            BatteryGlyph(percent: 18, tone: Palette.flag)
            BatteryGlyph(percent: 46, tone: Palette.ok, charging: true)
            BatteryGlyph(percent: 81, isCurrent: false)
            BatteryGlyph(percent: nil, isCurrent: false)
        }
        .padding(16)
        .background(Palette.bg)
        .preferredColorScheme(.dark)
    }

    #Preview("Light guide") {
        NavigationStack { LightGuideView(isConnected: true, set: { _ in true }) }
            .preferredColorScheme(.dark)
    }

    #Preview("Recording") { pendant(healthy) }

    #Preview("Not recording, paused on the pendant") {
        pendant(
            with {
                $0.recording = .paused(confirmedAt: now.addingTimeInterval(-20))
                $0.lastKnownRecording = Observed(.paused, at: now.addingTimeInterval(-20))
                $0.lastButton = Observed(.long, at: now.addingTimeInterval(-24))
            })
    }

    #Preview("Out of range") {
        let lost = now.addingTimeInterval(-900)
        pendant(
            with {
                $0.connection = .disconnected(UUID(), .linkLost(nil))
                $0.recording = .unknown
                $0.lastKnownRecording = Observed(.recording, at: lost)
                $0.batteryPercent = Observed(82, at: lost)
                $0.storage = nil
                $0.backlog = nil
                $0.lastContact = lost
                $0.lastReply = lost
            }, connectionSince: lost)
    }

    #Preview("Full") {
        pendant(
            with {
                $0.batteryPercent = Observed(71, at: now.addingTimeInterval(-6))
                $0.storage = Observed(
                    StorageState(oldestPage: 0, newestPage: 2_580, session: 1, freePages: 0, totalPages: 40_000),
                    at: now.addingTimeInterval(-6))
                $0.sync = .downloading(DrainProgress(expected: 3_400, received: 700, settled: 612))
                $0.backlog = Observed(Backlog(pages: 3_400, estimatedDuration: .seconds(11_400)), at: now)
            })
    }

    #Preview("Battery low") {
        pendant(with { $0.batteryPercent = Observed(12, at: now.addingTimeInterval(-6)) })
    }

    #Preview("Sending audio") {
        pendant(
            with {
                $0.sync = .downloading(DrainProgress(expected: 3_400, received: 2_300, settled: 2_176))
                $0.backlog = Observed(Backlog(pages: 3_400, estimatedDuration: .seconds(2_520)), at: now)
            },
            uploads: UploadStatus(unsent: .seconds(240), sentThrough: now.addingTimeInterval(-600), heardThrough: now))
    }

    #Preview("No pendant") {
        pendant(
            {
                var status = CaptureStatus(); status.connection = .scanning; return status
            }(),
            uploads: nil, known: false)
    }

    #Preview("Bluetooth off") {
        pendant(
            with {
                $0.connection = .bluetoothOff
                $0.recording = .unknown
                $0.lastContact = now.addingTimeInterval(-1_800)
            })
    }

    #Preview("Incident and Omi custody") {
        pendant(
            with {
                $0.connection = .resting(UUID())
                $0.deviceKind = .omi
                $0.firmwareRevision = "3.0.21"
            },
            incidents: [
                IncidentItem(
                    id: 1, kind: .replayConflict, index: 1_204, detail: "device time differs",
                    recordedAt: now.addingTimeInterval(-600))
            ], pairedKind: .omi)
    }

    #Preview("Replace") {
        Color.clear.sheet(isPresented: .constant(true)) { ReplaceSheet {}.sheetStack() }
            .environment(CaptureStore.preview())
            .previewSync()
            .preferredColorScheme(.dark)
    }

    #Preview("Pair") {
        Color.clear.sheet(isPresented: .constant(true)) { PairPendantSheet().sheetStack() }
            .environment(CaptureStore.preview())
            .preferredColorScheme(.dark)
    }

    #Preview("Interactive, simulated Pendant") {
        // The fake Pendant answers Pause and Resume as the real one does: pending first, then confirmed.
        let capture = CaptureStore.preview(.healthyRecording)
        PendantView()
            .environment(capture)
            .previewSync(capture: capture)
            .preferredColorScheme(.dark)
    }
#endif
