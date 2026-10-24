import Foundation
import PendantProtocol
import Testing

@testable import Capture

private let now = Date(timeIntervalSince1970: 1_790_000_000)

/// A flash page as the fake Pendant encodes it: 20 ms packets from `openedAt`, with optional session markers.
private func page(openedAt: Date, packets: Int = 75, starts: Bool = false, stops: Bool = false) throws -> FlashPage {
    let fake = FakePendantTransport.Page(
        index: 0, session: 1, timestampMillis: UInt64(openedAt.timeIntervalSince1970 * 1000),
        opusPackets: Array(repeating: Data([0xb8, 1, 2]), count: packets), startsSession: starts, stopsSession: stops)
    let buffer = try StorageBuffer(decoding: FakePendantTransport.storageBuffer(fake))
    return try FlashPage(decoding: try #require(buffer.flashPage))
}

private func storage(newest: Int64, session: UInt64 = 1) -> StorageState {
    StorageState(oldestPage: 0, newestPage: newest, session: session, freePages: 1000, totalPages: 2000)
}

@Suite struct SoundEvidenceDerivation {
    @Test func startMarkerMeansHearingSinceTheMarker() throws {
        var evidence = SoundEvidence()
        evidence.observe(try page(openedAt: now - 1.5, starts: true), index: 10, now: now)
        #expect(evidence.activity?.value == .hearing(since: now - 1.5))
        #expect(try #require(evidence.activity?.at).timeIntervalSince(now) > -0.1, "observed at the newest packet")
    }

    @Test func hearingKeepsItsStartAcrossPages() throws {
        var evidence = SoundEvidence()
        evidence.observe(try page(openedAt: now - 3, starts: true), index: 10, now: now - 1.5)
        evidence.observe(try page(openedAt: now - 1.5), index: 11, now: now)
        #expect(evidence.activity?.value == .hearing(since: now - 3))
    }

    @Test func stopMarkerThenNoNewPagesIsQuiet() throws {
        var evidence = SoundEvidence()
        evidence.observe(try page(openedAt: now - 3, stops: true), index: 10, now: now)
        #expect(evidence.activity?.value == .quiet(since: now - 1.5))
        // The page being written is 11; it doesn't move in the next replies.
        evidence.observe(storage(newest: 11), now: now)
        evidence.observe(storage(newest: 11), now: now + 5)
        evidence.observe(storage(newest: 11), now: now + 10)
        #expect(evidence.activity == Observed(.quiet(since: now - 1.5), at: now + 10), "reconfirmed, same start")
    }

    @Test func noNewPageBetweenRepliesEndsHearing() throws {
        var evidence = SoundEvidence()
        evidence.observe(try page(openedAt: now - 1.5, starts: true), index: 10, now: now)
        let heard = try #require(evidence.activity?.at)
        evidence.observe(storage(newest: 11), now: now)
        evidence.observe(storage(newest: 11), now: now + 5)
        #expect(evidence.activity == Observed(.quiet(since: heard), at: now + 5), "quiet since the last packet")
    }

    @Test func replayedOldPagesNeverCount() throws {
        var evidence = SoundEvidence()
        // Observe mode re-sends everything: an hour-old recording, start to stop.
        evidence.observe(try page(openedAt: now - 3600, starts: true), index: 1, now: now)
        evidence.observe(try page(openedAt: now - 3598, stops: true), index: 2, now: now)
        #expect(evidence.activity == nil)
        // Nor once live evidence exists.
        evidence.observe(try page(openedAt: now - 3, stops: true), index: 30, now: now)
        evidence.observe(try page(openedAt: now - 3500, starts: true), index: 3, now: now)
        #expect(evidence.activity?.value == .quiet(since: now - 1.5))
    }

    @Test func pagesFillingFastBetweenRepliesMeanHearing() {
        var evidence = SoundEvidence()
        evidence.observe(storage(newest: 10), now: now)
        evidence.observe(storage(newest: 13), now: now + 5)
        #expect(evidence.activity == Observed(.hearing(since: now), at: now + 5))
    }

    @Test func onePageInTheSameSessionKeepsTheLastWord() {
        var evidence = SoundEvidence()
        evidence.observe(storage(newest: 10), now: now)
        evidence.observe(storage(newest: 10), now: now + 5)
        let quiet = Observed(SoundActivity.quiet(since: now), at: now + 5)
        #expect(evidence.activity == quiet)
        evidence.observe(storage(newest: 11), now: now + 10)
        #expect(evidence.activity == quiet, "a quiet page filling up looks the same")
        evidence.observe(storage(newest: 12, session: 2), now: now + 15)
        #expect(evidence.activity?.value == .hearing(since: now + 10), "a new session opens with sound")
    }

    @Test func aLatePageFromBeforeQuietNeverSaysHearingAgain() throws {
        var evidence = SoundEvidence()
        evidence.observe(storage(newest: 10), now: now - 5)
        evidence.observe(storage(newest: 10), now: now)
        #expect(evidence.activity?.value == .quiet(since: now - 5))
        // Audio stored just before the quiet reply, its page arriving only after it.
        evidence.observe(try page(openedAt: now - 3), index: 9, now: now + 1)
        #expect(evidence.activity?.value == .quiet(since: now - 5))
    }

    @Test func pagesAlreadySeenOutrankTheIndex() throws {
        var evidence = SoundEvidence()
        evidence.observe(storage(newest: 10), now: now - 5)
        // The stop page itself sealed and arrived: the index moved, but its content already said quiet.
        evidence.observe(try page(openedAt: now - 3, stops: true), index: 10, now: now)
        evidence.observe(storage(newest: 11, session: 2), now: now)
        #expect(evidence.activity?.value == .quiet(since: now - 1.5))
    }

    @Test func staleEvidenceIsNeverRefreshedByAReplyLongAfter() throws {
        var evidence = SoundEvidence()
        evidence.observe(try page(openedAt: now - 1.5, starts: true), index: 10, now: now)
        let heard = try #require(evidence.activity)
        evidence.observe(storage(newest: 11), now: now)
        // Out of reach for a minute: the next reply says nothing about the time between.
        evidence.observe(storage(newest: 11), now: now + 60)
        #expect(evidence.activity == heard)
        #expect(!heard.isFresh(now: now + 60), "said as last heard")
        #expect(heard.isFresh(now: now + 5))
    }

    @Test func repliesTooCloseTogetherWaitForTheNext() {
        var evidence = SoundEvidence()
        evidence.observe(storage(newest: 10), now: now)
        evidence.observe(storage(newest: 10), now: now + 1)
        #expect(evidence.activity == nil, "a page takes longer than that to fill")
        evidence.observe(storage(newest: 10), now: now + 5)
        #expect(evidence.activity?.value == .quiet(since: now))
    }
}

@Suite struct FirmwareModeOnFlash {
    private func page(_ build: (inout ProtoWriter) -> Void) throws -> FlashPage {
        var writer = ProtoWriter()
        writer.varint(1, UInt64(now.timeIntervalSince1970 * 1000))
        build(&writer)
        return try FlashPage(decoding: writer.data)
    }

    private func log(_ text: String, at offset: UInt64, in writer: inout ProtoWriter) {
        writer.message(3) { chunk in
            chunk.varint(1, offset)
            chunk.message(10) { $0.bytes(1, Data("[00:05:20.731,933] <inf> scheduler_ble: \(text)".utf8)) }
        }
    }

    @Test func aDetectorPauseSaysNothingAboutTheMode() throws {
        // What the owner's Pendant writes when its detector stops: NOT_RECORDING and its log line.
        let pause = try page {
            $0.message(3) { chunk in chunk.message(9) { _ in } }
            log("Recording state set to NOT_RECORDING", at: 1000, in: &$0)
        }
        #expect(pause.recordingMode == nil)
    }

    @Test func idleModeIsOffAndWakingOrRecordingIsOn() throws {
        let stop = try page {
            $0.message(3) { chunk in chunk.message(9) { $0.varint(1, 1) } }
            log("Switching to idle mode after event BUTTON_LONG_PRESS (data=0)", at: 4000, in: &$0)
            log("Device mode set to IDLE_MODE", at: 7000, in: &$0)
        }
        #expect(stop.recordingMode == Observed(false, at: now + 7))
        let wake = try page { log("Waking up from idle mode after event BUTTON_LONG_PRESS (data=0)", at: 0, in: &$0) }
        #expect(wake.recordingMode == Observed(true, at: now))
        let detector = try page {
            $0.message(3) { chunk in
                chunk.varint(1, 20)
                chunk.message(2) { $0.bytes(4, Data([0xb8, 1, 2])) }
            }
        }
        #expect(detector.recordingMode == Observed(true, at: now + 0.02))
    }
}

@Suite(.timeLimit(.minutes(1))) struct LiveWatch {
    @Test func pagesSealedWhileWatchedReportSoundThenQuiet() async throws {
        let harness = Harness(.observe)
        try await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            let watch = Task { await harness.coordinator.watchLive() }
            defer { watch.cancel() }
            // The drain left the stream open: nothing new to save, so nothing to switch.
            #expect(await eventually { await harness.fake.commands.last == .getDeviceStatus })
            await harness.fake.record(pages: 1)
            #expect(await eventually { await harness.status().soundActivity?.isHearing == true })
            await harness.fake.recordVoice(pages: 2)
            #expect(
                await eventually {
                    if case .quiet = await harness.status().soundActivity?.value { true } else { false }
                })
            watch.cancel()
            #expect(await harness.fake.commands.filter { $0 == .setDownloadMode(.download) }.count == 1)
            #expect(!(await harness.fake.commands.contains(.setDownloadMode(.recordOnly))), "the stream stays open")
            let quiet = try #require(await harness.status().soundActivity)
            #expect(quiet.at.timeIntervalSinceNow > -5, "live pages, not history")
        }
    }

    @Test func neverAsksForStatusFasterThanTheLimit() async throws {
        let harness = Harness(.observe)
        await harness.fake.record(pages: 5)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            let before = await harness.statusQueries
            let watch = Task { await harness.coordinator.watchLive() }
            #expect(await eventually { await harness.statusQueries - before == 1 }, "the cycle when the screen appears")
            await harness.advanceClock(by: .seconds(6))
            #expect(await eventually { await harness.statusQueries - before == 2 }, "one refresh after `liveRefresh`")
            await harness.quiesce()
            watch.cancel()
            // One cycle when the screen appears, then one refresh per `liveRefresh` (5 s).
            let asked = await harness.statusQueries - before
            #expect((1...2).contains(asked), "\(asked) status queries in 6 s")
        }
    }
}

extension Harness {
    var statusQueries: Int {
        get async { await fake.commands.filter { $0 == .getDeviceStatus }.count }
    }
}

extension Observed<SoundActivity> {
    fileprivate var isHearing: Bool {
        if case .hearing = value { true } else { false }
    }
}
