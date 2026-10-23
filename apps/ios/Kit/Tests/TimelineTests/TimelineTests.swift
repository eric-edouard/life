import Foundation
import Testing

@testable import Timeline

private let base: Int64 = 1_790_000_000_000

/// Capture instant `seconds` after the test epoch.
private func at(_ seconds: Double) -> CaptureInstant {
    CaptureInstant(millis: base + Int64((seconds * 1000).rounded()))
}

private func range(_ start: Double, _ end: Double) -> Range<CaptureInstant> { at(start)..<at(end) }

private func span(_ start: Double, _ end: Double) -> CaptureSpan {
    CaptureSpan(interval: range(start, end), pages: 0...0, breaks: [])
}

private func window(
    _ start: Double, _ end: Double, _ activity: Activity, confidence: Double = 0.95, analyzer: String = "test"
) -> ActivityWindow {
    ActivityWindow(interval: range(start, end), activity: activity, confidence: confidence, analyzer: analyzer)
}

private let silero = "silero-vad 6"
private let energy = "energy-vad 2"
private let classifier = "sound-classifier 2"

// MARK: Capture time

@Test func lateArrivingPagesKeepTheirCaptureTime() {
    // The RTC ran 2 s fast over the 1000 s between two syncs.
    let opening = ClockSync(firstPageIndex: 0, phoneMillis: base, deviceMillisBeforeSet: nil)
    let closing = ClockSync(firstPageIndex: 100, phoneMillis: base + 1_000_000, deviceMillisBeforeSet: base + 1_002_000)
    let early = ClockModel(syncs: [opening, closing])
    let later = ClockModel(syncs: [
        closing, opening,
        ClockSync(firstPageIndex: 200, phoneMillis: base + 9_000_000, deviceMillisBeforeSet: base + 9_000_500),
    ])
    #expect(early.captureInstant(deviceMillis: base + 501_000, pageIndex: 10) == at(500))

    func page(_ index: UInt64) -> AudioPage {
        AudioPage(index: index, session: 1, deviceMillis: base + 501_000 + Int64(index - 10) * 1000, packetCount: 50)
    }
    let partial = CaptureTimeline.spans(pages: [page(10), page(12)], clock: early)
    // Page 11 arrives days later, out of order, after another sync.
    let complete = CaptureTimeline.spans(pages: [page(12), page(11), page(10)], clock: later)

    #expect(partial.map(\.breaks) == [[], [.missingPages]])
    let lost = CaptureTimeline.spans(pages: [page(10), page(12)], clock: early, knownGaps: [11])
    #expect(lost.map(\.breaks) == [[], [.recordedGap]], "a recorded gap is a known loss, not pending audio")
    #expect(complete.count == 1)
    #expect(complete[0].interval.lowerBound == partial[0].interval.lowerBound)
    #expect(complete[0].pages == 10...12)
    for index: UInt64 in 10...12 {
        #expect(
            early.captureInstant(deviceMillis: page(index).deviceMillis, pageIndex: index)
                == later.captureInstant(deviceMillis: page(index).deviceMillis, pageIndex: index))
    }
}

@Test func untrustworthyClockNeverBecomesATime() {
    let clock = ClockModel(syncs: [])
    #expect(clock.captureInstant(deviceMillis: 1_000, pageIndex: 1) == nil)
}

// MARK: Packet placement (structure observed on the owner's Pendant; no real audio)

/// Packet offsets as the Pendant writes them: 20 ms apart, alternately 17 and 23 ms.
private func jittered(_ count: Int, from start: Int64 = 0) -> [Int64] {
    (0..<count).map { start + Int64($0) * 20 - ($0 % 2 == 0 ? 0 : 3) }
}

private func audioPage(
    _ index: UInt64, at millis: Int64, offsets: [Int64], boot: UInt64 = 4, uptime: Int64? = nil
) -> AudioPage {
    AudioPage(
        index: index, session: Int64(index), deviceMillis: millis, boot: boot, uptimeMillis: uptime,
        runs: PacketRun.runs(offsets: offsets))
}

private func placedPackets(_ spans: [CaptureSpan]) -> Int { spans.flatMap(\.runs).map(\.packets.count).reduce(0, +) }

