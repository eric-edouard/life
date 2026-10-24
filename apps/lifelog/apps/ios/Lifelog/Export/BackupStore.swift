import Export
import Foundation
import Library
import Observation

/// Full private backup and restore. Backing up only reads the live stores; restoring writes a separate folder and
/// never touches them. Using a restored library is a switch scheduled for the next launch. The work runs in Kit, off
/// the main actor.
@Observable
final class BackupStore {
    enum State {
        case idle
        case working(String)
        case backedUp(URL)
        case restored(RestoreReport)
        case switchScheduled
        case failed(String)
    }

    private static let libraries = LibrarySwitch(support: .applicationSupportDirectory)
    private static let lastSwitchKey = "lastLibrarySwitch"

    /// Call at launch before any store opens. Switches to a restored library if the owner chose one, and keeps the
    /// outcome for the owner to read here.
    static func applyScheduledSwitch() {
        guard let outcome = libraries.applyScheduled() else { return }
        let message =
            switch outcome {
            case .switched(let previous?):
                "Switched to the restored library. The one it replaced is kept in \(previous.lastPathComponent)."
            case .switched(nil): "Switched to the restored library."
            case .failed(let reason): "Switching to the restored library failed. \(reason)"
            }
        UserDefaults.standard.set(message, forKey: lastSwitchKey)
    }

    /// What the last switch to a restored library did.
    let lastSwitch = UserDefaults.standard.string(forKey: lastSwitchKey)
    private(set) var state = State.idle
    @ObservationIgnored private var task: Task<Void, Never>?

    var isWorking: Bool {
        if case .working = state { true } else { false }
    }

    func backUp(library: LibraryStore?) {
        guard library != nil else {
            state = .failed(LibraryStore.notOpen)
            return
        }
        run("Backing up") {
            let work = URL.temporaryDirectory.appending(path: "backup-\(UUID())", directoryHint: .isDirectory)
            return .backedUp(
                try await Backup.archive(
                    from: Self.libraries.live, in: work, appVersion: Bundle.main.appVersion))
        }
    }

    /// `folder` is an unzipped backup the owner picked in Files.
    func restore(_ folder: URL) {
        run("Checking and restoring") {
            let scoped = folder.startAccessingSecurityScopedResource()
            defer { if scoped { folder.stopAccessingSecurityScopedResource() } }
            return .restored(try await Importer.restore(folder, into: Self.libraries.restores))
        }
    }

    /// The owner confirmed: the restored library replaces the live one at the next launch.
    func use(_ restored: RestoreReport) {
        run("Preparing the restored library") {
            try await Self.libraries.schedule(restored.location)
            return .switchScheduled
        }
    }

    func cancel() {
        task?.cancel()
    }

    func reset() {
        state = .idle
    }

    private func run(_ label: String, _ work: @escaping () async throws -> State) {
        state = .working(label)
        task = Task {
            do {
                state = try await work()
            } catch is CancellationError {
                state = .idle
            } catch {
                state = .failed(report(error))
            }
        }
    }
}
