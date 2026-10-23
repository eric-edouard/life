import Foundation

public enum CodexUsageReader {
    /// A read-only app-server exchange, without starting a thread or generating any tokens. Call off the main queue.
    /// The helper's dedicated CODEX_HOME supplies the login; no auth file is opened or copied by this code. Every wait
    /// for output has the same deadline, so a CLI that leaves a child holding stdout can't block the read for good.
    public static func read(binary: String, home: URL, timeout: TimeInterval = 15) -> SubscriptionReading? {
        let process = Process()
        let input = Pipe()
        let output = Pipe()
        // A signed-out or incompatible CLI can close stdin before a write. Treat EPIPE as a failed read, not a
        // signal that terminates the helper (and its unrelated dictation and model work).
        _ = fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
        process.executableURL = URL(filePath: binary)
        process.currentDirectoryURL = home
        process.arguments = ["--no-daemon", "app-server"]
        process.environment = CLI.environment(adding: ["CODEX_HOME": home.path])
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        defer {
            try? input.fileHandleForWriting.close()
            try? output.fileHandleForReading.close()
            CLI.stop(process, grace: 1)
        }
        let deadline = Date.now.addingTimeInterval(timeout)
        func send(_ message: String) throws {
            try input.fileHandleForWriting.write(contentsOf: Data((message + "\n").utf8))
        }
        do {
            try send(
                #"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"dictation_usage","version":"1.0"}}}"#)
            var pending = Data()
            var received = 0
            var ready = pollfd(fd: output.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0)
            while poll(&ready, 1, Int32(max(0, deadline.timeIntervalSinceNow) * 1000)) > 0 {
                let chunk = output.fileHandleForReading.availableData
                guard !chunk.isEmpty else { break }
                received += chunk.count
                guard received <= 131_072 else { return nil }
                pending.append(chunk)
                while let end = pending.firstIndex(of: 10) {
                    let line = Data(pending[..<end])
                    pending.removeSubrange(...end)
                    guard let reply = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                    switch reply["id"] as? Int {
                    case 1:
                        guard reply["error"] == nil else { return nil }
                        try send(#"{"method":"initialized"}"#)
                        try send(#"{"id":2,"method":"account/rateLimits/read"}"#)
                    case 2: return SubscriptionReading.codex(line)
                    default: break
                    }
                }
            }
        } catch { return nil }
        return nil
    }
}