@Test func packetsPlayAtTheirPageTimePlusChunkOffset() {
    // A lone packet written into the previous (not recording) session's page opens the recording; the recording's
    // first page starts its audio 22 ms in, and a new session on every page changes nothing.
    let lone = audioPage(1, at: base, offsets: [4_920])
    let first = audioPage(2, at: base + 4_921, offsets: jittered(70, from: 22))
    let second = audioPage(3, at: base + 6_341, offsets: jittered(75, from: -1))

    let spans = CaptureTimeline.spans(pages: [lone, first, second], clock: ClockModel(syncs: []))

    #expect(first.runs == [PacketRun(offsetMillis: 22, count: 70)], "jitter keeps packets in one run")
    #expect(spans.count == 1)
    #expect(spans[0].interval.lowerBound == CaptureInstant(millis: base + 4_920))
    #expect(spans[0].interval.millis == (1 + 70 + 75) * 20, "back to back, nothing lost or doubled")
    #expect(spans[0].runs.map(\.page) == [1, 2, 3])
}

@Test func stretchesWithoutPacketsAreSilenceInsideTheSpan() {
    // DTX: 1 s of speech, then a packet every 400 ms for 3 s, then speech; then 5 s with no packets at all.
    let dtx = stride(from: Int64(1_400), to: 4_400, by: 400).map(\.self)
    let quiet = audioPage(1, at: base, offsets: jittered(50) + dtx + jittered(50, from: 4_400))
    let later = audioPage(2, at: base + 10_400, offsets: jittered(50))

    let spans = CaptureTimeline.spans(pages: [quiet, later], clock: ClockModel(syncs: []))

    #expect(spans.map(\.breaks) == [[], [.timeGap]])
    #expect(spans[0].interval == CaptureInstant(millis: base)..<CaptureInstant(millis: base + 5_400))
    #expect(spans[0].runs.map(\.start.millis) == ([0] + dtx + [4_400]).map { base + $0 })
    #expect(placedPackets(spans) == quiet.packetCount + later.packetCount)
}

@Test func audioWhoseClockSteppedBackIsPlacedAfterNeverOnTop() {
    // After a reboot the RTC restarts 32 s behind, so the next recording claims time already recorded.
    let trueOffset = base + 20_000 - 10_077
    let staleOffset = trueOffset - 32_267
    let before = audioPage(1, at: base, offsets: jittered(75), boot: 4, uptime: 128_523_259)
    let stale = audioPage(2, at: staleOffset + 10_077, offsets: jittered(64), boot: 5, uptime: 10_077)
    // Our next set stamps its first page with the true clock.
    let synced = audioPage(3, at: trueOffset + 70_000, offsets: jittered(50), boot: 5, uptime: 70_000)
    let pages = [before, stale, synced]

    let unanchored = CaptureTimeline.spans(pages: pages, clock: ClockModel(syncs: []))
    #expect(unanchored[1].breaks == [.overlap])
    #expect(unanchored[1].interval.lowerBound == unanchored[0].interval.upperBound)
    #expect(placedPackets(unanchored) == 75 + 64 + 50)

    let anchor = ClockAnchor(pageIndex: 3, boot: 5, uptimeMillis: 70_000, deviceMillis: trueOffset + 70_000)
    let clock = ClockModel(
        syncs: [ClockSync(firstPageIndex: 3, phoneMillis: trueOffset + 69_300, deviceMillisBeforeSet: nil)],
        anchors: [anchor])
    let anchored = CaptureTimeline.spans(pages: pages, clock: clock)
    #expect(anchored.map(\.breaks) == [[], [.timeGap], [.timeGap]])
    #expect(anchored[1].interval.lowerBound == CaptureInstant(millis: base + 20_000), "timed by uptime")
    #expect(clock.captureInstant(of: before) == CaptureInstant(millis: base), "another boot keeps its own clock")
}

