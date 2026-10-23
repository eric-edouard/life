import AudioPipeline
import Testing
import Timeline

private func at(_ seconds: Int64) -> CaptureInstant { CaptureInstant(millis: 1_790_000_000_000 + seconds * 1000) }

@Test func onlyRoutesIntoTheRoomCountAsOutLoud() {
    #expect(PlaybackQuiet.isOutLoud([("Speaker", "Speaker")]))
    #expect(PlaybackQuiet.isOutLoud([("AirPlay", "Living Room")]))
    #expect(PlaybackQuiet.isOutLoud([("CarAudio", "CarPlay")]))
    #expect(PlaybackQuiet.isOutLoud([("BluetoothA2DPOutput", "JBL Flip 6")]))
    #expect(PlaybackQuiet.isOutLoud([("Headphones", "Headphones"), ("AirPlay", "Kitchen")]), "any output out loud")
    #expect(!PlaybackQuiet.isOutLoud([("BluetoothA2DPOutput", "Dave's AirPods Pro")]))
    #expect(!PlaybackQuiet.isOutLoud([("BluetoothA2DPOutput", "Bose QC Ultra Headphones")]))
    #expect(!PlaybackQuiet.isOutLoud([("Headphones", "Headphones")]))
    #expect(!PlaybackQuiet.isOutLoud([("BluetoothHFP", "Car kit")]), "a call headset")
    #expect(!PlaybackQuiet.isOutLoud([("Receiver", "Receiver")]))
    #expect(!PlaybackQuiet.isOutLoud([]))
}

@Test func aSpanOpensOutLoudGrowsWhilePlayingAndClosesPadded() throws {
    var quiet = PlaybackQuiet()
    let idle = quiet.update(outLoud: false, at: at(0))
    #expect(idle == nil, "paused or in headphones: nothing")
    let openedUpdate = quiet.update(outLoud: true, at: at(10))
    let opened = try #require(openedUpdate)
    #expect(opened.change == .opened)
    #expect(opened.span == at(8)..<at(40), "padded before, stored ahead until the next refresh")
    let early = quiet.update(outLoud: true, at: at(20))
    #expect(early == nil, "too soon to store again")
    let extendedUpdate = quiet.update(outLoud: true, at: at(40))
    let extended = try #require(extendedUpdate)
    #expect(extended.change == .extended)
    #expect(extended.span == at(8)..<at(70), "same start, so it replaces the stored one")
    let closedUpdate = quiet.update(outLoud: false, at: at(50))
    let closed = try #require(closedUpdate)
    #expect(closed.change == .closed)
    #expect(closed.span == at(8)..<at(52))
    let after = quiet.update(outLoud: false, at: at(60))
    #expect(after == nil)
    // Out loud again: a new span.
    let reopened = quiet.update(outLoud: true, at: at(90))
    #expect(reopened?.span.lowerBound == at(88))
}
