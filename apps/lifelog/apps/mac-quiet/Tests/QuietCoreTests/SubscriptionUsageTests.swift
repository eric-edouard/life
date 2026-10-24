import Foundation
import QuietCore
import Testing

private let observed = Date(timeIntervalSince1970: 1_800_000_000)

@Test func claudeUsageUsesAccountLimitsAndDropsEverythingElse() throws {
    let input = Data(
        #"{"session_id":"never-send","context_window":{"used_percentage":99},"rate_limits":{"five_hour":{"used_percentage":0,"resets_at":1800010000},"seven_day":{"used_percentage":100,"resets_at":1800600000}}}"#
            .utf8)
    let reading = try #require(SubscriptionReading.claude(input, now: observed))
    #expect(reading.fiveHour?.usedPercent == 0)
    #expect(reading.sevenDay?.usedPercent == 100)
    #expect(reading.observedAt == observed.timeIntervalSince1970)
    let message = try #require(reading.message(engine: "claude"))
    #expect(!message.contains("never-send") && !message.contains("context_window"))
    #expect(message.contains("subscription.usage"))
    for invalid in [
        "{}", #"{"rate_limits":{}}"#, #"{"rate_limits":{"five_hour":{"used_percentage":101,"resets_at":1800010000}}}"#,
    ] {
        #expect(SubscriptionReading.claude(Data(invalid.utf8), now: observed) == nil)
    }
    let one = SubscriptionReading.claude(
        Data(#"{"rate_limits":{"seven_day":{"used_percentage":12.5,"resets_at":1800600000}}}"#.utf8))
    #expect(one?.fiveHour == nil && one?.sevenDay?.usedPercent == 12.5, "one window known, the other unknown")
}

@Test func codexSelectsItsOwnQuotaAndRecognizesWindowDurations() throws {
    let input = Data(
        #"{"result":{"rateLimits":{"limitId":"other","primary":{"usedPercent":99,"windowDurationMins":300,"resetsAt":1800010000}},"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":42,"windowDurationMins":10080,"resetsAt":1800600000},"secondary":{"usedPercent":0,"windowDurationMins":300,"resetsAt":1800010000}}}}}"#
            .utf8)
    let reading = try #require(SubscriptionReading.codex(input, now: observed))
    #expect(reading.fiveHour?.usedPercent == 0)
    #expect(reading.sevenDay?.usedPercent == 42)
    #expect(SubscriptionReading.codex(Data(#"{"error":{"message":"signed out"}}"#.utf8)) == nil)
    #expect(SubscriptionReading.codex(Data(#"{"result":{"rateLimits":{"limitId":"other"}}}"#.utf8)) == nil)
    #expect(
        SubscriptionReading.codex(
            Data(
                #"{"result":{"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":60,"resetsAt":1800010000}}}}"#
                    .utf8)) == nil)
}

@Test func codexUsageHandshakeReadsWithoutStartingAModel() throws {
    let folder = FileManager.default.temporaryDirectory.appending(path: "usage-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let binary = folder.appending(path: "codex")
    let script = #"""
        #!/bin/sh
        read -r initialize
        case "$initialize" in *'"method":"initialize"'*) ;; *) exit 1;; esac
        printf '%s\n' '{"id":1,"result":{}}'
        read -r initialized
        read -r request
        case "$request" in *'"method":"account/rateLimits/read"'*) ;; *) exit 2;; esac
        printf '%s\n' '{"id":2,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":35,"windowDurationMins":300,"resetsAt":1800010000}}}}'
        """#
    try Data(script.utf8).write(to: binary)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: binary.path)
    #expect(CodexUsageReader.read(binary: binary.path, home: folder)?.fiveHour?.usedPercent == 35)
}

@Test func codexUsageFailureAndTimeoutLeaveTheHelperAlive() throws {
    let folder = FileManager.default.temporaryDirectory.appending(path: "usage-failure-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let binary = folder.appending(path: "codex")
    // Fails, never answers, and leaves a child holding stdout after it exits.
    for script in ["#!/bin/sh\nexit 1\n", "#!/bin/sh\nwhile read -r line; do :; done\n", "#!/bin/sh\nsleep 5 &\n"] {
        try Data(script.utf8).write(to: binary)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: binary.path)
        let start = Date.now
        #expect(CodexUsageReader.read(binary: binary.path, home: folder, timeout: 0.1) == nil)
        #expect(Date.now.timeIntervalSince(start) < 3)
    }
}
