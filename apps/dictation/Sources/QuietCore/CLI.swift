import Foundation

/// How the helper runs a provider's CLI: with only the plain environment it needs, and a stop that a child ignoring
/// SIGTERM can't outlive.
public enum CLI {
    public static func environment(adding extra: [String: String]) -> [String: String] {
        ProcessInfo.processInfo.environment
            .filter { ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "LC_ALL"].contains($0.key) }
            .merging(extra) { $1 }
    }

    /// SIGTERM now, SIGKILL after `grace` if it is still running.
    public static func stop(_ process: Process, grace: TimeInterval = 5) {
        guard process.isRunning else { return }
        process.terminate()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + grace) {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }
}
