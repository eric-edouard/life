#if DEBUG
    import Capture
    import Incidents
    import PendantProtocol
    import SourceStore
    import ServerAPI
    import SwiftUI
    import Timeline

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
            return PendantActions(
                capture: capture, sync: .preview(capture: capture),
                permissions: PermissionsStore(notifications: .notAsked, location: .denied))
        }
    }

    private let spending = TranscriptionFacts.Spending(today: 0.84, monthTranscription: 3.12)

    /// Any state of the screen.
    private func pendant(
        _ status: CaptureStatus, connectionSince: Date = now.addingTimeInterval(-3_600),
        incidents: [IncidentItem] = [], transcription: TranscriptionFacts = TranscriptionFacts(spending: spending),
        invite: Bool = false, pairedKind: DeviceKind = .limitless, actions: PendantActions = .preview()
    ) -> some View {
        NavigationStack {
            PendantScreen(
                capture: CaptureFacts(
                    status: status, context: CaptureContext(connectionSince: connectionSince),
                    lastCaughtUp: now.addingTimeInterval(-30), lastSaved: now.addingTimeInterval(-40),
                    phoneFreeBytes: 52_000_000_000, archiveBytes: 1_300_000_000, incidents: incidents,
                    recordingSince: status.recordingSince([
                        RecordingChange(.resumed, at: CaptureInstant(now.addingTimeInterval(-1_920)))
                    ]),
                    // Learned while recording; paused not seen enough yet.
                    batteryLife: BatteryLife(recording: 6), pairedKind: pairedKind),
                transcription: transcription,
                today: SavedToday(recorded: .seconds(11_520), conversations: 9, transcribed: .seconds(10_080)),
                permissions: PermissionsStore(notifications: .notAsked, location: .denied),
                showsNotificationsInvite: invite, actions: actions)
        }
        .previewSync()
        .environment(CaptureStore.preview())
        .preferredColorScheme(.dark)
    }

    #Preview("Settings") {
        NavigationStack {
            SettingsView(
                permissions: PermissionsStore(notifications: .allowed, location: .denied), allowNotifications: {})
        }
        .previewSync()
        .environment(CaptureStore.preview())
        .preferredColorScheme(.dark)
    }

    #Preview("Settings, large text") {
        NavigationStack {
            SettingsView(
                permissions: PermissionsStore(notifications: .notAsked, location: .allowed), allowNotifications: {})
        }
        .previewSync()
        .environment(CaptureStore.preview())
        .dynamicTypeSize(.accessibility2)
        .preferredColorScheme(.dark)
    }

    #Preview("Parts: battery") {
        HStack(spacing: 18) {
            BatteryGlyph(percent: 82)
            BatteryGlyph(percent: 18)
            BatteryGlyph(percent: 46, charging: true)
            BatteryGlyph(percent: 81, isCurrent: false)
            BatteryGlyph(percent: nil, isCurrent: false)
        }
        .padding(16)
        .background(Palette.ground)
        .preferredColorScheme(.dark)
    }

    #Preview("Light guide") {
        NavigationStack { LightGuideView() }
            .preferredColorScheme(.dark)
    }

    #Preview("Recording") { pendant(healthy) }

    #Preview("Recording, hearing sound") {
        pendant(
            with {
                $0.soundActivity = Observed(
                    .hearing(since: now.addingTimeInterval(-40)), at: now.addingTimeInterval(-2))
            })
    }

    #Preview("Recording, report gone stale") {
        let old = now.addingTimeInterval(-600)
        pendant(
            with {
                $0.recording = .recording(confirmedAt: old)
                $0.lastKnownRecording = Observed(.recording, at: old)
                $0.soundActivity = Observed(.hearing(since: old), at: old)
            })
    }

    #Preview("Paused on the Pendant") {
        pendant(
            with {
                $0.recording = .paused(confirmedAt: now.addingTimeInterval(-20))
                $0.lastKnownRecording = Observed(.paused, at: now.addingTimeInterval(-20))
                $0.lastButton = Observed(.long, at: now.addingTimeInterval(-24))
            })
    }

    #Preview("Pause pending") {
        pendant(with { $0.recording = .pauseRequested(pendingSince: now.addingTimeInterval(-2)) })
    }

    #Preview("Pause not confirmed") {
        pendant(with { $0.recording = .failed(.unconfirmed(.pause), at: now) })
    }

    #Preview("Checking, connected without a report") {
        pendant(
            with {
                $0.recording = .unknown
                $0.lastKnownRecording = nil
                $0.lastReply = nil
            }, connectionSince: now.addingTimeInterval(-3))
    }

    #Preview("Disconnected, last known") {
        let lost = now.addingTimeInterval(-900)
        pendant(
            with {
                $0.connection = .disconnected(UUID(), .linkLost(nil))
                $0.recording = .unknown
                $0.lastKnownRecording = Observed(.recording, at: lost)
                $0.batteryPercent = Observed(81, at: lost)
                $0.storage?.at = lost
                $0.backlog = Observed(Backlog(pages: 0, estimatedDuration: .zero), at: lost)
                $0.lastContact = lost
                $0.lastReply = lost
            }, connectionSince: lost)
    }

    #Preview("Catching up") {
        pendant(
            with {
                $0.sync = .downloading(DrainProgress(expected: 3_400, received: 1_500, settled: 1_420))
                $0.backlog = Observed(Backlog(pages: 3_400, estimatedDuration: .seconds(13_200)), at: now)
            })
    }

    #Preview("Low battery") {
        pendant(with { $0.batteryPercent = Observed(18, at: now.addingTimeInterval(-6)) })
    }

    #Preview("Charging") {
        pendant(
            with {
                $0.batteryPercent = Observed(46, at: now.addingTimeInterval(-6))
                $0.charging = Observed(.charging, at: now.addingTimeInterval(-6))
            })
    }

    #Preview("Bluetooth off") {
        pendant(
            with {
                $0.connection = .bluetoothOff
                $0.recording = .unknown
                $0.lastContact = now.addingTimeInterval(-1_800)
            })
    }

    #Preview("Busy elsewhere") {
        pendant(
            with {
                $0.connection = .busyElsewhere(UUID())
                $0.recording = .unknown
            })
    }

    #Preview("Incident present") {
        pendant(
            healthy,
            incidents: [
                IncidentItem(
                    id: 1, kind: .replayConflict, index: 1_204, detail: "device time differs",
                    recordedAt: now.addingTimeInterval(-600))
            ])
    }

    #Preview("Notifications invite") { pendant(healthy, invite: true) }

    #Preview("Omi resting, frees on delivery") {
        pendant(
            with {
                $0.connection = .resting(UUID())
                $0.deviceKind = .omi
                $0.firmwareRevision = "3.0.21"
            }, pairedKind: .omi)
    }

    #Preview("Resume pending") {
        pendant(
            with {
                $0.recording = .resumeRequested(pendingSince: now.addingTimeInterval(-2))
                $0.lastKnownRecording = Observed(.paused, at: now.addingTimeInterval(-20))
            })
    }

    #Preview("Bluetooth off, large text") {
        pendant(
            with {
                $0.connection = .bluetoothOff
                $0.recording = .unknown
            }
        )
        .dynamicTypeSize(.accessibility2)
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