@Test func pageWithUnsetClockIsTimedOnlyByAnAnchorInItsOwnBoot() {
    let trueOffset = base + 30_000
    let earlier = audioPage(1, at: base, offsets: jittered(50), boot: 4, uptime: 99_000)
    let unset = audioPage(2, at: 893, offsets: jittered(50), boot: 5, uptime: 893)
    let synced = audioPage(3, at: trueOffset + 60_000, offsets: jittered(50), boot: 5, uptime: 60_000)
    let pages = [earlier, unset, synced]
    let anchor = { (boot: UInt64) in
        ClockModel(
            syncs: [],
            anchors: [ClockAnchor(pageIndex: 3, boot: boot, uptimeMillis: 60_000, deviceMillis: trueOffset + 60_000)])
    }

    for clock in [ClockModel(syncs: []), anchor(6)] {
        let spans = CaptureTimeline.spans(pages: pages, clock: clock)
        #expect(spans.map(\.breaks) == [[], [.untimedPage, .timeGap]])
        #expect(placedPackets(spans) == 100, "kept out of the timeline, still in the source store")
    }
    let anchored = CaptureTimeline.spans(pages: pages, clock: anchor(5))
    #expect(anchored[1].interval.lowerBound == CaptureInstant(millis: trueOffset + 893))
    #expect(placedPackets(anchored) == 150)
}

@Test func aQuietMultiMinutePageStaysOneConversation() {
    // One page holds 3 minutes: a short burst of speech every 30 s, DTX packets every 400 ms between.
    var offsets: [Int64] = []
    var windows: [ActivityWindow] = []
    for burst in 0...6 {
        let start = Int64(burst) * 30_000
        offsets += jittered(25, from: start)
        windows.append(window(Double(start) / 1000, Double(start + 500) / 1000, .speech))
        guard burst < 6 else { break }
        offsets += stride(from: start + 900, to: start + 30_000, by: 400).map(\.self)
        windows.append(window(Double(start + 500) / 1000, Double(start + 30_000) / 1000, .silence))
    }
    let spans = CaptureTimeline.spans(pages: [audioPage(1, at: base, offsets: offsets)], clock: ClockModel(syncs: []))

    #expect(spans.count == 1)
    #expect(spans[0].interval == range(0, 180.5))
}

@Test func recordsStampedInWholeSecondsPlayBackToBackUntilTheStampJumps() {
    // Omi records: five 20 ms frames each, ten to a stamped second, then the microphone sleeps 5 s.
    let seconds: [Int64] = Array(repeating: 0, count: 10) + Array(repeating: 1, count: 10) + [6, 6]
    let pages = seconds.enumerated().map { index, second in
        AudioPage(
            index: UInt64(index), session: 0, deviceMillis: base + second * 1000,
            runs: [PacketRun(offsetMillis: 0, count: 5)], clockStepMillis: 1000)
    }
    let spans = CaptureTimeline.spans(pages: pages, clock: ClockModel(syncs: []))

    #expect(spans.map(\.interval) == [range(0, 2), range(6, 6.2)])
    #expect(spans.map(\.breaks) == [[], [.timeGap]])
}

// MARK: Silence policy

@Test func speechPolicySendsSpeechWithPaddingAndCutsOnlyLongGaps() {
    let windows = [
        window(0, 10, .silence),
        window(10, 15, .speech),
        window(15, 30, .silence),
        window(30, 32, .sound),  // noise: cut
        window(32, 40, .silence),
        window(40, 41, .speech, confidence: 0.3),
        window(43, 44, .speech),  // 2 s after the last speech: one stretch with it
        window(44, 50, .silence),
        // 50–60 has no label at all: missing analysis is kept.
    ]
    let kept = SpeechPolicy().keptAudio(spans: [span(0, 60)], windows: windows)
    #expect(kept == [range(9, 16), range(39, 45), range(50, 60)])
}

@Test func keptAudioLeavesOutQuietRanges() {
    // The owner talks from 0 to 60 s and dictates to the Mac from 20 to 30 s, then again from 55 s past the end.
    let windows = [window(0, 60, .speech)]
    let quiet = [range(55, 70), range(20, 30)]
    let kept = SpeechPolicy().keptAudio(spans: [span(0, 60)], windows: windows, quietRanges: quiet)
    #expect(kept == [range(0, 20), range(30, 55)])
    // All dictation: nothing to send.
    #expect(SpeechPolicy().keptAudio(spans: [span(0, 60)], windows: windows, quietRanges: [range(0, 60)]).isEmpty)
}

// MARK: Time map

