import Capture
import Foundation
import Testing

@testable import Upload

private let now = Date(timeIntervalSince1970: 1_750_000_000)

@Suite struct NotOnTheMacTests {
    private func backlog(_ pages: UInt64, minutes: Int? = nil, age: TimeInterval = 5) -> Observed<Backlog> {
        Observed(Backlog(pages: pages, estimatedDuration: minutes.map { .seconds($0 * 60) }), at: now - age)
    }

    @Test func nothingHeldBackIsAllOnTheMac() {
        let uploads = UploadStatus(sentThrough: now - 120, heardThrough: now - 120)
        #expect(whatIsNotOnTheMac(backlog: backlog(0), uploads: uploads, now: now).isEmpty)
    }

    @Test func pendantPagesAndPhoneSpeechAreBothHeldBack() {
        let uploads = UploadStatus(unsent: .seconds(240), sentThrough: now - 600, heardThrough: now)
        let held = whatIsNotOnTheMac(backlog: backlog(900, minutes: 12), uploads: uploads, now: now)
        #expect(!held.isEmpty)
        #expect(held.pendantPages == 900 && held.pendantDuration == .seconds(720))
        #expect(held.phoneDuration == .seconds(240))
    }

    @Test func sentShortOfHeardIsHeldBack() {
        let uploads = UploadStatus(sentThrough: now - 300, heardThrough: now)
        let held = whatIsNotOnTheMac(backlog: backlog(0), uploads: uploads, now: now)
        #expect(held.phoneDuration == .seconds(300) && !held.isEmpty)
    }

    @Test func aStaleBacklogOrNoUploaderIsNeverAllOnTheMac() {
        let uploads = UploadStatus(sentThrough: now, heardThrough: now)
        let stale = whatIsNotOnTheMac(backlog: backlog(0, age: 3_600), uploads: uploads, now: now)
        #expect(stale.isPendantUnknown && !stale.isEmpty)
        let unpaired = whatIsNotOnTheMac(backlog: backlog(0), uploads: nil, now: now)
        #expect(unpaired.isPhoneUnknown && !unpaired.isEmpty)
    }
}
