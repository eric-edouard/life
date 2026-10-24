import Foundation
import QuietCore
import Testing

private let now = Date(timeIntervalSince1970: 1_800_000_000)
private func iso(_ minutesAgo: Double) -> String {
    now.addingTimeInterval(-minutesAgo * 60).formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
}

@Test func theMenuReadsTheServersStatus() throws {
    let json = """
        {
          "pipeline": {
            "transcription": { "waiting": { "blocks": 3, "seconds": 750 },
              "atProvider": { "jobs": 2, "oldestSentAt": "\(iso(5))" },
              "fragments": { "seconds": 30 }, "failedLast24h": 0, "lastTranscriptAt": "\(iso(12))" },
            "ai": { "running": [{ "conversationId": "c1", "title": "Lunch", "startedAt": "\(iso(1))" }],
              "waiting": 4, "blockedBy": null, "lastSummaryAt": null }
          },
          "backup": { "packs": 0,
            "restic": { "lastSnapshotAt": "\(iso(49 * 60))", "lastError": null } },
          "mac": { "connected": true, "state": "watching", "heardAt": "\(iso(0))", "llm": { "able": true } },
          "pendant": { "batteryPercent": 81, "charging": false, "connection": "connected",
            "recording": "recording", "knownAt": "\(iso(180))", "recordingKnownAt": "\(iso(180))" },
          "phoneHeartbeat": { "receivedAt": "\(iso(180))", "somethingNew": 1 },
          "transcription": { "quota": { "limit": 1000, "used": 900, "checkedAt": "\(iso(3))" },
            "latency": { "transcriptionSeconds": { "median": 40, "p90": 95 } } },
          "switches": "reshaped",
          "problemsLast24h": { "crash": 1 },
          "archive": { "strayTurns": 0, "overlaps": 0 },
          "aNewSection": {}
        }
        """
    let status = try #require(HostStatus.decode(Data(json.utf8)))
    #expect(status.transcription?.quota != nil && status.switches == nil, "a reshaped section is unknown")
    let sections = Host.report(status, now: now)
    let menu = Dictionary(uniqueKeysWithValues: sections.map { ($0.summary.label, $0.summary) })
    #expect(menu["To transcribe"]?.value == "3 blocks · 12 min")
    #expect(menu["At ElevenLabs"]?.value == "2 jobs, since 5 min ago")
    #expect(menu["AI"]?.value == "summarizing “Lunch” · 4 waiting")
    #expect(menu["Pendant"]?.value == "81% · recording · seen 3 h ago")
    #expect(menu["Phone"]?.value == "heard 3 h ago")
    #expect(menu["Mac helper"]?.trouble == false)
    #expect(menu["ElevenLabs credits"]?.value == "100 left (10%)" && menu["ElevenLabs credits"]?.trouble == true)
    #expect(menu["Backup"]?.value == "last 2 d ago" && menu["Backup"]?.trouble == true, "over 48 h")
    #expect(menu["Problems in the last day"]?.trouble == true && menu["Archive"]?.trouble == false)
    #expect(Host.verdict(sections) == "lifelog: 3 to look at")
}

@Test func aServerThatDoesntAnswerIsOneThingToLookAt() throws {
    #expect(Host.verdict(Host.report(nil, now: now)) == "lifelog: 1 to look at")
    let blank = try #require(HostStatus.decode(Data(#"{"mac": "not an object"}"#.utf8)))
    let sections = Host.report(blank, now: now)
    #expect(sections.first { $0.summary.label == "Backup" }?.summary.value == "off")
    #expect(sections.first { $0.summary.label == "Mac helper" }?.summary.trouble == true)
    #expect(HostStatus.decode(Data("[]".utf8)) == nil)
}

@Test func aBlockedAIIsTroubleOnlyWithWorkWaiting() throws {
    let status = { (waiting: Int) in
        try #require(
            HostStatus.decode(Data(#"{"pipeline": {"ai": {"waiting": \#(waiting), "blockedBy": "macAway"}}}"#.utf8)))
    }
    let ai = { (s: HostStatus) in Host.report(s, now: now).first { $0.summary.label == "AI" }?.summary }
    #expect(try ai(status(2))?.value == "2 waiting · blocked: the Mac is away")
    #expect(try ai(status(2))?.trouble == true)
    #expect(try ai(status(0))?.trouble == false)
}

@Test func aListeningPendantIsRecording() throws {
    let pendant = { (recording: String) in
        try #require(
            HostStatus.decode(Data(#"{"pendant": {"batteryPercent": 80, "recording": "\#(recording)"}}"#.utf8)))
    }
    let trouble = { (s: HostStatus) in
        Host.report(s, now: now).first { $0.summary.label == "Pendant" }?.summary.trouble
    }
    for on in ["recording", "listening", "unknown"] { #expect(try trouble(pendant(on)) == false, "\(on)") }
    for off in ["paused", "not_recording", "failed"] { #expect(try trouble(pendant(off)) == true, "\(off)") }
}

@Test func speakerRecognitionOffOrFailingShowsInTheMenu() throws {
    let line = { (identity: String) in
        let status = try #require(HostStatus.decode(Data(#"{"identity": \#(identity)}"#.utf8)))
        return try #require(Host.report(status, now: now).first { $0.summary.label == "Speaker recognition" })
    }
    let off = try line(#"{"configured": false, "lastOkAt": null, "lastError": null}"#)
    #expect(off.summary.value == "off" && off.inMenu)
    let failing = try line(#"{"configured": true, "lastOkAt": null, "lastError": "connection refused"}"#)
    #expect(failing.summary.value == "failing: connection refused" && failing.summary.trouble)
    #expect(
        try line(#"{"configured": true, "lastOkAt": "\#(iso(5))", "lastError": null}"#).summary.value
            == "on, last used 5 min ago")
}
