#if DEBUG
    import Capture
    import Foundation

    /// Simulated Pendant setups for the simulator. Pick one with the launch argument `-fakePendant <name>`
    /// (read through UserDefaults' argument domain) or from the diagnostic screen.
    enum FakeScenario: String, CaseIterable, Identifiable {
        case healthyRecording
        case offlineBacklog
        case paused
        case busyElsewhere
        case bluetoothOff
        case corruptPage
        case disconnectMidDrain
        /// First launch: no Pendant paired yet, so Life scans; one turns up a few seconds later.
        case neverSetUp
        /// An Omi on firmware 3.0.21, which frees records on delivery: drained, then let go until the next sync.
        case omi

        static let launchKey = "fakePendant"

        var id: Self { self }

        /// The scenario chosen at launch, if any. Debug builds only; Release has no fake at all.
        static var selected: FakeScenario? {
            UserDefaults.standard.string(forKey: launchKey).flatMap(FakeScenario.init)
        }

        /// Every scenario but `neverSetUp` is a Pendant paired before, like a relaunch.
        var isSetUp: Bool { self != .neverSetUp }

        /// The simulated device and its Bluetooth identifier.
        func makeTransport() async -> (any PendantTransport, UUID) {
            if self == .omi {
                let omi = FakeOmiTransport()
                await omi.record(600)
                return (omi, omi.id)
            }
            // Real firmware applies a pause or resume a moment after the command, so the pending state shows.
            let fake = FakePendantTransport(recordingChangeDelay: .seconds(1.5))
            switch self {
            case .healthyRecording:
                await fake.record(pages: 20)
                await fake.setBattery(percent: 76, charging: true)
                // The firmware's sound detector: stored audio in bursts, nothing between.
                await fake.simulateVoiceActivity()
            case .offlineBacklog:
                // Out of range while it records; comes back after launch and catches up with real progress.
                await fake.setInRange(false)
                await fake.record(pages: 3000)
                Task {
                    try? await Task.sleep(for: .seconds(3))
                    await fake.setInRange(true)
                }
            case .paused:
                await fake.record(pages: 10)
                await fake.longPress()
            case .busyElsewhere:
                await fake.record(pages: 10)
                await fake.setBusyWithOtherClient(true)
            case .bluetoothOff:
                await fake.setBluetooth(.poweredOff)
            case .corruptPage:
                await fake.record(pages: 40)
                // A run of unreadable pages, which share one card.
                for index: UInt64 in 110...114 { await fake.corrupt(index: index, as: .corrupt) }
            case .disconnectMidDrain:
                await fake.record(pages: 400)
                await fake.dropLink(afterSendingPages: 150)
            case .neverSetUp:
                await fake.setInRange(false)
                await fake.record(pages: 20)
                Task {
                    try? await Task.sleep(for: .seconds(3))
                    await fake.setInRange(true)
                }
            case .omi:
                break
            }
            return (fake, fake.id)
        }
    }
#endif