@Test func timeMapRoundTripsExactly() throws {
    let map = try #require(TimeMap(segments: [range(100, 105), range(0, 10), range(40, 50)]))
    #expect(map.preparedMillis == 25_800)
    #expect(map.preparedMillis(at: at(20)) == nil)
    for millis in stride(from: base - 1000, through: base + 106_000, by: 7) {
        let instant = CaptureInstant(millis: millis)
        if let prepared = map.preparedMillis(at: instant) {
            #expect(map.capture(atPreparedMillis: prepared) == instant)
        }
    }
    for prepared in stride(from: Int64(0), through: map.preparedMillis, by: 3) {
        if let instant = map.capture(atPreparedMillis: prepared) {
            #expect(map.preparedMillis(at: instant) == prepared)
        } else {
            #expect((10_000..<10_400).contains(prepared) || (20_400..<20_800).contains(prepared) || prepared == 25_800)
        }
    }
}

/// The cases the server's `captureMillis` reads a job's map by (`fixtures/time-map.json`).
@Test func timeMapLaysOutAudioAsTheServerReadsIt() throws {
    struct Fixture: Decodable {
        struct Point: Decodable { var prepared: Int64; var capture: Int64 }
        struct Gap: Decodable { var prepared: Int64 }
        var segments: [[Int64]]
        var separatorMs: Int64
        var preparedMs: Int64
        var points: [Point]
        var inSeparator: [Gap]
        var past: [Int64]
    }
    let root = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../../../..")
    let fixture = try JSONDecoder().decode(
        Fixture.self, from: Data(contentsOf: root.appending(path: "fixtures/time-map.json")))
    #expect(fixture.separatorMs == TimeMap.separatorMillis)
    let map = try #require(
        TimeMap(segments: fixture.segments.map { CaptureInstant(millis: $0[0])..<CaptureInstant(millis: $0[1]) }))
    #expect(map.preparedMillis == fixture.preparedMs)
    for point in fixture.points {
        #expect(map.capture(atPreparedMillis: point.prepared) == CaptureInstant(millis: point.capture))
        #expect(map.preparedMillis(at: CaptureInstant(millis: point.capture)) == point.prepared)
    }
    for prepared in fixture.inSeparator.map(\.prepared) + fixture.past {
        #expect(map.capture(atPreparedMillis: prepared) == nil)
    }
}

// MARK: Speech rule

/// A train ride: talk, 20 minutes of rumble the energy detector calls speech while Silero hears none, then talk.
private func train(silero rumble: Activity) -> (spans: [CaptureSpan], windows: [ActivityWindow]) {
    (
        spans: [span(0, 1320)],
        windows: [
            window(0, 60, .speech, analyzer: silero), window(60, 1260, rumble, analyzer: silero),
            window(1260, 1320, .speech, analyzer: silero),
            window(0, 1320, .speech, analyzer: energy), window(0, 1320, .sound, analyzer: classifier),
            window(0, 1320, .uncertain, analyzer: "disagreement 1"),
        ]
    )
}

@Test func noiseSileroCallsSilenceIsNotSent() {
    let input = train(silero: .silence)
    #expect(SpeechPolicy().keptAudio(spans: input.spans, windows: input.windows) == [range(0, 61), range(1259, 1320)])
}

@Test func speechSileroHearsIsNeverCut() {
    let input = train(silero: .speech)
    #expect(SpeechPolicy().keptAudio(spans: input.spans, windows: input.windows) == [range(0, 1320)])
}

@Test func theClassifierStillCatchesSpeechSileroMisses() {
    let windows = [window(0, 60, .silence, analyzer: silero), window(20, 30, .speech, analyzer: classifier)]
    #expect(windows.speech() == [range(20, 30)])
}

@Test func withoutSileroUncertainAudioStaysPossibleSpeech() {
    let windows = [window(0, 10, .speech), window(10, 120, .uncertain), window(120, 130, .speech)]
    #expect(windows.speech(orUncertain: true) == [range(0, 130)])
    #expect(windows.speech() == [range(0, 10), range(120, 130)], "uploads never count uncertain")
}

@Test func openCaptureRangeNeverOverflows() {
    let all = CaptureInstant(millis: .min)..<CaptureInstant(millis: .max)
    #expect(all.contains(at(0)))
}
